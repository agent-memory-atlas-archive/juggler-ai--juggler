//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// installAppMenu builds the native application menu. Session ▸ Open… asks the
// focused window's page to show the project picker; Session ▸ New Tab creates a
// conversation in the focused window (mirrors the in-app Cmd+N shortcut);
// Session ▸ New Window opens another in-process window (no project → picker);
// View carries dev-only reload/devtools plus Toggle Full Screen; Help ▸ Learn
// More opens the browser.
func installAppMenu(a *appState, devMode bool) {
	// Linux renders the application menu as a GtkMenuBar embedded at the top of
	// the window (Wails prepends it into the window's vbox), which looks wrong
	// against our custom header. macOS shows it as the global top-of-screen menu
	// bar (correct) and the frameless Windows window doesn't display it at all,
	// so only Linux needs suppressing. The Linux window builds its menu bar
	// solely from globalApplication.applicationMenu, and the default-menu
	// fallback is darwin-only — so by never calling Menu.Set here, applicationMenu
	// stays nil and the window attaches no menu bar at all.
	if runtime.GOOS == "linux" {
		return
	}
	menu := application.NewMenu()
	buildAppMenu(a, menu)

	sessionMenu := menu.AddSubmenu("Session")
	sessionMenu.Add("Open...").
		SetAccelerator("CmdOrCtrl+o").
		OnClick(func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:open-project'))")
			}
		})
	// New Tab owns Cmd+N (the browser new-tab key most people reach for) and
	// creates a conversation in the focused window by dispatching the same event
	// the in-app Cmd+N shortcut fires. The native menu accelerator preempts the
	// webview keydown, so this is the only path Cmd+N takes here — no double
	// trigger. It is also the only path Cmd+N has anywhere: a browser reserves
	// that chord for its own New window and never delivers it to the page, which
	// is why the frontend binds Alt+N as an alias (see key-shortcut-manager.js).
	sessionMenu.Add("New Tab").
		SetAccelerator("CmdOrCtrl+n").
		OnClick(func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("document.dispatchEvent(new CustomEvent('juggler:new-conversation'))")
			}
		})
	// New Window moves to the Shift variant so it stops shadowing New Tab's Cmd+N.
	// Like New Tab, it dispatches into the focused window's page rather than
	// opening the window here: the page's own newWindow() carries THIS window's
	// live theme and font size to the child (see header-controls.js). Opening it
	// in Go could only pass the global last-used values, not the source window's —
	// which is what made a new window adopt the last-active appearance instead of
	// the one it was launched from.
	sessionMenu.Add("New Window").
		SetAccelerator("CmdOrCtrl+Shift+n").
		OnClick(func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:new-window'))")
			}
		})
	sessionMenu.AddSeparator()
	sessionMenu.AddRole(application.CloseWindow)

	menu.AddRole(application.EditMenu)

	dispatch := func(event string) func(*application.Context) {
		return func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("window.dispatchEvent(new CustomEvent('" + event + "'))")
			}
		}
	}

	viewMenu := menu.AddSubmenu("View")
	// Font-size zoom (mirrors the header bar's −/+ buttons), not the webview's
	// own page zoom — that breaks the fixed layout. The page also handles the
	// Cmd +/− keypresses directly for browser tabs that have no native menu.
	viewMenu.Add("Zoom In").SetAccelerator("CmdOrCtrl+plus").OnClick(dispatch("juggler:zoom-in"))
	viewMenu.Add("Zoom Out").SetAccelerator("CmdOrCtrl+-").OnClick(dispatch("juggler:zoom-out"))
	viewMenu.AddSeparator()
	if devMode {
		viewMenu.AddRole(application.Reload)
		viewMenu.AddRole(application.ForceReload)
		viewMenu.AddRole(application.OpenDevTools)
		viewMenu.AddSeparator()
	}
	viewMenu.AddRole(application.ToggleFullscreen)

	menu.AddRole(application.WindowMenu)

	helpMenu := menu.AddSubmenu("Help")
	helpMenu.Add("Learn More").
		OnClick(func(_ *application.Context) {
			if err := openInBrowser("https://juggler.studio"); err != nil {
				logf("open Learn More failed: %v", err)
			}
		})

	a.app.Menu.Set(menu)
}

// addAboutItem appends "About Juggler" to the application menu. It opens the
// page's own about box (the one the header logo opens) instead of Wails' About
// role, whose handler puts up the platform's stock about panel in a separate
// window — a second, plainer about box for an app that already has one.
func addAboutItem(a *appState, appMenu *application.Menu) {
	appMenu.Add("About Juggler").
		OnClick(func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:open-about'))")
			}
		})
}

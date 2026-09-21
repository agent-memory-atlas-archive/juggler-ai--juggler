//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"errors"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Build-injection seams for the desktop app.
//
// These are the two extension points a packaged build can attach behaviour to
// without the stock source carrying the implementation. The stock build leaves
// them at the inert defaults below — it builds and runs exactly as written. A
// packaged build may overlay a single file into this package that reassigns
// them in an init() (its files depend only on this module), so the added
// behaviour is compiled in for that build alone and the stock source stays
// free of it. Keeping the seams as swappable vars is what makes the source
// carry the call sites but none of the injected code.

// afterAppInit runs once, immediately after the Wails App is constructed (so
// a.app is live), from initApplication. Default: no-op.
var afterAppInit = func(*appState) {}

// buildAppMenu installs the application menu onto the root menu, from
// installAppMenu. Default: the platform application menu, no extra items.
//
// It mirrors Wails' AppMenu role (About, Services, Hide/HideOthers/UnHide,
// Quit) rather than using it, for the one difference addAboutItem makes; macOS
// treats the first submenu as the app menu whatever its label, and the Services
// role keeps its native submenu injection. Like that role, it is macOS-only:
// nothing else shows an application menu (Linux is suppressed a caller up, and
// the frameless Windows window displays no menu bar at all).
var buildAppMenu = func(a *appState, menu *application.Menu) {
	if runtime.GOOS != "darwin" {
		return
	}
	appMenu := menu.AddSubmenu("Juggler")
	addAboutItem(a, appMenu)
	appMenu.AddSeparator()
	appMenu.AddRole(application.ServicesMenu)
	appMenu.AddSeparator()
	appMenu.AddRole(application.Hide)
	appMenu.AddRole(application.HideOthers)
	appMenu.AddRole(application.UnHide)
	appMenu.AddSeparator()
	appMenu.AddRole(application.Quit)
}

// UpdaterSnapshot is the in-app updater's current state, marshalled to the page
// (over the loopback control endpoint and pushed via broadcastJS). Present=false
// means this build has no in-app updater — a from-source, free, or non-macOS
// build — in which case the page relies on the server-side version notice alone
// (see cmd/juggler/server/update_status.go). The overlay that fills these seams
// keeps the struct up to date from the updater's own events.
type UpdaterSnapshot struct {
	Present    bool   `json:"present"`
	State      string `json:"state"`                // updater.State value, e.g. "downloading"
	Version    string `json:"version,omitempty"`    // target release version
	AppVersion string `json:"appVersion,omitempty"` // this app bundle's core.Version (for skew detection vs the viewed server)
	Written    int64  `json:"written,omitempty"`
	Total      int64  `json:"total,omitempty"`
	Error      string `json:"error,omitempty"`
	// ErrorStage is which phase produced Error ("check", "download", "verify",
	// "install"). The page leads with it so a check that couldn't reach the
	// server doesn't claim an update failed — nothing was being updated.
	ErrorStage string `json:"errorStage,omitempty"`
}

// updaterSnapshot returns the current updater state. Default: not present, so a
// stock build reports "no in-app updater" and the page hides all progress UI.
var updaterSnapshot = func() UpdaterSnapshot { return UpdaterSnapshot{Present: false} }

// updaterInstall starts (or no-ops if already running) the download+stage flow.
// The argument is userInitiated: true when a click asked for this, false for the
// page's own proactive kick. A failure the user did not ask for is logged, not
// shown, so an unreachable update server never puts an error in front of someone
// who never asked. Default: no-op — there is nothing to install without an overlay.
var updaterInstall = func(_ bool) {}

// updaterCheck runs a check-only probe: it asks the updater whether a newer
// release exists and pushes the resulting snapshot to the page, but never
// starts a download. It backs the settings tab's "Check for updates" button and
// (in notify/off mode) the macOS menu, where an explicit check must reveal
// availability without triggering an auto-download. Default: no-op.
var updaterCheck = func() {}

// updaterRestart relaunches into the staged update. Synchronous; returns an
// error when no update is staged or the swap helper failed to spawn (the
// control handler turns that into a 409/500 and un-authorises the pending quit).
var updaterRestart = func() error { return errors.New("no in-app updater in this build") }

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
	"juggler/internal/webviewenv"
	"juggler/internal/windowgeom"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// windowStartupTimeout bounds how long we wait for the initial window to become
// visible before treating the launch as a failure. Generous, so a slow machine
// or a first-run webview warm-up never trips it — this is a "the window is never
// coming" backstop, not a performance check.
const windowStartupTimeout = 20 * time.Second

// revealInitialWindowWhenReady works around Wails waiting for WebView2's first
// navigation before showing a non-hidden Windows window. Run assigns the native
// implementation before it creates the HWND, so calling Show immediately can
// race it and create a second implementation. A non-zero native Size proves the
// HWND exists; Show is safe from that point and makes startup independent of
// WebView2 navigation timing.
func (a *appState) revealInitialWindowWhenReady(e *winEntry) {
	deadline := time.After(windowStartupTimeout)
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			return
		case <-tick.C:
			width, height := e.win.Size()
			if width <= 0 || height <= 0 {
				continue
			}
			application.InvokeAsync(func() {
				if a.fitWindowToScreens(e) {
					// Persist the corrected frame rather than waiting for the user to
					// move the window: a session poisoned by an older build otherwise
					// strands every launch from here on, which is the loop this breaks.
					e.triggerSave()
				}
				if e.win.IsVisible() {
					return
				}
				logf("initial window native frame ready but hidden; showing explicitly")
				a.showWindow(e)
			})
			return
		}
	}
}

// rescueStrandedWindow moves a window that has come up where the user can
// neither see nor drag it back onto the primary display, and persists the
// corrected frame.
//
// It exists because the placement decision at build time cannot be trusted to
// have been an informed one. Wails populates its screen cache inside Run(), and
// the initial window is built before Run, so windowgeom.PlaceVisible judges the
// saved frame against an empty screen list and passes anything through. This is
// the same question asked once the answer is available, against the frame the
// window actually ended up in — which also covers the placement being
// undermined afterwards, as when Wails maximises a window and then moves it to
// the saved coordinates anyway.
//
// A maximised window is judged by the frame it will restore to as well as the
// one it shows: it opens onto a real display whatever the saved frame
// underneath says, and Windows returns an un-maximised window to exactly that
// frame, however stale. See windowgeom.RescueTarget.
//
// Startup only. Once a window is up, where it goes is somebody's decision — the
// user's, the OS's when a display goes away, or a tiling window manager's that
// hides a window by parking it off every display — and second-guessing those
// fights them.
//
// Runs on the main thread, before the window is revealed, so a rescue is not a
// visible jump. Must not run before the native frame exists: Position and Size
// answer zeros until then, which reads as a window with nothing to judge.
// Reports whether it moved anything.
func (a *appState) rescueStrandedWindow(e *winEntry) bool {
	if e.win.IsMinimised() {
		return false
	}
	x, y := e.win.Position()
	width, height := e.win.Size()
	if width <= 0 || height <= 0 {
		return false
	}
	live := core.WindowState{X: x, Y: y, Width: width, Height: height, HasPos: true}
	maximised := e.win.IsMaximised()
	var restore core.WindowState
	if maximised {
		restore = e.geom.RestoreFrame()
	}
	screens := a.app.Screen.GetAll()
	rescued, moved := windowgeom.RescueTarget(live, restore, screens)
	if !moved {
		return false
	}
	logf("window %s came up unreachable at %s, restoring to %s (screens %s); moving it to %s",
		e.id, describeFrame(live), describeFrame(restore), describeScreens(screens), describeFrame(rescued))
	// A maximised window cannot simply be moved. Windows maximises onto whichever
	// display the window is on and holds it there — SetWindowPos on a WS_MAXIMIZE
	// window is not reliably honoured, and the maximised rect wins back anything
	// that is. Drop it to a normal frame, move that onto the primary display, and
	// maximise it again once it is there. Its normal size is the restore frame's,
	// not the live one's, so it is always set.
	if maximised {
		e.win.Restore()
	}
	if maximised || rescued.Width != live.Width || rescued.Height != live.Height {
		e.win.SetSize(rescued.Width, rescued.Height)
	}
	e.win.SetPosition(rescued.X, rescued.Y)
	if maximised {
		e.win.Maximise()
	}
	// The window has genuinely been at the rescued frame, so it is now the honest
	// restore frame — and the only one available while the window is maximised.
	// Without this the capture below is refused and a session poisoned by an
	// older build is rescued on every launch but never actually repaired.
	e.geom.Reseed(rescued)
	return true
}

// capOversizedWindow shrinks a window that came up larger than the display it
// is on, and persists nothing itself — it reports whether it changed anything.
//
// It is the same problem rescueStrandedWindow exists for, from the other end:
// the initial window is built before Run, when Wails knows of no screens, so
// its size is whatever was saved or defaulted and has never been judged against
// a display. A window wider than the screen hides its own right-hand side,
// which on a frameless window is where the controls are.
//
// Startup only, and deliberately not asked again when the geometry settles: a
// size the user chose is theirs, including one that hangs off the edge.
func (a *appState) capOversizedWindow(e *winEntry) bool {
	if e.win.IsMinimised() || e.win.IsMaximised() || e.win.IsFullscreen() {
		return false
	}
	x, y := e.win.Position()
	width, height := e.win.Size()
	if width <= 0 || height <= 0 {
		return false
	}
	live := core.WindowState{X: x, Y: y, Width: width, Height: height, HasPos: true}
	screens := a.app.Screen.GetAll()
	capped, changed := windowgeom.CapToWorkArea(live, screens)
	if !changed {
		return false
	}
	logf("window %s came up larger than its display at %s (screens %s); fitting it to %s",
		e.id, describeFrame(live), describeScreens(screens), describeFrame(capped))
	e.win.SetSize(capped.Width, capped.Height)
	e.win.SetPosition(capped.X, capped.Y)
	// The window has genuinely been at this frame, so it is the honest one to
	// keep and to write back — same reasoning as the rescue above.
	e.geom.Reseed(capped)
	return true
}

// sizeDefaultedWindow gives a window that opened at the bare default the size
// it would have been given had the display been known, and centres it there.
//
// The initial window is built before Run, when Wails knows of no screens, so a
// window with nothing saved gets windowgeom.DefaultWidth/Height — the layout's
// minimum, which on a large display is a small window in the middle of a lot of
// space. Every other window is placed after Run and gets the right size from
// PlaceVisible; this is the one that cannot.
//
// Only a window whose size nobody chose: a saved frame, an inherited one, or a
// size the user has since dragged to are all decisions, and none of them is
// ours to improve on.
func (a *appState) sizeDefaultedWindow(e *winEntry) bool {
	if !e.sizeDefaulted || e.win.IsMinimised() || e.win.IsMaximised() || e.win.IsFullscreen() {
		return false
	}
	width, height := e.win.Size()
	if width <= 0 || height <= 0 {
		return false
	}
	screens := a.app.Screen.GetAll()
	frame, ok := windowgeom.DefaultFrame(screens)
	if !ok || (frame.Width == width && frame.Height == height) {
		return false
	}
	logf("window %s opened at the screenless default %dx%d (screens %s); resizing it to %s",
		e.id, width, height, describeScreens(screens), describeFrame(frame))
	e.win.SetSize(frame.Width, frame.Height)
	e.win.SetPosition(frame.X, frame.Y)
	e.geom.Reseed(frame)
	return true
}

// fitWindowToScreens applies every correction a window can need before it is
// revealed: the size nobody chose, then a size too big for the display, then a
// position that cannot be reached on it. In that order, because each one moves
// what the next is judging. Reports whether any did anything, which is the
// caller's cue to persist the result.
func (a *appState) fitWindowToScreens(e *winEntry) bool {
	sized := a.sizeDefaultedWindow(e)
	capped := a.capOversizedWindow(e)
	rescued := a.rescueStrandedWindow(e)
	return sized || capped || rescued
}

// describeFrame renders a frame as one log token.
func describeFrame(f core.WindowState) string {
	if !f.HasPos {
		return fmt.Sprintf("%dx%d@centred", f.Width, f.Height)
	}
	return fmt.Sprintf("%dx%d@%d,%d", f.Width, f.Height, f.X, f.Y)
}

// describeScreens renders the work areas a frame was judged against, primary
// marked with a star. "none" is a diagnosis rather than a missing detail: it
// means the screen cache was empty and no frame could be judged at all.
func describeScreens(screens []*application.Screen) string {
	if len(screens) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(screens))
	for _, s := range screens {
		if s == nil {
			continue
		}
		mark := ""
		if s.IsPrimary {
			mark = "*"
		}
		parts = append(parts, fmt.Sprintf("%s%dx%d@%d,%d", mark, s.WorkArea.Width, s.WorkArea.Height, s.WorkArea.X, s.WorkArea.Y))
	}
	return strings.Join(parts, " ")
}

// describePlacement renders the placement a window is about to be opened with.
func describePlacement(p windowgeom.Placement) string {
	where := fmt.Sprintf("%d,%d", p.X, p.Y)
	if p.Position != application.WindowXY {
		where = "centred"
	}
	state := ""
	switch p.State {
	case application.WindowStateMaximised:
		state = " maximised"
	case application.WindowStateFullscreen:
		state = " fullscreen"
	}
	return fmt.Sprintf("%dx%d@%s%s", p.Width, p.Height, where, state)
}

// fatalf reports an unrecoverable window-startup failure as loudly as possible —
// to the console (a terminal launch) and to app.log (a windowless launch) — then
// exits non-zero. It exists to turn an otherwise-silent GUI failure into a
// diagnosable crash: without it, a webview that fails to initialise leaves a
// process that either exits 0 with nothing on screen or sits alive with no
// window and no output. jlog.Error already writes to stderr and the file; we
// flush the file sink before exiting so the breadcrumb survives the os.Exit.
func fatalf(format string, args ...any) {
	jlog.Error("[juggler-app] FATAL: "+format, args...)
	jlog.Close()
	os.Exit(1)
}

// wailsLogHandlers builds the option fields that stop Wails from swallowing its
// own diagnostics. In a production build (-tags production) Wails defaults its
// system logger to io.Discard and, with no ErrorHandler set, routes every
// internal error — including the fatal os.Exit(1) path — into that void. That is
// exactly why a failed window launch is silent. We point all of it at jlog
// instead, so GTK/WebKit warnings, version banners, and errors reach the same
// console + app.log everything else uses.
func wailsLogHandlers() (logger *slog.Logger, onErr func(error), onWarn func(string), onPanic func(*application.PanicDetails)) {
	logger = slog.New(slog.NewTextHandler(jlogWriter{}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	onErr = func(err error) { jlog.Error("[wails] %v", err) }
	onWarn = func(msg string) { jlog.Info("[wails] warning: %s", msg) }
	onPanic = func(p *application.PanicDetails) {
		if p == nil {
			fatalf("wails panic (no details)")
		}
		fatalf("wails panic: %v\n%s", p.Error, p.FullStackTrace)
	}
	return
}

// jlogWriter adapts an slog handler onto jlog so Wails' structured system log
// lines land in juggler's sink. Each Write is one formatted record; we strip the
// trailing newline slog appends and forward at Info (the level is already inside
// the line text, e.g. "level=ERROR ...").
type jlogWriter struct{}

func (jlogWriter) Write(p []byte) (int, error) {
	jlog.Info("[wails] %s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// watchWindowStartup crashes the process if the initial window never becomes
// visible within windowStartupTimeout. It is the backstop for the failure mode
// where the event loop stays up but the native layer presents no window and
// reports no error — the app would otherwise linger invisibly forever. It closes
// `up` the moment the window is confirmed visible (a normal, healthy launch),
// which also tells run() the loop's later exit was a real one, not a silent
// never-showed exit. Runs on its own goroutine, started before app.Run().
func (a *appState) watchWindowStartup(e *winEntry, up chan struct{}) {
	deadline := time.After(windowStartupTimeout)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			fatalf("%s", webviewenv.UnavailableMessage(
				fmt.Sprintf("the window never became visible within %s", windowStartupTimeout)))
		case <-tick.C:
			if a.windowIsVisible(e) {
				close(up)
				return
			}
		}
	}
}

// warnIfWindowNeverVisible polls a newly-opened non-initial window (Session ▸ New
// Window, or a second-instance hand-off) and logs loudly if it never becomes
// visible within windowStartupTimeout. Unlike the initial-window watchdog it does
// not crash the process — other windows may be healthy — but it makes a window
// that silently fails to appear diagnosable instead of invisible. Runs on its own
// goroutine.
func (a *appState) warnIfWindowNeverVisible(e *winEntry, context string) {
	deadline := time.After(windowStartupTimeout)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			jlog.Error("[juggler-app] window %s (%s): %s", e.id, context, webviewenv.UnavailableMessage(
				fmt.Sprintf("the window never became visible within %s", windowStartupTimeout)))
			return
		case <-tick.C:
			if a.windowIsVisible(e) {
				return
			}
		}
	}
}

// windowIsVisible probes the native window's visibility without letting a stalled
// main loop hang the watchdog. IsVisible marshals onto the main thread; if that
// loop never starts (a wedged GTK init), the call blocks — so we bound it and
// treat a non-answer as "not visible yet" and keep polling until the deadline.
func (a *appState) windowIsVisible(e *winEntry) bool {
	res := make(chan bool, 1)
	go func() { res <- e.win.IsVisible() }()
	select {
	case v := <-res:
		return v
	case <-time.After(500 * time.Millisecond):
		return false
	}
}

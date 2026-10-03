//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"juggler/internal/apipaths"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Closing a desktop window or quitting the app stops the server(s) the app
// spawned for those windows, abandoning any turn in flight. (A browser tab is different — disconnecting
// leaves the server running — so this guard lives only in the desktop app.) Before
// a close/quit tears a server down we ask it whether it is busy and, if so,
// confirm the discard with the user.
//
// The server is the source of truth: GET /api/health/active reports whether any
// conversation is actively running a turn, so we read it on demand rather than
// caching busy state app-side. A turn merely parked on a pending tool approval
// is NOT counted — it survives a restart intact, so quitting then is fine and
// must not warn. Fail-open — if the server can't be reached there is nothing
// running to lose, so the close/quit proceeds.

var busyHTTP = &http.Client{Timeout: 2 * time.Second}

// serverBusy reports how many conversations on serverURL are actively running a
// turn (approval-parked turns excluded — see /api/health/active). Returns 0 on
// any error (fail-open: an unreachable server has nothing to lose).
func serverBusy(serverURL string) int {
	url := strings.TrimRight(serverURL, "/") + apipaths.HealthActive
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return 0
	}
	resp, err := busyHTTP.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0
	}
	var body struct {
		Active          bool     `json:"active"`
		ConversationIDs []string `json:"conversationIds"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0
	}
	if !body.Active {
		return 0
	}
	return len(body.ConversationIDs)
}

// closeAllowed reports whether closing e may skip the busy-work prompt: the app
// is quitting (teardown shouldn't re-prompt per window), the window is already
// gone, the guard has already cleared it (forceClose), the window views a server
// this app did not spawn, or the window is a detached board with another window
// still behind it.
//
// A server the app did not spawn — a headless instance, a terminal server, a URL
// — is never stopped by a close (handleWindowClosed stops only what is in
// st.servers), so the turn it is running carries on whatever the user answers.
//
// A board is exempt because closing it usually discards nothing: it views a
// window's server rather than one of its own, so the turn the guard would report
// belongs to whatever else views that server — which stays open, keeps the
// server alive (a server is stopped only when no surviving window views it) and
// keeps running the turn. Asking would be a warning about work this close cannot
// touch.
//
// The exemption ends where that does. A board outlives the window it was
// detached from, so it can be the last window viewing its server — and then
// closing it IS what stops the turn, which is exactly the case the guard exists
// for.
//
// Read through the registry goroutine, like the rest of the shared window state.
func (a *appState) closeAllowed(e *winEntry) bool {
	var allow bool
	a.reg(func(st *regState) {
		w := st.windows[e.id]
		if st.quitting || w == nil || w.forceClose {
			allow = true
			return
		}
		_, owned := st.servers[w.serverURL]
		allow = !owned || (isBoardRole(w.role) && serverViewedElsewhere(st, w))
	})
	return allow
}

// serverViewedElsewhere reports whether any window other than w views w's
// server, and so whether w's close is one the server survives.
//
// Must run on the registry goroutine.
func serverViewedElsewhere(st *regState, w *winEntry) bool {
	for _, other := range st.windows {
		if other.id != w.id && other.serverURL == w.serverURL {
			return true
		}
	}
	return false
}

// shouldQuit is the application ShouldQuit hook (Cmd+Q / Quit menu). It must
// answer synchronously, so it allows an already-authorised quit and otherwise
// vetoes, handing the real decision to confirmThenQuit on a background goroutine.
func (a *appState) shouldQuit() bool {
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if quitting {
		return true
	}
	go a.confirmThenQuit()
	return false
}

// confirmThenQuit runs off the main thread after a quit was vetoed. It tallies
// in-flight turns across every server the quit will stop and, if any
// exist, confirms the discard; on approval it authorises the quit and re-issues
// it.
func (a *appState) confirmThenQuit() {
	total := 0
	for _, u := range a.ownedServerURLs() {
		total += serverBusy(u)
	}
	if total > 0 {
		msg := busyMessage(total, "Quitting")
		if !a.confirmDiscard(nil, "Quit Juggler?", msg, "Quit anyway") {
			return // user chose to keep working
		}
	}
	a.reg(func(st *regState) { st.quitting = true })
	a.notifyAllWindowsCloseRequested()
	application.InvokeAsync(func() { a.app.Quit() })
}

// ownedServerURLs lists the servers whose work a quit stops: the ones this app
// spawned. A window onto any other server (a headless instance, a terminal
// server, a URL) leaves it running when the app goes, turn and all.
func (a *appState) ownedServerURLs() []string {
	var urls []string
	a.reg(func(st *regState) {
		for u := range st.servers {
			urls = append(urls, u)
		}
	})
	return urls
}

// busyMessage builds the confirmation body for n in-flight conversations and the
// action about to discard them (e.g. "Quitting", "Closing this window").
func busyMessage(n int, action string) string {
	if n == 1 {
		return fmt.Sprintf("A conversation is still working. %s will stop and discard it.", action)
	}
	return fmt.Sprintf("%d conversations are still working. %s will stop and discard them.", n, action)
}

// confirmDiscard shows a modal question dialog and blocks (on its own goroutine)
// until the user answers. The safe choice ("Keep working") is both the default
// and the cancel action, so an accidental Return or Escape never discards work.
// parent attaches the dialog as a sheet on that window; nil makes it app-modal
// (used for the app-wide quit prompt).
func (a *appState) confirmDiscard(parent application.Window, title, message, confirmLabel string) bool {
	result := make(chan bool, 1)
	dialog := a.app.Dialog.Question().SetTitle(title).SetMessage(message)
	if parent != nil {
		dialog.AttachToWindow(parent)
	}
	dialog.AddButton(confirmLabel).OnClick(func() { result <- true })
	stay := dialog.AddButton("Keep working")
	stay.OnClick(func() { result <- false })
	dialog.SetDefaultButton(stay)
	dialog.SetCancelButton(stay)
	dialog.Show()
	return <-result
}

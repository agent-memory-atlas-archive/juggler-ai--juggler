//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"

	"juggler/cmd/juggler/core"
	"juggler/internal/httpx"
	"juggler/internal/userpaths/userpathstest"
)

// settingsFrame is a delivered settings-changed as a client sees it. The whole
// document rides the event rather than a "go and refetch" nudge, so N windows
// converge on one broadcast instead of answering it with N GETs.
type settingsFrame struct {
	Type     string              `json:"type"`
	Settings core.GlobalSettings `json:"settings"`
}

// settingsSilenceWindow is how long a "nothing was broadcast" assertion waits.
// It must outlast the watcher's debounce, or it would pass merely by finishing
// before a broadcast was ever due.
const settingsSilenceWindow = settingsReloadDebounce + 700*time.Millisecond

// newSettingsSocketServer stands up the production WebSocket handler with the
// settings store and its watcher running, against a config dir of its own so a
// test never reads or writes the developer's real settings.json.
func newSettingsSocketServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	userpathstest.Isolate(t)
	s, ts := newViewerSocketServer(t)
	s.settings = newSettingsStore()
	s.shutdownChan = make(chan struct{})
	t.Cleanup(func() { close(s.shutdownChan) })
	s.startConfigWatcher()
	return s, ts
}

// nextSettingsChange reads frames until a settings-changed arrives, or fails.
// Other traffic (the connect seeds, heartbeats, clients-changed) is skipped: the
// assertion is about this message type reaching this client.
func nextSettingsChange(t *testing.T, conn *websocket.Conn, who string) settingsFrame {
	t.Helper()
	// relayBudget for the same reason the relay tests spend it: the wait is only
	// paid out when the test is already failing.
	_ = conn.SetReadDeadline(time.Now().Add(relayBudget))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no settings-changed reached %s: %v", who, err)
		}
		var frame settingsFrame
		if err := json.Unmarshal(msgBytes, &frame); err != nil {
			continue
		}
		if frame.Type == "settings-changed" {
			return frame
		}
	}
}

// expectNoSettingsChange reads for a window that outlasts the debounce and fails
// if a settings-changed arrives.
func expectNoSettingsChange(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(settingsSilenceWindow))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			return // the read deadline expiring is the pass
		}
		var frame settingsFrame
		if err := json.Unmarshal(msgBytes, &frame); err != nil {
			continue
		}
		if frame.Type == "settings-changed" {
			t.Fatal("a settings write that changed nothing was still broadcast")
		}
	}
}

// TestSettingsChangeReachesOtherClient is the reported bug as an assertion: two
// windows are open, one changes a global setting, and the other must be told
// without being asked. The writer is told too — every client converges on the
// same document, so there is no origin to exclude.
func TestSettingsChangeReachesOtherClient(t *testing.T) {
	s, ts := newSettingsSocketServer(t)

	writer := dialRole(t, ts, "viewer", "v_writer")
	other := dialRole(t, ts, "viewer", "v_other")

	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)

	frame := nextSettingsChange(t, other, "the other window")
	if frame.Settings.Updates.Mode != core.UpdateModeNotify {
		t.Errorf("the other window was told mode %q, want %q",
			frame.Settings.Updates.Mode, core.UpdateModeNotify)
	}
	// Both windows must be handed the same document, not merely both notified —
	// two windows converging on different settings is the bug this replaces.
	own := nextSettingsChange(t, writer, "the writing window")
	if settingsRevision(own.Settings) != settingsRevision(frame.Settings) {
		t.Errorf("the two windows were told different documents for one change: %+v and %+v",
			own.Settings, frame.Settings)
	}
}

// TestExternalSettingsEditReachesEveryClient: one server process per open
// project, all sharing ~/.juggler/settings.json, so the write a client must hear
// about is often one THIS process never made. The store seeds from disk once at
// construction, so the server's own in-memory copy has to be re-seeded too — a
// broadcast that left it stale would tell clients the truth and then serve them
// the old document on their next GET.
func TestExternalSettingsEditReachesEveryClient(t *testing.T) {
	s, ts := newSettingsSocketServer(t)

	first := dialRole(t, ts, "viewer", "v_first")
	second := dialRole(t, ts, "viewer", "v_second")

	// Exactly what another project's server does: mutate under the file lock.
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Network.Proxy.Mode = core.ProxyModeNone
		return true
	}); err != nil {
		t.Fatalf("external edit: %v", err)
	}

	for _, c := range []struct {
		conn *websocket.Conn
		who  string
	}{{first, "the first window"}, {second, "the second window"}} {
		if frame := nextSettingsChange(t, c.conn, c.who); frame.Settings.Network.Proxy.Mode != core.ProxyModeNone {
			t.Errorf("%s was told proxy mode %q, want %q",
				c.who, frame.Settings.Network.Proxy.Mode, core.ProxyModeNone)
		}
	}
	if got := s.settings.get().Network.Proxy.Mode; got != core.ProxyModeNone {
		t.Errorf("the store still holds proxy mode %q after an external edit, want %q", got, core.ProxyModeNone)
	}
}

// newSettingsRefreshServer stands up a server whose provider refresh actor is
// running against a stub compute, so a queued refresh is observable. testMode is
// off: it makes RefreshProviders a no-op that only opens the readiness gate.
func newSettingsRefreshServer(t *testing.T) (*Server, chan struct{}) {
	t.Helper()
	userpathstest.Isolate(t)
	s := newReadyTestServer()
	s.hub = newClientHub()
	s.settings = newSettingsStore()
	s.refreshRequests = make(chan struct{}, 1)
	computed := make(chan struct{}, 8)
	s.computeProvidersFunc = func(context.Context) []ProviderStatus {
		computed <- struct{}{}
		return []ProviderStatus{}
	}
	go s.runProviderRefreshActor()
	t.Cleanup(func() { close(s.shutdownChan) })
	return s, computed
}

// TestExternalModelVisibilityEditRefreshesProviders: hidden models and per-model
// limits are folded into the provider list a server publishes — the list carries
// the hidden flag and the context window every model menu displays. That list is
// computed once and cached, so a server that adopts a new document without
// recomputing it goes on publishing the old flags: to the clients it has, and to
// every client that connects afterwards, which is seeded from the same cache.
//
// handlePutSettings already refreshes for a change it made itself. This is the
// same change arriving from another project's server, where nothing else will.
func TestExternalModelVisibilityEditRefreshesProviders(t *testing.T) {
	s, computed := newSettingsRefreshServer(t)

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{"anthropic": {"claude-3-haiku"}}
		return true
	}); err != nil {
		t.Fatalf("external edit: %v", err)
	}

	if !s.adoptExternalSettings() {
		t.Fatal("the external edit was not adopted at all")
	}
	select {
	case <-computed:
	case <-time.After(relayBudget):
		t.Fatal("hiding a model elsewhere left this server's published provider list uncomputed")
	}
}

// TestClassifyConfigEvent pins which of the files in the shared config directory
// each document's watcher reacts to. The directory holds the two documents, a lock
// file for each, and a temp file per save — so most events must be ignored, and
// reacting to a lock file would mean recomputing every provider (which reaches the
// network) every time anything wrote anything.
func TestClassifyConfigEvent(t *testing.T) {
	userpathstest.Isolate(t)
	dir := filepath.Dir(core.GlobalSettingsPath())
	for _, c := range []struct {
		name string
		op   fsnotify.Op
		want configEventAction
	}{
		{"settings.json", fsnotify.Write, configEventAction{settings: true}},
		{"settings.json", fsnotify.Rename, configEventAction{settings: true}},
		{"credentials.json", fsnotify.Create, configEventAction{credentials: true}},
		{"settings.lock", fsnotify.Write, configEventAction{}},
		{"credentials.lock", fsnotify.Write, configEventAction{}},
		{"settings-1234.json.tmp", fsnotify.Create, configEventAction{}},
		{"settings.json", fsnotify.Chmod, configEventAction{}},
	} {
		got := classifyConfigEvent(filepath.Join(dir, c.name), c.op)
		if got != c.want {
			t.Errorf("classifyConfigEvent(%s, %v) = %+v, want %+v", c.name, c.op, got, c.want)
		}
	}
}

// TestExternalProxyEditAppliesToThisServersOwnRequests: the proxy setting is not
// merely displayed — it decides where this process's own outbound requests go,
// and it is applied live so a change needs no restart. A document that is adopted
// and broadcast but never applied is the worst of the three outcomes: every window
// this server feeds shows the new proxy while the server itself keeps using the
// old one, so the UI reports a state the process is not in.
func TestExternalProxyEditAppliesToThisServersOwnRequests(t *testing.T) {
	s, _ := newSettingsRefreshServer(t)
	// The resolver is process-wide, so put it back as it was found.
	t.Cleanup(func() { httpx.SetConfig(httpx.Config{}) })

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Network.Proxy.Mode = core.ProxyModeManual
		gs.Network.Proxy.URL = "http://proxy.invalid:3128"
		return true
	}); err != nil {
		t.Fatalf("external edit: %v", err)
	}

	if !s.adoptExternalSettings() {
		t.Fatal("the external edit was not adopted at all")
	}

	proxyURL, err := httpx.Proxy(httptest.NewRequest(http.MethodGet, "https://api.example.com/v1", nil))
	if err != nil {
		t.Fatalf("resolving a proxy for an outbound request: %v", err)
	}
	if proxyURL == nil || proxyURL.Host != "proxy.invalid:3128" {
		t.Errorf("this server still sends its own requests via %v, but every window it serves has been told the proxy is proxy.invalid:3128", proxyURL)
	}
}

// TestExternalSettingsEditLeavesProvidersAloneWhenModelsDidNot: recomputing the
// provider list reaches every provider — some over the network — so it is done
// when the published list would otherwise be wrong, and not merely because the
// document changed.
func TestExternalSettingsEditLeavesProvidersAloneWhenModelsDidNot(t *testing.T) {
	s, computed := newSettingsRefreshServer(t)

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Updates.Mode = core.UpdateModeNotify
		return true
	}); err != nil {
		t.Fatalf("external edit: %v", err)
	}

	if !s.adoptExternalSettings() {
		t.Fatal("the external edit was not adopted at all")
	}
	select {
	case <-computed:
		t.Fatal("an update-mode change recomputed every provider, which reaches the network")
	case <-time.After(settingsSilenceWindow):
	}
}

// TestUnchangedSettingsWriteBroadcastsNothing: a PUT rewrites the file whether
// or not it changed anything, and every rewrite is a filesystem event. Without a
// comparison against what was already loaded, an idle client would be woken — and
// asked to re-render — by every save of an unchanged value.
func TestUnchangedSettingsWriteBroadcastsNothing(t *testing.T) {
	s, ts := newSettingsSocketServer(t)

	conn := dialRole(t, ts, "viewer", "v_idle")

	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	nextSettingsChange(t, conn, "the client watching the first change")

	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	expectNoSettingsChange(t, conn)
}

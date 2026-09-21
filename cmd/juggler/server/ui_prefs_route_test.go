//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// UI zoom and theme are the desktop window's own settings, stored per project in
// the session. A phone or laptop browsing in over the LAN or a tunnel is handed
// those values as its starting point but keeps its own in localStorage, so the
// write routes are gated to viewers on this machine. Without the gate the last
// device to zoom resizes every other one, and the desktop comes back changed
// from a session someone spent on a phone. These tests pin that gate, the read
// path staying open, and the project key the viewer namespaces its own storage
// with.

const localViewerAddr = "127.0.0.1:54321"

// newUIPrefsTestServer wires the real session routes over a real (temp-dir)
// session manager, so these tests exercise the registered route — including its
// localViewerOnly wrapper — rather than a stand-in.
func newUIPrefsTestServer(t *testing.T) (*Server, *core.SessionManager) {
	t.Helper()
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter()}
	s.setupSessionRoutes(handlers.NewSessionAPI(
		func() *core.SessionManager { return mgr }, nil, nil, nil, nil))
	return s, mgr
}

// uiPrefRequest issues one request at addr, optionally tagged as having arrived
// over a granted remote transport (a DataChannel dispatch or tunnel hop, both of
// which reach the server over loopback).
func uiPrefRequest(t *testing.T, s *Server, method, path, body, addr string, remote bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = addr
	if remote {
		req = withRemoteIngress(req)
	}
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	return rec
}

func TestUIPrefWritesAcceptLocalViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-zoom",
		`{"uiZoom":130}`, localViewerAddr, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("local ui-zoom write: got %d, want 200", rec.Code)
	}
	if zoom, ok := mgr.GetUIZoom(); !ok || zoom != 130 {
		t.Fatalf("local ui-zoom write not stored: got %d ok=%v want 130 true", zoom, ok)
	}

	rec = uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-theme",
		`{"uiTheme":"dark"}`, localViewerAddr, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("local ui-theme write: got %d, want 200", rec.Code)
	}
	if mode, ok := mgr.GetUITheme(); !ok || mode != "dark" {
		t.Fatalf("local ui-theme write not stored: got %q ok=%v want \"dark\" true", mode, ok)
	}
}

// TestUIPrefWritesRejectLANViewer covers a phone on the same wifi: a plain
// non-loopback connection, no remote-ingress tag.
func TestUIPrefWritesRejectLANViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUIZoom(110); err != nil {
		t.Fatalf("seed zoom: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-zoom",
		`{"uiZoom":60}`, remoteEdgeAddr, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("LAN ui-zoom write: got %d, want 403", rec.Code)
	}
	if zoom, _ := mgr.GetUIZoom(); zoom != 110 {
		t.Fatalf("LAN viewer changed the desktop's zoom: got %d, want 110", zoom)
	}
}

// TestUIPrefWritesRejectTunnelViewer is the one the address check alone would
// miss: a DataChannel dispatch or tunnel forwarder hop reaches the server over
// loopback, so only the remote-ingress tag distinguishes it from the desktop.
func TestUIPrefWritesRejectTunnelViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUITheme("dark"); err != nil {
		t.Fatalf("seed theme: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-theme",
		`{"uiTheme":"light"}`, localViewerAddr, true)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("tunnelled ui-theme write: got %d, want 403", rec.Code)
	}
	if mode, _ := mgr.GetUITheme(); mode != "dark" {
		t.Fatalf("tunnelled viewer changed the desktop's theme: got %q, want \"dark\"", mode)
	}
}

// TestUIPrefReadsStayOpen: only the writes are gated. A remote viewer is meant
// to start from the desktop's settings, so it must still be able to read them.
func TestUIPrefReadsStayOpen(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUIZoom(90); err != nil {
		t.Fatalf("seed zoom: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-zoom", "", remoteEdgeAddr, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("remote ui-zoom read: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "90") {
		t.Fatalf("remote ui-zoom read should return the saved value, got %s", rec.Body.String())
	}
}

// A window names itself with ?role=, and two windows of one project keep two
// settings. Without this the last window restyled decides for all of them at the
// next launch, which is what a user with two boards on two displays sees as
// "they all came back the same".
func TestUIPrefWritesArePerWindow(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	boardA := core.WindowRolePinboardFor("board_a")
	boardB := core.WindowRolePinboardFor("board_b")

	writes := []struct{ path, body string }{
		{"/api/session/ui-theme?role=" + boardA, `{"uiTheme":"light"}`},
		{"/api/session/ui-theme?role=" + boardB, `{"uiTheme":"dark"}`},
		{"/api/session/ui-zoom?role=" + boardA, `{"uiZoom":130}`},
	}
	for _, wr := range writes {
		if rec := uiPrefRequest(t, s, http.MethodPut, wr.path, wr.body, localViewerAddr, false); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: got %d, want 200", wr.path, rec.Code)
		}
	}

	if mode, _ := mgr.GetWindowUITheme(boardA); mode != "light" {
		t.Fatalf("board a: got %q, want \"light\"", mode)
	}
	if mode, _ := mgr.GetWindowUITheme(boardB); mode != "dark" {
		t.Fatalf("board b took board a's theme: got %q, want \"dark\"", mode)
	}
	if _, ok := mgr.GetUITheme(); ok {
		t.Fatal("a board's theme must not become the project's")
	}

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-theme?role="+boardA, "", localViewerAddr, false)
	if !strings.Contains(rec.Body.String(), `"light"`) {
		t.Fatalf("reading board a back: got %s", rec.Body.String())
	}
	rec = uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-zoom?role="+boardB, "", localViewerAddr, false)
	if strings.Contains(rec.Body.String(), "130") {
		t.Fatalf("board b was answered with board a's zoom: got %s", rec.Body.String())
	}
}

// A window that has never been restyled follows the project, so detaching a
// second board does not produce a window in some other theme than the one it
// was opened from.
func TestUIPrefReadsFallBackToTheProject(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.SetUITheme("dark"); err != nil {
		t.Fatalf("seed project theme: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodGet,
		"/api/session/ui-theme?role="+core.WindowRolePinboardFor("board_a"), "", localViewerAddr, false)
	if !strings.Contains(rec.Body.String(), `"dark"`) {
		t.Fatalf("an unstyled board should follow the project theme, got %s", rec.Body.String())
	}
}

// The rest of the viewer's preferences — hidden info cards, dragged column
// widths — ride one route of their own, carrying an opaque map instead of a
// named value. The gate is the same one, for the same reason, and these repeat
// the four shapes above against it before going on to the merge semantics the
// map needs and the bounds that keep it from growing without limit.

func TestUIPrefsRouteAcceptsLocalViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs",
		`{"ui":{"juggler-column-width":"31.5"}}`, localViewerAddr, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("local ui-prefs write: got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if got := string(mgr.GetWindowUIPrefs(core.WindowRoleMain)["juggler-column-width"]); got != `"31.5"` {
		t.Fatalf("local ui-prefs write not stored: got %s", got)
	}

	rec = uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", localViewerAddr, false)
	if !strings.Contains(rec.Body.String(), `"31.5"`) {
		t.Fatalf("reading it back: got %s", rec.Body.String())
	}
}

func TestUIPrefsRouteRejectsLANViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.MergeWindowUIPrefs(core.WindowRoleMain, uiPrefsPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs",
		`{"ui":{"juggler-column-width":"90"}}`, remoteEdgeAddr, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("LAN ui-prefs write: got %d, want 403", rec.Code)
	}
	if got := string(mgr.GetWindowUIPrefs(core.WindowRoleMain)["juggler-column-width"]); got != `"31.5"` {
		t.Fatalf("LAN viewer changed the desktop's preferences: got %s", got)
	}
}

// The one the address check alone would miss: a DataChannel dispatch or tunnel
// forwarder hop reaches the server over loopback.
func TestUIPrefsRouteRejectsTunnelViewer(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)

	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs",
		`{"ui":{"juggler-column-width":"90"}}`, localViewerAddr, true)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("tunnelled ui-prefs write: got %d, want 403", rec.Code)
	}
	if got := mgr.GetWindowUIPrefs(core.WindowRoleMain); len(got) != 0 {
		t.Fatalf("tunnelled viewer wrote the desktop's preferences: got %v", got)
	}
}

// Only the writes are gated: a remote viewer starts from the desktop's
// preferences and keeps its own changes in its own localStorage.
func TestUIPrefsRouteReadsStayOpen(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.MergeWindowUIPrefs(core.WindowRoleMain, uiPrefsPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", remoteEdgeAddr, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("remote ui-prefs read: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"31.5"`) {
		t.Fatalf("remote read should return the saved preferences, got %s", rec.Body.String())
	}
}

// Each window names itself with ?role=, and the project-wide realm is named with
// ?scope=project. Three slots, no leakage between them.
func TestUIPrefsRouteKeepsTheRealmsApart(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	board := core.WindowRolePinboardFor("board_a")

	writes := []struct{ path, body string }{
		{"/api/session/ui-prefs", `{"ui":{"juggler-column-width":"20"}}`},
		{"/api/session/ui-prefs?role=" + board, `{"ui":{"juggler-column-width":"55"}}`},
		{"/api/session/ui-prefs?scope=project", `{"ui":{"juggler-column-width":"80"}}`},
	}
	for _, wr := range writes {
		if rec := uiPrefRequest(t, s, http.MethodPut, wr.path, wr.body, localViewerAddr, false); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: got %d: %s", wr.path, rec.Code, rec.Body.String())
		}
	}

	for _, want := range []struct{ path, value string }{
		{"/api/session/ui-prefs?role=main", `"20"`},
		{"/api/session/ui-prefs?role=" + board, `"55"`},
		{"/api/session/ui-prefs?scope=project", `"80"`},
	} {
		rec := uiPrefRequest(t, s, http.MethodGet, want.path, "", localViewerAddr, false)
		if !strings.Contains(rec.Body.String(), want.value) {
			t.Fatalf("GET %s: got %s, want %s", want.path, rec.Body.String(), want.value)
		}
	}
	// A window nobody has told anything is answered with nothing rather than
	// another window's or the project's.
	rec := uiPrefRequest(t, s, http.MethodGet,
		"/api/session/ui-prefs?role="+core.WindowRolePinboardFor("board_b"), "", localViewerAddr, false)
	if strings.Contains(rec.Body.String(), "juggler-column-width") {
		t.Fatalf("an untouched window inherited someone else's preferences: %s", rec.Body.String())
	}
	if _, ok := mgr.GetSessionUIPrefs()["juggler-pinboard-width"]; ok {
		t.Fatal("a window's preference reached the project's realm")
	}
}

// The viewer PUTs the preference it just changed, so a key the body omits is
// unchanged; null is how it drops one it no longer has.
func TestUIPrefsRouteMergesAndDeletes(t *testing.T) {
	s, _ := newUIPrefsTestServer(t)

	put := func(body string) {
		t.Helper()
		if rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs", body, localViewerAddr, false); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: got %d: %s", body, rec.Code, rec.Body.String())
		}
	}
	put(`{"ui":{"a":1,"b":2}}`)
	put(`{"ui":{"a":3}}`)

	rec := uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", localViewerAddr, false)
	if body := rec.Body.String(); !strings.Contains(body, `"a":3`) || !strings.Contains(body, `"b":2`) {
		t.Fatalf("a partial write must not drop the keys it omits: got %s", body)
	}

	put(`{"ui":{"a":null}}`)
	rec = uiPrefRequest(t, s, http.MethodGet, "/api/session/ui-prefs", "", localViewerAddr, false)
	if body := rec.Body.String(); strings.Contains(body, `"a"`) || !strings.Contains(body, `"b":2`) {
		t.Fatalf("null must delete just that key: got %s", body)
	}
}

// A patch past the bounds is the caller's fault, not the server's, and is
// refused whole — 400, with what was already stored left alone.
func TestUIPrefsRouteRefusesAPatchOverTheBounds(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	if err := mgr.MergeWindowUIPrefs(core.WindowRoleMain, uiPrefsPatch(t, `{"kept":1}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	body := fmt.Sprintf(`{"ui":{"big":%q}}`, strings.Repeat("x", 9<<10))
	rec := uiPrefRequest(t, s, http.MethodPut, "/api/session/ui-prefs", body, localViewerAddr, false)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an oversized preference: got %d, want 400", rec.Code)
	}
	prefs := mgr.GetWindowUIPrefs(core.WindowRoleMain)
	if len(prefs) != 1 || string(prefs["kept"]) != `1` {
		t.Fatalf("a refused patch must leave what was stored alone: got %v", prefs)
	}
}

// uiPrefsPatch builds a patch for seeding, from the JSON object a viewer sends.
func uiPrefsPatch(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &patch); err != nil {
		t.Fatalf("uiPrefsPatch(%s): %v", body, err)
	}
	return patch
}

// serveIndex injects the theme the page must paint on its very first frame. It
// reads the window from the URL the desktop app opened it with, so a board
// window's own theme is in the markup rather than corrected a frame later —
// which would be a visible flash of the wrong colour on every launch.
func TestIndexInjectsTheWindowsOwnTheme(t *testing.T) {
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	if err := mgr.SetWindowUITheme(core.WindowRoleMain, "dark"); err != nil {
		t.Fatalf("set main theme: %v", err)
	}
	if err := mgr.SetWindowUITheme(core.WindowRolePinboardFor("board_a"), "light"); err != nil {
		t.Fatalf("set board theme: %v", err)
	}
	if err := mgr.SetWindowUIZoom(core.WindowRolePinboardFor("board_a"), 130); err != nil {
		t.Fatalf("set board zoom: %v", err)
	}

	s := &Server{router: mux.NewRouter()}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	tmpl, err := template.New("index").Parse(`theme={{.InitialThemeMode}} zoom={{.InitialZoom}}`)
	if err != nil {
		t.Fatalf("parse stand-in template: %v", err)
	}
	s.indexTemplate = tmpl

	serve := func(target string) string {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.RemoteAddr = localViewerAddr
		rec := httptest.NewRecorder()
		s.serveIndex(rec, req)
		return rec.Body.String()
	}

	if got, want := serve("/?window=1"), "theme=dark zoom=0"; got != want {
		t.Fatalf("the ordinary window: got %q, want %q", got, want)
	}
	if got, want := serve("/?window=1&view=pinboard&board=board_a"), "theme=light zoom=130"; got != want {
		t.Fatalf("the board window: got %q, want %q", got, want)
	}
	if got, want := serve("/?window=1&view=pinboard&board=board_b"), "theme=dark zoom=0"; got != want {
		t.Fatalf("a board with nothing of its own follows the project: got %q, want %q", got, want)
	}
}

// TestProjectStorageKeyIsStable pins the property the viewer's namespacing rests
// on: one project always yields one key, however its path is spelled.
func TestProjectStorageKeyIsStable(t *testing.T) {
	dir := t.TempDir()
	uncleaned := filepath.Join(dir, "sub", "..") + string(filepath.Separator)

	if got, want := projectStorageKey(uncleaned), projectStorageKey(dir); got != want {
		t.Fatalf("uncleaned spelling of the same project differs: got %q, want %q", got, want)
	}
	if key := projectStorageKey(dir); len(key) != projectStorageKeyLen {
		t.Fatalf("key length: got %d (%q), want %d", len(key), key, projectStorageKeyLen)
	}
}

func TestProjectStorageKeyIsPerProject(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	if projectStorageKey(a) == projectStorageKey(b) {
		t.Fatalf("two projects share a storage key (%q) — their stored zoom/theme would collide",
			projectStorageKey(a))
	}
}

// TestProjectStorageKeyHidesThePath: the key lands in a localStorage the studio
// relay origin shares with other pages, so it must not carry where the project
// lives. A no-project window has no key at all and falls back to the bare one.
func TestProjectStorageKeyHidesThePath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "unmistakable-project-name")
	key := projectStorageKey(dir)
	if strings.Contains(key, "unmistakable-project-name") {
		t.Fatalf("storage key leaks the project path: %q", key)
	}
	if projectStorageKey("") != "" {
		t.Fatalf("no-project window should have no key, got %q", projectStorageKey(""))
	}
}

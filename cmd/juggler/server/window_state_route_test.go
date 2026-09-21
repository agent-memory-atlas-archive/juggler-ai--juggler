//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
)

// Geometry is kept per window role, because a project has more than one kind of
// window: Juggler itself, and a board detached from it. These tests go through
// the real router, since the role travels as a query parameter and a handler
// called directly would not prove the route carries it.

// getFrame reads one role's saved frame through the route.
func getFrame(t *testing.T, s *Server, path string) (core.WindowState, bool) {
	t.Helper()
	rec := pinboardRequest(t, s, http.MethodGet, path, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", path, rec.Code, rec.Body.String())
	}
	var body struct {
		WindowState core.WindowState `json:"windowState"`
		HasState    bool             `json:"hasState"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body.WindowState, body.HasState
}

// putFrame writes one role's frame through the route.
func putFrame(t *testing.T, s *Server, path string, ws core.WindowState) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(ws)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return pinboardRequest(t, s, http.MethodPut, path, string(body))
}

// The two roles are separate slots end to end. Before this, a board closing
// wrote its own frame over the project's, and the next launch put Juggler where
// the board had been.
func TestWindowStateRouteKeepsTheRolesApart(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	main := core.WindowState{X: 0, Y: 0, Width: 1400, Height: 900, HasPos: true}
	board := core.WindowState{X: 1420, Y: 40, Width: 520, Height: 900, HasPos: true}
	if rec := putFrame(t, s, "/api/session/window-state?role=main", main); rec.Code != http.StatusOK {
		t.Fatalf("PUT main = %d: %s", rec.Code, rec.Body.String())
	}
	if rec := putFrame(t, s, "/api/session/window-state?role=pinboard", board); rec.Code != http.StatusOK {
		t.Fatalf("PUT pinboard = %d: %s", rec.Code, rec.Body.String())
	}

	got, ok := getFrame(t, s, "/api/session/window-state?role=main")
	if !ok || !got.SameFrame(main) {
		t.Fatalf("the board's close overwrote the window's frame: got %+v want %+v", got, main)
	}
	got, ok = getFrame(t, s, "/api/session/window-state?role=pinboard")
	if !ok || !got.SameFrame(board) {
		t.Fatalf("board frame: got %+v want %+v", got, board)
	}
}

// A caller that names no role means the main window — which is what every
// request meant before there was a second kind, so an older desktop app talking
// to a newer server still reads and writes the frame it always did.
func TestWindowStateRouteDefaultsToTheMainWindow(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	want := core.WindowState{X: 12, Y: 34, Width: 800, Height: 600, HasPos: true}
	if rec := putFrame(t, s, "/api/session/window-state", want); rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d: %s", rec.Code, rec.Body.String())
	}

	if got, ok := getFrame(t, s, "/api/session/window-state?role=main"); !ok || !got.SameFrame(want) {
		t.Fatalf("an unnamed role is the main window: got %+v want %+v", got, want)
	}
	if got, ok := getFrame(t, s, "/api/session/window-state"); !ok || !got.SameFrame(want) {
		t.Fatalf("and reads back the same way: got %+v want %+v", got, want)
	}
}

// A role nothing has saved reports that it has none, so the window is placed by
// the default rather than on top of another window.
func TestWindowStateRouteReportsAnUnsavedRoleAsAbsent(t *testing.T) {
	s, _ := newPinboardTestServer(t)
	if rec := putFrame(t, s, "/api/session/window-state?role=main",
		core.WindowState{X: 1, Y: 2, Width: 3, Height: 4, HasPos: true}); rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d", rec.Code)
	}
	if _, ok := getFrame(t, s, "/api/session/window-state?role=pinboard"); ok {
		t.Fatal("a board that has never been opened has no frame of its own yet")
	}
}

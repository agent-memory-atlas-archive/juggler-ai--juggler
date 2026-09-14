//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// The workspace table through its routes: a workspace is registered before it
// is built, flipped to ready when it is, and tombstoned when it is finished
// with — and every one of those is broadcast whole, because a second window has
// no other way to learn that the thing it is watching became usable.

// newWorkspaceTestServer wires the real session routes over a real (temp-dir)
// session manager, so these tests exercise registered routes rather than
// calling handlers directly.
func newWorkspaceTestServer(t *testing.T) (*Server, *recordingBroadcaster, string) {
	t.Helper()
	dir := t.TempDir()
	mgr, err := core.NewSessionManagerForPath(dir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	bc := &recordingBroadcaster{}
	s := &Server{router: mux.NewRouter()}
	s.setupSessionRoutes(handlers.NewSessionAPI(
		func() *core.SessionManager { return mgr }, nil, bc, nil, nil))
	return s, bc, dir
}

// decodeWorkspace reads the `workspace` object out of a response.
func decodeWorkspace(t *testing.T, rec *httptest.ResponseRecorder) core.Workspace {
	t.Helper()
	var body struct {
		Workspace core.Workspace `json:"workspace"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode workspace from %q: %v", rec.Body.String(), err)
	}
	return body.Workspace
}

// decodeWorkspaces reads the `workspaces` array out of a response.
func decodeWorkspaces(t *testing.T, rec *httptest.ResponseRecorder) []core.Workspace {
	t.Helper()
	var body struct {
		Workspaces []core.Workspace `json:"workspaces"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode workspaces from %q: %v", rec.Body.String(), err)
	}
	return body.Workspaces
}

// A workspace's whole life through the routes: registered as provisioning,
// flipped to ready, listed, then tombstoned — still there, still resolving.
func TestWorkspaceRoutes_RegisterReadyCloseRoundTrip(t *testing.T) {
	s, bc, dir := newWorkspaceTestServer(t)

	rec := pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET workspaces: got %d, want 200", rec.Code)
	}
	// An empty table must serialize as [], not null, so a client can iterate it
	// without sanitizing first.
	if got := rec.Body.String(); !strings.Contains(got, `"workspaces":[]`) {
		t.Fatalf("empty table serialized as %q, want an empty array", got)
	}

	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"label":"feat/tunnels","providerId":"git-worktree"}`, dir))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST workspaces: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	ws := decodeWorkspace(t, rec)
	if ws.ID == "" {
		t.Fatalf("registered workspace has no id: %+v", ws)
	}
	if ws.State != core.WorkspaceStateProvisioning {
		t.Fatalf("state = %q, want a workspace registered before it is built", ws.State)
	}
	if len(bc.workspaces) != 1 || len(bc.workspaces[0]) != 1 {
		t.Fatalf("broadcasts = %v, want one carrying the whole table", bc.workspaces)
	}

	rec = pinboardRequest(t, s, http.MethodPatch, "/api/session/workspaces/"+ws.ID,
		`{"state":"ready","meta":{"treeAdded":true}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH workspace: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if ready := decodeWorkspace(t, rec); ready.State != core.WorkspaceStateReady || ready.Meta["treeAdded"] != true {
		t.Fatalf("patched workspace = %+v, want it ready with the checkpoint kept", ready)
	}

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	listed := decodeWorkspaces(t, rec)
	if len(listed) != 1 || listed[0].ID != ws.ID || !listed[0].Available {
		t.Fatalf("listed = %+v, want the one ready workspace", listed)
	}

	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/"+ws.ID+"/close", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST close: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if closed := decodeWorkspace(t, rec); closed.State != core.WorkspaceStateClosed {
		t.Fatalf("closed workspace = %+v, want a tombstone", closed)
	}

	// The tombstone stays on the table: the id has to keep resolving, or a
	// conversation bound to it is told it is unknown rather than closed.
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if after := decodeWorkspaces(t, rec); len(after) != 1 || after[0].State != core.WorkspaceStateClosed {
		t.Fatalf("table after close = %+v, want the tombstone kept", after)
	}
	if len(bc.workspaces) != 3 {
		t.Fatalf("%d broadcasts, want one per edit", len(bc.workspaces))
	}
}

// Unregistering is the rollback path: the workspace was never built, so the row
// goes rather than being tombstoned.
func TestWorkspaceRoutes_UnregisterRemovesTheRow(t *testing.T) {
	s, _, dir := newWorkspaceTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q}`, dir))
	ws := decodeWorkspace(t, rec)

	rec = pinboardRequest(t, s, http.MethodDelete, "/api/session/workspaces/"+ws.ID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE workspace: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if after := decodeWorkspaces(t, rec); len(after) != 0 {
		t.Fatalf("table = %+v, want it empty", after)
	}
}

// A request about a workspace that is not there is a 404, not a 400: the client
// asked a well-formed question about something that has gone.
func TestWorkspaceRoutes_UnknownIDIsNotFound(t *testing.T) {
	s, _, _ := newWorkspaceTestServer(t)

	rec := pinboardRequest(t, s, http.MethodPatch, "/api/session/workspaces/ws_nope", `{"label":"ghost"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PATCH unknown workspace: got %d, want 404", rec.Code)
	}
	rec = pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/ws_nope/close", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST close of unknown workspace: got %d, want 404", rec.Code)
	}
}

// Reconciling is destructive and only the browser can do it, so exactly one
// viewer per run of the server is told to.
func TestWorkspaceRoutes_ReconcileClaimedOnce(t *testing.T) {
	s, _, _ := newWorkspaceTestServer(t)

	first := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/reconcile", "")
	second := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces/reconcile", "")

	if !strings.Contains(first.Body.String(), `"reconcile":true`) {
		t.Fatalf("first claim = %q, want it granted", first.Body.String())
	}
	if !strings.Contains(second.Body.String(), `"reconcile":false`) {
		t.Fatalf("second claim = %q, want it refused", second.Body.String())
	}
}

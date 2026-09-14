//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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

// A tree removed while the app is running stops reading as available.
//
// Availability is otherwise settled at load and on each register or update, so
// a worktree deleted mid-session leaves the flag saying the tree is there.
// Everything that protects the user from a place that has gone keys off that
// one boolean — the rows the setup panel offers, the chip, and the banner that
// tells a bound conversation its tree is not where it was — so a stale true is
// three silent failures at once. Listing re-stats, and broadcasts when the
// answer has moved so that every viewer's mirror is corrected with it.
func TestWorkspaceRoutes_ListRestatsAVanishedRoot(t *testing.T) {
	s, bc, _ := newWorkspaceTestServer(t)

	tree := t.TempDir()
	rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"label":"feat/tunnels","state":"ready"}`, tree))
	ws := decodeWorkspace(t, rec)
	if !ws.Available {
		t.Fatalf("registered workspace = %+v, want it available while its tree is there", ws)
	}
	edits := len(bc.workspaces)

	if err := os.RemoveAll(tree); err != nil {
		t.Fatalf("removing the tree: %v", err)
	}

	rec = pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	listed := decodeWorkspaces(t, rec)
	if len(listed) != 1 || listed[0].ID != ws.ID {
		t.Fatalf("listed = %+v, want the one row still on the table", listed)
	}
	if listed[0].Available {
		t.Fatalf("workspace = %+v, want available:false once its root has gone", listed[0])
	}
	// Unavailable, not closed. A tree can come back — an unmounted disk, a
	// prune somebody regrets — and tombstoning is one-way.
	if listed[0].State != core.WorkspaceStateReady {
		t.Fatalf("state = %q, want it left ready: a missing root is not a tombstone", listed[0].State)
	}
	if len(bc.workspaces) != edits+1 {
		t.Fatalf("%d broadcasts, want one more so every viewer's mirror is corrected", len(bc.workspaces))
	}

	// Nothing has moved on the second look, so nothing is said. This sweep sits
	// on a read path and must stay silent when it has nothing to report, or
	// every list turns into a broadcast to every window.
	pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", "")
	if len(bc.workspaces) != edits+1 {
		t.Fatalf("%d broadcasts, want the unchanged re-list to stay quiet", len(bc.workspaces))
	}
}

// Tombstones are capped, so finishing with workspaces cannot grow session.json
// without bound.
//
// A closed row is kept to tell the conversations bound to it what became of
// their workspace, which is worth keeping for the ones somebody might go back
// to and worth nothing for the hundredth. Past the cap the oldest go, and a
// conversation bound to one that has gone falls back to the banner for a
// binding the table has lost — which offers to put it back.
//
// A ready row is never evicted to make room. The cap is on the dead ones; a
// workspace somebody is still working in is not a candidate however full the
// table is.
func TestWorkspaceRoutes_ClosedWorkspacesAreCapped(t *testing.T) {
	s, _, dir := newWorkspaceTestServer(t)

	live := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
		fmt.Sprintf(`{"kind":"local","root":%q,"label":"still-working-here","state":"ready"}`, dir))
	liveID := decodeWorkspace(t, live).ID

	over := core.MaxClosedWorkspaces + 2
	closed := make([]string, 0, over)
	for i := range over {
		rec := pinboardRequest(t, s, http.MethodPost, "/api/session/workspaces",
			fmt.Sprintf(`{"kind":"local","root":%q,"label":"finished-%d","state":"ready"}`, dir, i))
		id := decodeWorkspace(t, rec).ID
		if rec = pinboardRequest(t, s, http.MethodPost,
			"/api/session/workspaces/"+id+"/close", ""); rec.Code != http.StatusOK {
			t.Fatalf("closing workspace %d: got %d (%s)", i, rec.Code, rec.Body.String())
		}
		closed = append(closed, id)
	}

	listed := decodeWorkspaces(t, pinboardRequest(t, s, http.MethodGet, "/api/session/workspaces", ""))
	tombstones := make(map[string]bool)
	liveRows := 0
	for _, ws := range listed {
		if ws.State == core.WorkspaceStateClosed {
			tombstones[ws.ID] = true
			continue
		}
		liveRows++
	}

	if len(tombstones) != core.MaxClosedWorkspaces {
		t.Fatalf("%d tombstones kept, want the cap of %d", len(tombstones), core.MaxClosedWorkspaces)
	}
	// Oldest first: the two closed before any others are the two that went.
	for _, gone := range closed[:2] {
		if tombstones[gone] {
			t.Fatalf("workspace %s survived, want the oldest tombstones evicted first", gone)
		}
	}
	for _, kept := range closed[2:] {
		if !tombstones[kept] {
			t.Fatalf("workspace %s was evicted, want the most recent %d kept", kept, core.MaxClosedWorkspaces)
		}
	}
	if liveRows != 1 || listed[0].ID != liveID {
		t.Fatalf("live rows = %d (first %q), want the one ready workspace untouched by the cap",
			liveRows, listed[0].ID)
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

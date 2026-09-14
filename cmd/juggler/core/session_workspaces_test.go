//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// workspaceForTest returns a ready local workspace rooted at an existing
// directory, which is what the load-time verification pass expects to find.
func workspaceForTest(t *testing.T, id, root string) Workspace {
	t.Helper()
	return Workspace{
		ID:         id,
		Kind:       WorkspaceKindLocal,
		Root:       root,
		Label:      "feat/tunnels",
		ProviderID: "git-worktree",
		State:      WorkspaceStateReady,
		Available:  true,
		Meta:       map[string]any{"branch": "feat/tunnels", "treeAdded": true},
	}
}

// A registered workspace survives a trip through session.json. The table is the
// only record of where a conversation's files are, so anything dropped here
// strands every conversation bound to it.
func TestWorkspaces_SurviveSaveAndLoad(t *testing.T) {
	store, dir := newStoreForTest(t)

	sess := NewSession()
	sess.Workspaces = []Workspace{workspaceForTest(t, "ws_1", dir)}
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	loaded, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded.Workspaces) != 1 {
		t.Fatalf("Workspaces = %v, want the one that was saved", loaded.Workspaces)
	}
	got := loaded.Workspaces[0]
	want := sess.Workspaces[0]
	if got.ID != want.ID || got.Kind != want.Kind || got.Root != want.Root ||
		got.Label != want.Label || got.ProviderID != want.ProviderID || got.State != want.State {
		t.Fatalf("workspace round-tripped as %+v, want %+v", got, want)
	}
	if got.Meta["branch"] != "feat/tunnels" || got.Meta["treeAdded"] != true {
		t.Fatalf("meta round-tripped as %v, want the provider's blob verbatim", got.Meta)
	}
}

// Clone must deep-copy the table. A snapshot handed out by GetSession is
// mutated freely by its caller; if the meta map were shared, a provider
// checkpointing into a snapshot would be writing into the actor's live state.
func TestWorkspaces_CloneIsolatesMeta(t *testing.T) {
	sess := NewSession()
	sess.Workspaces = []Workspace{workspaceForTest(t, "ws_1", t.TempDir())}

	snapshot := sess.Clone()
	snapshot.Workspaces[0].Meta["branch"] = "something-else"
	snapshot.Workspaces[0].Label = "renamed"
	snapshot.Workspaces = append(snapshot.Workspaces, workspaceForTest(t, "ws_2", t.TempDir()))

	if sess.Workspaces[0].Meta["branch"] != "feat/tunnels" {
		t.Fatalf("original meta = %v, want it untouched by the snapshot", sess.Workspaces[0].Meta)
	}
	if sess.Workspaces[0].Label != "feat/tunnels" {
		t.Fatalf("original label = %q, want it untouched by the snapshot", sess.Workspaces[0].Label)
	}
	if len(sess.Workspaces) != 1 {
		t.Fatalf("original table has %d rows, want the snapshot's append to have stayed there", len(sess.Workspaces))
	}
}

// A session that has never made a workspace stores no table at all, and one
// that asks for the default workspace by id gets a miss — the project is not a
// row, and the caller that wants it already holds the project path.
func TestWorkspaces_DefaultIsNotARow(t *testing.T) {
	sess := NewSession()
	if sess.Workspaces != nil {
		t.Fatalf("new session has %v, want no table until one is made", sess.Workspaces)
	}
	if ws, ok := sess.FindWorkspace(DefaultWorkspaceID); ok {
		t.Fatalf("FindWorkspace(default) returned %+v, want a miss", ws)
	}
}

func TestWorkspace_Validate(t *testing.T) {
	base := workspaceForTest(t, "ws_1", t.TempDir())

	if err := base.Validate(); err != nil {
		t.Fatalf("a well-formed workspace was rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*Workspace)
		want   string
	}{
		{"no kind", func(w *Workspace) { w.Kind = "" }, "kind"},
		{"no root", func(w *Workspace) { w.Root = "" }, "root"},
		{"bad state", func(w *Workspace) { w.State = "half-built" }, "state"},
		{"bad id", func(w *Workspace) { w.ID = "../escape" }, "id"},
		{"long label", func(w *Workspace) { w.Label = strings.Repeat("A", MaxWorkspaceLabelLen+1) }, "label"},
		{"huge meta", func(w *Workspace) {
			w.Meta = map[string]any{"blob": strings.Repeat("x", MaxWorkspaceMetaBytes+1)}
		}, "meta"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ws := base.Clone()
			tc.mutate(&ws)
			err := ws.Validate()
			if err == nil {
				t.Fatalf("Validate() accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Validate() = %q, want a message naming %q", err, tc.want)
			}
		})
	}
}

// managerForWorkspaceTest starts a manager on a fresh project, as a window
// would, and returns it with the project directory.
func managerForWorkspaceTest(t *testing.T) (*SessionManager, string) {
	t.Helper()
	store, dir := newStoreForTest(t)
	m := startManager(store, dir, "")
	t.Cleanup(m.Shutdown)
	return m, dir
}

// A workspace is registered before it is built, so the row that describes a
// provision is on the table from the first command it runs.
func TestRegisterWorkspace_DefaultsToProvisioning(t *testing.T) {
	m, _ := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: filepath.Join(t.TempDir(), "not-built-yet")})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if ws.ID == "" || !strings.HasPrefix(ws.ID, "ws_") {
		t.Fatalf("assigned id = %q, want a ws_ id", ws.ID)
	}
	if ws.State != WorkspaceStateProvisioning {
		t.Fatalf("state = %q, want %q", ws.State, WorkspaceStateProvisioning)
	}
	if ws.Kind != WorkspaceKindLocal {
		t.Fatalf("kind = %q, want %q", ws.Kind, WorkspaceKindLocal)
	}
	if ws.Available {
		t.Fatalf("available = true for a root that does not exist yet")
	}

	listed := m.ListWorkspaces()
	if len(listed) != 1 || listed[0].ID != ws.ID {
		t.Fatalf("ListWorkspaces = %+v, want the registered workspace", listed)
	}
	if got, ok := m.GetWorkspace(ws.ID); !ok || got.ID != ws.ID {
		t.Fatalf("GetWorkspace(%s) = %+v, %v", ws.ID, got, ok)
	}
	if _, ok := m.GetWorkspace("ws_nope"); ok {
		t.Fatalf("GetWorkspace of an unknown id reported a hit")
	}
}

// The flip to ready is what a finished provision writes, and it is what makes
// the root real: availability is re-checked on every write.
func TestUpdateWorkspace_ReadyFlipAndMetaMerge(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir, Meta: map[string]any{"branch": "feat/x", "treeAdded": false}})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	ready := WorkspaceStateReady
	label := "feat/x"
	updated, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{
		State: &ready,
		Label: &label,
		Meta:  map[string]any{"treeAdded": true, "hookStarted": true},
	})
	if err != nil {
		t.Fatalf("UpdateWorkspace: %v", err)
	}
	if updated.State != WorkspaceStateReady || updated.Label != "feat/x" {
		t.Fatalf("updated = %+v, want a ready workspace labelled feat/x", updated)
	}
	if !updated.Available {
		t.Fatalf("available = false for a root that is there")
	}
	// Merged, not replaced: the key the patch never mentioned survives.
	if updated.Meta["branch"] != "feat/x" || updated.Meta["treeAdded"] != true || updated.Meta["hookStarted"] != true {
		t.Fatalf("meta = %v, want the patch merged over what was there", updated.Meta)
	}

	// A nil value deletes its key, as it does for session metadata.
	updated, err = m.UpdateWorkspace(ws.ID, WorkspacePatch{Meta: map[string]any{"hookStarted": nil}})
	if err != nil {
		t.Fatalf("UpdateWorkspace (delete key): %v", err)
	}
	if _, present := updated.Meta["hookStarted"]; present {
		t.Fatalf("meta = %v, want hookStarted deleted", updated.Meta)
	}
}

func TestUpdateWorkspace_UnknownIDIsAnError(t *testing.T) {
	m, _ := managerForWorkspaceTest(t)

	label := "ghost"
	if _, err := m.UpdateWorkspace("ws_nope", WorkspacePatch{Label: &label}); err == nil {
		t.Fatalf("UpdateWorkspace of an unknown id succeeded, want an error")
	}
}

// Closing tombstones the row, is idempotent, and is final: a closed workspace
// takes no further changes, because conversations have already been told it is
// gone.
func TestCloseWorkspace_TombstonesAndIsFinal(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	closed, err := m.CloseWorkspace(ws.ID)
	if err != nil {
		t.Fatalf("CloseWorkspace: %v", err)
	}
	if closed.State != WorkspaceStateClosed {
		t.Fatalf("state = %q, want %q", closed.State, WorkspaceStateClosed)
	}
	if again, err := m.CloseWorkspace(ws.ID); err != nil || again.State != WorkspaceStateClosed {
		t.Fatalf("closing twice = %+v, %v; want the tombstone back unchanged", again, err)
	}
	if _, ok := m.GetWorkspace(ws.ID); !ok {
		t.Fatalf("closed workspace left the table; the id must keep resolving")
	}

	ready := WorkspaceStateReady
	if _, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{State: &ready}); err == nil {
		t.Fatalf("a closed workspace was reopened, want the update refused")
	}
	if _, err := m.CloseWorkspace("ws_nope"); err == nil {
		t.Fatalf("closing an unknown id succeeded, want an error")
	}
}

// Unregister is the rollback path: the workspace was never built, so there is
// nothing anyone can have been bound to, and forgetting it is right.
func TestUnregisterWorkspace_RemovesAndIsIdempotent(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if err := m.UnregisterWorkspace(ws.ID); err != nil {
		t.Fatalf("UnregisterWorkspace: %v", err)
	}
	if len(m.ListWorkspaces()) != 0 {
		t.Fatalf("table = %+v, want it empty", m.ListWorkspaces())
	}
	if err := m.UnregisterWorkspace(ws.ID); err != nil {
		t.Fatalf("unregistering twice: %v, want it to be a no-op", err)
	}
}

func TestRegisterWorkspace_RejectsDuplicateID(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if _, err := m.RegisterWorkspace(Workspace{ID: ws.ID, Root: dir}); err == nil {
		t.Fatalf("registering a second workspace under id %s succeeded", ws.ID)
	}
}

// writeManifest hand-writes a session.json, as an older build (or another
// machine) would have left one.
func writeManifest(t *testing.T, dir, manifest string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, ".juggler", "session.json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("write session.json: %v", err)
	}
}

// loadFresh loads through a new store, as a newly opened window would.
func loadFresh(t *testing.T, dir string) *Session {
	t.Helper()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := store.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return sess
}

// A root that has gone since the last run — a hand-run `git worktree remove`, a
// reprovisioned machine — is caught once, at load, so the user sees one banner
// instead of discovering it through a cascade of failing operations mid-turn.
// A provisioning row is stale by definition: no provisioner survives a restart.
func TestLoad_VerifiesWorkspaceRootsAndStaleProvisions(t *testing.T) {
	_, dir := newStoreForTest(t)
	live := t.TempDir()

	writeManifest(t, dir, `{
	  "version": 5,
	  "conversationOrder": [],
	  "activeConversationId": "",
	  "messageHistory": [],
	  "workspaces": [
	    {"id":"ws_live","kind":"local","root":"`+live+`","state":"ready","available":true},
	    {"id":"ws_gone","kind":"local","root":"`+filepath.Join(live, "removed-by-hand")+`","state":"ready","available":true},
	    {"id":"ws_half","kind":"local","root":"`+filepath.Join(live, "never-finished")+`","state":"provisioning"}
	  ]
	}`)

	sess := loadFresh(t, dir)
	if len(sess.Workspaces) != 3 {
		t.Fatalf("Workspaces = %+v, want all three rows kept", sess.Workspaces)
	}
	byID := map[string]Workspace{}
	for _, ws := range sess.Workspaces {
		byID[ws.ID] = ws
	}
	if !byID["ws_live"].Available {
		t.Fatalf("ws_live = %+v, want it available", byID["ws_live"])
	}
	if byID["ws_gone"].Available {
		t.Fatalf("ws_gone = %+v, want available:false — its root is not there", byID["ws_gone"])
	}
	if !byID["ws_half"].Stale {
		t.Fatalf("ws_half = %+v, want it flagged stale — nothing is provisioning it", byID["ws_half"])
	}
	if byID["ws_live"].Stale {
		t.Fatalf("ws_live = %+v, want a ready workspace left unflagged", byID["ws_live"])
	}

	// The verdict is persisted, so a second window reads it rather than
	// re-deriving it, and reopening the project does not re-offer a cleanup
	// that was already dealt with.
	again := loadFresh(t, dir)
	for _, ws := range again.Workspaces {
		if ws.ID == "ws_gone" && ws.Available {
			t.Fatalf("ws_gone came back available after a second load")
		}
		if ws.ID == "ws_half" && !ws.Stale {
			t.Fatalf("ws_half came back unflagged after a second load")
		}
	}
}

// A manifest that predates workspaces, one with the table removed, and one that
// is corrupt must all load. The table is state the app can rebuild; the
// conversations are not, and nothing here may cost them.
func TestLoad_ToleratesAbsentAndCorruptWorkspaceTable(t *testing.T) {
	for _, tc := range []struct {
		name     string
		manifest string
	}{
		{"no table", `{"version":5,"conversationOrder":[],"activeConversationId":"","messageHistory":[]}`},
		{"null table", `{"version":5,"conversationOrder":[],"activeConversationId":"","messageHistory":[],"workspaces":null}`},
		{"corrupt manifest", `{ this is not valid json`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, dir := newStoreForTest(t)
			if _, _, _, err := store.CreateConversationFolder("Untitled 1", ""); err != nil {
				t.Fatalf("CreateConversationFolder: %v", err)
			}
			writeManifest(t, dir, tc.manifest)

			sess := loadFresh(t, dir)
			if len(sess.Workspaces) != 0 {
				t.Fatalf("Workspaces = %+v, want an empty table", sess.Workspaces)
			}
			if len(sess.ConversationOrder) != 1 {
				t.Fatalf("ConversationOrder = %v, want the conversation on disk", sess.ConversationOrder)
			}
		})
	}
}

// A manifest field this build has never heard of survives a load and save.
//
// The case it is really about is a downgrade: run an older Juggler on a project
// that has workspaces, and every conversation bound to one is stranded the
// moment that build saves the session — not by a crash, but by a struct that
// quietly dropped a field it did not know. What goes for the workspace table
// goes for whatever is added next, so this is enforced generally.
func TestSaveLoad_KeepsManifestFieldsThisBuildDoesNotKnow(t *testing.T) {
	store, dir := newStoreForTest(t)

	writeManifest(t, dir, `{
	  "version": 5,
	  "conversationOrder": [],
	  "activeConversationId": "",
	  "messageHistory": [],
	  "somethingFromTheFuture": {"kept": ["verbatim", 2]}
	}`)

	sess := loadFresh(t, dir)
	sess.ActiveConversationID = "conv_x"
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, ".juggler", "session.json"))
	if err != nil {
		t.Fatalf("read session.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("re-read saved manifest: %v", err)
	}
	future, ok := raw["somethingFromTheFuture"].(map[string]any)
	if !ok {
		t.Fatalf("saved manifest = %s, want the unknown field kept", data)
	}
	kept, ok := future["kept"].([]any)
	if !ok || len(kept) != 2 || kept[0] != "verbatim" {
		t.Fatalf("unknown field came back as %v, want it verbatim", future)
	}
	if raw["activeConversationId"] != "conv_x" {
		t.Fatalf("activeConversationId = %v, want the write this build made", raw["activeConversationId"])
	}
}

// Reconciling is destructive and only the browser can do it, so exactly one
// client per run is told to. A later run asks again.
func TestClaimWorkspaceReconcile_AnswersOncePerRun(t *testing.T) {
	store, dir := newStoreForTest(t)
	m := startManager(store, dir, "")
	t.Cleanup(m.Shutdown)

	if !m.ClaimWorkspaceReconcile() {
		t.Fatalf("the first client was not given the reconcile")
	}
	if m.ClaimWorkspaceReconcile() {
		t.Fatalf("a second window was given the reconcile too")
	}

	// A new run of the server — the claim is about this process, not the
	// project, so it is offered again.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	m2 := startManager(fresh, dir, "")
	t.Cleanup(m2.Shutdown)
	if !m2.ClaimWorkspaceReconcile() {
		t.Fatalf("the next run was not offered the reconcile")
	}
}

// An id is assigned by the server, but it is echoed back in every operation
// request, so it has to be usable as a path-free token wherever it lands.
func TestWorkspace_IDShapeRejectsSeparators(t *testing.T) {
	for _, id := range []string{"a/b", "..", filepath.Join("x", "y"), "with space", ""} {
		ws := workspaceForTest(t, id, t.TempDir())
		if id == "" {
			// The empty id is the default workspace's, which is never a row and
			// so never validated as one; Validate only checks a non-empty id.
			continue
		}
		if err := ws.Validate(); err == nil {
			t.Fatalf("Validate() accepted workspace id %q", id)
		}
	}
}

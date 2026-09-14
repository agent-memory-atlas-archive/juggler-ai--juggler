//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import "fmt"

// Workspace lifecycle, on the actor goroutine.
//
// The table is written from two directions at once — the browser provisioning a
// workspace, and a second window watching it appear — so every mutation here
// runs as a write task with exclusive access to the live session, like every
// other session mutation. Reads hand back clones: the caller owns what it is
// given and can do nothing to the table with it.

// WorkspacePatch is a targeted change to one workspace. Every field is
// optional, and an omitted one leaves what is there alone — a provider
// checkpointing its progress must be able to write one key without restating
// the row it has not finished building.
//
// Meta is merged key by key rather than replaced, on PatchMetadata's pattern: a
// nil value deletes its key. Replacement would make every checkpoint a
// read-modify-write across the wire, and two windows could then overwrite each
// other's steps.
type WorkspacePatch struct {
	Label *string        `json:"label,omitempty"`
	Root  *string        `json:"root,omitempty"`
	State *string        `json:"state,omitempty"`
	Meta  map[string]any `json:"meta,omitempty"`
}

// ErrWorkspaceNotFound is returned for an id that is not on the table. It is
// deliberately an error rather than a silent miss: a stale binding must surface
// where it is used, not quietly run somewhere else.
var ErrWorkspaceNotFound = fmt.Errorf("workspace not found")

// ListWorkspaces returns every registered workspace, in registration order.
func (m *SessionManager) ListWorkspaces() []Workspace {
	out, _ := runRead(m, func(s *sessionState) ([]Workspace, error) {
		if s.session == nil {
			return []Workspace{}, nil
		}
		list := make([]Workspace, 0, len(s.session.Workspaces))
		for _, ws := range s.session.Workspaces {
			list = append(list, ws.Clone())
		}
		return list, nil
	})
	return out
}

// GetWorkspace returns one registered workspace by id.
//
// The default workspace is not one of them and answers false: it has no row,
// and every caller that could ask for it already holds the project path.
func (m *SessionManager) GetWorkspace(id string) (Workspace, bool) {
	type result struct {
		ws Workspace
		ok bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil {
			return result{}, nil
		}
		ws, ok := s.session.FindWorkspace(id)
		return result{ws: ws.Clone(), ok: ok}, nil
	})
	return r.ws, r.ok
}

// RegisterWorkspace puts a workspace on the table and returns it as stored,
// with the id the server assigned it.
//
// A workspace is registered BEFORE it is built, in the provisioning state, so
// that a provision interrupted half way through leaves a row describing what
// was started. The alternative — register on success — makes an interrupted
// provision invisible: a half-made worktree on disk that nothing in the app has
// heard of, for the user to find months later.
func (m *SessionManager) RegisterWorkspace(ws Workspace) (Workspace, error) {
	return runWrite(m, func(s *sessionState) (Workspace, error) {
		if s.session == nil {
			return Workspace{}, fmt.Errorf("no project is open")
		}
		if ws.State == "" {
			ws.State = WorkspaceStateProvisioning
		}
		if ws.Kind == "" {
			ws.Kind = WorkspaceKindLocal
		}
		if ws.ID == "" {
			ws.ID = GenerateWorkspaceID()
		}
		if err := ws.Validate(); err != nil {
			return Workspace{}, err
		}
		if _, exists := s.session.FindWorkspace(ws.ID); exists {
			return Workspace{}, fmt.Errorf("workspace id already registered: %s", ws.ID)
		}
		if len(s.session.Workspaces) >= MaxWorkspaces {
			return Workspace{}, fmt.Errorf("too many workspaces: %d (max %d)", len(s.session.Workspaces), MaxWorkspaces)
		}
		ws = ws.Clone()
		ws.Stale = false
		ws.refreshAvailability()
		s.session.Workspaces = append(s.session.Workspaces, ws)
		if err := s.store.Save(s.session); err != nil {
			return Workspace{}, err
		}
		return ws.Clone(), nil
	})
}

// UpdateWorkspace applies a patch to one workspace and returns it as stored.
//
// A closed workspace takes no further changes. Closing is the end of a
// workspace's life rather than a state it can be talked out of: conversations
// have already been told it is gone, and reviving the row would leave them
// bound to something they were told to rebind away from. A new workspace is
// what a second life looks like.
func (m *SessionManager) UpdateWorkspace(id string, patch WorkspacePatch) (Workspace, error) {
	return runWrite(m, func(s *sessionState) (Workspace, error) {
		if s.session == nil {
			return Workspace{}, fmt.Errorf("no project is open")
		}
		idx := -1
		for i, ws := range s.session.Workspaces {
			if ws.ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return Workspace{}, fmt.Errorf("%w: %s", ErrWorkspaceNotFound, id)
		}
		ws := s.session.Workspaces[idx].Clone()
		if ws.State == WorkspaceStateClosed {
			return Workspace{}, fmt.Errorf("workspace %s is closed", id)
		}
		if patch.Label != nil {
			ws.Label = *patch.Label
		}
		if patch.Root != nil {
			ws.Root = *patch.Root
		}
		if patch.State != nil {
			ws.State = *patch.State
		}
		if len(patch.Meta) > 0 {
			if ws.Meta == nil {
				ws.Meta = map[string]any{}
			}
			for k, v := range patch.Meta {
				if v == nil {
					delete(ws.Meta, k)
					continue
				}
				ws.Meta[k] = v
			}
		}
		if err := ws.Validate(); err != nil {
			return Workspace{}, err
		}
		// A row that has left provisioning is no longer a leftover of a
		// provision that died, whatever an earlier load decided.
		if ws.State != WorkspaceStateProvisioning {
			ws.Stale = false
		}
		ws.refreshAvailability()
		s.session.Workspaces[idx] = ws
		if err := s.store.Save(s.session); err != nil {
			return Workspace{}, err
		}
		return ws.Clone(), nil
	})
}

// CloseWorkspace tombstones a workspace: the row stays, the state becomes
// closed, and operations against it fail saying so.
//
// It is a tombstone rather than a deletion because the id outlives it. Any
// number of conversations may be bound to a workspace and none of them owns it,
// so the one that closes it leaves the others holding an id — and an id that
// still resolves can say "this was closed" where one that has been forgotten
// can only say "unknown", which is the message reserved for a binding that is
// genuinely stale.
//
// Closing one that is already closed is not an error: two windows may reach it,
// and neither is in a position to know what the other did.
func (m *SessionManager) CloseWorkspace(id string) (Workspace, error) {
	return runWrite(m, func(s *sessionState) (Workspace, error) {
		if s.session == nil {
			return Workspace{}, fmt.Errorf("no project is open")
		}
		for i, ws := range s.session.Workspaces {
			if ws.ID != id {
				continue
			}
			if ws.State == WorkspaceStateClosed {
				return ws.Clone(), nil
			}
			ws.State = WorkspaceStateClosed
			ws.Stale = false
			s.session.Workspaces[i] = ws
			if err := s.store.Save(s.session); err != nil {
				return Workspace{}, err
			}
			return ws.Clone(), nil
		}
		return Workspace{}, fmt.Errorf("%w: %s", ErrWorkspaceNotFound, id)
	})
}

// ClaimWorkspaceReconcile answers yes to the first client of this run that
// offers to reconcile the workspace table against what is on disk, and no to
// every client after it.
//
// Reconciling means asking each provider what it can actually find — running
// `git worktree list` and its like, offering to clean up what nothing is bound
// to. That is the browser's job, because only the browser has the providers.
// But there is no leader among clients: without this, every open window would
// run it, and two windows would race each other's destructive git commands over
// the same trees.
//
// Settled on the actor goroutine, where two windows opening together are
// serialized and the second is told no. Deliberately not persisted: a run that
// ends before reconciling leaves the next one to do it.
func (m *SessionManager) ClaimWorkspaceReconcile() bool {
	claimed, _ := runWrite(m, func(s *sessionState) (bool, error) {
		if s.session == nil || s.workspacesReconciled {
			return false, nil
		}
		s.workspacesReconciled = true
		return true, nil
	})
	return claimed
}

// UnregisterWorkspace removes a row outright — what rolling back a provision
// does, and the one case where forgetting is right: the workspace was never
// built, so there is nothing for anyone to have been bound to.
//
// Removing one that is not there is not an error, for the same reason closing
// twice isn't: rollback and cleanup can both arrive here.
func (m *SessionManager) UnregisterWorkspace(id string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		for i, ws := range s.session.Workspaces {
			if ws.ID != id {
				continue
			}
			s.session.Workspaces = append(s.session.Workspaces[:i], s.session.Workspaces[i+1:]...)
			return struct{}{}, s.store.Save(s.session)
		}
		return struct{}{}, nil
	})
	return err
}

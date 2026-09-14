//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestSpawn_UsesWorkspaceRoot covers a conversation bound to a workspace that
// is not the project — a git worktree, say. Two things must be true at once,
// and they pull in opposite directions:
//
//   - the CLI spawns in the WORKSPACE, because the tree it is being asked
//     about is the one it must read, and
//   - the warm-resume sidecar stays in the PROJECT, because it is ours, not
//     the user's. A worktree that acquires an untracked .juggler/ reads dirty
//     to any provider shelling out to `git status --porcelain`, and removing
//     that tree would take the resume state of every conversation bound to it
//     with it.
func TestSpawn_UsesWorkspaceRoot(t *testing.T) {
	projectDir := t.TempDir()   // the project — where our own state belongs
	workspaceDir := t.TempDir() // the bound workspace — where the CLI must run

	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-workspace")

	p, err := NewClient(provider.Config{
		Model:         "claude-sonnet-4-6",
		ProjectPath:   projectDir,
		WorkspaceRoot: workspaceDir,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	t.Cleanup(c.closeSession)

	convID := "conv_workspace"
	convDir := filepath.Join(projectDir, ".juggler", "ws--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	// The child reports os.Getwd(), which resolves symlinks (on macOS
	// /var → /private/var), so compare symlink-resolved forms.
	want := evalSymlinks(t, workspaceDir)
	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("expected at least one fake-CLI spawn, got none")
	}
	for i, rec := range trace {
		if evalSymlinks(t, rec.Cwd) != want {
			t.Errorf("spawn #%d ran in Cwd = %q; want the bound workspace %q (project was %q)",
				i, rec.Cwd, workspaceDir, projectDir)
		}
	}

	sidecar := filepath.Join(convDir, "claude_session.json")
	if _, err := os.Stat(sidecar); err != nil {
		t.Errorf("sidecar missing from the project at %s: %v", sidecar, err)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, ".juggler")); !os.IsNotExist(err) {
		t.Errorf("the workspace acquired a .juggler/ directory (stat err = %v); nothing of ours may be written into a workspace root", err)
	}
	if loaded := c.loadSidecar(convID); loaded == nil || loaded.sessionUUID == "" {
		t.Error("the sidecar written in the project is not readable back, so the next turn would cold-start")
	}

	c.dropSession(convID)
}

// TestSidecar_IsNotResumedInAnotherTree covers a conversation that MOVES. The
// sidecar rightly lives in the project and outlives any one workspace — but the
// session it names does not: the CLI files its transcript under the directory it
// ran in, and every entry of it records that directory. Resuming that uuid from
// another tree asks the CLI to carry on a conversation about a different set of
// files, without saying so.
//
// So a session is only resumed in the tree it was made in. Anywhere else the
// conversation cold-starts from its own history, which is the same thing that
// happens the first time a conversation runs anywhere.
func TestSidecar_IsNotResumedInAnotherTree(t *testing.T) {
	projectDir := t.TempDir()
	firstTree := t.TempDir()
	secondTree := t.TempDir()

	convID := "conv_moved"
	convDir := filepath.Join(projectDir, ".juggler", "ws--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	clientIn := func(tree string) *Client {
		t.Helper()
		p, err := NewClient(provider.Config{
			Model:         "claude-sonnet-4-6",
			ProjectPath:   projectDir,
			WorkspaceRoot: tree,
		})
		if err != nil {
			t.Fatalf("NewClient: %v", err)
		}
		return p.(*Client)
	}

	// A turn in the first tree, which leaves a resumable session behind.
	installFakeClaude(t, fakeModeUntilClose, "uuid-first-tree")
	first := clientIn(firstTree)
	t.Cleanup(first.closeSession)
	if _, err := first.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if loaded := first.loadSidecar(convID); loaded == nil || loaded.sessionUUID == "" {
		t.Fatal("the first tree's turn left no resumable session, so this case proves nothing")
	}

	// The conversation moves. A handle for the new tree is what the cache opens.
	moved := clientIn(secondTree)
	t.Cleanup(moved.closeSession)
	if loaded := moved.loadSidecar(convID); loaded != nil {
		t.Errorf("a session made in %q was offered for resume in %q (uuid %q); the CLI would continue another tree's transcript here",
			firstTree, secondTree, loaded.sessionUUID)
	}

	// And moving back finds it again: the session belongs to that tree, and
	// nothing about the move made it not.
	back := clientIn(firstTree)
	t.Cleanup(back.closeSession)
	if loaded := back.loadSidecar(convID); loaded == nil || loaded.sessionUUID == "" {
		t.Error("a conversation that came back to the tree its session was made in cold-started anyway")
	}

	back.dropSession(convID)
}

// TestNewClient_DefaultWorkspaceRootsEverythingAtTheProject pins the unbound
// case: with no workspace, the spawn directory and our state directory are
// both the project, which is what every conversation did before workspaces
// existed.
func TestNewClient_DefaultWorkspaceRootsEverythingAtTheProject(t *testing.T) {
	projectDir := t.TempDir()
	p, err := NewClient(provider.Config{Model: "claude-sonnet-4-6", ProjectPath: projectDir})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	if c.workingDir != projectDir {
		t.Errorf("workingDir = %q, want the project %q", c.workingDir, projectDir)
	}
	if c.stateDir != projectDir {
		t.Errorf("stateDir = %q, want the project %q", c.stateDir, projectDir)
	}
}

// TestThreadSession_InheritsBothDirs guards the per-thread clone: a sub-thread
// runs in the same place and keeps its parent's state directory, so a thread
// can never spawn in the project while its conversation runs in a worktree.
func TestThreadSession_InheritsBothDirs(t *testing.T) {
	projectDir := t.TempDir()
	workspaceDir := t.TempDir()
	p, err := NewClient(provider.Config{
		Model:         "claude-sonnet-4-6",
		ProjectPath:   projectDir,
		WorkspaceRoot: workspaceDir,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	s := c.newThreadSession("thread-1")
	if s.workingDir != workspaceDir {
		t.Errorf("thread workingDir = %q, want %q", s.workingDir, workspaceDir)
	}
	if s.stateDir != projectDir {
		t.Errorf("thread stateDir = %q, want %q", s.stateDir, projectDir)
	}
}

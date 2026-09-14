//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// The local kind is registered with the tools and serves every request that
// names no workspace — which, until a workspace exists, is all of them.
func TestLocalWorkspaceKind_ServesTheRegisteredTools(t *testing.T) {
	registerLocalWorkspaceKind()
	Register("read-file", func(scope PathScope) Operations { return NewFileOperations(scope) })

	kind, err := LookupWorkspaceKind(localKindName)
	if err != nil {
		t.Fatalf("LookupWorkspaceKind(%q): %v", localKindName, err)
	}
	if !kind.HostsLocalProviders {
		t.Fatalf("the local machine reports it cannot host a local provider")
	}

	backend := kind.New(WorkspaceRef{Kind: localKindName, Root: t.TempDir()})
	if _, err := backend.Operations("read-file", NewPathScope(t.TempDir(), nil)); err != nil {
		t.Fatalf("Operations(read-file): %v", err)
	}
	if _, err := backend.Operations("no-such-tool", NewPathScope(t.TempDir(), nil)); err == nil {
		t.Fatalf("a tool that is not registered was served anyway")
	}
}

// What the browser is told about the kinds, since a workspace row says only
// which kind it is. Without this the model picker has no way to know that a
// conversation working elsewhere cannot run a provider we spawn here.
func TestWorkspaceKindCapabilities_ReportsEveryKind(t *testing.T) {
	registerLocalWorkspaceKind()
	RegisterWorkspaceKind(WorkspaceKind{
		Name:                "test-elsewhere",
		HostsLocalProviders: false,
		New:                 func(ws WorkspaceRef) KindBackend { return fixtureBackend{ref: ws} },
	})
	t.Cleanup(func() { delete(workspaceKinds, "test-elsewhere") })

	capabilities := WorkspaceKindCapabilities()
	if !capabilities[localKindName].HostsLocalProviders {
		t.Fatalf("the local machine is reported as unable to host a local provider: %+v", capabilities)
	}
	elsewhere, ok := capabilities["test-elsewhere"]
	if !ok {
		t.Fatalf("a registered kind is missing from the report: %+v", capabilities)
	}
	if elsewhere.HostsLocalProviders {
		t.Fatalf("a kind that cannot host a local provider is reported as able to")
	}
}

// A kind nobody registered is an error rather than a fallback to the local
// machine: a request naming a transport this build does not have must not
// quietly run the command here instead.
func TestLookupWorkspaceKind_UnknownIsAnError(t *testing.T) {
	if _, err := LookupWorkspaceKind("remote-ssh"); err == nil {
		t.Fatalf("an unregistered kind resolved")
	}
}

// A second kind registers itself and is reachable without any edit to the
// request path — the whole point of the registry.
func TestRegisterWorkspaceKind_SecondKindIsReachable(t *testing.T) {
	RegisterWorkspaceKind(WorkspaceKind{
		Name:                "test-fixture",
		HostsLocalProviders: false,
		New:                 func(ws WorkspaceRef) KindBackend { return fixtureBackend{ref: ws} },
	})
	t.Cleanup(func() { delete(workspaceKinds, "test-fixture") })

	kind, err := LookupWorkspaceKind("test-fixture")
	if err != nil {
		t.Fatalf("LookupWorkspaceKind: %v", err)
	}
	if kind.HostsLocalProviders {
		t.Fatalf("a kind that said it cannot host local providers reports that it can")
	}
	backend := kind.New(WorkspaceRef{ID: "ws_1", Kind: "test-fixture", Root: "/elsewhere"})
	handler, err := backend.Operations("shell", NewPathScope("/elsewhere", nil))
	if err != nil {
		t.Fatalf("Operations: %v", err)
	}
	got, err := handler.Execute(context.Background(), "exec", nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got != "ws_1" {
		t.Fatalf("handler = %v, want one built for the workspace it was given", got)
	}
}

// fixtureBackend answers with the workspace it was built for, which is what
// proves the ref reached it.
type fixtureBackend struct{ ref WorkspaceRef }

func (b fixtureBackend) Operations(string, PathScope) (Operations, error) {
	return fixtureOps{id: b.ref.ID}, nil
}

type fixtureOps struct{ id string }

func (o fixtureOps) Execute(context.Context, string, map[string]any) (any, error) {
	return o.id, nil
}

// Nothing of Juggler's may be written into a workspace. A command that runs in
// one still spills into the PROJECT's .juggler/ — otherwise a fresh worktree is
// reported dirty by `git status`, and removing it takes the spill with it.
func TestSpillDir_FollowsTheProjectNotTheWorkspace(t *testing.T) {
	project := t.TempDir()
	workspace := t.TempDir()

	scope := NewPathScope(workspace, nil).WithProjectRoot(project)
	if got := scope.Root(); got != workspace {
		t.Fatalf("Root() = %q, want the workspace the command runs in", got)
	}
	if got := scope.ProjectRoot(); got != project {
		t.Fatalf("ProjectRoot() = %q, want %q", got, project)
	}

	dir := spillDirFor(scope.ProjectRoot(), "conv_1")
	if !strings.HasPrefix(dir, project) {
		t.Fatalf("spill dir = %q, want it under the project %q", dir, project)
	}
	if strings.HasPrefix(dir, workspace) {
		t.Fatalf("spill dir = %q, want nothing of ours inside the workspace", dir)
	}
	if want := filepath.Join(project, ".juggler", "bash-output", "conv_1"); dir != want {
		t.Fatalf("spill dir = %q, want %q", dir, want)
	}
}

// A scope that was never told about a project is its own project, so every
// existing caller — and every request that names no workspace — is unchanged.
func TestProjectRoot_DefaultsToTheWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	scope := NewPathScope(root, []string{"/tmp"})
	if got := scope.ProjectRoot(); got != root {
		t.Fatalf("ProjectRoot() = %q, want the working directory %q", got, root)
	}
	if got := spillDirFor(scope.ProjectRoot(), ""); got != filepath.Join(root, ".juggler", "bash-output", "_unassigned") {
		t.Fatalf("spill dir = %q, want the unassigned bucket under the working directory", got)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import "fmt"

// Workspace kinds: what an operation runs ON.
//
// The tool registry above answers "which operation is this" — read-file, shell,
// grep. This one answers "where does it run", which is a separate axis: the same
// nine tools against the machine Juggler is on, or against something else. Today
// there is one kind, and it is the machine; the registry exists so that adding
// another is a package that registers itself at startup rather than an edit to
// the request path.
//
// Resolution deliberately does not involve the extension that created a
// workspace. Everything an operation needs — the kind and the root — is on the
// server's own row, so a disabled or broken extension cannot strand the
// conversations bound to the workspaces it made.

// WorkspaceRef is what a backend is told about the workspace it is serving.
//
// It is a plain value rather than the session's own Workspace type so that this
// package stays free of the session: ops are called from tests, from handlers
// and (one day) from a process that has no session at all, and a path boundary
// should not drag a manifest along behind it.
type WorkspaceRef struct {
	ID   string         // The workspace's id, for logs and errors
	Kind string         // Which backend serves it
	Root string         // Its root, in terms this kind understands
	Meta map[string]any // The provider's own record — a host, a branch; opaque to every kind but the one that wrote it
}

// KindBackend builds the handler for one tool, in one workspace. It is one
// method rather than nine because the tool set is already a registry: a kind
// that cannot serve `websearch` says so by returning an error for it, not by
// implementing an interface full of stubs.
type KindBackend interface {
	Operations(toolID string, scope PathScope) (Operations, error)
}

// WorkspaceKind is one way for operations to reach a workspace.
//
// HostsLocalProviders records whether a workspace of this kind can host a CLI
// provider — one Juggler spawns as a subprocess, in the workspace's directory.
// That is true of the local machine and false of anything reached over a wire,
// where the CLI would run on the laptop while every file operation ran
// elsewhere: silently the wrong thing, in a way the user only discovers through
// results that make no sense. The flag is carried from the first kind onward so
// the model selector has something to ask, rather than being retrofitted the
// day a second kind exists.
type WorkspaceKind struct {
	Name                string
	HostsLocalProviders bool
	New                 func(ws WorkspaceRef) KindBackend
}

// workspaceKinds maps a kind name to its registration. Like the tool registry
// beside it, this is a package-global written at startup and read thereafter,
// so it carries no mutex.
var workspaceKinds = map[string]WorkspaceKind{}

// RegisterWorkspaceKind registers a way of reaching workspaces. Call at process
// startup, before any request is served.
func RegisterWorkspaceKind(kind WorkspaceKind) {
	workspaceKinds[kind.Name] = kind
}

// KindCapabilities is what a client needs to know about a kind whose backend it
// will never itself reach: today only whether the kind can host a provider
// Juggler spawns as a subprocess, which is what lets the model picker refuse
// that pairing rather than let a user discover it through a turn that ran on the
// wrong machine.
type KindCapabilities struct {
	HostsLocalProviders bool `json:"hostsLocalProviders"`
}

// WorkspaceKindCapabilities reports every registered kind, keyed by name.
//
// Published once, in the session bootstrap, because kinds are registered at
// startup and never change while the process runs — so a client holding this
// cannot be holding a stale copy of it.
func WorkspaceKindCapabilities() map[string]KindCapabilities {
	capabilities := make(map[string]KindCapabilities, len(workspaceKinds))
	for name, kind := range workspaceKinds {
		capabilities[name] = KindCapabilities{HostsLocalProviders: kind.HostsLocalProviders}
	}
	return capabilities
}

// LookupWorkspaceKind returns the registration for a kind name.
func LookupWorkspaceKind(name string) (WorkspaceKind, error) {
	kind, ok := workspaceKinds[name]
	if !ok {
		return WorkspaceKind{}, fmt.Errorf("no backend registered for workspace kind: %s", name)
	}
	return kind, nil
}

// localKindName is the kind every workspace has until something registers
// another: the machine this server is running on.
const localKindName = "local"

// localBackend serves operations on the machine Juggler is running on — the
// only thing that happened before workspaces existed, and still what happens
// for every request that names none.
type localBackend struct{}

// Operations builds the registered handler for a tool, bound to the request's
// path boundary. This is the whole of the old path: the indirection above it is
// what makes room for a backend that is not this one.
func (localBackend) Operations(toolID string, scope PathScope) (Operations, error) {
	factory, err := GetGlobal(toolID)
	if err != nil {
		return nil, err
	}
	return factory(scope), nil
}

// The local machine is registered from package init rather than RegisterAll,
// following the background-shell registry beside it: every request that names no
// workspace resolves through this kind, so a caller that wanted only a subset of
// the tools would otherwise be left with nowhere to run them.
func init() { registerLocalWorkspaceKind() }

// registerLocalWorkspaceKind wires the local machine in.
func registerLocalWorkspaceKind() {
	RegisterWorkspaceKind(WorkspaceKind{
		Name:                localKindName,
		HostsLocalProviders: true,
		New:                 func(WorkspaceRef) KindBackend { return localBackend{} },
	})
}

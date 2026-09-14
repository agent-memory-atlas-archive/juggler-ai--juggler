//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"
)

// OperationRequest represents a request to perform a native operation.
// AllowedPaths carries the caller's standing allowed-paths grant at the request
// top level (NOT inside Params) so the path boundary is assembled once into a
// PathScope rather than re-extracted from the params map at each op callsite.
//
// WorkspaceID rides at the top level for the same reason, and names WHERE the
// operation runs: empty is the project itself, which is what every request meant
// before workspaces existed. It is an id rather than a root because the engine
// executes tool calls an LLM composed — an id only resolves to somewhere the
// user registered through the UI, where a raw root would let a prompt-injected
// model point its own scope anywhere.
type OperationRequest struct {
	ToolID       string         `json:"toolId"`
	Operation    string         `json:"operation"`
	Params       map[string]any `json:"params"`
	AllowedPaths []string       `json:"allowedPaths,omitempty"`
	WorkspaceID  string         `json:"workspaceId,omitempty"`
}

// OperationResponse represents the response from a native operation
type OperationResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

// WorkspaceLookup answers what a request's workspaceId means. It returns false
// for an id the session has never registered — which must stay a refusal, never
// a fall back to the project.
type WorkspaceLookup func(id string) (core.Workspace, bool)

// OpsAPI handles the unified native operations API. The project path is
// looked up via a provider func so runtime project switches retarget ops.
type OpsAPI struct {
	pathProvider func() string
	workspaces   WorkspaceLookup
	// Operation handlers are stateless and recreated per request.
}

// NewOpsAPI creates a new operations API handler. pathProvider must return
// the current project path on each call; workspaces resolves a request's
// workspace id against the session's table, and may be nil in setups that have
// no session (every request then runs in the project, as it always did).
func NewOpsAPI(pathProvider func() string, workspaces WorkspaceLookup) *OpsAPI {
	return &OpsAPI{pathProvider: pathProvider, workspaces: workspaces}
}

// HandleOperationCall is the unified entry point for all native operations
func (api *OpsAPI) HandleOperationCall(w http.ResponseWriter, r *http.Request) {
	var req OperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, r, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// Get current project path
	projectPath := api.pathProvider()
	if projectPath == "" {
		api.sendError(w, r, "no project loaded", http.StatusConflict)
		return
	}

	// Route to appropriate operation handler. r.Context() is cancelled when the
	// client aborts the request (browser aborts the op fetch on Escape), so
	// long-running ops can stop early instead of running to completion.
	result, err := api.routeOperation(r.Context(), req, projectPath)
	if err != nil {
		// Return operation errors as success=false in the response body with HTTP 200
		// This allows the frontend to handle the error gracefully
		// HTTP 500 should only be for actual server failures (panics, crashes)
		api.sendOperationError(w, r, err.Error())
		return
	}

	api.sendSuccess(w, r, result)
}

// routeOperation routes the operation to the handler for its tool, in the
// workspace it named. Handlers are stateless and built per request, from the
// two registries: which operation this is (tool id) and where it runs (kind).
func (api *OpsAPI) routeOperation(ctx context.Context, req OperationRequest, projectPath string) (any, error) {
	backend, scope, err := api.resolveWorkspace(req, projectPath)
	if err != nil {
		return nil, err
	}

	handler, err := backend.Operations(req.ToolID, scope)
	if err != nil {
		return nil, fmt.Errorf("no operation handler registered for tool: %s", req.ToolID)
	}

	result, err := handler.Execute(ctx, req.Operation, req.Params)
	if err != nil {
		// Log the error for debugging
		jlog.Error("[OpsAPI] Error executing %s/%s: %v", req.ToolID, req.Operation, err)
	}

	return result, err
}

// resolveWorkspace turns a request's workspace id into the backend that will
// serve it and the path boundary it is confined to.
//
// The five answers, and why each is what it is:
//
//   - No id at all is the project, exactly as before workspaces existed. This
//     is every request today, and it must stay byte-identical.
//   - A ready workspace roots the scope at the workspace, and widens the READ
//     boundary with the project. A conversation working in a worktree still
//     needs to read the tree it branched from — to diff against it, to read a
//     doc that only exists on the main branch — and refusing that would make
//     the feature's first hour miserable. Writes are unaffected: they are gated
//     by approval, not by the scope (see PathScope.Sanitize).
//   - One still being provisioned refuses, saying so. The UI parks a send until
//     its workspace is ready, so this is the inherited binding and the second
//     window, not the common path.
//   - A closed one refuses too, and differently: the id still resolves, so the
//     conversation can be told the workspace was finished with rather than that
//     it never existed.
//   - An id the session does not know is an error and never a fall back to the
//     project. A stale binding that silently ran in the project root would edit
//     the wrong tree, and look exactly like working.
func (api *OpsAPI) resolveWorkspace(req OperationRequest, projectPath string) (ops.KindBackend, ops.PathScope, error) {
	ref := ops.WorkspaceRef{Kind: core.WorkspaceKindLocal, Root: projectPath}
	scope := ops.NewPathScope(projectPath, req.AllowedPaths)

	if req.WorkspaceID != core.DefaultWorkspaceID {
		ws, err := api.lookupWorkspace(req.WorkspaceID)
		if err != nil {
			return nil, ops.PathScope{}, err
		}
		ref = ops.WorkspaceRef{ID: ws.ID, Kind: ws.Kind, Root: ws.Root, Meta: ws.Meta}
		// The project joins the allowed roots so reads can reach it; the scope
		// is still ROOTED at the workspace, which is what confines a shell's
		// cwd (see ops.validateCwd, which consults the root alone).
		scope = ops.NewPathScope(ws.Root, append(append([]string{}, req.AllowedPaths...), projectPath)).
			WithProjectRoot(projectPath)
	}

	kind, err := ops.LookupWorkspaceKind(ref.Kind)
	if err != nil {
		return nil, ops.PathScope{}, err
	}
	return kind.New(ref), scope, nil
}

// lookupWorkspace resolves a registered workspace and reports why it cannot be
// used, if it cannot.
func (api *OpsAPI) lookupWorkspace(id string) (core.Workspace, error) {
	if api.workspaces == nil {
		return core.Workspace{}, fmt.Errorf("unknown workspace: %s", id)
	}
	ws, ok := api.workspaces(id)
	if !ok {
		return core.Workspace{}, fmt.Errorf("unknown workspace: %s", id)
	}
	switch ws.State {
	case core.WorkspaceStateReady:
	case core.WorkspaceStateProvisioning:
		return core.Workspace{}, fmt.Errorf("workspace %s is still being created", workspaceName(ws))
	case core.WorkspaceStateClosed:
		return core.Workspace{}, fmt.Errorf("workspace %s was closed", workspaceName(ws))
	default:
		return core.Workspace{}, fmt.Errorf("workspace %s is in an unknown state: %s", workspaceName(ws), ws.State)
	}
	// One stat, so a workspace whose tree was removed behind our back fails
	// once and legibly, rather than as a run of cryptic errors from whichever
	// operation happened to touch it first.
	if info, err := os.Stat(ws.Root); err != nil || !info.IsDir() {
		return core.Workspace{}, fmt.Errorf("workspace %s is missing its root: %s", workspaceName(ws), ws.Root)
	}
	return ws, nil
}

// workspaceName is what to call a workspace in an error: its label when it has
// one, since that is what the user named it, and its id otherwise.
func workspaceName(ws core.Workspace) string {
	if ws.Label != "" {
		return ws.Label
	}
	return ws.ID
}

// sendSuccess sends a success response
func (api *OpsAPI) sendSuccess(w http.ResponseWriter, r *http.Request, data any) {
	WriteJSON(w, r, 0, OperationResponse{
		Success: true,
		Data:    data,
	})
}

// sendError sends an error response
func (api *OpsAPI) sendError(w http.ResponseWriter, r *http.Request, message string, statusCode int) {
	WriteJSON(w, r, statusCode, OperationResponse{
		Success: false,
		Error:   message,
	})
}

// sendOperationError sends an operation error response (HTTP 200 with success=false)
// Operation errors like "search string not found" are not server errors
func (api *OpsAPI) sendOperationError(w http.ResponseWriter, r *http.Request, message string) {
	WriteJSON(w, r, http.StatusOK, OperationResponse{
		Success: false,
		Error:   message,
	})
}

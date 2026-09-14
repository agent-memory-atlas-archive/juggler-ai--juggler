//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"os"

	"juggler/cmd/juggler/providers/provider"
)

// Client implements provider.Provider for the ACP backend. It is the config
// template — the selected agent name (its model id) plus the working directory
// used to locate the per-project acp.json — while the per-conversation state
// (the live subprocess and session id) lives on each conversation handle
// returned by OpenConversation. The concrete agent command is resolved lazily
// from config when a turn first runs, so listing and initialization never
// depend on a particular agent being present.
type Client struct {
	model       string // the selected agent's name (== its model id), "" when only listing
	workingDir  string // where the agent spawns: the bound workspace, or the project
	projectRoot string // the project: where acp.json is read from, wherever the agent runs
	approver    Approver
}

// NewClient is the provider initializer registered with the registry. It does
// no agent resolution — that is deferred to the first turn — so a stale or
// placeholder model (as passed when merely listing models) never fails init.
func NewClient(cfg provider.Config) (provider.Provider, error) {
	// The agent spawns where the conversation's work is, but its configuration
	// comes from the project: acp.json lives in <project>/.juggler/, which a
	// workspace (a worktree, a scratch copy) has no copy of. The two are the
	// same directory for a conversation bound to the project itself.
	root := projectDir(cfg.ProjectPath)
	workingDir := root
	if cfg.WorkspaceRoot != "" {
		workingDir = cfg.WorkspaceRoot
	}
	return &Client{
		model:       cfg.Model,
		workingDir:  workingDir,
		projectRoot: root,
		approver:    defaultApprover{},
	}, nil
}

// projectDir is the root used to locate the per-project acp.json. The
// authoritative source is the project the server has open (cfgProjectPath, from
// Server.ProjectPath()); it falls back to the legacy env seam and then the
// process cwd only when no project is carried (e.g. model-listing calls that
// pass a bare Config).
func projectDir(cfgProjectPath string) string {
	if cfgProjectPath != "" {
		return cfgProjectPath
	}
	if wd := os.Getenv("JUGGLER_PROJECT_PATH"); wd != "" {
		return wd
	}
	if wd, err := os.Getwd(); err == nil {
		return wd
	}
	return ""
}

// Name returns the provider's registry name.
func (c *Client) Name() string { return providerName }

// ListModelsWithInfo returns one model per enabled agent in the merged
// acp.json (global + per-project), each identified by its configured name. ACP
// agents advertise "modes" rather than an OpenAI-style model list; enumerating
// a live agent's modes would require spawning it, which listing must not do, so
// one model per configured agent is the surface. Context window is unknown
// (0 → the UI shows nothing rather than a guess).
func (c *Client) ListModelsWithInfo(_ context.Context) ([]provider.ModelInfo, error) {
	names := enabledAgentNames(c.projectRoot)
	models := make([]provider.ModelInfo, 0, len(names))
	for _, name := range names {
		models = append(models, provider.ModelInfo{
			ID:          name,
			DisplayName: name,
			FromAPI:     false,
		})
	}
	return models, nil
}

// OpenConversation returns a fresh ACP conversation handle bound to this
// client. The agent is resolved from config and spawned lazily on the first
// Submit, so an unknown/misconfigured agent surfaces as a clear turn error
// rather than failing to open.
func (c *Client) OpenConversation(_ context.Context, convID string) (provider.Conversation, error) {
	return newConversation(c, convID, c.approver), nil
}

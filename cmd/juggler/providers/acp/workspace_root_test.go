//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestNewClient_WorkspaceRootSplitsSpawnFromConfig covers a conversation bound
// to a workspace. The agent runs in the workspace — that is the tree the work
// is about — but its configuration is still the project's: acp.json lives in
// <project>/.juggler/, which a worktree does not have a copy of. Reading the
// config from the workspace would leave the provider advertising no agents at
// all, and every turn failing with "no agent named …".
func TestNewClient_WorkspaceRootSplitsSpawnFromConfig(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir()) // an empty global config
	projectDir := t.TempDir()
	workspaceDir := t.TempDir()

	configPath := filepath.Join(projectDir, ".juggler", acpFileName)
	if err := writeConfigFile(configPath, map[string]AgentConfig{
		"gem": {Command: "sh"},
	}); err != nil {
		t.Fatalf("write project acp.json: %v", err)
	}

	p, err := NewClient(provider.Config{
		Model:         "gem",
		ProjectPath:   projectDir,
		WorkspaceRoot: workspaceDir,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)

	if c.workingDir != workspaceDir {
		t.Errorf("workingDir = %q, want the bound workspace %q", c.workingDir, workspaceDir)
	}
	if c.projectRoot != projectDir {
		t.Errorf("projectRoot = %q, want the project %q", c.projectRoot, projectDir)
	}

	models, err := c.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if len(models) != 1 || models[0].ID != "gem" {
		t.Fatalf("models = %+v, want the project's single configured agent", models)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, ".juggler")); !os.IsNotExist(err) {
		t.Errorf("the workspace acquired a .juggler/ directory (stat err = %v)", err)
	}
}

// TestNewClient_DefaultWorkspaceRootsEverythingAtTheProject pins the unbound
// case: with no workspace, the agent spawns in the project, as it always did.
func TestNewClient_DefaultWorkspaceRootsEverythingAtTheProject(t *testing.T) {
	projectDir := t.TempDir()
	p, err := NewClient(provider.Config{Model: "gem", ProjectPath: projectDir})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	if c.workingDir != projectDir {
		t.Errorf("workingDir = %q, want the project %q", c.workingDir, projectDir)
	}
	if c.projectRoot != projectDir {
		t.Errorf("projectRoot = %q, want the project %q", c.projectRoot, projectDir)
	}
}

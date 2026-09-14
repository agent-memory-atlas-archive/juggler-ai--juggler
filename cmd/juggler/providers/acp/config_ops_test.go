//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// isolatedConfig points the global acp.json at an empty temp dir (so a
// developer's real ~/.juggler/acp.json never leaks into a test) and returns a
// fresh temp project root. Both are cleaned up by t.
func isolatedConfig(t *testing.T) (projectRoot string) {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	return t.TempDir()
}

// writeProjectConfig writes a .juggler/acp.json under project with the given agents.
func writeProjectConfig(t *testing.T, project string, agents map[string]AgentConfig) {
	t.Helper()
	if err := writeConfigFile(projectConfigPath(project), agents); err != nil {
		t.Fatalf("write project config: %v", err)
	}
}

// enabled/disabled bool pointers for AgentConfig.Enabled.
func boolp(b bool) *bool { return &b }

func TestConfigRoundTrip(t *testing.T) {
	isolatedConfig(t)
	path := filepath.Join(t.TempDir(), "acp.json")
	in := map[string]AgentConfig{
		"gemini": {Command: "gemini", Args: []string{"--experimental-acp"}, Env: map[string]string{"K": "v"}},
	}
	if err := writeConfigFile(path, in); err != nil {
		t.Fatalf("write: %v", err)
	}
	cfg, err := readConfigFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	got := cfg.Agents["gemini"]
	if got.Command != "gemini" || len(got.Args) != 1 || got.Args[0] != "--experimental-acp" || got.Env["K"] != "v" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	// Confirm it serialized under the "acpAgents" key.
	raw, _ := os.ReadFile(path)
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(raw, &doc)
	if _, ok := doc["acpAgents"]; !ok {
		t.Fatalf("expected top-level acpAgents key, got %s", raw)
	}
}

func TestReadMissingConfigIsEmpty(t *testing.T) {
	cfg, err := readConfigFile(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if len(cfg.Agents) != 0 {
		t.Fatalf("expected empty, got %+v", cfg.Agents)
	}
}

func TestLoadMergedConfigProjectWins(t *testing.T) {
	project := isolatedConfig(t)
	// Global: a + b.
	if err := writeConfigFile(globalConfigPath(), map[string]AgentConfig{
		"a": {Command: "global-a"},
		"b": {Command: "global-b"},
	}); err != nil {
		t.Fatalf("write global: %v", err)
	}
	// Project overrides b, adds c.
	writeProjectConfig(t, project, map[string]AgentConfig{
		"b": {Command: "project-b"},
		"c": {Command: "project-c"},
	})

	merged, err := loadMergedConfig(project)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if merged["a"].Command != "global-a" {
		t.Fatalf("a = %q, want global-a", merged["a"].Command)
	}
	if merged["b"].Command != "project-b" {
		t.Fatalf("b = %q, want project-b (project wins)", merged["b"].Command)
	}
	if merged["c"].Command != "project-c" {
		t.Fatalf("c = %q, want project-c", merged["c"].Command)
	}
}

func TestResolveAgent(t *testing.T) {
	project := isolatedConfig(t)
	self := os.Args[0] // the test binary: guaranteed present + executable on PATH-with-slash
	writeProjectConfig(t, project, map[string]AgentConfig{
		"ok":       {Command: self, Args: []string{"-x"}, Env: map[string]string{"E": "1"}},
		"off":      {Command: self, Enabled: boolp(false)},
		"nocmd":    {Command: "   "},
		"notfound": {Command: "definitely-not-a-real-binary-xyz"},
	})

	ra, err := resolveAgent(project, "ok")
	if err != nil {
		t.Fatalf("resolve ok: %v", err)
	}
	if ra.path == "" || len(ra.args) != 1 || ra.args[0] != "-x" || ra.env["E"] != "1" {
		t.Fatalf("resolved = %+v", ra)
	}

	for _, name := range []string{"off", "nocmd", "notfound", "missing"} {
		if _, err := resolveAgent(project, name); err == nil {
			t.Fatalf("resolveAgent(%q) should error", name)
		}
	}
}

func TestEnabledAgentNamesSortedAndFiltered(t *testing.T) {
	project := isolatedConfig(t)
	writeProjectConfig(t, project, map[string]AgentConfig{
		"zeta":  {Command: "z"},
		"alpha": {Command: "a"},
		"off":   {Command: "o", Enabled: boolp(false)},
		"blank": {Command: ""},
	})
	names := enabledAgentNames(project)
	if len(names) != 2 || names[0] != "alpha" || names[1] != "zeta" {
		t.Fatalf("names = %v, want [alpha zeta]", names)
	}
	if !anyAgentConfiguredIn(project) {
		t.Fatalf("anyAgentConfiguredIn should be true")
	}
}

// anyAgentConfiguredIn mirrors anyAgentConfigured but takes an explicit project,
// so the test doesn't depend on JUGGLER_PROJECT_PATH.
func anyAgentConfiguredIn(project string) bool {
	return len(enabledAgentNames(project)) > 0
}

func TestListModelsWithInfoFromConfig(t *testing.T) {
	project := isolatedConfig(t)
	writeProjectConfig(t, project, map[string]AgentConfig{
		"gemini": {Command: "gemini"},
		"zed":    {Command: "zed"},
		"off":    {Command: "x", Enabled: boolp(false)},
	})
	c := &Client{workingDir: project, projectRoot: project}
	models, err := c.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("got %d models, want 2: %+v", len(models), models)
	}
	// Sorted: gemini, zed. IDs == names, DisplayName == name.
	if models[0].ID != "gemini" || models[0].DisplayName != "gemini" {
		t.Fatalf("model[0] = %+v", models[0])
	}
	if models[1].ID != "zed" {
		t.Fatalf("model[1] = %+v", models[1])
	}
}

func TestOpsSetThenGetConfig(t *testing.T) {
	project := isolatedConfig(t)
	o := &operations{}

	_, err := o.setConfig(project, map[string]any{
		"scope": "project",
		"agents": map[string]any{
			"gemini": map[string]any{"command": "gemini", "args": []any{"--experimental-acp"}},
		},
	})
	if err != nil {
		t.Fatalf("setConfig: %v", err)
	}

	got, err := o.getConfig(project)
	if err != nil {
		t.Fatalf("getConfig: %v", err)
	}
	m := got.(map[string]any)
	proj := m["project"].(map[string]AgentConfig)
	if proj["gemini"].Command != "gemini" {
		t.Fatalf("project config missing gemini: %+v", proj)
	}
	if m["hasProject"] != true {
		t.Fatalf("hasProject should be true")
	}
}

func TestOpsSetConfigProjectRequiresProject(t *testing.T) {
	isolatedConfig(t)
	o := &operations{}
	if _, err := o.setConfig("", map[string]any{"scope": "project", "agents": map[string]any{}}); err == nil {
		t.Fatalf("project scope with no project should error")
	}
}

func TestListAgentStatuses(t *testing.T) {
	project := isolatedConfig(t)
	self := os.Args[0]
	writeProjectConfig(t, project, map[string]AgentConfig{
		"good": {Command: self},
		"bad":  {Command: "definitely-not-a-real-binary-xyz"},
		"off":  {Command: self, Enabled: boolp(false)},
	})
	statuses := listAgentStatuses(project)
	byName := map[string]AgentStatus{}
	for _, s := range statuses {
		byName[s.Name] = s
	}
	if byName["good"].Status != "available" {
		t.Fatalf("good = %+v, want available", byName["good"])
	}
	if byName["bad"].Status != "unavailable" || byName["bad"].Error == "" {
		t.Fatalf("bad = %+v, want unavailable with error", byName["bad"])
	}
	if byName["off"].Status != "disabled" {
		t.Fatalf("off = %+v, want disabled", byName["off"])
	}
	// Sorted by name.
	if statuses[0].Name != "bad" || statuses[1].Name != "good" || statuses[2].Name != "off" {
		t.Fatalf("not sorted: %v", []string{statuses[0].Name, statuses[1].Name, statuses[2].Name})
	}
}

func TestDecodeAgentsRejectsNonObject(t *testing.T) {
	if _, err := decodeAgents([]any{"nope"}); err == nil {
		t.Fatalf("decodeAgents should reject a non-object")
	}
	m, err := decodeAgents(nil)
	if err != nil || len(m) != 0 {
		t.Fatalf("decodeAgents(nil) = %v, %v", m, err)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package extmanifest

import (
	"encoding/json"
	"os"
	"testing"
	"testing/fstest"
)

func TestParseRejectsUnknownFields(t *testing.T) {
	// DisallowUnknownFields: a typo'd key is surfaced, not silently dropped.
	_, err := Parse([]byte(`{"id":"@x/y","name":"Y","version":"1.0.0","permision":["x"],` +
		`"provides":{"commands":["c/*.js"]}}`))
	if err == nil {
		t.Fatal("expected unknown-field error, got nil")
	}
}

func TestParseInvalidJSON(t *testing.T) {
	if _, err := Parse([]byte("{ not json")); err == nil {
		t.Fatal("expected parse error, got nil")
	}
}

func TestValidate(t *testing.T) {
	good := Manifest{
		ID: "@x/y", Name: "Y", Version: "1.0.0", EngineAPI: "^1.0.0",
		Provides: Provides{Commands: []string{"commands/*.js"}},
	}
	cases := []struct {
		name    string
		mutate  func(m Manifest) Manifest
		wantErr bool
	}{
		{"valid", func(m Manifest) Manifest { return m }, false},
		{"missing id", func(m Manifest) Manifest { m.ID = ""; return m }, true},
		{"missing name", func(m Manifest) Manifest { m.Name = ""; return m }, true},
		{"missing version", func(m Manifest) Manifest { m.Version = ""; return m }, true},
		{"no capabilities", func(m Manifest) Manifest { m.Provides = Provides{}; return m }, true},
		{"infoCards only is a capability", func(m Manifest) Manifest {
			m.Provides = Provides{InfoCards: []string{"cards/*-card.js"}}
			return m
		}, false},
		{"systemPrompt only is a capability", func(m Manifest) Manifest {
			m.Provides = Provides{SystemPrompt: "system-prompt-contribution.js"}
			return m
		}, false},
		{"blank systemPrompt is not a capability", func(m Manifest) Manifest {
			m.Provides = Provides{SystemPrompt: "   "}
			return m
		}, true},
		{"blank engineApi ok", func(m Manifest) Manifest { m.EngineAPI = ""; return m }, false},
		{"incompatible engineApi", func(m Manifest) Manifest { m.EngineAPI = "^2.0.0"; return m }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Validate(c.mutate(good), "1.0.0")
			if (err != nil) != c.wantErr {
				t.Errorf("Validate err = %v, wantErr = %v", err, c.wantErr)
			}
		})
	}
}

func TestValidateSettings(t *testing.T) {
	defaults := func(v string) json.RawMessage { return json.RawMessage(v) }
	good := []Setting{
		{Key: "name", Type: "string", Label: "Name", Default: defaults(`"Ada"`)},
		{Key: "token", Type: "secret", Label: "Token"},
		{Key: "enabled", Type: "boolean", Label: "Enabled", Default: defaults(`true`)},
		{Key: "limit", Type: "number", Label: "Limit", Default: defaults(`5`)},
		{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"fast", "deep"}, Default: defaults(`"fast"`)},
		{Key: "base_url", Type: "url", Label: "Base URL", Default: defaults(`"https://example.com/api"`), Scope: "global"},
		{Key: "policy", Type: "text", Label: "Policy", Default: defaults(`"line one\nline two"`), Capability: "strategy:auto-approve"},
	}
	if err := ValidateSettings(good); err != nil {
		t.Fatalf("ValidateSettings(valid): %v", err)
	}

	cases := []struct {
		name    string
		setting Setting
	}{
		{"invalid key", Setting{Key: "../key", Type: "string", Label: "Key"}},
		{"duplicate enum option", Setting{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"x", "x"}}},
		{"missing enum options", Setting{Key: "mode", Type: "enum", Label: "Mode"}},
		{"options on string", Setting{Key: "name", Type: "string", Label: "Name", Options: []string{"x"}}},
		{"unknown type", Setting{Key: "name", Type: "object", Label: "Name"}},
		{"missing label", Setting{Key: "name", Type: "string"}},
		{"project scope", Setting{Key: "name", Type: "string", Label: "Name", Scope: "project"}},
		{"secret default", Setting{Key: "token", Type: "secret", Label: "Token", Default: defaults(`"secret"`)}},
		{"wrong default type", Setting{Key: "enabled", Type: "boolean", Label: "Enabled", Default: defaults(`"yes"`)}},
		{"invalid URL default", Setting{Key: "host", Type: "url", Label: "Host", Default: defaults(`"relative"`)}},
		{"invalid enum default", Setting{Key: "mode", Type: "enum", Label: "Mode", Options: []string{"x"}, Default: defaults(`"y"`)}},
		{"options on text", Setting{Key: "policy", Type: "text", Label: "Policy", Options: []string{"x"}}},
		{"wrong text default type", Setting{Key: "policy", Type: "text", Label: "Policy", Default: defaults(`3`)}},
		{"capability without type", Setting{Key: "name", Type: "string", Label: "Name", Capability: "auto-approve"}},
		{"capability without id", Setting{Key: "name", Type: "string", Label: "Name", Capability: "strategy:"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateSettings([]Setting{tc.setting}); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
	if err := ValidateSettings([]Setting{good[0], good[0]}); err == nil {
		t.Fatal("expected duplicate key error")
	}
}

func TestParseSettingsDefaultsScopeToGlobal(t *testing.T) {
	manifest, err := Parse([]byte(`{
		"id":"@x/y","name":"Y","version":"1.0.0","engineApi":"^1.0.0",
		"settings":[{"key":"enabled","type":"boolean","label":"Enabled","default":true}],
		"provides":{"commands":["commands/*.js"]}
	}`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if err := Validate(manifest, "1.0.0"); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := manifest.Settings[0].EffectiveScope(); got != "global" {
		t.Fatalf("EffectiveScope = %q, want global", got)
	}
}

func TestWarnings(t *testing.T) {
	// A blank engineApi disables the compat check silently — warn, don't error.
	if w := Warnings(Manifest{ID: "x", Name: "X", Version: "1.0.0"}); len(w) != 1 {
		t.Errorf("blank engineApi: got %d warnings %v, want 1", len(w), w)
	}
	// A declared range is fine — no warnings.
	if w := Warnings(Manifest{ID: "x", Name: "X", Version: "1.0.0", EngineAPI: "^1.0.0"}); len(w) != 0 {
		t.Errorf("declared engineApi: got %d warnings %v, want 0", len(w), w)
	}
}

func TestSatisfiesEngineAPI(t *testing.T) {
	cases := []struct {
		rng, version string
		want         bool
	}{
		{"*", "1.0.0", true},
		{"", "9.9.9", true},
		{"1.0.0", "1.0.0", true},
		{"1.0.0", "1.0.1", false},
		{"^1.0.0", "1.0.0", true},
		{"^1.0.0", "1.4.2", true},
		{"^1.2.0", "1.1.0", false},
		{"^1.2.0", "1.2.0", true},
		{"^1.0.0", "2.0.0", false},
		{"^2.0.0", "1.0.0", false},
		{"garbage", "1.0.0", false},
	}
	for _, c := range cases {
		if got := SatisfiesEngineAPI(c.rng, c.version); got != c.want {
			t.Errorf("SatisfiesEngineAPI(%q, %q) = %v, want %v", c.rng, c.version, got, c.want)
		}
	}
}

// TestSatisfiesEngineAPISharedVectors runs the SAME fixture the JS
// satisfiesEngineApi test consumes (web/js-tests/fixtures/engineapi-vectors.json),
// so the Go and JS implementations can't drift apart without a test failing.
func TestSatisfiesEngineAPISharedVectors(t *testing.T) {
	const fixture = "../../../web/js-tests/fixtures/engineapi-vectors.json"
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read shared vector fixture %s: %v", fixture, err)
	}
	var vectors []struct {
		Range   string `json:"range"`
		Version string `json:"version"`
		Want    bool   `json:"want"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(vectors) == 0 {
		t.Fatal("shared vector fixture is empty")
	}
	for _, v := range vectors {
		if got := SatisfiesEngineAPI(v.Range, v.Version); got != v.Want {
			t.Errorf("SatisfiesEngineAPI(%q, %q) = %v, want %v", v.Range, v.Version, got, v.Want)
		}
	}
}

func TestReadEngineAPIVersion(t *testing.T) {
	// Reads ENGINE_API_VERSION from sdk/version.js when present.
	fsys := fstest.MapFS{
		"sdk/version.js": {Data: []byte("export const ENGINE_API_VERSION = '1.4.0';")},
	}
	if v := ReadEngineAPIVersion(fsys); v != "1.4.0" {
		t.Errorf("ReadEngineAPIVersion = %q, want 1.4.0", v)
	}
	// No sdk/version.js → falls back to the compiled-in default.
	if v := ReadEngineAPIVersion(fstest.MapFS{}); v != DefaultEngineAPIVersion {
		t.Errorf("fallback = %q, want %q", v, DefaultEngineAPIVersion)
	}
}

func TestExpandGlobs(t *testing.T) {
	fsys := fstest.MapFS{
		"context-items/read-context-item.js":  {Data: []byte("//")},
		"context-items/write-context-item.js": {Data: []byte("//")},
		"context-items/edit-base.js":          {Data: []byte("// not matched")},
		"README.md":                           {Data: []byte("ignore")},
	}
	got, err := ExpandGlobs(fsys, []string{"context-items/*-context-item.js"})
	if err != nil {
		t.Fatalf("ExpandGlobs: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("got %d matches %v, want 2", len(got), got)
	}
}

func TestExpandGlobsDeduplicates(t *testing.T) {
	fsys := fstest.MapFS{"a/x-context-item.js": {Data: []byte("//")}}
	// Two overlapping globs must not yield the same file twice.
	got, err := ExpandGlobs(fsys, []string{"a/*.js", "a/x-context-item.js"})
	if err != nil {
		t.Fatalf("ExpandGlobs: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("got %v, want one de-duplicated match", got)
	}
}

func TestExpandGlobsTraversalGuard(t *testing.T) {
	fsys := fstest.MapFS{"x-context-item.js": {Data: []byte("//")}}
	for _, g := range []string{"../../../etc/passwd", "../secrets/*.js", "/etc/*.js", "", "..", "a/../../b"} {
		if _, err := ExpandGlobs(fsys, []string{g}); err == nil {
			t.Errorf("expected traversal rejection for %q", g)
		}
	}
}

func TestExpandGlobsAllowsDotDotInFilename(t *testing.T) {
	// A filename that merely CONTAINS ".." is not a traversal — it must resolve.
	fsys := fstest.MapFS{
		"context-items/foo..bar-context-item.js": {Data: []byte("//")},
		"weird..name/x-context-item.js":          {Data: []byte("//")},
	}
	got, err := ExpandGlobs(fsys, []string{"context-items/*-context-item.js", "weird..name/x-context-item.js"})
	if err != nil {
		t.Fatalf("ExpandGlobs rejected a legit '..'-in-name path: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("got %v, want both '..'-in-name files", got)
	}
}

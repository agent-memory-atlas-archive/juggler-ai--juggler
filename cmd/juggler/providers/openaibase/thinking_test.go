//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"slices"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestOpenAIThinkingSpec pins the per-family reasoning-effort classification.
// Each level name IS the native reasoning_effort string sent on the wire — a
// wrong value is a hard 400, so this is the single source of truth the tests
// guard.
func TestOpenAIThinkingSpec(t *testing.T) {
	cases := []struct {
		model       string
		wantLevels  []string
		wantDefault string
		noControl   bool
	}{
		{
			model:       "gpt-5.1", // 5.1+ uses an explicit "none" for fully-off
			wantLevels:  []string{"none", "low", "medium", "high"},
			wantDefault: "medium",
		},
		{
			model:      "gpt-5", // pre-5.1: "minimal" is the lowest tier, not "none"
			wantLevels: []string{"minimal", "low", "medium", "high"},
		},
		{
			model:      "gpt-5.2-codex", // codex-max style: adds native "xhigh", no off
			wantLevels: []string{"low", "medium", "high", "xhigh"},
		},
		{
			model:      "o3-mini",
			wantLevels: []string{"low", "medium", "high"},
		},
		{
			// GPT-6 Astra: its own set. Lowest tier is "low" — it accepts no
			// "none" at all — and it reaches beyond "high" to xhigh and max.
			model:       "gpt-6-astra",
			wantLevels:  []string{"low", "medium", "high", "xhigh", "max"},
			wantDefault: "low",
		},
		{
			// GPT-6 Sol and Luna: Astra's two tiers above "high", plus the
			// explicit "none" Astra does not take.
			model:       "gpt-6-sol",
			wantLevels:  []string{"none", "low", "medium", "high", "xhigh", "max"},
			wantDefault: "medium",
		},
		{
			model:       "gpt-6-luna",
			wantLevels:  []string{"none", "low", "medium", "high", "xhigh", "max"},
			wantDefault: "medium",
		},
		{model: "gpt-4o", noControl: true},
		{model: "gpt-3.5-turbo", noControl: true},
		{model: "o1-mini", noControl: true}, // no reasoning_effort
		// The generations between the "minimal" era and 5.6 are deliberately
		// unclassified: they run at their own default effort. Offering a level
		// here means sending one, and every level these models accept other
		// than "none" is a combination Chat Completions refuses to tool-call
		// with. No control, no parameter, no refusal.
		{model: "gpt-5.4", noControl: true},
		{model: "gpt-5.4-mini", noControl: true},
		{model: "gpt-5.5", noControl: true},
	}
	for _, tc := range cases {
		spec := OpenAIThinkingSpec(tc.model)
		if tc.noControl {
			if len(spec.Levels) != 0 {
				t.Errorf("%s: expected no thinking control, got %+v", tc.model, spec)
			}
			continue
		}
		if !slices.Equal(spec.Levels, tc.wantLevels) {
			t.Errorf("%s: levels = %v, want %v", tc.model, spec.Levels, tc.wantLevels)
		}
		if tc.wantDefault != "" && spec.Default != tc.wantDefault {
			t.Errorf("%s: default = %q, want %q", tc.model, spec.Default, tc.wantDefault)
		}
	}
}

// TestThinkingSpecOptions pins that Options() returns the advertised native
// levels verbatim, in display order, and nothing for a no-control model.
func TestThinkingSpecOptions(t *testing.T) {
	if got := OpenAIThinkingSpec("gpt-5.2-codex").Options(); !slices.Equal(got, []string{"low", "medium", "high", "xhigh"}) {
		t.Errorf("codex-max options = %v, want [low medium high xhigh]", got)
	}
	if got := OpenAIThinkingSpec("gpt-5.1").Options(); !slices.Equal(got, []string{"none", "low", "medium", "high"}) {
		t.Errorf("gpt-5.1 options = %v, want [none low medium high]", got)
	}
	if opts := OpenAIThinkingSpec("gpt-4o").Options(); len(opts) != 0 {
		t.Errorf("gpt-4o: options = %+v, want none", opts)
	}
	// An unclassified model must send no reasoning_effort whatever the turn
	// asks for: effortFor is the gate, and its answer for a level nobody
	// advertised is "omit the parameter".
	for _, level := range []string{"minimal", "none", "low", "medium", "high", "xhigh", ""} {
		if effort, ok := OpenAIThinkingSpec("gpt-5.5").effortFor(level); ok {
			t.Errorf("gpt-5.5 sent reasoning_effort %q for level %q, want the parameter omitted", effort, level)
		}
	}
}

// TestEffortForOmitsWhenUnsupported pins the omit contract: an advertised level
// maps to itself on the wire, while an absent/unknown level (or any level on a
// no-control spec) returns ok=false so no reasoning param is sent.
func TestEffortForOmitsWhenUnsupported(t *testing.T) {
	spec := OpenAIThinkingSpec("gpt-5.1")
	if got, ok := spec.effortFor("high"); !ok || got != "high" {
		t.Errorf("advertised level must map to itself, got %q,%v", got, ok)
	}
	if _, ok := spec.effortFor(""); ok {
		t.Error("absent level must omit the reasoning param")
	}
	if _, ok := spec.effortFor("garbage"); ok {
		t.Error("unknown level must omit the reasoning param")
	}
	if _, ok := (ThinkingSpec{}).effortFor("high"); ok {
		t.Error("no-control spec must omit the reasoning param for any level")
	}
	// gpt-5.1 has no "xhigh" tier → omit rather than 400.
	if _, ok := spec.effortFor("xhigh"); ok {
		t.Error("must omit for a level this model doesn't advertise")
	}
}

// TestEffortSpec pins the constructor: levels are preserved in order, the
// default is carried through, and each advertised level maps to itself on the
// wire (the level name IS the native effort string).
func TestEffortSpec(t *testing.T) {
	spec := EffortSpec("medium", "low", "medium", "high")
	if spec.Default != "medium" {
		t.Errorf("Default = %q, want medium", spec.Default)
	}
	if !slices.Equal(spec.Levels, []string{"low", "medium", "high"}) {
		t.Errorf("Levels = %v, want [low medium high]", spec.Levels)
	}
	for _, lvl := range spec.Levels {
		if got, ok := spec.effortFor(lvl); !ok || got != lvl {
			t.Errorf("effortFor(%q) = %q,%v, want identity", lvl, got, ok)
		}
	}
}

// TestChatCompletionsSendsReasoningEffort proves the Chat Completions path sends
// reasoning_effort mapped from the native level, and omits it when absent.
func TestChatCompletionsSendsReasoningEffort(t *testing.T) {
	newClient := func(t *testing.T, out *map[string]any) *Client {
		c, err := NewClient(Config{APIKey: "test", Model: "gpt-5.1", BaseURL: "https://example.test", HTTPClient: captureBody(t, out, "chat")})
		if err != nil {
			t.Fatalf("NewClient: %v", err)
		}
		c.thinkingSpec = OpenAIThinkingSpec("gpt-5.1")
		return c
	}

	// level high → reasoning_effort "high"
	var body map[string]any
	c := newClient(t, &body)
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages:      []provider.Message{{Type: "user", Content: "hi"}},
		ThinkingLevel: "high",
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got, _ := body["reasoning_effort"].(string); got != "high" {
		t.Fatalf("reasoning_effort = %q, want high", got)
	}

	// absent level → no reasoning_effort key
	var body2 map[string]any
	c2 := newClient(t, &body2)
	if _, err := c2.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if _, ok := body2["reasoning_effort"]; ok {
		t.Fatalf("reasoning_effort sent (%v) but should be omitted when level absent", body2["reasoning_effort"])
	}
}

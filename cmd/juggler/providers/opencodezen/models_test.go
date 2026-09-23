//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"slices"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestContextWindow pins a few known windows across vendors and the
// unknown-model default.
func TestContextWindow(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"claude-opus-4-5", 200000},
		{"claude-sonnet-4-5", 1000000},
		{"deepseek-v4-pro", 1000000},
		{"gpt-5", 400000},
		{"gemini-3-flash", 1048576},
		{"totally-unlisted-model", DefaultContextWindow}, // → default
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.want {
			t.Errorf("contextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestCurrentZenCatalogIsSized covers the ids the gateway serves today. Its
// listing publishes id, object, created and owned_by and no limits at all, so
// nothing at runtime corrects an omission here: an id missing from the table
// runs at the 200000 default against whatever the backend really serves.
func TestCurrentZenCatalogIsSized(t *testing.T) {
	for _, tc := range []struct {
		model string
		want  int
	}{
		{"claude-fable-5-1", 1000000},
		{"claude-opus-5", 1000000},
		{"claude-opus-5-5", 1000000},
		{"gemini-3.5-flash-lite", 1048576},
		{"gemini-3.6-flash", 1048576},
		{"gemini-3.7-flash", 1048576},
		{"gemini-3.8-flash", 1048576},
		{"glm-5.3", 1000000},
		{"glm-5.3-flash", 1000000},
		{"grok-4.6", 500000},
		{"kimi-k3", 1048576},
		// Not 1000000: the window is a million, but the documented input
		// ceiling in thinking mode — which is how this gateway runs it — is
		// lower, and the input ceiling is the one an admission check needs.
		{"qwen3.8-flash", 983616},
		{"deepseek-v4.1-flash", 1000000},
	} {
		if got, known := contextWindowCaps.LookupKnown(tc.model); !known || got != tc.want {
			t.Errorf("%s window = %d (declared: %v), want %d", tc.model, got, known, tc.want)
		}
	}
}

// TestRetiredZenModelsAreDropped checks that ids the gateway has stopped
// selling hold no entry. They cost nothing while they sit there, being
// unreachable, but they are a standing invitation to size a new model by
// copying a neighbour that no longer exists.
func TestRetiredZenModelsAreDropped(t *testing.T) {
	for _, model := range []string{
		"claude-opus-4-1",      // deprecated 2026-08-05
		"north-mini-code-free", // withdrawn from the listing
	} {
		if _, known := contextWindowCaps.LookupKnown(model); known {
			t.Errorf("%q still has a catalogued window, but the gateway no longer serves it", model)
		}
	}
}

// TestUnverifiedModelsCarryNoWindow pins the harder half of the contract. These
// ids are served, so the temptation is to complete the table for them — but
// their vendors are undisclosed or their limits undocumented, and the two
// directions of error are not equal. The 200000 default under-estimates most of
// them, costing room; a guessed window that runs over the real one is rejected
// mid-request with the whole prompt already built. An entry here needs a
// vendor's published figure behind it, not a plausible number.
func TestUnverifiedModelsCarryNoWindow(t *testing.T) {
	for _, model := range []string{
		"space-bunny-free",            // stealth, vendor undisclosed
		"muse-spark-1.3",              // vendor unconfirmed
		"nemotron-3.5-lightning-free", // undocumented
		"grok-4.7",                    // vendor docs unreadable; a re-server serves it smaller
	} {
		if _, known := contextWindowCaps.LookupKnown(model); known {
			t.Errorf("%q has a catalogued window, but no vendor figure was ever confirmed for it", model)
		}
	}
}

// TestOutputCapFitsWindow guards that no catalogued model's output cap exceeds
// its own context window (which would make max_tokens structurally impossible
// and 400 the request).
func TestOutputCapFitsWindow(t *testing.T) {
	for model := range ModelContextWindows {
		out := maxOutputCaps.Lookup(model)
		win := contextWindowCaps.Lookup(model)
		if out >= win {
			t.Errorf("maxOutput(%q) = %d must be < contextWindow %d (leave room for input)", model, out, win)
		}
	}
}

// TestThinkingSpecNativeLevels pins the thinking contract: each model advertises
// its native reasoning_effort levels directly (the level name IS the wire value),
// DeepSeek V4 exposes high/xhigh, and everything else low/medium/high.
func TestThinkingSpecNativeLevels(t *testing.T) {
	ds := thinkingSpec("deepseek-v4-pro")
	if !slices.Equal(ds.Levels, []string{"high", "xhigh"}) {
		t.Errorf("deepseek-v4 levels = %v, want [high xhigh]", ds.Levels)
	}
	if ds.Default != "high" {
		t.Errorf("deepseek-v4 default = %q, want high", ds.Default)
	}

	for _, model := range []string{"gpt-5", "claude-opus-4-5", "glm-5"} {
		spec := thinkingSpec(model)
		if !slices.Equal(spec.Levels, []string{"low", "medium", "high"}) {
			t.Errorf("thinkingSpec(%q) levels = %v, want [low medium high]", model, spec.Levels)
		}
	}
}

// TestCapabilitiesFailClosedOnUncataloguedModel pins the admission contract:
// catalogued ids resolve statically while user-invented aliases fail closed
// rather than inheriting the provider defaults.
func TestCapabilitiesFailClosedOnUncataloguedModel(t *testing.T) {
	Register()
	info, found := provider.GetProviderInfo("opencodezen")
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("opencodezen registration has no capability resolver")
	}
	got, found := info.ResolveModelCapabilities("deepseek-v4-pro")
	want := provider.ModelCapabilities{ContextWindowTokens: 1000000, MaxOutputTokens: 384000}
	if !found || got != want {
		t.Fatalf("deepseek-v4-pro capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	if got, found := info.ResolveModelCapabilities("my-custom-model"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("custom alias capabilities = (%+v, %v), want zero, false", got, found)
	}
}

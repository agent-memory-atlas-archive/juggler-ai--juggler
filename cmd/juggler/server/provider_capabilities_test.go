//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
	"juggler/internal/userpaths/userpathstest"
)

func TestResolveModelCapabilities(t *testing.T) {
	const providerName = "test_capability_resolution"
	provider.RegisterProvider(provider.ProviderInfo{
		Name: providerName,
		ModelContextWindows: map[string]int{
			"live-model":   111,
			"static-model": 222,
		},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{{
			ID:              "live-model",
			ContextWindow:   333,
			MaxOutputTokens: 44,
		}},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "exact live model wins over static metadata",
			model: "live-model",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 333,
				MaxOutputTokens:     44,
			},
		},
		{
			name:  "missing live model derives output reserve from known context",
			model: "static-model",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 222,
				MaxOutputTokens:     provider.ContextSafetyReserve(222),
			},
		},
		{
			name:  "unknown model remains unknown",
			model: "unknown-model",
			want:  provider.ModelCapabilities{},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestResolveModelCapabilitiesStaticResolverAndLivePrecedence(t *testing.T) {
	const providerName = "test_capability_static_resolver"
	fallback := provider.ModelCapabilities{
		ContextWindowTokens:    200000,
		MaxOutputTokens:        64000,
		ProviderOverheadTokens: 40000,
	}
	provider.RegisterProvider(provider.ProviderInfo{
		Name: providerName,
		ResolveModelCapabilities: func(model string) (provider.ModelCapabilities, bool) {
			return fallback, model == "sonnet"
		},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	t.Run("fresh alias uses conservative fallback", func(t *testing.T) {
		s := &Server{}
		if got := s.resolveModelCapabilities(providerName, "sonnet"); got != fallback {
			t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, fallback)
		}
		if got := s.resolveModelCapabilities(providerName, "custom"); got != (provider.ModelCapabilities{}) {
			t.Fatalf("unknown alias = %+v, want unknown", got)
		}
	})

	t.Run("positive live limits override fallback and retain overhead", func(t *testing.T) {
		s := &Server{}
		providers := []ProviderStatus{{
			Name: providerName,
			ModelsWithContext: []ModelWithContext{{
				ID: "sonnet", ContextWindow: 1000000, MaxOutputTokens: 32000,
			}},
		}}
		s.providersList.Store(&providers)
		want := provider.ModelCapabilities{
			ContextWindowTokens:    1000000,
			MaxOutputTokens:        32000,
			ProviderOverheadTokens: 40000,
		}
		if got := s.resolveModelCapabilities(providerName, "sonnet"); got != want {
			t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, want)
		}
	})
}

func TestResolveModelCapabilitiesKeepsFallbackForNonPositiveLiveValues(t *testing.T) {
	const providerName = "test_capability_live_unknown"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"model": 999},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name:              providerName,
		ModelsWithContext: []ModelWithContext{{ID: "model"}},
	}}
	s.providersList.Store(&providers)

	if got := s.resolveModelCapabilities(providerName, "model"); got != (provider.ModelCapabilities{ContextWindowTokens: 999, MaxOutputTokens: provider.ContextSafetyReserve(999)}) {
		t.Fatalf("resolveModelCapabilities() = %+v, want positive static fallback with derived reserve", got)
	}
}

// TestResolveModelCapabilitiesHonoursUserLimitOverrides pins the escape hatch
// for a model whose real limits differ from what this build believes: the
// user's models.limits override outranks the catalogue AND the live list, and
// applies even when the model appears in neither (an empty cache at startup, or
// a gateway alias the provider never lists).
func TestResolveModelCapabilitiesHonoursUserLimitOverrides(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "test_capability_user_overrides"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"catalogued": 128000},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	if err := core.SaveGlobalSettings(&core.GlobalSettings{Models: core.ModelSettings{
		Limits: map[string]map[string]core.ModelLimits{providerName: {
			"catalogued":   {ContextWindow: 1000000, MaxOutputTokens: 64000},
			"listed":       {ContextWindow: 200000},
			"never-listed": {ContextWindow: 512000},
		}},
	}}); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}

	s := &Server{settings: newSettingsStore()}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{
			{ID: "listed", ContextWindow: 32000, MaxOutputTokens: 4096},
		},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "override beats the compiled-in catalogue",
			model: "catalogued",
			want:  provider.ModelCapabilities{ContextWindowTokens: 1000000, MaxOutputTokens: 64000},
		},
		{
			// The half the user left blank still comes from the provider, so
			// correcting a window does not silently discard a good output cap.
			name:  "override beats the live list, per field",
			model: "listed",
			want:  provider.ModelCapabilities{ContextWindowTokens: 200000, MaxOutputTokens: 4096},
		},
		{
			// Nothing knows this model. Without the override it would be
			// unknown, and admission would have no window to charge against.
			name:  "override alone makes an unlisted model usable",
			model: "never-listed",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 512000,
				MaxOutputTokens:     provider.ContextSafetyReserve(512000),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}

// TestWindowResolverReportsAssumedWindow pins what the worker is told about a
// guessed window: that it is one while the provider's fallback stands, and that
// it no longer is once the user has typed the real number in. Compaction reads
// this to say which window it folded at, so a user who has already corrected
// the window must not be told it is a guess.
func TestWindowResolverReportsAssumedWindow(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "test_capability_window_assumed"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName},
		func(provider.Config) (provider.Provider, error) { return nil, nil })

	if err := core.SaveGlobalSettings(&core.GlobalSettings{Models: core.ModelSettings{
		Limits: map[string]map[string]core.ModelLimits{providerName: {
			"corrected": {ContextWindow: 256000},
		}},
	}}); err != nil {
		t.Fatalf("SaveGlobalSettings: %v", err)
	}
	s := &Server{settings: newSettingsStore()}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{
			{ID: "guessed", ContextWindow: 8192, WindowAssumed: true},
			{ID: "corrected", ContextWindow: 8192, WindowAssumed: true},
			{ID: "reported", ContextWindow: 131072, FromAPI: true},
		},
	}}
	s.providersList.Store(&providers)

	resolve := s.createWindowResolver()
	for model, want := range map[string]worker.ContextWindowInfo{
		"guessed":   {WindowTokens: 8192, ReserveTokens: int(provider.ContextSafetyReserve(8192)), Assumed: true},
		"corrected": {WindowTokens: 256000, ReserveTokens: int(provider.ContextSafetyReserve(256000))},
		"reported":  {WindowTokens: 131072, ReserveTokens: int(provider.ContextSafetyReserve(131072))},
	} {
		if got := resolve(worker.ModelConfig{Provider: providerName, Model: model}); got != want {
			t.Errorf("%s: resolver = %+v, want %+v", model, got, want)
		}
	}
}

// TestApplyModelLimitsPublishesEffectiveAndReportedValues pins what the
// catalogue puts on the wire: consumers read one effective number, and the
// provider's own is preserved beside it only where an override replaced it, so
// the settings UI can show what clearing the field restores.
func TestApplyModelLimitsPublishesEffectiveAndReportedValues(t *testing.T) {
	base := ModelWithContext{ID: "m", ContextWindow: 128000, MaxOutputTokens: 16384}

	t.Run("no override leaves the entry untouched", func(t *testing.T) {
		got := applyModelLimits(base, core.ModelLimits{})
		if got.ContextWindow != 128000 || got.MaxOutputTokens != 16384 {
			t.Fatalf("limits = %d/%d, want the provider's 128000/16384", got.ContextWindow, got.MaxOutputTokens)
		}
		if got.ProviderContextWindow != nil || got.ProviderMaxOutputTokens != nil {
			t.Fatal("reported values published without an override — the UI would read that as overridden")
		}
	})

	t.Run("one override replaces one field and records it", func(t *testing.T) {
		got := applyModelLimits(base, core.ModelLimits{ContextWindow: 1000000})
		if got.ContextWindow != 1000000 {
			t.Fatalf("context window = %d, want the override 1000000", got.ContextWindow)
		}
		if got.ProviderContextWindow == nil || *got.ProviderContextWindow != 128000 {
			t.Fatalf("reported window = %v, want 128000", got.ProviderContextWindow)
		}
		if got.MaxOutputTokens != 16384 || got.ProviderMaxOutputTokens != nil {
			t.Fatalf("output limit disturbed: %d / %v", got.MaxOutputTokens, got.ProviderMaxOutputTokens)
		}
	})

	t.Run("a provider that reports nothing overrides to a recorded zero", func(t *testing.T) {
		// The pointer is why this is expressible: a plain int could not tell
		// "provider reported 0" from "not overridden".
		got := applyModelLimits(ModelWithContext{ID: "m"}, core.ModelLimits{ContextWindow: 64000})
		if got.ContextWindow != 64000 {
			t.Fatalf("context window = %d, want 64000", got.ContextWindow)
		}
		if got.ProviderContextWindow == nil || *got.ProviderContextWindow != 0 {
			t.Fatalf("reported window = %v, want a recorded 0", got.ProviderContextWindow)
		}
	})
}

// TestResolveModelCapabilitiesDerivesOneEffectiveOutputLimit pins the unified
// output-limit policy on the snapshot: a known window with no output limit
// from any source gets the shared derived reserve (the same value admission
// charges and the wire sends), while explicit limits from any source win.
func TestResolveModelCapabilitiesDerivesOneEffectiveOutputLimit(t *testing.T) {
	const providerName = "test_capability_output_unification"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"context-only": 100000, "huge-context": 400000},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{
			{ID: "live-explicit", ContextWindow: 128000, MaxOutputTokens: 8192},
			{ID: "live-context-only", ContextWindow: 64000},
			{ID: "live-cap-equals-window", ContextWindow: 50000, MaxOutputTokens: 50000},
			{ID: "live-cap-above-window", ContextWindow: 50000, MaxOutputTokens: 60000},
		},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "small window derives a fifth",
			model: "context-only",
			want:  provider.ModelCapabilities{ContextWindowTokens: 100000, MaxOutputTokens: 20000},
		},
		{
			name:  "huge window derives the flat cap",
			model: "huge-context",
			want:  provider.ModelCapabilities{ContextWindowTokens: 400000, MaxOutputTokens: 20000},
		},
		{
			name:  "explicit live limit wins over derivation",
			model: "live-explicit",
			want:  provider.ModelCapabilities{ContextWindowTokens: 128000, MaxOutputTokens: 8192},
		},
		{
			name:  "live context-only derives reserve",
			model: "live-context-only",
			want:  provider.ModelCapabilities{ContextWindowTokens: 64000, MaxOutputTokens: 12800},
		},
		{
			// F2: an output cap equal to the window leaves no input room; clamp
			// it to the derived reserve so admission never bricks the model.
			name:  "reported cap equal to window clamps to derived reserve",
			model: "live-cap-equals-window",
			want:  provider.ModelCapabilities{ContextWindowTokens: 50000, MaxOutputTokens: provider.ContextSafetyReserve(50000)},
		},
		{
			name:  "reported cap above window clamps to derived reserve",
			model: "live-cap-above-window",
			want:  provider.ModelCapabilities{ContextWindowTokens: 50000, MaxOutputTokens: provider.ContextSafetyReserve(50000)},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}

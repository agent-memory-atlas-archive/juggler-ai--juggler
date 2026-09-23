//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"slices"
	"strings"
)

// ThinkingSpec describes a model's reasoning-effort support. Each level name IS
// the native reasoning_effort string sent on the wire — there is no separate
// canonical vocabulary. The zero value (nil Levels) means the model exposes no
// reasoning control and the UI hides the selector.
type ThinkingSpec struct {
	// Levels are the native reasoning_effort strings advertised to the UI, in
	// display order (e.g. ["low","medium","high"], ["none","low","high","xhigh"]).
	Levels []string
	// Default is the level the model uses when a turn carries none (presentation
	// only, so the UI can label "Default (medium)"). One of Levels.
	Default string
}

// ThinkingSpecFunc returns the ThinkingSpec for a model id. A nil func (or a
// zero ThinkingSpec) means the provider exposes no reasoning control.
type ThinkingSpecFunc func(modelID string) ThinkingSpec

// effortFor returns the native reasoning_effort to send for a requested level.
// ok=false means omit the reasoning param entirely — the level is absent or not
// one this model advertises — which preserves today's default request shape
// byte-for-byte. The advertised list is the only gate: a level is valid iff it
// is a member, and the string is sent verbatim.
func (s ThinkingSpec) effortFor(level string) (string, bool) {
	if level == "" || !slices.Contains(s.Levels, level) {
		return "", false
	}
	return level, true
}

// Options returns the advertised thinking levels in display order.
func (s ThinkingSpec) Options() []string {
	return s.Levels
}

// EffortSpec builds a ThinkingSpec from an ordered list of native
// reasoning_effort strings, with defaultLevel labelling the UI's "Default (…)"
// hint. It exists only to keep call sites terse — Levels is the given slice
// verbatim.
func EffortSpec(defaultLevel string, levels ...string) ThinkingSpec {
	return ThinkingSpec{Levels: levels, Default: defaultLevel}
}

// OpenAIThinkingSpec classifies an OpenAI / OpenAI-Codex model id into its
// reasoning-effort support, expressed in the native reasoning_effort values the
// family accepts. Non-reasoning models (gpt-4o, gpt-4, gpt-3.5) return the zero
// ThinkingSpec.
//
// The level sets are deliberately conservative: the valid set of
// reasoning_effort values differs per model and a value the model does not
// accept risks a hard 400, so a model we can't confidently classify gets no
// control (no param sent) rather than a guessed value. It then runs at its own
// default effort, which is always a value the model accepts. This is the single
// source of truth shared by the openai and openaicodex providers.
//
// Unlike routing and vision, this question cannot be answered by generation:
// the accepted set genuinely differs model by model — gpt-5.1 takes "none"
// where gpt-5 takes "minimal", and gpt-6-astra takes neither — which is why the
// ChatGPT-plan catalog ships a per-model reasoning list rather than a rule.
func OpenAIThinkingSpec(modelID string) ThinkingSpec {
	m := strings.ToLower(modelID)

	// GPT-6 Astra: no off tier at all, and two tiers above "high".
	if strings.HasPrefix(m, "gpt-6-astra") {
		return EffortSpec("low", "low", "medium", "high", "xhigh", "max")
	}

	// GPT-6 Sol and Luna: Astra's range plus the explicit "none" it refuses.
	// The ChatGPT-plan catalog advertises a further "ultra" tier for Sol, which
	// is deliberately not offered here: this spec answers for the Platform API,
	// where "ultra" is undocumented and would risk a 400. The plan provider
	// takes its levels from the live catalog, so it gets that tier there.
	if strings.HasPrefix(m, "gpt-6-sol") || strings.HasPrefix(m, "gpt-6-luna") {
		return EffortSpec("medium", "none", "low", "medium", "high", "xhigh", "max")
	}

	// Codex reasoning models (gpt-5.x-codex, codex-max, bare "codex" slugs).
	// They accept low/medium/high; codex-max style models add an "xhigh" tier.
	// No "off"/"none" — codex reasons on every turn.
	if strings.Contains(m, "codex") {
		if strings.Contains(m, "codex-max") || strings.Contains(m, "5.2-codex") {
			return EffortSpec("medium", "low", "medium", "high", "xhigh")
		}
		return EffortSpec("medium", "low", "medium", "high")
	}

	// GPT-5 family. gpt-5.1/5.2/5.6 accept an explicit "none" for fully-off; the
	// original gpt-5 line (gpt-5, gpt-5-mini, gpt-5-nano) uses "minimal" as its
	// lowest tier instead.
	if strings.HasPrefix(m, "gpt-5") {
		if strings.HasPrefix(m, "gpt-5.1") || strings.HasPrefix(m, "gpt-5.2") || strings.HasPrefix(m, "gpt-5.6") {
			return EffortSpec("medium", "none", "low", "medium", "high")
		}
		if GPTGeneration(m) == 5 {
			return EffortSpec("medium", "minimal", "low", "medium", "high")
		}
		// Any other gpt-5.x: unclassified, so no control and no parameter. These
		// route to Chat Completions, which will not tool-call alongside any
		// effort but "none" — so the levels we would have to guess at are
		// precisely the ones that would stop the model calling a tool. Their own
		// default effort is both correct and safe. Classify one here only with
		// its documented set in hand, and route it to Responses if that set
		// contains anything but "none".
		return ThinkingSpec{}
	}

	// o-series reasoning models (o1, o3, o3-mini, o4-mini). These accept only
	// low/medium/high — no "minimal"/"none"/"xhigh". o1-mini and o1-preview do
	// not accept reasoning_effort and are excluded.
	if isOSeriesReasoning(m) {
		return EffortSpec("medium", "low", "medium", "high")
	}

	return ThinkingSpec{}
}

// isOSeriesReasoning reports whether a (lower-cased) model id is an o-series
// reasoning model that accepts reasoning_effort. Includes o1, o3, o3-mini and
// o4-mini (and their dated ids); excludes o1-mini / o1-preview, which don't.
func isOSeriesReasoning(m string) bool {
	switch {
	case m == "o1" || strings.HasPrefix(m, "o1-2"):
		return true
	case m == "o3" || strings.HasPrefix(m, "o3-2") || strings.HasPrefix(m, "o3-mini"):
		return true
	case strings.HasPrefix(m, "o4-mini"):
		return true
	default:
		return false
	}
}

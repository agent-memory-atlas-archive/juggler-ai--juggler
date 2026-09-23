//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
)

// ModelContextWindows maps OpenCode Zen model names to context window sizes.
// Source: https://opencode.ai/zen/v1 models endpoint.
//
// A gateway is the case where a table keyed by model id is least trustworthy:
// the id names a model, and the limits belong to whichever backend the gateway
// routes it to. The same model id served by two providers genuinely differs —
// measured across OpenRouter's backends for one model, context ranged from 1M
// to 1.05M and the output cap from 16K to 943K, a 58x spread under one name.
// So anything the endpoint publishes about its own models wins outright — but
// this endpoint publishes nothing: its listing carries id, object, created and
// owned_by, and no limits. These entries therefore answer for every model it
// serves, not merely for a listing that could not be fetched, and an id missing
// from them is sized by DefaultContextWindow rather than corrected at runtime.
//
// A figure here needs a vendor's published number behind it. Where the vendor
// is undisclosed or silent the id is deliberately absent, because the default
// under-estimates while a guess that overshoots is rejected mid-request.
var ModelContextWindows = map[string]int{
	"big-pickle":             200000,
	"claude-fable-5":         1000000,
	"claude-fable-5-1":       1000000,
	"claude-haiku-4-5":       200000,
	"claude-opus-4-5":        200000,
	"claude-opus-4-6":        1000000,
	"claude-opus-4-7":        1000000,
	"claude-opus-4-8":        1000000,
	"claude-opus-5":          1000000,
	"claude-opus-5-5":        1000000,
	"claude-sonnet-4":        1000000,
	"claude-sonnet-4-5":      1000000,
	"claude-sonnet-4-6":      1000000,
	"claude-sonnet-5":        1000000,
	"deepseek-v4-flash":      1000000,
	"deepseek-v4-flash-free": 200000,
	"deepseek-v4-pro":        1000000,
	"deepseek-v4.1-flash":    1000000,
	"glm-5":                  204800,
	"glm-5.1":                204800,
	"glm-5.2":                1000000,
	"glm-5.3":                1000000,
	"glm-5.3-flash":          1000000,
	"gpt-5":                  400000,
	"gpt-5-codex":            400000,
	"gpt-5-nano":             400000,
	"gpt-5.1":                400000,
	"gpt-5.1-codex":          400000,
	"gpt-5.1-codex-max":      400000,
	"gpt-5.1-codex-mini":     400000,
	"gpt-5.2":                400000,
	"gpt-5.2-codex":          400000,
	"gpt-5.3-codex":          400000,
	"gpt-5.3-codex-spark":    128000,
	"gpt-5.4":                1050000,
	"gpt-5.4-mini":           400000,
	"gpt-5.4-nano":           400000,
	"gpt-5.4-pro":            1050000,
	"gpt-5.5":                1050000,
	"gpt-5.5-pro":            1050000,
	"gpt-5.6-luna":           1050000,
	"gpt-5.6-sol":            1050000,
	"gpt-5.6-terra":          1050000,
	"gpt-6-astra":            1050000,
	"gpt-6-luna":             1050000,
	"gpt-6-sol":              1050000,
	"gemini-3-flash":         1048576,
	"gemini-3.1-pro":         1048576,
	"gemini-3.5-flash":       1048576,
	"gemini-3.5-flash-lite":  1048576,
	"gemini-3.6-flash":       1048576,
	"gemini-3.7-flash":       1048576,
	"gemini-3.8-flash":       1048576,
	"grok-4.5":               500000,
	"grok-4.6":               500000,
	"grok-build-0.1":         256000,
	"kimi-k2.5":              262144,
	"kimi-k2.6":              262144,
	"kimi-k2.7-code":         262144,
	// K3's window is shared between prompt and completion rather than being a
	// separate input ceiling, so the whole conversation is spent against it.
	"kimi-k3":        1048576,
	"mimo-v2.5-free": 200000,
	// Xiaomi documents a 1M window, but this gateway's free tier is served at
	// its own smaller limit — the same shrink deepseek-v4-flash-free carries.
	"mimo-v2.6-flash-free":  200000,
	"minimax-m2.5":          204800,
	"minimax-m2.7":          204800,
	"minimax-m3":            512000,
	"nemotron-3-ultra-free": 1000000,
	"qwen3.5-plus":          262144,
	"qwen3.6-plus":          262144,
	// The window is a million, but the documented input ceiling with thinking
	// on — which is how this gateway serves it — is lower, and it is the input
	// ceiling that an admission check has to respect.
	"qwen3.8-flash": 983616,
}

const DefaultContextWindow = 200000
const DefaultMaxOutputTokens = 32000

// ModelMaxOutputTokens overrides the default output cap for models with a
// larger known ceiling. Every entry must stay strictly below the model's
// context window (an output cap == the window leaves no room for input and
// 400s the request); models omitted here fall back to DefaultMaxOutputTokens.
var ModelMaxOutputTokens = map[string]int{
	"deepseek-v4-flash":     384000,
	"deepseek-v4-pro":       384000,
	"minimax-m3":            128000,
	"nemotron-3-ultra-free": 128000,
}

var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)

// thinkingSpec returns the reasoning-effort spec for an OpenCode Zen model.
// Most models support low/medium/high; DeepSeek V4 models use high/xhigh.
// Each level string is the native reasoning_effort the gateway expects on the
// wire and the label shown in the UI.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	m := strings.ToLower(modelID)

	if strings.HasPrefix(m, "deepseek-v4") {
		return openaibase.EffortSpec("high", "high", "xhigh")
	}

	// All other models on this gateway support low/medium/high.
	return openaibase.EffortSpec("medium", "low", "medium", "high")
}

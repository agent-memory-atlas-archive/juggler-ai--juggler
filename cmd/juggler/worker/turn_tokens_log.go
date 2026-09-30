//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"time"
)

// turnTokensLine formats the per-turn token economics logged at Info level, so
// the prompt-cache hit rate is visible in the normal conversation log without
// enabling trace.
//
// cached/input is the prefix-cache hit rate: on an agent loop it should climb
// toward ~1.0 once routing is pinned (prompt_cache_key). A persistent 0 on an
// OpenAI/Codex model means the growing prefix is being re-billed every turn —
// the shard-misrouting burn. cached=? / cacheWrite=? mean the provider reported
// no cache usage for the call: unknown, not a miss. thread is logged so an
// interleaved sub-context (its own short prefix, tiny output) is
// distinguishable from the main task's turns rather than looking like a cache
// miss on the same conversation.
//
// est is how large admission judged this same request before dispatching it,
// and est/input is that judgement's error against what the provider actually
// billed. It is logged because automatic compaction fires on est, not on
// input: a ratio well above 1.0 means compaction triggers at a fraction of the
// real window, which is invisible from input alone.
//
// The "anchored"/"full" tag says which way est was reached. Anchored means it
// was projected from the previous turn's measured count plus an estimate of
// only the messages added since, so the ratio should sit near 1.0. Full means
// the whole request was estimated by the character heuristic, which is where
// the large ratios live. A run of "full" on a long conversation means the
// transcript prefix keeps changing under us and the anchor is not holding —
// that, not the ratio, is the thing to chase.
//
// est=? means admission did not size the request at all (unknown window). A
// trailing ~ means input is itself a local fallback estimate, so there is no
// measurement to form a ratio against.
func turnTokensLine(threadID string, response *LLMResponse, duration time.Duration) string {
	cached, hit, cacheWrite := "?", "?", "?"
	if response.CachedTokens != nil {
		cached = fmt.Sprintf("%d", *response.CachedTokens)
		hit = "0"
		if response.InputTokens > 0 {
			hit = fmt.Sprintf("%d", *response.CachedTokens*100/response.InputTokens)
		}
	}
	if response.CacheWriteTokens != nil {
		cacheWrite = fmt.Sprintf("%d", *response.CacheWriteTokens)
	}
	est := "?"
	if response.AdmissionEstimateTokens > 0 {
		basis := "full"
		if response.AdmissionAnchored {
			basis = "anchored"
		}
		est = fmt.Sprintf("%d/%s", response.AdmissionEstimateTokens, basis)
		switch {
		case response.InputTokensApproximate:
			est += "~"
		case response.InputTokens > 0:
			est += fmt.Sprintf(" %.2fx", float64(response.AdmissionEstimateTokens)/float64(response.InputTokens))
		}
	}
	return fmt.Sprintf("[turn tokens] thread=%q input=%d est=%s cached=%s (%s%% hit) output=%d cacheWrite=%s stop=%s in %s",
		threadID, response.InputTokens, est, cached, hit,
		response.OutputTokens, cacheWrite, response.StopReason,
		duration.Round(time.Millisecond))
}

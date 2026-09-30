//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

func TestTurnTokensLine(t *testing.T) {
	intp := func(n int) *int { return &n }
	cases := []struct {
		name string
		resp LLMResponse
		want string
	}{
		{
			name: "no cache usage reported is unknown, not a miss",
			resp: LLMResponse{InputTokens: 1000, OutputTokens: 50, StopReason: provider.StopReasonEndTurn},
			want: `[turn tokens] thread="t1" input=1000 est=? cached=? (?% hit) output=50 cacheWrite=? stop=end_turn in 1.5s`,
		},
		{
			name: "anchored estimate with a measured ratio",
			resp: LLMResponse{
				InputTokens: 1000, OutputTokens: 50, CachedTokens: intp(900), CacheWriteTokens: intp(100),
				AdmissionEstimateTokens: 1100, AdmissionAnchored: true, StopReason: provider.StopReasonToolUse,
			},
			want: `[turn tokens] thread="t1" input=1000 est=1100/anchored 1.10x cached=900 (90% hit) output=50 cacheWrite=100 stop=tool_use in 1.5s`,
		},
		{
			name: "approximate input has no ratio to form",
			resp: LLMResponse{
				InputTokens: 1000, InputTokensApproximate: true, CachedTokens: intp(0),
				AdmissionEstimateTokens: 2000, StopReason: provider.StopReasonEndTurn,
			},
			want: `[turn tokens] thread="t1" input=1000 est=2000/full~ cached=0 (0% hit) output=0 cacheWrite=? stop=end_turn in 1.5s`,
		},
		{
			name: "zero input reports a zero hit rate rather than dividing",
			resp: LLMResponse{CachedTokens: intp(5), StopReason: provider.StopReasonEndTurn},
			want: `[turn tokens] thread="t1" input=0 est=? cached=5 (0% hit) output=0 cacheWrite=? stop=end_turn in 1.5s`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := turnTokensLine("t1", &tc.resp, 1500*time.Millisecond+400*time.Microsecond)
			if got != tc.want {
				t.Errorf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func TestClampOutputToWindow(t *testing.T) {
	tests := []struct {
		name      string
		window    int
		maxOutput int
		want      int
	}{
		{"a cap that fits is left alone", 200000, 64000, 64000},
		{"a cap equal to the window leaves no input room", 8192, 8192, 1638},
		{"a cap above the window is a catalog artifact", 128000, 200000, 20000},
		{"a cap over the admission ceiling leaves no usable input room", 1000000, 900000, 20000},
		{"a cap just under the admission ceiling is left alone", 1000000, 849999, 849999},
		{"an absent cap derives the reserve", 1000000, 0, 20000},
		{"a negative cap derives the reserve", 32000, -1, 6400},
		{"a small window derives a fifth", 4096, 0, 819},
		{"an unknown window cannot clamp", 0, 64000, 64000},
		{"an unknown window with no cap stays unknown", 0, 0, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClampOutputToWindow(tc.window, tc.maxOutput); got != tc.want {
				t.Errorf("ClampOutputToWindow(%d, %d) = %d, want %d", tc.window, tc.maxOutput, got, tc.want)
			}
		})
	}
}

// TestClampedOutputAlwaysLeavesInputRoom states the property the table above
// samples: whatever comes back for a known window is usable, so no clamped pair
// can be the one that 400s.
//
// The domain starts at 2 because a one-token window has no answer at all — the
// smallest reserve that is still a limit is one token, which is the whole
// window. A provider reporting a window of 1 is reporting a broken model, and
// admission refusing it outright is the correct outcome, not something for this
// function to paper over with a fabricated cap.
func TestClampedOutputAlwaysLeavesInputRoom(t *testing.T) {
	windows := []int{2, 100, 4096, 8192, 32000, 128000, 200000, 1000000, 1048576}
	outputs := []int{-5, 0, 1, 4096, 65536, 128000, 999999, 2000000}
	for _, window := range windows {
		for _, output := range outputs {
			got := ClampOutputToWindow(window, output)
			if got <= 0 {
				t.Errorf("window %d, cap %d: clamped to %d, which is not a limit", window, output, got)
			}
			if got >= window {
				t.Errorf("window %d, cap %d: clamped to %d, which still leaves no room for input", window, output, got)
			}
			// Room for input is not enough on its own: admission charges this
			// cap as its output reserve and advises compaction once the reserve
			// plus the input estimate passes the soft ceiling. A reserve at or
			// above that ceiling exceeds it unaided, so every request advises
			// and no amount of folding can ever clear it. A window of 2 is
			// excluded because its ceiling and its derived reserve are both one
			// token, so no cap can satisfy this — the same degenerate end the
			// domain note above describes.
			if window >= 3 && int64(got) >= provider.ContextCeiling(int64(window), 0) {
				t.Errorf("window %d, cap %d: clamped to %d, at or above the admission ceiling %d — every request would advise compaction",
					window, output, got, provider.ContextCeiling(int64(window), 0))
			}
		}
	}
}

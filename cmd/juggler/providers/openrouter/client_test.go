//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestListModelsClampsOutputCapAtOrAboveWindow pins the F2 source clamp: an
// OpenRouter catalog entry whose max_completion_tokens is at or above its
// context_length would leave zero input room, so listModels replaces the
// reported cap with the reserve derived from the window — the same answer the
// server would reach, so the listed number and the enforced one agree. A
// normal, smaller cap passes through untouched, and a model with no window at
// all has nothing to derive from and keeps the flat default.
func TestListModelsClampsOutputCapAtOrAboveWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[
			{"id":"cap-equals-window","context_length":128000,"top_provider":{"max_completion_tokens":128000}},
			{"id":"cap-above-window","context_length":128000,"top_provider":{"max_completion_tokens":200000}},
			{"id":"no-cap-reported","context_length":128000,"top_provider":{}},
			{"id":"normal-cap","context_length":128000,"top_provider":{"max_completion_tokens":16384}}
		]}`))
	}))
	defer srv.Close()

	orig := baseURL
	baseURL = srv.URL
	defer func() { baseURL = orig }()

	infos, err := listModels(context.Background(), "key", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := map[string]int{}
	for _, info := range infos {
		byID[info.ID] = info.MaxOutputTokens
	}
	// A 128000 window derives a 20000 reserve (a fifth, capped at 20k).
	const derivedReserve = 20000
	for _, id := range []string{"cap-equals-window", "cap-above-window", "no-cap-reported"} {
		if got := byID[id]; got != derivedReserve {
			t.Errorf("%s MaxOutputTokens = %d, want the derived reserve %d", id, got, derivedReserve)
		}
	}
	if got := byID["normal-cap"]; got != 16384 {
		t.Fatalf("normal-cap MaxOutputTokens = %d, want 16384 preserved", got)
	}
}

// TestListModelsPrefersServingContextWindow pins which of OpenRouter's two
// context numbers a model's window comes from.
//
// The first row is a real catalog entry, copied verbatim. Its top-level
// context_length (1310720) is the maximum across every endpoint that can serve
// the id; top_provider describes the one that actually will, and that endpoint
// takes 1048576. Reading the window from the aggregate while reading the output
// cap from top_provider mixes two denominators, and the result is not a rounding
// error: a 943718 reserve charged against a 1310720 window clears the source
// clamp, goes out as the wire max_tokens, and leaves the serving endpoint
// 104858 tokens of input before it rejects outright.
//
// Taking the serving window makes both numbers agree again, and the clamp above
// then recognises 943718 for the artifact it is.
func TestListModelsPrefersServingContextWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[
			{"id":"~z-ai/glm-flash-latest","context_length":1310720,"top_provider":{"context_length":1048576,"max_completion_tokens":943718}},
			{"id":"no-serving-window","context_length":128000,"top_provider":{"max_completion_tokens":16384}}
		]}`))
	}))
	defer srv.Close()

	orig := baseURL
	baseURL = srv.URL
	defer func() { baseURL = orig }()

	infos, err := listModels(context.Background(), "key", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := map[string]provider.ModelInfo{}
	for _, info := range infos {
		byID[info.ID] = info
	}

	glm := byID["~z-ai/glm-flash-latest"]
	if glm.ContextWindow != 1048576 {
		t.Errorf("ContextWindow = %d, want the serving endpoint's 1048576", glm.ContextWindow)
	}
	// 943718 is at or above the admission ceiling of a 1048576 window, so the
	// clamp replaces it with the reserve derived from that window.
	if glm.MaxOutputTokens != 20000 {
		t.Errorf("MaxOutputTokens = %d, want the derived reserve 20000", glm.MaxOutputTokens)
	}

	// Nothing to prefer: the top-level window stands.
	if got := byID["no-serving-window"]; got.ContextWindow != 128000 || got.MaxOutputTokens != 16384 {
		t.Errorf("no-serving-window = (%d, %d), want (128000, 16384)", got.ContextWindow, got.MaxOutputTokens)
	}
}

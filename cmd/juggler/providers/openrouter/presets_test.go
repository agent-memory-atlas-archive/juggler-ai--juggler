//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// catalogJSON is the /models body the preset tests resolve windows against. The
// three entries exist to be looked up by the presets below, so their numbers are
// chosen to be unambiguous: every cap sits well under its window, so the source
// clamp passes them through and a preset's expected figure is exactly the
// model's.
const catalogJSON = `{"data":[
	{"id":"openai/gpt-4o","name":"OpenAI: GPT-4o","context_length":128000,"top_provider":{"context_length":128000,"max_completion_tokens":16384}},
	{"id":"big/model","context_length":1000000,"top_provider":{"context_length":1000000,"max_completion_tokens":32768}},
	{"id":"small/model","context_length":100000,"top_provider":{"context_length":100000,"max_completion_tokens":4096}}
]}`

// presetsListJSON is one page of /presets: metadata only, exactly as OpenRouter
// returns it — no model and no context length anywhere in it.
const presetsListJSON = `{"data":[
	{"id":"p1","slug":"routing","name":"Routing Only","status":"active"},
	{"id":"p2","slug":"chain","name":"","status":"active"},
	{"id":"p3","slug":"bare","name":"Bare Config","status":"active"},
	{"id":"p4","slug":"archived-one","name":"Archived One","status":"archived"},
	{"id":"p5","slug":"broken","name":"Broken","status":"active"}
],"total_count":5}`

// presetDetailJSON maps a slug to its /presets/{slug} body. The model a preset
// routes to lives in designated_version.config, which is free-form: "model",
// "models", or neither.
var presetDetailJSON = map[string]string{
	"routing": `{"data":{"slug":"routing","name":"Routing Only","status":"active",
		"designated_version":{"config":{"model":"openai/gpt-4o","temperature":0.7},
		"system_prompt":"You are a helpful assistant.","version":1}}}`,
	"chain": `{"data":{"slug":"chain","name":"","status":"active",
		"designated_version":{"config":{"models":["big/model","small/model"]},"version":1}}}`,
	"bare": `{"data":{"slug":"bare","name":"Bare Config","status":"active",
		"designated_version":{"config":{"provider":{"order":["anthropic"],"zdr":true}},"version":1}}}`,
}

// presetFakeServer serves /models, /presets and /presets/{slug}. presetsStatus
// overrides the /presets status code so the soft-fail path can be exercised;
// slugs absent from presetDetailJSON answer 500, which is the per-preset
// degrade path. It records the /presets query string for the paging assertion.
func presetFakeServer(t *testing.T, presetsStatus int) (*httptest.Server, func() string) {
	t.Helper()
	var listQuery atomic.Pointer[string]
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/models":
			_, _ = w.Write([]byte(catalogJSON))
		case r.URL.Path == "/presets":
			query := r.URL.RawQuery
			listQuery.Store(&query)
			if presetsStatus != http.StatusOK {
				http.Error(w, "presets unavailable", presetsStatus)
				return
			}
			_, _ = w.Write([]byte(presetsListJSON))
		case strings.HasPrefix(r.URL.Path, "/presets/"):
			slug := strings.TrimPrefix(r.URL.Path, "/presets/")
			body, ok := presetDetailJSON[slug]
			if !ok {
				http.Error(w, "no such preset", http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(body))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() string {
		if query := listQuery.Load(); query != nil {
			return *query
		}
		return ""
	}
}

// pointBaseURLAt redirects the package's OpenRouter base URL at a fake server
// for the duration of one test.
func pointBaseURLAt(t *testing.T, url string) {
	t.Helper()
	orig := baseURL
	baseURL = url
	t.Cleanup(func() { baseURL = orig })
}

func modelsByID(infos []provider.ModelInfo) map[string]provider.ModelInfo {
	byID := make(map[string]provider.ModelInfo, len(infos))
	for _, info := range infos {
		byID[info.ID] = info
	}
	return byID
}

// TestListModelsIncludesPresets pins the whole preset path: presets arrive in
// the model list as the "@preset/<slug>" ids OpenRouter accepts in place of a
// model, and each one carries a real context window resolved from the model its
// config names — never a guess, because admission fails closed on an unknown
// window.
func TestListModelsIncludesPresets(t *testing.T) {
	srv, _ := presetFakeServer(t, http.StatusOK)
	pointBaseURLAt(t, srv.URL)

	infos, err := listModels(context.Background(), "key", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := modelsByID(infos)

	// The catalog itself is untouched by the preset pass.
	for _, id := range []string{"openai/gpt-4o", "big/model", "small/model"} {
		if _, ok := byID[id]; !ok {
			t.Errorf("model %q missing from the list", id)
		}
	}

	// A single-model preset inherits that model's numbers verbatim, and is
	// labelled with the name the user gave the preset.
	routing, ok := byID["@preset/routing"]
	if !ok {
		t.Fatalf("@preset/routing missing; list = %v", ids(infos))
	}
	if routing.ContextWindow != 128000 || routing.MaxOutputTokens != 16384 {
		t.Errorf("@preset/routing = (%d, %d), want its model's (128000, 16384)",
			routing.ContextWindow, routing.MaxOutputTokens)
	}
	if routing.DisplayName != "Routing Only" {
		t.Errorf("@preset/routing DisplayName = %q, want the preset's name", routing.DisplayName)
	}
	if !routing.FromAPI {
		t.Error("@preset/routing not marked FromAPI")
	}

	// A models fallback array takes the smallest window in the chain: OpenRouter
	// picks the serving model at request time, so anything larger is a window we
	// might not get. An empty name falls back to the slug.
	chain, ok := byID["@preset/chain"]
	if !ok {
		t.Fatalf("@preset/chain missing; list = %v", ids(infos))
	}
	if chain.ContextWindow != 100000 || chain.MaxOutputTokens != 4096 {
		t.Errorf("@preset/chain = (%d, %d), want the chain's smallest (100000, 4096)",
			chain.ContextWindow, chain.MaxOutputTokens)
	}
	if chain.DisplayName != "chain" {
		t.Errorf("@preset/chain DisplayName = %q, want the slug as fallback", chain.DisplayName)
	}

	// A config naming no model at all (routing preferences only — what the
	// feature is actually for) still gets listed, on the provider default.
	// A 128000 window derives a 20000 reserve.
	bare, ok := byID["@preset/bare"]
	if !ok {
		t.Fatalf("@preset/bare missing; list = %v", ids(infos))
	}
	if bare.ContextWindow != DefaultContextWindow || bare.MaxOutputTokens != 20000 {
		t.Errorf("@preset/bare = (%d, %d), want the default (%d, 20000)",
			bare.ContextWindow, bare.MaxOutputTokens, DefaultContextWindow)
	}

	// An unreadable preset degrades to the default rather than dropping out of
	// the list or failing it.
	broken, ok := byID["@preset/broken"]
	if !ok {
		t.Fatalf("@preset/broken missing; an individual preset failing must not drop it")
	}
	if broken.ContextWindow != DefaultContextWindow {
		t.Errorf("@preset/broken window = %d, want the default %d", broken.ContextWindow, DefaultContextWindow)
	}

	// Only active presets are usable, so only active presets are offered.
	if _, ok := byID["@preset/archived-one"]; ok {
		t.Error("@preset/archived-one listed, want non-active presets skipped")
	}
}

// TestListPresetsRequestsOneBoundedPage pins that we ask for a page inside
// OpenRouter's documented ceiling (limit max 100) instead of relying on the
// default 50 or asking for more than the endpoint allows.
func TestListPresetsRequestsOneBoundedPage(t *testing.T) {
	srv, listQuery := presetFakeServer(t, http.StatusOK)
	pointBaseURLAt(t, srv.URL)

	if _, err := listModels(context.Background(), "key", nil); err != nil {
		t.Fatalf("listModels: %v", err)
	}
	query := listQuery()
	if query == "" {
		t.Fatalf("/presets requested without a limit, want an explicit bounded page")
	}
	limit, err := strconv.Atoi(strings.TrimPrefix(query, "limit="))
	if err != nil {
		t.Fatalf("/presets query = %q, want a plain limit=<n>", query)
	}
	if limit <= 0 || limit > 100 {
		t.Errorf("/presets limit = %d, want 1..100", limit)
	}
}

// TestListModelsSurvivesPresetsFailure is the soft-fail contract: presets are an
// addition to the model list, so losing them must cost the user nothing but the
// presets.
func TestListModelsSurvivesPresetsFailure(t *testing.T) {
	srv, _ := presetFakeServer(t, http.StatusInternalServerError)
	pointBaseURLAt(t, srv.URL)

	infos, err := listModels(context.Background(), "key", nil)
	if err != nil {
		t.Fatalf("listModels returned an error when only /presets failed: %v", err)
	}
	if len(infos) != 3 {
		t.Fatalf("list = %v, want exactly the three catalog models", ids(infos))
	}
	for _, info := range infos {
		if strings.HasPrefix(info.ID, "@preset/") {
			t.Errorf("preset %q listed despite /presets failing", info.ID)
		}
	}
}

func ids(infos []provider.ModelInfo) []string {
	out := make([]string, 0, len(infos))
	for _, info := range infos {
		out = append(out, info.ID)
	}
	return out
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// lmStudioModels is LM Studio's own model table: the only place it states a
// window. Two models, one loaded well below its architectural ceiling.
const lmStudioModels = `{"object":"list","data":[
  {"id":"qwen3-8b","object":"model","type":"llm","publisher":"qwen","arch":"qwen3",
   "compatibility_type":"gguf","quantization":"Q4_K_M","state":"loaded",
   "max_context_length":131072,"loaded_context_length":131072},
  {"id":"gemma-3-4b","object":"model","type":"llm","publisher":"google","arch":"gemma3",
   "compatibility_type":"gguf","quantization":"Q8_0","state":"not-loaded",
   "max_context_length":32768}
]}`

// lmStudioBareModels is what LM Studio serves on the OpenAI-compatible
// /v1/models: ids and nothing else. No meta, so no window.
const lmStudioBareModels = `{"object":"list","data":[
  {"id":"qwen3-8b","object":"model","owned_by":"organization_owner"},
  {"id":"gemma-3-4b","object":"model","owned_by":"organization_owner"}
]}`

// newLMStudioServer starts a stub answering the way LM Studio really does and
// points the provider at it. It returns the per-path request counts so a test
// can assert which probes were spent.
//
// The catch-all is the point of this fixture: LM Studio answers 200 to every
// path it does not implement, /props included. So the /props probe does not
// fail — it succeeds and decodes to a struct with no n_ctx, which is a very
// different code path from a connection error, and the one that let a
// 131072-token server be advertised as 8192.
func newLMStudioServer(t *testing.T, apiV0Models string) map[string]*atomic.Int64 {
	t.Helper()
	isolateConfig(t)
	counts := map[string]*atomic.Int64{
		"/v1/models":     {},
		"/props":         {},
		"/api/v0/models": {},
		"/health":        {},
	}
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, ok := counts[r.URL.Path]; ok {
			c.Add(1)
		}
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(lmStudioBareModels))
		case "/api/v0/models":
			if apiV0Models != "" {
				_, _ = w.Write([]byte(apiV0Models))
				return
			}
			fallthrough
		default:
			// "Returning 200 anyway" — LM Studio's own words for this branch.
			_, _ = fmt.Fprintf(w, `{"error":"Unexpected endpoint or method. (%s %s)"}`, r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LLAMACPP_HOST", stub.URL)
	return counts
}

// The reported defect: a server advertising 131072 was published as 8192,
// because neither native llama.cpp probe answers on LM Studio and nothing
// consulted the one endpoint that knows.
func TestContextWindowUsesLMStudioModelTable(t *testing.T) {
	newLMStudioServer(t, lmStudioModels)

	window, maxOutput := getContextWindowInfo("qwen3-8b")
	if window != 131072 {
		t.Errorf("context window = %d, want LM Studio's 131072", window)
	}
	if maxOutput != 0 {
		t.Errorf("max output = %d, want 0 (no output cap distinct from the window)", maxOutput)
	}
}

// A model loaded far below its architectural ceiling must be enforced at the
// window it was actually loaded with. Believing max_context_length would admit
// requests LM Studio then silently truncates, since its default overflow policy
// drops the middle of the conversation rather than refusing the request.
func TestContextWindowPrefersLoadedOverMaxContextLength(t *testing.T) {
	const loadedSmall = `{"object":"list","data":[
	  {"id":"qwen3-8b","state":"loaded","max_context_length":131072,"loaded_context_length":8192}
	]}`
	newLMStudioServer(t, loadedSmall)

	if window, _ := getContextWindowInfo("qwen3-8b"); window != 8192 {
		t.Errorf("context window = %d, want the loaded 8192, not the 131072 ceiling", window)
	}
}

// A model LM Studio has downloaded but not loaded states only its ceiling, and
// it will be loaded at LM Studio's own default length, not that ceiling. So it
// gets the conservative fallback: over-stating a window is what LM Studio
// punishes silently, by dropping the middle of the conversation.
func TestContextWindowDoesNotTrustCeilingWhenNotLoaded(t *testing.T) {
	newLMStudioServer(t, lmStudioModels)

	if window, _ := getContextWindowInfo("gemma-3-4b"); window != DefaultContextWindow {
		t.Errorf("context window = %d, want the fallback %d rather than the 32768 ceiling", window, DefaultContextWindow)
	}
}

// LM Studio 0.4's native table states each loaded instance's window, so a
// llama.cpp provider pointed at it reads the same number the LM Studio provider
// would.
func TestContextWindowUsesLMStudioNativeTable(t *testing.T) {
	isolateConfig(t)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"qwen/qwen3.6-35b","object":"model"}]}`))
		case "/api/v1/models":
			_, _ = w.Write([]byte(`{"models":[{"type":"llm","key":"qwen/qwen3.6-35b","max_context_length":262144,
			  "loaded_instances":[{"id":"qwen/qwen3.6-35b","config":{"context_length":256000}}]}]}`))
		default:
			_, _ = fmt.Fprintf(w, `{"error":"Unexpected endpoint or method. (%s %s)"}`, r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LLAMACPP_HOST", stub.URL)

	if window, _ := getContextWindowInfo("qwen/qwen3.6-35b"); window != 256000 {
		t.Errorf("context window = %d, want the loaded 256000", window)
	}
}

func TestListModelsPublishesLMStudioWindows(t *testing.T) {
	counts := newLMStudioServer(t, lmStudioModels)

	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %+v, want 2", models)
	}
	// The loaded model's window is reported; the unloaded one's is not — only
	// its ceiling is — so it gets the fallback and is labelled a guess.
	want := map[string]struct {
		window  int
		assumed bool
	}{"qwen3-8b": {131072, false}, "gemma-3-4b": {DefaultContextWindow, true}}
	for _, model := range models {
		w := want[model.ID]
		if model.ContextWindow != w.window {
			t.Errorf("%s window = %d, want %d", model.ID, model.ContextWindow, w.window)
		}
		if model.FromAPI == w.assumed || model.WindowAssumed != w.assumed {
			t.Errorf("%s FromAPI=%v WindowAssumed=%v, want assumed=%v", model.ID, model.FromAPI, model.WindowAssumed, w.assumed)
		}
	}
	// One probe for the whole list, not one per model.
	if n := counts["/api/v0/models"].Load(); n != 1 {
		t.Errorf("/api/v0/models requested %d times, want exactly 1 shared probe", n)
	}
}

// When even LM Studio's table reveals nothing, the conservative default still
// applies and is still labelled a fallback.
func TestListModelsFallsBackWhenLMStudioTableIsEmpty(t *testing.T) {
	newLMStudioServer(t, "") // /api/v0/models gets the 200 catch-all too

	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	for _, model := range models {
		if model.ContextWindow != DefaultContextWindow {
			t.Errorf("%s window = %d, want DefaultContextWindow %d", model.ID, model.ContextWindow, DefaultContextWindow)
		}
		if model.FromAPI {
			t.Errorf("%s marked FromAPI despite falling back to the default window", model.ID)
		}
	}
}

// The LM Studio probe is a last resort, so a llama-server that answers the
// native endpoints must never pay for it. This pins the ordering rather than
// the outcome: both orders resolve 170240, only one does it in one request.
func TestLMStudioProbeUnusedWhenLlamaServerAnswers(t *testing.T) {
	isolateConfig(t)
	var apiV0 atomic.Int64
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(routerModels))
		case "/props":
			_, _ = w.Write([]byte(routerProps))
		case "/api/v0/models":
			apiV0.Add(1)
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LLAMACPP_HOST", stub.URL)

	if window, _ := getContextWindowInfo("Qwen3.8-27B-IQ4_NL"); window != 170240 {
		t.Fatalf("context window = %d, want the measured 170240", window)
	}
	if n := apiV0.Load(); n != 0 {
		t.Errorf("/api/v0/models probed %d times for a llama-server that already answered", n)
	}
}

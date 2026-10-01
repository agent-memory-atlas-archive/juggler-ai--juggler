//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lmstudio

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// nativeModels is GET /api/v1/models (LM Studio 0.4 and later), after the
// example in LM Studio's REST documentation: a vision model loaded at 4096
// across four parallel slots, a model downloaded but not loaded, an embedding
// model, and — added here — one model loaded twice at different lengths, and a
// small unloaded one whose ceiling is below Juggler's fallback.
const nativeModels = `{"models":[
  {"type":"llm","publisher":"google","key":"google/gemma-4-26b-a4b","display_name":"Gemma 4 26B A4B",
   "architecture":"gemma4","size_bytes":17990911801,"params_string":"26B-A4B",
   "loaded_instances":[{"id":"google/gemma-4-26b-a4b","config":{"context_length":4096,"eval_batch_size":512,"parallel":4,"flash_attention":true}}],
   "max_context_length":262144,"format":"gguf",
   "capabilities":{"vision":true,"trained_for_tool_use":true,"reasoning":{"allowed_options":["off","on"],"default":"on"}}},
  {"type":"llm","publisher":"deepseek","key":"deepseek-r1","display_name":"DeepSeek R1",
   "loaded_instances":[],"max_context_length":131072,"format":"gguf",
   "capabilities":{"vision":false,"trained_for_tool_use":true}},
  {"type":"embedding","publisher":"gaianet","key":"text-embedding-nomic-embed-text-v1.5-embedding",
   "display_name":"Nomic Embed Text v1.5","loaded_instances":[],"max_context_length":2048,"format":"gguf"},
  {"type":"llm","publisher":"qwen","key":"qwen/qwen3.6-35b","display_name":"Qwen3.6 35B",
   "loaded_instances":[
     {"id":"qwen/qwen3.6-35b","config":{"context_length":256000}},
     {"id":"qwen/qwen3.6-35b:2","config":{"context_length":65536}}],
   "max_context_length":262144,"format":"gguf","capabilities":{"vision":false,"trained_for_tool_use":true}},
  {"type":"llm","publisher":"tiny","key":"tiny-1b","display_name":"Tiny 1B",
   "loaded_instances":[],"max_context_length":2048,"format":"gguf"}
]}`

// legacyModels is GET /api/v0/models, the only table LM Studio 0.3 serves. A
// loaded row may or may not state loaded_context_length (LM Studio 0.4.25 does;
// see realLegacyModels), so this has one of each.
const legacyModels = `{"object":"list","data":[
  {"id":"qwen3-8b","object":"model","type":"llm","state":"loaded","max_context_length":131072,"loaded_context_length":32768},
  {"id":"llava-7b","object":"model","type":"vlm","state":"loaded","max_context_length":4096},
  {"id":"nomic-embed","object":"model","type":"embeddings","state":"not-loaded","max_context_length":2048}
]}`

// openAIModels is what LM Studio serves on the OpenAI-compatible /v1/models:
// ids and nothing else.
const openAIModels = `{"object":"list","data":[
  {"id":"qwen3-8b","object":"model","owned_by":"organization_owner"},
  {"id":"mystery","object":"model","owned_by":"organization_owner"}
]}`

// newStub starts a server that answers the given paths with the given bodies
// and every other path the way LM Studio does — 200 with an error body — then
// points the provider at it. The catch-all is the point: a probe of a route LM
// Studio lacks does not fail, it succeeds with nothing useful in it.
func newStub(t *testing.T, routes map[string]string) {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if body, ok := routes[r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		_, _ = fmt.Fprintf(w, `{"error":"Unexpected endpoint or method. (%s %s)"}`, r.Method, r.URL.Path)
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LMSTUDIO_HOST", stub.URL)
}

func listedByID(t *testing.T) map[string]provider.ModelInfo {
	t.Helper()
	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := make(map[string]provider.ModelInfo, len(models))
	for _, m := range models {
		byID[m.ID] = m
	}
	return byID
}

// The window a loaded model is enforced at is the one it was loaded with —
// here 4096, far below the 262144 the architecture allows — and it is the
// server's own statement, not a guess.
func TestListModelsReadsLoadedWindowFromNativeAPI(t *testing.T) {
	newStub(t, map[string]string{"/api/v1/models": nativeModels, "/v1/models": openAIModels})

	gemma, ok := listedByID(t)["google/gemma-4-26b-a4b"]
	if !ok {
		t.Fatal("the loaded model is missing from the listing")
	}
	if gemma.ContextWindow != 4096 {
		t.Errorf("window = %d, want the loaded 4096, not the 262144 ceiling", gemma.ContextWindow)
	}
	if !gemma.FromAPI || gemma.WindowAssumed {
		t.Errorf("FromAPI=%v WindowAssumed=%v, want a reported window", gemma.FromAPI, gemma.WindowAssumed)
	}
	if gemma.DisplayName != "Gemma 4 26B A4B" {
		t.Errorf("display name = %q, want LM Studio's own", gemma.DisplayName)
	}
	if !slices.Contains(gemma.InputModalities, "image") {
		t.Errorf("input modalities = %v, want image for a vision model", gemma.InputModalities)
	}
}

// The reporter's setup, loaded twice: requests may land on either instance, so
// the smaller window is the one every request is sure to fit.
func TestListModelsTakesSmallestLoadedInstance(t *testing.T) {
	newStub(t, map[string]string{"/api/v1/models": nativeModels})

	if got := listedByID(t)["qwen/qwen3.6-35b"].ContextWindow; got != 65536 {
		t.Errorf("window = %d, want the smaller instance's 65536", got)
	}
}

func TestListModelsDropsEmbeddingModels(t *testing.T) {
	newStub(t, map[string]string{"/api/v1/models": nativeModels})

	if _, ok := listedByID(t)["text-embedding-nomic-embed-text-v1.5-embedding"]; ok {
		t.Error("an embedding model was offered as something to chat with")
	}
}

// An unloaded model is loaded on first use with LM Studio's own default
// length, which the API does not state. max_context_length is the
// architecture's ceiling, and believing it would admit requests LM Studio then
// silently truncates, so the window is the conservative fallback, capped at
// that ceiling, and marked as the guess it is.
func TestUnloadedModelWindowIsCappedAndAssumed(t *testing.T) {
	newStub(t, map[string]string{"/api/v1/models": nativeModels})
	byID := listedByID(t)

	for id, want := range map[string]int{"deepseek-r1": DefaultContextWindow, "tiny-1b": 2048} {
		m := byID[id]
		if m.ContextWindow != want {
			t.Errorf("%s window = %d, want %d", id, m.ContextWindow, want)
		}
		if m.FromAPI || !m.WindowAssumed {
			t.Errorf("%s FromAPI=%v WindowAssumed=%v, want an assumed window", id, m.FromAPI, m.WindowAssumed)
		}
	}
}

// LM Studio 0.3 has no /api/v1 — the catch-all answers there — so the older
// table is read instead.
func TestListModelsFallsBackToLegacyTable(t *testing.T) {
	newStub(t, map[string]string{"/api/v0/models": legacyModels, "/v1/models": openAIModels})
	byID := listedByID(t)

	if m := byID["qwen3-8b"]; m.ContextWindow != 32768 || m.WindowAssumed {
		t.Errorf("qwen3-8b = window %d assumed %v, want the loaded 32768, reported", m.ContextWindow, m.WindowAssumed)
	}
	// Loaded, but this table states no loaded length: a guess, capped by the ceiling.
	if m := byID["llava-7b"]; m.ContextWindow != 4096 || !m.WindowAssumed {
		t.Errorf("llava-7b = window %d assumed %v, want an assumed 4096", m.ContextWindow, m.WindowAssumed)
	}
	if !slices.Contains(byID["llava-7b"].InputModalities, "image") {
		t.Error("a vlm row lost its image input")
	}
	if _, ok := byID["nomic-embed"]; ok {
		t.Error("an embedding model was offered as something to chat with")
	}
}

// Neither table readable — an LM Studio newer or older than both, say — still
// leaves its models usable, each on the assumed window.
func TestListModelsFallsBackToOpenAIList(t *testing.T) {
	newStub(t, map[string]string{"/v1/models": openAIModels})
	byID := listedByID(t)

	if len(byID) != 2 {
		t.Fatalf("listed %d models, want both OpenAI-listed ids", len(byID))
	}
	for id, m := range byID {
		if m.ContextWindow != DefaultContextWindow || !m.WindowAssumed {
			t.Errorf("%s = window %d assumed %v, want an assumed %d", id, m.ContextWindow, m.WindowAssumed, DefaultContextWindow)
		}
	}
}

func TestContextWindowForOneModel(t *testing.T) {
	newStub(t, map[string]string{"/api/v1/models": nativeModels})

	if window, maxOutput := getContextWindowInfo("google/gemma-4-26b-a4b"); window != 4096 || maxOutput != 0 {
		t.Errorf("getContextWindowInfo = (%d, %d), want (4096, 0)", window, maxOutput)
	}
	if window, _ := getContextWindowInfo("not-a-model"); window != DefaultContextWindow {
		t.Errorf("unknown model window = %d, want the fallback %d", window, DefaultContextWindow)
	}
}

// Detection must recognise LM Studio, not merely a listening port: LM Studio
// answers 200 to everything, so something else doing the same must not pass
// for it, and neither must a server that 404s.
func TestAutoDetectRecognisesLMStudio(t *testing.T) {
	t.Run("0.4 native table", func(t *testing.T) {
		newStub(t, map[string]string{"/api/v1/models": nativeModels})
		if !autoDetect() {
			t.Error("LM Studio 0.4 not detected")
		}
	})
	t.Run("0.3 legacy table", func(t *testing.T) {
		newStub(t, map[string]string{"/api/v0/models": legacyModels})
		if !autoDetect() {
			t.Error("LM Studio 0.3 not detected")
		}
	})
	t.Run("a server answering 200 to everything", func(t *testing.T) {
		newStub(t, nil)
		if autoDetect() {
			t.Error("detected LM Studio on a server with no model table")
		}
	})
	t.Run("a server that 404s", func(t *testing.T) {
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		stub := httptest.NewServer(http.NotFoundHandler())
		t.Cleanup(stub.Close)
		t.Setenv("LMSTUDIO_HOST", stub.URL)
		if autoDetect() {
			t.Error("detected LM Studio on a server that 404s")
		}
	})
}

func TestModelsReportsUnreachableServer(t *testing.T) {
	if models, err := Models(context.Background(), "http://127.0.0.1:1", nil); err == nil {
		t.Errorf("Models = %v, nil; want an error from an unreachable host", models)
	}
}

func TestRegisterPublishesTheNameUsersLookFor(t *testing.T) {
	Register()
	info, ok := provider.GetProviderInfo("lmstudio")
	if !ok {
		t.Fatal("lmstudio not registered")
	}
	if info.DisplayName != "LM Studio (local)" {
		t.Errorf("display name = %q, want \"LM Studio (local)\"", info.DisplayName)
	}
}

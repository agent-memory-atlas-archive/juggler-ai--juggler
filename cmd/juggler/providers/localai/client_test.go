//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package localai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// The bodies below were captured from localai/localai:latest (v4.10.0) on
// 2026-09-20, serving the gallery's qwen3-0.6b plus four hand-written configs
// that isolate what drives the reported window:
//
//	top-level-big    context_size: 32768 at the top level of the config
//	top-level-small  context_size: 2048 at the top level
//	qwen3-0.6b       the gallery's own YAML, which puts context_size under
//	                 parameters: — where LocalAI ignores it, leaving the default
//	voice-thing      backend: piper, a voice rather than a chat model
//
// The two that matter: a configured model reports the window it was configured
// with, and everything else reports LocalAI's default 8192 whatever its YAML
// claims.
const modelList = `{"object":"list","data":[
  {"id":"qwen3-0.6b","object":"model"},
  {"id":"top-level-big","object":"model"},
  {"id":"top-level-small","object":"model"},
  {"id":"voice-thing","object":"model"}
]}`

const capabilities = `{"object":"list","data":[
  {"id":"top-level-big","object":"model","capabilities":["chat"],"input_modalities":["text"],"output_modalities":["text"],"context_size":32768},
  {"id":"top-level-small","object":"model","capabilities":["chat"],"input_modalities":["text"],"output_modalities":["text"],"context_size":2048},
  {"id":"voice-thing","object":"model","capabilities":["tts"],"input_modalities":["text"],"output_modalities":["audio"],"context_size":4096},
  {"id":"qwen3-0.6b","object":"model","capabilities":["chat"],"input_modalities":["text"],"output_modalities":["text"],"context_size":8192}
]}`

// isolateConfig points the credentials store at a throwaway dir so tests never
// pick up the developer's real localai_host.
func isolateConfig(t *testing.T) {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
}

// newLocalAI starts a stub LocalAI serving the given bodies and points the
// provider at it. An empty capabilities body stands for a server too old to
// have the route, which answers 404. The returned counter records how often the
// capabilities route was asked for.
func newLocalAI(t *testing.T, models, caps string) *int {
	t.Helper()
	isolateConfig(t)
	probes := 0
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			if models == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(models))
		case "/v1/models/capabilities":
			probes++
			if caps == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(caps))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LOCALAI_HOST", stub.URL)
	return &probes
}

func listed(t *testing.T) map[string]provider.ModelInfo {
	t.Helper()
	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := make(map[string]provider.ModelInfo, len(models))
	for _, model := range models {
		byID[model.ID] = model
	}
	return byID
}

// The issue this provider exists for: every model assumed to be 8k, including
// the one whose config says 32768.
func TestListedWindowsComeFromCapabilities(t *testing.T) {
	newLocalAI(t, modelList, capabilities)

	byID := listed(t)
	for id, want := range map[string]int{"top-level-big": 32768, "top-level-small": 2048, "qwen3-0.6b": 8192} {
		model, ok := byID[id]
		if !ok {
			t.Errorf("%s missing from the listing", id)
			continue
		}
		if model.ContextWindow != want {
			t.Errorf("%s ContextWindow = %d, want the server's own %d", id, model.ContextWindow, want)
		}
		if !model.FromAPI {
			t.Errorf("%s FromAPI = false, but its window was read off the server", id)
		}
	}
}

// LocalAI's model list is everything it hosts, voices and image models
// included. Publishing those puts models in the picker that fail on first use.
func TestVoiceModelsAreNotListedAsChatModels(t *testing.T) {
	newLocalAI(t, modelList, capabilities)

	if _, listed := listed(t)["voice-thing"]; listed {
		t.Error("voice-thing was published as a chat model, but the server says its only capability is tts")
	}
}

// An embeddings model is still a chat model on LocalAI — the same backend
// serves both — so it stays in the list.
func TestEmbeddingModelsStayListed(t *testing.T) {
	const withEmbeddings = `{"object":"list","data":[{"id":"embed-thing","object":"model"}]}`
	const embedCaps = `{"object":"list","data":[
	  {"id":"embed-thing","object":"model","capabilities":["chat","embeddings"],"context_size":8192}
	]}`
	newLocalAI(t, withEmbeddings, embedCaps)

	if _, ok := listed(t)["embed-thing"]; !ok {
		t.Error("embed-thing was dropped, but it serves chat as well as embeddings")
	}
}

// One request for the whole listing, however many models the server hosts.
func TestCapabilitiesProbedOncePerListing(t *testing.T) {
	probes := newLocalAI(t, modelList, capabilities)

	listed(t)

	if *probes != 1 {
		t.Errorf("capabilities probed %d times for a four-model listing, want 1", *probes)
	}
}

// A LocalAI predating the capabilities route answers 404. Its models are still
// usable — they just carry a window nobody promised, and have to say so.
func TestOlderServerFallsBackToDefaultWindow(t *testing.T) {
	newLocalAI(t, modelList, "")

	byID := listed(t)
	if len(byID) != 4 {
		t.Fatalf("listed %d models, want all 4 — an unanswered probe is not a reason to hide a model", len(byID))
	}
	model := byID["top-level-big"]
	if model.ContextWindow != DefaultContextWindow {
		t.Errorf("top-level-big ContextWindow = %d, want DefaultContextWindow %d", model.ContextWindow, DefaultContextWindow)
	}
	if model.FromAPI {
		t.Error("top-level-big FromAPI = true, but the server described no window — the number is an assumption")
	}
}

// The single-model lookup the registry uses for a model chosen from settings,
// rather than the whole listing.
func TestContextWindowForOneModel(t *testing.T) {
	newLocalAI(t, modelList, capabilities)

	window, maxOutput := getContextWindowInfo("top-level-small")
	if window != 2048 {
		t.Errorf("context window = %d, want the server's own 2048", window)
	}
	if maxOutput != 0 {
		t.Errorf("max output = %d, want 0 (LocalAI has no output cap distinct from the window)", maxOutput)
	}
}

func TestContextWindowFallsBackWhenServerUnreachable(t *testing.T) {
	isolateConfig(t)
	// A port nothing is listening on: the probe fails outright.
	t.Setenv("LOCALAI_HOST", "http://127.0.0.1:1")

	if window, _ := getContextWindowInfo("anything"); window != DefaultContextWindow {
		t.Errorf("context window = %d, want DefaultContextWindow %d", window, DefaultContextWindow)
	}
}

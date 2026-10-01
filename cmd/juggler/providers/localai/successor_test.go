//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package localai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/lmstudio"
)

// lmStudioModels is LM Studio 0.4.25's /api/v1/models, trimmed to its one
// loaded model; the row is as the server sent it. The LM Studio provider's own
// tests carry the rest of the capture.
const lmStudioModels = `{"models":[
  {"type":"llm","publisher":"unsloth","key":"qwen3.6-35b-a3b-mtp","display_name":"Qwen3.6 35B A3B UD","architecture":"qwen35moe","quantization":{"name":"Q3_K_M","bits_per_weight":3},"size_bytes":18890707872,"params_string":"35B-A3B","loaded_instances":[{"id":"qwen3.6-35b-a3b-mtp","config":{"context_length":262144,"eval_batch_size":2048,"physical_batch_size":512,"parallel":4,"flash_attention":true,"context_checkpoints":32,"reasoning_budget_message":"","speculative_draft_mtp":true,"speculative_draft_simple":false,"speculative_draft_model":"","speculative_draft_max_tokens":3,"speculative_draft_min_tokens":0,"speculative_draft_min_continue_probability":0,"num_experts":8,"offload_kv_cache_to_gpu":true}}],"max_context_length":262144,"format":"gguf","capabilities":{"vision":true,"trained_for_tool_use":true,"reasoning":{"allowed_options":["off","on"],"default":"on"}},"description":null}
]}`

// fastFlowLMModels is FastFlowLM's /api/v1/models, trimmed to three rows: an
// OpenAI-style list on the path LM Studio's own table lives on.
const fastFlowLMModels = `{"data":[{"created":1790797736,"id":"gemma3:4b","object":"model","owned_by":"FastFlowLM"},{"created":1790797736,"id":"gpt-oss:20b","object":"model","owned_by":"FastFlowLM"},{"created":1790797736,"id":"qwen3.6-moe:35b-a3b","object":"model","owned_by":"FastFlowLM"}],"object":"list"}`

// pointAt starts a stub answering the given paths with the given bodies and
// every other path with fallback's status, and points LocalAI's host at it.
func pointAt(t *testing.T, routes map[string]string, fallback int) string {
	t.Helper()
	isolateConfig(t)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if body, ok := routes[r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		w.WriteHeader(fallback)
		_, _ = w.Write([]byte(`{"error":"Unexpected endpoint or method."}`))
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LOCALAI_HOST", stub.URL)
	t.Setenv("LMSTUDIO_HOST", "")
	return stub.URL
}

// The upgrade case: LocalAI's probe once accepted any 200, so a user who ran LM
// Studio has LocalAI switched on against it, every window assumed. LocalAI has
// to say what the server really is, and the switch has to keep talking to it.
func TestSuccessorNamesLMStudioForAnLMStudioServer(t *testing.T) {
	host := pointAt(t, map[string]string{
		"/api/v1/models": lmStudioModels,
		"/v1/models":     `{"object":"list","data":[{"id":"qwen3.6-35b-a3b-mtp","object":"model"}]}`,
	}, http.StatusOK)

	next := successor(context.Background())
	if next == nil {
		t.Fatal("successor = nil for a server serving LM Studio's model table")
	}
	if next.Provider != "lmstudio" {
		t.Errorf("successor provider = %q, want lmstudio", next.Provider)
	}
	if next.Reason == "" {
		t.Error("successor gives the user no reason")
	}
	if err := next.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if got := store.GetRawKey(lmstudio.HostCredKey); got != host {
		t.Errorf("%s = %q after Adopt, want LocalAI's host %q", lmstudio.HostCredKey, got, host)
	}
}

// The host LocalAI already shares with LM Studio's own default is not written:
// LM Studio finds that server unconfigured.
func TestSuccessorLeavesLMStudioDefaultHostUnwritten(t *testing.T) {
	isolateConfig(t)
	t.Setenv("LOCALAI_HOST", lmstudio.DefaultHost)
	t.Setenv("LMSTUDIO_HOST", "")
	if err := adoptHost(lmstudio.DefaultHost); err != nil {
		t.Fatalf("adoptHost: %v", err)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if got := store.GetRawKey(lmstudio.HostCredKey); got != "" {
		t.Errorf("%s = %q, want it left unset for LM Studio's default host", lmstudio.HostCredKey, got)
	}
}

func TestSuccessorIsNilForOtherServers(t *testing.T) {
	t.Run("LocalAI itself", func(t *testing.T) {
		pointAt(t, map[string]string{"/.well-known/localai.json": discoveryDocument, "/v1/models": modelList}, http.StatusNotFound)
		if next := successor(context.Background()); next != nil {
			t.Errorf("successor = %+v for LocalAI's own server", next)
		}
	})
	t.Run("FastFlowLM", func(t *testing.T) {
		pointAt(t, map[string]string{"/api/v1/models": fastFlowLMModels, "/v1/models": fastFlowLMModels}, http.StatusNotFound)
		if next := successor(context.Background()); next != nil {
			t.Errorf("successor = %+v for a FastFlowLM server", next)
		}
	})
	t.Run("nothing listening", func(t *testing.T) {
		isolateConfig(t)
		t.Setenv("LOCALAI_HOST", "http://127.0.0.1:1")
		if next := successor(context.Background()); next != nil {
			t.Errorf("successor = %+v with no server", next)
		}
	})
}

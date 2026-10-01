//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lmstudio

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// Real responses from LM Studio 0.4.25 serving one model loaded at 262144 and
// three not loaded, one of them an embedding model, trimmed to those rows:
// /api/v1/models (realNativeModels) and /api/v0/models (realLegacyModels).
// Each row is as the server sent it.
const realNativeModels = `{"models":[
  {"type":"llm","publisher":"qwen","key":"qwen/qwen3-coder-next","display_name":"Qwen3 Coder Next","architecture":"qwen3next","quantization":{"name":"Q4_K_M","bits_per_weight":4},"size_bytes":48487210160,"params_string":"80B","loaded_instances":[],"max_context_length":262144,"format":"gguf","capabilities":{"vision":false,"trained_for_tool_use":true},"description":null,"variants":["qwen/qwen3-coder-next@q4_k_m"],"selected_variant":"qwen/qwen3-coder-next@q4_k_m"},
  {"type":"llm","publisher":"unsloth","key":"qwen3.6-35b-a3b-mtp","display_name":"Qwen3.6 35B A3B UD","architecture":"qwen35moe","quantization":{"name":"Q3_K_M","bits_per_weight":3},"size_bytes":18890707872,"params_string":"35B-A3B","loaded_instances":[{"id":"qwen3.6-35b-a3b-mtp","config":{"context_length":262144,"eval_batch_size":2048,"physical_batch_size":512,"parallel":4,"flash_attention":true,"context_checkpoints":32,"reasoning_budget_message":"","speculative_draft_mtp":true,"speculative_draft_simple":false,"speculative_draft_model":"","speculative_draft_max_tokens":3,"speculative_draft_min_tokens":0,"speculative_draft_min_continue_probability":0,"num_experts":8,"offload_kv_cache_to_gpu":true}}],"max_context_length":262144,"format":"gguf","capabilities":{"vision":true,"trained_for_tool_use":true,"reasoning":{"allowed_options":["off","on"],"default":"on"}},"description":null},
  {"type":"embedding","publisher":"nomic-ai","key":"text-embedding-nomic-embed-text-v1.5","display_name":"Nomic Embed Text v1.5","quantization":{"name":"Q4_K_M","bits_per_weight":4},"size_bytes":84106624,"params_string":null,"loaded_instances":[],"max_context_length":2048,"format":"gguf"},
  {"type":"llm","publisher":"QuantFactory","key":"meta-llama-3-8b-instruct","display_name":"Meta Llama 3 8B Instruct","architecture":"llama","quantization":{"name":"Q4_K_S","bits_per_weight":4},"size_bytes":4692668992,"params_string":"8.0B","loaded_instances":[],"max_context_length":8192,"format":"gguf","capabilities":{"vision":false,"trained_for_tool_use":false},"description":null}
]}`

const realLegacyModels = `{"data":[
  {"id":"qwen3.6-35b-a3b-mtp","object":"model","type":"vlm","publisher":"unsloth","arch":"qwen35moe","compatibility_type":"gguf","quantization":"Q3_K_M","state":"loaded","max_context_length":262144,"loaded_context_length":262144,"capabilities":["tool_use"]},
  {"id":"qwen/qwen3-coder-next","object":"model","type":"llm","publisher":"qwen","arch":"qwen3next","compatibility_type":"gguf","quantization":"Q4_K_M","state":"not-loaded","max_context_length":262144,"capabilities":["tool_use"]},
  {"id":"text-embedding-nomic-embed-text-v1.5","object":"model","type":"embeddings","publisher":"nomic-ai","arch":"nomic-bert","compatibility_type":"gguf","quantization":"Q4_K_M","state":"not-loaded","max_context_length":2048},
  {"id":"meta-llama-3-8b-instruct","object":"model","type":"llm","publisher":"QuantFactory","arch":"llama","compatibility_type":"gguf","quantization":"Q4_K_S","state":"not-loaded","max_context_length":8192}
],"object":"list"}`

// FastFlowLM's answers on the same two paths, the list trimmed to three rows:
// an OpenAI-style list on /api/v1/models, and a 404 on /api/v0/models.
const (
	fastFlowLMModels   = `{"data":[{"created":1790797736,"id":"gemma3:4b","object":"model","owned_by":"FastFlowLM"},{"created":1790797736,"id":"gpt-oss:20b","object":"model","owned_by":"FastFlowLM"},{"created":1790797736,"id":"qwen3.6-moe:35b-a3b","object":"model","owned_by":"FastFlowLM"}],"object":"list"}`
	fastFlowLMNotFound = `{"error":"Not Found"}`
)

// The loaded model is enforced at the length LM Studio loaded it with, stated
// by the server; the models not loaded fall back to the assumed window, capped
// at their own ceiling.
func TestRealLMStudioNativeTable(t *testing.T) {
	newStub(t, map[string]string{"/api/v1/models": realNativeModels})
	byID := listedByID(t)

	assertWindow(t, byID, "qwen3.6-35b-a3b-mtp", 262144, false)
	assertWindow(t, byID, "qwen/qwen3-coder-next", DefaultContextWindow, true)
	assertWindow(t, byID, "meta-llama-3-8b-instruct", 8192, true)
	if byID["qwen3.6-35b-a3b-mtp"].DisplayName != "Qwen3.6 35B A3B UD" {
		t.Errorf("display name = %q, want LM Studio's own", byID["qwen3.6-35b-a3b-mtp"].DisplayName)
	}
	if _, ok := byID["text-embedding-nomic-embed-text-v1.5"]; ok {
		t.Error("an embedding model was offered as something to chat with")
	}
}

// LM Studio 0.4.25's v0 table states loaded_context_length on a loaded row, so
// a server without the v1 table still yields the real window.
func TestRealLMStudioLegacyTable(t *testing.T) {
	newStub(t, map[string]string{"/api/v0/models": realLegacyModels})
	byID := listedByID(t)

	assertWindow(t, byID, "qwen3.6-35b-a3b-mtp", 262144, false)
	assertWindow(t, byID, "qwen/qwen3-coder-next", DefaultContextWindow, true)
	if _, ok := byID["text-embedding-nomic-embed-text-v1.5"]; ok {
		t.Error("an embedding model was offered as something to chat with")
	}
}

func TestRealLMStudioIsDetected(t *testing.T) {
	for _, tc := range []struct{ name, path, body string }{
		{"0.4 native table", "/api/v1/models", realNativeModels},
		{"0.4 legacy table", "/api/v0/models", realLegacyModels},
	} {
		t.Run(tc.name, func(t *testing.T) {
			newStub(t, map[string]string{tc.path: tc.body})
			if !autoDetect() {
				t.Error("LM Studio not detected from its own model table")
			}
			if !IsServer(context.Background(), server.Host()) {
				t.Error("IsServer = false for LM Studio's own model table")
			}
		})
	}
}

// FastFlowLM serves an OpenAI-style list on /api/v1/models — the path LM
// Studio's native table lives on — and 404s on /api/v0/models. A list of ids
// is not LM Studio's table, so it is not taken for one.
func TestFastFlowLMIsNotLMStudio(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	list := fastFlowLMModels
	notFound := fastFlowLMNotFound
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/models", "/v1/models":
			_, _ = w.Write([]byte(list))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(notFound))
		}
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LMSTUDIO_HOST", stub.URL)

	if autoDetect() {
		t.Error("FastFlowLM detected as LM Studio")
	}
	if IsServer(context.Background(), stub.URL) {
		t.Error("IsServer = true for FastFlowLM")
	}
	if models, err := Models(context.Background(), stub.URL, nil); err == nil {
		t.Errorf("Models = %v, nil; want an error from a server with no LM Studio table", models)
	}
}

func assertWindow(t *testing.T, byID map[string]provider.ModelInfo, id string, wantWindow int, wantAssumed bool) {
	t.Helper()
	m, ok := byID[id]
	if !ok {
		t.Errorf("%s is missing from the listing", id)
		return
	}
	if m.ContextWindow != wantWindow || m.WindowAssumed != wantAssumed || m.FromAPI == wantAssumed {
		t.Errorf("%s = window %d assumed %v fromAPI %v, want window %d assumed %v",
			id, m.ContextWindow, m.WindowAssumed, m.FromAPI, wantWindow, wantAssumed)
	}
}

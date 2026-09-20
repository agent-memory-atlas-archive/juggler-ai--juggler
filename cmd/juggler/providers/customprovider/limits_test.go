//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestCustomProviderDiscoversEndpointLimits covers the case a compiled-in
// catalog can never help with: an endpoint nobody but this user has configured.
//
// A custom endpoint is whatever the user pointed it at — vLLM, llama.cpp, LM
// Studio, LiteLLM, a company gateway — and there is no vendor documentation to
// consult about it. But most of those servers state their own limits on the
// model list, and that number is authoritative in a way no table could be: it
// is the machine that will serve the request. The flat default is what remains
// for a server that says nothing, and it is a guess, which is why FromAPI has
// to distinguish the two.
func TestCustomProviderDiscoversEndpointLimits(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[
			{"id":"served-by-vllm","object":"model","owned_by":"vllm","max_model_len":131072},
			{"id":"silent-gateway-model","object":"model","owned_by":"someone"}
		]}`))
	}))
	defer srv.Close()

	if _, err := execute(t, "save", endpointParams("lab", "Lab box", srv.URL)); err != nil {
		t.Fatalf("save lab: %v", err)
	}

	built, err := provider.InitializeProvider(RegisteredName("lab"), provider.Config{Model: "served-by-vllm"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := built.ListModelsWithInfo(ctx)
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}

	byID := map[string]provider.ModelInfo{}
	for _, info := range infos {
		byID[info.ID] = info
	}

	served, ok := byID["served-by-vllm"]
	if !ok {
		t.Fatal("served-by-vllm missing from the listing")
	}
	if served.ContextWindow != 131072 {
		t.Errorf("served-by-vllm ContextWindow = %d, want the endpoint's own 131072 rather than the %d assumption",
			served.ContextWindow, defaultContextWindow)
	}
	if !served.FromAPI {
		t.Error("served-by-vllm FromAPI = false, but its window was read off the endpoint")
	}

	silent, ok := byID["silent-gateway-model"]
	if !ok {
		t.Fatal("silent-gateway-model missing from the listing")
	}
	if silent.ContextWindow != defaultContextWindow {
		t.Errorf("silent-gateway-model ContextWindow = %d, want the %d assumption", silent.ContextWindow, defaultContextWindow)
	}
	if silent.FromAPI {
		t.Error("silent-gateway-model FromAPI = true, but nothing was reported about it — the number is an assumption")
	}
}

// A LocalAI reached as a custom endpoint, which is how a user finds it before
// there is a provider named after it. Its /v1/models rows are bare ids, so the
// flat 128000 default used to stand for every model on the box — four times
// what a default LocalAI will serve, and sixteen times what a model configured
// down to 2048 will. The capabilities route is the one place the real number is
// published, and reading it is what turns the guess into the server's own
// answer.
func TestCustomProviderReadsLocalAICapabilities(t *testing.T) {
	userpathstest.Isolate(t)
	unregisterAllAtEnd(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"object":"list","data":[
				{"id":"top-level-big","object":"model"},
				{"id":"top-level-small","object":"model"}
			]}`))
		case "/v1/models/capabilities":
			_, _ = w.Write([]byte(`{"object":"list","data":[
				{"id":"top-level-big","object":"model","capabilities":["chat"],"context_size":32768},
				{"id":"top-level-small","object":"model","capabilities":["chat"],"context_size":2048}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	if _, err := execute(t, "save", endpointParams("localai", "LocalAI box", srv.URL+"/v1")); err != nil {
		t.Fatalf("save localai: %v", err)
	}

	built, err := provider.InitializeProvider(RegisteredName("localai"), provider.Config{Model: "top-level-big"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := built.ListModelsWithInfo(ctx)
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}

	want := map[string]int{"top-level-big": 32768, "top-level-small": 2048}
	for _, info := range infos {
		if want[info.ID] != info.ContextWindow {
			t.Errorf("%s ContextWindow = %d, want the server's own %d rather than the %d assumption",
				info.ID, info.ContextWindow, want[info.ID], defaultContextWindow)
		}
		if !info.FromAPI {
			t.Errorf("%s FromAPI = false, but its window came off the endpoint", info.ID)
		}
	}
}

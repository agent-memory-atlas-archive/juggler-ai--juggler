//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// isolateConfig points the credentials store at a throwaway dir so tests never
// pick up the developer's real llamacpp_host.
func isolateConfig(t *testing.T) {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
}

// routerModels mirrors what a router-mode llama-server serves: one loaded model
// carrying a measured meta block, the rest configured but unloaded and
// described only by the arguments they will be launched with.
const routerModels = `{"object":"list","data":[
  {"id":"Qwen3.8-27B-IQ4_NL","aliases":["qwen"],"object":"model","owned_by":"llamacpp",
   "status":{"value":"loaded","args":["llama-server","--alias","Qwen3.8-27B-IQ4_NL","--ctx-size","170000","--flash-attn","on"]},
   "meta":{"n_ctx":170240,"n_ctx_train":262144,"n_vocab":248320}},
  {"id":"Gemma-4-31B-it-IQ4_NL","aliases":[],"object":"model","owned_by":"llamacpp",
   "status":{"value":"unloaded","args":["llama-server","--alias","Gemma-4-31B-it-IQ4_NL","--ctx-size","70000"]}},
  {"id":"Muse-Glimmer-30B","aliases":[],"object":"model","owned_by":"llamacpp",
   "status":{"value":"unloaded","args":["llama-server","--alias","Muse-Glimmer-30B"]}}
]}`

// routerProps is the placeholder a router answers /props with: it hosts no
// model of its own, so it reports n_ctx 0.
const routerProps = `{"role":"router","model_path":"none","default_generation_settings":{"params":{},"n_ctx":0}}`

// newLlamaServer starts a stub llama-server serving the given bodies and points
// the provider at it.
func newLlamaServer(t *testing.T, models, props string) *httptest.Server {
	t.Helper()
	isolateConfig(t)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			if models == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(models))
		case "/props":
			if props == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(props))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(stub.Close)
	t.Setenv("LLAMACPP_HOST", stub.URL)
	return stub
}

// A router reports n_ctx 0 from /props, so the window has to come from the
// model's own entry — this is the regression that pinned every model on a
// multi-model server to DefaultContextWindow.
func TestContextWindowUsesLoadedModelEntryWhenPropsIsRouter(t *testing.T) {
	newLlamaServer(t, routerModels, routerProps)

	window, maxOutput := getContextWindowInfo("Qwen3.8-27B-IQ4_NL")
	if window != 170240 {
		t.Errorf("context window = %d, want the loaded model's measured 170240", window)
	}
	if maxOutput != 0 {
		t.Errorf("max output = %d, want 0 (llama.cpp has no separate output cap)", maxOutput)
	}
}

func TestContextWindowResolvesModelByAlias(t *testing.T) {
	newLlamaServer(t, routerModels, routerProps)

	if window, _ := getContextWindowInfo("qwen"); window != 170240 {
		t.Errorf("context window via alias = %d, want 170240", window)
	}
}

// An unloaded model has no meta block, so its configured --ctx-size stands in
// rather than the conservative default.
func TestContextWindowFallsBackToConfiguredCtxSize(t *testing.T) {
	newLlamaServer(t, routerModels, routerProps)

	if window, _ := getContextWindowInfo("Gemma-4-31B-it-IQ4_NL"); window != 70000 {
		t.Errorf("context window = %d, want the configured 70000", window)
	}
}

// A single-model llama-server old enough to omit meta from /v1/models still
// describes its window on /props.
func TestContextWindowFallsBackToProps(t *testing.T) {
	const models = `{"object":"list","data":[{"id":"solo","object":"model","owned_by":"llamacpp"}]}`
	newLlamaServer(t, models, `{"default_generation_settings":{"n_ctx":32768}}`)

	if window, _ := getContextWindowInfo("solo"); window != 32768 {
		t.Errorf("context window = %d, want the /props 32768", window)
	}
}

func TestContextWindowFallsBackToDefaultWhenServerUnreachable(t *testing.T) {
	isolateConfig(t)
	// A port nothing is listening on: both probes fail.
	t.Setenv("LLAMACPP_HOST", "http://127.0.0.1:1")

	if window, _ := getContextWindowInfo("anything"); window != DefaultContextWindow {
		t.Errorf("context window = %d, want DefaultContextWindow %d", window, DefaultContextWindow)
	}
}

// A model the server doesn't list gets the conservative default, not a
// neighbour's window.
func TestContextWindowFallsBackForUnknownModel(t *testing.T) {
	newLlamaServer(t, routerModels, routerProps)

	if window, _ := getContextWindowInfo("not-configured"); window != DefaultContextWindow {
		t.Errorf("context window = %d, want DefaultContextWindow %d", window, DefaultContextWindow)
	}
}

func TestListModelsPublishesPerModelWindows(t *testing.T) {
	newLlamaServer(t, routerModels, routerProps)

	models, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if len(models) != 3 {
		t.Fatalf("models = %+v, want 3", models)
	}

	byID := make(map[string]provider.ModelInfo, len(models))
	for _, m := range models {
		byID[m.ID] = m
	}

	for id, want := range map[string]int{
		"Qwen3.8-27B-IQ4_NL":    170240, // measured
		"Gemma-4-31B-it-IQ4_NL": 70000,  // configured
	} {
		model := byID[id]
		if model.ContextWindow != want {
			t.Errorf("%s window = %d, want %d", id, model.ContextWindow, want)
		}
		if !model.FromAPI {
			t.Errorf("%s not marked FromAPI despite a server-reported window", id)
		}
		if model.WindowAssumed {
			t.Errorf("%s marked WindowAssumed despite a server-reported window", id)
		}
	}

	// No window anywhere for this one: the router's /props says 0, so the
	// fallback applies and is labelled as a fallback.
	unsized := byID["Muse-Glimmer-30B"]
	if unsized.ContextWindow != DefaultContextWindow {
		t.Errorf("unsized window = %d, want DefaultContextWindow %d", unsized.ContextWindow, DefaultContextWindow)
	}
	if unsized.FromAPI {
		t.Error("unsized model marked FromAPI despite falling back to the default window")
	}
	if !unsized.WindowAssumed {
		t.Error("unsized model not marked WindowAssumed, so nothing will tell the user its window is a guess")
	}
}

// A single-model server's /props window covers the models that declare none of
// their own.
func TestListModelsFallsBackToPropsWindow(t *testing.T) {
	const models = `{"object":"list","data":[{"id":"solo","object":"model","owned_by":"llamacpp"}]}`
	newLlamaServer(t, models, `{"default_generation_settings":{"n_ctx":4096}}`)

	list, err := listModels(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if len(list) != 1 || list[0].ContextWindow != 4096 || !list[0].FromAPI {
		t.Fatalf("models = %+v, want one API-sourced 4096 window", list)
	}
}

func TestListModelsReportsUnreachableServer(t *testing.T) {
	isolateConfig(t)
	t.Setenv("LLAMACPP_HOST", "http://127.0.0.1:1")

	if _, err := listModels(context.Background(), "", nil); err == nil {
		t.Fatal("listModels succeeded against an unreachable server, want an error")
	}
}

func TestListModelsSendsHeaders(t *testing.T) {
	isolateConfig(t)
	var got string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"id":"solo","meta":{"n_ctx":8000}}]}`))
	}))
	defer stub.Close()
	t.Setenv("LLAMACPP_HOST", stub.URL)

	if _, err := listModels(context.Background(), "", map[string]string{"Authorization": "Bearer token"}); err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if got != "Bearer token" {
		t.Errorf("Authorization header = %q, want it forwarded to the probe", got)
	}
}

func TestCtxSizeFromArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want int
	}{
		{"separate value", []string{"--ctx-size", "65536"}, 65536},
		{"joined value", []string{"--ctx-size=65536"}, 65536},
		{"short flag", []string{"-c", "4096"}, 4096},
		{"split across slots", []string{"--ctx-size", "65536", "--parallel", "4"}, 16384},
		{"single slot", []string{"--ctx-size", "65536", "--parallel", "1"}, 65536},
		{"joined parallel", []string{"-c", "8192", "-np=2"}, 4096},
		{"absent", []string{"--flash-attn", "on"}, 0},
		{"missing value", []string{"--flash-attn", "on", "--ctx-size"}, 0},
		{"non-numeric", []string{"--ctx-size", "big"}, 0},
		{"zero means from-model", []string{"--ctx-size", "0"}, 0},
		{"no args", nil, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ctxSizeFromArgs(test.args); got != test.want {
				t.Errorf("ctxSizeFromArgs(%v) = %d, want %d", test.args, got, test.want)
			}
		})
	}
}

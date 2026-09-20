//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// bareModelList is what LocalAI answers GET /v1/models with: ids and nothing
// else. Every window key DiscoverLimits knows is absent, which is why such a
// server used to leave the caller's assumed default standing.
const bareModelList = `{"object":"list","data":[
  {"id":"top-level-big","object":"model"},
  {"id":"bare-model","object":"model"},
  {"id":"voice-thing","object":"model"}
]}`

// capabilitiesBody is a real GET /v1/models/capabilities response, captured
// from LocalAI v4.10.0 on 2026-09-20. context_size is the window the backend
// will actually serve: 32768 for the model whose config sets it, 8192 for the
// one that leaves LocalAI's own default standing.
const capabilitiesBody = `{"object":"list","data":[
  {"id":"top-level-big","object":"model","capabilities":["chat"],"input_modalities":["text"],"output_modalities":["text"],"context_size":32768},
  {"id":"bare-model","object":"model","capabilities":["chat"],"input_modalities":["text"],"output_modalities":["text"],"context_size":8192},
  {"id":"voice-thing","object":"model","capabilities":["tts"],"input_modalities":["text"],"output_modalities":["audio"],"context_size":4096}
]}`

// capabilitiesWithoutWindow drops context_size from one row. No live LocalAI
// produced this — its default fills the field for every backend tried, TTS
// included — but the field is `omitempty` on an int, so an endpoint that knows
// no window for a model sends the key absent rather than zero. Absent must
// leave the caller's own number alone; a zero read as a limit would advertise a
// 0-token window to the budgeter.
const capabilitiesWithoutWindow = `{"object":"list","data":[
  {"id":"top-level-big","object":"model","capabilities":["chat"]}
]}`

// capabilitiesServer serves a model list and a capabilities body, counting how
// many times the capabilities endpoint is asked for. The count is the assertion
// for the two cases where the probe must not fire at all.
func capabilitiesServer(t *testing.T, models, capabilities string) (*httptest.Server, *int) {
	t.Helper()
	probes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/models":
			_, _ = io.WriteString(w, models)
		case "/models/capabilities":
			probes++
			if capabilities == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = io.WriteString(w, capabilities)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &probes
}

// listModelsByID builds a descriptor against the stub, lists its models, and
// returns them keyed by id. catalogWindow stands in for whatever a provider
// would otherwise assume about a model nobody described.
func listModelsByID(t *testing.T, d Descriptor, endpoint string, catalogWindow int) map[string]provider.ModelInfo {
	t.Helper()
	d.Name = "openaibase-capabilities-" + t.Name()
	d.BaseURL = endpoint
	if d.ContextWindowFn == nil {
		d.ContextWindowFn = func(string) (int, int) { return catalogWindow, 0 }
	}
	Register(d)

	p, err := provider.InitializeProvider(d.Name, provider.Config{APIKey: "test", Model: "bare-model"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	infos, err := p.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	byID := make(map[string]provider.ModelInfo, len(infos))
	for _, info := range infos {
		byID[info.ID] = info
	}
	return byID
}

// The case the whole endpoint exists for: rows that describe no limit at all,
// and a server that will happily say what it is serving if asked one more
// question.
func TestCapabilitiesProbeFillsWindowsBareRowsOmit(t *testing.T) {
	srv, probes := capabilitiesServer(t, bareModelList, capabilitiesBody)

	byID := listModelsByID(t, Descriptor{}, srv.URL, 128000)

	big, ok := byID["top-level-big"]
	if !ok {
		t.Fatal("top-level-big missing from the listing")
	}
	if big.ContextWindow != 32768 {
		t.Errorf("top-level-big ContextWindow = %d, want the server's own 32768 rather than the 128000 assumption", big.ContextWindow)
	}
	if !big.FromAPI {
		t.Error("top-level-big FromAPI = false, but its window was read off the endpoint")
	}
	if *probes != 1 {
		t.Errorf("capabilities probed %d times, want exactly 1 for the whole listing", *probes)
	}
}

// A row that omits context_size is a server saying nothing, not a server saying
// zero: the caller's own number has to survive.
func TestCapabilitiesProbeLeavesCatalogValueWhenWindowAbsent(t *testing.T) {
	srv, _ := capabilitiesServer(t, bareModelList, capabilitiesWithoutWindow)

	byID := listModelsByID(t, Descriptor{}, srv.URL, 128000)

	big := byID["top-level-big"]
	if big.ContextWindow != 128000 {
		t.Errorf("top-level-big ContextWindow = %d, want the caller's 128000 left standing", big.ContextWindow)
	}
	if big.FromAPI {
		t.Error("top-level-big FromAPI = true, but the row carried no window — the number is still an assumption")
	}
}

// A listing that already described every model needs nothing further, and the
// vendors that will never implement this endpoint are the common case: not
// asking is what keeps the probe from costing them a request per listing.
func TestCapabilitiesProbeSkippedWhenRowsCarryWindows(t *testing.T) {
	const describedModelList = `{"object":"list","data":[
	  {"id":"top-level-big","object":"model","max_model_len":65536}
	]}`
	srv, probes := capabilitiesServer(t, describedModelList, capabilitiesBody)

	byID := listModelsByID(t, Descriptor{}, srv.URL, 128000)

	if got := byID["top-level-big"].ContextWindow; got != 65536 {
		t.Errorf("top-level-big ContextWindow = %d, want the listing's own 65536", got)
	}
	if *probes != 0 {
		t.Errorf("capabilities probed %d times, want 0 — the listing already described every model", *probes)
	}
}

// LimitDiscoveryUnsupported means "do not believe this endpoint about limits".
// A second endpoint on the same server is still that endpoint.
func TestCapabilitiesProbeSkippedWhenLimitDiscoveryUnsupported(t *testing.T) {
	srv, probes := capabilitiesServer(t, bareModelList, capabilitiesBody)

	byID := listModelsByID(t, Descriptor{LimitDiscoveryUnsupported: true}, srv.URL, 128000)

	if got := byID["top-level-big"].ContextWindow; got != 128000 {
		t.Errorf("top-level-big ContextWindow = %d, want the catalog's 128000 left in charge", got)
	}
	if *probes != 0 {
		t.Errorf("capabilities probed %d times, want 0 for a provider opted out of limit discovery", *probes)
	}
}

// An endpoint without the route answers 404, which is the ordinary case for
// every vendor that never implemented it. The listing must survive it.
func TestCapabilitiesProbeAbsentEndpointLeavesListingIntact(t *testing.T) {
	srv, probes := capabilitiesServer(t, bareModelList, "")

	byID := listModelsByID(t, Descriptor{}, srv.URL, 128000)

	if len(byID) != 3 {
		t.Fatalf("listed %d models, want all 3 despite the 404", len(byID))
	}
	if got := byID["bare-model"].ContextWindow; got != 128000 {
		t.Errorf("bare-model ContextWindow = %d, want the caller's 128000", got)
	}
	if *probes != 1 {
		t.Errorf("capabilities probed %d times, want 1", *probes)
	}
}

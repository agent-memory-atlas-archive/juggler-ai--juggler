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
	"juggler/cmd/juggler/providers/utils"
)

// modelListServer answers the OpenAI /models call with one model, recording the
// path it was asked for. Reaching it at all is the assertion: the decoy URLs the
// base-URL tests register point at a closed port, so a client built against the
// wrong one fails to connect instead of quietly succeeding.
//
// Only the FIRST request is recorded, which is the model list. The row this
// serves publishes no limits, so the listing goes on to ask the same endpoint
// for its model capabilities, and that second path would otherwise overwrite
// the one under test.
func modelListServer(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gotPath == "" {
			gotPath = r.URL.Path
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"object":"list","data":[{"id":"m","object":"model"}]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &gotPath
}

// closedPort is a decoy endpoint: nothing listens there, and it costs no DNS
// lookup, so a client that wrongly uses it fails immediately.
const closedPort = "http://127.0.0.1:1/v1"

func TestRegisterConfigBaseURLOverridesDescriptor(t *testing.T) {
	srv, gotPath := modelListServer(t)
	name := "openaibase-config-baseurl-" + t.Name()
	// Both descriptor forms are set and both are decoys: the config's URL must
	// beat the static field and the resolver alike.
	Register(Descriptor{
		Name:            name,
		BaseURL:         closedPort,
		BaseURLFunc:     func() string { return closedPort },
		ContextWindowFn: func(string) (int, int) { return 2000, 200 },
	})

	p, err := provider.InitializeProvider(name, provider.Config{
		APIKey:  "test",
		Model:   "m",
		BaseURL: srv.URL,
	})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	if _, err := p.ListModelsWithInfo(context.Background()); err != nil {
		t.Fatalf("ListModelsWithInfo went somewhere other than the config's base URL: %v", err)
	}
	if *gotPath != "/models" {
		t.Fatalf("server asked for %q, want /models", *gotPath)
	}
}

func TestRegisterDescriptorBaseURLStandsWithoutAConfigOverride(t *testing.T) {
	for _, tc := range []struct {
		name  string
		build func(endpoint string) Descriptor
	}{
		{"static BaseURL", func(endpoint string) Descriptor {
			return Descriptor{BaseURL: endpoint}
		}},
		{"BaseURLFunc beats the static field", func(endpoint string) Descriptor {
			return Descriptor{BaseURL: closedPort, BaseURLFunc: func() string { return endpoint }}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, gotPath := modelListServer(t)
			d := tc.build(srv.URL)
			d.Name = "openaibase-descriptor-baseurl-" + t.Name()
			d.ContextWindowFn = func(string) (int, int) { return 2000, 200 }
			Register(d)

			// No BaseURL on the config: the descriptor still decides, exactly as
			// it did before the config gained the field.
			p, err := provider.InitializeProvider(d.Name, provider.Config{APIKey: "test", Model: "m"})
			if err != nil {
				t.Fatalf("InitializeProvider: %v", err)
			}
			if _, err := p.ListModelsWithInfo(context.Background()); err != nil {
				t.Fatalf("ListModelsWithInfo did not reach the descriptor's base URL: %v", err)
			}
			if *gotPath != "/models" {
				t.Fatalf("server asked for %q, want /models", *gotPath)
			}
		})
	}
}

func TestRegisterPublishesDescriptorCapabilities(t *testing.T) {
	name := "openaibase-capabilities-" + t.Name()
	Register(Descriptor{
		Name: name,
		ContextWindowFn: func(model string) (int, int) {
			if model != "known" {
				return 0, 0
			}
			return 2000, 200
		},
	})

	info, found := provider.GetProviderInfo(name)
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("registered provider has no capability resolver")
	}
	got, found := info.ResolveModelCapabilities("known")
	want := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 200}
	if !found || got != want {
		t.Fatalf("known capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	if got, found := info.ResolveModelCapabilities("unknown"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("unknown capabilities = (%+v, %v), want zero, false", got, found)
	}
}

func TestRegisterMapsForcedToolChoiceQuirkToCapability(t *testing.T) {
	cases := []struct {
		name            string
		supported       bool
		wantUnsupported bool
	}{
		{name: "supports forced tool choice", supported: true, wantUnsupported: false},
		{name: "does not support forced tool choice", supported: false, wantUnsupported: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			name := "openaibase-forced-tool-" + t.Name()
			Register(Descriptor{
				Name:            name,
				ContextWindowFn: func(string) (int, int) { return 2000, 200 },
				Quirks:          Quirks{ForcedToolChoiceSupported: tc.supported},
			})
			info, found := provider.GetProviderInfo(name)
			if !found {
				t.Fatal("provider not registered")
			}
			if info.ForcedToolChoiceUnsupported != tc.wantUnsupported {
				t.Fatalf("ForcedToolChoiceUnsupported = %v, want %v", info.ForcedToolChoiceUnsupported, tc.wantUnsupported)
			}
		})
	}
}

func TestRegisterCapsResolverVouchesOnlyForCataloguedModels(t *testing.T) {
	name := "openaibase-caps-resolver-" + t.Name()
	Register(Descriptor{
		Name:              name,
		ContextWindowCaps: utils.ModelCaps{Default: 100000, Overrides: map[string]int{"known": 2000}},
		MaxOutputCaps:     utils.ModelCaps{Default: 4000},
	})

	info, found := provider.GetProviderInfo(name)
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("registered provider has no capability resolver")
	}
	// A catalogued id resolves, with defaults filling the dimensions that
	// lack an override.
	got, found := info.ResolveModelCapabilities("known")
	want := provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 4000}
	if !found || got != want {
		t.Fatalf("catalogued capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	// An uncatalogued id (e.g. a user-invented alias) fails closed instead of
	// inheriting the provider defaults as a fabricated limit.
	if got, found := info.ResolveModelCapabilities("user-invented-alias"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("uncatalogued capabilities = (%+v, %v), want zero, false", got, found)
	}
}

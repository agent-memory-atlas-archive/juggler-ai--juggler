//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

const (
	switchFrom = "test-switch-from"
	switchTo   = "test-switch-to"
)

// registerSwitchPair registers two keyless providers, the first naming the
// second as its successor while *suggest is true, and returns how often Adopt
// ran.
func registerSwitchPair(t *testing.T, suggest *bool) *int {
	t.Helper()
	adopted := 0
	initializer := func(provider.Config) (provider.Provider, error) { return fakeModelProvider{name: "fake"}, nil }
	provider.RegisterProvider(provider.ProviderInfo{
		Name:        switchFrom,
		DisplayName: "Switch From",
		Successor: func(context.Context) *provider.Successor {
			if !*suggest {
				return nil
			}
			return &provider.Successor{
				Provider: switchTo,
				Reason:   "This server is the other kind.",
				Adopt:    func() error { adopted++; return nil },
			}
		},
	}, initializer)
	provider.RegisterProvider(provider.ProviderInfo{Name: switchTo, DisplayName: "Switch To"}, initializer)
	t.Cleanup(func() {
		provider.UnregisterProvider(switchFrom)
		provider.UnregisterProvider(switchTo)
	})
	return &adopted
}

func postSwitch(t *testing.T, s *Server, from string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleProviderSwitch(rec, httptest.NewRequest("POST", "/api/providers/switch",
		strings.NewReader(`{"from":"`+from+`"}`)))
	return rec
}

// A provider pointed at a server another provider understands better is
// published with that provider named, so the UI can say so.
func TestProviderSwitchIsPublishedWhileSuggested(t *testing.T) {
	userpathstest.Isolate(t)
	suggest := true
	registerSwitchPair(t, &suggest)
	info, _ := provider.GetProviderInfo(switchFrom)

	got := providerSwitchFor(context.Background(), info)
	want := &ProviderSwitch{Provider: switchTo, DisplayName: "Switch To", Reason: "This server is the other kind."}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("providerSwitchFor = %+v, want %+v", got, want)
	}

	// Asked only of a provider that is switched on: it is the switched-on one
	// that lists models nothing can read the windows of.
	creds, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := creds.SetProviderEnabled(switchFrom, true); err != nil {
		t.Fatal(err)
	}
	if err := creds.SetProviderEnabled(switchTo, false); err != nil {
		t.Fatal(err)
	}
	published := findProviderStatus(t, (&Server{}).computeProviders(context.Background()), switchFrom)
	if !reflect.DeepEqual(published.SwitchTo, want) {
		t.Errorf("published switchTo = %+v, want %+v", published.SwitchTo, want)
	}
	if err := creds.SetProviderEnabled(switchFrom, false); err != nil {
		t.Fatal(err)
	}
	if off := findProviderStatus(t, (&Server{}).computeProviders(context.Background()), switchFrom); off.SwitchTo != nil {
		t.Errorf("a switched-off provider published switchTo = %+v", off.SwitchTo)
	}

	suggest = false
	if got := providerSwitchFor(context.Background(), info); got != nil {
		t.Errorf("providerSwitchFor = %+v once nothing is suggested, want nil", got)
	}
}

// The switch keeps everything the user set up for the models: the provider is
// replaced, not the user's preferences.
func TestProviderSwitchCarriesTheUsersSetupAcross(t *testing.T) {
	userpathstest.Isolate(t)
	suggest := true
	adopted := registerSwitchPair(t, &suggest)

	creds, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := creds.SetProviderEnabled(switchFrom, true); err != nil {
		t.Fatal(err)
	}
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Hidden = map[string][]string{switchFrom: {"noisy"}, switchTo: {"other"}}
		gs.Models.Limits = map[string]map[string]core.ModelLimits{
			switchFrom: {"big": {ContextWindow: 256000}, "both": {ContextWindow: 1000}},
			switchTo:   {"both": {ContextWindow: 2000}},
		}
		return true
	}); err != nil {
		t.Fatal(err)
	}
	defaults, _ := core.NewDefaultModelStore()
	if err := defaults.Save(core.ModelRef{Provider: switchFrom, Model: "big"}); err != nil {
		t.Fatal(err)
	}
	cheap, _ := core.NewCheapModelStore()
	if err := cheap.Save(core.CheapModelSetting{ModelRef: core.ModelRef{Provider: switchFrom, Model: "small"}}); err != nil {
		t.Fatal(err)
	}

	s := &Server{settings: newSettingsStore()}
	rec := postSwitch(t, s, switchFrom)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Provider != switchTo {
		t.Errorf("response = %s, want the provider switched to", rec.Body.String())
	}

	if *adopted != 1 {
		t.Errorf("Adopt ran %d times, want once", *adopted)
	}
	if creds.IsProviderEnabled(switchFrom) || !creds.HasProviderFlag(switchFrom) {
		t.Error("the old provider is not switched off")
	}
	if !creds.IsProviderEnabled(switchTo) {
		t.Error("the new provider is not switched on")
	}

	gs := s.settings.get()
	wantLimits := map[string]core.ModelLimits{"big": {ContextWindow: 256000}, "both": {ContextWindow: 2000}}
	if got := gs.Models.Limits[switchTo]; !reflect.DeepEqual(got, wantLimits) {
		t.Errorf("new provider's limits = %v, want %v (carried over, its own entry winning)", got, wantLimits)
	}
	if got := gs.Models.Hidden[switchTo]; !reflect.DeepEqual(got, []string{"noisy", "other"}) {
		t.Errorf("new provider's hidden models = %v, want both lists", got)
	}
	if _, kept := gs.Models.Limits[switchFrom]["big"]; !kept {
		t.Error("the old provider's limits were dropped; switching it back on should lose nothing")
	}

	if ref, _ := defaults.Load(); ref.Provider != switchTo || ref.Model != "big" {
		t.Errorf("default model = %+v, want the same model on the new provider", ref)
	}
	if setting, _ := cheap.Load(); setting.Provider != switchTo || setting.Model != "small" {
		t.Errorf("cheap model = %+v, want the same model on the new provider", setting)
	}
}

// A switch asked for after the server changed — LocalAI really is LocalAI now —
// is refused rather than carried out on a stale reading.
func TestProviderSwitchRefusedWhenNoLongerSuggested(t *testing.T) {
	userpathstest.Isolate(t)
	suggest := false
	adopted := registerSwitchPair(t, &suggest)
	s := &Server{settings: newSettingsStore()}

	if rec := postSwitch(t, s, switchFrom); rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
	if rec := postSwitch(t, s, "no-such-provider"); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown provider: status = %d, want 400", rec.Code)
	}
	if *adopted != 0 {
		t.Error("Adopt ran for a refused switch")
	}
}

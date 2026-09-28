//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

func newOnboardingTestServer() *Server {
	return &Server{
		providerRefresh: providerRefresh{
			providersReady:  make(chan struct{}),
			refreshRequests: make(chan struct{}, 1),
		},
		shutdownChan: make(chan struct{}),
	}
}

func fixedProbes(apps core.InstalledApps, claudeCLI, codexSignedIn bool) onboardingProbes {
	return onboardingProbes{
		apps:          func() core.InstalledApps { return apps },
		claudeCLI:     func() bool { return claudeCLI },
		codexSignedIn: func() bool { return codexSignedIn },
	}
}

// TestOnboardingDetectComposesProbes covers the cases where the flags disagree,
// which are the only ones that change what setup tells the user.
func TestOnboardingDetectComposesProbes(t *testing.T) {
	tests := []struct {
		name          string
		apps          core.InstalledApps
		claudeCLI     bool
		codexSignedIn bool
		want          onboardingDetection
		because       string
	}{
		{
			name:    "bare machine",
			want:    onboardingDetection{},
			because: "nothing installed must report nothing, not a default of something",
		},
		{
			name:      "Claude desktop app without the CLI",
			apps:      core.InstalledApps{ClaudeDesktopApp: true},
			claudeCLI: false,
			want:      onboardingDetection{ClaudeDesktopApp: true},
			because:   "the app contains Claude Code as a tab but gives Juggler no claude binary to drive",
		},
		{
			name:          "ChatGPT app signed in with no Codex CLI",
			apps:          core.InstalledApps{ChatGPTApp: true},
			codexSignedIn: true,
			want:          onboardingDetection{ChatGPTApp: true, CodexSignedIn: true},
			because:       "the app writes the login the CLI would, so there is nothing left to install",
		},
		{
			name:    "Codex CLI present but signed out",
			apps:    core.InstalledApps{CodexCLI: true},
			want:    onboardingDetection{CodexCLI: true},
			because: "an installed CLI is not a login; setup must ask for the sign-in, not the install",
		},
		{
			name:      "Claude CLI without the desktop app",
			claudeCLI: true,
			want:      onboardingDetection{ClaudeCLI: true},
			because:   "the CLI is the thing Juggler drives; the app is neither required nor implied",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newOnboardingTestServer()
			got := s.detectOnboarding(fixedProbes(tc.apps, tc.claudeCLI, tc.codexSignedIn))
			if got != tc.want {
				t.Fatalf("detectOnboarding() = %+v, want %+v (%s)", got, tc.want, tc.because)
			}
		})
	}
}

// TestOnboardingAnyProviderAvailableNeedsAModel pins the completion signal to
// the same test the client makes: a provider with no model cannot start a
// conversation, so reporting setup as finished would strand the user on an
// empty model picker.
func TestOnboardingAnyProviderAvailableNeedsAModel(t *testing.T) {
	tests := []struct {
		name string
		list []ProviderStatus
		want bool
	}{
		{name: "no providers", list: nil, want: false},
		{
			name: "available but no models",
			list: []ProviderStatus{{Name: "x", Available: true}},
			want: false,
		},
		{
			name: "models but not available",
			list: []ProviderStatus{{Name: "x", ModelsWithContext: []ModelWithContext{{ID: "m"}}}},
			want: false,
		},
		{
			name: "available with a model",
			list: []ProviderStatus{{Name: "x", Available: true, ModelsWithContext: []ModelWithContext{{ID: "m"}}}},
			want: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newOnboardingTestServer()
			list := tc.list
			s.providersList.Store(&list)
			if got := s.anyProviderAvailable(); got != tc.want {
				t.Fatalf("anyProviderAvailable() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestOnboardingDetectRefreshRereadsTheMachine is the assertion the whole
// "check again" button rests on: a user sent away to install a CLI comes back
// and presses it, and the answer must describe the machine as it is now rather
// than as it was when the window opened.
func TestOnboardingDetectRefreshRereadsTheMachine(t *testing.T) {
	const name = "onboarding-refresh-probe"
	var installed atomic.Bool
	provider.RegisterProvider(
		provider.ProviderInfo{Name: name, AutoDetect: installed.Load},
		func(provider.Config) (provider.Provider, error) { return nil, nil },
	)
	t.Cleanup(func() { provider.UnregisterProvider(name) })

	if provider.CheckAutoDetect(name) {
		t.Fatal("provider detected before it was installed")
	}
	installed.Store(true)

	s := newOnboardingTestServer()
	rec := httptest.NewRecorder()
	s.handleOnboardingDetect(rec, httptest.NewRequest(http.MethodGet, "/api/onboarding/detect?refresh=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !provider.CheckAutoDetect(name) {
		t.Fatal("refresh=1 left the memoised detection in place, so check-again reports a stale machine")
	}
}

// TestOnboardingDetectWithoutRefreshKeepsTheMemo is the other half: the ordinary
// poll must not turn into a filesystem scan per call.
func TestOnboardingDetectWithoutRefreshKeepsTheMemo(t *testing.T) {
	const name = "onboarding-norefresh-probe"
	var probes atomic.Int64
	provider.RegisterProvider(
		provider.ProviderInfo{Name: name, AutoDetect: func() bool { probes.Add(1); return false }},
		func(provider.Config) (provider.Provider, error) { return nil, nil },
	)
	t.Cleanup(func() { provider.UnregisterProvider(name) })

	provider.CheckAutoDetect(name)

	s := newOnboardingTestServer()
	rec := httptest.NewRecorder()
	s.handleOnboardingDetect(rec, httptest.NewRequest(http.MethodGet, "/api/onboarding/detect", nil))

	provider.CheckAutoDetect(name)
	if got := probes.Load(); got != 1 {
		t.Fatalf("probe ran %d times, want 1: a plain detect call discarded the memo", got)
	}
}

// TestOnboardingDetectRespondsAsJSON pins the wire shape the client branches on.
func TestOnboardingDetectRespondsAsJSON(t *testing.T) {
	s := newOnboardingTestServer()
	rec := httptest.NewRecorder()
	s.handleOnboardingDetect(rec, httptest.NewRequest(http.MethodGet, "/api/onboarding/detect", nil))

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	for _, key := range []string{
		"claudeDesktopApp", "claudeCLI", "chatgptApp", "codexCLI",
		"codexSignedIn", "anyProviderAvailable", "providersReady",
	} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("response is missing %q; the client branches on every field", key)
		}
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
)

const (
	claudeCodeProviderName = "claudecode"
	codexProviderName      = "openaicodex"
)

// onboardingDetection is what first-run setup needs in order to say something
// specific instead of "no providers configured". Each field answers a question
// that changes what the user should be told to do next, and they are reported
// separately because the interesting cases are the ones where they disagree:
// the Claude desktop app without the CLI, or a Codex login with no CLI at all.
type onboardingDetection struct {
	ClaudeDesktopApp bool `json:"claudeDesktopApp"`
	ClaudeCLI        bool `json:"claudeCLI"`
	ChatGPTApp       bool `json:"chatgptApp"`
	CodexCLI         bool `json:"codexCLI"`
	// CodexSignedIn is read from the login on disk rather than from the provider
	// cache, because the ChatGPT app writes that login without the CLI ever being
	// installed — so a machine with no codex binary can still be ready to work.
	CodexSignedIn bool `json:"codexSignedIn"`
	// AnyProviderAvailable is the completion signal: setup has nothing left to do
	// the moment one provider can actually serve a model.
	AnyProviderAvailable bool `json:"anyProviderAvailable"`
	ProvidersReady       bool `json:"providersReady"`
}

// onboardingProbes is the seam the detection reads the world through, so the
// composition can be tested without the test's own machine deciding the answer.
type onboardingProbes struct {
	apps          func() core.InstalledApps
	claudeCLI     func() bool
	codexSignedIn func() bool
}

func realOnboardingProbes() onboardingProbes {
	return onboardingProbes{
		apps:          core.ProbeInstalledApps,
		claudeCLI:     func() bool { return provider.CheckAutoDetect(claudeCodeProviderName) },
		codexSignedIn: codexLoginPresent,
	}
}

// codexLoginPresent reports whether the Codex login on disk resolves to a usable
// bearer. It asks the credentials store rather than stat-ing the file, so an
// expired token counts as signed out exactly as it does everywhere else.
func codexLoginPresent() bool {
	credStore, err := core.NewCredentialsStore()
	if err != nil {
		return false
	}
	_, err = credStore.GetProviderCredential(codexProviderName)
	return err == nil
}

// handleOnboardingDetect reports what is installed on this machine.
//
// `refresh=1` is the "check again" the setup flow offers after sending someone
// off to install a CLI. It discards memoised auto-detection first, because the
// whole point of the button is that the machine has changed since the answer was
// taken — everything else here is read live on each call and needs no such help.
func (s *Server) handleOnboardingDetect(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("refresh") == "1" {
		provider.InvalidateAutoDetect()
		s.RefreshProviders()
	}
	handlers.WriteJSON(w, r, 0, s.detectOnboarding(realOnboardingProbes()))
}

func (s *Server) detectOnboarding(probes onboardingProbes) onboardingDetection {
	apps := probes.apps()
	return onboardingDetection{
		ClaudeDesktopApp:     apps.ClaudeDesktopApp,
		ClaudeCLI:            probes.claudeCLI(),
		ChatGPTApp:           apps.ChatGPTApp,
		CodexCLI:             apps.CodexCLI,
		CodexSignedIn:        probes.codexSignedIn(),
		AnyProviderAvailable: s.anyProviderAvailable(),
		ProvidersReady:       s.providersReadyNow(),
	}
}

// anyProviderAvailable mirrors the client's own completion test: a provider that
// is available but lists no model cannot start a conversation, so it does not
// count as set up.
func (s *Server) anyProviderAvailable() bool {
	for _, p := range s.cachedProviders() {
		if p.Available && len(p.ModelsWithContext) > 0 {
			return true
		}
	}
	return false
}

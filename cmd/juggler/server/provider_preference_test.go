//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "testing"

// providerWith builds a provider entry with one or more models.
func providerWith(name string, available bool, modelIDs ...string) ProviderStatus {
	var models []ModelWithContext
	for _, id := range modelIDs {
		models = append(models, ModelWithContext{ID: id})
	}
	return ProviderStatus{Name: name, Available: available, ModelsWithContext: models}
}

// hideModels marks the named models of p as hidden, as computeProviders does
// from the user's models.hidden settings.
func hideModels(p ProviderStatus, hidden ...string) ProviderStatus {
	for i, m := range p.ModelsWithContext {
		for _, id := range hidden {
			if m.ID == id {
				p.ModelsWithContext[i].Hidden = true
			}
		}
	}
	return p
}

// fromCatalog marks every model of p as listed by the provider's live catalog,
// leaving the named ones as built-in stand-ins (FromAPI false).
func fromCatalog(p ProviderStatus, standIns ...string) ProviderStatus {
	for i, m := range p.ModelsWithContext {
		p.ModelsWithContext[i].FromAPI = true
		for _, id := range standIns {
			if m.ID == id {
				p.ModelsWithContext[i].FromAPI = false
			}
		}
	}
	return p
}

func noDefaultModels(string) []string { return nil }

func TestPreferredAvailableModelHonoursProviderDefaults(t *testing.T) {
	codexDefaults := func(name string) []string {
		if name == "openaicodex" {
			return []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"}
		}
		return nil
	}
	tests := []struct {
		name      string
		provider  ProviderStatus
		wantModel string
	}{
		{
			name:      "first preferred model wins over catalog order",
			provider:  fromCatalog(providerWith("openaicodex", true, "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol")),
			wantModel: "gpt-6.1-sol",
		},
		{
			name:      "a preference the catalog lacks falls to the next",
			provider:  fromCatalog(providerWith("openaicodex", true, "gpt-6-astra", "gpt-5.6-sol")),
			wantModel: "gpt-5.6-sol",
		},
		{
			name:      "a hidden preference is skipped",
			provider:  hideModels(fromCatalog(providerWith("openaicodex", true, "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol")), "gpt-6.1-sol"),
			wantModel: "gpt-6-sol",
		},
		{
			// An account without GPT-6 still sees the GPT-6 slugs as stand-ins;
			// seeding a conversation with one fails its first turn.
			name:      "a stand-in the account's catalog did not list is skipped",
			provider:  fromCatalog(providerWith("openaicodex", true, "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6.1-sol"), "gpt-6.1-sol"),
			wantModel: "gpt-5.6-sol",
		},
		{
			name:      "no preference present falls back to the first visible model",
			provider:  fromCatalog(providerWith("openaicodex", true, "gpt-6-astra", "gpt-5.5")),
			wantModel: "gpt-6-astra",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, ok := preferredAvailableModel([]ProviderStatus{tt.provider}, codexDefaults)
			if !ok || ref.Model != tt.wantModel {
				t.Fatalf("got %s (ok=%v), want %s", ref.Model, ok, tt.wantModel)
			}
		})
	}
}

func TestPreferredAvailableModel(t *testing.T) {
	tests := []struct {
		name         string
		providers    []ProviderStatus
		wantOK       bool
		wantProvider string
		wantModel    string
	}{
		{
			name:   "no providers",
			wantOK: false,
		},
		{
			name: "none available",
			providers: []ProviderStatus{
				providerWith("claudecode", false, "sonnet"),
				providerWith("openai", false, "gpt"),
			},
			wantOK: false,
		},
		{
			name: "available but no models is skipped",
			providers: []ProviderStatus{
				providerWith("claudecode", true), // available, zero models
				providerWith("openai", true, "gpt-4"),
			},
			wantOK:       true,
			wantProvider: "openai",
			wantModel:    "gpt-4",
		},
		{
			name: "claudecode wins over codex and others",
			providers: []ProviderStatus{
				providerWith("openaicodex", true, "gpt-5-codex"),
				providerWith("anthropic", true, "claude-api"),
				providerWith("claudecode", true, "opus", "sonnet"),
			},
			wantOK:       true,
			wantProvider: "claudecode",
			wantModel:    "opus", // first model
		},
		{
			name: "codex wins when claudecode absent",
			providers: []ProviderStatus{
				providerWith("anthropic", true, "claude-api"),
				providerWith("openaicodex", true, "gpt-5-codex"),
			},
			wantOK:       true,
			wantProvider: "openaicodex",
			wantModel:    "gpt-5-codex",
		},
		{
			name: "unlisted providers ordered by name",
			providers: []ProviderStatus{
				providerWith("openai", true, "gpt-4"),
				providerWith("deepseek", true, "deepseek-chat"),
				providerWith("ollama", true, "llama"),
			},
			wantOK:       true,
			wantProvider: "deepseek",
			wantModel:    "deepseek-chat",
		},
		{
			name: "hidden first model falls through to the next",
			providers: []ProviderStatus{
				hideModels(providerWith("claudecode", true, "opus", "sonnet"), "opus"),
			},
			wantOK:       true,
			wantProvider: "claudecode",
			wantModel:    "sonnet",
		},
		{
			name: "provider with every model hidden is skipped entirely",
			providers: []ProviderStatus{
				hideModels(providerWith("claudecode", true, "opus", "sonnet"), "opus", "sonnet"),
				providerWith("openai", true, "gpt-4"),
			},
			wantOK:       true,
			wantProvider: "openai",
			wantModel:    "gpt-4",
		},
		{
			name: "all models of all providers hidden yields nothing",
			providers: []ProviderStatus{
				hideModels(providerWith("claudecode", true, "opus"), "opus"),
				hideModels(providerWith("openai", true, "gpt-4"), "gpt-4"),
			},
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, ok := preferredAvailableModel(tt.providers, noDefaultModels)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if ref.Provider != tt.wantProvider || ref.Model != tt.wantModel {
				t.Fatalf("got %s/%s, want %s/%s", ref.Provider, ref.Model, tt.wantProvider, tt.wantModel)
			}
		})
	}
}

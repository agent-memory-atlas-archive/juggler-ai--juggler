//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package audit

import (
	"sort"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/copilot"
	"juggler/cmd/juggler/providers/deepseek"
	"juggler/cmd/juggler/providers/gemini"
	"juggler/cmd/juggler/providers/llamacpp"
	"juggler/cmd/juggler/providers/localai"
	"juggler/cmd/juggler/providers/mistral"
	"juggler/cmd/juggler/providers/moonshot"
	"juggler/cmd/juggler/providers/ollama"
	"juggler/cmd/juggler/providers/openai"
	"juggler/cmd/juggler/providers/openaicodex"
	"juggler/cmd/juggler/providers/opencodezen"
	"juggler/cmd/juggler/providers/openrouter"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/zai"
)

// registerCatalogProviders registers every provider that ships a static model
// catalog. It mirrors the registration list in app/run.go, minus the providers
// that carry no catalog of their own (the CLI- and protocol-backed ones, whose
// models come from a subprocess) and customprovider, whose catalog is whatever
// endpoints the user configured.
//
// Registration is idempotent per process — the registry replaces a name — so
// tests in this package may call it freely.
func registerCatalogProviders() {
	anthropic.Register()
	copilot.Register()
	deepseek.Register()
	gemini.Register()
	llamacpp.Register()
	localai.Register()
	mistral.Register()
	moonshot.Register()
	ollama.Register()
	openai.Register()
	openaicodex.Register()
	opencodezen.Register()
	openrouter.Register()
	zai.Register()
}

// TestCatalogInvariants checks every catalogued model of every provider against
// the rules a limit pair must satisfy to be usable, without touching the
// network. These are the failures no amount of live discovery can rescue,
// because they are wrong before a request is ever built:
//
//   - A window of zero or less is not a limit. Admission fails closed on an
//     unknown window, which is the right answer for a model nobody catalogued —
//     but an entry that exists and says nothing is just a broken entry.
//   - An output cap at or above the window leaves no room for input at all. The
//     provider answers such a request with a 400, so the model is unusable for
//     as long as the entry stands. (The server's normalizeOutputLimit catches
//     this at runtime and substitutes a derived reserve, which is a safety net,
//     not a licence to ship the number.)
//   - A resolver and a map that disagree about the same model would make the
//     window depend on which of the two a caller happened to ask.
func TestCatalogInvariants(t *testing.T) {
	registerCatalogProviders()

	checked := 0
	for _, info := range provider.ListProviderInfos() {
		ids := make([]string, 0, len(info.ModelContextWindows))
		for id := range info.ModelContextWindows {
			ids = append(ids, id)
		}
		sort.Strings(ids)

		for _, id := range ids {
			checked++
			window := info.ModelContextWindows[id]
			if window <= 0 {
				t.Errorf("%s/%s: catalogued with a context window of %d", info.Name, id, window)
				continue
			}
			if info.ResolveModelCapabilities == nil {
				continue
			}
			caps, ok := info.ResolveModelCapabilities(id)
			if !ok {
				t.Errorf("%s/%s: listed in ModelContextWindows but resolves no static capabilities, so admission cannot size it", info.Name, id)
				continue
			}
			if caps.ContextWindowTokens != int64(window) {
				t.Errorf("%s/%s: resolver says the window is %d, the catalog map says %d", info.Name, id, caps.ContextWindowTokens, window)
			}
			// A zero output cap is not a fault: several providers deliberately
			// leave it to the server's derived safety reserve. A positive one
			// has to fit.
			if caps.MaxOutputTokens > 0 && caps.MaxOutputTokens >= int64(window) {
				t.Errorf("%s/%s: output cap %d is at or above the %d window, leaving no room for input — the provider 400s every request",
					info.Name, id, caps.MaxOutputTokens, window)
			}
		}
	}

	if checked == 0 {
		t.Fatal("no catalogued models were checked — the provider registration list is not doing anything")
	}
	t.Logf("checked %d catalogued models", checked)
}

// TestCheapModelHintsNameACataloguedModel checks each provider's cheap-model
// hint against that provider's own catalog.
//
// The hint is a compiled-in model id, and a vendor rolling its small model to a
// new name is enough to make it name nothing. Nothing complains when that
// happens: resolution simply finds no match and reports no cheap model, so the
// symptom is tabs quietly staying "Untitled 4" — a fault with no error, on a
// feature nobody is watching. This test is what turns it into a build failure
// at the moment the catalog is edited.
//
// Matching mirrors liveModelMatch: exact id first, then prefix, so a family
// hint ("ministral-8b") legitimately names the dated id a vendor publishes
// ("ministral-8b-2512"). Providers with no static catalog are skipped — their
// model list is discovered at runtime, so there is nothing here to check the
// hint against.
func TestCheapModelHintsNameACataloguedModel(t *testing.T) {
	registerCatalogProviders()

	checked := 0
	for _, info := range provider.ListProviderInfos() {
		if info.CheapModel == "" || len(info.ModelContextWindows) == 0 {
			continue
		}
		checked++

		ids := make([]string, 0, len(info.ModelContextWindows))
		for id := range info.ModelContextWindows {
			ids = append(ids, id)
		}
		sort.Strings(ids)

		matched := ""
		for _, id := range ids {
			if id == info.CheapModel {
				matched = id
				break
			}
			if matched == "" && strings.HasPrefix(id, info.CheapModel) {
				matched = id
			}
		}
		if matched == "" {
			t.Errorf("%s: cheap-model hint %q matches nothing in its own catalog (%v) — tab naming will silently stop on this provider",
				info.Name, info.CheapModel, ids)
		}
	}

	if checked == 0 {
		t.Fatal("no cheap-model hints were checked — either every provider lost its hint, or registration is not doing anything")
	}
	t.Logf("checked %d cheap-model hints", checked)
}

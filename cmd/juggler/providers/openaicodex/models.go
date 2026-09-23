//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

const (
	// DefaultContextWindow is the last-resort admission limit for a model the
	// catalog lists without any window of its own. It is deliberately
	// conservative: an under-estimate compacts early, an over-estimate
	// overruns the model's real limit mid-turn.
	DefaultContextWindow   = 128000
	DefaultMaxOutputTokens = 16384

	// catalogContextWindow is the operating point the ChatGPT-plan catalog
	// reports as `context_window` for every model it currently lists.
	//
	// The live path deliberately prefers the larger `max_context_window` (see
	// listModels), and this map deliberately does not follow it. These numbers
	// are used when the catalog is unreachable or the user is signed out, so
	// they are guesses about a backend we could not reach — and the two
	// directions of error are not equal. Guessing low compacts a conversation
	// earlier than it needed to be; guessing high walks it into a mid-turn
	// rejection with the whole prompt already assembled. The ceilings also vary
	// per model in ways only the catalog knows, so a static one would be wrong
	// per-slug rather than merely conservative.
	catalogContextWindow = 272000
)

// knownModel is one slug Juggler lists for the ChatGPT plan.
type knownModel struct {
	// Slug is the catalog's model id, verbatim.
	Slug string

	// ContextWindow is the admission limit used only when the live catalog is
	// unreachable or the user is signed out; a live row always overrides it.
	ContextWindow int

	// MinClientVersion is the minimal_client_version the catalog declares for
	// this slug, or "" for a slug old enough to carry no minimum. The catalog
	// withholds a row from any client older than this, and says nothing about
	// having done so, which is why codexClientVersion must be at or above every
	// value here — TestCodexClientVersionCoversEveryModel is what says so.
	MinClientVersion string
}

// knownModels is the ChatGPT-plan model list, and the one place to edit when
// the catalog gains or retires a model. Everything else is derived from it: the
// windows the settings UI shows, the static entries a signed-out user picks
// from, and which slugs may be admitted from a hidden catalog row (admitModel).
//
// Adding a model is one line, with two things to get right in it:
//   - Copy MinClientVersion from the catalog's record for that slug. If it is
//     above codexClientVersion, raise that too — the tests will tell you.
//   - A slug the catalog has retired must be deleted from here. Left in place
//     it stays selectable long after the backend stops accepting it.
var knownModels = []knownModel{
	{Slug: "gpt-6-astra", ContextWindow: catalogContextWindow, MinClientVersion: "0.153.0"},
	{Slug: "gpt-6-sol", ContextWindow: catalogContextWindow, MinClientVersion: "0.155.0"},
	{Slug: "gpt-6-luna", ContextWindow: catalogContextWindow, MinClientVersion: "0.155.0"},
	{Slug: "gpt-5.6-sol", ContextWindow: catalogContextWindow, MinClientVersion: "0.144.0"},
	{Slug: "gpt-5.6-terra", ContextWindow: catalogContextWindow, MinClientVersion: "0.144.0"},
	{Slug: "gpt-5.6-luna", ContextWindow: catalogContextWindow, MinClientVersion: "0.144.0"},
	{Slug: "gpt-5.5", ContextWindow: catalogContextWindow, MinClientVersion: "0.124.0"},
}

// ModelContextWindows is knownModels in the shape the provider descriptor and
// the settings UI consume, via ProviderInfo.ModelContextWindows.
var ModelContextWindows = knownModelContextWindows()

func knownModelContextWindows() map[string]int {
	windows := make(map[string]int, len(knownModels))
	for _, model := range knownModels {
		windows[model.Slug] = model.ContextWindow
	}
	return windows
}

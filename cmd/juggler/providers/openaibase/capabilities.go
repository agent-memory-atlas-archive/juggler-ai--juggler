//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
)

// CapabilitiesPath is the model-capabilities route, relative to the /v1 base
// URL every OpenAI-compatible client is configured with. LocalAI serves it, and
// it is the only endpoint there that states a window at all: its /v1/models
// rows are an id and an object type, so DiscoverLimits has nothing to read and
// the caller is left advertising whatever it assumed.
const CapabilitiesPath = "/models/capabilities"

// capabilitiesClient bounds the probe. Three seconds because the endpoint may
// be a LAN box or a hosted gateway rather than loopback, and the result is only
// ever an improvement on a number the caller already has: a server that stalls
// must cost a listing a short pause, never the listing itself.
var capabilitiesClient = httpx.Client(3 * time.Second)

// ModelCapability is one GET /v1/models/capabilities row, reduced to the two
// things a client can act on.
//
// ContextSize is the window the backend will actually serve — LocalAI derives
// it from the running configuration rather than the model's architectural
// maximum, so it is a promise rather than a ceiling. It is `omitempty` on an
// int at the server, which makes an absent key the only way to say "unknown":
// zero is never a window, and reading one as a limit would advertise a
// 0-token context to the budgeter.
//
// Capabilities names what the model is for — "chat", "embeddings", "tts",
// "image" — which is worth more than it looks: an OpenAI-compatible /v1/models
// list is a flat list of everything the server hosts, voices and image models
// included, and this is the only field that distinguishes them.
type ModelCapability struct {
	ID           string   `json:"id"`
	Capabilities []string `json:"capabilities"`
	ContextSize  int      `json:"context_size"`
}

// Serves reports whether this model declares the named capability. A row that
// declares none at all is treated as serving everything: an endpoint that
// publishes the field empty has told us nothing, and filtering a model out on
// the strength of nothing would hide a model that works.
func (m ModelCapability) Serves(capability string) bool {
	if len(m.Capabilities) == 0 {
		return true
	}
	for _, declared := range m.Capabilities {
		if declared == capability {
			return true
		}
	}
	return false
}

// FetchModelCapabilities reads every capabilities row the endpoint publishes.
// Returns nil when the endpoint does not implement the route, which is the
// ordinary case: it is a LocalAI extension, so every other vendor answers 404
// (and LocalAI itself only gained the context_size field in v4.10.0).
//
// baseURL is the client's OpenAI-compatible base — the one that already ends in
// /v1 — so the route is reached with the same prefix, host and scheme the model
// list uses.
func FetchModelCapabilities(ctx context.Context, baseURL, credential string, headers map[string]string) []ModelCapability {
	if baseURL == "" {
		return nil
	}
	var body struct {
		Data []ModelCapability `json:"data"`
	}
	opts := utils.JSONGetOptions{
		Bearer:  credential,
		Headers: headers,
		Label:   "model capabilities",
		Client:  capabilitiesClient,
	}
	if err := utils.GetJSON(ctx, baseURL+CapabilitiesPath, opts, &body); err != nil {
		return nil
	}
	return body.Data
}

// CapabilityWindows keys the windows these rows declare by model id, skipping
// the rows that declare none.
func CapabilityWindows(rows []ModelCapability) map[string]int {
	windows := make(map[string]int, len(rows))
	for _, row := range rows {
		if row.ContextSize > 0 {
			windows[row.ID] = row.ContextSize
		}
	}
	return windows
}

// fillWindowsFromCapabilities gives models the endpoint described nothing about
// the window it says it is serving them with, and returns the listing
// unchanged when there is nothing to gain or nobody to ask.
//
// The probe costs one request per listing and only runs when some model's
// window is still an assumption, so the vendors that will never implement the
// route — which is all of them but LocalAI — pay for it exactly once per
// listing, and not at all once their own rows carry limits. A provider opted
// out of limit discovery is opted out of this too: "don't believe what this
// endpoint says about limits" does not become false because the claim arrived
// on a different route.
func (c *openAICompatClient) fillWindowsFromCapabilities(ctx context.Context, models []provider.ModelInfo) []provider.ModelInfo {
	if c.limitDiscoveryDisabled {
		return models
	}
	assumed := false
	for _, model := range models {
		if !model.FromAPI {
			assumed = true
			break
		}
	}
	if !assumed {
		return models
	}

	windows := CapabilityWindows(FetchModelCapabilities(ctx, c.baseURL, c.credential, c.headers))
	for i, model := range models {
		if model.FromAPI {
			continue
		}
		window, ok := windows[model.ID]
		if !ok {
			continue
		}
		models[i].ContextWindow = window
		// The output cap came from a catalog describing a different, usually
		// larger window. Left alone it can now exceed the window the server just
		// told us it will serve, which is a 400 on the wire rather than a
		// truncated reply.
		models[i].MaxOutputTokens = utils.ClampOutputToWindow(window, model.MaxOutputTokens)
		models[i].FromAPI = true
	}
	return models
}

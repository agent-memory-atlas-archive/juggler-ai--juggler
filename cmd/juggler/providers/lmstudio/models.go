//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lmstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
)

// DefaultContextWindow is the window assumed for a model LM Studio states no
// loaded length for: one downloaded but not loaded (LM Studio loads it on first
// use, at a length its API does not report), or any model on a server whose
// model table cannot be read.
//
// The rule for an assumed window is that it must never exceed what the server
// would plausibly serve. The two errors are not symmetric: a window stated too
// small compacts early and shortens replies, which is visible — the model
// picker and every compaction say the window was assumed and link to the field
// that corrects it — while a window stated too large is silent, because LM
// Studio's default overflow policy drops the middle of the conversation rather
// than refusing the request. So this is small, and it is capped further by a
// model's own max_context_length when that is smaller still.
const DefaultContextWindow = 8192

// probeClient bounds the model-table reads. They are cheap metadata requests a
// local server answers in milliseconds; the timeout caps the wait when the
// server dies mid-listing.
var probeClient = httpx.Client(3 * time.Second)

// Model is one model an LM Studio server can serve, as its own model table
// describes it.
type Model struct {
	// ID is the identifier the OpenAI-compatible API accepts: the v1 table's
	// key, or the v0 table's id.
	ID          string
	DisplayName string
	// LoadedContextLength is the window the model is loaded with — the smallest
	// across its loaded instances, since a request may land on any of them. Zero
	// when it is not loaded, or when the table does not say.
	LoadedContextLength int
	// MaxContextLength is the architecture's ceiling, which a model is routinely
	// loaded far below. It bounds an assumed window; it is never enforced as one.
	MaxContextLength int
	// Vision reports that the model accepts image input.
	Vision bool
}

// ContextWindow returns the window to enforce for this model and whether it is
// assumed. A loaded model's loaded length is the server's own statement; any
// other model gets DefaultContextWindow, capped at its ceiling.
func (m Model) ContextWindow() (window int, assumed bool) {
	if m.LoadedContextLength > 0 {
		return m.LoadedContextLength, false
	}
	window = DefaultContextWindow
	if m.MaxContextLength > 0 && m.MaxContextLength < window {
		window = m.MaxContextLength
	}
	return window, true
}

// nativeTable is GET /api/v1/models, LM Studio's REST API from 0.4 on. Models
// is a pointer so a body without the key — the 200-with-an-error LM Studio
// sends for a route it lacks — is told apart from an empty list.
type nativeTable struct {
	Models *[]nativeModel `json:"models"`
}

type nativeModel struct {
	Type             string `json:"type"`
	Key              string `json:"key"`
	DisplayName      string `json:"display_name"`
	MaxContextLength int    `json:"max_context_length"`
	LoadedInstances  []struct {
		Config struct {
			ContextLength int `json:"context_length"`
		} `json:"config"`
	} `json:"loaded_instances"`
	Capabilities struct {
		Vision bool `json:"vision"`
	} `json:"capabilities"`
}

// legacyTable is GET /api/v0/models, the only table LM Studio 0.3 serves. LM
// Studio's documentation shows no loaded length on its rows, but 0.4.25 sends
// loaded_context_length on every loaded row (realLegacyModels in
// fixtures_test.go), so it is read wherever it is present.
type legacyTable struct {
	Object string         `json:"object"`
	Data   *[]legacyModel `json:"data"`
}

type legacyModel struct {
	ID                  string `json:"id"`
	Type                string `json:"type"`
	State               string `json:"state"`
	MaxContextLength    int    `json:"max_context_length"`
	LoadedContextLength int    `json:"loaded_context_length"`
}

// Models reads the models an LM Studio server at host can serve: its v1 table,
// else its v0 table. Embedding models are left out — they cannot hold a
// conversation. Returns an error when neither table is there, which is the
// ordinary answer from a server that is not LM Studio.
func Models(ctx context.Context, host string, headers map[string]string) ([]Model, error) {
	var native nativeTable
	nativeErr := getJSON(ctx, host+"/api/v1/models", headers, &native)
	if nativeErr == nil && native.Models != nil {
		return native.models(), nil
	}
	var legacy legacyTable
	legacyErr := getJSON(ctx, host+"/api/v0/models", headers, &legacy)
	if legacyErr == nil && legacy.isTable() {
		return legacy.models(), nil
	}
	if nativeErr == nil {
		nativeErr = fmt.Errorf("no model table in the response")
	}
	return nil, fmt.Errorf("no LM Studio model table at %s: /api/v1/models: %w", host, nativeErr)
}

func (t nativeTable) models() []Model {
	out := make([]Model, 0, len(*t.Models))
	for _, m := range *t.Models {
		if m.Key == "" || m.Type == "embedding" {
			continue
		}
		loaded := 0
		for _, instance := range m.LoadedInstances {
			if n := instance.Config.ContextLength; n > 0 && (loaded == 0 || n < loaded) {
				loaded = n
			}
		}
		out = append(out, Model{
			ID:                  m.Key,
			DisplayName:         m.DisplayName,
			LoadedContextLength: loaded,
			MaxContextLength:    m.MaxContextLength,
			Vision:              m.Capabilities.Vision,
		})
	}
	return out
}

func (t legacyTable) isTable() bool {
	return t.Object == "list" && t.Data != nil
}

func (t legacyTable) models() []Model {
	out := make([]Model, 0, len(*t.Data))
	for _, m := range *t.Data {
		if m.ID == "" || m.Type == "embeddings" || m.Type == "embedding" {
			continue
		}
		model := Model{ID: m.ID, MaxContextLength: m.MaxContextLength, Vision: m.Type == "vlm"}
		if m.State == "loaded" {
			model.LoadedContextLength = m.LoadedContextLength
		}
		out = append(out, model)
	}
	return out
}

// IsServer reports whether the server at host is LM Studio: whether it serves
// either of LM Studio's own model tables. It answers for any host, not only the
// one this provider is configured with, so another provider can ask it about
// the server it is pointed at.
func IsServer(ctx context.Context, host string) bool {
	_, err := Models(ctx, host, nil)
	return err == nil
}

// isNativeTable reports whether body is LM Studio's v1 model table.
func isNativeTable(body []byte) bool {
	var t nativeTable
	return json.Unmarshal(body, &t) == nil && t.Models != nil
}

// isLegacyTable reports whether body is LM Studio's v0 model table.
func isLegacyTable(body []byte) bool {
	var t legacyTable
	return json.Unmarshal(body, &t) == nil && t.isTable()
}

func getJSON(ctx context.Context, url string, headers map[string]string, out any) error {
	return utils.GetJSON(ctx, url, utils.JSONGetOptions{Headers: headers, Label: url, Client: probeClient}, out)
}

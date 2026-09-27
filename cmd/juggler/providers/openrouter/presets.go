//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// presetIDPrefix is how OpenRouter accepts a preset in place of a model id, and
// it is the whole reason presets can be offered here at all: "@preset/<slug>"
// goes on the wire in the model field, so nothing downstream of the model list
// needs to know presets exist.
//
// A preset is the only way to express OpenRouter's own routing controls
// (provider order, ZDR, allow-lists) from Juggler, since a request body carries
// no seam for extra top-level fields.
const presetIDPrefix = "@preset/"

// presetStatusActive is the only preset status worth offering. The enum is
// active | disabled | archived, and the other two cannot serve a request.
const presetStatusActive = "active"

// presetPageLimit is one page of presets: OpenRouter's /presets accepts limit
// up to 100 and defaults to 50. One page is fetched, deliberately — an account
// with more presets than this needs paging, and an unbounded loop over an
// endpoint with no published rate limit is the worse of the two problems.
const presetPageLimit = 100

// maxConcurrentPresetFetches bounds the per-preset fan-out. /presets returns
// metadata only, so each preset's model — and therefore its context window —
// costs one more request, and /presets publishes no rate limit.
const maxConcurrentPresetFetches = 4

// openRouterPreset is the subset of a /presets entry we consume. Note what is
// absent: no model, and no context length. Those live only on the per-preset
// endpoint, which is why listing presets is a two-step fetch.
type openRouterPreset struct {
	Slug   string `json:"slug"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type openRouterPresetsResponse struct {
	Data []openRouterPreset `json:"data"`
}

// openRouterPresetDetail mirrors /presets/{slug}. The config block is free-form
// by OpenRouter's own schema, so it is decoded as such: it may name a single
// model, a fallback chain, or no model at all.
type openRouterPresetDetail struct {
	Data struct {
		DesignatedVersion struct {
			Config map[string]any `json:"config"`
		} `json:"designated_version"`
	} `json:"data"`
}

// listPresets returns the account's presets as model entries, resolving each
// one's limits against the catalog already fetched in the same refresh.
//
// Soft-fail throughout: presets are an addition to the model list, so every
// error path here returns what it has and leaves the list intact. A user whose
// key cannot read /presets still gets every model.
//
// A preset can also carry generation settings — a system_prompt, a temperature —
// which shallow-merge underneath the request we build (ours wins on conflict),
// so a preset built for prompting rather than routing can change behaviour
// without saying so anywhere in the UI. Routing-only presets, which is what this
// exists for, have no such effect.
func listPresets(ctx context.Context, apiKey string, headers map[string]string, catalog []provider.ModelInfo) []provider.ModelInfo {
	var page openRouterPresetsResponse
	presetsURL := baseURL + "/presets?limit=" + strconv.Itoa(presetPageLimit)
	if err := utils.GetJSON(ctx, presetsURL, utils.JSONGetOptions{
		Bearer:  apiKey,
		Headers: headers,
		Label:   "OpenRouter /presets",
	}, &page); err != nil {
		return nil
	}

	active := make([]openRouterPreset, 0, len(page.Data))
	for _, preset := range page.Data {
		if preset.Slug != "" && strings.EqualFold(preset.Status, presetStatusActive) {
			active = append(active, preset)
		}
	}
	if len(active) == 0 {
		return nil
	}

	byID := make(map[string]provider.ModelInfo, len(catalog))
	for _, info := range catalog {
		byID[info.ID] = info
	}

	return utils.MapConcurrent(ctx, active, maxConcurrentPresetFetches,
		func(ctx context.Context, preset openRouterPreset) provider.ModelInfo {
			// A preset we cannot read degrades to the provider default rather
			// than dropping out of the list, the same way a config that names no
			// model does: the user configured it, so it is offered.
			models := fetchPresetModels(ctx, preset.Slug, apiKey, headers)
			window, maxOut := presetLimits(models, byID)
			return provider.ModelInfo{
				ID:              presetIDPrefix + preset.Slug,
				DisplayName:     utils.FirstNonEmpty(preset.Name, preset.Slug),
				ContextWindow:   window,
				MaxOutputTokens: maxOut,
				FromAPI:         true,
				InputModalities: presetInputModalities(models, byID),
			}
		})
}

// fetchPresetModels returns the model ids a preset can route to, or nil when the
// preset names none or cannot be read.
func fetchPresetModels(ctx context.Context, slug, apiKey string, headers map[string]string) []string {
	var detail openRouterPresetDetail
	if err := utils.GetJSON(ctx, baseURL+"/presets/"+url.PathEscape(slug), utils.JSONGetOptions{
		Bearer:  apiKey,
		Headers: headers,
		Label:   "OpenRouter /presets/" + slug,
	}, &detail); err != nil {
		return nil
	}
	return presetConfigModels(detail.Data.DesignatedVersion.Config)
}

// presetConfigModels pulls the model ids out of a preset's free-form config:
// "model" is the primary, "models" a fallback chain in priority order. Both may
// be present, and either may be absent. Everything that can serve the request
// goes in the list, because the limits derived from it have to hold whichever
// one does.
func presetConfigModels(config map[string]any) []string {
	models := make([]string, 0, 2)
	if primary, ok := config["model"].(string); ok && primary != "" {
		models = append(models, primary)
	}
	chain, _ := config["models"].([]any)
	for _, entry := range chain {
		if id, ok := entry.(string); ok && id != "" && !slices.Contains(models, id) {
			models = append(models, id)
		}
	}
	return models
}

// presetLimits resolves the context window and output cap for a preset that can
// route to models.
//
// The smallest window in the chain is the only safe figure: OpenRouter picks the
// serving model at request time, so any larger number is a window we might not
// get — the same conservative rule listModels applies across one model's
// endpoints. The output cap follows it: the smallest cap in the chain, re-clamped
// against the window that was chosen so both numbers stay in one denominator.
//
// A preset naming no model (or one whose detail could not be fetched) takes the
// provider default. That matters because admission fails closed on an unknown
// window, so listing a preset without one would make it unusable rather than
// approximate.
func presetLimits(models []string, catalog map[string]provider.ModelInfo) (int, int) {
	window, maxOut := 0, 0
	for _, id := range models {
		modelWindow, modelCap := GetContextWindow(id), 0
		if info, ok := catalog[id]; ok && info.ContextWindow > 0 {
			modelWindow, modelCap = info.ContextWindow, info.MaxOutputTokens
		}
		if window == 0 || modelWindow < window {
			window = modelWindow
		}
		if modelCap > 0 && (maxOut == 0 || modelCap < maxOut) {
			maxOut = modelCap
		}
	}
	if window <= 0 {
		window = DefaultContextWindow
	}
	maxOut = utils.ClampOutputToWindow(window, maxOut)
	if maxOut <= 0 {
		maxOut = DefaultMaxOutputTokens
	}
	return window, maxOut
}

// presetInputModalities reports image input for a preset only when every model
// it can route to accepts images. A preset that might route to a text-only
// model is text-only, since the request is served by one of them and the user
// does not choose which.
func presetInputModalities(models []string, catalog map[string]provider.ModelInfo) []string {
	if len(models) == 0 {
		return nil
	}
	for _, id := range models {
		if !slices.Contains(catalog[id].InputModalities, "image") {
			return nil
		}
	}
	return []string{"text", "image"}
}

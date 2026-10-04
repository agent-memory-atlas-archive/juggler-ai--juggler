//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"net/http"
	"slices"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// ProviderSwitch is a provider's published suggestion that another provider
// would serve the server it is pointed at better: the one the UI offers to
// switch to, and the sentence that says why.
type ProviderSwitch struct {
	Provider    string `json:"provider"`
	DisplayName string `json:"displayName"`
	Reason      string `json:"reason"`
}

// providerSwitchFor asks a provider for its successor and describes it for the
// UI. Nil when the provider names none, or names one this build does not have.
func providerSwitchFor(ctx context.Context, info provider.ProviderInfo) *ProviderSwitch {
	if info.Successor == nil {
		return nil
	}
	next := info.Successor(ctx)
	if next == nil {
		return nil
	}
	target, ok := provider.GetProviderInfo(next.Provider)
	if !ok {
		return nil
	}
	return &ProviderSwitch{Provider: next.Provider, DisplayName: target.DisplayName, Reason: next.Reason}
}

// handleProviderSwitch moves the user from one provider to the successor it
// names: POST /api/providers/switch {"from": "<provider>"}.
//
// The successor is asked for again rather than trusted from the request, so a
// switch offered before the server changed — the user has since started the
// server the first provider is for — is refused with 409 instead of carried out
// on a stale reading.
func (s *Server) handleProviderSwitch(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		From string `json:"from"`
	}](w, r)
	if !ok {
		return
	}
	info, found := provider.GetProviderInfo(req.From)
	if !found {
		handlers.WriteError(w, r, http.StatusBadRequest, fmt.Sprintf("Unknown provider %q", req.From))
		return
	}
	var next *provider.Successor
	if info.Successor != nil {
		next = info.Successor(r.Context())
	}
	if next == nil {
		handlers.WriteError(w, r, http.StatusConflict, info.DisplayName+" no longer needs switching.")
		return
	}
	if _, ok := provider.GetProviderInfo(next.Provider); !ok {
		handlers.WriteError(w, r, http.StatusConflict, fmt.Sprintf("Provider %q is not available in this build.", next.Provider))
		return
	}
	if err := s.switchProvider(req.From, next); err != nil {
		handlers.WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	s.RefreshProviders()
	handlers.WriteSuccess(w, r, map[string]any{"provider": next.Provider})
}

// switchProvider carries the user's setup from one provider to its successor
// and swaps which of the two is switched on.
//
// What moves is what the user set up for the models: the successor is pointed
// at the same server, and receives the per-model limits and hidden models, and
// the default and cheap model selections naming the old provider. The model ids
// are the server's own, so they mean the same models under either provider.
// Where the successor already has a preference for a model, that one stays: it
// was set for the provider now taking over.
//
// The old provider's preferences are copied, not moved, so switching it back
// on loses nothing. Conversations are not touched. Each records its model in
// its own document, owned by its own worker, and nothing spans those writes;
// rewriting them would also make the history misstate which provider served
// the turns already taken. A conversation left on the old provider asks for
// another model on its next send, through the same prompt any switched-off
// provider gets.
func (s *Server) switchProvider(from string, next *provider.Successor) error {
	to := next.Provider
	if next.Adopt != nil {
		if err := next.Adopt(); err != nil {
			return fmt.Errorf("couldn't point %s at the same server: %w", to, err)
		}
	}

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		return carryModelSettings(&gs.Models, from, to)
	}); err != nil {
		return fmt.Errorf("couldn't carry the model settings across: %w", err)
	}
	if s.settings != nil {
		s.settings.reloadFromDisk()
	}

	if store, err := core.NewDefaultModelStore(); err != nil {
		jlog.Error("switchProvider: default-model store: %v", err)
	} else if ref, err := store.Load(); err == nil && ref.Provider == from {
		ref.Provider = to
		if err := store.Save(ref); err != nil {
			jlog.Error("switchProvider: couldn't repoint the default model: %v", err)
		}
	}
	if store, err := core.NewCheapModelStore(); err != nil {
		jlog.Error("switchProvider: cheap-model store: %v", err)
	} else if setting, err := store.Load(); err == nil && setting.Provider == from {
		setting.Provider = to
		if err := store.Save(setting); err != nil {
			jlog.Error("switchProvider: couldn't repoint the cheap model: %v", err)
		}
	}

	creds, err := core.NewCredentialsStore()
	if err != nil {
		return err
	}
	// The successor goes on before the old provider goes off, so a failure
	// between the two leaves both listed rather than neither.
	if err := creds.SetProviderEnabled(to, true); err != nil {
		return fmt.Errorf("couldn't switch %s on: %w", to, err)
	}
	if err := creds.SetProviderEnabled(from, false); err != nil {
		return fmt.Errorf("couldn't switch %s off: %w", from, err)
	}
	return nil
}

// carryModelSettings copies from's per-model limits and hidden models to to,
// keeping any limit to already has for the same model. Reports whether
// anything changed.
func carryModelSettings(ms *core.ModelSettings, from, to string) bool {
	changed := false
	for modelID, limits := range ms.Limits[from] {
		if _, own := ms.Limits[to][modelID]; own {
			continue
		}
		if ms.Limits == nil {
			ms.Limits = map[string]map[string]core.ModelLimits{}
		}
		if ms.Limits[to] == nil {
			ms.Limits[to] = map[string]core.ModelLimits{}
		}
		ms.Limits[to][modelID] = limits
		changed = true
	}
	for _, modelID := range ms.Hidden[from] {
		if slices.Contains(ms.Hidden[to], modelID) {
			continue
		}
		if ms.Hidden == nil {
			ms.Hidden = map[string][]string{}
		}
		ms.Hidden[to] = append(ms.Hidden[to], modelID)
		changed = true
	}
	if changed {
		slices.Sort(ms.Hidden[to])
	}
	return changed
}

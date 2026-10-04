//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net/http"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
)

// handleGetSystemPromptPresets returns the user's saved presets and the chosen
// default preset id. Built-in presets are NOT included — they live in the
// frontend; the client merges the two. An empty defaultId means the client
// should fall back to the built-in `default` preset.
//
//	GET /api/system-prompt-presets → {presets: [{id,name,content}], defaultId}
func (s *Server) handleGetSystemPromptPresets(w http.ResponseWriter, r *http.Request) {
	presets, defaultID, err := s.systemPromptPresetStore.Load()
	if err != nil {
		handlers.WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't load system prompt presets: %v", err))
		return
	}
	handlers.WriteJSON(w, r, 0, map[string]any{
		"presets":   presets,
		"defaultId": defaultID,
	})
}

// handleCreateSystemPromptPreset saves the current prompt body as a new named
// user preset and returns it (with its generated id).
//
//	POST /api/system-prompt-presets {name, content} → {success, preset}
func (s *Server) handleCreateSystemPromptPreset(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}](w, r)
	if !ok {
		return
	}
	preset, err := s.systemPromptPresetStore.Create(req.Name, req.Content)
	if err != nil {
		handlers.WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	handlers.WriteSuccess(w, r, map[string]any{"preset": preset})
}

// handleDeleteSystemPromptPreset removes a user preset by id (idempotent).
//
//	DELETE /api/system-prompt-presets/{id} → {success}
func (s *Server) handleDeleteSystemPromptPreset(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if err := s.systemPromptPresetStore.Delete(id); err != nil {
		handlers.WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't delete preset: %v", err))
		return
	}
	handlers.WriteSuccess(w, r, nil)
}

// handleUpdateSystemPromptPreset replaces the name and content of an existing
// user preset by id.
//
//	PUT /api/system-prompt-presets/{id} {name, content} → {success, preset}
func (s *Server) handleUpdateSystemPromptPreset(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	req, ok := handlers.DecodeJSON[struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}](w, r)
	if !ok {
		return
	}
	preset, err := s.systemPromptPresetStore.Update(id, req.Name, req.Content)
	if err != nil {
		handlers.WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	handlers.WriteSuccess(w, r, map[string]any{"preset": preset})
}

// handleSetDefaultSystemPromptPreset records which preset (built-in or user) new
// conversations are seeded from. An empty id clears the explicit default.
//
//	PUT /api/system-prompt-presets/default {id} → {success}
func (s *Server) handleSetDefaultSystemPromptPreset(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		ID string `json:"id"`
	}](w, r)
	if !ok {
		return
	}
	if err := s.systemPromptPresetStore.SetDefault(req.ID); err != nil {
		handlers.WriteError(w, r, http.StatusInternalServerError, fmt.Sprintf("Couldn't set default preset: %v", err))
		return
	}
	handlers.WriteSuccess(w, r, nil)
}

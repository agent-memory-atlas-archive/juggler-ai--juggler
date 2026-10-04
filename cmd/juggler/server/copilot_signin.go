//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

// GitHub Copilot device-flow sign-in endpoints. The frontend (providers tab)
// calls start once, shows the user code, then polls until authorized; a
// successful authorization or a sign-out triggers a provider refresh so the
// Copilot row flips state without a manual reload.

// handleCopilotDeviceStart begins the OAuth device flow (against the requested
// GitHub host, defaulting to github.com) and returns the user code + verification
// URL for the UI to display. The resolved host is echoed back so the client sends
// the same one when polling.
func (s *Server) handleCopilotDeviceStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
	}
	// Body is optional: no host means github.com.
	_ = json.NewDecoder(r.Body).Decode(&req)
	code, err := core.StartCopilotDeviceLogin(r.Context(), req.Host)
	if err != nil {
		handlers.WriteError(w, r, http.StatusBadGateway, err.Error())
		return
	}
	handlers.WriteSuccess(w, r, map[string]any{
		"host":            req.Host,
		"deviceCode":      code.DeviceCode,
		"userCode":        code.UserCode,
		"verificationUri": code.VerificationURI,
		"expiresIn":       code.ExpiresIn,
		"interval":        code.Interval,
	})
}

// handleCopilotDevicePoll performs one poll for the pending device code. On
// authorization it refreshes the provider list before responding.
func (s *Server) handleCopilotDevicePoll(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		DeviceCode string `json:"deviceCode"`
		Host       string `json:"host"`
	}](w, r)
	if !ok {
		return
	}
	status, err := core.PollCopilotDeviceLogin(r.Context(), req.Host, req.DeviceCode)
	if err != nil {
		handlers.WriteError(w, r, http.StatusBadGateway, err.Error())
		return
	}
	if status == core.CopilotLoginAuthorized {
		s.RefreshProviders()
	}
	handlers.WriteSuccess(w, r, map[string]any{
		"status": string(status),
	})
}

// handleCopilotSignOut clears a Juggler device-flow login and refreshes the
// provider list. It does not disturb an editor-managed login on disk.
func (s *Server) handleCopilotSignOut(w http.ResponseWriter, r *http.Request) {
	if err := core.SignOutCopilot(); err != nil {
		handlers.WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	s.RefreshProviders()
	handlers.WriteSuccess(w, r, nil)
}

// handleCopilotGetHost returns the GitHub host Copilot logins target (github.com
// or the saved *.ghe.com Enterprise Cloud tenant), so the UI can prefill it.
func (s *Server) handleCopilotGetHost(w http.ResponseWriter, r *http.Request) {
	handlers.WriteSuccess(w, r, map[string]any{
		"host": core.CopilotHost(),
	})
}

// handleCopilotSetHost saves the preferred GitHub host (a *.ghe.com tenant, or
// github.com to reset to the public default) and refreshes the provider list so
// the Copilot row re-evaluates against the new host.
func (s *Server) handleCopilotSetHost(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		Host string `json:"host"`
	}](w, r)
	if !ok {
		return
	}
	if err := core.SetCopilotHost(req.Host); err != nil {
		handlers.WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	s.RefreshProviders()
	handlers.WriteSuccess(w, r, map[string]any{
		"host": core.CopilotHost(),
	})
}

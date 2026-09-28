//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
)

// expandTilde replaces a leading "~" with the current user's home directory.
func expandTilde(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return home + path[1:]
		}
	}
	return path
}

// ProjectAPI exposes endpoints for opening, closing, and listing recent
// project folders. It delegates the actual switch to a callback so the
// server's project-state lifecycle stays out of the handler layer.
type ProjectAPI struct {
	pathProvider  func() string
	switchFn      func(path string) error
	checkLockedFn func(path string) (bool, *core.InstanceInfo, error)
	recents       *core.RecentsStore
}

// NewProjectAPI creates a new ProjectAPI.
//   - pathProvider returns the currently-loaded project path ("" if none).
//   - switchFn is called with the desired project path ("" to clear) and
//     should perform the live swap. Errors propagate to the HTTP response.
func NewProjectAPI(pathProvider func() string, switchFn func(path string) error, recents *core.RecentsStore) *ProjectAPI {
	return &ProjectAPI{
		pathProvider:  pathProvider,
		switchFn:      switchFn,
		checkLockedFn: core.CheckProjectLocked,
		recents:       recents,
	}
}

// HandleGetProject returns the current project path.
// GET /api/project
func (api *ProjectAPI) HandleGetProject(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, map[string]any{
		"projectPath": api.pathProvider(),
	})
}

// HandlePostProject opens (or switches to) a project folder.
// POST /api/project  { "path": "/abs/or/relative/path" }
func (api *ProjectAPI) HandlePostProject(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Path string `json:"path"`
	}](w, r)
	if !ok {
		return
	}
	if req.Path == "" {
		WriteError(w, r, http.StatusBadRequest, "path is required")
		return
	}

	abs, err := filepath.Abs(expandTilde(req.Path))
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}

	api.switchAndRespond(w, r, abs)
}

// switchAndRespond performs the live project swap, records the folder in
// recents, and answers with the absolute path. Shared by opening an existing
// folder and creating a new one, so both report the same errors the same way.
func (api *ProjectAPI) switchAndRespond(w http.ResponseWriter, r *http.Request, abs string) {
	if err := api.switchFn(abs); err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, core.ErrProjectNotFound), errors.Is(err, core.ErrProjectNotDir):
			status = http.StatusBadRequest
		case errors.Is(err, core.ErrProjectLocked):
			status = http.StatusConflict
		}
		WriteError(w, r, status, err.Error())
		return
	}

	if api.recents != nil {
		_ = api.recents.Add(abs)
	}

	WriteJSON(w, r, 0, map[string]any{"projectPath": abs})
}

// HandleNewProject creates a folder and opens it as the project, so starting
// from nothing does not mean leaving the app to make a folder by hand.
// POST /api/project/new  { "parent": "/abs/or/~/path", "name": "myapp" }
func (api *ProjectAPI) HandleNewProject(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}](w, r)
	if !ok {
		return
	}

	if strings.TrimSpace(req.Parent) == "" {
		WriteError(w, r, http.StatusBadRequest, "parent is required")
		return
	}

	// The name must land directly inside the parent the user named. A separator
	// would put it somewhere else entirely, and "." or ".." name the parent
	// itself — none of which is what the field in front of them asked for.
	name := strings.TrimSpace(req.Name)
	switch {
	case name == "":
		WriteError(w, r, http.StatusBadRequest, "name is required")
		return
	case name == "." || name == "..":
		WriteError(w, r, http.StatusBadRequest, "name must be a folder name, not a path")
		return
	case strings.ContainsAny(name, `/\`):
		WriteError(w, r, http.StatusBadRequest, "name cannot contain a slash — it is created inside the parent folder")
		return
	}

	parent, err := filepath.Abs(expandTilde(req.Parent))
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(parent)
	switch {
	case os.IsNotExist(err):
		WriteError(w, r, http.StatusBadRequest, "parent folder not found: "+parent)
		return
	case err != nil:
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	case !info.IsDir():
		WriteError(w, r, http.StatusBadRequest, "parent is not a folder: "+parent)
		return
	}

	// Mkdir, never MkdirAll: one level, inside a parent already proven to be
	// there. A mistyped parent has to fail in front of the user rather than
	// quietly grow a tree of empty folders they will never find again.
	abs := filepath.Join(parent, name)
	if err := os.Mkdir(abs, 0o755); err != nil {
		if os.IsExist(err) {
			// Not silently adopted: they asked to create something new, and
			// opening a folder that is already full of someone else's work is a
			// different decision, taken with the picker in front of them.
			WriteError(w, r, http.StatusConflict, "there is already something called "+name+" in "+parent)
			return
		}
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	// The folder stays if the swap fails — it was created exactly as asked, and
	// deleting it would discard a thing the user can see and now expects.
	api.switchAndRespond(w, r, abs)
}

// HandleCheckProject validates whether a path exists and is a directory, without switching.
// GET /api/project/check?path=...
func (api *ProjectAPI) HandleCheckProject(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	if raw == "" {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": "path is required"})
		return
	}
	abs, err := filepath.Abs(expandTilde(raw))
	if err != nil {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": err.Error()})
		return
	}
	info, err := os.Stat(abs)
	if os.IsNotExist(err) {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": "path not found"})
		return
	}
	if err != nil {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": err.Error()})
		return
	}
	if !info.IsDir() {
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": "not a directory"})
		return
	}

	// The current project's lock is held by this very instance, not a competing
	// one, so report it as current instead of falsely blocking in-place
	// (browser/PWA) switches with "Already open at http://…/".
	if current := api.pathProvider(); current != "" && current == abs {
		WriteJSON(w, r, 0, map[string]any{"valid": true, "path": abs, "current": true})
		return
	}

	// Check whether another instance already has this project open.
	if locked, existing, _ := api.checkLockedFn(abs); locked {
		msg := "Already open in another Juggler instance"
		if existing != nil {
			isRunning, _ := core.VerifyInstance(existing, abs)
			if isRunning {
				msg = fmt.Sprintf("Already open at http://%s:%d/", existing.Host, existing.Port)
			}
		}
		WriteJSON(w, r, 0, map[string]any{"valid": false, "error": msg, "locked": true})
		return
	}

	WriteJSON(w, r, 0, map[string]any{"valid": true, "path": abs})
}

// HandleDeleteProject closes the current project (returns to no-project mode).
// DELETE /api/project
func (api *ProjectAPI) HandleDeleteProject(w http.ResponseWriter, r *http.Request) {
	if err := api.switchFn(""); err != nil {
		WriteError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, r, 0, map[string]any{"projectPath": ""})
}

// HandleGetRecents returns the user's recents list (most-recent first).
// GET /api/recents
func (api *ProjectAPI) HandleGetRecents(w http.ResponseWriter, r *http.Request) {
	paths := []string{}
	if api.recents != nil {
		// Prune folders that have since been deleted/moved so the picker never
		// offers a dead path (and the persisted list self-heals over time).
		if loaded, err := api.recents.Prune(); err == nil {
			paths = loaded
		}
	}
	if paths == nil {
		paths = []string{}
	}
	WriteJSON(w, r, 0, map[string]any{"paths": paths})
}

// HandleDeleteRecent removes one path from the recents list.
// DELETE /api/recents  { "path": "/abs/path" }
func (api *ProjectAPI) HandleDeleteRecent(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[struct {
		Path string `json:"path"`
	}](w, r)
	if !ok {
		return
	}
	if api.recents != nil {
		_ = api.recents.Remove(req.Path)
	}
	w.WriteHeader(http.StatusNoContent)
}

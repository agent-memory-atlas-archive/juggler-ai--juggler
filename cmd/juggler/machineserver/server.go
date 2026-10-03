//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package machineserver implements `juggler serve`: the persistent, per-machine
// supervisor + broker. It owns a registry of per-project session children
// (today's server, spawned with --session-child), a single client-facing
// endpoint that reverse-proxies /s/<id>/… to the owning child, and a control
// API to list/spawn/stop sessions. It is a plain HTTP process: no engine, no
// webview, no providers.
package machineserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// Server is the machine server: registry, control API, and session proxy.
type Server struct {
	reg         *registry
	lock        *MachineLock
	childBin    string
	addr        string
	startedAt   time.Time
	httpSrv     *http.Server
	shutdownReq chan struct{} // control-API shutdown signal (buffered, len 1)
	// testChildren (serve --test) spawns every child as a test server whose
	// test window loads its session through this server's proxy. Test
	// binaries only: a production-tagged child panics on --test.
	testChildren bool
}

// childExtraArgs returns the flags a session child gets beyond the fixed
// ones. Under --test, each child runs the test harness in a window pointed at
// its own session URL here, so a browser test drives it through the proxy.
func (s *Server) childExtraArgs(sessionID string) []string {
	if !s.testChildren {
		return nil
	}
	return []string{"--test", "--assets-from-disk",
		"--test-window-url", "http://" + s.addr + "/s/" + sessionID + "/"}
}

// routes builds the machine server's handler: the control API under
// /api/server, plus the /s/<id>/ session proxy. Everything is wrapped in the
// origin guard so a drive-by page on another origin can't drive the control
// API or ride the proxy.
func (s *Server) routes() http.Handler {
	r := mux.NewRouter()
	api := r.PathPrefix("/api/server").Subrouter()
	api.HandleFunc("/status", s.handleStatus).Methods("GET")
	api.HandleFunc("/sessions", s.handleListSessions).Methods("GET")
	api.HandleFunc("/sessions", s.handleOpenSession).Methods("POST")
	api.HandleFunc("/sessions/{id}", s.handleStopSession).Methods("DELETE")
	api.HandleFunc("/shutdown", s.handleShutdown).Methods("POST")
	r.HandleFunc("/s/{id}", s.redirectSession)
	r.PathPrefix("/s/{id}/").HandlerFunc(s.handleSessionProxy)
	return originGuard(r)
}

// originGuard rejects browser requests whose Origin is a different host. A
// request with no Origin (curl, the desktop app, same-origin fetches without
// one) passes; a cross-origin page's fetch/POST against the loopback control
// API is refused. The session children keep their own per-instance API-token
// auth behind the proxy — this guard is the machine server's own surface.
func originGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			if err != nil || u.Host != r.Host {
				http.Error(w, "cross-origin request rejected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// statusResponse is the GET /api/server/status payload — the machine-scope
// analogue of a child's /api/health/instance, used by discovery to classify a
// lock holder as healthy or stale.
type statusResponse struct {
	Status    string    `json:"status"`
	PID       int       `json:"pid"`
	Addr      string    `json:"addr"`
	Version   string    `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	Sessions  int       `json:"sessions"`
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, statusResponse{
		Status:    "ok",
		PID:       os.Getpid(),
		Addr:      s.addr,
		Version:   core.Version,
		StartedAt: s.startedAt,
		Sessions:  len(s.reg.snapshot()),
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.reg.snapshot())
}

// handleOpenSession spawns (or reuses) the session child for a project.
// POST /api/server/sessions {"project": "/abs/or/relative/path"}.
// Reuse returns the live record; a fresh spawn blocks until the child reports
// its address (bounded by childStartTimeout) and returns 201.
func (s *Server) handleOpenSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Project string `json:"project"`
	}
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	project, err := resolveProject(req.Project)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	sess, created := s.reg.reserve(project)
	if !created {
		// A running child, or a spawn already in flight (state "starting" —
		// the caller polls the sessions list until it flips).
		writeJSON(w, http.StatusOK, sess)
		return
	}

	c, err := spawnChild(s.childBin, project, s.childExtraArgs(sess.ID))
	if err != nil {
		jlog.Error("[machineserver] spawn failed for %s: %v", project, err)
		s.reg.setError(sess.ID, err.Error())
		errSess, _ := s.reg.get(sess.ID)
		writeJSON(w, http.StatusBadGateway, errSess)
		return
	}
	if !s.reg.setRunning(sess.ID, c, c.cmd.Process.Pid) {
		// The reservation vanished while we were spawning — don't leak an
		// unsupervised child.
		c.stop()
		http.Error(w, "session was removed during spawn", http.StatusConflict)
		return
	}
	// Surface an unexpected child exit in the registry. A supervised stop
	// (beginStop) is exempt inside noteExit.
	go func() {
		<-c.exited
		s.reg.noteExit(sess.ID)
	}()
	go s.pollActivity(sess.ID, c, activityPollInterval)
	jlog.Info("[machineserver] session %s: %s at %s (pid %d)", sess.ID, project, c.addr, c.cmd.Process.Pid)
	sess, _ = s.reg.get(sess.ID)
	writeJSON(w, http.StatusCreated, sess)
}

// handleStopSession stops a session child and drops its registry entry.
// DELETE /api/server/sessions/{id}.
func (s *Server) handleStopSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if c, ok := s.reg.beginStop(id); ok {
		c.stop()
		s.reg.remove(id)
		jlog.Info("[machineserver] session %s stopped", id)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	sess, ok := s.reg.get(id)
	if !ok {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	if sess.State == SessionStarting {
		// Its spawner still holds the reservation; removing it now would leak
		// the child the spawner is about to register.
		http.Error(w, "session is still starting", http.StatusConflict)
		return
	}
	// No live child (an errored entry) — just drop the record.
	s.reg.remove(id)
	w.WriteHeader(http.StatusNoContent)
}

// handleShutdown asks the whole machine server to shut down gracefully.
// Responds 202 first; the run loop drains children after.
func (s *Server) handleShutdown(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusAccepted)
	select {
	case s.shutdownReq <- struct{}{}:
	default:
	}
}

// stopAllChildren stops every session child concurrently and waits for them.
// Part of server shutdown: called after the HTTP listener stops accepting.
func (s *Server) stopAllChildren() {
	done := make(chan struct{})
	n := 0
	for _, sess := range s.reg.snapshot() {
		c, ok := s.reg.beginStop(sess.ID)
		if !ok {
			s.reg.remove(sess.ID)
			continue
		}
		n++
		go func(id string, c *child) {
			c.stop()
			s.reg.remove(id)
			done <- struct{}{}
		}(sess.ID, c)
	}
	for range n {
		<-done
	}
}

// resolveProject validates a control-API project path: absolute-ized, must
// exist, must be a directory. Mirrors the --project validation in the child.
func resolveProject(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("project path is required")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("project %s: %w", p, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("project %s: %w", abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("project %s: not a directory", abs)
	}
	return abs, nil
}

// childBinPath locates the binary to spawn session children from:
// $JUGGLER_SERVER_BIN if set (dev/test override), else our own executable —
// the machine server and the session child are the same binary.
func childBinPath() (string, error) {
	if env := os.Getenv("JUGGLER_SERVER_BIN"); env != "" {
		return env, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot locate own executable to spawn session children: %w", err)
	}
	return exe, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		jlog.Error("[machineserver] failed to encode response: %v", err)
	}
}

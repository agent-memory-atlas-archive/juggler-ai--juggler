//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// newProjectTestAPI builds a ProjectAPI with no recents store and a switchFn
// that records what it was asked to open, so a test can tell "created and
// opened" from "created but never opened" — and, for the rejection cases, prove
// the refusal happened before anything was switched.
func newProjectTestAPI() (*ProjectAPI, *[]string) {
	var opened []string
	api := NewProjectAPI(
		func() string { return "" },
		func(path string) error {
			opened = append(opened, path)
			return nil
		},
		nil,
	)
	return api, &opened
}

// serveNewProject posts a create request and returns the recorder. A nil body
// field is omitted so a test can send a partial request.
func serveNewProject(api *ProjectAPI, parent, name string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"parent": parent, "name": name})
	req := httptest.NewRequest(http.MethodPost, "/api/project/new", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	api.HandleNewProject(rec, req)
	return rec
}

// TestNewProjectCreatesAndOpens is the happy path: the folder appears on disk,
// the project is switched to it, and the absolute path comes back.
func TestNewProjectCreatesAndOpens(t *testing.T) {
	api, opened := newProjectTestAPI()
	parent := t.TempDir()

	rec := serveNewProject(api, parent, "myapp")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}

	want := filepath.Join(parent, "myapp")
	info, err := os.Stat(want)
	if err != nil {
		t.Fatalf("stat %q: %v", want, err)
	}
	if !info.IsDir() {
		t.Errorf("%q is not a directory", want)
	}

	var resp struct {
		ProjectPath string `json:"projectPath"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	if resp.ProjectPath != want {
		t.Errorf("projectPath = %q, want %q", resp.ProjectPath, want)
	}
	if len(*opened) != 1 || (*opened)[0] != want {
		t.Errorf("switched to %v, want exactly [%q]", *opened, want)
	}
}

// TestNewProjectRejectsUnusableNames covers every name that must never reach
// os.Mkdir. A separator is the dangerous one: it would silently create (or
// target) somewhere other than directly inside the parent the user named.
func TestNewProjectRejectsUnusableNames(t *testing.T) {
	cases := []struct {
		label string
		name  string
	}{
		{"empty", ""},
		{"whitespace only", "   "},
		{"current dir", "."},
		{"parent dir", ".."},
		{"forward slash", "sub/app"},
		{"backslash", `sub\app`},
		{"leading slash", "/app"},
		{"trailing slash", "app/"},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			api, opened := newProjectTestAPI()
			parent := t.TempDir()

			rec := serveNewProject(api, parent, tc.name)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
			}
			if len(*opened) != 0 {
				t.Errorf("switched to %v, want no switch on a rejected name", *opened)
			}

			entries, err := os.ReadDir(parent)
			if err != nil {
				t.Fatalf("readdir: %v", err)
			}
			if len(entries) != 0 {
				t.Errorf("parent gained %d entries, want the folder left untouched", len(entries))
			}
		})
	}
}

// TestNewProjectRejectsMissingParent refuses a parent that is not there, and —
// the point of the test — proves it did not conjure one. os.MkdirAll would
// happily build the whole chain from a typo.
func TestNewProjectRejectsMissingParent(t *testing.T) {
	api, opened := newProjectTestAPI()
	base := t.TempDir()
	parent := filepath.Join(base, "typo", "deeper")

	rec := serveNewProject(api, parent, "myapp")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if len(*opened) != 0 {
		t.Errorf("switched to %v, want no switch", *opened)
	}
	if _, err := os.Stat(filepath.Join(base, "typo")); !os.IsNotExist(err) {
		t.Errorf("the missing parent was created; want a mistyped parent to fail loudly")
	}
}

// TestNewProjectRejectsFileParent: a parent that exists but is a file.
func TestNewProjectRejectsFileParent(t *testing.T) {
	api, opened := newProjectTestAPI()
	base := t.TempDir()
	parent := filepath.Join(base, "notadir.txt")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	rec := serveNewProject(api, parent, "myapp")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if len(*opened) != 0 {
		t.Errorf("switched to %v, want no switch", *opened)
	}
}

// TestNewProjectRejectsExisting: the folder is already there. This must not
// quietly become "open it" — the user asked to create something new, and
// adopting a stranger's folder is a different act with different consequences.
func TestNewProjectRejectsExisting(t *testing.T) {
	api, opened := newProjectTestAPI()
	parent := t.TempDir()
	existing := filepath.Join(parent, "myapp")
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(existing, "keep.txt"), []byte("mine"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	rec := serveNewProject(api, parent, "myapp")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %q)", rec.Code, rec.Body.String())
	}
	if len(*opened) != 0 {
		t.Errorf("switched to %v, want no switch onto an existing folder", *opened)
	}
	if _, err := os.Stat(filepath.Join(existing, "keep.txt")); err != nil {
		t.Errorf("existing contents disturbed: %v", err)
	}
}

// TestNewProjectRequiresParent: an omitted parent is a client bug, not a cue to
// guess at the working directory.
func TestNewProjectRequiresParent(t *testing.T) {
	api, opened := newProjectTestAPI()

	rec := serveNewProject(api, "", "myapp")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if len(*opened) != 0 {
		t.Errorf("switched to %v, want no switch", *opened)
	}
}

// TestNewProjectExpandsTilde: the parent goes through the same ~ expansion the
// open and check endpoints use, so a typed "~" means the same thing everywhere.
// Home is redirected at a temp dir, so the real one is never written to.
func TestNewProjectExpandsTilde(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir on Windows

	api, opened := newProjectTestAPI()

	rec := serveNewProject(api, "~", "myapp")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}

	want := filepath.Join(home, "myapp")
	if info, err := os.Stat(want); err != nil {
		t.Fatalf("stat %q: %v", want, err)
	} else if !info.IsDir() {
		t.Errorf("%q is not a directory", want)
	}
	if len(*opened) != 1 || (*opened)[0] != want {
		t.Errorf("switched to %v, want exactly [%q]", *opened, want)
	}
}

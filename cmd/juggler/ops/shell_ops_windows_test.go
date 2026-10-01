//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestWindowsShellResolvesAndRuns is the regression test for the
// WSL-not-installed failure: on a Windows host with any POSIX shell available
// (WSL with a distro, or Git for Windows), an approved command must actually
// run — not fail through the bare wsl.exe stub. GitHub-hosted windows runners
// ship Git for Windows, so this exercises the git-bash fallback there.
func TestWindowsShellResolvesAndRuns(t *testing.T) {
	if winShell().shell == nil {
		t.Skip("no POSIX shell on this host (neither WSL nor Git for Windows)")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))

	res, err := shellOps.Execute(context.Background(), "execute", map[string]any{
		"command": "echo hello",
	})
	if err != nil {
		t.Fatalf("execute echo failed: %v", err)
	}
	m := res.(map[string]any)
	if m["success"] != true {
		t.Fatalf("expected success=true, got %+v", m)
	}
	if out, _ := m["stdout"].(string); !strings.Contains(out, "hello") {
		t.Fatalf("expected stdout to contain %q, got %q", "hello", out)
	}
}

// TestShellCmdFrom_NoShellSurfacesActionableError verifies that when no POSIX
// shell resolves, command-start fails with the resolver's actionable message
// rather than a cryptic wsl.exe error. Uses a synthetic winPOSIX so the branch
// is exercised regardless of what the host actually has installed.
func TestShellCmdFrom_NoShellSurfacesActionableError(t *testing.T) {
	want := errors.New("no POSIX shell available: install WSL or Git for Windows")
	cmd := shellCmdFrom(context.Background(), winPOSIX{shellErr: want}, "echo hello")
	if err := cmd.Start(); !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want %v", err, want)
	}
}

// A WSL that is installed but slow or failing must not be reported as missing:
// "install WSL" sends a user with a working WSL the wrong way.
func TestNoShellError_TellsSlowWSLFromAbsentWSL(t *testing.T) {
	cases := []struct {
		name string
		wsl  wslProbe
		want string
	}{
		{"absent", wslProbe{}, "install WSL"},
		{"timed out", wslProbe{distros: []string{"Ubuntu"}, timedOut: true, err: errors.New("deadline")}, "not responding"},
		{"failing", wslProbe{distros: []string{"Ubuntu"}, err: errors.New("exit status 1")}, "cannot run a shell"},
	}
	for _, tc := range cases {
		if got := noShellError(tc.wsl).Error(); !strings.Contains(got, tc.want) {
			t.Errorf("%s: noShellError = %q, want it to contain %q", tc.name, got, tc.want)
		}
	}
}

func TestPythonCmdFrom_NoInterpreterSurfacesActionableError(t *testing.T) {
	want := errors.New("no Python interpreter available")
	cmd := pythonCmdFrom(context.Background(), winPOSIX{pythonErr: want})
	if err := cmd.Start(); !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want %v", err, want)
	}
}

func TestIsWindowsStoreStub(t *testing.T) {
	cases := map[string]bool{
		`C:\Users\me\AppData\Local\Microsoft\WindowsApps\python.exe`: true,
		`C:\Program Files\Python312\python.exe`:                      false,
		`C:\Windows\py.exe`:                                          false,
	}
	for path, want := range cases {
		if got := isWindowsStoreStub(path); got != want {
			t.Errorf("isWindowsStoreStub(%q) = %v, want %v", path, got, want)
		}
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// fakeProbeEnv builds a machine out of a set of present paths, environment
// variables and PATH-resolvable names. Paths are matched literally, so every
// expectation below is written with the same filepath.Join the probe uses and
// the host's separator cancels out on both sides.
func fakeProbeEnv(goos, home string, present []string, vars map[string]string, onPath ...string) appProbeEnv {
	presentSet := make(map[string]bool, len(present))
	for _, path := range present {
		presentSet[path] = true
	}
	pathSet := make(map[string]bool, len(onPath))
	for _, name := range onPath {
		pathSet[name] = true
	}
	return appProbeEnv{
		goos:   goos,
		home:   home,
		getenv: func(name string) string { return vars[name] },
		exists: func(path string) bool { return presentSet[path] },
		globAny: func(pattern string) bool {
			prefix, ok := strings.CutSuffix(pattern, "*")
			if !ok {
				return presentSet[pattern]
			}
			for path := range presentSet {
				if strings.HasPrefix(path, prefix) {
					return true
				}
			}
			return false
		},
		lookPath: func(name string) (string, error) {
			if pathSet[name] {
				return "/fake/" + name, nil
			}
			return "", errors.New("not found")
		},
	}
}

func TestProbeClaudeDesktopApp(t *testing.T) {
	const home = "/Users/tester"
	localAppData := filepath.Join("C:", "Users", "tester", "AppData", "Local")
	windowsVars := map[string]string{"LOCALAPPDATA": localAppData}

	tests := []struct {
		name    string
		env     appProbeEnv
		want    bool
		because string
	}{
		{
			name: "macOS system Applications",
			env:  fakeProbeEnv("darwin", home, []string{"/Applications/Claude.app"}, nil),
			want: true,
		},
		{
			name:    "macOS user Applications",
			env:     fakeProbeEnv("darwin", home, []string{filepath.Join(home, "Applications", "Claude.app")}, nil),
			want:    true,
			because: "an app dragged to ~/Applications is installed as far as its owner is concerned",
		},
		{
			name: "macOS absent",
			env:  fakeProbeEnv("darwin", home, []string{"/Applications/ChatGPT.app"}, nil),
			want: false,
		},
		{
			name:    "Windows MSIX package",
			env:     fakeProbeEnv("windows", home, []string{filepath.Join(localAppData, "Packages", claudeMSIXPackageDir)}, windowsVars),
			want:    true,
			because: "the package family name stands in for an AppX query we refuse to shell out for",
		},
		{
			name:    "Windows user-scope exe",
			env:     fakeProbeEnv("windows", home, []string{filepath.Join(localAppData, "AnthropicClaude", "claude.exe")}, windowsVars),
			want:    true,
			because: "the exe installer is user-scope, with ProductCode AnthropicClaude",
		},
		{
			name: "Windows absent",
			env:  fakeProbeEnv("windows", home, nil, windowsVars),
			want: false,
		},
		{
			name:    "Linux package binary",
			env:     fakeProbeEnv("linux", home, nil, nil, "claude-desktop"),
			want:    true,
			because: "the Debian package puts claude-desktop on PATH",
		},
		{
			name: "Linux absent",
			env:  fakeProbeEnv("linux", home, nil, nil, "claude"),
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := claudeDesktopInstalled(tc.env); got != tc.want {
				t.Fatalf("claudeDesktopInstalled() = %v, want %v (%s)", got, tc.want, tc.because)
			}
		})
	}
}

func TestProbeChatGPTApp(t *testing.T) {
	const home = "/Users/tester"
	localAppData := filepath.Join("C:", "Users", "tester", "AppData", "Local")
	windowsVars := map[string]string{"LOCALAPPDATA": localAppData}

	tests := []struct {
		name    string
		env     appProbeEnv
		want    bool
		because string
	}{
		{
			name: "macOS system Applications",
			env:  fakeProbeEnv("darwin", home, []string{"/Applications/ChatGPT.app"}, nil),
			want: true,
		},
		{
			name: "macOS user Applications",
			env:  fakeProbeEnv("darwin", home, []string{filepath.Join(home, "Applications", "ChatGPT.app")}, nil),
			want: true,
		},
		{
			name:    "macOS Claude only",
			env:     fakeProbeEnv("darwin", home, []string{"/Applications/Claude.app"}, nil),
			want:    false,
			because: "the two apps must not be confused for one another",
		},
		{
			name: "Windows Store package with publisher hash",
			env: fakeProbeEnv("windows", home, []string{
				filepath.Join(localAppData, "Packages", "OpenAI.Codex_kq2s9z4rj1vy8"),
			}, windowsVars),
			want:    true,
			because: "the package name is OpenAI.Codex even though the app is called ChatGPT",
		},
		{
			name: "Windows absent",
			env: fakeProbeEnv("windows", home, []string{
				filepath.Join(localAppData, "Packages", "SomethingElse_kq2s9z4rj1vy8"),
			}, windowsVars),
			want: false,
		},
		{
			name: "Linux package binary",
			env:  fakeProbeEnv("linux", home, nil, nil, "chatgpt"),
			want: true,
		},
		{
			name: "Linux absent",
			env:  fakeProbeEnv("linux", home, nil, nil),
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := chatGPTAppInstalled(tc.env); got != tc.want {
				t.Fatalf("chatGPTAppInstalled() = %v, want %v (%s)", got, tc.want, tc.because)
			}
		})
	}
}

func TestProbeCodexCLI(t *testing.T) {
	const home = "/Users/tester"

	tests := []struct {
		name    string
		env     appProbeEnv
		want    bool
		because string
	}{
		{
			name: "on PATH",
			env:  fakeProbeEnv("darwin", home, nil, nil, "codex"),
			want: true,
		},
		{
			name:    "installer default bin dir",
			env:     fakeProbeEnv("darwin", home, []string{filepath.Join(home, ".local", "bin", "codex")}, nil),
			want:    true,
			because: "a macOS GUI launch inherits a PATH that omits ~/.local/bin, so PATH alone misses a plain install",
		},
		{
			name: "standalone release under ~/.codex",
			env: fakeProbeEnv("darwin", home, []string{
				filepath.Join(home, ".codex", "packages", "standalone", "current", "bin", "codex"),
			}, nil),
			want: true,
		},
		{
			name: "CODEX_HOME override",
			env: fakeProbeEnv("darwin", home, []string{
				filepath.Join("/opt/codexhome", "packages", "standalone", "current", "bin", "codex"),
			}, map[string]string{"CODEX_HOME": "/opt/codexhome"}),
			want:    true,
			because: "the official installer honours CODEX_HOME, so a user who set it is still found",
		},
		{
			name: "CODEX_INSTALL_DIR override",
			env: fakeProbeEnv("darwin", home, []string{filepath.Join("/opt/bin", "codex")},
				map[string]string{"CODEX_INSTALL_DIR": "/opt/bin"}),
			want: true,
		},
		{
			name: "homebrew",
			env:  fakeProbeEnv("darwin", home, []string{"/opt/homebrew/bin/codex"}, nil),
			want: true,
		},
		{
			name:    "absent",
			env:     fakeProbeEnv("darwin", home, []string{filepath.Join(home, ".local", "bin", "claude")}, nil),
			want:    false,
			because: "the claude CLI being present says nothing about codex",
		},
		{
			name:    "Windows npm shim",
			env:     fakeProbeEnv("windows", home, []string{filepath.Join(`C:\Roaming`, "npm", "codex.cmd")}, map[string]string{"APPDATA": `C:\Roaming`}),
			want:    true,
			because: "the npm global install is a .cmd shim, not an exe",
		},
		{
			name: "Windows installer bin dir",
			env:  fakeProbeEnv("windows", home, []string{filepath.Join(home, ".local", "bin", "codex.exe")}, nil),
			want: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexCLIInstalled(tc.env); got != tc.want {
				t.Fatalf("codexCLIInstalled() = %v, want %v (%s)", got, tc.want, tc.because)
			}
		})
	}
}

// TestProbeInstalledAppsNoHome pins the degenerate machine: no home directory
// resolved, nothing on PATH, no environment. Every home-rooted candidate must
// drop out rather than being probed as a relative path.
func TestProbeInstalledAppsNoHome(t *testing.T) {
	got := probeInstalledApps(fakeProbeEnv("darwin", "", nil, nil))
	if got != (InstalledApps{}) {
		t.Fatalf("probeInstalledApps on an empty machine = %+v, want every field false", got)
	}
}

// TestProbeInstalledAppsReadsRealMachine is a smoke test over the real seam: it
// asserts nothing about what is installed, only that reading the actual machine
// neither panics nor blocks.
func TestProbeInstalledAppsReadsRealMachine(t *testing.T) {
	_ = ProbeInstalledApps()
}

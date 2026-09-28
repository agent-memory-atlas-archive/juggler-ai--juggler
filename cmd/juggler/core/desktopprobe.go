//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// InstalledApps reports which vendor desktop apps and CLIs are present on the
// machine. It answers a different question from provider availability: a
// provider is available when Juggler can drive it, whereas these flags say what
// the user has installed, including things Juggler cannot drive at all.
//
// The Claude desktop app is the clearest case. It contains Claude Code as a tab
// of its own, so a user who has it reasonably believes Claude Code is installed
// — but Juggler drives the `claude` command-line tool, which is a separate
// download. Knowing the app is there is what lets setup say "you have the app,
// you also need the CLI" instead of "nothing found", which reads as a denial of
// something they can see on their dock.
type InstalledApps struct {
	ClaudeDesktopApp bool `json:"claudeDesktopApp"`
	ChatGPTApp       bool `json:"chatgptApp"`
	CodexCLI         bool `json:"codexCLI"`
}

// appProbeEnv is the seam the probe reads the machine through. The platform is a
// field rather than a build tag so every platform's rules are exercised on
// whichever one the tests happen to run on: these paths are the kind that rot
// quietly, and a Windows rule that only compiles on Windows is a rule nobody
// here ever runs.
type appProbeEnv struct {
	goos     string
	home     string
	getenv   func(string) string
	exists   func(string) bool
	globAny  func(string) bool
	lookPath func(string) (string, error)
}

func realAppProbeEnv() appProbeEnv {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return appProbeEnv{
		goos:   runtime.GOOS,
		home:   home,
		getenv: os.Getenv,
		exists: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		globAny: func(pattern string) bool {
			matches, err := filepath.Glob(pattern)
			return err == nil && len(matches) > 0
		},
		lookPath: exec.LookPath,
	}
}

// ProbeInstalledApps reads the machine for the vendor apps and CLIs that first-run
// setup asks about. Every check is a stat, a glob or a PATH lookup: nothing is
// launched and nothing is asked over the network, because this runs while the
// user is waiting for the window to appear.
func ProbeInstalledApps() InstalledApps {
	return probeInstalledApps(realAppProbeEnv())
}

func probeInstalledApps(env appProbeEnv) InstalledApps {
	return InstalledApps{
		ClaudeDesktopApp: claudeDesktopInstalled(env),
		ChatGPTApp:       chatGPTAppInstalled(env),
		CodexCLI:         codexCLIInstalled(env),
	}
}

// anyExists reports whether any of the paths is present, skipping the empty
// strings that an unset environment variable contributes.
func anyExists(env appProbeEnv, paths ...string) bool {
	for _, path := range paths {
		if path != "" && env.exists(path) {
			return true
		}
	}
	return false
}

// homeJoin builds a path under the user's home, or "" when there is no home to
// build it under, so it drops out of anyExists rather than resolving relative.
func homeJoin(env appProbeEnv, parts ...string) string {
	if env.home == "" {
		return ""
	}
	return filepath.Join(append([]string{env.home}, parts...)...)
}

// envJoin does the same for a path rooted at an environment variable.
func envJoin(env appProbeEnv, name string, parts ...string) string {
	root := env.getenv(name)
	if root == "" {
		return ""
	}
	return filepath.Join(append([]string{root}, parts...)...)
}

// claudeMSIXPackageDir is the per-user directory Windows creates for Claude's
// MSIX package, named from the package family name in Anthropic's winget
// manifest. Presence of the directory stands in for the package being installed,
// which avoids shelling out to PowerShell for an AppX query.
const claudeMSIXPackageDir = "Claude_pzs8sxrjxfjjc"

func claudeDesktopInstalled(env appProbeEnv) bool {
	switch env.goos {
	case "darwin":
		// Checked in both locations because an app dragged to a user-local
		// Applications folder is installed as far as its owner is concerned.
		return anyExists(env,
			"/Applications/Claude.app",
			homeJoin(env, "Applications", "Claude.app"),
		)
	case "windows":
		// Two supported install shapes: the MSIX package, and the user-scope exe
		// installer whose ProductCode is AnthropicClaude.
		return anyExists(env,
			envJoin(env, "LOCALAPPDATA", "Packages", claudeMSIXPackageDir),
			envJoin(env, "LOCALAPPDATA", "AnthropicClaude", "claude.exe"),
		)
	default:
		// The Linux build is a Debian package whose binary lands on PATH.
		_, err := env.lookPath("claude-desktop")
		return err == nil
	}
}

func chatGPTAppInstalled(env appProbeEnv) bool {
	switch env.goos {
	case "darwin":
		return anyExists(env,
			"/Applications/ChatGPT.app",
			homeJoin(env, "Applications", "ChatGPT.app"),
		)
	case "windows":
		// Store-only distribution, so there is no install directory to stat: the
		// per-user package directory is suffixed with a publisher hash, and the
		// package name is OpenAI.Codex even though the app is called ChatGPT.
		if pattern := envJoin(env, "LOCALAPPDATA", "Packages", "OpenAI.Codex_*"); pattern != "" {
			return env.globAny(pattern)
		}
		return false
	default:
		_, err := env.lookPath("chatgpt")
		return err == nil
	}
}

// codexCLIInstalled probes for the Codex CLI, which is a separate download from
// the ChatGPT app even though the two share a login. Setup distinguishes them
// because only one of them needs installing when the other is already there.
func codexCLIInstalled(env appProbeEnv) bool {
	name := "codex"
	if env.goos == "windows" {
		name = "codex.exe"
	}
	if _, err := env.lookPath("codex"); err == nil {
		return true
	}

	// CODEX_HOME and CODEX_INSTALL_DIR are the two overrides the official
	// installer honours, so a user who set either is still found.
	codexHome := env.getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = homeJoin(env, ".codex")
	}
	standalone := ""
	if codexHome != "" {
		standalone = filepath.Join(codexHome, "packages", "standalone", "current", "bin", name)
	}
	installDir := ""
	if dir := env.getenv("CODEX_INSTALL_DIR"); dir != "" {
		installDir = filepath.Join(dir, name)
	}

	if env.goos == "windows" {
		return anyExists(env,
			installDir,
			standalone,
			homeJoin(env, ".local", "bin", name),
			envJoin(env, "APPDATA", "npm", "codex.cmd"),
		)
	}
	// Mirrors the claude CLI's candidate list: a GUI launch on macOS inherits a
	// minimal PATH that omits every one of these directories, so the PATH lookup
	// above cannot be relied on to find an install that is plainly there.
	return anyExists(env,
		installDir,
		standalone,
		homeJoin(env, ".local", "bin", name),
		homeJoin(env, ".npm-global", "bin", name),
		"/opt/homebrew/bin/codex",
		"/usr/local/bin/codex",
	)
}

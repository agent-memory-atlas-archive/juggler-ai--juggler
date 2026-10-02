//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package claudecode

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// claudeInstallLocationsHint names the fallback install dirs probed when the
// claude CLI isn't on $PATH; used in the not-found error message. Kept in step
// with claudeBinaryCandidates.
const claudeInstallLocationsHint = "~/.local/bin, ~/.claude/local, ~/.npm-global/bin, bun, pnpm, volta, mise, asdf, nvm and fnm installs, /opt/homebrew/bin, /usr/local/bin"

// claudeBinaryCandidates lists absolute paths to probe for the claude CLI, in
// priority order. A GUI launch inherits a minimal PATH (typically just
// /usr/bin:/bin:/usr/sbin:/sbin); the login-shell probe at startup normally
// repairs it, and this list is what is left when that probe fails or the
// shell's rc files don't set up the version manager. So it covers the official
// installer's dirs, npm's, and each common JavaScript package or version
// manager's bin or shim dir — all user-local, so they come before the
// system-wide ones.
func claudeBinaryCandidates() []string {
	var candidates []string
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		for _, dir := range []string{
			".local/bin",
			".claude/local",
			".npm-global/bin",
			".bun/bin",
			".volta/bin",
			".local/share/pnpm", // pnpm on Linux
			"Library/pnpm",      // pnpm on macOS
			".local/share/mise/shims",
			".asdf/shims",
			".fnm/aliases/default/bin",
			".local/share/fnm/aliases/default/bin",
			"Library/Application Support/fnm/aliases/default/bin",
		} {
			candidates = append(candidates, filepath.Join(home, filepath.FromSlash(dir), "claude"))
		}
		candidates = append(candidates, nvmCandidates(home)...)
	}
	return append(candidates,
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	)
}

// nvmCandidates lists claude in each nvm-managed node, newest version first.
// nvm keeps one bin dir per installed node and has no stable "current" path
// outside a shell, so the newest is the best guess at the one in use — and
// the order is by version, since by name v9 sorts after v22.
func nvmCandidates(home string) []string {
	matches, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin", "claude"))
	version := func(p string) []int {
		name := filepath.Base(filepath.Dir(filepath.Dir(p))) // ".../node/<vX.Y.Z>/bin/claude"
		var parts []int
		for _, s := range strings.Split(strings.TrimPrefix(name, "v"), ".") {
			n, _ := strconv.Atoi(s)
			parts = append(parts, n)
		}
		return parts
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return slices.Compare(version(matches[i]), version(matches[j])) > 0
	})
	return matches
}

// isExecutableFile reports whether a probed candidate is runnable. On Unix that
// means at least one execute bit is set.
func isExecutableFile(info os.FileInfo) bool { return info.Mode()&0o111 != 0 }

// claudeCommand builds the exec.Cmd that launches the CLI. On Unix the binary
// is invoked directly.
func claudeCommand(ctx context.Context, bin string, args []string) *exec.Cmd {
	return exec.CommandContext(ctx, bin, args...)
}

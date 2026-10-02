//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// TestClaudeBinary_NonExecutableOverrideIgnored is Unix-only: it constructs a
// "non-executable" file by withholding the +x permission bit, then asserts the
// resolver rejects it. That premise has no Windows analogue — Windows has no
// +x bit (isExecutableFile is `!IsDir()`), so a plain 0644 file is considered
// runnable and the assertion can't hold there.
func TestClaudeBinary_NonExecutableOverrideIgnored(t *testing.T) {
	// An override that isn't a runnable file must not be returned; resolution
	// falls through to the normal search.
	userpathstest.Isolate(t)
	t.Setenv("SHELL", "")
	bogus := filepath.Join(t.TempDir(), "not-exec")
	if err := os.WriteFile(bogus, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(claudePathEnvVar, bogus)

	if got := claudeBinary(); got == bogus {
		t.Fatalf("claudeBinary() returned the non-executable override %q", got)
	}
}

// A symlink to a real executable must be accepted (os.Stat follows it), and a
// dangling symlink must be rejected. This covers the standard installs whose
// `claude` on PATH is a symlink (npm/nvm shims, homebrew, the native installer
// into ~/.local/bin).
func TestIsExecutablePath_Symlinks(t *testing.T) {
	dir := t.TempDir()
	real := writeExecutable(t, dir, "claude-real")

	link := filepath.Join(dir, "claude")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if !isExecutablePath(link) {
		t.Fatalf("isExecutablePath(%q -> %q) = false, want true", link, real)
	}

	dangling := filepath.Join(dir, "claude-dangling")
	if err := os.Symlink(filepath.Join(dir, "gone"), dangling); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if isExecutablePath(dangling) {
		t.Fatalf("isExecutablePath(%q -> missing) = true, want false", dangling)
	}
}

// TestClaudeBinaryCandidates_VersionManagers covers the installs a GUI launch
// misses when the login-shell PATH probe fails: claude installed with bun,
// pnpm, volta, mise or asdf, or into an nvm-managed node.
func TestClaudeBinaryCandidates_VersionManagers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	got := map[string]int{}
	for i, c := range claudeBinaryCandidates() {
		got[c] = i
	}
	for _, rel := range []string{
		".bun/bin/claude",
		".volta/bin/claude",
		".local/share/pnpm/claude",
		"Library/pnpm/claude",
		".local/share/mise/shims/claude",
		".asdf/shims/claude",
	} {
		if _, ok := got[filepath.Join(home, rel)]; !ok {
			t.Errorf("candidates omit ~/%s", rel)
		}
	}
}

// With several nvm-managed nodes the newest wins — by version, not by name,
// under which v9 would sort after v22 — and it is found with nothing on PATH.
func TestResolve_NewestNvmNodeWins(t *testing.T) {
	userpathstest.Isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "")
	var newest string
	for _, v := range []string{"v9.11.2", "v22.1.0", "v22.10.0"} {
		dir := filepath.Join(home, ".nvm", "versions", "node", v, "bin")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		bin := writeExecutable(t, dir, "claude")
		if v == "v22.10.0" {
			newest = bin
		}
	}

	if got := resolveClaudeBinary(); got != newest {
		t.Fatalf("resolveClaudeBinary() = %q, want the newest nvm node's %q", got, newest)
	}
}

// The env override and login-shell probe both accept a symlinked claude.
func TestResolve_SymlinkedClaudeAccepted(t *testing.T) {
	userpathstest.Isolate(t)
	dir := t.TempDir()
	real := writeExecutable(t, dir, "claude-real")
	link := filepath.Join(dir, "claude")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	t.Setenv("SHELL", "")
	t.Setenv(claudePathEnvVar, link)
	if got := claudeBinary(); got != link {
		t.Fatalf("claudeBinary() with symlink override = %q, want %q", got, link)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMergePath_LoginEntriesFirstThenCurrent(t *testing.T) {
	current := string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin"
	login := "/opt/homebrew/bin" + string(os.PathListSeparator) + "/usr/local/go/bin"
	got := mergePath(current, login)
	want := "/opt/homebrew/bin:/usr/local/go/bin:/usr/bin:/bin"
	if got != want {
		t.Fatalf("mergePath(%q, %q) = %q, want %q", current, login, got, want)
	}
}

// An entry present in both inputs appears only once, in its login position.
func TestMergePath_DeduplicatesByExactString(t *testing.T) {
	current := "/usr/bin:/bin:/opt/homebrew/bin"
	login := "/opt/homebrew/bin:/usr/local/go/bin"
	got := mergePath(current, login)
	want := "/opt/homebrew/bin:/usr/local/go/bin:/usr/bin:/bin"
	if got != want {
		t.Fatalf("mergePath(%q, %q) = %q, want %q", current, login, got, want)
	}
}

func TestMergePath_EmptyLoginReturnsCurrent(t *testing.T) {
	current := "/usr/bin:/bin"
	if got := mergePath(current, ""); got != current {
		t.Fatalf("mergePath(%q, \"\") = %q, want %q", current, got, current)
	}
}

func TestMergePath_EmptyCurrentReturnsLogin(t *testing.T) {
	login := "/opt/homebrew/bin:/usr/local/go/bin"
	if got := mergePath("", login); got != login {
		t.Fatalf("mergePath(\"\", %q) = %q, want %q", login, got, login)
	}
}

// Empty/whitespace-only entries (e.g. a leading "::") are dropped, not kept as
// the cwd-implying empty PATH element POSIX allows.
func TestMergePath_DropsEmptyEntries(t *testing.T) {
	current := ":/usr/bin:"
	login := ":/opt/homebrew/bin:"
	got := mergePath(current, login)
	want := "/opt/homebrew/bin:/usr/bin"
	if got != want {
		t.Fatalf("mergePath(%q, %q) = %q, want %q", current, login, got, want)
	}
}

// TestLoginShellPath simulates the macOS-GUI case: a fake $SHELL whose rc files
// set PATH runs the probe's command. loginShellPath should capture exactly it.
func TestLoginShellPath(t *testing.T) {
	loginPath := "/opt/homebrew/bin:/usr/local/go/bin:/usr/bin:/bin"
	t.Setenv("SHELL", fakeLoginShell(t, loginPath, ""))

	if got, err := loginShellPath(); err != nil || got != loginPath {
		t.Fatalf("loginShellPath() = %q, %v; want %q", got, err, loginPath)
	}
}

// TestLoginShellPath_IgnoresRcOutput covers interactive rc files that print —
// a greeting, a fortune, a version manager's notice — before and after the
// probe's command runs. Read as the PATH, a banner glued to the first entry
// breaks exactly the directory a version manager put first.
func TestLoginShellPath_IgnoresRcOutput(t *testing.T) {
	loginPath := "/Users/me/.nvm/versions/node/v22.0.0/bin:/usr/bin:/bin"
	t.Setenv("SHELL", fakeLoginShell(t, loginPath, "Welcome back!\nNow using node v22.0.0"))

	if got, err := loginShellPath(); err != nil || got != loginPath {
		t.Fatalf("loginShellPath() = %q, %v; want %q", got, err, loginPath)
	}
}

// A shell that never runs the command (or prints only its rc noise) yields no
// PATH at all rather than the noise.
func TestLoginShellPath_NoMarkersIsNoAnswer(t *testing.T) {
	t.Setenv("SHELL", writeFakeShell(t, "#!/bin/sh\necho 'just a banner'\n"))

	if got, err := loginShellPath(); err == nil || got != "" {
		t.Fatalf("loginShellPath() = %q, %v; want \"\" and an error when the shell never printed a PATH", got, err)
	}
}

func TestLoginShellPath_NoShellEnv(t *testing.T) {
	t.Setenv("SHELL", "")
	if got, err := loginShellPath(); err == nil || got != "" {
		t.Fatalf("loginShellPath() = %q, %v; want \"\" and an error when $SHELL is unset", got, err)
	}
}

// A failed probe leaves PATH alone and leaves an account for the log, which is
// the only way to tell afterwards why a GUI launch couldn't find a tool.
func TestRepairPathForGUILaunch_RecordsFailure(t *testing.T) {
	t.Setenv("SHELL", writeFakeShell(t, "#!/bin/sh\nexit 3\n"))
	t.Setenv("PATH", "/usr/bin:/bin")
	prev := pathRepairReport
	pathRepairReport = ""
	t.Cleanup(func() { pathRepairReport = prev })

	repairPathForGUILaunch(false)
	if got := os.Getenv("PATH"); got != "/usr/bin:/bin" {
		t.Fatalf("PATH after a failed probe = %q, want it untouched", got)
	}
	if !strings.Contains(pathRepairReport, "probe failed") || !strings.Contains(pathRepairReport, "/usr/bin:/bin") {
		t.Fatalf("pathRepairReport = %q, want the failure and the PATH kept", pathRepairReport)
	}
}

// TestRepairPathForGUILaunch sets up a minimal GUI PATH, runs the repair, and
// asserts the login-shell PATH entries land ahead of the originals in the
// process env. Mirrors how Run() calls it.
func TestRepairPathForGUILaunch(t *testing.T) {
	loginPath := "/opt/homebrew/bin:/usr/local/go/bin"
	t.Setenv("SHELL", fakeLoginShell(t, loginPath, ""))
	t.Setenv("PATH", "/usr/bin:/bin")

	repairPathForGUILaunch(false) // hasTerminal=false → GUI launch path
	got := os.Getenv("PATH")
	want := loginPath + ":/usr/bin:/bin"
	if got != want {
		t.Fatalf("PATH after repair = %q, want %q", got, want)
	}
}

// A terminal launch must leave PATH untouched even when the probe would fire.
func TestRepairPathForGUILaunch_NoopForTerminalLaunch(t *testing.T) {
	// A shell that would mutate PATH if it were consulted.
	t.Setenv("SHELL", fakeLoginShell(t, "/opt/homebrew/bin", ""))
	original := "/usr/bin:/bin"
	t.Setenv("PATH", original)

	repairPathForGUILaunch(true) // hasTerminal=true → skip
	if got := os.Getenv("PATH"); got != original {
		t.Fatalf("PATH after terminal-launch repair = %q, want %q (untouched)", got, original)
	}
}

// fakeLoginShell writes a fake $SHELL that behaves like a real one invoked as
// `shell -l -i -c <command>`: its "rc files" print banner (if any) and set PATH
// to loginPath, then it runs the command it was given and prints the banner
// again on the way out.
func fakeLoginShell(t *testing.T, loginPath, banner string) string {
	t.Helper()
	echo := ""
	if banner != "" {
		echo = "printf '%s\\n' '" + banner + "'\n"
	}
	return writeFakeShell(t, "#!/bin/sh\n"+echo+
		"PATH='"+loginPath+"' /bin/sh -c \"$4\"\n"+echo)
}

// writeFakeShell creates an executable fake $SHELL in the test's temp dir that
// runs the given script. Lets us stand in for zsh/bash without depending on the
// host's rc files.
func writeFakeShell(t *testing.T, script string) string {
	t.Helper()
	// Production's 4s budget is sized for a real login shell sourcing rc files.
	// What it buys here is macOS's first-exec scan of a script written
	// microseconds ago — a cost belonging to the machine, and one that has come
	// within a few hundred milliseconds of the budget under load. Every test
	// that writes a fake shell is about to exec it, so the patience goes here
	// where it cannot be forgotten.
	previous := loginShellProbeTimeout
	loginShellProbeTimeout = 30 * time.Second
	t.Cleanup(func() { loginShellProbeTimeout = previous })

	shell := filepath.Join(t.TempDir(), "fakeshell")
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return shell
}

// A sanity check that mergePath's output is colon-delimited and the login
// entries genuinely precede the current ones — the invariant the bash tool
// relies on to find `go` on a Finder launch.
func TestMergePath_OrderingGuarantee(t *testing.T) {
	login := "/usr/local/go/bin"
	current := "/usr/bin"
	got := mergePath(current, login)
	parts := strings.Split(got, string(os.PathListSeparator))
	loginIdx, currentIdx := -1, -1
	for i, p := range parts {
		switch p {
		case login:
			loginIdx = i
		case current:
			currentIdx = i
		}
	}
	if loginIdx == -1 || currentIdx == -1 {
		t.Fatalf("mergePath lost an entry: %v", parts)
	}
	if loginIdx > currentIdx {
		t.Fatalf("login entry at %d should precede current at %d in %v", loginIdx, currentIdx, parts)
	}
}

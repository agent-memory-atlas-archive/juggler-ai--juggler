//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"os"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// storeBinaryPath writes a runnable fake claude and records it as the
// settings-panel override in an isolated credentials store.
func storeBinaryPath(t *testing.T, name string) string {
	t.Helper()
	bin := writeExecutable(t, t.TempDir(), name)
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore: %v", err)
	}
	if err := store.SetRawKey(BinaryPathCredKey, bin); err != nil {
		t.Fatalf("SetRawKey: %v", err)
	}
	return bin
}

func TestConfiguredClaudeBinary_FromCredentialsStore(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(claudePathEnvVar, "")
	bin := storeBinaryPath(t, "claude")

	if got := configuredClaudeBinary(); got != bin {
		t.Fatalf("configuredClaudeBinary() = %q, want stored %q", got, bin)
	}
}

func TestConfiguredClaudeBinary_StoreBeatsEnv(t *testing.T) {
	userpathstest.Isolate(t)
	envBin := writeExecutable(t, t.TempDir(), "claude-env")
	t.Setenv(claudePathEnvVar, envBin)
	storeBin := storeBinaryPath(t, "claude-store")

	if got := configuredClaudeBinary(); got != storeBin {
		t.Fatalf("settings path should win over env: got %q, want %q", got, storeBin)
	}
}

func TestConfiguredClaudeBinary_EnvFallbackWhenStoreEmpty(t *testing.T) {
	userpathstest.Isolate(t)
	envBin := writeExecutable(t, t.TempDir(), "claude-env")
	t.Setenv(claudePathEnvVar, envBin)

	if got := configuredClaudeBinary(); got != envBin {
		t.Fatalf("env should be used when store is empty: got %q, want %q", got, envBin)
	}
}

// A claude found at startup and since removed (uninstalled, or moved by a
// version-manager upgrade) must not keep being handed out: the provider would
// read as ready and every spawn would fail on a path that isn't there.
func TestClaudeBinary_DropsVanishedStartupPath(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(claudePathEnvVar, "")
	bin := writeExecutable(t, t.TempDir(), "claude")
	prev := claudeBinaryPath
	claudeBinaryPath = bin
	t.Cleanup(func() { claudeBinaryPath = prev })

	if got := claudeBinary(); got != bin {
		t.Fatalf("precondition: claudeBinary() = %q, want the startup path %q", got, bin)
	}
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	if got := claudeBinary(); got == bin {
		t.Fatalf("claudeBinary() still returns %q after it was removed", got)
	}
}

// The test seam must win over a real settings-panel path so suites that don't
// isolate the config dir aren't shadowed by a developer's own override.
func TestClaudeBinary_PinnedSeamWinsOverStore(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(claudePathEnvVar, "")
	storeBinaryPath(t, "claude-store")

	pinned := writeExecutable(t, t.TempDir(), "claude-pinned")
	restore := SetBinaryPathForTesting(pinned)
	defer restore()

	if got := claudeBinary(); got != pinned {
		t.Fatalf("pinned test seam must win: got %q, want %q", got, pinned)
	}
}

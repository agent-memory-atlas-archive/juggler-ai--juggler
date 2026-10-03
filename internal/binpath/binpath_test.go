//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package binpath

import (
	"os"
	"path/filepath"
	"testing"
)

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o755); err != nil {
		t.Fatal(err)
	}
}

// symlink links link → target, skipping the test where the OS refuses
// (Windows without developer mode).
func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
}

func TestSiblingNextToExe(t *testing.T) {
	dir := t.TempDir()
	touch(t, filepath.Join(dir, "juggler"))
	touch(t, filepath.Join(dir, "juggler-app"))

	got, ok := Sibling(filepath.Join(dir, "juggler"), "juggler-app")
	if !ok || got != filepath.Join(dir, "juggler-app") {
		t.Fatalf("Sibling = %q, %v; want the juggler-app beside it", got, ok)
	}
}

// A package manager links only juggler into a bin directory on PATH (Homebrew's
// cask `binary` stanza). Run through that link, the executable's path is the
// link's, and juggler-app sits beside the real binary inside the bundle.
func TestSiblingThroughSymlinkedExe(t *testing.T) {
	root := t.TempDir()
	bundle := filepath.Join(root, "Juggler.app", "Contents", "MacOS")
	touch(t, filepath.Join(bundle, "juggler"))
	touch(t, filepath.Join(bundle, "juggler-app"))
	link := filepath.Join(root, "bin", "juggler")
	symlink(t, filepath.Join(bundle, "juggler"), link)

	got, ok := Sibling(link, "juggler-app")
	if !ok {
		t.Fatalf("Sibling(%q) found nothing; want the juggler-app in the bundle", link)
	}
	real, err := filepath.EvalSymlinks(filepath.Join(bundle, "juggler-app"))
	if err != nil {
		t.Fatal(err)
	}
	if gotReal, _ := filepath.EvalSymlinks(got); gotReal != real {
		t.Fatalf("Sibling = %q; want %q", got, real)
	}
}

// A sibling beside the link itself wins over the one beside its target: the
// dev layout links both binaries into bin/, and that pair belongs together.
func TestSiblingPrefersLinkDirectory(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "real", "juggler"))
	touch(t, filepath.Join(root, "real", "juggler-app"))
	link := filepath.Join(root, "bin", "juggler")
	symlink(t, filepath.Join(root, "real", "juggler"), link)
	touch(t, filepath.Join(root, "bin", "juggler-app"))

	got, ok := Sibling(link, "juggler-app")
	if !ok || got != filepath.Join(root, "bin", "juggler-app") {
		t.Fatalf("Sibling = %q, %v; want the juggler-app beside the link", got, ok)
	}
}

func TestSiblingMissing(t *testing.T) {
	dir := t.TempDir()
	touch(t, filepath.Join(dir, "juggler"))
	if got, ok := Sibling(filepath.Join(dir, "juggler"), "juggler-app"); ok {
		t.Fatalf("Sibling = %q; want nothing", got)
	}
}

func TestSiblingIgnoresDirectory(t *testing.T) {
	dir := t.TempDir()
	touch(t, filepath.Join(dir, "juggler"))
	if err := os.Mkdir(filepath.Join(dir, "juggler-app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := Sibling(filepath.Join(dir, "juggler"), "juggler-app"); ok {
		t.Fatalf("Sibling = %q; want a directory to be ignored", got)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package binpath finds one of Juggler's two binaries (juggler, juggler-app)
// installed next to the other.
package binpath

import (
	"os"
	"path/filepath"
)

// Sibling returns the regular file called name beside exe, and whether one
// exists. It looks in exe's own directory first, then — when exe is a symlink —
// in the directory of the file it resolves to.
//
// The second look is what lets a lone link to juggler on PATH (a package
// manager's bin directory, pointing into Juggler.app) still find juggler-app:
// os.Executable reports the path the process was started through, which on
// macOS and Linux is the link, not the bundle. The link's own directory is
// tried first so a pair of links kept side by side (the dev layout's bin/)
// stays a pair.
func Sibling(exe, name string) (string, bool) {
	if cand, ok := fileIn(filepath.Dir(exe), name); ok {
		return cand, true
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil || filepath.Dir(resolved) == filepath.Dir(exe) {
		return "", false
	}
	return fileIn(filepath.Dir(resolved), name)
}

func fileIn(dir, name string) (string, bool) {
	cand := filepath.Join(dir, name)
	if st, err := os.Stat(cand); err == nil && !st.IsDir() {
		return cand, true
	}
	return "", false
}

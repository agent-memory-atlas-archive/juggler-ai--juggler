//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package srcroot locates the root of a Juggler source checkout — the
// directory holding the module's go.mod and its web/ tree. The server needs it
// to serve assets from disk and to register test routes, and the test suites
// need it to find fixtures and built binaries.
//
// This is Juggler's own source tree, not the user's project: a stock binary
// outside a checkout has no source root at all.
package srcroot

import (
	"errors"
	"os"
	"path/filepath"
)

// Find finds the juggler source root by looking for a go.mod whose directory
// also contains a web/ tree. Requiring the web/ dir makes this locate the
// juggler root specifically rather than any enclosing Go module — important
// when the binary is launched from inside another repo (e.g. a parent module)
// that has its own go.mod but no web/ assets.
//
// It searches upward from startPath (when non-empty), then from the current
// working directory, then from the executable's resolved location.
func Find(startPath string) (string, error) {
	// Strategy 1: Search from provided startPath
	if startPath != "" {
		if root, found := searchUp(startPath); found {
			return root, nil
		}
	}

	// Strategy 2: Search from current working directory
	cwd, err := os.Getwd()
	if err == nil {
		if root, found := searchUp(cwd); found {
			return root, nil
		}
	}

	// Strategy 3: Search from executable's location (for --assets-from-disk from arbitrary directory)
	exePath, err := os.Executable()
	if err == nil {
		// Resolve symlinks to get actual binary location
		exePath, err = filepath.EvalSymlinks(exePath)
		if err == nil {
			if root, found := searchUp(filepath.Dir(exePath)); found {
				return root, nil
			}
		}
	}

	return "", errors.New("could not find juggler project root (no go.mod with a web/ directory found in startPath, cwd, or executable location)")
}

// searchUp walks upward from start, returning the first directory that holds
// both a go.mod and a web/ directory.
func searchUp(start string) (string, bool) {
	searchPath := start
	for {
		if isJugglerRoot(searchPath) {
			return searchPath, true
		}

		parent := filepath.Dir(searchPath)
		if parent == searchPath {
			return "", false // Reached filesystem root
		}
		searchPath = parent
	}
}

// isJugglerRoot reports whether dir is the juggler root: a directory holding
// both go.mod and a web/ tree.
func isJugglerRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err != nil {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, "web"))
	return err == nil && info.IsDir()
}

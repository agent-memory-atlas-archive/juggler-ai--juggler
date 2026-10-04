//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/srcroot"
)

// TestAllTestFilesRegistered checks that every JS test file in the integration-tests/
// and unit-tests/ directories is imported in integration-test-executor.js.
// This prevents silently dropped tests when a file is added but the executor is not updated.
func TestAllTestFilesRegistered(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping test registration check in short mode")
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("cannot find project root: %v", err)
	}

	executorPath := filepath.Join(root, "web", "js-tests", "utilities", "integration-test-executor.js")
	executorBytes, err := os.ReadFile(executorPath)
	if err != nil {
		t.Fatalf("cannot read integration-test-executor.js: %v", err)
	}
	executorSrc := string(executorBytes)

	dirs := []string{
		filepath.Join(root, "web", "js-tests", "integration-tests"),
		filepath.Join(root, "web", "js-tests", "unit-tests"),
	}

	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("cannot read dir %s: %v", dir, err)
		}
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".js" {
				continue
			}
			name := e.Name()
			if !strings.Contains(executorSrc, name) {
				t.Errorf("test file %q is not imported in integration-test-executor.js", filepath.Join(filepath.Base(dir), name))
			}
		}
	}
}

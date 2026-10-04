//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/extmanifest"
	"juggler/internal/srcroot"
	"juggler/web"
)

// TestExtensionTestsDeclared enforces the co-location contract: any test file an
// extension keeps under its _tests/ directory MUST be matched by that
// extension's manifest `provides.tests` glob. Otherwise the harness's
// /api/test/extension-tests discovery would silently skip it — a dropped test.
// This is the extension-owned analogue of TestAllTestFilesRegistered, which
// guards the shared js-tests/ pool.
func TestExtensionTestsDeclared(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping extension-test registration check in short mode")
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("cannot find project root: %v", err)
	}
	extRoot := filepath.Join(root, "web", "extensions")

	entries, err := os.ReadDir(extRoot)
	if err != nil {
		t.Fatalf("cannot read extensions dir %s: %v", extRoot, err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		extDir := filepath.Join(extRoot, entry.Name())
		testsDir := filepath.Join(extDir, "_tests")

		// Collect the *-test.js files physically present under _tests/.
		var present []string
		if dirEntries, err := os.ReadDir(testsDir); err == nil {
			for _, de := range dirEntries {
				if !de.IsDir() && strings.HasSuffix(de.Name(), "-test.js") {
					present = append(present, "_tests/"+de.Name())
				}
			}
		}
		if len(present) == 0 {
			continue // no co-located tests in this extension
		}

		// The extension has co-located tests, so its manifest must declare them.
		data, err := os.ReadFile(filepath.Join(extDir, extmanifest.ManifestFileName))
		if err != nil {
			t.Errorf("extension %q has _tests/ files but no readable manifest: %v", entry.Name(), err)
			continue
		}
		manifest, err := extmanifest.Parse(data)
		if err != nil {
			t.Errorf("extension %q manifest failed to parse: %v", entry.Name(), err)
			continue
		}
		if len(manifest.Provides.Tests) == 0 {
			t.Errorf("extension %q has _tests/ files but declares no provides.tests glob", entry.Name())
			continue
		}

		matched, err := extmanifest.ExpandGlobs(os.DirFS(extDir), manifest.Provides.Tests)
		if err != nil {
			t.Errorf("extension %q provides.tests glob is invalid: %v", entry.Name(), err)
			continue
		}
		matchedSet := make(map[string]bool, len(matched))
		for _, m := range matched {
			matchedSet[m] = true
		}
		for _, p := range present {
			if !matchedSet[p] {
				t.Errorf("extension %q test file %q is not matched by any provides.tests glob %v",
					entry.Name(), p, manifest.Provides.Tests)
			}
		}
	}
}

// TestExtensionTestsExcludedFromProductionEmbed proves that extension test code
// never ships in a binary: the production asset embed (`//go:embed extensions/*`
// in web/embed.go) skips any _tests/ directory because its leading underscore
// excludes it from a non-`all:` embed pattern. web.Files is the same embed used
// by release builds, so if a _tests/ path is reachable here it would ship in
// production — fail loudly.
func TestExtensionTestsExcludedFromProductionEmbed(t *testing.T) {
	err := fs.WalkDir(web.Files, "extensions", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.Contains(p, "/_tests/") || strings.HasSuffix(p, "/_tests") {
			t.Errorf("test asset %q is embedded in web.Files — it would ship in a production binary", p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking embedded extensions tree: %v", err)
	}
}

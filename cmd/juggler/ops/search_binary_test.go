//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func grepFiles(t *testing.T, ops *SearchOperations, params map[string]any) []string {
	t.Helper()
	res, err := ops.grep(context.Background(), params)
	if err != nil {
		t.Fatalf("grep: %v", err)
	}
	var files []string
	for _, m := range res.(map[string]any)["matches"].([]map[string]any) {
		files = append(files, m["file"].(string))
	}
	return files
}

// TestGrepSkipsBinaryFiles: a compiled .pyc carries the same identifiers as
// its source, but its "lines" are bytecode, so grep reports only the source.
func TestGrepSkipsBinaryFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "mod.py"), []byte("def compute_total():\n    pass\n"))
	pyc := []byte{0x6f, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0xe3, 0, 0, 0}
	pyc = append(pyc, []byte("compute_total\x00\x01\x02\nz\x00compute_total\xff\xfe")...)
	writeFile(t, filepath.Join(dir, "__pycache__", "mod.cpython-312.pyc"), pyc)
	ops := NewSearchOperations(NewPathScope(dir, nil))

	for name, params := range map[string]map[string]any{
		"walk": {"pattern": "compute_total"},
		"glob": {"pattern": "compute_total", "path": "**/*"},
	} {
		files := grepFiles(t, ops, params)
		if len(files) != 1 || files[0] != "mod.py" {
			t.Errorf("%s: matched files = %v, want [mod.py]", name, files)
		}
	}
}

// TestGrepSearchesPastOverlongLine: a line longer than the scanner's default
// 64KB token must neither end the file's scan nor be returned in full.
func TestGrepSearchesPastOverlongLine(t *testing.T) {
	dir := t.TempDir()
	long := "needle" + strings.Repeat("x", 200*1024)
	writeFile(t, filepath.Join(dir, "bundle.min.js"), []byte(long+"\nneedle after\n"))
	ops := NewSearchOperations(NewPathScope(dir, nil))

	res, err := ops.grep(context.Background(), map[string]any{"pattern": "needle"})
	if err != nil {
		t.Fatalf("grep: %v", err)
	}
	matches := res.(map[string]any)["matches"].([]map[string]any)
	if len(matches) != 2 {
		t.Fatalf("matchCount = %d, want 2 (both lines of bundle.min.js)", len(matches))
	}
	if got := len(matches[0]["content"].(string)); got > maxMatchContentBytes+64 {
		t.Errorf("overlong line returned %d bytes of content, want at most ~%d", got, maxMatchContentBytes)
	}
	if matches[1]["line"] != "2" || matches[1]["content"] != "needle after" {
		t.Errorf("second match = %v, want line 2 %q", matches[1], "needle after")
	}
}

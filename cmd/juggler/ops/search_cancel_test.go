//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeMatchingFiles creates n files under dir, each containing the literal
// "needle", so a grep/glob over dir has many files to walk.
func writeMatchingFiles(t *testing.T, dir string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, fmt.Sprintf("file_%03d.txt", i))
		if err := os.WriteFile(p, []byte("needle here\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
}

// TestGrepHonorsContextCancellation proves the grep walk stops early when the
// request context is cancelled — the server-side half of "Escape stops an
// in-flight grep". With a live context the walk finds every file; with an
// already-cancelled context the walk returns before scanning them all.
func TestGrepHonorsContextCancellation(t *testing.T) {
	dir := t.TempDir()
	const n = 50
	writeMatchingFiles(t, dir, n)
	ops := NewSearchOperations(NewPathScope(dir, nil))

	// Baseline: a live context finds all matches.
	full, err := ops.grep(context.Background(), map[string]any{
		"pattern":    "needle",
		"maxCount":   float64(1000),
		"ignoreCase": false,
	})
	if err != nil {
		t.Fatalf("grep(live): %v", err)
	}
	fullCount := full.(map[string]any)["matchCount"].(int)
	if fullCount != n {
		t.Fatalf("baseline matchCount = %d, want %d", fullCount, n)
	}

	// Cancelled context: the walk must bail out before scanning everything.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := ops.grep(ctx, map[string]any{
		"pattern":    "needle",
		"maxCount":   float64(1000),
		"ignoreCase": false,
	})
	if err != nil {
		t.Fatalf("grep(cancelled): %v", err)
	}
	cancelledCount := got.(map[string]any)["matchCount"].(int)
	if cancelledCount >= fullCount {
		t.Fatalf("cancelled grep scanned %d matches, expected fewer than %d (walk did not stop on ctx cancel)",
			cancelledCount, fullCount)
	}
}

// TestGrepGlobHonorsContextCancellation covers the glob-path grep branch
// (searchGlobFiles), which walks a doublestar match list rather than the tree.
func TestGrepGlobHonorsContextCancellation(t *testing.T) {
	dir := t.TempDir()
	const n = 50
	writeMatchingFiles(t, dir, n)
	ops := NewSearchOperations(NewPathScope(dir, nil))

	params := func() map[string]any {
		return map[string]any{
			"pattern":    "needle",
			"path":       "*.txt", // glob path triggers searchGlobFiles
			"maxCount":   float64(1000),
			"ignoreCase": false,
		}
	}

	full, err := ops.grep(context.Background(), params())
	if err != nil {
		t.Fatalf("grep glob(live): %v", err)
	}
	fullCount := full.(map[string]any)["matchCount"].(int)
	if fullCount == 0 {
		t.Fatalf("baseline glob grep found no matches")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := ops.grep(ctx, params())
	if err != nil {
		t.Fatalf("grep glob(cancelled): %v", err)
	}
	cancelledCount := got.(map[string]any)["matchCount"].(int)
	if cancelledCount >= fullCount {
		t.Fatalf("cancelled glob grep scanned %d matches, expected fewer than %d", cancelledCount, fullCount)
	}
}

// TestTreeGlobHonorsContextCancellation proves the glob tool (TreeOperations)
// stops collecting files when the request context is cancelled.
func TestTreeGlobHonorsContextCancellation(t *testing.T) {
	dir := t.TempDir()
	const n = 50
	writeMatchingFiles(t, dir, n)
	ops := NewTreeOperations(NewPathScope(dir, nil))

	full, err := ops.glob(context.Background(), map[string]any{"pattern": "*.txt"})
	if err != nil {
		t.Fatalf("glob(live): %v", err)
	}
	fullFiles := full.(map[string]any)["files"].([]string)
	if len(fullFiles) != n {
		t.Fatalf("baseline glob files = %d, want %d", len(fullFiles), n)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := ops.glob(ctx, map[string]any{"pattern": "*.txt"})
	if err != nil {
		t.Fatalf("glob(cancelled): %v", err)
	}
	gotFiles, _ := got.(map[string]any)["files"].([]string)
	if len(gotFiles) >= len(fullFiles) {
		t.Fatalf("cancelled glob collected %d files, expected fewer than %d", len(gotFiles), len(fullFiles))
	}
}

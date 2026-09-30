//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestToolTerminalRuleHasOneHome pins "which tool-action states are terminal"
// to isTerminalToolState. The rule was once spelled inline at five sites, and a
// state added to it (or taken from it) at one site would silently disagree with
// the others about whether a turn may proceed.
func TestToolTerminalRuleHasOneHome(t *testing.T) {
	inline := regexp.MustCompile(`StateCompleted\s*(\|\||&&)[^\n]*StateCancelled|StateCancelled\s*(\|\||&&)[^\n]*StateCompleted`)
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		for i, line := range strings.Split(string(src), "\n") {
			if !inline.MatchString(line) {
				continue
			}
			if f == "thread_reducer.go" && strings.Contains(line, "state == StateCompleted || state == StateCancelled") {
				continue // isTerminalToolState itself
			}
			t.Errorf("%s:%d spells the terminal-tool rule inline; call isToolTerminal / isTerminalToolState:\n\t%s", f, i+1, strings.TrimSpace(line))
		}
	}
	if scanned < 20 {
		t.Fatalf("scanned only %d production files — the walk is not seeing the package", scanned)
	}
}

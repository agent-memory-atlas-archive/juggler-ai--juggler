//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
	"time"
)

// A reply that takes most of ContextTimeout "coming back" has waited in the
// inbox behind slow run() iterations. These pin the line that names them.

func TestDescribeSlowIterationSplitsEventFromReconcile(t *testing.T) {
	desc, ok := describeSlowIteration("message yjs-sync", 40*time.Millisecond, 600*time.Millisecond, 3)
	if !ok {
		t.Fatalf("a 640ms iteration must be reported")
	}
	for _, want := range []string{"message yjs-sync", "640ms", "40ms", "600ms", "3 reconcile"} {
		if !strings.Contains(desc, want) {
			t.Errorf("description %q missing %q", desc, want)
		}
	}
}

func TestDescribeSlowIterationCountsTheReconcileAgainstTheThreshold(t *testing.T) {
	// An event that is quick to handle but triggers a long reducer drain holds
	// the inbox just as long, so the two halves are judged together.
	if _, ok := describeSlowIteration("items change", slowLoopIteration/2, slowLoopIteration/2, 1); !ok {
		t.Errorf("an iteration at the threshold, split across event and reconcile, must be reported")
	}
}

func TestDescribeSlowIterationIsSilentWhenHealthy(t *testing.T) {
	if desc, ok := describeSlowIteration("liveness tick", 2*time.Millisecond, 5*time.Millisecond, 1); ok {
		t.Errorf("a healthy iteration must not be reported, got %q", desc)
	}
}

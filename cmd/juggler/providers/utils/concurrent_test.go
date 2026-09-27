//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

// TestMapConcurrentRespectsTheBound pins the reason the helper exists: a list of
// N items must not become N simultaneous requests to somebody's API, and must
// not become N serial round trips either.
func TestMapConcurrentRespectsTheBound(t *testing.T) {
	const (
		count = 24
		bound = 4
	)
	items := make([]int, count)
	for i := range items {
		items[i] = i
	}

	var inFlight, peak atomic.Int64
	results := MapConcurrent(context.Background(), items, bound, func(_ context.Context, n int) int {
		current := inFlight.Add(1)
		for {
			highest := peak.Load()
			if current <= highest || peak.CompareAndSwap(highest, current) {
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
		inFlight.Add(-1)
		return n * 2
	})

	if got := peak.Load(); got > bound {
		t.Errorf("peak concurrency = %d, want at most the bound %d", got, bound)
	}
	if got := peak.Load(); got < 2 {
		t.Errorf("peak concurrency = %d, want the pool to overlap work at all", got)
	}
	if len(results) != count {
		t.Fatalf("len(results) = %d, want %d", len(results), count)
	}
	for i, got := range results {
		if want := i * 2; got != want {
			t.Errorf("results[%d] = %d, want %d", i, got, want)
		}
	}
}

// TestMapConcurrentKeepsResultsIndexAligned is what lets a caller pair results
// back up with its inputs by position, so the early items finishing last cannot
// shuffle the answers.
func TestMapConcurrentKeepsResultsIndexAligned(t *testing.T) {
	items := []string{"a", "b", "c", "d", "e", "f"}
	results := MapConcurrent(context.Background(), items, 3, func(_ context.Context, s string) string {
		// Earlier items finish last: completion order is the reverse of input order.
		time.Sleep(time.Duration(len(items)-int(s[0]-'a')) * time.Millisecond)
		return "<" + s + ">"
	})
	if len(results) != len(items) {
		t.Fatalf("len(results) = %d, want %d", len(results), len(items))
	}
	for i, item := range items {
		if want := "<" + item + ">"; results[i] != want {
			t.Errorf("results[%d] = %q, want %q", i, results[i], want)
		}
	}
}

// TestMapConcurrentDegradesFailedItemsToTheZeroValue pins the failure contract:
// one item that cannot produce an answer leaves the zero value at its index and
// costs the rest of the list nothing.
func TestMapConcurrentDegradesFailedItemsToTheZeroValue(t *testing.T) {
	items := []int{1, 2, 3, 4}
	results := MapConcurrent(context.Background(), items, 2, func(_ context.Context, n int) string {
		if n == 3 {
			return "" // the "probe failed" path
		}
		return fmt.Sprintf("ok-%d", n)
	})
	want := []string{"ok-1", "ok-2", "", "ok-4"}
	if len(results) != len(want) {
		t.Fatalf("len(results) = %d, want %d", len(results), len(want))
	}
	for i := range want {
		if results[i] != want[i] {
			t.Errorf("results[%d] = %q, want %q", i, results[i], want[i])
		}
	}
}

// TestMapConcurrentHandlesEdgeInputs covers the shapes a caller reaches by
// accident rather than by design: nothing to do, and a bound that is not a bound.
func TestMapConcurrentHandlesEdgeInputs(t *testing.T) {
	if got := MapConcurrent(context.Background(), nil, 4, func(_ context.Context, n int) int { return n }); len(got) != 0 {
		t.Errorf("empty input returned %d results, want 0", len(got))
	}
	// A non-positive bound runs the work serially rather than not at all.
	results := MapConcurrent(context.Background(), []int{1, 2, 3}, 0, func(_ context.Context, n int) int { return n + 10 })
	for i, want := range []int{11, 12, 13} {
		if results[i] != want {
			t.Errorf("results[%d] = %d, want %d", i, results[i], want)
		}
	}
}

// TestMapConcurrentStopsOnCancelledContext keeps a cancelled refresh from
// queueing every remaining request only to have each one fail on its own.
func TestMapConcurrentStopsOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var calls atomic.Int64
	results := MapConcurrent(ctx, []int{1, 2, 3, 4}, 2, func(_ context.Context, n int) int {
		calls.Add(1)
		return n
	})
	if got := calls.Load(); got != 0 {
		t.Errorf("fn called %d times under a cancelled context, want 0", got)
	}
	if len(results) != 4 {
		t.Fatalf("len(results) = %d, want 4 index-aligned slots", len(results))
	}
	for i, got := range results {
		if got != 0 {
			t.Errorf("results[%d] = %d, want the zero value", i, got)
		}
	}
}

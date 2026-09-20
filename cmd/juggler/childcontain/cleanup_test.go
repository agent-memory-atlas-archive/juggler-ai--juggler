//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package childcontain

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestCleanup_ConcurrentCallersReleaseOnce verifies that Cleanup releases OS
// resources exactly once when several goroutines call it at the same moment.
// Terminate routes through Cleanup on Windows and macOS, so a context-cancel
// watcher and an explicit kill of the same shell land on one Child
// concurrently; a second release closes a job handle the OS may already have
// reissued to someone else.
//
// The cleanup func blocks briefly so every caller is inside Cleanup together,
// which is the interleaving that matters.
func TestCleanup_ConcurrentCallersReleaseOnce(t *testing.T) {
	const callers = 8

	var releases atomic.Int64
	c := &Child{cleanup: func() {
		releases.Add(1)
		time.Sleep(10 * time.Millisecond)
	}}

	start := make(chan struct{})
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			c.Cleanup()
		}()
	}
	close(start)
	wg.Wait()

	if got := releases.Load(); got != 1 {
		t.Fatalf("cleanup ran %d times across %d concurrent callers, want exactly 1", got, callers)
	}
}

// TestCleanup_SequentialCallsReleaseOnce pins the idempotence that terminate()
// relies on: Terminate followed by the caller's deferred Cleanup must not
// release twice.
func TestCleanup_SequentialCallsReleaseOnce(t *testing.T) {
	var releases atomic.Int64
	c := &Child{cleanup: func() { releases.Add(1) }}

	c.Cleanup()
	c.Cleanup()
	c.Cleanup()

	if got := releases.Load(); got != 1 {
		t.Fatalf("cleanup ran %d times across 3 sequential calls, want exactly 1", got)
	}
}

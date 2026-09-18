//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// deadPort returns a port number nothing is listening on, so a health probe
// against it fails the way it fails for a server that has closed its listener.
func deadPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return port
}

// lockedProject returns a project directory whose .juggler/juggler.lock is held
// by an in-process holder, along with the holder itself. flock is held per open
// file description, so a second InstanceLock in this process contends with it
// exactly as another process would.
func lockedProject(t *testing.T) (string, *core.InstanceLock, int) {
	t.Helper()
	dir := t.TempDir()
	port := deadPort(t)
	holder := core.NewInstanceLock(dir)
	res, err := holder.TryAcquire(port, "127.0.0.1")
	if err != nil || !res.Acquired {
		t.Fatalf("holder could not take the lock: acquired=%v err=%v", res.Acquired, err)
	}
	t.Cleanup(func() { _ = holder.Release() })
	return dir, holder, port
}

// appUnder returns an App wired up to acquire dir's lock, as startup does.
func appUnder(t *testing.T, dir string, port int) *App {
	t.Helper()
	cfg := &core.Config{}
	cfg.Server.Port = port
	cfg.Server.Host = "127.0.0.1"
	a := &App{projectPath: dir, cfg: cfg}
	t.Cleanup(a.runCleanups)
	return a
}

// TestAcquireInstanceWaitsOutAShuttingDownHolder is the regression test for the
// leaked-lockfile failure.
//
// A server releases its project lock at the very end of Shutdown but closes its
// listener at the very start, so between those points it holds the lock and
// answers no HTTP. A relaunch landing in that window probes the holder, gets a
// connection refused, concludes the lock is stale — and must then wait for the
// holder to finish, not give up on the spot.
func TestAcquireInstanceWaitsOutAShuttingDownHolder(t *testing.T) {
	dir, holder, port := lockedProject(t)

	// The holder finishes its teardown shortly after we start trying.
	go func() {
		time.Sleep(300 * time.Millisecond)
		_ = holder.Release()
	}()

	a := appUnder(t, dir, port)
	if err := a.acquireInstance(); err != nil {
		t.Fatalf("acquireInstance gave up on a holder that was still shutting down: %v", err)
	}
	if a.lock == nil {
		t.Fatal("acquireInstance reported success without holding the lock")
	}
}

// TestAcquireInstanceWaitsWhenInstanceInfoIsAlreadyGone covers the narrower
// window inside Release itself: instance.json is deleted BEFORE the flock is
// unlocked, so a relaunch can find the lock held with no metadata to explain
// who holds it. That is a moment mid-teardown, not a reason to refuse to start.
func TestAcquireInstanceWaitsWhenInstanceInfoIsAlreadyGone(t *testing.T) {
	dir, holder, port := lockedProject(t)

	// Reproduce the gap: info gone, lock still held.
	if err := os.Remove(filepath.Join(dir, ".juggler", "instance.json")); err != nil {
		t.Fatalf("remove instance.json: %v", err)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		_ = holder.Release()
	}()

	a := appUnder(t, dir, port)
	if err := a.acquireInstance(); err != nil {
		t.Fatalf("acquireInstance refused to wait for a holder with no instance info: %v", err)
	}
}

// TestAcquireInstanceGivesUpOnALockNobodyReleases keeps the wait bounded. A
// genuinely wedged holder must not hang the launch forever, and the error has
// to say the project is still locked so the caller can explain the recovery.
func TestAcquireInstanceGivesUpOnALockNobodyReleases(t *testing.T) {
	restore := staleLockGrace
	staleLockGrace = 200 * time.Millisecond
	t.Cleanup(func() { staleLockGrace = restore })

	dir, _, port := lockedProject(t)
	a := appUnder(t, dir, port)

	done := make(chan error, 1)
	go func() { done <- a.acquireInstance() }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("acquireInstance claimed a lock that was never released")
		}
		if !strings.Contains(err.Error(), "still locked") {
			t.Fatalf("error does not say the project is still locked: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("acquireInstance never gave up — a wedged holder hangs the launch")
	}
}

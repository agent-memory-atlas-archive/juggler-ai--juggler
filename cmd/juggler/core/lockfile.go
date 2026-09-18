//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"juggler/internal/apipaths"
	"juggler/internal/jlog"

	"github.com/gofrs/flock"
)

const (
	// instanceHealthTimeout caps HTTP probes against a peer's /api/health/instance
	// endpoint. Short because a live local instance answers within a few ms.
	instanceHealthTimeout = 2 * time.Second

	// shutdownRequestTimeout caps the POST /api/shutdown call. Slightly longer
	// than the health probe to allow the peer to start draining before responding.
	shutdownRequestTimeout = 5 * time.Second

	// shutdownPollInterval is the gap between health probes while WaitForShutdown
	// polls a peer for liveness.
	shutdownPollInterval = 200 * time.Millisecond

	// gracefulShutdownTimeout is how long we'll wait for a peer to disappear
	// after acknowledging a shutdown request, before falling back to SIGKILL.
	gracefulShutdownTimeout = 5 * time.Second
)

// InstanceInfo holds metadata about a running Juggler instance
type InstanceInfo struct {
	PID       int       `json:"pid"`
	Port      int       `json:"port"`
	Host      string    `json:"host"`
	StartedAt time.Time `json:"startedAt"`
}

// InstanceLock manages the single-instance lock for a project
type InstanceLock struct {
	projectPath string
	lockPath    string
	infoPath    string
	flock       *flock.Flock
	info        InstanceInfo
}

// NewInstanceLock creates a new instance lock manager for the given project path
func NewInstanceLock(projectPath string) *InstanceLock {
	jugglerDir := filepath.Join(projectPath, ".juggler")
	return &InstanceLock{
		projectPath: projectPath,
		lockPath:    filepath.Join(jugglerDir, "juggler.lock"),
		infoPath:    filepath.Join(jugglerDir, "instance.json"),
	}
}

// AcquireResult is the outcome of InstanceLock.TryAcquire.
// Existing is only meaningful when Acquired is false.
// FirstRun is only meaningful when Acquired is true (it reports whether the
// .juggler directory had to be created).
type AcquireResult struct {
	Acquired bool
	Existing *InstanceInfo
	FirstRun bool
}

// TryAcquire attempts to acquire the lock.
func (l *InstanceLock) TryAcquire(port int, host string) (AcquireResult, error) {
	// Check if this is first-time setup (directory doesn't exist yet)
	jugglerDir := filepath.Dir(l.lockPath)
	isFirstRun := false
	if _, statErr := os.Stat(jugglerDir); os.IsNotExist(statErr) {
		isFirstRun = true
	}

	// Ensure .juggler directory exists
	if err := os.MkdirAll(jugglerDir, 0700); err != nil {
		return AcquireResult{}, fmt.Errorf("failed to create .juggler directory: %w", err)
	}

	// Create flock instance
	l.flock = flock.New(l.lockPath)

	// Try to acquire exclusive lock (non-blocking)
	locked, err := l.flock.TryLock()
	if err != nil {
		return AcquireResult{}, fmt.Errorf("failed to acquire lock: %w", err)
	}

	if !locked {
		// Lock is held by another process - read existing instance info
		existing, readErr := l.readInstanceInfo()
		if readErr != nil {
			// Can't read info, but lock is held
			return AcquireResult{}, nil
		}
		return AcquireResult{Existing: existing}, nil
	}

	// Lock acquired - write our instance info
	l.info = InstanceInfo{
		PID:       os.Getpid(),
		Port:      port,
		Host:      host,
		StartedAt: time.Now(),
	}

	if err := l.writeInstanceInfo(); err != nil {
		// Release lock if we can't write info; failure here is non-fatal but
		// leaves a stale lock that the next acquire would have to break.
		if unlockErr := l.flock.Unlock(); unlockErr != nil {
			jlog.Error("[lockfile] failed to release lock after writeInstanceInfo failure: %v", unlockErr)
		}
		return AcquireResult{}, fmt.Errorf("failed to write instance info: %w", err)
	}

	return AcquireResult{Acquired: true, FirstRun: isFirstRun}, nil
}

// UpdateAddr rewrites the on-disk instance info with the address the server
// actually bound to. TryAcquire runs before the port is bound, so it records
// the *configured* port — which is stale whenever findAvailablePort had to
// auto-increment past a busy port. Calling this after BindPort keeps
// instance.json authoritative so a desktop app (or peer) discovering a running
// server for this project connects to the real address. No-op if the lock
// isn't held by us.
func (l *InstanceLock) UpdateAddr(host string, port int) error {
	if l == nil || l.flock == nil || !l.flock.Locked() {
		return nil
	}
	l.info.Host = host
	l.info.Port = port
	return l.writeInstanceInfo()
}

// Release releases the lock and cleans up instance info
func (l *InstanceLock) Release() error {
	if l.flock == nil {
		return nil
	}

	// Remove instance info file — non-fatal if it fails; the file is
	// rewritten on next Acquire and the lock release below is what actually
	// matters for other instances.
	if err := os.Remove(l.infoPath); err != nil && !os.IsNotExist(err) {
		jlog.Error("[lockfile] failed to remove instance info file: %v", err)
	}

	return l.flock.Unlock()
}

// writeInstanceInfo writes the current instance info to disk
func (l *InstanceLock) writeInstanceInfo() error {
	data, err := json.MarshalIndent(l.info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(l.infoPath, data, 0600)
}

// readInstanceInfo reads instance info from disk
func (l *InstanceLock) readInstanceInfo() (*InstanceInfo, error) {
	data, err := os.ReadFile(l.infoPath)
	if err != nil {
		return nil, err
	}

	var info InstanceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}

	return &info, nil
}

// ProjectLockedError reports a project whose lock is held by something that
// can't be identified as a running Juggler — a peer still shutting down, or a
// process that wedged mid-teardown and never let go.
//
// It carries its own recovery advice so that every surface reporting it says
// the same thing: the desktop app renders Advice in a window, the terminal
// prints it. Info is nil when the lock was held but instance.json could not be
// read, which is itself a moment inside someone else's Release.
type ProjectLockedError struct {
	Project string
	Info    *InstanceInfo
}

func (e *ProjectLockedError) Error() string {
	return fmt.Sprintf("project %s is still locked by another process", e.Project)
}

// LockPath is the file a person has to delete if the advice runs out.
func (e *ProjectLockedError) LockPath() string {
	return filepath.Join(e.Project, ".juggler", "juggler.lock")
}

// Advice explains the situation and the way out of it, in the order someone
// stuck needs them: what happened, which file, what usually fixes it, and only
// then the manual step that cannot be undone.
func (e *ProjectLockedError) Advice() string {
	msg := "This project is locked by another process, but Juggler could not connect to the session that holds it.\n\n" +
		"The lock file is:\n" + e.LockPath() + "\n\n" +
		"This usually clears by itself within a few seconds, while the previous session finishes shutting down — try again first. " +
		"If it persists, and you are sure no other Juggler process is running for this project, delete that file and start again."
	if e.Info != nil {
		msg += fmt.Sprintf("\n\nThe lock recorded Juggler process %d at %s:%d, but it did not respond as this project.", e.Info.PID, e.Info.Host, e.Info.Port)
	}
	return msg
}

// CheckProjectLocked probes whether another juggler instance holds the lock for
// projectPath. It is read-only: it never creates directories or writes files,
// and it immediately releases the flock if it was able to acquire it.
//
// Returns (locked bool, info *InstanceInfo, err error).
// locked==false means the path is free (or the lock file doesn't exist yet).
func CheckProjectLocked(projectPath string) (bool, *InstanceInfo, error) {
	lockPath := filepath.Join(projectPath, ".juggler", "juggler.lock")
	infoPath := filepath.Join(projectPath, ".juggler", "instance.json")

	// If the lock file doesn't exist yet, the project is definitely free.
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		return false, nil, nil
	}

	f := flock.New(lockPath)
	acquired, err := f.TryLock()
	if err != nil {
		// Can't tell — treat as unlocked to avoid false positives.
		return false, nil, nil
	}
	if acquired {
		_ = f.Unlock()
		return false, nil, nil
	}

	// Lock is held — read the instance info for a useful error message.
	data, err := os.ReadFile(infoPath)
	if err != nil {
		return true, nil, nil
	}
	var info InstanceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return true, nil, nil
	}
	return true, &info, nil
}

// instanceHealth is the parsed /api/health/instance response used to verify and
// classify a lock-holding server.
type instanceHealth struct {
	Status         string `json:"status"`
	ProjectPath    string `json:"projectPath"`
	PID            int    `json:"pid"`
	ParentPID      int    `json:"parentPid"`
	ExitWithParent bool   `json:"exitWithParent"`
}

// fetchInstanceHealth probes info's /api/health/instance endpoint. It returns
// (nil, nil) when the instance can't be reached or answers non-OK — i.e. "not a
// live instance" — so callers treat any failure as "not running" rather than
// surfacing a transport error.
func fetchInstanceHealth(info *InstanceInfo) (*instanceHealth, error) {
	if info == nil {
		return nil, nil
	}
	url := fmt.Sprintf("http://%s:%d%s", info.Host, info.Port, apipaths.HealthInstance)
	client := &http.Client{Timeout: instanceHealthTimeout}
	resp, err := client.Get(url)
	if err != nil {
		// Can't connect - instance probably not running.
		return nil, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil
	}
	var health instanceHealth
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return nil, nil
	}
	return &health, nil
}

// instanceMatches reports whether h is precisely the process that wrote
// instance.json for expectedProjectPath. A reused PID or another Juggler server
// on the recorded port must never be treated as the lock holder for this project.
func instanceMatches(h *instanceHealth, info *InstanceInfo, expectedProjectPath string) bool {
	return h != nil && h.PID == info.PID && h.ProjectPath == expectedProjectPath
}

// VerifyInstance checks if an instance is actually running via HTTP health check
// Returns true if the instance is verified as Juggler running on the expected project path
func VerifyInstance(info *InstanceInfo, expectedProjectPath string) (bool, error) {
	if info == nil {
		return false, nil
	}
	h, err := fetchInstanceHealth(info)
	if err != nil || h == nil {
		return false, nil
	}
	return instanceMatches(h, info, expectedProjectPath), nil
}

// RunningInstanceStatus classifies a lock-holding server for a desktop viewer's
// reuse decision (see ClassifyRunningInstance).
type RunningInstanceStatus int

const (
	// InstanceUnreachable: the lock is held but no matching server answers — a
	// stale lock, a mismatched pid/project, or a server that isn't responding.
	// The viewer must neither attach nor blindly spawn into the collision.
	InstanceUnreachable RunningInstanceStatus = iota
	// InstanceReusable: a healthy matching server the viewer can attach a window
	// to.
	InstanceReusable
	// InstanceExiting: a matching server started with --exit-with-parent whose
	// parent has already died (reparented to init/launchd, ppid<=1). Its
	// parent-watchdog is about to self-terminate it, so the viewer should wait
	// for it to release the lock and then spawn a fresh server rather than attach
	// a window that would be left stuck on "connecting" when it vanishes.
	InstanceExiting
)

// ClassifyRunningInstance probes a lock-holding server and classifies it for the
// desktop viewer's reuse decision. It is stricter than VerifyInstance: on top of
// the identity check it distinguishes a durable server (reusable) from an orphan
// that is about to self-terminate because the app that owned it has quit — the
// race behind a "connecting to server" hang on a quick quit-then-relaunch.
func ClassifyRunningInstance(info *InstanceInfo, expectedProjectPath string) RunningInstanceStatus {
	h, err := fetchInstanceHealth(info)
	if err != nil || h == nil {
		return InstanceUnreachable
	}
	if !instanceMatches(h, info, expectedProjectPath) {
		return InstanceUnreachable
	}
	if h.ExitWithParent && h.ParentPID <= 1 {
		return InstanceExiting
	}
	return InstanceReusable
}

// RequestGracefulShutdown asks an existing instance to shut down gracefully
// Returns true if the shutdown was acknowledged
func RequestGracefulShutdown(info *InstanceInfo) (bool, error) {
	if info == nil {
		return false, nil
	}

	// Build URL for shutdown endpoint
	url := fmt.Sprintf("http://%s:%d%s", info.Host, info.Port, apipaths.Shutdown)

	client := &http.Client{Timeout: shutdownRequestTimeout}

	resp, err := client.Post(url, "application/json", nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	// 202 Accepted means shutdown was initiated
	return resp.StatusCode == http.StatusAccepted, nil
}

// WaitForShutdown waits for an instance to shut down, polling the health endpoint
// Returns true if the instance shut down within the timeout
func WaitForShutdown(info *InstanceInfo, timeout time.Duration) bool {
	if info == nil {
		return true
	}

	url := fmt.Sprintf("http://%s:%d%s", info.Host, info.Port, apipaths.HealthInstance)
	client := &http.Client{Timeout: shutdownPollInterval * 5}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err != nil {
			// Can't connect - instance is down
			return true
		}
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return true
		}

		time.Sleep(shutdownPollInterval)
	}

	return false
}

// KillExistingInstance attempts to kill an existing instance
// First tries graceful shutdown, then falls back to force kill
func KillExistingInstance(info *InstanceInfo, projectPath string) error {
	if info == nil {
		return nil
	}

	// First verify it's actually running
	running, _ := VerifyInstance(info, projectPath)
	if !running {
		return nil
	}

	// Try graceful shutdown first
	acknowledged, err := RequestGracefulShutdown(info)
	if err == nil && acknowledged {
		if WaitForShutdown(info, gracefulShutdownTimeout) {
			return nil
		}
	}

	// Graceful shutdown failed - force kill
	return forceKillProcess(info.PID)
}

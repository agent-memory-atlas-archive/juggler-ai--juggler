//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/server"
)

// testServerEntry is one isolated Wails subprocess+fixture pair in the pool.
type testServerEntry struct {
	addr    string
	fixture string
	cmd     *exec.Cmd
	proc    *poolProc
}

// poolProc is the liveness record for one pool subprocess. Entries travel
// through testServerPool by value, so this hangs off them as a pointer: every
// lane holding a token of the same subprocess shares one record.
//
// It exists because a subprocess that dies mid-run is otherwise invisible. All
// N lanes live in ONE subprocess, so its death fails every remaining test with
// an anonymous "connection refused" — the same message whether the server
// force-exited on the main-thread watchdog, quit gracefully, or was OOM-killed.
// Nothing else in the harness can tell those apart: the exit status is the only
// evidence, and it is destroyed unless someone waits for it.
type poolProc struct {
	pid        int
	stderrPath string // empty when stderr was discarded
	started    time.Time
	exited     chan struct{} // closed once waitErr/exitedAt are set
	waitErr    error         // result of the single cmd.Wait()
	exitedAt   time.Time
	reported   sync.Once // the full post-mortem is printed once per subprocess
}

// dead reports whether the subprocess has exited, without blocking.
func (p *poolProc) dead() bool {
	if p == nil {
		return false
	}
	select {
	case <-p.exited:
		return true
	default:
		return false
	}
}

// watch performs the one and only cmd.Wait() for this subprocess and records
// its outcome. It runs after scannerDone closes: Wait closes the stdout pipe,
// and the os/exec contract forbids doing that while a reader is still working
// through it (the addr scanner reads until EOF, which the process exit itself
// delivers).
func (p *poolProc) watch(cmd *exec.Cmd, scannerDone <-chan struct{}) {
	<-scannerDone
	err := cmd.Wait()
	p.waitErr = err
	p.exitedAt = time.Now()
	close(p.exited)
}

// status renders the exit as a human phrase: "exit status 1", "signal: killed",
// or "exited cleanly (status 0)".
func (p *poolProc) status() string {
	if p.waitErr == nil {
		return "exited cleanly (status 0)"
	}
	return p.waitErr.Error()
}

// testServerPool is a buffered channel acting as both a pool and a semaphore.
// Each browser test acquires an entry, runs with full isolation, then returns it.
var testServerPool chan testServerEntry

// testLogDir is a throwaway directory the pool points every subprocess's logs
// at (via JUGGLER_LOG_DIR), so a test run never writes browser-test-*.log into
// the user's real application-log directory. Created in TestMain, removed on
// pool shutdown. Empty when unset (e.g. the -short path).
var testLogDir string

// testConfigDir is a throwaway per-user config root inherited by every pool
// subprocess. It isolates cache-backed convenience state such as recent models,
// plus credentials and settings, from the developer's real Juggler profile.
var testConfigDir string

// testSkillsDir is an empty throwaway directory the pool points every
// subprocess's user-scoped skill discovery at (via JUGGLER_SKILLS_USER_DIR), so
// a server — which inherits the developer's real $HOME — never discovers their
// personal ~/.juggler or ~/.agents skills. A discovered skill auto-instantiates
// a Skills context item into every conversation, which would perturb thread
// item-count assertions and make tests pass or fail by the host's installed
// skills. Created in TestMain, removed on pool shutdown.
var testSkillsDir string

// poolConfig controls the test-pool topology.
//
//   - JUGGLER_TEST_WINDOWS=N: number of Wails-window subprocesses (default 3).
//     Each subprocess is fully isolated — its own SessionManager, engine,
//     WebSocket server, and its own WebKit content process. Cranking this up
//     gives perfect isolation but burns more memory and WebKit helper startup
//     time.
//
//   - JUGGLER_TEST_IFRAMES=N: number of test-runner iframes per subprocess
//     (default 3). Each iframe is its own JS realm with its own WebSocket
//     connection, but they share the subprocess's SessionManager, engine,
//     server actors — and its content process, so also one heap and one main
//     thread. Iframes stress-test the server-side concurrency that
//     windows-only topologies hide.
//
// Total parallel-test slots = WINDOWS × IFRAMES. The defaults give 9 slots,
// which benchmarking puts at the knee of the curve: TestBrowser measured ~58s
// at 9 lanes, ~59s at 12 (as 4x3 and as 3x4 alike) and ~61s at 15, so more
// lanes buy nothing and eventually cost. What saturates has changed, though,
// and the distinction matters to anyone re-tuning this: lanes used to sit idle
// on 1s-aligned timers, so the ceiling was how much a single engine could be
// made to do at once. With that alignment switched off (see the test pool's
// DisableHiddenPageDOMTimerThrottling) the lanes run flat out and the ceiling
// is the host's CPU — 10 cores here. So this is a knee for THIS machine, not a
// universal one, and a box with many more cores may well want more lanes.
//
// How those 9 are SHAPED matters as much as how many there are, and 3×3 beats
// 1×9 on the same slot count: 46s and clean against 141–214s and 5–34 arbitrary
// failures. Lanes sharing a subprocess share its content process, so their
// heaps are one heap. Test pages accumulate what their tests do not release,
// and nine lanes' worth in one heap reaches ~2 GB partway through a run, at
// which point collection pauses land on all nine lanes at once: tests fail on
// their own timeouts, picked by luck rather than by fault, and the pool looks
// like it is failing at random. Three lanes' worth stays under that. Spreading
// them also thins the shared session each lane loads, which is a second-order
// win: a lane hydrates a doc per conversation in ITS subprocess, so a third of
// the siblings is a third of the documents.
//
// Three lanes per subprocess still puts several tabs on one server, which is
// what the iframe topology is for.
type poolConfig struct {
	windows int
	iframes int
}

func loadPoolConfig() poolConfig {
	cfg := poolConfig{windows: 3, iframes: 3}
	if v := os.Getenv("JUGGLER_TEST_WINDOWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.windows = n
		}
	}
	if v := os.Getenv("JUGGLER_TEST_IFRAMES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.iframes = n
		}
	}
	return cfg
}

func (c poolConfig) totalSlots() int { return c.windows * c.iframes }

// serverBinary is the server binary every spawn site in this suite runs.
//
// JUGGLER_TEST_SERVER names it outright, for a build system that keeps its
// test-capable server somewhere other than the slot the desktop app occupies —
// pointing the suite at that binary is then a matter of one variable, and
// bin/juggler is left alone.
//
// Otherwise it is <root>/bin plus the platform executable name — "juggler" on
// Unix, "juggler.exe" on Windows. Both halves of the contract need this:
// `go build -o` writes the output name verbatim (it does NOT append .exe on a
// Windows target), and Windows exec.LookPath refuses to run an extension-less
// file. So the spawn sites here and the CI build step must all agree on this
// name, or the suite fails at spawn with "executable file not found" on Windows
// (which -short used to hide).
func serverBinary(root string) string {
	if custom := os.Getenv("JUGGLER_TEST_SERVER"); custom != "" {
		return custom
	}
	name := "juggler"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(root, "bin", name)
}

// TestMain spins up the test-pool topology controlled by poolConfig and
// tears everything down after m.Run() returns.
func TestMain(m *testing.M) {
	flag.Parse()

	if testing.Short() {
		os.Exit(m.Run())
	}

	jugglerRoot, err := server.FindProjectRoot(".")
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot find project root: %v\n", err)
		os.Exit(1)
	}

	binary := serverBinary(jugglerRoot)
	srcFixture := filepath.Join(jugglerRoot, "tests", "benchmarks", "fixtures", "unit-test-fixture")

	log.SetOutput(io.Discard)

	cfg := loadPoolConfig()

	// Redirect every subprocess's logs into a throwaway dir so the run never
	// litters the user's real ~/Library/Logs/Juggler with browser-test-*.log.
	// Removed in poolHandle.shutdown alongside the fixtures.
	if dir, err := os.MkdirTemp("", "juggler-test-logs-*"); err == nil {
		testLogDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test log dir: %v\n", err)
		os.Exit(1)
	}

	// Isolate all per-user application state. Browser tests exercise real HTTP
	// endpoints, including recent-model writes, so inheriting the developer's
	// profile would let synthetic fixtures escape the test process.
	if dir, err := os.MkdirTemp("", "juggler-test-config-*"); err == nil {
		testConfigDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test config dir: %v\n", err)
		os.Exit(1)
	}

	// Isolate user-scoped skill discovery to an empty dir so the developer's
	// real ~/.juggler and ~/.agents skills never leak into a test conversation
	// (see testSkillsDir).
	if dir, err := os.MkdirTemp("", "juggler-test-skills-*"); err == nil {
		testSkillsDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test skills dir: %v\n", err)
		os.Exit(1)
	}

	testServerPool = make(chan testServerEntry, cfg.totalSlots())
	startedPool := &poolHandle{}

	// Trap SIGINT/SIGTERM so a Ctrl-C or test-killing signal still reaps the
	// pool. The other escape hatch — Go's `panic: test timed out` from the
	// testing alarm — runs in a goroutine and crashes the process without
	// running deferreds; the subprocess-side parent-watchdog catches that.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		startedPool.shutdown()
		os.Exit(130)
	}()

	// Start cfg.windows subprocesses; each hosts cfg.iframes iframe lanes.
	// One fixture dir per subprocess, passed to it as --project: all iframes
	// inside a subprocess share its SessionManager+engine+WS, so they share
	// that fixture too, and every slot token for the subprocess carries it.
	// Tests collaborate on the shared root by prefixing their filenames; a
	// suite that cannot is declared exclusive and scheduled alone (see
	// listExclusiveTests in web/js-tests/utilities/integration-test-executor.js).
	for w := 0; w < cfg.windows; w++ {
		fixtureDir, err := os.MkdirTemp("", "browser-test-*")
		if err != nil {
			fmt.Fprintf(os.Stderr, "cannot create fixture dir: %v\n", err)
			startedPool.shutdown()
			os.Exit(1)
		}

		if err := copyDir(srcFixture, fixtureDir); err != nil {
			fmt.Fprintf(os.Stderr, "cannot copy fixture: %v\n", err)
			os.RemoveAll(fixtureDir)
			startedPool.shutdown()
			os.Exit(1)
		}

		entry, err := startJugglerSubprocess(binary, fixtureDir, cfg.iframes)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cannot start juggler subprocess: %v\n", err)
			os.RemoveAll(fixtureDir)
			startedPool.shutdown()
			os.Exit(1)
		}

		startedPool.add(entry)
		// One slot token per iframe lane: tests acquire a token to enter
		// the semaphore (capped at totalSlots concurrent in-flight tests).
		for i := 0; i < cfg.iframes; i++ {
			testServerPool <- entry
		}
	}

	code := m.Run()

	startedPool.shutdown()
	os.Exit(code)
}

// poolHandle owns the started subprocesses so they can be reaped exactly
// once, whether the run exits cleanly, via signal, or via Go's testing
// alarm panic. add() is called from a single goroutine before m.Run()
// starts; shutdown() is idempotent via sync.Once.
type poolHandle struct {
	entries []testServerEntry
	once    sync.Once
}

func (p *poolHandle) add(e testServerEntry) {
	p.entries = append(p.entries, e)
}

func (p *poolHandle) shutdown() {
	p.once.Do(func() {
		cleanupPool(p.entries)
		for _, e := range p.entries {
			os.RemoveAll(e.fixture)
		}
		if testLogDir != "" {
			os.RemoveAll(testLogDir)
		}
		if testConfigDir != "" {
			os.RemoveAll(testConfigDir)
		}
		if testSkillsDir != "" {
			os.RemoveAll(testSkillsDir)
		}
	})
}

func envWithOverride(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			out = append(out, entry)
		}
	}
	return append(out, prefix+value)
}

// startJugglerSubprocess starts a slot subprocess and returns the entry once
// JUGGLER_ADDR= is printed to stdout. If iframes>1, the subprocess opens its
// viewer window at /test-pool?n=iframes (one Wails window hosting N test
// lanes); otherwise it opens the production app which self-redirects to
// /headless-test. Set JUGGLER_TEST_SHOW_WINDOW=1 to make the window visible.
func startJugglerSubprocess(binary, fixture string, iframes int) (testServerEntry, error) {
	args := []string{"--test", "--assets-from-disk", "--port", "0", "--project", fixture}
	if iframes > 1 {
		args = append(args, "--test-iframes", strconv.Itoa(iframes))
	}
	if os.Getenv("JUGGLER_TEST_SHOW_WINDOW") == "1" {
		args = append(args, "--window")
	}
	cmd := exec.Command(binary, args...)
	// Opt-in coalescing stress: set JUGGLER_TEST_SYNC_THROTTLE_MS to a larger
	// value to widen the outbound-sync window so a fast turn's busy→idle
	// transition always merges into one broadcast — useful for hunting waits
	// that depend on observing a transient state edge instead of a durable
	// fence (Conversation.completedTurns). NOT forced on by default: a global
	// throttle bump also slows every cross-conversation sync, which makes
	// load-sensitive multi-conv tests exceed their budget. The env is inherited
	// by the child (resolveSyncThrottle reads it in cmd/juggler/worker); the
	// default (10ms) is the production value. Run e.g.
	// `JUGGLER_TEST_SYNC_THROTTLE_MS=40 make test` for a targeted stress pass.
	cmd.Env = os.Environ()
	// Always enable the per-worker event tape in the pool. It's a fixed-size
	// ring buffer per conversation worker, so the cost is negligible, and it
	// is the only way a browser-test failure block can include the WORKER
	// TAPE section (the /api/test/dump-tape endpoint returns nothing when
	// tracing is off).
	cmd.Env = envWithOverride(cmd.Env, "JUGGLER_TRACE", "1")
	// Redirect this server's logs into the pool's throwaway dir (see testLogDir)
	// so the run never writes into the user's real application-log directory.
	if testLogDir != "" {
		cmd.Env = envWithOverride(cmd.Env, "JUGGLER_LOG_DIR", testLogDir)
	}
	// Redirect all user-level state, including cache-backed recent models, away
	// from the developer's profile.
	if testConfigDir != "" {
		configDir := filepath.Join(testConfigDir, filepath.Base(fixture))
		cmd.Env = envWithOverride(cmd.Env, "JUGGLER_CONFIG_DIR", configDir)
	}
	// Point user-scoped skill discovery at an empty throwaway dir (see
	// testSkillsDir) so the developer's real ~/.juggler / ~/.agents skills never
	// leak in as an auto-instantiated Skills context item and skew item counts.
	if testSkillsDir != "" {
		cmd.Env = envWithOverride(cmd.Env, "JUGGLER_SKILLS_USER_DIR", testSkillsDir)
	}
	// Put the child in its own process group so we can kill the whole group
	// (parent + any grandchildren) on cleanup. Without this, signals to the
	// test process don't reach Wails-spawned WebKit helpers, and they survive
	// as orphans when the test panics on Go's 15-minute alarm.
	setProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return testServerEntry{}, fmt.Errorf("stdout pipe: %w", err)
	}
	// Pipe stderr to a per-subprocess log under the platform temp dir so we can
	// post-mortem batch hangs after the fact — and so poolDeath can quote its
	// tail into the failing test, which is the only place a reader ever sees it
	// on CI. Set JUGGLER_TEST_DISCARD_STDERR=1 to skip.
	stderrPath := ""
	if os.Getenv("JUGGLER_TEST_DISCARD_STDERR") == "1" {
		cmd.Stderr = io.Discard
	} else {
		logDir := filepath.Join(os.TempDir(), "juggler-test-logs")
		if err := os.MkdirAll(logDir, 0o755); err != nil {
			return testServerEntry{}, fmt.Errorf("create log dir: %w", err)
		}
		stderrPath = filepath.Join(logDir, "juggler-stderr-"+filepath.Base(fixture)+".log")
		stderrFile, err := os.Create(stderrPath)
		if err != nil {
			return testServerEntry{}, fmt.Errorf("stderr file: %w", err)
		}
		cmd.Stderr = stderrFile
	}

	if err := cmd.Start(); err != nil {
		return testServerEntry{}, fmt.Errorf("start: %w", err)
	}

	proc := &poolProc{
		pid:        cmd.Process.Pid,
		stderrPath: stderrPath,
		started:    time.Now(),
		exited:     make(chan struct{}),
	}

	addrCh := make(chan string, 1)
	scannerDone := make(chan struct{})
	go func() {
		defer close(scannerDone)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if after, ok := strings.CutPrefix(line, "JUGGLER_ADDR="); ok {
				addrCh <- after
			}
		}
	}()
	// The single owner of cmd.Wait() for this subprocess, for the whole run: a
	// second Wait elsewhere would race it and lose the exit status.
	go proc.watch(cmd, scannerDone)

	select {
	case addr := <-addrCh:
		return testServerEntry{addr: addr, fixture: fixture, cmd: cmd, proc: proc}, nil
	case <-time.After(60 * time.Second):
		signalGroup(cmd, syscall.SIGKILL)
		<-proc.exited
		return testServerEntry{}, fmt.Errorf("timeout waiting for JUGGLER_ADDR from %s", binary)
	}
}

// cleanupPool gracefully terminates all subprocess entries in the slice.
// Signals the entire process group (children too — Wails spawns WebKit
// helpers) so nothing survives as an orphan.
func cleanupPool(entries []testServerEntry) {
	for _, e := range entries {
		signalGroup(e.cmd, syscall.SIGTERM)
	}
	// Wait on each subprocess's liveness record rather than calling cmd.Wait()
	// here: the watch goroutine started at spawn already owns that call.
	done := make(chan struct{})
	go func() {
		for _, e := range entries {
			if e.proc != nil {
				<-e.proc.exited
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		for _, e := range entries {
			signalGroup(e.cmd, syscall.SIGKILL)
		}
	}
}

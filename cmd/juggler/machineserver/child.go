//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/childcontain"
	"juggler/internal/jlog"
	"juggler/internal/logpaths"
)

// childStartTimeout bounds how long a freshly spawned session child may take
// to print its bound address before the spawn is abandoned.
const childStartTimeout = 20 * time.Second

// childStopGrace is how long a child gets to exit after a graceful interrupt
// before its process tree is killed.
const childStopGrace = 3 * time.Second

// child is one live session-child process: today's per-project server, spawned
// with --session-child and contained via childcontain for tree-kill. That flag
// binds it to a loopback ephemeral port and stops it applying the saved
// LAN/WAN-on-launch preferences, so it is reachable only through the proxy.
type child struct {
	cmd       *exec.Cmd
	contained *childcontain.Child
	addr      string
	exited    chan struct{} // closed by the monitor goroutine when the process exits
}

// newChildCommand builds the exec.Cmd for a session child. A package variable
// so tests can substitute a stub child process. bin comes from the supervisor's
// own executable path (or $JUGGLER_SERVER_BIN) and the args are fixed flags
// plus a validated project path passed as separate argv elements — no shell,
// nothing request-derived beyond the directory path the control API validated.
var newChildCommand = func(bin, project string) *exec.Cmd {
	args := []string{"--session-child",
		"--port", "0",
		"--log-file", logpaths.ServerLogPath(project),
		"--project", project}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return exec.Command(bin, args...) //nolint:gosec // operator-controlled bin+args, no shell
}

// spawnChild starts a session child for project and waits for its ready
// handshake (a JUGGLER_ADDR=<host:port> line on stdout). The child keeps
// running after return; the caller owns stopping it via stop().
func spawnChild(bin, project string) (*child, error) {
	cmd := newChildCommand(bin, project)

	// The child's stderr carries only genuine panics / pre-logging output;
	// capture it to the project's crash sink (single writer per project). The
	// child keeps its own fd after Start, so our copy closes below.
	if sink := openStderrSink(project); sink != nil {
		cmd.Stderr = sink
		defer sink.Close()
	} else {
		cmd.Stderr = os.Stderr
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("session child stdout pipe: %w", err)
	}

	childcontain.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start session child: %w", err)
	}
	contained, err := childcontain.Adopt(cmd)
	if err != nil {
		jlog.Error("[machineserver] child containment incomplete for %s: %v", project, err)
	}

	c := &child{cmd: cmd, contained: contained, exited: make(chan struct{})}

	// Monitor: reap the process and release containment resources exactly once,
	// whatever caused the exit. Everyone else observes c.exited.
	go func() {
		_, _ = cmd.Process.Wait()
		c.contained.Cleanup()
		close(c.exited)
	}()

	// Scan stdout for the ready handshake, then keep draining so the child
	// never blocks on a full pipe. The scanner exits on EOF when the child does.
	addrCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if addr, ok := strings.CutPrefix(sc.Text(), "JUGGLER_ADDR="); ok {
				select {
				case addrCh <- strings.TrimSpace(addr):
				default:
				}
			}
		}
	}()

	select {
	case addr := <-addrCh:
		c.addr = addr
		return c, nil
	case <-c.exited:
		return nil, fmt.Errorf("session child for %s exited before reporting its address (see %s)",
			project, logpaths.StderrLogPath(project))
	case <-time.After(childStartTimeout):
		_ = c.contained.Terminate()
		return nil, fmt.Errorf("session child for %s did not report its address within %s", project, childStartTimeout)
	}
}

// stop tears the child down: graceful interrupt, a grace period, then a
// process-tree kill. It returns once the process has exited (or shortly after
// the kill was issued, as a backstop against an unreapable process). On
// Windows, where signalling another process is unsupported, it tree-kills
// immediately.
func (c *child) stop() {
	if c == nil || c.cmd == nil || c.cmd.Process == nil {
		return
	}
	if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
		_ = c.contained.Terminate()
	} else {
		select {
		case <-c.exited:
			return
		case <-time.After(childStopGrace):
			_ = c.contained.Terminate()
		}
	}
	select {
	case <-c.exited:
	case <-time.After(childStopGrace):
		jlog.Error("[machineserver] session child pid %d did not exit after kill", c.cmd.Process.Pid)
	}
}

// openStderrSink opens the per-project raw-stderr crash file for a session
// child (logpaths.StderrLogPath): one file per project means a single writer.
// Returns nil if it can't be opened; the caller falls back to our stderr.
func openStderrSink(project string) *os.File {
	p := logpaths.StderrLogPath(project)
	if os.MkdirAll(filepath.Dir(p), 0o755) != nil {
		return nil
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil
	}
	return f
}

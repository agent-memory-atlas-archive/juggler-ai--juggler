//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"juggler/cmd/juggler/childcontain"
	"juggler/internal/jlog"
)

// Approved shell strings must run through a POSIX shell, not cmd.exe/PowerShell:
// the command-approval analyser tokenises and proves each command as sh/bash
// syntax, so running the same string through a different language would mean the
// static safety proof was computed against a shell other than the one that runs.
//
// On Windows we resolve that POSIX shell in priority order:
//
//  1. WSL (`wsl.exe -e sh -c …`) — a full Linux userland (real coreutils,
//     python3); its interop layer translates cmd.Dir (a Windows path) to
//     /mnt/<drive>/…, so relative paths in approved commands resolve unchanged.
//     But bare presence of wsl.exe means nothing: Windows ships a stub on PATH
//     that errors ("WSL is not installed") until a distro is provisioned, so we
//     must actually run it to know (see probeWSL).
//  2. A Git-for-Windows POSIX shell (`bash.exe -c …`). The approval analyser
//     explicitly supports git-bash-shaped commands — same POSIX tokenisation as
//     WSL sh — so the executed language stays identical to the validated one.
//  3. Nothing: command-start fails with a message saying which of these was
//     tried and why it failed, instead of a cryptic wsl.exe error.

// winPOSIX describes the POSIX toolchain resolved for this Windows host: the
// argv prefix used to run an approved shell string, and the one used to run a
// Python program fed on stdin. A nil prefix means "unavailable"; the paired
// *Err explains why, surfaced at command-start.
type winPOSIX struct {
	shell     []string // argv prefix; the command string is appended. nil if none.
	python    []string // full argv for `python -` (program on stdin). nil if none.
	shellErr  error
	pythonErr error
}

const (
	// wslListTimeout bounds `wsl.exe -l -q`, which asks the WSL service for its
	// distros without booting one. It is normally instant; the allowance covers
	// the service itself starting.
	wslListTimeout = 30 * time.Second
	// wslShellTimeout bounds the first `sh` in WSL, which may have to boot the
	// utility VM: WSL2 parks it when idle, and a cold boot on a busy machine or
	// just after an update has been seen to take well over ten seconds.
	wslShellTimeout = 60 * time.Second
	// winShellRetry is how long a failed resolution stands before the next
	// command probes again (see toolchainCache).
	winShellRetry = 10 * time.Second
)

// winShellCache keeps the first toolchain that has a shell for the rest of the
// server run, so the WSL probe is paid once. A resolution with no shell is
// retried (see toolchainCache), which also picks up a WSL or Git install
// completed after startup.
var winShellCache = newToolchainCache(resolveWinPOSIX, winShellRetry)

func winShell() winPOSIX { return winShellCache.get() }

// resolveWinPOSIX resolves the toolchain and reports whether it is worth
// keeping: it is exactly when it has a shell. Each outcome is logged, since the
// error the user sees is all they have otherwise.
func resolveWinPOSIX() (winPOSIX, bool) {
	start := time.Now()
	wsl := probeWSL()
	if wsl.ready {
		jlog.Info("ops: POSIX shell is WSL (distros: %s), probed in %s", strings.Join(wsl.distros, ", "), time.Since(start).Round(time.Millisecond))
		return winPOSIX{
			shell:  []string{"wsl.exe", "-e", "sh", "-c"},
			python: []string{"wsl.exe", "-e", "python3", "-"},
		}, true
	}

	res := winPOSIX{shellErr: noShellError(wsl), pythonErr: noPythonError(wsl)}

	// Fall back to a Git-for-Windows POSIX shell for command execution.
	if sh := findGitBashShell(); sh != "" {
		res.shell = []string{sh, "-c"}
		res.shellErr = nil
	}

	// Python has no git-bash equivalent (Git for Windows bundles no interpreter),
	// so use a native Windows Python if one is installed. It reads a program from
	// stdin via `-` and takes a Windows working directory natively.
	if py := findWindowsPython(); py != "" {
		res.python = []string{py, "-"}
		res.pythonErr = nil
	}

	elapsed := time.Since(start).Round(time.Millisecond)
	switch {
	case res.shell != nil && wsl.err != nil:
		jlog.Info("ops: WSL unusable (%v); POSIX shell is %s, probed in %s", wsl.err, res.shell[0], elapsed)
	case res.shell != nil:
		jlog.Info("ops: POSIX shell is %s, probed in %s", res.shell[0], elapsed)
	default:
		jlog.Error("ops: no POSIX shell, probed in %s, retrying after %s: %v", elapsed, winShellRetry, res.shellErr)
	}
	return res, res.shell != nil
}

// wslProbe is what probeWSL learned. No distros means WSL is absent for our
// purposes — wsl.exe missing, the stub, or nothing provisioned. Distros without
// ready means WSL is there but could not run a shell, and err says why.
type wslProbe struct {
	distros  []string
	ready    bool
	timedOut bool // err is a deadline, not an answer: WSL may simply be starting
	err      error
}

// probeWSL decides whether WSL can run a POSIX shell, in two steps so a slow
// WSL is never mistaken for an absent one. Listing distros says whether WSL is
// installed and provisioned without booting anything. Only then is the exact
// form newShellCmd uses run, so the probe cannot disagree with what a real
// command would do — given a deadline long enough for a cold VM boot.
func probeWSL() wslProbe {
	if _, err := exec.LookPath("wsl.exe"); err != nil {
		return wslProbe{}
	}
	out, timedOut, err := runWSL(wslListTimeout, "-l", "-q")
	if timedOut {
		return wslProbe{timedOut: true, err: fmt.Errorf("`wsl.exe -l -q` did not answer within %s", wslListTimeout)}
	}
	distros := parseWSLDistroList(out)
	if err != nil || len(distros) == 0 {
		return wslProbe{}
	}

	out, timedOut, err = runWSL(wslShellTimeout, "-e", "sh", "-c", "exit 0")
	switch {
	case timedOut:
		return wslProbe{distros: distros, timedOut: true, err: fmt.Errorf("WSL did not start a shell within %s", wslShellTimeout)}
	case err != nil:
		msg := strings.TrimSpace(strings.ReplaceAll(decodeWSLOutput(out), "\x00", ""))
		return wslProbe{distros: distros, err: fmt.Errorf("`wsl.exe -e sh` failed: %v: %s", err, msg)}
	}
	return wslProbe{distros: distros, ready: true}
}

// runWSL runs wsl.exe with a deadline and returns its combined output, and
// whether the deadline is what ended it. Capturing the output also keeps the
// stub's "not installed" message off the server console.
func runWSL(timeout time.Duration, args ...string) (out []byte, timedOut bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wsl.exe", args...)
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
	out, err = cmd.CombinedOutput()
	return out, errors.Is(ctx.Err(), context.DeadlineExceeded), err
}

// noShellError says why there is no shell, distinguishing a WSL that is there
// but failing from one that is not there at all: telling a user with a working
// but slow WSL to install WSL sends them the wrong way.
func noShellError(wsl wslProbe) error {
	switch {
	case wsl.timedOut:
		return fmt.Errorf("WSL is installed but not responding (%w); it may still be starting, and the next command will try again. Git for Windows would give a fallback shell", wsl.err)
	case wsl.err != nil:
		return fmt.Errorf("WSL is installed but cannot run a shell (%w); check the default distro with `wsl --list --verbose`, or install Git for Windows", wsl.err)
	}
	return errors.New("no POSIX shell available: install WSL (`wsl --install`) or Git for Windows")
}

func noPythonError(wsl wslProbe) error {
	if wsl.err != nil {
		return fmt.Errorf("no Python interpreter available: WSL cannot be used (%w) and no Python for Windows was found", wsl.err)
	}
	return errors.New("no Python interpreter available: install WSL (`wsl --install`) or Python for Windows")
}

// findGitBashShell locates a Git-for-Windows POSIX shell, preferring an explicit
// Git install over a PATH lookup so it can never resolve to
// C:\Windows\System32\bash.exe — that is the WSL launcher, which wslUsable has
// already ruled out.
func findGitBashShell() string {
	var candidates []string
	for _, root := range gitInstallRoots() {
		candidates = append(candidates,
			filepath.Join(root, "bin", "bash.exe"),
			filepath.Join(root, "usr", "bin", "sh.exe"),
		)
	}
	// A sh.exe on PATH is a safe last resort: unlike bash.exe, WSL contributes no
	// sh.exe to System32, so this cannot loop back to WSL.
	if p, err := exec.LookPath("sh.exe"); err == nil {
		candidates = append(candidates, p)
	}
	for _, c := range candidates {
		if statIsFile(c) {
			return c
		}
	}
	return ""
}

// gitInstallRoots returns candidate Git-for-Windows install roots: derived from
// a git.exe on PATH (…\Git\cmd\git.exe → …\Git, so a non-standard install is
// found) plus the standard system and per-user install directories.
func gitInstallRoots() []string {
	var roots []string
	if gitPath, err := exec.LookPath("git.exe"); err == nil {
		// …\Git\cmd\git.exe or …\Git\bin\git.exe → …\Git
		roots = append(roots, filepath.Dir(filepath.Dir(gitPath)))
	}
	if dir := os.Getenv("ProgramFiles"); dir != "" {
		roots = append(roots, filepath.Join(dir, "Git"))
	}
	if dir := os.Getenv("ProgramFiles(x86)"); dir != "" {
		roots = append(roots, filepath.Join(dir, "Git"))
	}
	if dir := os.Getenv("LocalAppData"); dir != "" {
		roots = append(roots, filepath.Join(dir, "Programs", "Git"))
	}
	return roots
}

// findWindowsPython locates a native Windows Python interpreter for the
// stdin-fed code path, trying the usual executable names in priority order. It
// skips the Microsoft Store execution-alias stub (under \WindowsApps\), which
// exists even with no Python installed and would open the Store instead of
// running code.
func findWindowsPython() string {
	for _, name := range []string{"python3.exe", "python.exe", "py.exe"} {
		if p, err := exec.LookPath(name); err == nil && !isWindowsStoreStub(p) {
			return p
		}
	}
	return ""
}

func isWindowsStoreStub(p string) bool {
	return strings.Contains(strings.ToLower(p), `\windowsapps\`)
}

func statIsFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// newShellCmd builds the command that runs an approved shell string through the
// resolved POSIX shell (see the package-level comment). When none is available,
// it returns a command whose Start reports a clear, actionable error.
func newShellCmd(ctx context.Context, command string) *exec.Cmd {
	return shellCmdFrom(ctx, winShell(), command)
}

// newPythonCmd builds the command that runs Python with the program supplied on
// stdin (caller sets cmd.Stdin), using the resolved interpreter — WSL's python3
// when WSL is in use, otherwise a native Windows Python.
func newPythonCmd(ctx context.Context) *exec.Cmd {
	return pythonCmdFrom(ctx, winShell())
}

// shellCmdFrom / pythonCmdFrom build the *exec.Cmd from an already-resolved
// toolchain. Split out from the memoised newShellCmd/newPythonCmd so the
// no-shell-available branch is testable without depending on the host.
func shellCmdFrom(ctx context.Context, p winPOSIX, command string) *exec.Cmd {
	if p.shell == nil {
		return &exec.Cmd{Err: p.shellErr}
	}
	argv := append(append([]string{}, p.shell...), command)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	takeTreeOnCancel(cmd)
	return cmd
}

func pythonCmdFrom(ctx context.Context, p winPOSIX) *exec.Cmd {
	if p.python == nil {
		return &exec.Cmd{Err: p.pythonErr}
	}
	cmd := exec.CommandContext(ctx, p.python[0], p.python[1:]...)
	takeTreeOnCancel(cmd)
	return cmd
}

// takeTreeOnCancel replaces the kill os/exec performs when the command's context
// is done.
//
// Its default is Process.Kill: on Windows a TerminateProcess against a single
// pid, which terminates that process's threads and nothing it started. One pid
// is never the whole command here. The POSIX shell resolved above is normally
// `Git\bin\bash.exe`, which is not bash at all but a launcher that sets MSYSTEM
// and PATH, spawns `Git\usr\bin\bash.exe` as a separate child, and waits on it.
// Terminating the process we started therefore leaves the real shell — and the
// build, test run or install it is part-way through — alive and orphaned.
//
// Orphaned is also out of reach, which is what makes the default kill worse than
// no kill at all: taskkill /T reconstructs descendants from the parent-child
// edges that are live when it runs, so it must start from a leader that is still
// there. Killing the leader first destroys the only route to everything under
// it, and the pid it leaves behind is reused within seconds by something with no
// relation to us. So the tree is taken from here, before anything has terminated
// the leader, rather than from a handler racing os/exec for the right to kill it
// first.
//
// A cancel that killed the launcher and left the work running would be a lie the
// user discovers through a fan and a lock file, having been told it stopped.
func takeTreeOnCancel(cmd *exec.Cmd) {
	// nil leaves Wait reporting the command's own exit status rather than an
	// error of ours, as it did when the kill was os/exec's.
	cmd.Cancel = func() error {
		killProcessGroup(cmd)
		return nil
	}
}

// setProcGroup puts the command in a console process group of its own, so a
// Ctrl-C delivered to the server's console is not also delivered to every
// command it is running.
//
// It buys nothing for killing: a Windows process group is addressable only by
// console control events, is ignorable by each recipient, and reaches no process
// that made a console of its own. taskkill /T does not consult it — it walks
// parent-child edges — and there is no kill-the-group call to reach for.
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// contained holds the job object each running command's tree belongs to, keyed
// by the command that leads it. An entry lives from startContained to
// releaseContainment, which is the window in which a kill can be asked for.
//
// containedGate is a size-1 semaphore guarding the map (the project forbids
// sync.Mutex; channels are the house style). Reads take it too — they are map
// lookups, so there is nothing for a reader/writer split to win here.
var (
	containedGate = make(chan struct{}, 1)
	contained     = map[*exec.Cmd]*childcontain.Child{}
)

// startContained starts a command with its whole process tree inside a job
// object, so the tree can later be taken in one act rather than reconstructed.
//
// The command is created suspended and resumed only once it is in the job.
// That ordering is the whole point: AssignProcessToJobObject captures the
// process it is given and every process that one starts afterwards, but nothing
// it has already started. A command left to run while we assign would race the
// launcher described in takeTreeOnCancel — which spawns the real shell as one of
// the first things it does — and lose often enough that the escaped shell, and
// the work it is part-way through, would outlive an occasional cancel.
//
// A command that cannot be contained still runs: it is resumed either way, and
// killProcessGroup falls back to walking the tree. A suspended process that was
// never resumed would hang forever, so nothing here may return before the resume.
func startContained(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED

	if err := cmd.Start(); err != nil {
		return err
	}
	defer resumeProcess(cmd.Process.Pid)

	child, err := childcontain.Adopt(cmd)
	if err != nil {
		jlog.Error("ops: shell tree not contained, falling back to taskkill: %v", err)
		return nil
	}
	containedGate <- struct{}{}
	contained[cmd] = child
	<-containedGate
	return nil
}

// releaseContainment closes the command's job once it has been reaped. The job
// is empty by then, so closing it kills nothing; leaving it open would leak the
// handle for the life of the server.
func releaseContainment(cmd *exec.Cmd) {
	containedGate <- struct{}{}
	child := contained[cmd]
	delete(contained, cmd)
	<-containedGate
	child.Cleanup() // nil-safe, and idempotent against a kill that got there first
}

// resumeProcess lets a suspended process run. Go hands back a process but not
// the thread it was created with, so the thread is found by asking the OS which
// threads that process owns — at this point it has exactly one, the initial
// thread CreateProcess made and suspended.
func resumeProcess(pid int) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		jlog.Error("ops: cannot enumerate threads to resume pid %d: %v", pid, err)
		return
	}
	defer func() { _ = windows.CloseHandle(snapshot) }()

	var entry windows.ThreadEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != uint32(pid) {
			continue
		}
		thread, openErr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if openErr != nil {
			jlog.Error("ops: cannot open thread %d to resume pid %d: %v", entry.ThreadID, pid, openErr)
			continue
		}
		_, resumeErr := windows.ResumeThread(thread)
		_ = windows.CloseHandle(thread)
		if resumeErr != nil {
			jlog.Error("ops: cannot resume pid %d: %v", pid, resumeErr)
		}
	}
}

// killProcessGroup kills the process tree on Windows.
//
// A contained command is taken by terminating its job: one call, every member,
// including whatever it started after it was contained. That is atomic against a
// tree still spawning, idempotent against the two callers that race here on a
// cancel (cmd.Cancel and the execute path's own kill), and immune to the
// unreachability described in takeTreeOnCancel, since a job holds its members
// however their parents have fared.
//
// Only a command that could not be contained falls back to walking the tree, and
// only that fallback needs the leader alive to walk down from.
func killProcessGroup(cmd *exec.Cmd) {
	containedGate <- struct{}{}
	child := contained[cmd]
	<-containedGate
	if child != nil {
		if err := child.Terminate(); err != nil {
			jlog.Error("ops: cannot terminate contained shell tree: %v", err)
		}
		return
	}

	if cmd.Process == nil {
		return
	}
	// /F = force, /T = tree (kill child processes), /PID = process ID
	kill := exec.Command("taskkill", "/F", "/T", "/PID", fmt.Sprintf("%d", cmd.Process.Pid))
	// A kill that silently did nothing is how a command outlives its cancel, so
	// say so rather than leaving a survivor to be discovered by a fan.
	if out, err := kill.CombinedOutput(); err != nil {
		jlog.Error("ops: taskkill on pid %d failed: %v: %s", cmd.Process.Pid, err, strings.TrimSpace(string(out)))
	}
}

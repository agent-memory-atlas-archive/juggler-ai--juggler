//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"os"
	"time"
)

// ShellOperations handles shell command execution: the op handlers behind the
// shell tool. Execution itself lives in shell_exec.go, the process registry
// every background task is tracked through in shell_registry.go, the streaming
// path in shell_stream.go, and command parsing in shell_command_parse.go.
//
// Trust model: every command reaching this layer must already have been
// approved by the user via the UI approval flow. There is no server-side
// whitelist. bestEffortShellSanityCheck is a foot-gun filter, not a security
// boundary.
type ShellOperations struct {
	scope PathScope

	// Watchdog tuning for the streaming "why is this silent?" feedback. Zero
	// means "use the default"; tests override these (and probeFn) directly to
	// stay deterministic and fast without hardcoding multi-second waits.
	probeDeadline     time.Duration    // how long the fs-access probe may block before we call it "awaiting-permission"
	heartbeatInterval time.Duration    // how long a command may be silent before a neutral "still running" status
	probeFn           func(dir string) // filesystem-access probe; default os.Stat(dir)

	// Cancel/timeout teardown tuning for ExecuteStreaming. Zero means "use the
	// default"; tests override these to exercise the escaped-grandchild path
	// without waiting multiple real seconds.
	killGrace time.Duration // after SIGTERM, wait this long before SIGKILL of the process group
	reapGrace time.Duration // then wait at most this long for the process to exit before force-closing the pipe
}

// NewShellOperations creates a new shell operations handler
func NewShellOperations(scope PathScope) *ShellOperations {
	return &ShellOperations{
		scope: scope,
	}
}

// Default watchdog timings. The probe deadline MUST stay below the heartbeat
// interval: a pending permission prompt is detected first (probe blocks past
// its deadline) so the specific "awaiting-permission" status pre-empts the
// neutral heartbeat. Generic silence (slow build, network, sleep) lets the
// probe return fast, so only the heartbeat fires.
const (
	defaultProbeDeadline     = 1500 * time.Millisecond
	defaultHeartbeatInterval = 4 * time.Second
)

const (
	// streamKillGrace is how long the ExecuteStreaming cancel/timeout path waits
	// after SIGTERM before force-killing the process group.
	streamKillGrace = 5 * time.Second
	// streamReapGrace bounds how long that path then waits for the process to
	// actually exit (cmd.Wait, via cmdDone) before giving up and force-closing the
	// output pipe. It is longer than streamKillGrace so a process reaped by the
	// SIGKILL above is normally collected cleanly and its output tail preserved;
	// the cap only bites when a grandchild has escaped the process group and
	// wedged the pipe, which would otherwise block the return indefinitely — long
	// past the command's deadline.
	streamReapGrace = 7 * time.Second
)

func (ops *ShellOperations) probeDeadlineOrDefault() time.Duration {
	if ops.probeDeadline > 0 {
		return ops.probeDeadline
	}
	return defaultProbeDeadline
}

func (ops *ShellOperations) heartbeatIntervalOrDefault() time.Duration {
	if ops.heartbeatInterval > 0 {
		return ops.heartbeatInterval
	}
	return defaultHeartbeatInterval
}

func (ops *ShellOperations) killGraceOrDefault() time.Duration {
	if ops.killGrace > 0 {
		return ops.killGrace
	}
	return streamKillGrace
}

func (ops *ShellOperations) reapGraceOrDefault() time.Duration {
	if ops.reapGrace > 0 {
		return ops.reapGrace
	}
	return streamReapGrace
}

func (ops *ShellOperations) probeFnOrDefault() func(dir string) {
	if ops.probeFn != nil {
		return ops.probeFn
	}
	// A real TCC consent dialog makes this stat block while pending; a decided
	// (granted or denied) state returns fast.
	return func(dir string) { _, _ = os.Stat(dir) }
}

// Execute executes a shell operation
func (ops *ShellOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "execute":
		return ops.execute(ctx, params)
	case "startBackground":
		return ops.startBackground(params)
	case "getOutput":
		return ops.getOutput(params)
	case "getOutputDelta":
		return ops.getOutputDelta(params)
	case "kill":
		return ops.kill(params)
	case "listBackgroundShells":
		return ops.listBackgroundShells(params)
	case "taskStatus":
		return ops.taskStatus(params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// ownedTask resolves a caller-supplied task id to a shell the caller is entitled
// to act on, or nil. Two checks, and they are not the same kind of thing:
//
//   - Project. The registry is process-global and survives a project switch, so a
//     bare id would otherwise reach a task belonging to a project this caller is
//     no longer (or was never) in. Comparing the spawn-time root against the
//     caller's current scope root is a genuine boundary between sessions.
//   - Conversation. Optional, and enforced only when the caller names one. This
//     is scoping rather than privilege: /api/ops/call authenticates with a single
//     per-instance token and there is no per-conversation identity behind it, so
//     conv_id is a statement of which conversation the caller is acting for, not
//     proof of anything. It still earns its place — a surface that knows about one
//     conversation should not be able to reach into another's tasks by id — but do
//     not read it as an access-control decision.
//
// A rejected lookup is indistinguishable from an unknown id on purpose: callers
// report "not found", which neither confirms nor denies that the task exists
// somewhere the caller cannot see.
func (ops *ShellOperations) ownedTask(taskID string, params map[string]any) *BackgroundShell {
	shell := getBackgroundShell(taskID)
	if shell == nil {
		return nil
	}
	if !sameProject(shell.ProjectRoot, ops.scope.Root()) {
		return nil
	}
	if convID, _ := params["conv_id"].(string); convID != "" && shell.ConvID != convID {
		return nil
	}
	return shell
}

// getOutput retrieves output from a background shell
func (ops *ShellOperations) getOutput(params map[string]any) (any, error) {
	taskID, ok := params["task_id"].(string)
	if !ok || taskID == "" {
		return nil, fmt.Errorf("missing task_id parameter")
	}

	shell := ops.ownedTask(taskID, params)
	if shell == nil {
		return map[string]any{
			"task_id": taskID,
			"status":  "not_found",
			"error":   "Task not found",
		}, nil
	}

	state := getShellState(taskID)

	result := map[string]any{
		"task_id": taskID,
		"status":  state.Status,
		"output":  state.Output,
	}

	if state.Status == "completed" || state.Status == "failed" {
		result["exitCode"] = state.ExitCode
		if state.Error != "" {
			result["error"] = state.Error
		}
	}
	if state.OutputFile != "" {
		result["outputFile"] = state.OutputFile
		result["outputBytes"] = state.OutputBytes
		result["truncated"] = state.OutputTruncated
	}

	return result, nil
}

// getOutputDelta is the read-and-advance variant of getOutput used by the
// TaskOutput tool: each call returns only the output produced since the previous
// getOutputDelta call for this task (BashOutput semantics), so a model that polls
// a running task never re-ingests output it has already seen. The cumulative
// getOutput path is untouched — the Monitor live-output panel, which keeps its
// own diff cursor over the full buffer, keeps calling that.
func (ops *ShellOperations) getOutputDelta(params map[string]any) (any, error) {
	taskID, ok := params["task_id"].(string)
	if !ok || taskID == "" {
		return nil, fmt.Errorf("missing task_id parameter")
	}

	shell := ops.ownedTask(taskID, params)
	if shell == nil {
		return map[string]any{
			"task_id": taskID,
			"status":  "not_found",
			"error":   "Task not found",
		}, nil
	}

	state := getShellDelta(taskID)

	result := map[string]any{
		"task_id":     taskID,
		"status":      state.Status,
		"output":      state.Output,
		"outputIsNew": true, // output is the delta since the previous read, not the full log
	}

	if state.Status == "completed" || state.Status == "failed" {
		result["exitCode"] = state.ExitCode
		if state.Error != "" {
			result["error"] = state.Error
		}
	}
	if state.OutputFile != "" {
		result["outputFile"] = state.OutputFile
		result["outputBytes"] = state.OutputBytes
		result["truncated"] = state.OutputTruncated
	}

	return result, nil
}

// kill terminates a background shell
func (ops *ShellOperations) kill(params map[string]any) (any, error) {
	shellID, ok := params["shell_id"].(string)
	if !ok || shellID == "" {
		return nil, fmt.Errorf("missing shell_id parameter")
	}

	shell := ops.ownedTask(shellID, params)
	if shell == nil {
		return map[string]any{
			"shell_id": shellID,
			"killed":   false,
			"error":    "Shell not found",
		}, nil
	}

	result := killShell(shellID)

	if result.Status != "failed" {
		return map[string]any{
			"shell_id": shellID,
			"killed":   false,
			"error":    "Shell is not running",
		}, nil
	}

	return map[string]any{
		"shell_id": shellID,
		"killed":   true,
	}, nil
}

// listBackgroundShells returns one conversation's background shells, within the
// caller's current project. conv_id is required rather than optional: an omitted
// filter would mean "every task in the process", which is a listing of other
// conversations' commands and is never what a caller wants.
func (ops *ShellOperations) listBackgroundShells(params map[string]any) (any, error) {
	convID, ok := params["conv_id"].(string)
	if !ok || convID == "" {
		return nil, fmt.Errorf("missing conv_id parameter")
	}

	return map[string]any{"shells": ops.shellsFor(convID)}, nil
}

// shellsFor returns the registry's entries for one conversation in the caller's
// current project. The registry applies both filters; nothing here can widen them.
func (ops *ShellOperations) shellsFor(convID string) []map[string]any {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{
		kind:        regList,
		convID:      convID,
		projectRoot: ops.scope.Root(),
		resp:        resp,
	}
	return (<-resp).shells
}

// taskStatus answers one question about tasks the caller already knows the ids
// of: which of them are still running. It is deliberately not an inventory —
// there is no way to ask it what exists — so the caller must already hold the
// ids, which in practice means reading them out of a conversation transcript it
// is already displaying. That bound is structural, and worth keeping: it is why
// the board can show running tasks without any endpoint that enumerates them.
//
// It carries no output, no command and no exit code. A task the caller does not
// own reports the same "not running, not found" as one that never existed.
func (ops *ShellOperations) taskStatus(params map[string]any) (any, error) {
	convID, ok := params["conv_id"].(string)
	if !ok || convID == "" {
		return nil, fmt.Errorf("missing conv_id parameter")
	}
	raw, ok := params["task_ids"].([]any)
	if !ok {
		return nil, fmt.Errorf("missing task_ids parameter")
	}

	// One registry pass for the whole batch: a board polling a dozen tasks should
	// not cost a dozen round trips through the actor.
	statusByID := make(map[string]string)
	for _, entry := range ops.shellsFor(convID) {
		id, _ := entry["task_id"].(string)
		status, _ := entry["status"].(string)
		statusByID[id] = status
	}

	tasks := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		id, _ := item.(string)
		if id == "" {
			continue
		}
		status, found := statusByID[id]
		if !found {
			status = "not_found"
		}
		tasks = append(tasks, map[string]any{
			"task_id": id,
			"status":  status,
			"running": status == "running",
		})
	}

	return map[string]any{"tasks": tasks}, nil
}

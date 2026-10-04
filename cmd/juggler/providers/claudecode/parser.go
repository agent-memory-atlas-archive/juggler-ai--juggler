//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Stream-parser state machine for the claude CLI's stream-json output. The
// CLI is always spawned with --include-partial-messages, so stream_event
// envelopes are the sole content path; assistant envelopes are ignored.
// Wire-format types live in protocol.go.

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"
)

// transientCLIError marks a turn failure caused by the CLI's infrastructure
// (the process died without a terminal stop reason, or its stream stalled)
// rather than a definitive API result. These are safe to re-attempt: the
// turn-level retry in dispatchTurnWithRetry re-runs the dispatch when it sees
// one (and nothing has streamed yet). A clean API error — rate-limit
// exhaustion the CLI reported in-band, a 400 — is a plain error and is never
// retried.
type transientCLIError struct {
	msg string
	// processExited is true when the CLI process has terminated (the
	// "exited unexpectedly" case), so finalizeTurn may enrich the message
	// with the captured process exit status. False for a stall, where the
	// process is still up (and teardown, not the CLI, would end it).
	processExited bool
	// diag is an optional exit-status annotation ("exit status 1",
	// "signal: killed") filled in by finalizeTurn once the dead CLI is reaped.
	diag string
	// ladderExhausted marks the retryLadderCap failure: the CLI was alive and
	// retrying the whole time, so the upstream is persistently overloaded
	// rather than the process having died. Re-dispatching immediately would
	// just re-enter the same ladder, so the turn-level retry skips these —
	// they still count as stalls for the circuit breaker.
	ladderExhausted bool
}

func (e *transientCLIError) Error() string {
	if e.diag != "" {
		return e.msg + " (" + e.diag + ")"
	}
	return e.msg
}

// isTransientCLIError reports whether err (or anything it wraps) is a
// transientCLIError — CLI infrastructure failed rather than the API returning
// a definitive result. Drives the circuit-breaker's stall bookkeeping.
func isTransientCLIError(err error) bool {
	var t *transientCLIError
	return errors.As(err, &t)
}

// isRetryableCLIError reports whether a transient failure is worth
// re-dispatching immediately. Everything transient qualifies except an
// exhausted retry ladder, where the CLI already spent retryLadderCap retrying
// this exact request — a fresh dispatch would only repeat it.
func isRetryableCLIError(err error) bool {
	var t *transientCLIError
	return errors.As(err, &t) && !t.ladderExhausted
}

// isLadderExhaustedError reports whether err is the retryLadderCap failure: the
// UPSTREAM was persistently overloaded, as distinct from this CLI session being
// wedged. The two look alike from a distance and must not be treated alike —
// see the circuit-breaker bookkeeping in dispatchTurnWithRetry.
func isLadderExhaustedError(err error) bool {
	var t *transientCLIError
	return errors.As(err, &t) && t.ladderExhausted
}

// annotateExit attaches an exit-status diagnostic (e.g. "exit status 1",
// "signal: killed") to err when err is a process-exit transientCLIError.
// Returns err unchanged for any other error or an empty diag.
func annotateExit(err error, diag string) error {
	if diag == "" {
		return err
	}
	var te *transientCLIError
	if errors.As(err, &te) && te.processExited {
		te.diag = diag
	}
	return err
}

// stallNoOutputMsg is the idle-stall error text, assembled from the two markers
// the worker's transient classifier matches on (utils.StallMarker /
// StallDroppedMarker) so this provider's wording cannot drift out of that
// contract. Takes the idle window that elapsed; the stderr variant appends the
// CLI's own last words.
const stallNoOutputMsg = "claude CLI " + utils.StallMarker + ": no output for %s (" +
	utils.StallDroppedMarker + ", e.g. across system sleep)"

// retryLadderCap bounds how long a single turn may sit in the CLI's own in-band
// backoff ladder without making progress. The CLI retries an overloaded
// upstream (HTTP 529) itself, announcing each attempt as a system/api_retry
// line. Those lines are LIVENESS, not PROGRESS: they keep resetting the idle
// watchdog, so the silence watchdog alone can never end a turn whose
// upstream is persistently overloaded — the turn would run until the worker's
// 30-minute LLMTimeout backstop with the UI still claiming to receive.
//
// Generous enough to ride out a normal backoff ladder (which recovers in tens
// of seconds, and disarms the cap the moment it does), short enough to report a
// genuinely unavailable upstream while the user is still watching — and short
// enough to pre-empt the CLI's own give-up, which takes about five minutes to
// arrive as an in-band 529 the worker then retries from scratch. A package var
// so tests can shrink it.
var retryLadderCap = 2 * time.Minute

// turnResult holds the results from a single CLI invocation.
type turnResult struct {
	InputTokens      int
	OutputTokens     int
	CacheReadTokens  int
	CacheWriteTokens int
	StopReason       provider.StopReason
	SessionID        string // captured from system/init; used for --resume
	Blocks           []provider.ContentBlock

	// usageFromStream is set the first time a stream_event (message_start
	// or message_delta) reports usage for the current API call. The
	// trailing `result` / `system/result` envelopes can carry usage that
	// is cumulative across all API calls the persistent CLI process has
	// served in the session — overwriting the per-call number with that
	// would make `anchoredTokens` grow without bound across a long
	// tool-use loop (we observed 8754k after a long LLM loop, ~40× the
	// real context window). When this flag is true, we keep the
	// stream-event numbers and ignore the result-envelope ones.
	usageFromStream bool

	// Per-block accumulators for the stream-event parser; the CLI is always
	// spawned with --include-partial-messages so this is the sole content
	// path. Lazily initialised on the first stream_event.
	partialBlocks map[int]*partialBlock

	// progress tracks running output-token estimate during the stream so
	// the UI's "Receiving..." spinner can show a live count. Owned by a
	// single goroutine for the duration of one stream.
	progress *provider.ProgressEmitter

	// Per-API-call tool tallies, reset at every message_start. A juggler turn
	// can span several API calls, and the tool_use pause decision is about the
	// call that just ended: dispatchableThisCall counts tool_use blocks emitted
	// for juggler to execute, cliServedThisCall counts blocks the CLI answers
	// itself (unparseable tool input). A pause with the first at zero and the
	// second above it parks nothing on our side — see onStopReason.
	dispatchableThisCall int
	cliServedThisCall    int

	// retryNotices counts system/api_retry lines seen this turn — the CLI
	// announcing its own in-band backoff against an overloaded upstream. The
	// read loop watches this to tell "alive but retrying" apart from "making
	// progress"; see retryLadderCap.
	retryNotices int

	// Calls to a tool name missing the mcp__juggler__ prefix, which the CLI
	// rejects on its own side. bareNameThisCall is per API call, reset at every
	// message_start like the tallies above; bareNameRounds counts the calls this
	// read loop whose every tool call was one of them, and bareNames the names
	// seen, for the error. A read loop ends at the first round that dispatches a
	// tool, so these only ever describe rounds with nothing to show for them.
	// See maxBareToolNameRounds.
	bareNameThisCall int
	bareNameRounds   int
	bareNames        []string
}

// maxBareToolNameRounds is how many consecutive rounds of bare-name tool calls a
// turn is allowed before it is abandoned as unusable output.
//
// The CLI answers a bare name with "No such tool available: <name>", which
// never mentions the prefix, and the model has to work the rest out. Usually it
// does on the very next round. When it doesn't, it tends to read the rejection
// as that tool being broken and try a different bare name instead, working down
// the tool list, and can end the turn telling the user the tools are down. A
// fresh sample of the same request is far more likely to use the names it was
// given than the one that has already failed this way, so the provider abandons
// the turn and the worker sends it again. A model that ends its turn after any
// bare round without reaching a real tool is treated the same way (see the
// end_turn arm): that answer comes from a model that couldn't investigate.
const maxBareToolNameRounds = 2

// unusableBareNameOutput is the error a turn is abandoned with once the model's
// bare-name calls have used up maxBareToolNameRounds, or it gave up after one.
func unusableBareNameOutput(result *turnResult) error {
	return &provider.UnusableOutputError{Message: fmt.Sprintf(
		"the model called tools by names this session doesn't serve (%s) and did not recover; its turn was discarded",
		strings.Join(result.bareNames, ", "))}
}

// partialBlock accumulates a single content block's incremental data as
// stream_event deltas arrive. Finalised on content_block_stop.
type partialBlock struct {
	kind      string // "text" | "thinking" | "tool_use"
	text      string // accumulated text or thinking text
	signature string // for thinking blocks
	toolID    string
	toolName  string
	toolJSON  strings.Builder // accumulated input_json_delta payload
}

// readUntilPauseOrComplete reads from the active session until we see one of:
//   - tool_use     (early return, CLI is paused inside MCP awaiting our results)
//   - end_turn     (the LLM turn finished; CLI may still be alive idling on stdin)
//   - empty_response
//   - the CLI exits (one-shot -p mode, or unexpected death)
//
// Detecting end_turn from the stream itself (rather than waiting for stdout to
// close) is what lets persistent CLI processes survive across juggler turns.
func (c *Client) readUntilPauseOrComplete(ctx context.Context, callback provider.StructuredStreamCallback) (res *turnResult, toolUses int, err error) {
	if c.activeSession == nil {
		return nil, 0, fmt.Errorf("no active session")
	}

	// Named returns exist for this: every exit from the loop below — clean
	// pause, end_turn, stall, CLI death, cancel — reports how long it read for
	// and why it stopped, so a turn that ends without a visible error still
	// leaves a trace of which arm it took.
	armedAt := time.Now()
	defer func() {
		var stop provider.StopReason
		if res != nil {
			stop = res.StopReason
		}
		jlog.Debug("claudecode read loop exited after %v (stop=%q toolUses=%d err=%v)",
			time.Since(armedAt).Round(time.Millisecond), stop, toolUses, err)
	}()

	// Capture the live-CLI stream channels up front. Every caller reaches here
	// with a live CLI; if there is none, content stays nil and the select
	// below blocks on it exactly as the old zero-value field did.
	var content chan string
	var scanErr <-chan error
	if lc := c.activeSession.live; lc != nil {
		content = lc.content
		scanErr = lc.scanErr
	}

	result := &turnResult{progress: provider.NewProgressEmitter(callback)}
	toolUseCount := 0

	// Idle watchdog: reset on every line. If it fires, the CLI has gone silent
	// without completing the turn — treat it as a dropped connection (most
	// commonly the machine slept mid-request and the TCP connection died)
	// rather than blocking until the worker's coarse LLMTimeout backstop. The
	// CLI streams incrementally under --include-partial-messages (content
	// deltas, and api_retry events during its own backoff), so a long stretch
	// of total silence is the connection, not the model thinking.
	//
	// The window is the same one every other streaming provider arms, user
	// setting included: this transport is a subprocess rather than a socket,
	// but the failure it guards against and the setting that tunes it are
	// shared. Resolved once per read loop and reused for the error text, so
	// the reported timeout is the one that actually fired.
	idleTimeout := utils.EffectiveStreamIdleTimeout()
	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()
	resetIdle := func() {
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		idle.Reset(idleTimeout)
	}

	// Retry-ladder cap: armed by the first api_retry notice of a stretch and
	// dropped by the next line carrying real progress. Starts stopped, so a
	// turn that never sees a retry notice is never subject to it.
	ladder := time.NewTimer(retryLadderCap)
	if !ladder.Stop() {
		<-ladder.C
	}
	defer ladder.Stop()
	ladderArmed := false
	armLadder := func() {
		if ladderArmed {
			return
		}
		ladder.Reset(retryLadderCap)
		ladderArmed = true
	}
	disarmLadder := func() {
		if !ladderArmed {
			return
		}
		if !ladder.Stop() {
			select {
			case <-ladder.C:
			default:
			}
		}
		ladderArmed = false
	}

	for {
		select {
		case <-ctx.Done():
			return result, toolUseCount, ctx.Err()

		case <-ladder.C:
			ladderArmed = false
			return result, toolUseCount, &transientCLIError{
				msg: fmt.Sprintf("claude CLI "+utils.StallMarker+": %s of provider retries with no progress (upstream persistently overloaded)",
					retryLadderCap),
				ladderExhausted: true,
			}

		case <-idle.C:
			stderr := ""
			if c.activeSession != nil {
				stderr = strings.TrimSpace(c.activeSession.drainStderr())
			}
			if stderr != "" {
				return result, toolUseCount, &transientCLIError{
					msg: fmt.Sprintf(stallNoOutputMsg+": %s", idleTimeout, stderr)}
			}
			return result, toolUseCount, &transientCLIError{
				msg: fmt.Sprintf(stallNoOutputMsg, idleTimeout)}

		case line, ok := <-content:
			resetIdle()
			if !ok {
				// Reader closed content (CLI exited / reader stopped). Surface scan errors.
				select {
				case err := <-scanErr:
					return result, toolUseCount, fmt.Errorf("scanner error: %w", err)
				default:
				}
				// CLI exited without emitting a terminal stop reason. This is
				// not a clean end-of-turn — it happens when the CLI dies for
				// an external reason (usage-limit / quota exhaustion, auth
				// failure, crash). Surface as an error so the worker shows it
				// in the UI instead of silently completing the turn.
				if result.StopReason == "" {
					stderr := ""
					if c.activeSession != nil {
						stderr = strings.TrimSpace(c.activeSession.drainStderr())
					}
					if stderr != "" {
						return result, toolUseCount, &transientCLIError{
							msg:           fmt.Sprintf("claude CLI exited unexpectedly: %s", stderr),
							processExited: true,
						}
					}
					return result, toolUseCount, &transientCLIError{
						msg:           "claude CLI exited unexpectedly without completing the turn (possible usage-limit / quota exhaustion — check `claude` directly)",
						processExited: true,
					}
				}
				return result, toolUseCount, nil
			}
			if line == "" {
				continue
			}

			noticesBefore := result.retryNotices
			pause, count, err := c.processStreamLineWithEarlyReturn(line, result, callback)
			if err != nil {
				return result, toolUseCount, err
			}
			toolUseCount += count

			// A retry notice re-armed the idle window above without the turn
			// having moved. Put it on the ladder clock instead; any line that
			// carries real progress takes it back off.
			if result.retryNotices > noticesBefore {
				armLadder()
			} else {
				disarmLadder()
			}

			if pause {
				result.StopReason = provider.StopReasonToolUse
				return result, toolUseCount, nil
			}

			// End-of-turn detected from the stream (persistent CLI keeps running).
			switch result.StopReason {
			case provider.StopReasonEndTurn, provider.StopReasonEmptyResponse:
				return result, toolUseCount, nil
			}
		}
	}
}

// processStreamLineWithEarlyReturn processes a line but returns early on tool_use.
// Returns (shouldPause, toolUseCount, error).
func (c *Client) processStreamLineWithEarlyReturn(line string, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	var msg StreamMessage
	if err := json.Unmarshal([]byte(line), &msg); err != nil {
		return false, 0, nil // Skip malformed lines
	}

	// Capture session id from any event that carries one — system/init is the
	// canonical source on a fresh spawn, but we also accept it from result
	// events as a safety net.
	if msg.SessionID != "" && result.SessionID == "" {
		result.SessionID = msg.SessionID
	}

	switch msg.Type {
	case "system":
		if msg.Subtype == "api_retry" {
			// CLI is retrying due to rate limit (HTTP 529) — surface to UI
			var retry struct {
				Attempt      int     `json:"attempt"`
				MaxRetries   int     `json:"max_retries"`
				RetryDelayMs float64 `json:"retry_delay_ms"`
				ErrorStatus  int     `json:"error_status"`
				Error        string  `json:"error"`
			}
			result.retryNotices++
			if json.Unmarshal([]byte(line), &retry) == nil {
				delaySec := int(retry.RetryDelayMs/1000 + 0.5)
				statusMsg := fmt.Sprintf("Rate limited (HTTP %d) — retrying (%d/%d, waiting %ds)",
					retry.ErrorStatus, retry.Attempt, retry.MaxRetries, delaySec)
				_, _ = callback(provider.StreamChunk{
					Type:    provider.ContentBlockTypeStatus,
					Content: statusMsg,
				})
			}
		} else if msg.Subtype == "result" && len(msg.Result) > 0 {
			var resultContent ResultContent
			if err := json.Unmarshal(msg.Result, &resultContent); err == nil {
				jlog.Debug("claudecode usage[system/result]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d (usageFromStream=%v)",
					resultContent.InputTokens, resultContent.CacheReadInputTokens,
					resultContent.CacheCreationInputTokens, resultContent.OutputTokens,
					resultContent.InputTokens+resultContent.CacheReadInputTokens+resultContent.CacheCreationInputTokens,
					result.usageFromStream)
				// Only trust the result-envelope usage when no stream_event
				// has reported per-call numbers; see the comment on
				// turnResult.usageFromStream.
				if !result.usageFromStream {
					result.InputTokens = resultContent.InputTokens
					result.OutputTokens = resultContent.OutputTokens
					result.CacheReadTokens = resultContent.CacheReadInputTokens
					result.CacheWriteTokens = resultContent.CacheCreationInputTokens
				}
				// The result envelope repeats the API's own stop_reason, in the
				// vocabulary provider.StopReason is modelled on; a value with
				// no constant there carries through as itself.
				result.StopReason = provider.StopReason(resultContent.StopReason)
			}
		} else if msg.Subtype == "init" {
			// The CLI has booted and loaded the session — the slow spawn/resume
			// work is over and we now wait on the model. Replace the spinner's
			// "Starting"/"Reconnecting" description with the per-turn activity
			// (a plain "Waiting for response", or "Processing conversation history"
			// on a cold start with prior history).
			waiting := c.turnWaitingDescription
			if waiting == "" {
				waiting = activityWaiting
			}
			emitActivity(callback, waiting)
		}

	case "result":
		if msg.Usage != nil {
			jlog.Debug("claudecode usage[result]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d (usageFromStream=%v)",
				msg.Usage.InputTokens, msg.Usage.CacheReadInputTokens,
				msg.Usage.CacheCreationInputTokens, msg.Usage.OutputTokens,
				msg.Usage.InputTokens+msg.Usage.CacheReadInputTokens+msg.Usage.CacheCreationInputTokens,
				result.usageFromStream)
			if !result.usageFromStream {
				// Only trust the result-envelope usage when no stream_event has
				// reported per-call numbers; see turnResult.usageFromStream.
				result.InputTokens = msg.Usage.InputTokens
				result.OutputTokens = msg.Usage.OutputTokens
				result.CacheReadTokens = msg.Usage.CacheReadInputTokens
				result.CacheWriteTokens = msg.Usage.CacheCreationInputTokens
			}
		}
		// Self-update model spec cache from the CLI's modelUsage report so
		// ListModelsWithInfo serves the model's true context window / max output
		// without us tracking Anthropic's release notes. Key by the canonical
		// alias (matching ListModelsWithInfo's base IDs and the CLI --model arg),
		// not the raw configured string, or the warm value lands under a key the
		// list never reads.
		//
		// modelUsage is keyed by FULL model id and a single turn routinely bills
		// MORE than the requested model — the CLI runs a background model (e.g.
		// haiku) for quota/summary work and reports its usage alongside. Learning
		// from every entry stamps the wrong (smaller) window onto the requested
		// alias, nondeterministically thanks to Go's randomized map iteration;
		// that is exactly what stuck fable at 200k. selectModelUsage attributes
		// the report to the model this turn actually ran as. A per-turn flip then
		// self-heals on the next turn (true window != cached => update + persist +
		// rebroadcast), so a stuck cache recovers on its own.
		alias := c.modelAlias()
		if mu, ok := selectModelUsage(msg.ModelUsage, alias); ok {
			updateCachedModelInfo(alias, mu.ContextWindow, mu.MaxOutputTokens)
		}
		switch msg.Subtype {
		case "success":
			// "success" means the CLI ran without crashing — NOT that the
			// underlying API call succeeded. The CLI signals API failures
			// via top-level is_error / api_error_status while keeping
			// subtype="success", and stuffs the error text into Result.
			// Without surfacing this, the worker would see an empty
			// end_turn and treat it as a normal (silent) completion.
			if msg.IsError {
				var errStr string
				_ = json.Unmarshal(msg.Result, &errStr)
				if errStr == "" {
					errStr = fmt.Sprintf("claude CLI API call failed (HTTP %d)", msg.APIErrorStatus)
				}
				// An authentication failure is the one thing here the user can
				// fix, and the CLI's own wording is addressed to someone sitting
				// at its command line. Type it so the worker can lead with what
				// to do while still showing this text underneath.
				if authErr := classifyClaudeAuthFailure(msg.APIErrorStatus, errStr); authErr != nil {
					markClaudeLoginExpired()
					return false, 0, authErr
				}
				return false, 0, fmt.Errorf("%s", errStr)
			}
			// A clean result proves the CLI is signed in and served a turn.
			// Unlock the passive /usage poll, and clear any earlier expiry so a
			// user who has just signed back in isn't still told they haven't.
			markClaudeLoginConfirmed()
			var resultStr string
			if json.Unmarshal(msg.Result, &resultStr) == nil && resultStr == "" {
				result.StopReason = provider.StopReasonEmptyResponse
			} else {
				result.StopReason = provider.StopReasonEndTurn
			}
		case "error":
			// CLI exhausted retries or hit a fatal error — return as a proper error
			var errStr string
			if json.Unmarshal(msg.Result, &errStr) == nil && errStr != "" {
				// Same reasoning as the "success" arm above: a CLI that has no
				// usable credential answers here with bare text and no status,
				// so the text is the only signal there is.
				if authErr := classifyClaudeAuthFailure(msg.APIErrorStatus, errStr); authErr != nil {
					markClaudeLoginExpired()
					return false, 0, authErr
				}
				return false, 0, fmt.Errorf("%s", errStr)
			}
			return false, 0, fmt.Errorf("claude CLI returned an error")
		}

	case "stream_event":
		return c.handleStreamEvent(msg.Event, result, callback)

	case "control_request":
		// CLI asking us to do something (typically: invoke an MCP tool
		// via mcp_message). Dispatch through the stdio control protocol;
		// tools/call responses are emitted later when the worker hands
		// us the result via the next StreamMessage call.
		if c.activeSession != nil && c.activeSession.live != nil && c.activeSession.live.control != nil {
			if err := c.activeSession.live.control.handleControlRequest(&msg); err != nil {
				return false, 0, fmt.Errorf("control_request: %w", err)
			}
		}

	case "control_response":
		// CLI replying to an outbound control_request we sent (today
		// only initialize). Match by request_id and unblock the parked
		// sender.
		if c.activeSession != nil && c.activeSession.live != nil && c.activeSession.live.control != nil {
			c.activeSession.live.control.handleControlResponse(&msg)
		}

	case "control_cancel_request":
		// CLI cancelling a pending outbound control_request. We don't
		// emit cancellable outbound requests today; logged for forensics
		// if it ever fires.
		jlog.Debug("CLI sent control_cancel_request for id=%s — no-op", msg.RequestID)
	}
	// Note: the CLI also emits a final `assistant` envelope after the
	// stream_event sequence with the fully-assembled message. It is ignored
	// here — the stream-event parser already finalised blocks at each
	// content_block_stop, usage at message_delta, and stop_reason at
	// message_delta — re-feeding it would only re-emit content to the UI.

	return false, 0, nil
}

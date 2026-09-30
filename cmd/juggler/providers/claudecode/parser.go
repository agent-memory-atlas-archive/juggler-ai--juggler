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
	// second above it parks nothing on our side — see the message_delta arm.
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

// handleStreamEvent dispatches Anthropic API events that the CLI passes
// through verbatim when --include-partial-messages is enabled. Per-block
// accumulators carry text/JSON across deltas; tool_use chunks are emitted
// to the callback only at content_block_stop so the callback never sees a
// partial tool input.
func (c *Client) handleStreamEvent(ev *StreamEventDetail, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	if ev == nil {
		return false, 0, nil
	}
	if result.partialBlocks == nil {
		result.partialBlocks = make(map[int]*partialBlock)
	}

	switch ev.Type {
	case "message_start":
		// The API has accepted the prompt and begun generating — the silent
		// ingestion wait (system/init → here, the long cache-miss segment on a
		// cold start) is over. Emit the mid-wait beat so the spinner flips off
		// "Waiting"/"Processing conversation history" to "Generating
		// response" the moment work starts, instead of looking stuck right up
		// until the first token. Harmless on the later message_start of a
		// multi-call turn: by then output tokens have streamed, so the frontend
		// shows the token flow alongside the latest activity description.
		emitActivity(callback, activityGenerating)

		// A juggler "turn" can contain multiple Anthropic API calls (the LLM
		// internally chains tool-use round-trips). The claudecode CLI emits
		// usage that appears to *accumulate* across those calls within one
		// turn — we observed `cache_read_input_tokens` of 223k on plain
		// Opus (200k window) and 8754k after a long loop. Resetting at
		// every message_start makes only the final API call's usage
		// survive into `turnResult`, which matches what the footer wants
		// to display (the prompt size the *next* turn will cache against).
		// Trade-off: we lose per-call totals across the chain, but better
		// no info than wildly wrong info.
		result.InputTokens = 0
		result.CacheReadTokens = 0
		result.CacheWriteTokens = 0
		// OutputTokens reset too — message_delta of the final call will
		// set the authoritative value.
		result.OutputTokens = 0
		// The tool tallies describe one API call's block batch, and this is
		// the start of a new one.
		result.dispatchableThisCall = 0
		result.cliServedThisCall = 0
		result.bareNameThisCall = 0
		if ev.Message != nil && ev.Message.Usage != nil {
			result.InputTokens = ev.Message.Usage.InputTokens
			result.OutputTokens = ev.Message.Usage.OutputTokens
			result.CacheReadTokens = ev.Message.Usage.CacheReadInputTokens
			result.CacheWriteTokens = ev.Message.Usage.CacheCreationInputTokens
			result.usageFromStream = true
			jlog.Debug("claudecode usage[message_start]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d",
				ev.Message.Usage.InputTokens, ev.Message.Usage.CacheReadInputTokens,
				ev.Message.Usage.CacheCreationInputTokens, ev.Message.Usage.OutputTokens,
				ev.Message.Usage.InputTokens+ev.Message.Usage.CacheReadInputTokens+ev.Message.Usage.CacheCreationInputTokens)
			// We deliberately do NOT emit a transient `usage` chunk here.
			// The CLI reports message_start usage cumulatively across all
			// API calls in one juggler turn — emitting it mid-stream
			// would flash a wrong number in the footer (10× too high on
			// long tool-use loops). The footer keeps showing the previous
			// turn's correct anchor until end-of-turn writes the new one.
		}

	case "content_block_start":
		if ev.ContentBlock == nil {
			return false, 0, nil
		}
		pb := &partialBlock{kind: ev.ContentBlock.Type}
		if pb.kind == "tool_use" {
			pb.toolID = ev.ContentBlock.ID
			pb.toolName = ev.ContentBlock.Name
		}
		result.partialBlocks[ev.Index] = pb

	case "content_block_delta":
		pb := result.partialBlocks[ev.Index]
		if pb == nil || ev.Delta == nil {
			return false, 0, nil
		}
		switch ev.Delta.Type {
		case "text_delta":
			pb.text += ev.Delta.Text
			if ev.Delta.Text != "" {
				result.progress.Add(ev.Delta.Text)
				if _, err := callback(provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: ev.Delta.Text,
				}); err != nil {
					return false, 0, err
				}
			}
		case "thinking_delta":
			pb.text += ev.Delta.Thinking
			if ev.Delta.Thinking != "" {
				result.progress.Add(ev.Delta.Thinking)
				if _, err := callback(provider.StreamChunk{
					Type:    provider.ContentBlockTypeThinking,
					Content: ev.Delta.Thinking,
				}); err != nil {
					return false, 0, err
				}
			}
		case "signature_delta":
			pb.signature += ev.Delta.Signature
		case "input_json_delta":
			pb.toolJSON.WriteString(ev.Delta.PartialJSON)
			result.progress.Add(ev.Delta.PartialJSON)
		}

	case "content_block_stop":
		pb := result.partialBlocks[ev.Index]
		if pb == nil {
			return false, 0, nil
		}
		delete(result.partialBlocks, ev.Index)

		switch pb.kind {
		case "text":
			result.Blocks = append(result.Blocks, provider.ContentBlock{
				Type:    provider.ContentBlockTypeText,
				Content: pb.text,
			})
		case "thinking":
			block := provider.ContentBlock{
				Type:    provider.ContentBlockTypeThinking,
				Content: pb.text,
			}
			if pb.signature != "" {
				block.Metadata = map[string]any{"signature": pb.signature}
				// The signature is complete only at the end of the block, so it
				// rides a contentless chunk the worker attaches to the thinking
				// already on screen. Without it the block reaches the next turn
				// unsigned and is dropped rather than replayed.
				if _, err := callback(provider.StreamChunk{
					Type:     provider.ContentBlockTypeThinking,
					Metadata: block.Metadata,
				}); err != nil {
					return false, 0, err
				}
			}
			result.Blocks = append(result.Blocks, block)
		case "tool_use":
			// Tool input arrives as JSON fragments via input_json_delta.
			// Parse the accumulated payload now and emit a single complete
			// tool_use chunk to the callback.
			// A tool_use whose name arrived WITHOUT the mcp__juggler__ prefix is
			// never juggler's to dispatch, whatever the name says.
			// canonicalToolName strips a prefix that was never there, so a bare
			// name juggler also serves (Monitor is both a CLI built-in and a
			// juggler tool) would dispatch as juggler's own; the CLI meanwhile
			// resolves the call on its side and never sends a tools/call, so the
			// result finds no parked call and stashes forever while the CLI blocks
			// on its next genuinely-MCP call — both sides wait until teardown.
			//
			// Skipping the block is what avoids that, and it is enough on its own:
			// nothing is dispatched, so nothing can go unclaimed. Failing the turn
			// as well would cost more than it saves — a turn error tears the
			// process down (finalizeTurn), which kills the CLI's own recovery and
			// hands the user an error where there was a working session.
			//
			// The name still says which of two things happened, so the log line
			// does too. A CLI built-in means --disallowedTools has gone stale and
			// the CLI may have acted where juggler cannot see it: an ERROR worth
			// chasing, and never grounds for re-sending the request, which could
			// run it twice. Anything else is the model using a name it was never
			// offered — imitating the bare names in its own transcript
			// (prefixJugglerToolUses covers why they are there) or in the prompt's
			// prose. The CLI rejects it with "No such tool available" and the
			// model usually re-issues it correctly on the same open process, so
			// the turn heals itself; when it doesn't, maxBareToolNameRounds ends it.
			if !strings.HasPrefix(pb.toolName, mcpToolPrefix) {
				if isCLINativeToolName(pb.toolName) {
					jlog.Error("claudecode: CLI native tool %q leaked past --disallowedTools — skipping the block rather than dispatching it as juggler's own (which deadlocks the conversation). The CLI may have served it itself, unseen by juggler. Add it to disallowedNativeTools.", pb.toolName)
				} else {
					jlog.Info("claudecode: model called %q without the %s prefix — skipping the block; the CLI rejects the bare name itself and drives the model's retry", pb.toolName, mcpToolPrefix)
					result.bareNameThisCall++
					result.bareNames = append(result.bareNames, pb.toolName)
				}
				result.cliServedThisCall++
				_, _ = callback(provider.StreamChunk{
					Type:    provider.ContentBlockTypeStatus,
					Content: fmt.Sprintf("Tool name %s isn't callable — retrying", pb.toolName),
				})
				return false, 0, nil
			}
			toolName := canonicalToolName(pb.toolName)
			input := map[string]any{}
			if raw := pb.toolJSON.String(); raw != "" {
				if err := json.Unmarshal([]byte(raw), &input); err != nil {
					// A non-empty payload that won't parse is a block the model
					// mis-sampled: observed as a doubled comma (`"offset": 340, ,
					// "limit": 70`) and as JSON that simply stops mid-object. The CLI
					// validates tool input too, and answers such a block ITSELF —
					// recording it as `__unparsedToolInput`, synthesising an
					// InputValidationError tool_result, and feeding that back so the
					// model retries the call through the same open process. So:
					//
					// DO NOT dispatch it. Falling through to empty args makes the
					// worker execute a phantom call (e.g. read with no file_path) and
					// feed its error into the control-protocol (name+args) FIFO, where
					// it matches no CLI park — permanently shifting every later result
					// by one and cross-delivering wrong file contents (the "tool/request
					// divergence" cascade).
					//
					// DO NOT fail the turn either. The CLI is mid-recovery; a turn
					// error tears the process down (finalizeTurn) and kills the retry
					// it was about to make. Skip the block, tally it as CLI-served so
					// the message_delta arm knows this batch parks nothing on our side,
					// and keep reading.
					jlog.Error("claudecode: malformed tool input JSON for %s — skipping the block; the CLI answers it with an InputValidationError and drives the model's retry: %v (raw=%s)", toolName, err, raw)
					result.cliServedThisCall++
					_, _ = callback(provider.StreamChunk{
						Type:    provider.ContentBlockTypeStatus,
						Content: fmt.Sprintf("Invalid tool input for %s — retrying", toolName),
					})
					return false, 0, nil
				}
			}
			chunk := provider.StreamChunk{
				Type:      provider.ContentBlockTypeToolUse,
				ToolUseID: pb.toolID,
				ToolName:  toolName,
				ToolInput: input,
			}
			if _, err := callback(chunk); err != nil {
				return false, 0, err
			}
			result.Blocks = append(result.Blocks, provider.ContentBlock(chunk))
			result.dispatchableThisCall++
		}

	case "message_delta":
		// Usage first, stop reason second. Anthropic puts both on this one event,
		// and the tool_use arm below leaves the read loop the moment it sees the
		// stop reason — so a usage read placed after it is never reached on a
		// pausing call, and every count that call was billed for is lost. An
		// agentic turn pauses at every tool batch and reaches end_turn once, so
		// that is nearly all of them.
		if ev.Usage != nil {
			result.InputTokens = ev.Usage.InputTokens
			result.OutputTokens = ev.Usage.OutputTokens
			result.CacheReadTokens = ev.Usage.CacheReadInputTokens
			result.CacheWriteTokens = ev.Usage.CacheCreationInputTokens
			result.usageFromStream = true
			jlog.Debug("claudecode usage[message_delta]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d",
				ev.Usage.InputTokens, ev.Usage.CacheReadInputTokens,
				ev.Usage.CacheCreationInputTokens, ev.Usage.OutputTokens,
				ev.Usage.InputTokens+ev.Usage.CacheReadInputTokens+ev.Usage.CacheCreationInputTokens)
			// Emit a transient `usage` chunk so the UI footer can flip to
			// a real input-token anchor as soon as this API call finishes
			// (rather than waiting for the worker's end-of-turn write).
			// We use message_delta — NOT message_start — because the CLI
			// reports message_start.usage cumulatively across API calls
			// in the session (we observed 10×–40× wrong values there).
			// message_delta.usage is per-call and authoritative; it's
			// what produces the correct end-of-turn anchor.
			uncachedInput := ev.Usage.InputTokens
			cacheRead := ev.Usage.CacheReadInputTokens
			cacheWrite := ev.Usage.CacheCreationInputTokens
			if total := uncachedInput + cacheRead + cacheWrite; total > 0 {
				if _, err := callback(provider.StreamChunk{
					Type: provider.ContentBlockTypeUsage,
					Metadata: map[string]any{
						"inputTokens":  total,
						"cachedTokens": cacheRead,
					},
				}); err != nil {
					return false, 0, err
				}
			}
		}
		if ev.Delta != nil && ev.Delta.StopReason != "" {
			// Map Anthropic stop_reason to our stop reasons. tool_use causes a
			// pause; end_turn lets readUntilPauseOrComplete exit cleanly.
			switch ev.Delta.StopReason {
			case "tool_use":
				// A batch that parked nothing on our side must not pause the turn.
				// Two shapes reach here, and the CLI recovers from both by itself
				// on the same open process:
				//
				//   - every block had unparseable input, so the CLI answered each
				//     one with an InputValidationError (cliServedThisCall > 0);
				//   - the response carried no usable tool_use block at all — the
				//     model stopped mid-block, or emitted none — so the CLI
				//     discards the message and feeds itself "The previous response
				//     failed to produce a valid tool call. Please retry the tool
				//     call now."
				//
				// Pausing on either hands the worker a round with no tools to
				// execute while the CLI streams its recovery call into s.content
				// with nobody reading it — content the next Submit would then
				// dequeue as if it were that message's reply. And a round that
				// streamed text before failing reads to the worker as a finished
				// turn (text counts as an action, no tool_use means nothing left to
				// do), so the conversation ends with no tool run, no error, and no
				// explanation. Stay in the read loop: the recovery round belongs to
				// this turn, and the turn ends at its real stop reason. A CLI that
				// recovers with nothing instead trips the idle watchdog, which ends
				// the turn with a visible stall.
				if result.dispatchableThisCall == 0 {
					if result.bareNameThisCall > 0 {
						result.bareNameRounds++
						if result.bareNameRounds >= maxBareToolNameRounds {
							jlog.Info("claudecode: %d consecutive rounds of bare tool names (%s) — abandoning the turn for the worker to re-send",
								result.bareNameRounds, strings.Join(result.bareNames, ", "))
							return false, 0, unusableBareNameOutput(result)
						}
					}
					if result.cliServedThisCall > 0 {
						jlog.Info("claudecode: tool_use pause with no dispatchable blocks (%d answered by the CLI itself) — reading on for its recovery round", result.cliServedThisCall)
					} else {
						jlog.Info("claudecode: tool_use stop carrying no tool call at all — the CLI discards the message and re-prompts itself; reading on for its recovery round")
					}
					return false, 0, nil
				}
				result.StopReason = provider.StopReasonToolUse
				// Count emitted tool_use blocks for the caller's tally.
				count := 0
				for _, b := range result.Blocks {
					if b.Type == provider.ContentBlockTypeToolUse {
						count++
					}
				}
				return true, count, nil
			case "end_turn", "stop_sequence", "max_tokens":
				// Giving up after a rejected bare name: the model is answering
				// without ever having reached a tool (see maxBareToolNameRounds).
				if result.bareNameRounds > 0 {
					jlog.Info("claudecode: turn ended after a round of bare tool names (%s) and no tool call — abandoning it for the worker to re-send",
						strings.Join(result.bareNames, ", "))
					return false, 0, unusableBareNameOutput(result)
				}
				result.StopReason = provider.StopReasonEndTurn
			default:
				result.StopReason = provider.StopReason(ev.Delta.StopReason)
			}
		}

	case "message_stop":
		// No-op; we already finalised via message_delta above.
	}

	return false, 0, nil
}

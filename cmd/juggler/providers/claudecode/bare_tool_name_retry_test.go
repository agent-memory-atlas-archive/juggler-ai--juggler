//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Coverage for the backstop on a model that keeps calling tools by bare names.
//
// The CLI serves every juggler tool as mcp__juggler__<name> and rejects anything
// else with "No such tool available". Usually the model re-issues the call with
// the prefix on its next round. Observed in the wild: a model that answered each
// rejection by trying a DIFFERENT bare name, six rounds running, then ended its
// turn telling the user the tools were broken. The session was fine; nothing
// had ever reached juggler.
//
// Tool names here are deliberately ones no plugin serves — the rule is about the
// prefix, never about which tools exist.

package claudecode

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// bareRound is one API call whose only tool call carries an unprefixed name.
func bareRound(t *testing.T, name string) []string {
	t.Helper()
	return append([]string{messageStartLine(t)}, bareToolUseLines(t, name)...)
}

// endTurnLine closes an API call with stop_reason=end_turn.
func endTurnLine(t *testing.T) string {
	t.Helper()
	return mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"},
	}})
}

func wantUnusableOutput(t *testing.T, err error) {
	t.Helper()
	var unusable *provider.UnusableOutputError
	if !errors.As(err, &unusable) {
		t.Fatalf("want *provider.UnusableOutputError so the worker re-sends the request, got %T %v", err, err)
	}
}

// TestParser_RepeatedBareToolNameRoundsAbandonTurn: a second consecutive round
// in which every tool call was rejected for a missing prefix ends the turn as
// unusable output, instead of leaving the model to walk the tool list.
func TestParser_RepeatedBareToolNameRoundsAbandonTurn(t *testing.T) {
	c := newParserClient()
	lines := bareRound(t, "alpha_tool")
	lines = append(lines, bareRound(t, "beta_tool")...)
	// Never reached: the turn is abandoned at the end of the second round.
	lines = append(lines, bareRound(t, "gamma_tool")...)

	res, _, pause, _, err := feedLines(t, c, lines)
	wantUnusableOutput(t, err)
	if pause {
		t.Error("an abandoned turn must not report a pause")
	}
	if res.bareNameRounds != maxBareToolNameRounds {
		t.Errorf("abandoned after %d rounds, want %d", res.bareNameRounds, maxBareToolNameRounds)
	}
}

// TestParser_BareToolNameThenEndTurnAbandonsTurn: a model that gives up after a
// rejection — ending its turn without ever reaching a real tool — has answered
// a question it never got to investigate. That answer is not the turn's result.
func TestParser_BareToolNameThenEndTurnAbandonsTurn(t *testing.T) {
	c := newParserClient()
	lines := bareRound(t, "alpha_tool")
	lines = append(lines, messageStartLine(t))
	lines = append(lines, proseLines(t, "Every tool call has failed with \"No such tool available\".")...)
	lines = append(lines, endTurnLine(t))

	_, _, _, _, err := feedLines(t, c, lines)
	wantUnusableOutput(t, err)
}

// TestParser_BareToolNameRecoveredIsNotAbandoned: the common case — one
// rejection, then the prefixed call — still heals inside the turn. The backstop
// must not cost it a retry.
func TestParser_BareToolNameRecoveredIsNotAbandoned(t *testing.T) {
	c := newParserClient()
	lines := bareRound(t, "alpha_tool")
	lines = append(lines, messageStartLine(t))
	lines = append(lines, streamToolUseLines(t, 0, "t-ok", mcpToolPrefix+"alpha_tool",
		map[string]any{"command": "ls"})...)
	lines = append(lines, toolUsePauseLine(t))

	_, _, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("a round that recovers with the prefixed name must not be abandoned: %v", err)
	}
	if !pause || count != 1 {
		t.Fatalf("the recovered call must pause the turn, got pause=%v count=%d", pause, count)
	}
}

// TestParser_NoBareRoundsEndTurnIsNotAbandoned: an ordinary text-only answer is
// untouched by the backstop.
func TestParser_NoBareRoundsEndTurnIsNotAbandoned(t *testing.T) {
	c := newParserClient()
	lines := []string{messageStartLine(t)}
	lines = append(lines, proseLines(t, "Here is the answer.")...)
	lines = append(lines, endTurnLine(t))

	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("a plain end_turn must not be abandoned: %v", err)
	}
	if res.StopReason != provider.StopReasonEndTurn {
		t.Errorf("StopReason = %q, want end_turn", res.StopReason)
	}
}

// TestParser_LeakedNativeToolIsNotRetried: a bare name the CLI serves itself
// may already have run there, so re-sending the request could run it twice. It
// is logged as a leak and left out of the count.
func TestParser_LeakedNativeToolIsNotRetried(t *testing.T) {
	c := newParserClient()
	lines := bareRound(t, "Monitor")
	lines = append(lines, bareRound(t, "Monitor")...)
	lines = append(lines, messageStartLine(t))
	lines = append(lines, proseLines(t, "Done.")...)
	lines = append(lines, endTurnLine(t))

	_, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("CLI-native bare names must not trigger a re-send: %v", err)
	}
}

// TestFinalizeTurn_UnusableOutputDropsSession: the CLI's own transcript now
// holds the rejected calls, which juggler's history never saw. Resuming it
// would replay them into the retry, so the anchor goes and the retry starts
// clean.
func TestFinalizeTurn_UnusableOutputDropsSession(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	const convID = "conv_bare_names" // must match ^conv_ so ScanConvDirs indexes the folder
	if err := os.MkdirAll(filepath.Join(c.stateDir, ".juggler", "bare--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}
	sess := &activeSession{sessionUUID: "uuid-bare-names"}
	cleanup := seedSession(t, c, sess)
	defer cleanup()
	c.saveSidecar(convID, sess)
	if c.loadSidecar(convID) == nil {
		t.Fatal("fixture: sidecar was not saved")
	}

	_, err := c.finalizeTurn(provider.MessageRequest{
		ConversationID: convID,
		Messages:       []provider.Message{userMsg("do a thing")},
	}, &turnResult{}, &provider.UnusableOutputError{Message: "bare names"})

	wantUnusableOutput(t, err)
	if c.activeSession != nil {
		t.Error("the session must be released")
	}
	if c.loadSidecar(convID) != nil {
		t.Error("the sidecar must be deleted so the retry does not resume the rejected calls")
	}
}

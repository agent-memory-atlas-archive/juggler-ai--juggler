package provider

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// anchorFiller returns messages whose combined estimate lands just under want,
// built by measuring rather than by hardcoding a length, so these tests keep
// their meaning when the estimator's rates change.
func anchorFiller(t *testing.T, want int64) []Message {
	t.Helper()
	const chunk = "the quick brown fox jumps over the lazy dog. "
	var messages []Message
	for {
		next := append(append([]Message{}, messages...), Message{Type: "user", Content: chunk})
		if EstimateMessageRequestTokens(MessageRequest{Messages: next}) > want {
			break
		}
		messages = next
	}
	if len(messages) == 0 {
		t.Fatalf("filler budget %d is too small for one message", want)
	}
	return messages
}

func submitForTest(t *testing.T, conversation Conversation, req MessageRequest) (*StreamResult, error) {
	t.Helper()
	return conversation.Submit(context.Background(), req, nil)
}

// The regression this whole mechanism exists for: an estimate that overcounts
// the transcript pushes a request over the ceiling while the provider's own
// measurement of the same history sits comfortably under it. Anchored, the
// history stops being guessed at and only the appended message is estimated.
func TestAdmissionAnchoredProjectionPreventsEarlyCompaction(t *testing.T) {
	const window, reserve = int64(10_000), int64(1_000)
	budget := ContextCeiling(window, 0) - reserve

	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: window, MaxOutputTokens: reserve},
	})

	history := anchorFiller(t, budget-500)
	appended := append(append([]Message{}, history...), Message{
		Type:    "user",
		Content: strings.Repeat("the quick brown fox jumps over the lazy dog. ", 40),
	})

	// Preconditions, asserted rather than assumed: the history alone fits, and
	// the appended message tips the whole-request estimate over the budget.
	if got := EstimateMessageRequestTokens(MessageRequest{Messages: history}); got > budget {
		t.Fatalf("history estimate %d already exceeds budget %d", got, budget)
	}
	if got := EstimateMessageRequestTokens(MessageRequest{Messages: appended}); got <= budget {
		t.Fatalf("appended estimate %d does not exceed budget %d, so this test proves nothing", got, budget)
	}

	// The provider bills the history far below what the estimator claims.
	stub.result = &StreamResult{InputTokens: 900}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	result, err := submitForTest(t, conversation, MessageRequest{Messages: appended})
	if err != nil {
		t.Fatalf("anchored submit advised compaction on a request the provider measures well under budget: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("second submit did not use the measured anchor")
	}
	if int64(result.AdmissionEstimateTokens) > budget {
		t.Fatalf("anchored projection %d exceeds budget %d", result.AdmissionEstimateTokens, budget)
	}
	if int64(result.AdmissionEstimateTokens) <= 900 {
		t.Fatalf("anchored projection %d did not charge the appended message", result.AdmissionEstimateTokens)
	}
}

// The measured count already contains the system prompt, tools, framing and the
// provider's own fixed overhead, so an anchored projection must not re-add any
// of it. A provider declaring a large ProviderOverheadTokens makes a
// double-charge impossible to miss.
func TestAdmissionAnchoredProjectionExcludesProviderOverhead(t *testing.T) {
	const window, reserve, overhead = int64(10_000), int64(1_000), int64(6_000)

	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens:    window,
			MaxOutputTokens:        reserve,
			ProviderOverheadTokens: overhead,
		},
	})

	history := []Message{{Type: "user", Content: "hello"}}
	stub.result = &StreamResult{InputTokens: 500}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	appended := append(append([]Message{}, history...), Message{
		Type:    "user",
		Content: strings.Repeat("the quick brown fox jumps over the lazy dog. ", 40),
	})
	result, err := submitForTest(t, conversation, MessageRequest{Messages: appended})
	if err != nil {
		t.Fatalf("anchored submit: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("second submit did not use the measured anchor")
	}
	if int64(result.AdmissionEstimateTokens) >= overhead {
		t.Fatalf("anchored projection %d re-added the %d-token provider overhead already inside the measurement", result.AdmissionEstimateTokens, overhead)
	}
}

// An advisory raised from a measurement still has to hand the recovery ladder a
// whole-request breakdown, because the ladder reduces history in estimator
// units and derives its fixed envelope from these components.
func TestAdmissionAnchoredAdvisoryCarriesWholeRequestBreakdown(t *testing.T) {
	const window, reserve = int64(10_000), int64(1_000)
	budget := ContextCeiling(window, 0) - reserve

	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: window, MaxOutputTokens: reserve},
	})

	history := []Message{{Type: "user", Content: "hello"}}
	stub.result = &StreamResult{InputTokens: int(budget)}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	appended := append(append([]Message{}, history...), Message{Type: "user", Content: "one more turn"})
	_, err := submitForTest(t, conversation, MessageRequest{Messages: appended})

	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("want compaction advisory once the measured prefix fills the budget, got %v", err)
	}
	if !advisory.MeasuredPrefix {
		t.Fatal("advisory does not report that it fired from a measurement")
	}
	full := EstimateMessageRequestTokenBreakdown(MessageRequest{Messages: appended}, 0)
	if advisory.Breakdown.Total != full.Total {
		t.Fatalf("breakdown total = %d, want the whole-request estimate %d", advisory.Breakdown.Total, full.Total)
	}
	if advisory.EstimatedInputTokens <= advisory.Breakdown.Total {
		t.Fatalf("measured projection %d should exceed the small whole-request estimate %d here; the two numbers have been conflated", advisory.EstimatedInputTokens, advisory.Breakdown.Total)
	}
}

func TestAdmissionAnchorInvalidation(t *testing.T) {
	history := []Message{
		{Type: "user", Content: "first"},
		{Type: "assistant", Content: "second"},
	}

	// tools is the envelope the "first" request carries whenever a case needs
	// one to differ FROM, rather than merely to appear.
	tools := []ToolDefinition{{Name: "bash", Description: "run a command"}, {Name: "read"}}

	for _, tc := range []struct {
		name string
		// first defaults to the bare history when zero, so only the cases that
		// need a non-empty envelope to start from have to spell one out.
		first MessageRequest
		next  MessageRequest
	}{
		{
			name: "an edited earlier message is not the measured prefix",
			next: MessageRequest{Messages: []Message{
				{Type: "user", Content: "first, edited"},
				{Type: "assistant", Content: "second"},
				{Type: "user", Content: "third"},
			}},
		},
		{
			name: "a shorter history means the transcript was rewritten",
			next: MessageRequest{Messages: []Message{{Type: "user", Content: "first"}}},
		},
		{
			name: "a changed system prompt changes what the provider bills",
			next: MessageRequest{Messages: history, SystemPrompt: "you are different now"},
		},
		{
			name: "a changed tool set changes what the provider bills",
			next: MessageRequest{
				Messages: history,
				Tools:    []ToolDefinition{{Name: "bash", Description: "run a command"}},
			},
		},
		{
			// The tool list is sent in order and billed in order, so the same set
			// in a different order is a different envelope. The builders upstream
			// are order-deterministic; this pins that the anchor does not quietly
			// assume it.
			name:  "a reordered tool set is a different envelope",
			first: MessageRequest{Messages: history, Tools: tools},
			next: MessageRequest{
				Messages: history,
				Tools:    []ToolDefinition{{Name: "read"}, {Name: "bash", Description: "run a command"}},
			},
		},
		{
			name:  "a changed tool choice changes what the provider bills",
			first: MessageRequest{Messages: history, Tools: tools},
			next: MessageRequest{
				Messages:   history,
				Tools:      tools,
				ToolChoice: &ToolChoice{Mode: ToolChoiceNone},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
			})
			first := tc.first
			if first.Messages == nil {
				first = MessageRequest{Messages: history}
			}
			stub.result = &StreamResult{InputTokens: 500}
			if _, err := submitForTest(t, conversation, first); err != nil {
				t.Fatalf("first submit: %v", err)
			}
			result, err := submitForTest(t, conversation, tc.next)
			if err != nil {
				t.Fatalf("second submit: %v", err)
			}
			if result.AdmissionAnchored {
				t.Fatal("anchor survived a change that invalidates the measurement it was taken from")
			}
		})
	}
}

// A count the provider never reported is itself a local estimate, so anchoring
// on it would pin the projection to the guesswork the anchor exists to replace.
func TestAdmissionDoesNotAnchorOnApproximateInputTokens(t *testing.T) {
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	history := []Message{{Type: "user", Content: "first"}}

	stub.result = &StreamResult{InputTokens: 500, InputTokensApproximate: true}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	appended := append(append([]Message{}, history...), Message{Type: "user", Content: "second"})
	result, err := submitForTest(t, conversation, MessageRequest{Messages: appended})
	if err != nil {
		t.Fatalf("second submit: %v", err)
	}
	if result.AdmissionAnchored {
		t.Fatal("anchored on a count the provider never reported")
	}
}

// An unusable result must not discard a good anchor: an older measured prefix
// with a larger estimated delta still beats estimating the whole history.
func TestAdmissionKeepsAnchorAcrossUnreportedTurn(t *testing.T) {
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})

	history := []Message{{Type: "user", Content: "first"}}
	stub.result = &StreamResult{InputTokens: 500}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	// A turn the provider reported no usage for.
	second := append(append([]Message{}, history...), Message{Type: "user", Content: "second"})
	stub.result = &StreamResult{}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: second}); err != nil {
		t.Fatalf("second submit: %v", err)
	}

	third := append(append([]Message{}, second...), Message{Type: "user", Content: "third"})
	stub.result = &StreamResult{InputTokens: 700}
	result, err := submitForTest(t, conversation, MessageRequest{Messages: third})
	if err != nil {
		t.Fatalf("third submit: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("a turn with no reported usage discarded the earlier measured anchor")
	}
}

// One admissionConversation serves every thread in the conversation, so a
// sub-thread turn — a different message array under a filtered tool set — must
// not displace the root's measurement. Sub-threads are routine, so a single
// shared anchor would leave the root on the estimated path for the whole of any
// conversation that used one, which is every conversation long enough to compact.
func TestAdmissionAnchorsPerThread(t *testing.T) {
	rootTools := []ToolDefinition{{Name: "bash"}, {Name: "read"}, {Name: "create_thread"}}
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})

	rootHistory := []Message{{Type: "user", Content: "do the thing"}, {Type: "assistant", Content: "working"}}
	stub.result = &StreamResult{InputTokens: 5_000}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: rootHistory, Tools: rootTools}); err != nil {
		t.Fatalf("root submit: %v", err)
	}

	// A sub-thread dispatch: its own transcript, its own tools, its own id.
	stub.result = &StreamResult{InputTokens: 800}
	child := MessageRequest{
		ThreadID: "thread-1",
		Messages: []Message{{Type: "user", Content: "investigate one narrow question"}},
		Tools:    []ToolDefinition{{Name: "read"}},
	}
	childResult, err := submitForTest(t, conversation, child)
	if err != nil {
		t.Fatalf("sub-thread submit: %v", err)
	}
	if childResult.AdmissionAnchored {
		t.Fatal("a sub-thread's first dispatch anchored to the root's measurement")
	}

	// Back to the root, one message further on.
	rootNext := append(append([]Message{}, rootHistory...), Message{Type: "user", Content: "carry on"})
	stub.result = &StreamResult{InputTokens: 5_400}
	rootResult, err := submitForTest(t, conversation, MessageRequest{Messages: rootNext, Tools: rootTools})
	if err != nil {
		t.Fatalf("second root submit: %v", err)
	}
	if !rootResult.AdmissionAnchored {
		t.Fatal("a sub-thread dispatch displaced the root thread's anchor")
	}
	if int64(rootResult.AdmissionEstimateTokens) <= 5_000 {
		t.Fatalf("root projection %d did not build on the root's own 5000-token measurement", rootResult.AdmissionEstimateTokens)
	}

	// And the sub-thread keeps its own anchor across the root turn.
	childNext := append(append([]Message{}, child.Messages...), Message{Type: "assistant", Content: "found it"})
	stub.result = &StreamResult{InputTokens: 900}
	childAgain, err := submitForTest(t, conversation, MessageRequest{
		ThreadID: child.ThreadID, Messages: childNext, Tools: child.Tools,
	})
	if err != nil {
		t.Fatalf("second sub-thread submit: %v", err)
	}
	if !childAgain.AdmissionAnchored {
		t.Fatal("a root dispatch displaced the sub-thread's anchor")
	}
}

// A bypassed request that is still a real turn carries the one measurement a
// pressured conversation most needs. The recovery ladder dispatches bypassed
// precisely when it cannot reduce any further and wants the provider to be the
// judge; if that dispatch cannot anchor, the only request such a conversation
// ever sends is the one request that cannot correct the number that made it
// pressured, and a wrong or missing anchor becomes permanent.
func TestAdmissionAnchorsGuardBypassedRealRequest(t *testing.T) {
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})

	history := []Message{{Type: "user", Content: "do the thing"}, {Type: "assistant", Content: "working"}}
	stub.result = &StreamResult{InputTokens: 5_000}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history, BypassContextGuard: true}); err != nil {
		t.Fatalf("bypassed submit: %v", err)
	}

	next := append(append([]Message{}, history...), Message{Type: "user", Content: "carry on"})
	stub.result = &StreamResult{InputTokens: 5_400}
	result, err := submitForTest(t, conversation, MessageRequest{Messages: next})
	if err != nil {
		t.Fatalf("second submit: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("a bypassed real turn left no anchor, so nothing this conversation dispatches can ever correct its projection")
	}
	if int64(result.AdmissionEstimateTokens) <= 5_000 {
		t.Fatalf("projection %d did not build on the bypassed turn's 5000-token measurement", result.AdmissionEstimateTokens)
	}
}

// Hidden compaction calls swap the system prompt and send a synthetic
// transcript of their own — and the folded-summary probe sends its under the
// PARENT thread's id. None of them is a turn in a thread's transcript, so none
// may file a measurement under a key real turns read.
func TestAdmissionDoesNotAnchorOnSyntheticRequest(t *testing.T) {
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})

	history := []Message{{Type: "user", Content: "do the thing"}, {Type: "assistant", Content: "working"}}
	stub.result = &StreamResult{InputTokens: 5_000}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	// The folded-summary probe's shape: same thread id, everything else its own.
	stub.result = &StreamResult{InputTokens: 300}
	if _, err := submitForTest(t, conversation, MessageRequest{
		SystemPrompt:        "summarize the transcript below",
		Messages:            []Message{{Type: "user", Content: "…transcript…"}},
		BypassContextGuard:  true,
		SyntheticTranscript: true,
	}); err != nil {
		t.Fatalf("hidden compaction submit: %v", err)
	}

	next := append(append([]Message{}, history...), Message{Type: "user", Content: "carry on"})
	stub.result = &StreamResult{InputTokens: 5_400}
	result, err := submitForTest(t, conversation, MessageRequest{Messages: next})
	if err != nil {
		t.Fatalf("second submit: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("a hidden compaction call displaced the thread's anchor")
	}
}

// A dispatch that failed measured nothing. Providers still report usage on the
// error path — claudecode sums whatever arrived before the failure — and when a
// session limit means no usage for THIS request ever arrives, what is left is
// the CLI's session-wide cumulative total. Anchoring on that files a number
// describing something else entirely as this thread's measured prefix.
func TestAdmissionDoesNotAnchorOnFailedDispatch(t *testing.T) {
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})

	history := []Message{{Type: "user", Content: "first"}}
	stub.result = &StreamResult{InputTokens: 500}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	// The failing turn, in the shape a provider really returns one: a populated
	// result carrying a count from somewhere else, alongside the error.
	second := append(append([]Message{}, history...), Message{Type: "user", Content: "second"})
	stub.result = &StreamResult{StopReason: StopReasonError, InputTokens: 60_000}
	stub.submitErr = errors.New("You've hit your session limit")
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: second}); err == nil {
		t.Fatal("the failing dispatch was expected to return its error")
	}

	third := append(append([]Message{}, second...), Message{Type: "user", Content: "third"})
	stub.submitErr = nil
	stub.result = &StreamResult{InputTokens: 700}
	result, err := submitForTest(t, conversation, MessageRequest{Messages: third})
	if err != nil {
		t.Fatalf("third submit: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("a failed turn discarded the earlier measured anchor")
	}
	if int64(result.AdmissionEstimateTokens) >= 60_000 {
		t.Fatalf("projection %d was anchored on the failed turn's 60000-token report", result.AdmissionEstimateTokens)
	}
}

// A count larger than the whole context window cannot be what this request
// cost: the provider accepted it, so it fit. Refusing it is a backstop and
// nothing more — it catches the impossible numbers a broken turn reports, never
// a wrong-but-plausible one — so it must never be mistaken for the reason the
// anchor is trustworthy.
func TestAdmissionDoesNotAnchorAboveContextWindow(t *testing.T) {
	const window = int64(100_000)
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: window, MaxOutputTokens: 4_000},
	})

	history := []Message{{Type: "user", Content: "first"}}
	stub.result = &StreamResult{InputTokens: 500}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	second := append(append([]Message{}, history...), Message{Type: "user", Content: "second"})
	stub.result = &StreamResult{InputTokens: int(window) * 8}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: second}); err != nil {
		t.Fatalf("second submit: %v", err)
	}

	third := append(append([]Message{}, second...), Message{Type: "user", Content: "third"})
	stub.result = &StreamResult{InputTokens: 700}
	result, err := submitForTest(t, conversation, MessageRequest{Messages: third})
	if err != nil {
		t.Fatalf("third submit advised compaction on an impossible measurement: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("an impossible measurement discarded the earlier usable anchor")
	}
	if int64(result.AdmissionEstimateTokens) >= window {
		t.Fatalf("projection %d was anchored on a measurement larger than the %d-token window", result.AdmissionEstimateTokens, window)
	}
}

// The whole ladder, end to end, in the shape that stranded real conversations:
// a wrong anchor puts every request over the ceiling, the advisory sends the
// turn down the recovery ladder, and the ladder's last move is one bypassed
// dispatch that the provider accepts and bills honestly. That dispatch is the
// only chance to replace the number that caused all of it — and the next
// request has to be projected from it, or the conversation compacts forever.
func TestAdmissionRecoversFromStaleAnchorAfterBypassedDispatch(t *testing.T) {
	const window, reserve = int64(100_000), int64(4_000)
	budget := ContextCeiling(window, 0) - reserve

	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: window, MaxOutputTokens: reserve},
	})

	// A wrong but not impossible measurement: inside the window, so nothing
	// about it is self-evidently broken, and it fills the budget on its own.
	history := []Message{{Type: "user", Content: "do the thing"}}
	stub.result = &StreamResult{InputTokens: int(budget - 100)}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: history}); err != nil {
		t.Fatalf("first submit: %v", err)
	}

	pressured := append(append([]Message{}, history...), Message{
		Type:    "user",
		Content: strings.Repeat("the quick brown fox jumps over the lazy dog. ", 40),
	})
	_, err := submitForTest(t, conversation, MessageRequest{Messages: pressured})
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("want an advisory from the stale anchor, got %v", err)
	}
	if !advisory.MeasuredPrefix {
		t.Fatal("advisory does not report that it fired from a measurement")
	}

	// The ladder's move: dispatch once with the guard bypassed and let the
	// provider judge. It accepts, and bills the request at its real size.
	stub.result = &StreamResult{InputTokens: 6_000}
	if _, err := submitForTest(t, conversation, MessageRequest{Messages: pressured, BypassContextGuard: true}); err != nil {
		t.Fatalf("bypassed dispatch: %v", err)
	}

	next := append(append([]Message{}, pressured...), Message{Type: "assistant", Content: "done"})
	stub.result = &StreamResult{InputTokens: 6_200}
	result, err := submitForTest(t, conversation, MessageRequest{Messages: next})
	if err != nil {
		t.Fatalf("the turn after the bypassed dispatch is still pressured by the stale anchor: %v", err)
	}
	if !result.AdmissionAnchored {
		t.Fatal("the bypassed dispatch left no anchor, so the next turn is back to estimating the whole history")
	}
	if int64(result.AdmissionEstimateTokens) >= budget {
		t.Fatalf("projection %d is still the stale anchor, not the provider's 6000-token count", result.AdmissionEstimateTokens)
	}
}

// The table is bounded, and the bound must not be able to evict a thread that is
// still dispatching in favour of one that has gone quiet.
func TestAdmissionAnchorTableEvictsOldestThread(t *testing.T) {
	stub, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})

	root := []Message{{Type: "user", Content: "root turn"}}
	submitThread := func(threadID string, messages []Message) *StreamResult {
		t.Helper()
		stub.result = &StreamResult{InputTokens: 400}
		result, err := submitForTest(t, conversation, MessageRequest{ThreadID: threadID, Messages: messages})
		if err != nil {
			t.Fatalf("submit %q: %v", threadID, err)
		}
		return result
	}

	submitThread("", root)
	for i := 0; i < maxAnchoredThreads; i++ {
		id := fmt.Sprintf("thread-%d", i)
		submitThread(id, []Message{{Type: "user", Content: id}})
		// Keep the root live: it is re-recorded each round, so it is never the
		// oldest entry and never the one evicted.
		submitThread("", root)
	}

	next := append(append([]Message{}, root...), Message{Type: "assistant", Content: "still here"})
	if result := submitThread("", next); !result.AdmissionAnchored {
		t.Fatalf("the root thread was evicted from a %d-entry table despite dispatching throughout", maxAnchoredThreads)
	}
}

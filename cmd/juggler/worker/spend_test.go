//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// TestSpendAccumulatesAcrossThreads is the whole point of the counter: the cost
// of a conversation is the cost of every thread in it, and a fan-out is where
// that cost actually goes. Three runs on three different threads must land in
// one conversation-wide total, not three per-thread ones.
func TestSpendAccumulatesAcrossThreads(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	for _, threadID := range []string{"", "thread-a", "thread-b"} {
		r := w.runFor(newTurnState())
		r.t.thread.itemID = threadID
		r.recordTurnSpend(&LLMResponse{InputTokens: 1000, OutputTokens: 100})
	}

	in, out := w.conversationSpend()
	if in != 3000 || out != 300 {
		t.Errorf("conversationSpend() = (%d in, %d out), want (3000, 300)", in, out)
	}

	// Durable, because the figure has to survive the reload that follows every
	// crash people want it for.
	if got := w.doc.GetMetadata(metaSpendNewInput); toInt64(got) != 3000 {
		t.Errorf("metadata %s = %v, want 3000", metaSpendNewInput, got)
	}
	if got := w.doc.GetMetadata(metaSpendOutput); toInt64(got) != 300 {
		t.Errorf("metadata %s = %v, want 300", metaSpendOutput, got)
	}
}

// TestSpendCountsOnlyNewInput is what the counter is for. A prompt is re-sent in
// full on every round-trip of an agentic turn, and a cached one is ~99% cache
// read (measured against the provider's own transcripts), so a total that counts
// whole prompts measures how many round-trips a conversation took, not what it
// spent: forty sessions of ordinary work came to 95.5M of prompt and 3.9M of new
// input. Only the new part — fresh tokens and the ones written to cache — is
// content the conversation had not already paid for.
func TestSpendCountsOnlyNewInput(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()

	// A typical warm round-trip: a 120k prompt that is almost all cache read.
	cached := 118_000
	r.recordTurnSpend(&LLMResponse{InputTokens: 120_000, CachedTokens: &cached, OutputTokens: 400})

	in, _ := w.conversationSpend()
	if in != 2000 {
		t.Errorf("conversationSpend() input = %d, want 2000 — the 118k re-read from cache is not new spend", in)
	}

	// A provider that reports no cache figure has not told us any of it was
	// cached, so the whole prompt counts. Unknown is not zero in the other
	// direction either: under-counting here would switch the ceiling off.
	r.recordTurnSpend(&LLMResponse{InputTokens: 5000, OutputTokens: 100})
	if in, _ := w.conversationSpend(); in != 7000 {
		t.Errorf("conversationSpend() input = %d, want 7000 — an unreported cache figure counts the whole prompt", in)
	}
}

// TestSpendNeverGoesNegative: a provider reporting more cache read than total
// input is incoherent, but it must not subtract from the running total — a
// ceiling that can be pushed back down is not a ceiling.
func TestSpendNeverGoesNegative(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	r := w.currentRun()

	r.recordTurnSpend(&LLMResponse{InputTokens: 1000, OutputTokens: 10})
	overreported := 9999
	r.recordTurnSpend(&LLMResponse{InputTokens: 100, CachedTokens: &overreported, OutputTokens: 10})

	if in, _ := w.conversationSpend(); in != 1000 {
		t.Errorf("conversationSpend() input = %d, want 1000 — an incoherent cache count must add nothing, not subtract", in)
	}
}

// TestSpendSeedsFromDocumentOnReload: a fresh worker on a reloaded conversation
// starts its counters at zero while the persisted doc already carries the
// spend. Without the seed the first recorded turn would publish a total far
// below what the conversation has actually cost — the reload would look like a
// refund.
func TestSpendSeedsFromDocumentOnReload(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.doc.SetMetadata(metaSpendNewInput, int64(5_000_000))
	w.doc.SetMetadata(metaSpendOutput, int64(20_000))

	w.currentRun().recordTurnSpend(&LLMResponse{InputTokens: 1000, OutputTokens: 100})

	in, out := w.conversationSpend()
	if in != 5_001_000 || out != 20_100 {
		t.Errorf("conversationSpend() after reload = (%d, %d), want (5001000, 20100)", in, out)
	}
}

// TestSpendIsConcurrencySafe: sibling threads stream at the same time on their
// own goroutines (canAdmitThread), so the read-modify-write behind the total
// runs concurrently with itself. Nothing may be lost.
func TestSpendIsConcurrencySafe(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			r := w.runFor(newTurnState())
			r.t.thread.itemID = fmt.Sprintf("thread-%d", n)
			for j := 0; j < 25; j++ {
				r.recordTurnSpend(&LLMResponse{InputTokens: 10, OutputTokens: 1})
			}
		}(i)
	}
	wg.Wait()

	in, out := w.conversationSpend()
	if in != 2000 || out != 200 {
		t.Errorf("conversationSpend() = (%d, %d), want (2000, 200) — a concurrent record was lost", in, out)
	}
}

// TestSpendIgnoresUnmeasuredTurns: a turn the provider reported nothing for
// (a failure before any usage came back) adds nothing rather than a zero row.
func TestSpendIgnoresUnmeasuredTurns(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.currentRun().recordTurnSpend(nil)
	if in, out := w.conversationSpend(); in != 0 || out != 0 {
		t.Errorf("conversationSpend() = (%d, %d) after a nil response, want (0, 0)", in, out)
	}
	if got := w.doc.GetMetadata(metaSpendNewInput); got != nil {
		t.Errorf("a nil response wrote metadata %s = %v", metaSpendNewInput, got)
	}
}

// TestSpendCeilingDefaultAndOverride pins the shipped default and the two ways
// it can be changed: an explicit limit, and 0 for "no ceiling".
func TestSpendCeilingDefaultAndOverride(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	if got := w.spendCeiling(); got != DefaultSpendCeilingTokens {
		t.Errorf("spendCeiling() with no resolver = %d, want the default %d", got, DefaultSpendCeilingTokens)
	}

	w.SetSpendLimit(func() int64 { return 1234 })
	if got := w.spendCeiling(); got != 1234 {
		t.Errorf("spendCeiling() = %d, want the configured 1234", got)
	}

	w.SetSpendLimit(func() int64 { return 0 })
	if got := w.spendCeiling(); got != 0 {
		t.Errorf("spendCeiling() = %d, want 0 (off)", got)
	}
	if w.spendCeilingReached() {
		t.Errorf("spendCeilingReached() is true with the ceiling switched off")
	}
}

// TestSpendCeilingReachedOnInputTotal: the ceiling meters cumulative INPUT
// tokens, the thing a runaway fan-out actually burns. It is reached at the
// limit, not only past it.
func TestSpendCeilingReachedOnInputTotal(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.SetSpendLimit(func() int64 { return 1000 })
	r := w.currentRun()

	r.recordTurnSpend(&LLMResponse{InputTokens: 999, OutputTokens: 5000})
	if w.spendCeilingReached() {
		t.Errorf("ceiling reached at 999 input tokens of 1000 (output must not count toward it)")
	}

	r.recordTurnSpend(&LLMResponse{InputTokens: 1, OutputTokens: 0})
	if !w.spendCeilingReached() {
		t.Errorf("ceiling not reached at exactly the limit")
	}
}

// TestCreateThreadRefusedPastSpendCeiling: past the ceiling the tool is refused
// as the depth and breadth caps are — a paired meta-tool-result, never a
// dangling tool_use — and no thread is created. The message must name the
// figure and the limit, because a refusal the model cannot explain to the user
// is a refusal the user will read as a bug.
func TestCreateThreadRefusedPastSpendCeiling(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.SetSpendLimit(func() int64 { return 1000 })
	w.currentRun().recordTurnSpend(&LLMResponse{InputTokens: 2000, OutputTokens: 10})

	root := w.doc.ensureItems()
	before := w.doc.GetItemsLengthFromArray(root)
	if err := w.currentRun().executeCreateThread("tu-spend", "create_thread",
		json.RawMessage(`{"goal":"more","prompt":"spawn another"}`)); err != nil {
		t.Fatalf("executeCreateThread returned error: %v", err)
	}
	if got := w.doc.GetItemsLengthFromArray(root); got != before+1 {
		t.Fatalf("expected exactly one item appended (the refusal), before=%d after=%d", before, got)
	}

	var refusal *ConversationItem
	for _, it := range w.doc.GetItemsFromArray(root) {
		if it.Type == ItemTypeThread {
			t.Fatalf("spend ceiling breached: a thread was created past the ceiling")
		}
		if it.Type == ItemTypeMetaToolResult && it.ToolUseID == "tu-spend" {
			item := it
			refusal = &item
		}
	}
	if refusal == nil {
		t.Fatalf("expected a meta-tool-result refusal bound to tu-spend")
	}
	if !refusal.IsError {
		t.Errorf("refusal meta-tool-result should be isError=true")
	}

	// The refusal reaches the LLM as a paired create_thread tool_use+tool_result.
	var sawToolUse, sawResult bool
	for _, m := range w.currentRun().buildMessages(nil) {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-spend" {
			sawToolUse = true
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-spend" {
			sawResult = true
		}
	}
	if !sawToolUse || !sawResult {
		t.Errorf("refusal must emit a paired tool_use+tool_result; sawToolUse=%v sawResult=%v", sawToolUse, sawResult)
	}
}

// TestSpendCeilingGovernsOnlyLeafChildren pins WHO the ceiling stops, and what
// stopping means. It governs exactly what the turn budget governs — a leaf
// worker an LLM opened, never the root thread, never a thread a person created
// or has taken over — because a ceiling that interrupts the work a human is
// sitting in front of, leaving them no way on but the settings panel, is the
// tool overruling its user. An agent nobody is watching has no such brake.
//
// How it lands — the tools kept, a late call refused — is shared with the run
// budget and pinned in TestBudgetLandingKeepsToolsAndRefusesCalls.
func TestSpendCeilingGovernsOnlyLeafChildren(t *testing.T) {
	tools := []ToolDefinition{{Name: "read"}, {Name: "grep"}}

	cases := []struct {
		name        string
		build       func(*ConversationWorker) string
		wantStopped bool
	}{
		{"a leaf child an LLM opened", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
		}, true},
		{"a thread a human is steering", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Mine", llmCreated: true, canSpawnThreads: true})
		}, false},
		{"a thread nobody's agent created", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Compaction"})
		}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			w.SetSpendLimit(func() int64 { return 1000 })
			w.currentRun().recordTurnSpend(&LLMResponse{InputTokens: 2000, OutputTokens: 10})

			r := runOnThread(w, tc.build(w))
			if got := r.spendCeilingStopsRun(); got != tc.wantStopped {
				t.Fatalf("spendCeilingStopsRun() = %v, want %v", got, tc.wantStopped)
			}

			// The landing turn keeps its tools on every thread, so the prompt
			// prefix stays cached; what differs is whether calls are refused.
			r.announceSpendCeiling()
			if got := r.filterToolsForThread(tools); len(got) != len(tools) {
				t.Errorf("tools offered = %d, want all %d", len(got), len(tools))
			}
			if got := r.landing(); got != tc.wantStopped {
				t.Errorf("landing() = %v, want %v", got, tc.wantStopped)
			}
		})
	}

	t.Run("the root thread is never stopped", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.SetSpendLimit(func() int64 { return 1000 })
		w.currentRun().recordTurnSpend(&LLMResponse{InputTokens: 2000, OutputTokens: 10})

		r := runOnThread(w, "")
		if r.spendCeilingStopsRun() {
			t.Fatal("root is the user's own thread; stopping it would halt the work they are watching")
		}
		if got := r.filterToolsForThread(tools); len(got) != len(tools) {
			t.Errorf("root tools = %d, want all %d", len(got), len(tools))
		}
	})
}

// TestSpendCeilingNoticeSaidOncePerRun: the child is told why its tools went,
// once. A notice repeated at every boundary would end up the loudest thing in
// its context and be read as a fresh instruction each time — the opposite of
// asking it to land.
func TestSpendCeilingNoticeSaidOncePerRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.SetSpendLimit(func() int64 { return 1000 })
	w.currentRun().recordTurnSpend(&LLMResponse{InputTokens: 2000, OutputTokens: 10})

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	r := runOnThread(w, threadID)

	notices := func() int {
		n := 0
		for _, it := range w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)) {
			if it.Type == ItemTypeSystemReminder && strings.Contains(it.Content, spendCeilingNoticeMarker) {
				n++
			}
		}
		return n
	}

	r.announceSpendCeiling()
	if got := notices(); got != 1 {
		t.Fatalf("notices after the first boundary = %d, want 1", got)
	}
	r.announceSpendCeiling()
	r.announceSpendCeiling()
	if got := notices(); got != 1 {
		t.Errorf("notices after three boundaries = %d, want 1", got)
	}
}

// TestSpendCeilingSaysNothingBelowIt: no notice, and no tools withheld, while
// the conversation is inside its ceiling. The quiet case is most of them.
func TestSpendCeilingSaysNothingBelowIt(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.SetSpendLimit(func() int64 { return 1_000_000 })
	w.currentRun().recordTurnSpend(&LLMResponse{InputTokens: 2000, OutputTokens: 10})

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	r := runOnThread(w, threadID)
	r.announceSpendCeiling()

	for _, it := range w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)) {
		if strings.Contains(it.Content, spendCeilingNoticeMarker) {
			t.Fatalf("a conversation inside its ceiling was told about it: %q", it.Content)
		}
	}
	if got := r.filterToolsForThread([]ToolDefinition{{Name: "read"}}); len(got) != 1 {
		t.Errorf("tools offered = %d below the ceiling, want 1", len(got))
	}
}

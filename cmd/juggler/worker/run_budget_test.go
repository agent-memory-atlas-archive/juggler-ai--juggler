//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// runOnThread points a worker's run at a thread and binds its budget to
// whatever run that thread currently has open, as a turn boundary does.
func runOnThread(w *ConversationWorker, threadItemID string) *run {
	r := w.currentRun()
	r.t.thread.itemID = threadItemID
	r.t.thread.itemsArray = w.doc.GetThreadItemsArray(threadItemID)
	r.syncRunBudget()
	return r
}

// chargeTurn charges one completed round-trip with the given prompt size and
// cache read to the run's budget.
func chargeTurn(r *run, input, cached int) {
	r.noteRunTurn(&LLMResponse{InputTokens: input, CachedTokens: &cached})
}

// spendTurns charges n cheap, warm round-trips — far too small to reach the
// token budget — so only the turn backstop can be what they exhaust.
func spendTurns(r *run, n int) {
	for i := 0; i < n; i++ {
		chargeTurn(r, 1000, 1000)
	}
}

// spendBudget charges one round-trip that uncached, costs the whole token budget.
func spendBudget(r *run) {
	r.noteRunTurn(&LLMResponse{InputTokens: int(runCostBudget)})
}

// TestRunBudgetGovernsOnlyLeafChildren pins WHO the budget applies to.
//
// It governs a leaf worker an LLM opened and nothing else: never the root
// thread, never a thread a person created or has taken over, because a budget
// on those would interrupt the human's own work — and a person can see how long
// their thread has been running and stop it themselves. An agent nobody is
// watching cannot.
func TestRunBudgetGovernsOnlyLeafChildren(t *testing.T) {
	leaf := func(w *ConversationWorker) string {
		return insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	}
	cases := []struct {
		name      string
		build     func(*ConversationWorker) string
		spend     func(*run)
		wantSpent bool
	}{
		{"a leaf child at its token budget", leaf, spendBudget, true},
		{"a leaf child at its turn backstop", leaf, func(r *run) { spendTurns(r, runTurnBackstop) }, true},
		{"a leaf child one turn short of the backstop", leaf, func(r *run) { spendTurns(r, runTurnBackstop-1) }, false},
		{"a thread a human is steering", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Mine", llmCreated: true, canSpawnThreads: true})
		}, func(r *run) { spendBudget(r); spendTurns(r, runTurnBackstop) }, false},
		{"a thread nobody's agent created", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Compaction"})
		}, func(r *run) { spendBudget(r); spendTurns(r, runTurnBackstop) }, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			r := runOnThread(w, tc.build(w))
			tc.spend(r)
			if got := r.runBudgetSpent(); got != tc.wantSpent {
				t.Fatalf("runBudgetSpent = %v, want %v", got, tc.wantSpent)
			}
		})
	}

	t.Run("the root thread is never budgeted", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		r := runOnThread(w, "")
		spendBudget(r)
		spendTurns(r, runTurnBackstop*3)
		if r.runBudgetSpent() {
			t.Fatal("root is the user's own thread; a budget there would stop the work they are watching")
		}
	})
}

// TestRunBudgetChargesTokensNotTurns replays two real shapes of run against the
// budget. The first is a code-reading child that made twelve warm calls in 48
// seconds, ~500k of prompt of which ~430k was cache read, and was stopped by a
// flat twelve-turn budget mid-investigation: it must have room to spare. The
// second is the incident shape the budget exists for — a child whose prompt
// climbs from 12k to 300k over 27 turns — which must still be stopped, and
// around the middle of its run rather than at the end.
func TestRunBudgetChargesTokensNotTurns(t *testing.T) {
	newLeaf := func(t *testing.T) (*ConversationWorker, *run) {
		w := NewConversationWorker("test-conv", "user:test")
		r := runOnThread(w, insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true}))
		return w, r
	}

	t.Run("a cheap warm run is not stopped at twelve turns", func(t *testing.T) {
		w, r := newLeaf(t)
		defer w.doc.Destroy()
		turns := [][2]int{
			{21965, 0}, {23645, 21963}, {26971, 23643}, {28633, 26969}, {32540, 28631}, {41665, 32538},
			{42919, 41663}, {44299, 42917}, {51773, 44297}, {52437, 51771}, {62849, 52435}, {72697, 62847},
		}
		for _, tu := range turns {
			chargeTurn(r, tu[0], tu[1])
		}
		if r.runBudgetSpent() {
			t.Fatalf("budget spent after the replayed run (cost %d of %d): a warm, mostly-cached run must have room to go on",
				r.t.runBudget.cost, runCostBudget)
		}
		if r.t.runBudget.cost*2 > runCostBudget {
			t.Errorf("replayed run cost %d, over half the %d budget — it should sit well inside it",
				r.t.runBudget.cost, runCostBudget)
		}
	})

	t.Run("an incident-shaped child is stopped mid-run", func(t *testing.T) {
		w, r := newLeaf(t)
		defer w.doc.Destroy()
		const total = 27
		prompt := func(i int) int { return 12_000 + (300_000-12_000)*i/(total-1) }
		stoppedAt := 0
		for i := 0; i < total; i++ {
			cached := 0
			if i > 0 {
				cached = prompt(i - 1)
			}
			chargeTurn(r, prompt(i), cached)
			if r.runBudgetSpent() {
				stoppedAt = i + 1
				break
			}
		}
		if stoppedAt == 0 {
			t.Fatalf("a child climbing to 300k-token prompts over %d turns was never stopped", total)
		}
		if stoppedAt < 12 || stoppedAt > 22 {
			t.Errorf("stopped at turn %d of %d, want around the middle (12-22)", stoppedAt, total)
		}
	})

	t.Run("a provider that reports no cache figure is charged the whole prompt", func(t *testing.T) {
		w, r := newLeaf(t)
		defer w.doc.Destroy()
		r.noteRunTurn(&LLMResponse{InputTokens: 50_000})
		if got := r.t.runBudget.cost; got != 50_000 {
			t.Errorf("cost = %d, want 50000 — an unreported cache figure must not read as a free turn", got)
		}
	})
}

// TestRunBudgetIsPerRunNotPerThread pins the reset. A session is called again
// and again — the whole point of a resumable child — so a counter that only ever
// climbed would spend the budget on call one and hand every later call a child
// that could not use a tool. The budget is a bound on ONE run's length.
func TestRunBudgetIsPerRunNotPerThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	r := runOnThread(w, threadID)
	invocation := func(id, text string) {
		r.appendTargetMessage(ConversationItem{
			Type: ItemTypeUser, ItemID: id, Content: text,
			RunToolUseID: "tu-" + id, RunToolName: "Explore",
		})
	}

	// Call one spends the whole budget and settles.
	invocation("inv-1", "find it")
	r.syncRunBudget()
	spendBudget(r)
	if !r.runBudgetSpent() {
		t.Fatal("the budget should be spent after its last turn")
	}
	r.appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Here is what I found.",
	})
	w.settleThreadRun(threadID, false)

	// Call two appends its own invocation message, which is a different run —
	// and so a whole budget, without anything having to remember to clear one.
	invocation("inv-2", "now check the tests")
	r.syncRunBudget()

	if b := r.t.runBudget; b.turns != 0 || b.cost != 0 {
		t.Errorf("budget at the start of the next call = %d turns, %d cost; want 0, 0 — each call into a session gets a whole budget",
			b.turns, b.cost)
	}
	if r.runBudgetSpent() {
		t.Error("a resumed child must be able to run again with tools")
	}
	if got := r.filterToolsForThread([]ToolDefinition{{Name: "read"}}); len(got) != 1 {
		t.Errorf("tools offered on the new run = %d, want 1", len(got))
	}
}

// countReminders counts the system reminders in a thread carrying marker.
func countReminders(w *ConversationWorker, threadID, marker string) int {
	n := 0
	for _, it := range threadItems(w, threadID) {
		if it.Type == ItemTypeSystemReminder && strings.Contains(it.Content, marker) {
			n++
		}
	}
	return n
}

// TestRunBudgetLandsOnceWithANotice pins the soft landing: being told is what
// turns a hard stop into a report. It is said exactly once, at the turn the
// budget runs out, because a notice repeated every turn afterwards would be the
// loudest thing in the child's context.
func TestRunBudgetLandsOnceWithANotice(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	r := runOnThread(w, threadID)

	// Short of the budget there is nothing to say.
	spendTurns(r, runTurnBackstop-1)
	r.announceRunBudgetSpent()
	if got := countReminders(w, threadID, runBudgetNoticeMarker); got != 0 {
		t.Fatalf("notices = %d below the budget, want 0", got)
	}

	// At the budget it is said once, however many times the turn boundary is
	// re-entered — the reducer re-dispatches a parked run, and each re-entry
	// passes this point.
	spendTurns(r, 1)
	r.announceRunBudgetSpent()
	r.announceRunBudgetSpent()
	if got := countReminders(w, threadID, runBudgetNoticeMarker); got != 1 {
		t.Fatalf("notices = %d at the budget, want exactly 1", got)
	}

	// And it is not repeated by the turns that follow it.
	spendTurns(r, 1)
	r.announceRunBudgetSpent()
	if got := countReminders(w, threadID, runBudgetNoticeMarker); got != 1 {
		t.Errorf("notices = %d after a further turn, want the single one", got)
	}

	// A system reminder, never a user message: a user item here would be taken
	// for the message that started the run and stamped with its outcome.
	for _, it := range threadItems(w, threadID) {
		if strings.Contains(it.Content, runBudgetNoticeMarker) && it.Type != ItemTypeSystemReminder {
			t.Errorf("the notice is a %s item; it must be a system reminder", it.Type)
		}
	}
}

// TestRunBudgetWarnsOnceBeforeItLands pins the early warning: a child told only
// at the moment its budget is gone has to stop mid-step, whereas one told a
// little earlier can finish the step it is on and write its report from a
// coherent place. Said once, and it takes nothing away.
func TestRunBudgetWarnsOnceBeforeItLands(t *testing.T) {
	for _, tc := range []struct {
		name  string
		below func(*run)
		reach func(*run)
	}{
		{"by tokens", func(r *run) {
			r.noteRunTurn(&LLMResponse{InputTokens: int(runCostBudget*3/4) - 1})
		}, func(r *run) {
			r.noteRunTurn(&LLMResponse{InputTokens: 1})
		}},
		{"by turns", func(r *run) {
			spendTurns(r, runTurnWarning-1)
		}, func(r *run) {
			spendTurns(r, 1)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
			r := runOnThread(w, threadID)

			tc.below(r)
			r.announceRunBudgetSpent()
			if got := countReminders(w, threadID, runBudgetWarningMarker); got != 0 {
				t.Fatalf("warnings = %d below the threshold, want 0", got)
			}

			tc.reach(r)
			r.announceRunBudgetSpent()
			r.announceRunBudgetSpent()
			if got := countReminders(w, threadID, runBudgetWarningMarker); got != 1 {
				t.Fatalf("warnings = %d at the threshold, want exactly 1", got)
			}
			if got := countReminders(w, threadID, runBudgetNoticeMarker); got != 0 {
				t.Errorf("the warning must not be the landing notice; notices = %d", got)
			}
			if got := r.filterToolsForThread([]ToolDefinition{{Name: "read"}}); len(got) != 1 {
				t.Errorf("tools offered after the warning = %d, want 1 — a warning takes nothing away", len(got))
			}
		})
	}
}

// TestBudgetLandingKeepsToolsAndRefusesCalls pins HOW both run-ending limits
// land. Taking the tools out of the request changes the prompt prefix every
// provider caches on, so the landing turn was a full cache rewrite of the
// child's whole transcript — as many new tokens as the rest of a cheap run put
// together. The tools therefore stay in the request, unchanged, and a call made
// after the notice is refused with an error result telling the child to report.
// Only a child that ignores that once has the tools withheld, so the landing
// still cannot turn into a loop.
func TestBudgetLandingKeepsToolsAndRefusesCalls(t *testing.T) {
	tools := []ToolDefinition{{Name: "read"}, {Name: "grep"}}
	for _, tc := range []struct {
		name string
		land func(*ConversationWorker, *run)
	}{
		{"run budget", func(_ *ConversationWorker, r *run) {
			spendBudget(r)
			r.announceRunBudgetSpent()
		}},
		{"spend ceiling", func(w *ConversationWorker, r *run) {
			w.SetSpendLimit(func() int64 { return 1000 })
			r.recordTurnSpend(&LLMResponse{InputTokens: 2000, OutputTokens: 10})
			r.announceSpendCeiling()
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
			r := runOnThread(w, threadID)
			tc.land(w, r)

			// The landing turn's request carries the same tools as every turn
			// before it, so its prefix is still in the provider's cache.
			got := r.filterToolsForThread(tools)
			if len(got) != len(tools) {
				t.Fatalf("tools offered on the landing turn = %d, want all %d — withholding them breaks the prompt cache",
					len(got), len(tools))
			}
			r.t.offeredTools = collectOfferedToolNames(got)

			// A call made anyway is refused, not run.
			cont, err := r.processLLMResponse(&LLMResponse{Blocks: []LLMResponseBlock{{
				Type: provider.ContentBlockTypeToolUse, ID: "tu-late", Name: "read",
				Input: json.RawMessage(`{"file_path":"x"}`),
			}}})
			if err != nil || !cont {
				t.Fatalf("processLLMResponse = (%v, %v), want (true, nil): the child must get a turn to report", cont, err)
			}
			refused := false
			for _, it := range threadItems(w, threadID) {
				if it.ToolUseID != "tu-late" {
					continue
				}
				if it.Type == ItemTypeToolAction {
					t.Fatal("a tool called after the landing notice was queued to run")
				}
				if it.Type == ItemTypeMetaToolResult && it.IsError {
					refused = true
				}
			}
			if !refused {
				t.Fatal("no error result for the late call: the child has nothing telling it the call was refused")
			}

			// Having ignored the notice once, the child gets no tools at all.
			if got := r.filterToolsForThread(tools); len(got) != 0 {
				t.Errorf("tools offered after a refused call = %d, want none — the landing must not loop", len(got))
			}
		})
	}
}

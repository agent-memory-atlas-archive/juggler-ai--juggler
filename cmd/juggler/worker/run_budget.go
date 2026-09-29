//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/cmd/juggler/providers/provider"
)

// The per-run budget.
//
// maxThreadDepth bounds how deep delegation goes, maxLiveThreads how wide, and
// maxConcurrentReadOnlyThreads how much of that width runs at once. None of them
// bounds how far a single child runs, and that is where the tokens are: a
// sub-agent's input grows with its own transcript, so turn 25 costs many times
// turn 1, and the last few turns of a long run cost more than all the early ones
// together. A fan-out of four children that each ran to exhaustion spent 13.8M
// input tokens in ten minutes, about half of it past this budget.
//
// It is charged in TOKENS, weighted the way providers bill them, because that is
// what it exists to bound. A turn count treats a warm 20k round-trip the same as
// a 300k one: a flat twelve-turn budget stopped a code-reading child that had
// spent 48 seconds and a seventh of an incident child's tokens, while still
// needing to read on. The turn count survives only as a backstop, for a run of
// many tiny round-trips that no token figure would catch.
//
// The budget governs a LEAF WORKER an LLM opened, and nothing else — never the
// root thread, never a thread a person created or has taken over. That is not a
// technicality but the point: a human watching their own thread can see it
// running long and stop it, and interrupting them to save tokens they chose to
// spend would be the tool overruling its user. An agent nobody is watching has
// no such brake, so it is given one.
//
// It is per RUN, not per thread. A session is meant to be called again — that is
// what makes a warm child cheaper than a fresh one — so each call gets a whole
// budget.

// runCostBudget is how many weighted input tokens (runTurnCost) one run of a
// leaf child may spend before it is asked to report.
//
// 400k because it lands where the twelve-turn budget it replaced was meant to:
// an incident-shaped child, its prompt climbing from 12k to 300k over 27 turns,
// is stopped around turn 19, about half of its prompt volume, while a warm
// twelve-turn code-reading run costs ~116k and has room for more than twice as
// much again. A child that opens by reading one very large file pays for it
// here, which is the point — that is the run that is expensive.
const runCostBudget int64 = 400_000

// cacheReadDivisor is how much cheaper a cache-read token is than a new one:
// providers bill cache reads at around a tenth of the input rate.
const cacheReadDivisor = 10

// runTurnBackstop is how many completed round-trips one run may take whatever
// they cost. Far above any honest sub-agent run; it exists for a loop of tiny
// round-trips that the token budget would take hundreds of turns to notice.
const runTurnBackstop = 40

// runTurnWarning is the turn at which a run nearing the backstop is warned.
const runTurnWarning = runTurnBackstop - 5

// runBudgetNoticeMarker is the phrase the budget notice is recognised by — in
// the child's transcript, by a reader, and in tests. Its own constant because
// the notice must stay identifiable as one after the wording changes.
const runBudgetNoticeMarker = "run budget is spent"

// runBudgetWarningMarker identifies the early warning the same way.
const runBudgetWarningMarker = "run budget is nearly spent"

// runBudgetNotice is what the child is told at the moment its budget runs out.
//
// The tools stay in the request (see landingRefusesTools), so being told is the
// whole mechanism for the well-behaved case: it turns a hard stop into a landing
// — the run's last turn is a deliberate report rather than a sentence cut off,
// which is the difference between the caller getting an answer and getting
// wreckage.
func runBudgetNotice() string {
	return fmt.Sprintf("This %s, so any tool you call now will be refused. "+
		"Give your report now from what you already have: answer what you can, and say plainly what you "+
		"could not finish and what you would do next.", runBudgetNoticeMarker)
}

// runBudgetWarning is what the child is told a little before its budget runs
// out, so it can finish the step it is on rather than be stopped in the middle
// of one.
func runBudgetWarning() string {
	return fmt.Sprintf("This %s. Finish the step you are on, make only the tool calls you still "+
		"need, then write your report.", runBudgetWarningMarker)
}

// runTurnCost is what one round-trip charges to the run's budget: new input at
// full weight, cache reads at a tenth. New input is newInputTokens — the same
// figure the conversation's spend ceiling counts, including its rule that a
// provider reporting no cache figure is charged the whole prompt.
func runTurnCost(response *LLMResponse) int64 {
	if response == nil {
		return 0
	}
	cost := int64(newInputTokens(response))
	if response.CachedTokens != nil {
		cached := min(*response.CachedTokens, response.InputTokens)
		if cached > 0 {
			cost += int64(cached / cacheReadDivisor)
		}
	}
	return cost
}

// runBudgetState is what one run's budget amounts to: how many turns it has
// taken and what they cost, what it has been told, and which run that is true
// of.
//
// It is turn state, carried between a run's dispatches by the same turnBoundary
// mechanism as every other "state one logical turn carries between its LLM runs"
// — not a field on the thread's Y.Map. The document is a persisted CRDT synced to
// every viewer, and a counter there wrote once per thread per turn: a sync round
// to every client for bookkeeping nobody reads, landing BETWEEN the items a turn
// produces, which split the coalesced sync the client's auto-selection reads as
// one batch. A sub-thread then auto-selected a seeded context item instead of the
// tool-action it should have shown. A count about a run in flight belongs to the
// worker running it.
//
// starter is what makes it self-correcting. It names the message that began the
// run being counted (the same item settleThreadRun stamps), so the count is
// bound to one run rather than to a thread: when the boundary carries a count
// into a turn whose run has changed, the mismatch resets it. That covers every
// way a run can end — settled, cancelled, abandoned, or ended by a path that
// never came back through here — without a single reset call site to keep in
// step with them.
type runBudgetState struct {
	starter string
	turns   int
	// cost is the run's weighted input tokens so far (runTurnCost).
	cost   int64
	warned bool
	told   bool
	// refused records that a tool call made after a landing notice was refused.
	// A child that has ignored the notice once has its tools withheld from then
	// on (landingRefusesTools), so the landing cannot become a loop.
	refused bool
	// spendTold records that this run has been told the conversation's spend
	// ceiling has landed on it (announceSpendCeiling). It rides here because it
	// is the same kind of state for the same kind of reason: said once per run,
	// reset by the same starter mismatch, and belonging to the run rather than to
	// the document. The ceiling itself is conversation-wide and lives in spend.go.
	spendTold bool
}

// currentRunStarterID returns the item id of the message that started the
// thread's current run, or "" when no run is open. Same walk settleThreadRun
// uses to decide which message to stamp — openRunMessagesLocked returns the open
// messages newest-first, so the last is the one that began the run.
func (w *ConversationWorker) currentRunStarterID(threadItemID string) string {
	if threadItemID == "" {
		return ""
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), threadItemID)
	if m == nil {
		return ""
	}
	nested, _ := m.Get("items").(*ycrdt.YArray)
	open := openRunMessagesLocked(nested)
	if len(open) == 0 {
		return ""
	}
	id, _ := open[len(open)-1].Get("itemId").(string)
	return id
}

// syncRunBudget binds the budget to the run this turn is part of, starting a
// fresh one whenever that is a different run from the one counted so far.
//
// Called once at the top of each turn, before anything reads the budget, so
// everything downstream is a plain read of turn-local state on the goroutine
// that owns it.
func (r *run) syncRunBudget() {
	starter := r.currentRunStarterID(r.t.thread.itemID)
	if r.t.runBudget.starter != starter {
		r.t.runBudget = runBudgetState{starter: starter}
	}
}

// noteRunTurn charges one completed LLM round-trip, and what it cost, to this
// run's budget.
func (r *run) noteRunTurn(response *LLMResponse) {
	if r.t.thread.itemID == "" {
		return // root keeps no budget, so it counts nothing
	}
	r.t.runBudget.turns++
	r.t.runBudget.cost = provider.SaturatingAdd(r.t.runBudget.cost, runTurnCost(response))
}

// runBudgetGoverned reports whether the budget applies to this thread at all.
//
// The two document reads each exclude a thread the budget has no business
// governing: one no LLM opened (a /compact fold, an orchestrator dispatch, a
// thread the user made), and one a human has since taken over — canSpawnThreads
// is exactly the "a person is steering this" stamp promoteThreadSpawnCapable
// writes when someone types into a thread, so a thread being driven by hand is
// never interrupted by a budget meant for unattended work.
func (r *run) runBudgetGoverned() bool {
	threadItemID := r.t.thread.itemID
	if threadItemID == "" {
		return false
	}
	if !r.doc.threadFlag(threadItemID, "llmCreated") {
		return false
	}
	return !r.doc.threadFlag(threadItemID, "canSpawnThreads")
}

// runBudgetSpent reports whether this run has used its budget: its tokens, or
// failing that its turn backstop.
func (r *run) runBudgetSpent() bool {
	b := r.t.runBudget
	if b.cost < runCostBudget && b.turns < runTurnBackstop {
		return false
	}
	return r.runBudgetGoverned()
}

// runBudgetNearlySpent reports whether this run is close enough to its budget
// to be warned: three quarters of its tokens, or a few turns short of the
// backstop.
func (r *run) runBudgetNearlySpent() bool {
	b := r.t.runBudget
	if b.cost < runCostBudget*3/4 && b.turns < runTurnWarning {
		return false
	}
	return r.runBudgetGoverned()
}

// announceRunBudgetSpent appends the budget's notices to the current thread, at
// the turn boundary where they became true: the warning as the budget nears its
// end, and the landing notice when it is spent.
//
// Each is said once per run: a notice repeated every turn afterwards would end
// up the loudest thing in the child's context, and be read as a fresh
// instruction each time, which is the opposite of asking it to land. The flags
// record that rather than inferring it from the count, because a turn boundary
// is not the same thing as a turn — the reducer re-enters a parked run at the
// same count, which is how the notice went in twice before. A run that jumps
// straight past the warning threshold to spent is given only the landing notice.
func (r *run) announceRunBudgetSpent() {
	b := &r.t.runBudget
	if r.runBudgetSpent() {
		if b.told {
			return
		}
		b.told, b.warned = true, true
		r.appendRunBudgetReminder(runBudgetNotice())
		r.log.Info("[worker] thread %s spent its run budget (%d of %d weighted tokens, %d of %d turns) — asked to report",
			r.t.thread.itemID, b.cost, runCostBudget, b.turns, runTurnBackstop)
		return
	}
	if b.warned || !r.runBudgetNearlySpent() {
		return
	}
	b.warned = true
	r.appendRunBudgetReminder(runBudgetWarning())
	r.log.Info("[worker] thread %s nearing its run budget (%d of %d weighted tokens, %d of %d turns) — warned",
		r.t.thread.itemID, b.cost, runCostBudget, b.turns, runTurnBackstop)
}

func (r *run) appendRunBudgetReminder(content string) {
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeSystemReminder,
		ItemID:    generateItemID(),
		Content:   content,
		Source:    "run budget",
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// landing reports whether this turn is a delegated run's report turn: a
// run-ending limit (this run's budget, or the conversation's spend ceiling) has
// landed on it and the child has been told so, in a notice that is in this
// turn's request. Only then may a tool call be refused — a call made on the
// turn a budget ran out, before the child could know, is honoured.
func (r *run) landing() bool {
	b := r.t.runBudget
	return (b.told && r.runBudgetSpent()) || (b.spendTold && r.spendCeilingStopsRun())
}

// landingRefusesTools reports whether a landing run is to be offered no tools
// at all: it has already made a call after its notice and been refused. The
// tools otherwise stay in the request, byte-for-byte what every earlier turn
// sent — taking them out changes the prompt prefix providers cache on, which
// made the landing turn a full cache rewrite of the child's transcript, often
// the dearest round-trip of the run. Withholding is kept for the child that
// ignores being told, so the landing still ends.
func (r *run) landingRefusesTools() bool {
	return r.t.runBudget.refused && r.landing()
}

// landingRefusal is the error result a tool call made during a landing gets.
const landingRefusal = "Not run: this run has been asked to report, so no more tools will run. " +
	"Give your report now from what you already have."

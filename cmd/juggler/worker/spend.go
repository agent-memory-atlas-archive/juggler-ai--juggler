//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// What a conversation has spent, and the ceiling that stops it running away.
//
// Every round-trip's usage was logged and then forgotten: the per-turn figures
// went to the conversation log, the per-thread ones onto the thread tile as
// estimates, and nothing anywhere added them up. A conversation could therefore
// spend tens of millions of input tokens — most of it inside sub-threads nobody
// was watching — with no figure on screen saying so, and the total obtainable
// only by summing log lines afterwards.
//
// The counter is conversation-wide because that is the unit a person spends in.
// It runs on ConversationWorker, which is one per conversation (manager.go) and
// is shared by every thread's run through the embedded pointer in `run`, so a
// figure recorded on a sub-thread's goroutine lands in the same total as the
// root's. That is the whole reason it lives here rather than on turnState.
//
// Both figures are what the PROVIDER billed, never the local admission estimate:
// the estimator is deliberately conservative (see approximateTokenCount) and
// runs up to ~2x hot on structured content, which is tolerable for deciding when
// to compact and not tolerable in a number a ceiling acts on.
//
// What is counted is NEW input — the prompt minus the part served from cache.
// An agentic turn re-sends its whole prompt at every tool round-trip, and a warm
// prompt is ~99% cache read, so counting whole prompts measures how long someone
// worked rather than what they spent: forty sessions of ordinary work, measured
// against the providers' own transcripts, came to 95.5M of prompt and 3.9M of
// new input. A runaway fan-out still climbs fast under this rule, because a
// fresh transcript is cache WRITE, not cache read.
const (
	// metaSpendNewInput is the conversation's cumulative NEW input tokens, every
	// thread included. Durable top-level metadata rather than part of the
	// ephemeral processingState blob, because it is a lifetime figure: it must
	// survive the reload that follows the crash people want it for.
	//
	// A key of its own rather than the older spendInputTokens, whose stored
	// values counted whole prompts: those totals are 20-30x this scale, and
	// seeding from one (addSpendFloored takes the document as a floor) would put
	// an existing conversation past any sane ceiling on its first turn.
	metaSpendNewInput = "spendNewInputTokens"

	// metaSpendOutput is the conversation's cumulative billed output tokens.
	// Kept separate rather than summed into the input figure because they are
	// not the same thing and are not priced as the same thing; a single total
	// would be a figure with no unit.
	metaSpendOutput = "spendOutputTokens"
)

// DefaultSpendCeilingTokens is the shipped ceiling: cumulative NEW input tokens
// for one conversation, past which delegated work stops.
//
// Ten million is incident territory rather than a budget, measured rather than
// guessed. Across 1,024 provider sessions of real work, new input per session
// ran to a median of 0.28M, a p95 of 0.88M and a maximum of 5.93M; a
// conversation is several sessions, so ten million leaves an ordinary one —
// however long — well clear, while a fan-out cold-starting transcript after
// transcript reaches it quickly. A ceiling that fires in normal use would be
// read as noise and switched off, which is the one outcome that helps nobody.
//
// It meters INPUT only. Output is a small fraction of the count and is bounded
// per turn by the model's own reserve; input is what a runaway's cost is made
// of.
const DefaultSpendCeilingTokens int64 = 10_000_000

// SpendLimitFunc reports the configured ceiling in cumulative input tokens, 0
// meaning no ceiling. Injected so this package stays free of the credentials
// store; a nil func means the default applies. Read live at each turn boundary,
// so a settings change takes effect on the next turn without a restart.
type SpendLimitFunc func() int64

// SetSpendLimit installs the ceiling resolver. See SpendLimitFunc.
func (w *ConversationWorker) SetSpendLimit(fn SpendLimitFunc) {
	w.spendLimit = fn
}

// toInt64 reads a number out of doc metadata, whatever numeric shape the CRDT
// round-trip left it in. Anything else — absent, or not a number — is 0.
func toInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	default:
		return 0
	}
}

// recordTurnSpend adds one completed round-trip to the conversation's running
// total. Called for every call that reaches a provider — the strategy loop's
// turns, an autonomous provider turn, and the hidden calls compaction makes —
// because a token spent out of sight is still spent.
//
// A nil response, or one carrying no counts, adds nothing: a call that failed
// before the provider reported usage has nothing to contribute, and writing a
// zero row for it would cost a sync to every viewer to say so.
func (r *run) recordTurnSpend(response *LLMResponse) {
	if response == nil {
		return
	}
	in, out := int64(newInputTokens(response)), int64(response.OutputTokens)
	if in <= 0 && out <= 0 {
		return
	}

	w := r.ConversationWorker
	totalIn := w.addSpendFloored(&w.spendInput, metaSpendNewInput, in)
	totalOut := w.addSpendFloored(&w.spendOutput, metaSpendOutput, out)

	w.doc.SetMetadata(metaSpendNewInput, totalIn)
	w.doc.SetMetadata(metaSpendOutput, totalOut)
}

// newInputTokens is the part of a round-trip's prompt the conversation had not
// already paid for: everything sent, less what the provider served from cache.
//
// A nil CachedTokens means the provider reported no cache figure, not that it
// cached nothing (see provider.StreamResult), so the whole prompt counts —
// guessing the other way would quietly switch the ceiling off for every provider
// that stays silent. Floored at zero: a provider reporting more cache read than
// prompt is incoherent, and a round-trip that subtracted from the total would
// make the ceiling something a long enough conversation could walk back from.
func newInputTokens(response *LLMResponse) int {
	in := response.InputTokens
	if response.CachedTokens == nil {
		return in
	}
	if fresh := in - *response.CachedTokens; fresh > 0 {
		return fresh
	}
	return 0
}

// addSpendFloored advances one counter by delta, first taking the persisted
// figure as a floor. Both halves matter and neither can be dropped:
//
// The floor keeps the total MONOTONIC across a worker restart on a reloaded
// conversation — a fresh worker starts at zero while the document already holds
// the whole history, and a lifetime total that went backwards on a reload would
// read as a refund. Same rule, and the same reason, as bumpTurnCounterAtIdle's
// seed.
//
// The compare-and-swap keeps it lossless while sibling threads record at once.
// A plain read-max-add-store would drop one of two concurrent turns, which is
// precisely the fan-out case this counter exists to measure.
//
// Saturating, so a total that somehow overflowed could not wrap negative and
// switch the ceiling off at the moment it was most needed.
func (w *ConversationWorker) addSpendFloored(counter *atomic.Int64, metaKey string, delta int64) int64 {
	floor := toInt64(w.doc.GetMetadata(metaKey))
	for {
		current := counter.Load()
		base := current
		if floor > base {
			base = floor
		}
		next := provider.SaturatingAdd(base, delta)
		if counter.CompareAndSwap(current, next) {
			return next
		}
	}
}

// conversationSpend returns the conversation's cumulative new input and billed
// output tokens. Reading applies the same document floor as recording, so a
// worker that has run no turn since a reload still answers with the history.
func (w *ConversationWorker) conversationSpend() (int64, int64) {
	in := w.addSpendFloored(&w.spendInput, metaSpendNewInput, 0)
	out := w.addSpendFloored(&w.spendOutput, metaSpendOutput, 0)
	return in, out
}

// spendCeiling is the configured ceiling in cumulative input tokens: 0 = off.
func (w *ConversationWorker) spendCeiling() int64 {
	if w.spendLimit == nil {
		return DefaultSpendCeilingTokens
	}
	if limit := w.spendLimit(); limit > 0 {
		return limit
	}
	return 0
}

// spendCeilingReached reports whether this conversation has spent its ceiling.
// At the ceiling counts as reached: the limit is the last acceptable figure,
// not the first unacceptable one.
//
// Asked of the conversation, not of a run, and so ungated — it is what the two
// gates that refuse to OPEN a thread are built on (executeCreateThread,
// tryDelegateTool). Those two are the ceiling's only teeth against a fan-out:
// the threads that can open threads are the root and the ones a human steers,
// which is exactly the set spendCeilingStopsRun below exempts, so a ceiling
// that governed only that function's answer could quieten children already
// running and prevent nothing.
func (w *ConversationWorker) spendCeilingReached() bool {
	ceiling := w.spendCeiling()
	if ceiling <= 0 {
		return false
	}
	in, _ := w.conversationSpend()
	return in >= ceiling
}

// spendCeilingStopsRun reports whether the ceiling lands the run in hand — asks
// it to report and refuses its further tool calls (landing) — one of the two
// things the ceiling does, and the narrower.
//
// Here it governs exactly what the run budget governs (runBudgetSpent), and for
// the same argument: a leaf worker an LLM opened, never the root thread, never a
// thread a person created or has since taken over. A human watching their own
// thread can see it running and stop it; having the work they are watching go
// quiet on them, with no way on but a settings panel they would first have to go
// and find, is the tool overruling its user. An agent nobody is watching has no
// such brake.
//
// What the root and a human-steered thread DO lose past the ceiling is the
// ability to start new unwatched work: spendCeilingReached refuses create_thread
// and any delegating tool that cannot run inline. That is the ceiling's other
// half, it is deliberate, and it is why "the ceiling never touches your own
// thread" would be too strong a thing to say anywhere.
func (r *run) spendCeilingStopsRun() bool {
	threadItemID := r.t.thread.itemID
	if threadItemID == "" {
		return false
	}
	if !r.doc.threadFlag(threadItemID, "llmCreated") {
		return false
	}
	if r.doc.threadFlag(threadItemID, "canSpawnThreads") {
		return false
	}
	return r.spendCeilingReached()
}

// spendCeilingNoticeMarker is the phrase the ceiling notice is recognised by —
// in a child's transcript, by a reader, and in tests. Its own constant so the
// notice stays identifiable as one after the wording changes.
const spendCeilingNoticeMarker = "spend ceiling"

// spendCeilingNotice is what a delegated run is told at the boundary where the
// ceiling lands on it. It asks for the report rather than announcing a stop: any
// tool call this turn makes is refused (processLLMResponse), so this turn has to
// answer, and what it answers is what the caller gets. Naming the figures
// keeps the model able to explain the ending to the person reading it.
func spendCeilingNotice(spent, ceiling int64) string {
	return fmt.Sprintf("This conversation has spent %s input tokens, past its %s %s, so any tool "+
		"you call now will be refused. Give your report now from what you already have: answer what you can, "+
		"and say plainly what you could not finish and what you would do next.",
		formatTokenCount(spent), formatTokenCount(ceiling), spendCeilingNoticeMarker)
}

// announceSpendCeiling appends the ceiling notice to the current thread, at the
// turn boundary where the ceiling landed on it.
//
// Said once per run, for the reason announceRunBudgetSpent is: a notice repeated
// every turn becomes the loudest thing in the child's context and is read as a
// fresh instruction each time, which is the opposite of asking it to land.
func (r *run) announceSpendCeiling() {
	if !r.spendCeilingStopsRun() || r.t.runBudget.spendTold {
		return
	}
	r.t.runBudget.spendTold = true
	spent, _ := r.conversationSpend()
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeSystemReminder,
		ItemID:    generateItemID(),
		Content:   spendCeilingNotice(spent, r.spendCeiling()),
		Source:    spendCeilingNoticeMarker,
		Timestamp: time.Now().Format(time.RFC3339),
	})
	r.log.Info("[worker] thread %s stopped at the conversation spend ceiling (%d of %d input tokens) — asked to report",
		r.t.thread.itemID, spent, r.spendCeiling())
}

// spendCeilingRefusal is what a caller is told when the ceiling turns a
// thread-opening call down. Same shape as the depth and breadth refusals: say
// what happened, name the figures, and say what to do instead — a refusal the
// model cannot explain is one the user reads as a bug. Naming the tool keeps it
// true of every path that opens a thread, not just create_thread.
func spendCeilingRefusal(toolName string, spent, ceiling int64) string {
	return fmt.Sprintf("%s refused: this conversation has spent %s input tokens, past its %s spend "+
		"ceiling. Do this work inline in the current thread, and if it genuinely needs more than that, "+
		"say so in your reply — raising or removing the ceiling is the user's call, in Settings → Defaults.",
		toolName, formatTokenCount(spent), formatTokenCount(ceiling))
}

// formatTokenCount renders a token count the way the UI does — 28.1M, 412k —
// because a notice quoting 28134902 asks its reader to count digits.
func formatTokenCount(n int64) string {
	switch {
	case n >= 10_000_000:
		return fmt.Sprintf("%dM", n/1_000_000)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 10_000:
		return fmt.Sprintf("%dk", n/1000)
	case n >= 1000:
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	default:
		return fmt.Sprintf("%d", n)
	}
}

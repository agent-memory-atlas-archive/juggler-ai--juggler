//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// The synchronous actor driver.
//
// A worker the test never Starts has no run() goroutine, so the test goroutine
// is its actor: it calls the handlers directly, exactly as the run loop would.
// The scheduler is the shipped one — a reducer pass is requested by posting,
// a doc-driven pickup is posted to threadDispatch, every turn runs on its own
// goroutine and hands itself back through turnRetired — so what is missing is
// only the loop that serves those three channels. quiesce is that loop, run on
// the test goroutine until there is nothing left for it to do.
//
// It serves the scheduler's own channels and nothing else. The mailbox and the
// items-change signal are left to the test, which delivers them by calling the
// handler, so a test still decides which inputs the worker sees.

// quiesceTimeout bounds how long quiesce waits for a live turn to hand itself
// back. A turn in these tests answers from a script, so anything near this is a
// turn waiting on something the test never provided.
const quiesceTimeout = 10 * time.Second

// quiesce serves the run loop's scheduler cases on the calling goroutine until,
// after a reducer drain, no scheduler event is ready and no turn is live — the
// point at which the run loop itself would block waiting for an input. Like the
// loop, it does not wait for needsReconcile to clear: a drain is bounded, and a
// refused dispatch re-arms the bit for the next event to act on.
func (w *ConversationWorker) quiesce(t testing.TB) {
	t.Helper()
	r := w.currentRun()
	deadline := time.NewTimer(quiesceTimeout)
	defer deadline.Stop()
	for {
		r.drainReconcile()
		if r.serveSchedulerEvent(nil) {
			continue
		}
		if !r.hasLiveRun() {
			return
		}
		if !r.serveSchedulerEvent(deadline.C) {
			t.Fatalf("quiesce: a turn was still live after %v: %d live run(s)", quiesceTimeout, len(r.liveRuns()))
		}
	}
}

// serveSchedulerEvent handles one ready scheduler event the way the run loop's
// matching case does, and reports whether it handled one. With a nil wait it
// does not block; otherwise it blocks until an event or wait fires.
func (r *run) serveSchedulerEvent(wait <-chan time.Time) bool {
	if wait == nil {
		select {
		case <-r.reconcileRequest:
			r.needsReconcile.Store(true)
		case t := <-r.threadDispatch:
			r.startPreparedThreadRun(t)
		case t := <-r.turnRetired:
			r.finishRetiredTurn(t)
		default:
			return false
		}
		return true
	}
	select {
	case <-r.reconcileRequest:
		r.needsReconcile.Store(true)
	case t := <-r.threadDispatch:
		r.startPreparedThreadRun(t)
	case t := <-r.turnRetired:
		r.finishRetiredTurn(t)
	case <-wait:
		return false
	}
	return true
}

// cancelLiveRuns accepts a cancel on every live turn, which is what handleCancel
// does to the run it targets. Safe from a turn's own goroutine — a provider stub
// standing in for a call the user cancelled mid-flight — because acceptCancel
// writes only the run's atomic state and its wake signal.
func cancelLiveRuns(w *ConversationWorker) {
	for _, e := range w.liveRuns() {
		w.runFor(e.t).acceptCancel()
	}
}

// ownedRun returns a turn of its own, published in the live-run registry as the
// conversation's only run, on the thread the ambient turn names and in the
// ambient turn's state. It is what a dispatched turn is when it reaches a step a
// test calls directly — compactToFit, the overflow handling — so those steps see
// the ownership they would in production. Asked again, it returns the same run.
func (w *ConversationWorker) ownedRun(t testing.TB) *run {
	t.Helper()
	threadID := w.turn.thread.itemID
	if runs := w.liveRuns(); len(runs) == 1 && runs[0].threadItemID == threadID {
		return w.runFor(runs[0].t)
	}
	if w.hasLiveRun() {
		t.Fatalf("ownedRun: %d other run(s) already live", len(w.liveRuns()))
	}
	tr := w.currentRun().beginTurn(threadID)
	tr.storeState(w.currentRun().loadState())
	t.Cleanup(func() {
		w.retireLiveRun(tr.t)
		w.releaseOSActivity()
	})
	return tr
}

// driveStrategyLoop runs one strategy loop the way the reducer's ActionCallLLM
// dispatch starts one — claim, a turn of its own in the live-run registry, its
// own goroutine — with the test's userText as the opening message, then quiesces
// the actor so every turn it led to has run and retired. The loop runs on the
// thread the ambient turn names: the root unless the test set one.
func (w *ConversationWorker) driveStrategyLoop(t testing.TB, userText string, isContinuation bool) {
	t.Helper()
	w.startStrategyLoop(t, userText, isContinuation)
	w.quiesce(t)
}

// startStrategyLoop is driveStrategyLoop without the quiesce: the turn is
// running on its goroutine when it returns, for a test that acts while it does.
func (w *ConversationWorker) startStrategyLoop(t testing.TB, userText string, isContinuation bool) {
	t.Helper()
	r := w.currentRun()
	threadID := r.t.thread.itemID
	// A test standing in for a run already under way holds the claim itself.
	if r.threadActivity(threadID) != ActivityCallingLLM && !r.claimLLM(threadID) {
		t.Fatalf("driveStrategyLoop: thread %q could not be claimed", threadID)
	}
	tr := r.beginTurn(threadID)
	if tr.t.processingStartedAt.Load() == 0 {
		tr.t.processingStartedAt.Store(time.Now().UnixMilli())
	}
	tr.storeState(StateProcessing)
	r.runTurn(tr, func(tr *run) { tr.runStrategyLoop(userText, isContinuation) })
}

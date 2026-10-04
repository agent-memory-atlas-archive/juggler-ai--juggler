//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// execReport is one accepted tool-execution-report: the engine's snapshot of the
// tool-actions it is executing for THIS conversation, at the moment it was sent.
// ids maps each executing toolUseId to the runningEpoch (generation) it is running
// under, so absence can be judged per-incarnation rather than per-id.
type execReport struct {
	receivedAt time.Time        // worker receive time — the freshness clock
	sentAtMs   int64            // engine send time (browser Date.now()) — the happens-after clock
	seq        int64            // per-engine monotonic sequence (staleness fence)
	ids        map[string]int64 // toolUseId → runningEpoch currently executing
}

// handleToolExecutionReport ingests a tool-execution-report from the engine
// (INV-B). It runs on the run goroutine, so the report store needs no lock.
//
// Accept-gate: a report is evidence only if it came from the CURRENTLY-attached
// engine client (OriginClient identity fence — a viewer or a superseded engine
// connection is rejected) and carries a seq newer than the last accepted one
// (duplicate/reorder fence). On an engine change the stored reports are dropped
// so a new engine's early report can't be compared against a dead engine's.
func (w *ConversationWorker) handleToolExecutionReport(payload json.RawMessage, originClient string) {
	var msg struct {
		Seq       int64 `json:"seq"`
		SentAt    int64 `json:"sentAt"`
		Executing []struct {
			ToolUseID    string `json:"toolUseId"`
			RunningEpoch int64  `json:"runningEpoch"`
		} `json:"executing"`
	}
	if !w.decodePayload("tool-execution-report", payload, &msg) {
		return
	}

	// Identity fence: only the current engine's reports are admissible.
	engineID := w.callbacks.engineClientID()
	if engineID == "" || originClient != engineID {
		w.tape.Record("exec-report-rejected", map[string]any{
			"reason": "origin", "from": originClient, "seq": msg.Seq,
		})
		return
	}

	// Engine (re)attach: a different engine than the stored reports came from —
	// drop the old state and reset the seq fence before applying this one.
	if originClient != w.execReportClient {
		w.execReportClient = originClient
		w.lastExecReport = nil
		w.prevExecReport = nil
		w.execReportSeq = 0
	}

	// Duplicate/reorder fence. On one ordered channel this shouldn't regress, but
	// it costs one integer compare and closes the door on a replayed frame.
	if msg.Seq <= w.execReportSeq {
		w.tape.Record("exec-report-rejected", map[string]any{
			"reason": "seq", "seq": msg.Seq, "last": w.execReportSeq,
		})
		return
	}
	w.execReportSeq = msg.Seq

	ids := make(map[string]int64, len(msg.Executing))
	for _, e := range msg.Executing {
		if e.ToolUseID != "" {
			ids[e.ToolUseID] = e.RunningEpoch
		}
	}
	w.prevExecReport = w.lastExecReport
	w.lastExecReport = &execReport{
		receivedAt: time.Now(),
		sentAtMs:   msg.SentAt,
		seq:        msg.Seq,
		ids:        ids,
	}
	w.tape.Record("exec-report", map[string]any{"seq": msg.Seq, "count": len(ids)})
}

// finalizeToolsAbsentFromExecReport is the level-based liveness rule (INV-B/C),
// run on the liveness tick. It finalizes any tool-action stuck at
// running-with-no-result that the currently-attached engine is provably NOT
// executing — as witnessed by two consecutive fresh accepted reports in which the
// tool is absent (by generation) and which postdate the tool's claim.
//
// The sole tool-liveness backstop: it finalizes via finalizeStuckRunningToolOnField,
// which guards on state==running + no-result, so a re-run (back at approved) or an
// already-terminal tool is never clobbered.
func (w *ConversationWorker) finalizeToolsAbsentFromExecReport() {
	w.finalizeToolsAbsentFromExecReportExcept(nil)
}

func (w *ConversationWorker) finalizeToolsAbsentFromExecReportExcept(liveThreads map[string]bool) {
	// Cond 1: an engine must be attached AND the last accepted report must be fresh.
	if !w.callbacks.engineAttached() || w.lastExecReport == nil {
		return
	}
	now := time.Now()
	if now.Sub(w.lastExecReport.receivedAt) > execReportFreshMs*time.Millisecond {
		return // engine went quiet — orphan recovery belongs to the reattach path
	}
	// Cond 5 (belt): require a second, also-recent accepted report. Two consecutive
	// reports converts any future regression of the ordering/contiguity assumptions
	// from "wrongly finalize a completed tool" into a no-op (the terminal write lands
	// between the two reports).
	if w.prevExecReport == nil ||
		now.Sub(w.prevExecReport.receivedAt) > 2*execReportFreshMs*time.Millisecond {
		return
	}

	type cand struct {
		id    string
		epoch int64
	}
	var cands []cand
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
		if liveThreads[threadID] {
			return false
		}
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		// The wedge shape only: still running, no result.
		if state, _ := m.Get("state").(string); state != StateRunning {
			return false
		}
		if m.Get("result") != nil {
			return false
		}
		// Cond 2: worker-executed tools never appear in an engine report — the
		// engine's executor is not their liveness oracle. Skip the executor='worker'
		// stamp (written at evaluate) and the create_thread fallback (docs predating
		// the stamp). Only create_thread is worker-managed today, so these two cover
		// every worker-executed tool; a future one would carry the stamp.
		if ex, _ := m.Get("executor").(string); ex == "worker" {
			return false
		}
		if name, _ := m.Get("toolName").(string); name == "create_thread" {
			return false
		}
		id, _ := m.Get("toolUseId").(string)
		if id == "" {
			return false
		}
		epoch, _ := docNumberToInt64(m.Get("runningEpoch"))
		started, _ := docNumberToInt64(m.Get("runningStartedAt"))
		// Cond 3+4 must hold for BOTH consecutive reports (the belt).
		if !absentFromReport(w.lastExecReport, id, epoch, started) {
			return false
		}
		if !absentFromReport(w.prevExecReport, id, epoch, started) {
			return false
		}
		cands = append(cands, cand{id: id, epoch: epoch})
		return false
	})
	ycrdtMu.Unlock()

	for _, c := range cands {
		if w.finalizeStuckRunningToolOnField(c.id, "runningEpoch", float64(c.epoch), "exec-report-absent") {
			// Settle the parked turn now that the tool reached terminal.
			w.needsReconcile.Store(true)
		}
	}
}

// absentFromReport reports whether a running execution is provably absent from an
// accepted report: its toolUseId is either not in the report's executing set, or
// present but under a DIFFERENT generation (that incarnation died; a re-claim is a
// new epoch) — AND the doc claim provably predates the report (happens-after
// guard), so a claim fresher than the report (one that simply hasn't appeared in a
// report yet) is never treated as absent.
//
// started (doc runningStartedAt) and r.sentAtMs share the browser Date.now() clock:
// the accept-gate pins both report and claim to the same engine attachment, so the
// comparison is skew-free. A missing/zero claim stamp is treated as too-fresh
// (conservative — never finalize) rather than as ancient.
func absentFromReport(r *execReport, id string, epoch, started int64) bool {
	// Happens-after: the claim must predate the report by at least the
	// claim→executor-registration grace, or it is too fresh to have been reported.
	if started == 0 || started+execReportClaimGraceMs >= r.sentAtMs {
		return false
	}
	repEpoch, present := r.ids[id]
	if !present {
		return true // not executing at all
	}
	return repEpoch != epoch // executing a different incarnation → this one is gone
}

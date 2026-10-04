//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// The four properties automatic compaction has to hold, each driven through
// real turns of the strategy loop against real admission.
//
// Everything else in this package tests a piece of compaction: how the reducer
// packs a chunk, which items a fold pins, what the tape records. Those tests all
// build the state they examine, so they cannot see the two things that actually
// went wrong in practice — a compaction that fired at a useless moment, and a
// compaction that cost the conversation its name. Both live in the seams
// between well-tested units, and both are outcomes of running a conversation
// rather than shapes of a data structure. So these tests run conversations.
//
//	I1 fits      — no request is ever dispatched over the window.
//	I2 timely    — compaction happens while a turn can still use it.
//	I3 identity  — compaction does not change who the conversation is.
//	I4 terminates— compaction always converges, however bad the input.

// compactionWorld is a worker wired to real registry admission over a small
// context window, with a scripted model on the other side. Turns are driven
// through runStrategyLoop exactly as production drives them.
type compactionWorld struct {
	t          *testing.T
	w          *ConversationWorker
	underlying *compactionAdmissionConversation
	autoNames  []string

	// visibleDispatches records the estimated input size of each visible
	// (non-compaction) request that admission actually let through, in order.
	visibleDispatches []int64
	// foldsAtDispatch[i] is how many compaction folds existed at the moment
	// dispatch i went out. Sampled at the dispatch itself, because that is the
	// only place the question "did this fold arrive in time to be used?" has a
	// sharp answer: a fold is timely exactly when some later request carries it.
	foldsAtDispatch []int
	reducerCalls    int
}

// newCompactionWorld builds the world. window/reserve are the model's limits;
// respond scripts the visible turns, receiving the 1-based turn number.
func newCompactionWorld(t *testing.T, window, reserve int64, respond func(turn int) *LLMResponse) *compactionWorld {
	t.Helper()
	underlying, conversation := openCompactionAdmissionConversation(t, window, reserve)
	world := &compactionWorld{t: t, underlying: underlying}

	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.SetAutoNamer(func(_, firstMessage, _, _, _ string, _ bool) {
		world.autoNames = append(world.autoNames, firstMessage)
	})
	w.SetCallback("engine", func([]byte) {})
	w.SetEngineClientID("engine")
	w.currentRun().storeState(StateProcessing)
	feedCompactionContextAndTools(w, ToolDefinition{Name: "bash"})
	world.w = w

	visibleTurn := 0
	w.llmCallFunc = func(ctx context.Context, raw json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		hidden := strings.Contains(req.ThreadID, ":bounded:")

		// Real admission decides. An advisory or a limit error propagates to the
		// worker exactly as it would in production, and drives the same ladder.
		if _, err := conversation.Submit(ctx, providerRequest(req), func(provider.StreamChunk) (*provider.ToolResult, error) {
			return nil, nil
		}); err != nil {
			return nil, err
		}

		if hidden {
			world.reducerCalls++
			if isCompactionFinalRequest(req) {
				return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "summary of earlier work"}}}, nil
			}
			return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "condensed fragment"}}}, nil
		}

		visibleTurn++
		world.visibleDispatches = append(world.visibleDispatches,
			provider.EstimateMessageRequestTokenBreakdown(providerRequest(req), 0).Total)
		world.foldsAtDispatch = append(world.foldsAtDispatch, world.foldCount())
		response := respond(visibleTurn)
		for _, block := range response.Blocks {
			if block.Type == provider.ContentBlockTypeText {
				sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: block.Content})
			}
		}
		return response, nil
	}
	return world
}

// runToolTurn completes one tool round-trip the way the engine does: approve
// the call, drive the execution command, write the result back, then re-enter
// the strategy loop as the reducer's dispatchCallLLMOnThread would.
func (world *compactionWorld) runToolTurn(toolUseID, result string) {
	world.t.Helper()
	if err := world.w.doc.UpdateItemByToolUseID(toolUseID, "state", StateApproved); err != nil {
		world.t.Fatal(err)
	}
	world.driveToolActions()
	if err := world.w.doc.UpdateItemByToolUseID(toolUseID, "state", StateCompleted); err != nil {
		world.t.Fatal(err)
	}
	if err := world.w.doc.UpdateItemByToolUseID(toolUseID, "result", map[string]any{"content": result, "isError": false}); err != nil {
		world.t.Fatal(err)
	}
	world.w.driveStrategyLoop(world.t, "", true)
}

func (world *compactionWorld) driveToolActions() { world.w.driveToolActions() }

func (world *compactionWorld) foldCount() int {
	folds := 0
	for _, item := range world.w.doc.GetItems() {
		if item.Type == ItemTypeThread && item.BoundedCompaction {
			folds++
		}
	}
	return folds
}

func (world *compactionWorld) errorItems() []string {
	var errs []string
	for _, item := range world.w.doc.GetItems() {
		if item.Type == ItemTypeError {
			errs = append(errs, item.Content)
		}
	}
	return errs
}

func toolUseTurn(id string) *LLMResponse {
	return &LLMResponse{
		Blocks:     []LLMResponseBlock{{Type: "tool_use", ID: id, Name: "bash", Input: json.RawMessage(`{"command":"work"}`)}},
		StopReason: "tool_use",
	}
}

func endTurn(text string) *LLMResponse {
	return &LLMResponse{
		Blocks:     []LLMResponseBlock{{Type: "text", Content: text}},
		StopReason: "end_turn",
	}
}

// repeatToTokens builds a string that admission estimates at roughly want
// tokens, by measuring rather than by a fixed repeat count. Fixtures that
// pressure the context window have to be expressed in the estimator's own units
// — a hardcoded length silently stops crossing the ceiling the moment a rate
// changes, and the test then passes vacuously instead of failing loudly.
func repeatToTokens(t *testing.T, unit string, want int64) string {
	t.Helper()
	estimate := func(s string) int64 {
		return provider.EstimateMessageRequestTokens(provider.MessageRequest{
			Messages: []provider.Message{{Type: "tool-result", Content: s}},
		})
	}
	for n := 1; n <= 1<<22; {
		text := strings.Repeat(unit, n)
		got := estimate(text)
		if got >= want {
			return text
		}
		next := int(float64(n) * float64(want) / float64(max(got, 1)))
		if next <= n {
			next = n + 1
		}
		n = next
	}
	t.Fatalf("could not reach %d tokens by repeating %q", want, unit)
	return ""
}

// I1 + I2. A long tool chain grows the transcript past the ceiling partway
// through. The chain must complete, every dispatch must fit, and — the point —
// the compaction must land DURING the chain, not after it.
//
// The settle-time trigger this replaced could only fire once the conversation
// went idle, so it folded a finished task and summarized work nobody needed
// summarized, while the turn that was actually starved of room never got any.
func TestCompactionFitsAndFiresDuringTheToolChain(t *testing.T) {
	const (
		window   int64 = 20_000
		reserve  int64 = 2_000
		toolCall       = 12
	)
	world := newCompactionWorld(t, window, reserve, func(turn int) *LLMResponse {
		if turn <= toolCall {
			return toolUseTurn(fmt.Sprintf("tu-%d", turn))
		}
		return endTurn("done")
	})

	// Each result is ~2k tokens, so the transcript crosses the ceiling around
	// turn nine and there are still calls left that a compaction can help.
	result := repeatToTokens(t, "output ", 2_000)

	world.w.driveStrategyLoop(world.t, "work through the list", false)
	for i := 1; i <= toolCall; i++ {
		world.runToolTurn(fmt.Sprintf("tu-%d", i), result)
	}

	// I1: assertFits already failed the test on any over-window dispatch. Prove
	// the fixture actually pressured the window rather than passing vacuously.
	if len(world.visibleDispatches) < toolCall {
		t.Fatalf("visible dispatches = %d, want the whole %d-call chain to have run", len(world.visibleDispatches), toolCall)
	}
	if errs := world.errorItems(); len(errs) > 0 {
		t.Fatalf("chain ended in error items: %q", errs)
	}
	var peak int64
	for _, estimate := range world.visibleDispatches {
		peak = max(peak, estimate)
	}
	if ceiling := provider.ContextCeiling(window, 0); peak <= ceiling/2 {
		t.Fatalf("peak dispatch was %d against a %d ceiling; the fixture never pressured the window", peak, ceiling)
	}

	// I2: compaction happened, and every fold was carried by a later request.
	// Equivalently: nothing was folded after the last dispatch — no summary was
	// produced for a conversation that had already stopped needing one.
	folds := world.foldCount()
	if folds == 0 {
		t.Fatal("no compaction ran across a chain that crossed the ceiling")
	}
	lastSeen := world.foldsAtDispatch[len(world.foldsAtDispatch)-1]
	if lastSeen != folds {
		t.Errorf("%d fold(s) exist but the final request carried only %d: %d landed after the last dispatch, too late to help any turn",
			folds, lastSeen, folds-lastSeen)
	}
}

// I3. A conversation's identity must not depend on how much of its history is
// currently folded. This is the bug that produced "Commit changes", "Commit
// changes 2", "Commit changes 3": compaction emptied the root items array, so
// the next message looked like a new conversation's first and retitled the tab.
func TestCompactionDoesNotChangeConversationIdentity(t *testing.T) {
	world := newCompactionWorld(t, 20_000, 2_000, func(int) *LLMResponse {
		return endTurn("acknowledged")
	})
	// Messages arrive at an idle conversation; a busy one queues them instead.
	world.w.currentRun().storeState(StateIdle)

	sendMsg(t, world.w, SendMessageMessage{Text: "the original task"})
	world.w.quiesce(t)
	if len(world.autoNames) != 1 || world.autoNames[0] != "the original task" {
		t.Fatalf("auto-name calls = %v, want exactly one from the opening message", world.autoNames)
	}

	world.w.currentRun().storeState(StateIdle)
	if _, folded, err := world.w.currentRun().foldConversationForCompaction(false); err != nil || !folded {
		t.Fatalf("foldConversationForCompaction = (%v, %v), want a fold", folded, err)
	}

	sendMsg(t, world.w, SendMessageMessage{Text: "commit this"})
	world.w.quiesce(t)

	if len(world.autoNames) != 1 {
		t.Fatalf("auto-name calls after compaction = %v, want the original one only", world.autoNames)
	}
	if first := world.w.firstRootUserMessageText(); first != "the original task" {
		t.Fatalf("first user message reads %q through the fold, want the opening message", first)
	}
}

// I4. Compaction must converge on input designed to defeat it: a single tool
// result larger than the whole window, which cannot be folded away because it
// belongs to the live tool pair. It has to be shrunk in place instead, the turn
// has to finish, and the reducer must not spin.
func TestCompactionTerminatesOnAnUnfoldableOversizedResult(t *testing.T) {
	const window int64 = 20_000
	world := newCompactionWorld(t, window, 2_000, func(turn int) *LLMResponse {
		if turn == 1 {
			return toolUseTurn("tu-huge")
		}
		return endTurn("recovered and continued")
	})

	world.w.driveStrategyLoop(world.t, "read the enormous file", false)
	world.runToolTurn("tu-huge", strings.Repeat("enormous ", 12_000))

	if errs := world.errorItems(); len(errs) > 0 {
		t.Fatalf("oversized result ended in error items: %q", errs)
	}
	var assistant string
	var shrunk bool
	for _, item := range world.w.doc.GetItems() {
		switch item.Type {
		case ItemTypeAssistant:
			assistant = item.Content
		case ItemTypeToolAction:
			var payload struct {
				Content string `json:"content"`
			}
			if json.Unmarshal(item.Result, &payload) == nil {
				shrunk = strings.HasPrefix(payload.Content, recoveryShrunkResultMarker)
			}
		}
	}
	if assistant != "recovered and continued" {
		t.Fatalf("assistant content = %q, want the turn to have completed", assistant)
	}
	if !shrunk {
		t.Fatal("the oversized tool result was not shrunk in place; the live tool pair must survive")
	}
	if world.reducerCalls == 0 {
		t.Fatal("no reducer calls; the fixture did not exercise compaction")
	}
	if world.reducerCalls > 64 {
		t.Fatalf("reducer calls = %d, want a bounded number — compaction is spinning", world.reducerCalls)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
)

// TestPrependContextItemMessages: standing context items render as LEADING
// context-item messages, in order, ahead of the messages they are prepended to;
// empty ones are skipped. This is the placement that keeps them inside the
// cached tools+system+history prefix.
func TestPrependContextItemMessages(t *testing.T) {
	history := []map[string]any{
		{"type": "user", "content": "hello"},
		{"type": "assistant", "content": "hi"},
	}
	out := prependContextItemMessages(nil, []ItemContext{
		{ItemID: "FILE_1", Content: "package main"},
		{ItemID: "EMPTY_1", Content: ""}, // skipped
		{ItemID: "FILE_2", Content: "more"},
	})
	out = append(out, history...)

	// Two non-empty context items lead, then the two history messages.
	if len(out) != 4 {
		t.Fatalf("expected 4 messages (2 context + 2 history), got %d: %+v", len(out), out)
	}
	for i, wantID := range []string{"FILE_1", "FILE_2"} {
		msg := out[i]
		if msg["type"] != messageTypeContextItem {
			t.Errorf("message[%d] type = %v, want %q", i, msg["type"], messageTypeContextItem)
		}
		content, _ := msg["content"].(string)
		if !strings.HasPrefix(content, "=== Context: "+wantID+" ===\n") {
			t.Errorf("message[%d] content missing %q header; got %q", i, wantID, content)
		}
	}
	// History follows the context run, untouched.
	if out[2]["content"] != "hello" || out[3]["content"] != "hi" {
		t.Fatalf("history must follow the context run; got %+v", out[2:])
	}
}

// TestPrependContextItemMessagesNilIsNoOp: a turn with no standing context items
// (the common case, and how most tests call buildMessages(nil)) prepends nothing.
func TestPrependContextItemMessagesNilIsNoOp(t *testing.T) {
	out := prependContextItemMessages(nil, nil)
	if len(out) != 0 {
		t.Fatalf("nil contexts must prepend nothing; got %+v", out)
	}
}

// TestBuildMessages_UnplacedContextLeadsHistory: a context whose item does not
// stand in the array being rendered cannot be positioned within it, so it falls
// back to the leading placement, before all history. This is the folded
// compaction probe's case — foldedCompactionContextItemIDs mixes in the PARENT
// thread's items, which have no position in the target thread's history.
func TestBuildMessages_UnplacedContextLeadsHistory(t *testing.T) {
	w := NewConversationWorker("conv-ctx-lead", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "hello"})

	msgs := w.currentRun().buildMessages([]ItemContext{
		{ItemID: "FILE_1", Content: "package main"},
	})

	ctxIdx, userIdx, asstIdx := -1, -1, -1
	for i, m := range msgs {
		c, _ := m["content"].(string)
		switch {
		case m["type"] == messageTypeContextItem && strings.Contains(c, "FILE_1"):
			ctxIdx = i
		case m["type"] == "user" && c == "hi":
			userIdx = i
		case m["type"] == "assistant" && c == "hello":
			asstIdx = i
		}
	}
	if ctxIdx != 0 {
		t.Fatalf("context item must be the FIRST message; got index %d in %+v", ctxIdx, msgs)
	}
	if ctxIdx >= userIdx || userIdx >= asstIdx {
		t.Fatalf("want context < history; got ctx=%d user=%d asst=%d", ctxIdx, userIdx, asstIdx)
	}
}

// TestBuildMessages_ContextByteStableAcrossAppendedTurn is the anti-re-bill
// guard: a seeded context item — one standing at the head of the array, where a
// fresh conversation puts its agents files — stays the FIRST message and
// byte-identical across a later turn that only appended history, so it remains
// inside the cached prefix rather than being re-read as the conversation grows.
func TestBuildMessages_ContextByteStableAcrossAppendedTurn(t *testing.T) {
	w := NewConversationWorker("conv-ctx-stable", "user:test")
	defer w.doc.Destroy()

	ctx := []ItemContext{{ItemID: "FILE_1", Content: "package main"}}

	w.doc.InsertMessage(0, ConversationItem{Type: "file-content", ItemID: "FILE_1"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "one"})
	turn1 := w.currentRun().buildMessages(ctx)

	// Next turn: history grew (assistant reply + a new user message), same context.
	w.doc.InsertMessage(2, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "reply"})
	w.doc.InsertMessage(3, ConversationItem{Type: ItemTypeUser, ItemID: "u-2", Content: "two"})
	turn2 := w.currentRun().buildMessages(ctx)

	if turn1[0]["type"] != messageTypeContextItem || turn2[0]["type"] != messageTypeContextItem {
		t.Fatalf("context must lead both turns; got %v / %v", turn1[0]["type"], turn2[0]["type"])
	}
	if turn1[0]["content"] != turn2[0]["content"] {
		t.Fatalf("context message diverged across an append-only turn:\n  turn1=%q\n  turn2=%q", turn1[0]["content"], turn2[0]["content"])
	}
	if len(turn2) <= len(turn1) {
		t.Fatalf("expected turn2 to have more messages than turn1; got %d vs %d", len(turn2), len(turn1))
	}
}

// TestBuildMessages_MidConversationContextDoesNotShiftHistory is the cache
// anchor: adding a context item partway through a conversation — an @-mention,
// a paperclip pin, a dropped file — must APPEND to the request, never insert
// ahead of history.
//
// A context item stands in the items array at the point it was added (the
// composer awaits the mention before dispatching, so it lands immediately
// before the user message that mentioned it), and it is rendered there. So the
// whole previous request survives as a byte-identical prefix of this one, the
// provider's cache hits, and only the genuinely new bytes are paid for.
// Rendering every context item at the HEAD instead slides all history down one
// slot and cold-starts the entire conversation for the sake of one file.
func TestBuildMessages_MidConversationContextDoesNotShiftHistory(t *testing.T) {
	w := NewConversationWorker("conv-ctx-inplace", "user:test")
	defer w.doc.Destroy()

	// Turn 1: the agents file a fresh conversation seeds itself with, then history.
	w.doc.InsertMessage(0, ConversationItem{Type: "file-content", ItemID: "FILE_1"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "one"})
	w.doc.InsertMessage(2, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "reply"})

	seeded := ItemContext{ItemID: "FILE_1", Content: "# agents file"}
	turn1 := w.currentRun().buildMessages([]ItemContext{seeded})

	// Turn 2: an @-mention's item, then the user message that mentioned it.
	w.doc.InsertMessage(3, ConversationItem{Type: "file-content", ItemID: "FILE_2"})
	w.doc.InsertMessage(4, ConversationItem{Type: ItemTypeUser, ItemID: "u-2", Content: "two"})

	mentioned := ItemContext{ItemID: "FILE_2", Content: "package main"}
	turn2 := w.currentRun().buildMessages([]ItemContext{seeded, mentioned})

	if len(turn2) <= len(turn1) {
		t.Fatalf("turn2 must extend turn1; got %d vs %d messages", len(turn2), len(turn1))
	}
	for i := range turn1 {
		if got, want := mustJSON(t, turn2[i]), mustJSON(t, turn1[i]); got != want {
			t.Fatalf("turn1 is no longer a prefix of turn2 — the cache cold-starts from message[%d]:\n  turn1[%d]=%s\n  turn2[%d]=%s",
				i, i, want, i, got)
		}
	}
	// The mention renders at its own position: after the turn-1 history, before
	// the user message it arrived with.
	tail := turn2[len(turn1):]
	if len(tail) != 2 {
		t.Fatalf("expected the new context item and its user message; got %+v", tail)
	}
	if tail[0]["type"] != messageTypeContextItem || !strings.Contains(tail[0]["content"].(string), "FILE_2") {
		t.Errorf("first new message must be FILE_2's context; got %+v", tail[0])
	}
	if tail[1]["type"] != ItemTypeUser || tail[1]["content"] != "two" {
		t.Errorf("the mentioning user message must follow its context item; got %+v", tail[1])
	}
}

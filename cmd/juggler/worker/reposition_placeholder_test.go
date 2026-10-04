//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestRepositionPlaceholderWritesViewerText pins the reposition-context-item-
// placeholder contract: the worker detaches the tool action from the context
// item it produced and writes the text the viewer sent, rather than wording of
// its own.
func TestRepositionPlaceholderWritesViewerText(t *testing.T) {
	w := NewConversationWorker("test-reposition-placeholder", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.doc.InsertMessage(0,
		ConversationItem{Type: ItemTypeToolAction, ItemID: "ci-1", ToolUseID: "call-1", ToolName: "read", State: StateCompleted},
	)

	w.handleRepositionContextItemPlaceholder(json.RawMessage(`{"itemId":"ci-1","content":"moved on"}`))

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if got := items[0].ItemID; got != "" {
		t.Errorf("itemId = %q, want it cleared so the item is no longer anchored here", got)
	}
	if got := items[0].Content; got != "moved on" {
		t.Errorf("content = %q, want the viewer's text %q", got, "moved on")
	}
}

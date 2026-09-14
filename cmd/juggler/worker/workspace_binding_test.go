//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// A conversation's workspace binding lives in its doc metadata, written by the
// browser. The worker reads it and puts it on every LLM request, which is the
// only way the server learns where this conversation's turn should run: the
// binding is in the Yjs doc, and the server does not read those.
func TestBuildLLMRequest_CarriesWorkspaceBinding(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	var unbound map[string]any
	if err := json.Unmarshal(w.currentRun().buildLLMRequest(&ContextResult{}, nil, "txn-unbound", false), &unbound); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	if _, present := unbound["workspaceId"]; present {
		t.Fatalf("workspaceId = %v, want absent so an unbound conversation asks for exactly what it always did", unbound["workspaceId"])
	}

	w.doc.SetMetadata(metaWorkspaceID, "ws_abc123def")
	var bound map[string]any
	if err := json.Unmarshal(w.currentRun().buildLLMRequest(&ContextResult{}, nil, "txn-bound", false), &bound); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	if got, _ := bound["workspaceId"].(string); got != "ws_abc123def" {
		t.Fatalf("workspaceId = %v, want ws_abc123def", bound["workspaceId"])
	}
}

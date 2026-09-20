//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"
)

// sampleTools is a stable two-tool set used across the cache tests.
func sampleTools() []provider.ToolDefinition {
	return []provider.ToolDefinition{
		{Name: "read_file", Description: "Read a file", InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`)},
		{Name: "grep", Description: "Search", InputSchema: json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string"}}}`)},
	}
}

// cachePrefixJSON serializes the cacheable prompt prefix (tools + system, in
// Anthropic's cache order) so two turns' prefixes can be compared byte-for-byte.
// Identical prefix ⇒ the prompt cache would hit; divergent ⇒ cold start.
func cachePrefixJSON(t *testing.T, p anthropicsdk.BetaMessageNewParams) string {
	t.Helper()
	prefix := struct {
		Tools  any `json:"tools"`
		System any `json:"system"`
	}{Tools: p.Tools, System: p.System}
	data, err := json.Marshal(prefix)
	if err != nil {
		t.Fatalf("marshal cache prefix: %v", err)
	}
	return string(data)
}

// TestSystemBlockCarriesCacheControl: the system prompt is a single cached
// block. This prefix is stable across a strategy change, so the breakpoint hits
// rather than cold-starting each phase.
func TestSystemBlockCarriesCacheControl(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "IDENTITY\n\n<env>\n</env>\n\nEXTENSION GUIDANCE",
		Tools:        sampleTools(),
		Messages:     []provider.Message{{Type: "user", Content: "hello"}},
	})

	if len(params.System) != 1 {
		t.Fatalf("expected 1 system block, got %d", len(params.System))
	}
	if got := string(params.System[0].CacheControl.Type); got != "ephemeral" {
		t.Errorf("system block missing ephemeral cache_control; got %q", got)
	}
}

// TestRollingCacheBreakpointOnLastMessageOnly: the rolling history breakpoint
// sits on the final block of the final message and nowhere else, so each turn
// writes an incrementally longer prefix that the next turn reads.
func TestRollingCacheBreakpointOnLastMessageOnly(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "user", Content: "first"},
			{Type: "assistant", Content: "reply"},
			{Type: "user", Content: "second"},
		},
	})

	n := len(params.Messages)
	if n == 0 {
		t.Fatal("expected messages")
	}

	// Last message's last block carries the breakpoint.
	lastMsg := params.Messages[n-1]
	if len(lastMsg.Content) == 0 {
		t.Fatal("last message has no content blocks")
	}
	lastCC := lastMsg.Content[len(lastMsg.Content)-1].GetCacheControl()
	if lastCC == nil || string(lastCC.Type) != "ephemeral" {
		t.Errorf("last message's final block must carry an ephemeral breakpoint; got %+v", lastCC)
	}

	// Every earlier message carries NO breakpoint (only the tail rolls).
	for i := 0; i < n-1; i++ {
		for j, blk := range params.Messages[i].Content {
			if cc := blk.GetCacheControl(); cc != nil && string(cc.Type) == "ephemeral" {
				t.Errorf("message[%d].block[%d] unexpectedly carries a cache breakpoint", i, j)
			}
		}
	}
}

// countEphemeralBreakpoints returns the total number of ephemeral cache_control
// breakpoints across all message content blocks.
func countEphemeralBreakpoints(messages []anthropicsdk.BetaMessageParam) int {
	n := 0
	for _, m := range messages {
		for _, blk := range m.Content {
			if cc := blk.GetCacheControl(); cc != nil && string(cc.Type) == "ephemeral" {
				n++
			}
		}
	}
	return n
}

// TestRollingBreakpointWithLeadingPrefixContext: a context item at the head of
// the conversation — the agents files a session seeds itself with — rides as a
// leading context-item message. The rolling breakpoint lands on the final block,
// so it sits inside the cached prefix (paid once) rather than anchoring the
// breakpoint itself.
func TestRollingBreakpointWithLeadingPrefixContext(t *testing.T) {
	c := &Client{model: "claude-test"}

	// Leading context, then ordinary history ending on a user turn.
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "context-item", Content: "=== Context: FILE_1 ===\npackage main"},
			{Type: "user", Content: "first"},
			{Type: "assistant", Content: "reply"},
			{Type: "user", Content: "second"},
		},
	})
	if got := countEphemeralBreakpoints(params.Messages); got != 1 {
		t.Fatalf("expected exactly one rolling breakpoint, got %d", got)
	}
	// The leading context-item block must NOT carry the breakpoint.
	if cc := params.Messages[0].Content[0].GetCacheControl(); cc != nil && string(cc.Type) == "ephemeral" {
		t.Errorf("the leading context block must not anchor the rolling breakpoint")
	}
	// The breakpoint is on the final history message ("second"), so everything
	// before it — including the leading context — is cached.
	last := params.Messages[len(params.Messages)-1]
	if cc := last.Content[len(last.Content)-1].GetCacheControl(); cc == nil || string(cc.Type) != "ephemeral" {
		t.Errorf("the last stable history block must carry the rolling breakpoint")
	}
}

// TestRollingBreakpointWithInterleavedContext: a context item added partway
// through a conversation — an @-mention, a pin — renders at the position it was
// added (worker.buildMessages), so it arrives here BETWEEN history messages.
// The breakpoint still lands at the tail, which is the whole point: the request
// is one growing prefix, so the turn that adds the file pays for the file and
// everything before it stays cached.
func TestRollingBreakpointWithInterleavedContext(t *testing.T) {
	c := &Client{model: "claude-test"}

	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "user", Content: "first"},
			{Type: "assistant", Content: "reply"},
			{Type: "context-item", Content: "=== Context: FILE_2 ===\npackage main"},
			{Type: "user", Content: "second"},
		},
	})
	if got := countEphemeralBreakpoints(params.Messages); got != 1 {
		t.Fatalf("expected exactly one rolling breakpoint, got %d", got)
	}
	// The context item and the user message it arrived with merge into one
	// user-role turn: context block first, then the message.
	last := params.Messages[len(params.Messages)-1]
	if len(last.Content) != 2 {
		t.Fatalf("expected the context block and its user message in one turn; got %d block(s)", len(last.Content))
	}
	if cc := last.Content[0].GetCacheControl(); cc != nil && string(cc.Type) == "ephemeral" {
		t.Errorf("an interleaved context block must not anchor the rolling breakpoint")
	}
	if cc := last.Content[1].GetCacheControl(); cc == nil || string(cc.Type) != "ephemeral" {
		t.Errorf("the final block must carry the rolling breakpoint")
	}
}

// TestNoBreakpointWhenNoSystemPrompt: an empty system prompt yields no system
// block (and so no system breakpoint); the rolling message breakpoint still
// applies.
func TestNoBreakpointWhenNoSystemPrompt(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	})
	if len(params.System) != 0 {
		t.Errorf("expected no system block for empty system prompt, got %d", len(params.System))
	}
	last := params.Messages[len(params.Messages)-1]
	if cc := last.Content[len(last.Content)-1].GetCacheControl(); cc == nil || string(cc.Type) != "ephemeral" {
		t.Errorf("rolling breakpoint should still apply with no system prompt")
	}
}

// signedThinking builds a thinking message the transform will keep: an unsigned
// one is dropped outright (Anthropic rejects a signatureless thinking block), so
// the signature is what makes it reach the SDK union as an OfThinking variant.
func signedThinking(content string) provider.Message {
	return provider.Message{
		Type:         "thinking",
		Content:      content,
		ProviderData: map[string]any{"signature": "sig-" + content},
	}
}

// breakpointAt returns the (message, block) index of the single ephemeral
// message-level breakpoint, or (-1, -1) when there is none. It fails the test if
// more than one exists — exactly one is the invariant the whole scheme rests on.
func breakpointAt(t *testing.T, messages []anthropicsdk.BetaMessageParam) (int, int) {
	t.Helper()
	msgIdx, blkIdx := -1, -1
	for i, m := range messages {
		for j, blk := range m.Content {
			if cc := blk.GetCacheControl(); cc != nil && string(cc.Type) == "ephemeral" {
				if msgIdx >= 0 {
					t.Fatalf("expected exactly one message-level breakpoint; found a second at message[%d].block[%d] (first at message[%d].block[%d])", i, j, msgIdx, blkIdx)
				}
				msgIdx, blkIdx = i, j
			}
		}
	}
	return msgIdx, blkIdx
}

// TestRollingBreakpointSkipsTrailingThinkingBlock: a thinking block has no
// cache_control field at all (the SDK union's GetCacheControl returns nil for
// it), so an assistant turn ending in one — what a "continue" turn leaves as the
// final message — would drop the breakpoint entirely if it could only be written
// on the final block. It lands on the last block that accepts it instead.
func TestRollingBreakpointSkipsTrailingThinkingBlock(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "user", Content: "first"},
			{Type: "assistant", Content: "reply"},
			signedThinking("still working"),
		},
	})

	n := len(params.Messages)
	if n == 0 {
		t.Fatal("expected messages")
	}
	last := params.Messages[n-1]
	if len(last.Content) != 2 {
		t.Fatalf("expected the final assistant message to hold [text, thinking], got %d blocks", len(last.Content))
	}
	if last.Content[1].OfThinking == nil {
		t.Fatalf("expected block[1] of the final message to be a thinking block")
	}
	// The SDK fact this whole search rule exists for.
	if cc := last.Content[1].GetCacheControl(); cc != nil {
		t.Errorf("expected a thinking block to refuse cache_control, got %+v", cc)
	}

	msgIdx, blkIdx := breakpointAt(t, params.Messages)
	if msgIdx != n-1 || blkIdx != 0 {
		t.Errorf("expected the breakpoint on the final message's text block (message[%d].block[0]), got message[%d].block[%d]", n-1, msgIdx, blkIdx)
	}
	if got := countEphemeralBreakpoints(params.Messages); got != 1 {
		t.Errorf("expected exactly one rolling breakpoint, got %d", got)
	}
}

// TestRollingBreakpointFallsBackToEarlierMessage: when the whole final message
// refuses cache_control (thinking blocks only), the search crosses the message
// boundary rather than giving up. Retreating one message shortens the cached
// prefix by that message; giving up forfeits the entire conversation prefix.
func TestRollingBreakpointFallsBackToEarlierMessage(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "user", Content: "first"},
			signedThinking("only reasoning"),
		},
	})

	n := len(params.Messages)
	if n != 2 {
		t.Fatalf("expected a user message and a thinking-only assistant message, got %d messages", n)
	}
	if len(params.Messages[1].Content) != 1 || params.Messages[1].Content[0].OfThinking == nil {
		t.Fatalf("expected the final message to hold a single thinking block")
	}

	msgIdx, blkIdx := breakpointAt(t, params.Messages)
	if msgIdx != 0 || blkIdx != 0 {
		t.Errorf("expected the breakpoint to fall back to the preceding user message (message[0].block[0]), got message[%d].block[%d]", msgIdx, blkIdx)
	}
	if got := countEphemeralBreakpoints(params.Messages); got != 1 {
		t.Errorf("expected exactly one rolling breakpoint, got %d", got)
	}
}

// TestRollingBreakpointOnToolResultTail: the ordinary case is untouched — a
// message ending in a cacheable block (here a tool_result) carries the
// breakpoint on that very last block, keeping the cached prefix maximal.
func TestRollingBreakpointOnToolResultTail(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "user", Content: "read it"},
			{Type: "tool-use", ToolUseID: "t1", ToolName: "read_file", ToolInput: map[string]any{"path": "a.go"}},
			{Type: "tool-result", ToolUseID: "t1", Content: "package main"},
		},
	})

	n := len(params.Messages)
	last := params.Messages[n-1]
	if len(last.Content) == 0 {
		t.Fatal("last message has no content blocks")
	}
	if last.Content[len(last.Content)-1].OfToolResult == nil {
		t.Fatalf("expected the final block to be a tool_result")
	}

	msgIdx, blkIdx := breakpointAt(t, params.Messages)
	if msgIdx != n-1 || blkIdx != len(last.Content)-1 {
		t.Errorf("expected the breakpoint on the very last block (message[%d].block[%d]), got message[%d].block[%d]",
			n-1, len(last.Content)-1, msgIdx, blkIdx)
	}
	if got := countEphemeralBreakpoints(params.Messages); got != 1 {
		t.Errorf("expected exactly one rolling breakpoint, got %d", got)
	}
}

// TestNoRollingBreakpointWhenNoBlockAcceptsOne: a request whose every block
// refuses cache_control gets no breakpoint (there is nowhere to put one) and
// still builds a valid request rather than panicking. The client logs the loss.
func TestNoRollingBreakpointWhenNoBlockAcceptsOne(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages:     []provider.Message{signedThinking("only reasoning")},
	})

	if len(params.Messages) != 1 || len(params.Messages[0].Content) != 1 {
		t.Fatalf("expected a single thinking-only message, got %+v", params.Messages)
	}
	if got := countEphemeralBreakpoints(params.Messages); got != 0 {
		t.Errorf("expected no message-level breakpoint when nothing accepts one, got %d", got)
	}
	// The system breakpoint is independent and must survive.
	if len(params.System) != 1 || string(params.System[0].CacheControl.Type) != "ephemeral" {
		t.Errorf("the system breakpoint must still be written")
	}
}

// TestCachePrefixStableAcrossStrategyChange pins the two designs it contrasts.
//
// Current design: strategies contribute NOTHING to the system prompt (they
// inject messages instead), so when the active strategy changes mid-conversation
// the cacheable prefix (tools + system) is byte-identical turn-to-turn. The
// prompt cache therefore hits — exactly the property the breakpoints exploit.
//
// Contrast (the embed-strategy-text-in-system design): the system prompt carries
// phase-dependent strategy text, so a strategy/phase change mutates the cached
// prefix and cold-starts the 30k+ token anchor every transition. The contrast
// case pins that this design WOULD diverge, documenting why message-injection is
// what makes caching effective.
func TestCachePrefixStableAcrossStrategyChange(t *testing.T) {
	c := &Client{model: "claude-test"}
	const base = "IDENTITY\n\n<env>\n</env>\n\nPROJECT RULES\n\nEXTENSION GUIDANCE"
	tools := sampleTools()

	// Current: system is `base` regardless of strategy; only messages grow.
	turn1 := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: base, Tools: tools,
		Messages: []provider.Message{{Type: "user", Content: "u1"}},
	})
	turn2 := c.buildMessageParams(provider.MessageRequest{ // strategy switched here
		SystemPrompt: base, Tools: tools,
		Messages: []provider.Message{
			{Type: "user", Content: "u1"},
			{Type: "assistant", Content: "a1"},
			{Type: "user", Content: "u2"},
		},
	})
	if cachePrefixJSON(t, turn1) != cachePrefixJSON(t, turn2) {
		t.Errorf("cacheable prefix diverged across a strategy change — the prompt cache would cold-start.\nturn1=%s\nturn2=%s",
			cachePrefixJSON(t, turn1), cachePrefixJSON(t, turn2))
	}

	// Contrast: had strategy phase text lived in the system prompt, the two
	// turns' prefixes would differ and bust the cache. Pin that contrast.
	oldPlan := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: base + "\n\nYou are in Plan mode. Explore read-only.", Tools: tools,
		Messages: []provider.Message{{Type: "user", Content: "u1"}},
	})
	oldExec := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: base + "\n\nYou are in Plan Execution mode. Each step runs in a sub-thread.", Tools: tools,
		Messages: []provider.Message{{Type: "user", Content: "u1"}},
	})
	if cachePrefixJSON(t, oldPlan) == cachePrefixJSON(t, oldExec) {
		t.Errorf("expected the old embed-strategy-in-system design to diverge across a phase change (benchmark contrast invalid)")
	}
}

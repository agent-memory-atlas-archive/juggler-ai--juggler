//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

var errConversationClosed = errors.New("acp: conversation closed")

// conversation is the provider.Conversation for one Juggler dialogue. Each
// Juggler thread owns an independent ACP subprocess, transport, and session so
// distinct threads can submit concurrently without sharing agent history or
// inbound callback routing. A goroutine owns the thread map; each threadSession
// serialises its own Submit calls with a channel token.
type conversation struct {
	client   *Client
	convID   string
	approver Approver

	ops  chan conversationOp
	done chan struct{}
}

type conversationOpKind int

const (
	conversationGetThread conversationOpKind = iota
	conversationCancelThread
	conversationCancelAll
	conversationCloseAll
)

type conversationOp struct {
	kind     conversationOpKind
	threadID string
	resp     chan *threadSession
	done     chan struct{}
}

// threadSession owns all mutable ACP state for one MessageRequest.ThreadID. The
// transport binds this value as its inboundHandler, making notification and
// request routing independent of every other thread.
type threadSession struct {
	conversation *conversation
	threadID     string

	initLock lock
	submit   chan struct{}
	sess     atomic.Pointer[session]
	turn     atomic.Pointer[turnState]
}

// session bundles the live transport with its negotiated ACP session id so both
// swap atomically on (re)spawn and teardown.
type session struct {
	rpc       *transport
	sessionID string
}

// turnState carries the callback and accumulators for one in-flight Submit.
// session/update notifications (arriving on the reader goroutine) feed it.
type turnState struct {
	cb provider.StructuredStreamCallback

	guard  lock
	output strings.Builder
	cbErr  error
}

func newConversation(client *Client, convID string, approver Approver) *conversation {
	c := &conversation{
		client:   client,
		convID:   convID,
		approver: approver,
		ops:      make(chan conversationOp),
		done:     make(chan struct{}),
	}
	go c.run()
	return c
}

func newThreadSession(c *conversation, threadID string) *threadSession {
	t := &threadSession{
		conversation: c,
		threadID:     threadID,
		initLock:     newLock(),
		submit:       make(chan struct{}, 1),
	}
	t.submit <- struct{}{}
	return t
}

func (c *conversation) run() {
	threads := make(map[string]*threadSession)
	for {
		op := <-c.ops
		switch op.kind {
		case conversationGetThread:
			t := threads[op.threadID]
			if t == nil {
				t = newThreadSession(c, op.threadID)
				threads[op.threadID] = t
			}
			op.resp <- t
		case conversationCancelThread:
			if t := threads[op.threadID]; t != nil {
				t.cancel()
			}
			op.done <- struct{}{}
		case conversationCancelAll:
			for _, t := range threads {
				t.cancel()
			}
			op.done <- struct{}{}
		case conversationCloseAll:
			for _, t := range threads {
				t.close()
			}
			op.done <- struct{}{}
			close(c.done)
			return
		}
	}
}

func (c *conversation) thread(threadID string) *threadSession {
	resp := make(chan *threadSession, 1)
	select {
	case c.ops <- conversationOp{kind: conversationGetThread, threadID: threadID, resp: resp}:
		return <-resp
	case <-c.done:
		return nil
	}
}

func (ts *turnState) appendOutput(s string) {
	ts.guard.acquire()
	ts.output.WriteString(s)
	ts.guard.release()
}

func (ts *turnState) outputString() string {
	ts.guard.acquire()
	defer ts.guard.release()
	return ts.output.String()
}

func (ts *turnState) setErr(err error) {
	ts.guard.acquire()
	if ts.cbErr == nil {
		ts.cbErr = err
	}
	ts.guard.release()
}

func (ts *turnState) err() error {
	ts.guard.acquire()
	defer ts.guard.release()
	return ts.cbErr
}

// Submit drives one ACP turn on req.ThreadID. Different thread sessions run
// independently; the per-thread token keeps prompts on one ACP session ordered.
func (c *conversation) Submit(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	promptText := latestUserText(req.Messages)
	if strings.TrimSpace(promptText) == "" {
		return nil, errors.New("acp: no user message to send")
	}
	t := c.thread(req.ThreadID)
	if t == nil {
		return nil, errConversationClosed
	}
	return t.submitTurn(ctx, promptText, callback)
}

func (t *threadSession) submitTurn(ctx context.Context, promptText string, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	select {
	case <-t.submit:
		defer func() { t.submit <- struct{}{} }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	sess, err := t.ensureSession(ctx)
	if err != nil {
		return nil, err
	}

	ts := &turnState{cb: callback, guard: newLock()}
	t.turn.Store(ts)
	defer t.turn.CompareAndSwap(ts, nil)

	raw, err := sess.rpc.call(ctx, "session/prompt", promptParams{
		SessionID: sess.sessionID,
		Prompt:    []contentBlock{{Type: "text", Text: promptText}},
	})
	if err != nil {
		if errors.Is(err, errTransportClosed) {
			t.dropSession(sess)
		}
		return nil, err
	}
	if cbErr := ts.err(); cbErr != nil {
		return nil, cbErr
	}

	var pr promptResult
	if err := json.Unmarshal(raw, &pr); err != nil {
		jlog.Debug("[acp] session/prompt: decode result: %v", err)
	}

	return &provider.StreamResult{
		// ACP spells its stop reasons the way provider.StopReason does, so the
		// agent's value carries across as itself; the ones with no constant
		// there ("max_turn_requests") reach the turn loop as themselves.
		StopReason:             provider.StopReason(pr.StopReason),
		InputTokens:            provider.EstimateTokens(promptText),
		InputTokensApproximate: true,
		OutputTokens:           provider.EstimateTokens(ts.outputString()),
	}, nil
}

func (c *conversation) Subscribe(sink provider.TurnSink) {}

func (c *conversation) CacheTTL() time.Duration { return 0 }

// Cancel cooperatively interrupts one thread, or every existing thread for
// provider.CancelAllThreads, while preserving each live ACP session.
func (c *conversation) Cancel(threadItemID string) {
	done := make(chan struct{}, 1)
	kind := conversationCancelThread
	if threadItemID == provider.CancelAllThreads {
		kind = conversationCancelAll
	}
	select {
	case c.ops <- conversationOp{kind: kind, threadID: threadItemID, done: done}:
		<-done
	case <-c.done:
	}
}

// Close releases every thread's subprocess and transport. It is idempotent; the
// handle is terminal after the first call.
func (c *conversation) Close() error {
	done := make(chan struct{}, 1)
	select {
	case c.ops <- conversationOp{kind: conversationCloseAll, done: done}:
		<-done
	case <-c.done:
	}
	return nil
}

func (t *threadSession) cancel() {
	sess := t.sess.Load()
	if sess == nil || sess.sessionID == "" {
		return
	}
	if err := sess.rpc.notify("session/cancel", cancelParams{SessionID: sess.sessionID}); err != nil {
		jlog.Debug("[acp] session/cancel: %v", err)
	}
}

func (t *threadSession) close() {
	t.initLock.acquire()
	sess := t.sess.Swap(nil)
	t.initLock.release()
	if sess == nil {
		return
	}
	if sess.sessionID != "" {
		_ = sess.rpc.notify("session/cancel", cancelParams{SessionID: sess.sessionID})
	}
	sess.rpc.close()
}

// ensureSession lazily spawns and handshakes this thread's agent, or replaces a
// transport dropped after a crash.
func (t *threadSession) ensureSession(ctx context.Context) (*session, error) {
	if s := t.sess.Load(); s != nil && !s.rpc.closed() {
		return s, nil
	}
	t.initLock.acquire()
	defer t.initLock.release()
	if s := t.sess.Load(); s != nil && !s.rpc.closed() {
		return s, nil
	}

	c := t.conversation
	agent, err := resolveAgent(c.client.projectRoot, c.client.model)
	if err != nil {
		return nil, err
	}
	proc, err := spawnAgent(ctx, c.client.workingDir, agent)
	if err != nil {
		return nil, err
	}
	tr := newTransport(proc.stdin, proc.stdout, proc.kill, proc.reap)
	tr.start(t)

	sid, err := t.handshake(ctx, tr)
	if err != nil {
		tr.close()
		return nil, err
	}
	s := &session{rpc: tr, sessionID: sid}
	t.sess.Store(s)
	return s, nil
}

func (t *threadSession) dropSession(s *session) {
	if t.sess.CompareAndSwap(s, nil) {
		s.rpc.close()
	}
}

// handleNotification runs inline on this thread's transport reader, preserving
// update order while making cross-thread callback crossover impossible.
func (t *threadSession) handleNotification(method string, params json.RawMessage) {
	if method != "session/update" {
		return
	}
	var p sessionUpdateParams
	if err := json.Unmarshal(params, &p); err != nil {
		jlog.Debug("[acp] session/update: decode: %v", err)
		return
	}
	ts := t.turn.Load()
	if ts == nil {
		return
	}
	chunk, ok := toStreamChunk(p.Update)
	if !ok {
		return
	}
	if isOutputText(chunk.Type) {
		ts.appendOutput(chunk.Content)
	}
	if _, err := ts.cb(chunk); err != nil {
		ts.setErr(err)
	}
}

func (t *threadSession) handleRequest(id json.RawMessage, method string, params json.RawMessage) {
	sess := t.sess.Load()
	if sess == nil {
		return
	}
	switch method {
	case "session/request_permission":
		t.handlePermission(sess, id, params)
	default:
		if err := sess.rpc.respondError(id, rpcCodeMethodNotFound, "method not supported (MVP): "+method); err != nil {
			jlog.Debug("[acp] respondError %s: %v", method, err)
		}
	}
}

func (t *threadSession) handlePermission(sess *session, id json.RawMessage, params json.RawMessage) {
	var p requestPermissionParams
	if err := json.Unmarshal(params, &p); err != nil {
		_ = sess.rpc.respondError(id, rpcCodeInvalidParams, "invalid session/request_permission params")
		return
	}
	outcome := t.conversation.approver.Approve(PermissionRequest{ToolCall: p.ToolCall, Options: p.Options})
	var resp permissionResponse
	if outcome.Selected {
		resp = permissionResponse{Outcome: permissionOutcomeWire{Outcome: "selected", OptionID: outcome.OptionID}}
	} else {
		resp = permissionResponse{Outcome: permissionOutcomeWire{Outcome: "cancelled"}}
	}
	if err := sess.rpc.respond(id, resp); err != nil {
		jlog.Debug("[acp] session/request_permission respond: %v", err)
	}
}

func latestUserText(msgs []provider.Message) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if provider.MessageTypeToRole(msgs[i].Type) == "user" && strings.TrimSpace(msgs[i].Content) != "" {
			return msgs[i].Content
		}
	}
	return ""
}

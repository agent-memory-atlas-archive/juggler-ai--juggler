//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"
)

// managerOpKind identifies the type of operation sent to the Manager goroutine.
type managerOpKind int

const (
	mgrSetLLMCaller managerOpKind = iota
	mgrSetWindowResolver
	mgrSetAutoCompactGate
	mgrSetEngineClient
	mgrClearEngineClient
	mgrGetOrCreate
	mgrSeedNewConversation
	mgrGet
	mgrRemove
	mgrHandleMessage
	mgrClientDisconnected
	mgrShutdown
	mgrCount
	mgrSetPathProvider
	mgrSetNameProvider
	mgrSetSaveBinary
	mgrSetCancelLLMSession
	mgrSetEngineReady
	mgrSetSyncThrottle
	mgrSystemWake
	mgrAnyActive
	mgrActiveIDs
	mgrSetAutoNamer
	mgrSetSpendLimit
	mgrConversationRestored
	mgrRecordBackgroundTaskSnapshot
)

// CancelLLMSessionFunc tears down provider-side state for an in-flight LLM
// session on ONE thread of a conversation, while preserving the resume anchor so
// the next turn stays cache-warm. Currently only the claudecode provider
// implements this with non-trivial behaviour: its persistent CLI subprocess can
// be parked inside MCP tools/call awaiting a result that the user has just
// cancelled, so the cancel must kill that subprocess without discarding the warm
// session. Other providers run one-shot LLM calls, so their cancellation is
// fully covered by ctx cancellation on the in-flight call. Safe no-op for
// unknown convIDs.
//
// threadItemID names the thread whose session to release — "" is the root
// thread, provider.CancelAllThreads every thread of the conversation. Naming it
// is what keeps one thread's Stop from killing the subprocess a sibling is
// streaming through: claudecode gives each thread its own CLI.
type CancelLLMSessionFunc func(conversationID, threadItemID string)

// PathProviderFunc resolves a conversation id to its on-disk folder path.
// Returns ok=false if the conversation is unknown to the session store.
type PathProviderFunc func(convID string) (string, bool)

// NameProviderFunc resolves a conversation id to its human-readable tab name.
// Returns ok=false if the conversation is unknown to the session store.
//
// The name is the session store's to know — it is carried by the folder name,
// which the store owns and renames — so a worker that needs the name for a log
// filename or the auto-naming gate asks for it rather than decoding the path
// it was handed.
type NameProviderFunc func(convID string) (string, bool)

// SaveBinaryFunc persists the Yjs binary for a conversation. The
// implementation is expected to create the conversation's folder if it
// doesn't exist (e.g. for a newly-duplicated conversation) and to write
// atomically.
type SaveBinaryFunc func(convID string, data []byte) error

// BackgroundTaskSnapshot is the bounded task history persisted on its tool
// action — the shell registry's own snapshot type under the worker's name, so a
// snapshot travels from the registry to the document without being restated.
type BackgroundTaskSnapshot = ops.BackgroundTaskSnapshot

// managerOp is a message sent to the Manager's run goroutine.
type managerOp struct {
	kind            managerOpKind
	conversationID  string
	authorID        string
	clientID        string
	msgType         string
	payload         json.RawMessage
	sendCallback    func(msg []byte)
	llmCallFunc     LLMCallFunc
	windowResolver  WindowResolverFunc
	autoCompactGate AutoCompactGateFunc
	spendLimit      SpendLimitFunc
	autoNameFunc    AutoNameFunc
	engineCallback  func(convID string, msg []byte)
	pathProvider    PathProviderFunc
	nameProvider    NameProviderFunc
	saveBinaryFn    SaveBinaryFunc
	cancelLLMFn     CancelLLMSessionFunc
	engineReadyFn   func() bool
	syncThrottle    time.Duration
	initMessage     *InitMessage
	backgroundTask  *BackgroundTaskSnapshot

	// Response channels
	workerResult chan *ConversationWorker
	boolResult   chan bool
	intResult    chan int
	idsResult    chan []string
	errorResult  chan error
	done         chan struct{} // for synchronous operations (e.g., shutdown)
}

// Manager manages Go workers for conversations.
// Each conversation can have at most one active worker.
// A dedicated goroutine owns all state — no mutexes needed.
//
// The manager owns a parent context cancelled on Shutdown. Each worker is
// started with this ctx so a server-level shutdown propagates to every
// active LLM call without each caller having to plumb its own cancel func.
type Manager struct {
	ops    chan managerOp
	done   chan struct{}
	ctx    context.Context
	cancel context.CancelFunc
}

// NewManager creates a new worker manager and starts its goroutine.
func NewManager() *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		ops:    make(chan managerOp, 64),
		done:   make(chan struct{}),
		ctx:    ctx,
		cancel: cancel,
	}
	go m.run()
	return m
}

// run is the dedicated goroutine that owns all Manager state.
func (m *Manager) run() {
	workers := make(map[string]*ConversationWorker)         // conversationID -> worker
	clientConversations := make(map[string]map[string]bool) // clientID -> set of conversationIDs
	// removedConvs holds ids torn down by Remove (bin or permanent delete).
	// Remove returns before the caller moves the folder, so for that window the
	// path provider still resolves the id and a late client message would
	// recreate a worker for a conversation that is about to stop existing — one
	// whose every save is then silently dropped as unowned, and whose tab
	// outlives it. The id is cleared again by ConversationRestored.
	removedConvs := make(map[string]bool)
	var llmCallFunc LLMCallFunc
	var windowResolver WindowResolverFunc
	var autoCompactGate AutoCompactGateFunc
	var spendLimit SpendLimitFunc
	var autoNameFunc AutoNameFunc
	var engineClientID string
	var engineCallback func(convID string, msg []byte)
	var pathProvider PathProviderFunc
	var nameProvider NameProviderFunc
	var saveBinaryFn SaveBinaryFunc
	var cancelLLMFn CancelLLMSessionFunc
	var engineReadyFn func() bool
	var syncThrottle time.Duration

	// Helper to create a worker and register engine client. If requireKnown is
	// true, the conversation must not have been torn down by Remove and the
	// current pathProvider must still resolve the conversation id; this prevents
	// stale browser messages after delete/archive from recreating workers for
	// ids that no longer have active folders.
	createWorker := func(conversationID, authorID string, requireKnown bool) *ConversationWorker {
		if requireKnown {
			if removedConvs[conversationID] {
				jlog.Info("[worker.Manager] rejecting stale worker message for removed conv=%s", conversationID)
				return nil
			}
			if pathProvider != nil {
				if _, ok := pathProvider(conversationID); !ok {
					jlog.Info("[worker.Manager] rejecting stale worker message for unknown/deleted conv=%s", conversationID)
					return nil
				}
			}
		}
		w := NewConversationWorker(conversationID, authorID)
		if syncThrottle > 0 {
			w.SetSyncThrottle(syncThrottle)
		}
		if pathProvider != nil {
			w.SetPathProvider(pathProvider)
		}
		if nameProvider != nil {
			w.SetNameProvider(nameProvider)
		}
		if saveBinaryFn != nil {
			w.SetSaveBinary(saveBinaryFn)
		}
		if llmCallFunc != nil {
			w.SetLLMCaller(llmCallFunc)
		}
		if windowResolver != nil {
			w.SetWindowResolver(windowResolver)
		}
		if autoCompactGate != nil {
			w.SetAutoCompactGate(autoCompactGate)
		}
		if spendLimit != nil {
			w.SetSpendLimit(spendLimit)
		}
		if autoNameFunc != nil {
			w.SetAutoNamer(autoNameFunc)
		}
		if cancelLLMFn != nil {
			w.SetCancelLLMSession(cancelLLMFn)
		}
		if engineReadyFn != nil {
			w.SetEngineReadyFunc(engineReadyFn)
		}
		w.Start(m.ctx)
		workers[conversationID] = w

		// Auto-register engine client on new workers
		if engineClientID != "" && engineCallback != nil {
			convIDCopy := conversationID
			cb := engineCallback
			w.SetCallback(engineClientID, func(msg []byte) {
				cb(convIDCopy, msg)
			})
			w.SetEngineClientID(engineClientID)
		}

		return w
	}

	for op := range m.ops {
		switch op.kind {
		case mgrSetLLMCaller:
			llmCallFunc = op.llmCallFunc

		case mgrSetWindowResolver:
			windowResolver = op.windowResolver
			for _, w := range workers {
				w.SetWindowResolver(windowResolver)
			}

		case mgrSetAutoCompactGate:
			autoCompactGate = op.autoCompactGate
			for _, w := range workers {
				w.SetAutoCompactGate(autoCompactGate)
			}

		case mgrSetSpendLimit:
			spendLimit = op.spendLimit
			for _, w := range workers {
				w.SetSpendLimit(spendLimit)
			}

		case mgrSetAutoNamer:
			autoNameFunc = op.autoNameFunc
			for _, w := range workers {
				w.SetAutoNamer(autoNameFunc)
			}

		case mgrSetCancelLLMSession:
			cancelLLMFn = op.cancelLLMFn
			for _, w := range workers {
				w.SetCancelLLMSession(cancelLLMFn)
			}

		case mgrSetEngineReady:
			engineReadyFn = op.engineReadyFn
			for _, w := range workers {
				w.SetEngineReadyFunc(engineReadyFn)
			}

		case mgrSetSyncThrottle:
			// Applied to workers at creation (the batcher is built in the
			// constructor); existing workers keep their current window.
			syncThrottle = op.syncThrottle

		case mgrSetPathProvider:
			pathProvider = op.pathProvider
			for _, w := range workers {
				w.SetPathProvider(pathProvider)
			}

		case mgrSetNameProvider:
			nameProvider = op.nameProvider
			for _, w := range workers {
				w.SetNameProvider(nameProvider)
			}

		case mgrSetSaveBinary:
			saveBinaryFn = op.saveBinaryFn
			for _, w := range workers {
				w.SetSaveBinary(saveBinaryFn)
			}

		case mgrSetEngineClient:
			engineClientID = op.clientID
			engineCallback = op.engineCallback
			// Register on all existing workers
			for convID, w := range workers {
				convIDCopy := convID
				cb := op.engineCallback
				w.SetCallback(op.clientID, func(msg []byte) {
					cb(convIDCopy, msg)
				})
				w.SetEngineClientID(op.clientID)
				// Seed the newly-attached engine with the state of conversations
				// that were already loaded before it connected. A recreated
				// on-demand engine starts with an empty session and only
				// auto-loads a conversation on an incidental yjs-sync; without
				// this seed its approved tool-actions would never be observed
				// and so never execute (the "tools stuck forever" wedge).
				w.SendFromClient(op.clientID, "resync-to-origin", nil)
			}

		case mgrClearEngineClient:
			if engineClientID != op.clientID {
				continue
			}
			cid := engineClientID
			engineClientID = ""
			engineCallback = nil
			for _, w := range workers {
				w.RemoveCallback(cid)
			}

		case mgrGetOrCreate:
			if w, ok := workers[op.conversationID]; ok {
				op.workerResult <- w
			} else {
				op.workerResult <- createWorker(op.conversationID, op.authorID, false)
			}

		case mgrSeedNewConversation:
			w, ok := workers[op.conversationID]
			if !ok {
				w = createWorker(op.conversationID, "server:seed", false)
			}
			var err error
			if w != nil && op.initMessage != nil {
				payload, marshalErr := json.Marshal(op.initMessage)
				if marshalErr != nil {
					err = marshalErr
				} else {
					err = w.SendAndWait(m.ctx, "init", payload)
					if err == nil {
						err = w.FlushPersistence(m.ctx)
					}
				}
			}
			op.errorResult <- err

		case mgrGet:
			op.workerResult <- workers[op.conversationID]

		case mgrRemove:
			// Recorded before the caller is acknowledged: the folder move
			// happens after Remove returns, so the id must already be refused
			// by createWorker when that call unblocks.
			removedConvs[op.conversationID] = true
			w, ok := workers[op.conversationID]
			if ok {
				// Mark deleting before acknowledging the caller. The HTTP handler
				// deletes/moves the folder immediately after Remove returns; any
				// already-queued save/flush must observe deleting=true and skip.
				w.MarkDeleting()
				delete(workers, op.conversationID)
			}
			if op.done != nil {
				op.done <- struct{}{}
			}
			if ok {
				inflight := w.hasLLMInFlight()
				jlog.Info("[worker.Remove] stopping worker conv=%s llmInFlight=%v", op.conversationID, inflight)
				go w.StopForRemoval()
			} else {
				jlog.Info("[worker.Remove] no worker for conv=%s (already gone)", op.conversationID)
			}

		case mgrConversationRestored:
			delete(removedConvs, op.conversationID)
			if op.done != nil {
				op.done <- struct{}{}
			}

		case mgrRecordBackgroundTaskSnapshot:
			w := workers[op.conversationID]
			if w == nil || op.backgroundTask == nil {
				continue
			}
			payload, err := json.Marshal(op.backgroundTask)
			if err == nil {
				w.Send("background-task-snapshot", payload)
			}

		case mgrHandleMessage:
			w, exists := workers[op.conversationID]
			if !exists {
				w = createWorker(op.conversationID, "user:main", true)
				if w == nil {
					op.boolResult <- false
					continue
				}
			}

			// Register callback — always set when provided (idempotent, avoids blocking GetCallback)
			if op.sendCallback != nil {
				w.SetCallback(op.clientID, op.sendCallback)
				if clientConversations[op.clientID] == nil {
					clientConversations[op.clientID] = make(map[string]bool)
				}
				clientConversations[op.clientID][op.conversationID] = true
			}

			w.SendFromClient(op.clientID, op.msgType, op.payload)
			op.boolResult <- true

		case mgrClientDisconnected:
			convIDs, exists := clientConversations[op.clientID]
			if !exists {
				continue
			}
			for convID := range convIDs {
				if w, ok := workers[convID]; ok {
					w.RemoveCallback(op.clientID)
				}
			}
			delete(clientConversations, op.clientID)

		case mgrShutdown:
			if n := len(workers); n > 0 {
				jlog.Info("⏳ Shutting down %d conversation worker(s)...", n)
			}
			// Cancel the manager-level context first so any in-flight LLM
			// call observing the worker's ctx unblocks before w.Stop closes
			// its inbound channel.
			m.cancel()
			// Concurrently, because Stop blocks until that worker has unwound
			// its turn and written its document, and every worker shares one
			// bounded teardown window. In sequence, the last worker's LLM call
			// is not even cancelled until all the others have finished saving —
			// so a busy session runs the window out and the conversations at
			// the back of the queue never get written at all. Each Stop touches
			// only its own worker; the writes serialize behind the session
			// manager's actor either way.
			var wg sync.WaitGroup
			for _, w := range workers {
				wg.Go(w.Stop)
			}
			wg.Wait()
			workers = make(map[string]*ConversationWorker)
			if op.done != nil {
				op.done <- struct{}{}
			}

		case mgrSystemWake:
			// The OS reported the system resumed from sleep. Any LLM request
			// that was streaming across the sleep almost certainly lost its
			// connection; cancel it now so the turn fails fast instead of
			// riding the LLMTimeout backstop. Runs in this goroutine, so the
			// per-worker reads are race-free.
			for _, w := range workers {
				w.interruptInFlightLLMForWake()
			}

		case mgrCount:
			op.intResult <- len(workers)

		case mgrAnyActive:
			// "Active" = a turn is genuinely doing work on some worker:
			// activity != none AND not merely parked on a pending approval.
			// claimLLM/requestLLM set activity at turn start and sendStatus
			// ("idle") clears it, so it stays non-none for the whole turn —
			// including while async tools execute AND while parked awaiting
			// approval. isActivelyRunning excludes only the latter: a turn
			// blocked solely on approvals is interrupting nothing, so it is
			// safe to quit/rebuild. Read from this goroutine so the per-worker
			// reads are race-free; the reads take ycrdtMu for the C binding.
			active := false
			for _, w := range workers {
				if w.isActivelyRunning() {
					active = true
					break
				}
			}
			op.boolResult <- active

		case mgrActiveIDs:
			ids := make([]string, 0)
			for convID, w := range workers {
				if w.isActivelyRunning() {
					ids = append(ids, convID)
				}
			}
			sort.Strings(ids)
			op.idsResult <- ids
		}
	}
	close(m.done)
}

// SetLLMCaller sets the function used by all workers to call the LLM provider directly.
func (m *Manager) SetLLMCaller(fn LLMCallFunc) {
	m.ops <- managerOp{kind: mgrSetLLMCaller, llmCallFunc: fn}
}

// SetWindowResolver sets the context-window resolver applied to every existing
// worker and any worker created later. See WindowResolverFunc.
func (m *Manager) SetWindowResolver(fn WindowResolverFunc) {
	m.ops <- managerOp{kind: mgrSetWindowResolver, windowResolver: fn}
}

// SetAutoCompactGate sets the automatic-compaction gate applied to every
// existing worker and any worker created later. See AutoCompactGateFunc.
func (m *Manager) SetAutoCompactGate(fn AutoCompactGateFunc) {
	m.ops <- managerOp{kind: mgrSetAutoCompactGate, autoCompactGate: fn}
}

// SetSpendLimit sets the conversation spend-ceiling resolver applied to every
// existing worker and any worker created later. See SpendLimitFunc.
func (m *Manager) SetSpendLimit(fn SpendLimitFunc) {
	m.ops <- managerOp{kind: mgrSetSpendLimit, spendLimit: fn}
}

// SetAutoNamer sets the out-of-band tab auto-naming callback applied to every
// existing worker and any worker created later. See AutoNameFunc.
func (m *Manager) SetAutoNamer(fn AutoNameFunc) {
	m.ops <- managerOp{kind: mgrSetAutoNamer, autoNameFunc: fn}
}

// SetEngineReadyFunc sets the engine-readiness gate used by all workers before
// dispatching a strategy hook to the engine at turn-start. See
// ConversationWorker.engineReadyFunc.
func (m *Manager) SetEngineReadyFunc(fn func() bool) {
	m.ops <- managerOp{kind: mgrSetEngineReady, engineReadyFn: fn}
}

// SetSyncThrottle sets the outbound-sync coalescing window applied to workers
// created after this call. Zero leaves the default (SyncThrottleMs). The server
// wires this from the JUGGLER_TEST_SYNC_THROTTLE_MS knob at startup.
func (m *Manager) SetSyncThrottle(d time.Duration) {
	m.ops <- managerOp{kind: mgrSetSyncThrottle, syncThrottle: d}
}

// SetCancelLLMSession registers a callback workers can invoke to abort any
// provider-side LLM session for a conversation. Used by the claudecode
// provider to release MCP tools/call handlers parked on a CLI subprocess
// after a user-initiated cancel.
func (m *Manager) SetCancelLLMSession(fn CancelLLMSessionFunc) {
	m.ops <- managerOp{kind: mgrSetCancelLLMSession, cancelLLMFn: fn}
}

// SetPathProvider sets the per-conversation path resolver applied to every
// existing worker and any worker created later. Called once at server
// startup and again on project switch.
func (m *Manager) SetPathProvider(fn PathProviderFunc) {
	m.ops <- managerOp{kind: mgrSetPathProvider, pathProvider: fn}
}

// SetNameProvider sets the per-conversation name resolver applied to every
// existing worker and any worker created later. Called alongside
// SetPathProvider at server startup and again on project switch.
func (m *Manager) SetNameProvider(fn NameProviderFunc) {
	m.ops <- managerOp{kind: mgrSetNameProvider, nameProvider: fn}
}

// SetSaveBinary registers the persistence callback used by every worker
// to save its Yjs doc. The callback is expected to handle folder
// creation and atomic writes.
func (m *Manager) SetSaveBinary(fn SaveBinaryFunc) {
	m.ops <- managerOp{kind: mgrSetSaveBinary, saveBinaryFn: fn}
}

// SetEngineClient registers the engine client callback.
func (m *Manager) SetEngineClient(clientID string, callback func(convID string, msg []byte)) {
	m.ops <- managerOp{kind: mgrSetEngineClient, clientID: clientID, engineCallback: callback}
}

// ClearEngineClient removes the engine client callback from all workers.
func (m *Manager) ClearEngineClient(clientID string) {
	m.ops <- managerOp{kind: mgrClearEngineClient, clientID: clientID}
}

// GetOrCreate returns an existing worker or creates a new one.
func (m *Manager) GetOrCreate(conversationID, authorID string) *ConversationWorker {
	result := make(chan *ConversationWorker, 1)
	m.ops <- managerOp{kind: mgrGetOrCreate, conversationID: conversationID, authorID: authorID, workerResult: result}
	return <-result
}

// SeedNewConversation initializes a newly-created conversation's doc and saves it
// before the server announces the conversation to viewers. The worker remains
// loaded afterwards, so the creating viewer attaches through the normal init
// reconnect path.
func (m *Manager) SeedNewConversation(conversationID, name, projectPath, created string, model *core.ModelRef) error {
	// Copied rather than aliased: the seed must not change under the worker if
	// the caller reuses its ModelRef.
	var modelConfig *ModelConfig
	if model != nil && model.Provider != "" && model.Model != "" {
		seed := *model
		modelConfig = &seed
	}
	init := &InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:          conversationID,
			Name:        name,
			Created:     created,
			ModelConfig: modelConfig,
		},
		Config: WorkerConfig{ProjectPath: projectPath},
	}
	result := make(chan error, 1)
	m.ops <- managerOp{kind: mgrSeedNewConversation, conversationID: conversationID, initMessage: init, errorResult: result}
	return <-result
}

// Get returns a worker if it exists.
func (m *Manager) Get(conversationID string) *ConversationWorker {
	result := make(chan *ConversationWorker, 1)
	m.ops <- managerOp{kind: mgrGet, conversationID: conversationID, workerResult: result}
	return <-result
}

// RecordBackgroundTaskSnapshot persists task history only when its owning
// conversation is already loaded. An asynchronous task must never resurrect a
// removed conversation merely to write a late snapshot.
func (m *Manager) RecordBackgroundTaskSnapshot(conversationID string, snapshot BackgroundTaskSnapshot) {
	m.ops <- managerOp{kind: mgrRecordBackgroundTaskSnapshot, conversationID: conversationID, backgroundTask: &snapshot}
}

// FlushConversation forces the worker for conversationID (if one is loaded) to
// persist its in-memory doc to disk synchronously, then returns. It is the
// pre-step for any out-of-band read of a conversation's on-disk files (e.g. the
// server-side duplicate, which copies doc.yjs + txns directly): without it a
// freshly-edited open conversation could be copied from a stale file. No-op
// when no worker is loaded — the on-disk doc is then already authoritative.
func (m *Manager) FlushConversation(conversationID string) error {
	w := m.Get(conversationID)
	if w == nil {
		return nil
	}
	return w.FlushPersistence(m.ctx)
}

// RemoveAndPurgeLogs removes the worker for conversationID like Remove, and
// additionally — when a worker is loaded — flags it to delete its
// per-conversation log file(s) once its sink is closed (race-free on the
// worker's own goroutine, so it works on Windows too). Use this only for a
// PERMANENT delete, never a reversible bin or a plain eviction. When no worker
// is loaded the logs are left for the retention sweep (the manager has no
// project path to resolve them here).
func (m *Manager) RemoveAndPurgeLogs(conversationID string) {
	if w := m.Get(conversationID); w != nil {
		w.purgeLogs.Store(true)
	}
	m.Remove(conversationID)
}

// NameIsProvisional reports whether a conversation's name may still be replaced
// by the auto-namer. known=false when no worker is loaded: the marker lives in
// the conversation's doc, which only a loaded worker holds, and the auto-namer
// treats "can't tell" as "don't rename". Every auto-naming path starts from a
// loaded worker, so an unknown answer means the conversation was evicted
// mid-derivation. See metaProvisionalName.
func (m *Manager) NameIsProvisional(conversationID string) (provisional bool, known bool) {
	w := m.Get(conversationID)
	if w == nil {
		return false, false
	}
	return w.NameIsProvisional(), true
}

// RenameLog tells the loaded worker for conversationID (if any) to move its
// per-conversation log file to match the conversation's new name. Called by the
// rename API after the on-disk folder has been renamed; the worker re-derives
// the name from that folder, so no name needs to be passed. No-op when no worker
// is loaded — the file (if any) picks up the new name when the worker next inits.
func (m *Manager) RenameLog(conversationID string) {
	if w := m.Get(conversationID); w != nil {
		w.Send("rename-log", nil)
	}
}

// DumpTape returns the per-worker event tape for the given conversation,
// JSON-encoded. Returns nil if the worker does not exist or tracing is off.
// Used by `/api/test/dump-tape` to splice worker-side events into the
// JS-side failure block at test-failure time. Returns []byte rather than the
// concrete EventTapeEntry slice so callers (test handlers package) don't
// take a worker-package dep.
func (m *Manager) DumpTape(conversationID string) any {
	w := m.Get(conversationID)
	if w == nil {
		return nil
	}
	return w.tape.DumpAll()
}

// Remove stops and removes a worker, and refuses to recreate one for that
// conversation from a later client message. Blocks until the worker is stopped.
// Reserved for binning and permanent deletion — a conversation removed here
// only becomes workable again through ConversationRestored.
func (m *Manager) Remove(conversationID string) {
	done := make(chan struct{}, 1)
	m.ops <- managerOp{kind: mgrRemove, conversationID: conversationID, done: done}
	<-done
}

// ConversationRestored lifts the block Remove placed on a conversation id, so a
// conversation brought back out of the bin can load a worker again. Blocks until
// the manager has recorded it, so the restore endpoint cannot answer the client
// before a reopened tab would be served.
func (m *Manager) ConversationRestored(conversationID string) {
	done := make(chan struct{}, 1)
	m.ops <- managerOp{kind: mgrConversationRestored, conversationID: conversationID, done: done}
	<-done
}

// HandleMessageWithClient routes a message to the appropriate worker.
func (m *Manager) HandleMessageWithClient(conversationID, clientID, msgType string, payload json.RawMessage, sendCallback func(msg []byte)) bool {
	result := make(chan bool, 1)
	m.ops <- managerOp{
		kind:           mgrHandleMessage,
		conversationID: conversationID,
		clientID:       clientID,
		msgType:        msgType,
		payload:        payload,
		sendCallback:   sendCallback,
		boolResult:     result,
	}
	return <-result
}

// ClientDisconnected removes all callbacks for a client across all conversations.
func (m *Manager) ClientDisconnected(clientID string) {
	m.ops <- managerOp{kind: mgrClientDisconnected, clientID: clientID}
}

// HandleMessage routes a message to the appropriate worker (legacy API).
// Deprecated: Use HandleMessageWithClient for proper multi-client support.
func (m *Manager) HandleMessage(conversationID string, msgType string, payload json.RawMessage, sendCallback func(msg []byte)) bool {
	return m.HandleMessageWithClient(conversationID, "legacy-client", msgType, payload, sendCallback)
}

// Shutdown stops all workers. Blocks until all workers are stopped.
func (m *Manager) Shutdown() {
	done := make(chan struct{}, 1)
	m.ops <- managerOp{kind: mgrShutdown, done: done}
	<-done
}

// SystemDidWake notifies the manager that the OS resumed from sleep so every
// worker can cancel any in-flight LLM request whose connection the sleep is
// likely to have dropped. Wired from the platform sleep/wake observer via
// the syswake package. Fire-and-forget: the op is queued on the manager
// goroutine and never blocks the (possibly main-thread) wake callback.
func (m *Manager) SystemDidWake() {
	m.ops <- managerOp{kind: mgrSystemWake}
}

// Count returns the number of active workers.
func (m *Manager) Count() int {
	result := make(chan int, 1)
	m.ops <- managerOp{kind: mgrCount, intResult: result}
	return <-result
}

// AnyActive reports whether any conversation worker is actively running a turn:
// doc-native activity != none AND not merely parked on a pending tool approval
// (see isActivelyRunning). An approval-parked turn is interrupting nothing, so
// it is excluded.
func (m *Manager) AnyActive() bool {
	result := make(chan bool, 1)
	m.ops <- managerOp{kind: mgrAnyActive, boolResult: result}
	return <-result
}

// ActiveConversationIDs returns conversation IDs that are actively running a
// turn — activity != none and not merely parked on a pending tool approval
// (see isActivelyRunning). Approval-parked conversations are excluded.
func (m *Manager) ActiveConversationIDs() []string {
	result := make(chan []string, 1)
	m.ops <- managerOp{kind: mgrActiveIDs, idsResult: result}
	return <-result
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// noCheapModelNotice is what the user is told when a micro-task finds no cheap
// model. Information first: what stopped, and where to fix it. The tasks it
// names are the ones they might have noticed not happening.
const noCheapModelNotice = "No cheap model is set, so background tasks like naming tabs can't run. Pick one in Settings → Defaults."

// cheapModelForTask resolves the cheap model for a micro-task that is about to
// run, and tells the user once per server run when there isn't one.
//
// It exists to separate two questions that resolveCheapModel cannot tell apart:
// something wanted to run and couldn't, versus something merely asked what the
// setting currently resolves to. Only the first is worth interrupting anyone
// over, so the settings endpoint calls resolveCheapModel directly and this is
// what the auto-namer and /api/llm/complete call.
//
// Once per run, and not per task, because the cause is configuration: it holds
// for every micro-task equally, so announcing each one would put a toast on
// screen for every new conversation. That cost is why this was previously not
// announced at all — and being announced nowhere is why a user whose provider
// has no cheap tier had no way to find out that tab naming had quietly stopped.
// The counter resets when the server does, which is the right cadence for a
// message about something the user has to go and change.
//
// Nothing is said when the user has turned the cheap model off. They know.
//
// Nor is anything said when the first provider refresh has not landed yet.
// resolveCheapModel waits for it, but gives up when the caller's context ends
// or the readiness timeout elapses, and then resolves against an empty list: a
// client that aborts a request during startup would otherwise announce a
// missing model that discovery is about to find, and spend the run's single
// notice on it.
func (s *Server) cheapModelForTask(ctx context.Context, primary core.ModelRef) (core.ModelRef, bool) {
	ref, ok := s.resolveCheapModel(ctx, primary)
	if ok {
		return ref, true
	}
	if s.cheapModelDisabled() || !s.providersReadyNow() {
		return core.ModelRef{}, false
	}
	s.cheapModelNoticeOnce.Do(func() {
		jlog.Error("no cheap model resolvable for out-of-band tasks; announcing once")
		serverBroadcaster{srv: s}.BroadcastNotice(noCheapModelNotice)
	})
	return core.ModelRef{}, false
}

// cheapModelDisabled reports whether the user explicitly turned the cheap model
// off. A store that cannot be read is treated as not-off: the nudge is the
// recoverable answer, where silence would hide both the missing model and the
// unreadable file.
func (s *Server) cheapModelDisabled() bool {
	if s.cheapModelStore == nil {
		return false
	}
	stored, err := s.cheapModelStore.Load()
	return err == nil && stored.Disabled
}

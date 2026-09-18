//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"time"
)

// The rate-limit latch: what one thread learns about an account-level usage cap,
// the rest of the conversation is spared having to find out.
//
// A usage cap is a fact about the account, not about the request — so it stands
// over every thread on that provider at once. Without the latch each live thread
// discovers it separately: a root turn and five delegated children each spend
// their retries against a limit none of them can clear, which is eighteen
// requests charged to the window the user is waiting for, and twelve error items
// saying the same sentence.
//
// Three rules keep it honest:
//
//   - Only a STATED reset latches. A wait nobody supplied is a guess
//     (defaultRetryWait), and a guess must not stop a conversation.
//   - It expires by itself, on read. There is no timer and nothing to re-tickle
//     the reducer when the cap lifts: threads held here are at rest, and the
//     user's next message is what starts the conversation again.
//   - A user send lifts it. Typing into a capped conversation is an explicit
//     "try anyway", and it costs exactly one request to find out. It lifts
//     wherever it lands — a thread held by the cap rests without settling, so the
//     parent parked on it reads as busy, and the send the user makes is the one
//     into that parent. A lift only the idle path could reach would be a lift
//     this conversation never gets.
//
// Keyed by provider name, which is the granularity credentials are resolved at
// (server/llm_caller.go) and therefore the granularity a quota belongs to.
// Deliberately per-conversation and in memory only: it is an optimisation over
// finding out, never a source of truth about the account.

// latchRateLimit records that providerName is capped until the stated time, and
// reports whether this call was the one that discovered it. Only the discoverer
// reports the cap to the user; the threads behind it rest, so a conversation-wide
// refusal reads as one message rather than one per thread.
//
// A later, longer reset extends a standing hold — the provider has moved the
// wall, and the conversation follows it — but does not make that caller a
// discoverer.
func (w *ConversationWorker) latchRateLimit(providerName string, until time.Time) bool {
	if !until.After(time.Now()) {
		return false
	}
	discovered := false
	w.mutateRateLimits(func(next map[string]time.Time) bool {
		standing, held := next[providerName]
		discovered = !held || !standing.After(time.Now())
		if !discovered && !until.After(standing) {
			return false
		}
		next[providerName] = until
		return true
	})
	return discovered
}

// rateLimitedUntil returns when providerName's cap lifts, or the zero time when
// no cap stands over this conversation. An entry whose time has passed answers
// as no cap at all: the only moment the answer matters is when a thread is about
// to call, so expiry is read there rather than driven by a timer. The entry is
// left in place — a handful of provider names is not worth a write to prune.
func (w *ConversationWorker) rateLimitedUntil(providerName string) time.Time {
	holds := w.rateLimitHolds()
	if until, held := holds[providerName]; held && until.After(time.Now()) {
		return until
	}
	return time.Time{}
}

// rateLimitedModelConfig returns the model config of the thread about to call
// when a cap stands over its provider, and nil when the call may go ahead. The
// "any hold at all" test comes first because it is a pointer load, while
// resolving a thread's provider walks the document under the y-crdt lock — and
// the answer is "no cap" for every dispatch in a conversation that never meets
// one.
func (r *run) rateLimitedModelConfig(threadItemID string) *ModelConfig {
	if len(r.rateLimitHolds()) == 0 {
		return nil
	}
	mc := r.doc.ResolveEffectiveModelConfig(threadItemID)
	if mc == nil || r.rateLimitedUntil(mc.Provider).IsZero() {
		return nil
	}
	return mc
}

// liftRateLimitForSend lifts the cap standing over the thread a send is destined
// for, and reports whether it lifted one — which is also the answer to "was this
// conversation stopped by a cap until now", and therefore to "does anything need
// re-offering to the reducer".
//
// Resolving the thread's provider walks the document under the y-crdt lock, so
// it sits behind the same "any hold at all" pointer load rateLimitedModelConfig
// uses: the sends in a conversation that never meets a cap — very nearly all of
// them — pay one atomic read for this.
func (r *run) liftRateLimitForSend(threadItemID string) bool {
	if len(r.rateLimitHolds()) == 0 {
		return false
	}
	mc := r.doc.ResolveEffectiveModelConfig(threadItemID)
	if mc == nil || r.rateLimitedUntil(mc.Provider).IsZero() {
		return false
	}
	r.clearRateLimit(mc.Provider)
	return true
}

// clearRateLimit lifts providerName's cap. Called when the user sends into the
// conversation: they are asking us to try, and being told "no" by our own record
// of an old refusal is a worse answer than the provider's.
func (w *ConversationWorker) clearRateLimit(providerName string) {
	if w.rateLimitedUntil(providerName).IsZero() {
		return
	}
	w.mutateRateLimits(func(next map[string]time.Time) bool {
		delete(next, providerName)
		return true
	})
}

// rateLimitHolds returns the current holds. Never mutated in place, so the
// caller may hold it across anything.
func (w *ConversationWorker) rateLimitHolds() map[string]time.Time {
	if p := w.rateLimits.Load(); p != nil {
		return *p
	}
	return nil
}

// mutateRateLimits rewrites the holds copy-on-write under compare-and-swap,
// retrying when a racing thread got there first. edit reports whether it changed
// anything; a no-op publishes nothing. Unlike the polite-stop set this has no
// single writer to serialise it — the whole point is several threads meeting the
// same refusal at the same moment — so the loop is what decides which one of them
// wrote the hold that now stands.
func (w *ConversationWorker) mutateRateLimits(edit func(next map[string]time.Time) bool) {
	for {
		cur := w.rateLimits.Load()
		next := map[string]time.Time{}
		if cur != nil {
			for name, until := range *cur {
				next[name] = until
			}
		}
		if !edit(next) {
			return
		}
		if w.rateLimits.CompareAndSwap(cur, &next) {
			return
		}
	}
}

// rateLimitReport is what the user reads when a usage cap ends a turn: a lead
// that says which provider, how long, and until when, above the provider's own
// text — which is the only diagnosable part and is never dropped for the lead's
// convenience. The last clause is there because the alternative is a
// conversation that has gone quiet for reasons it never explains, and because
// the cap is ours to work around, not the user's to obey: sending again lifts it
// and costs one request to find out.
func rateLimitReport(providerName string, until, now time.Time, detail string) string {
	if providerName == "" {
		providerName = "The provider"
	}
	return fmt.Sprintf("%s has reached its usage limit. It resets %s, %s.\nNothing here will call it again until then — send again to try anyway.\n\n%s",
		providerName, approximateDuration(until.Sub(now)), formatResetTime(until, now), detail)
}

// formatResetTime renders when a cap lifts in the terms of whoever is reading:
// the clock time, carrying the day only when it is not today's.
func formatResetTime(until, now time.Time) string {
	clock := until.Format("15:04")
	switch days := daysBetween(now, until); {
	case days <= 0:
		return "at " + clock
	case days == 1:
		return "tomorrow at " + clock
	default:
		return until.Format("on 2 Jan at ") + clock
	}
}

// daysBetween counts calendar days from now to until, so "tomorrow" means the
// next date rather than twenty-four hours away — 23:50 to 00:10 is twenty
// minutes and a different day, and the clock time alone would be ambiguous.
func daysBetween(now, until time.Time) int {
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	to := time.Date(until.Year(), until.Month(), until.Day(), 0, 0, 0, 0, until.Location())
	return int(to.Sub(from).Hours() / 24)
}

// approximateDuration is how long the wait is, rounded to what a person would
// say. The precise figure is already in the clock time beside it; what this
// answers is "is this worth waiting for", where four hours and four hours two
// minutes are the same answer.
func approximateDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "in under a minute"
	case d < 2*time.Minute:
		return "in about a minute"
	case d < 90*time.Minute:
		return fmt.Sprintf("in about %d minutes", int((d+30*time.Second)/time.Minute))
	case d < 36*time.Hour:
		return fmt.Sprintf("in about %d hours", int((d+30*time.Minute)/time.Hour))
	default:
		return fmt.Sprintf("in about %d days", int((d+12*time.Hour)/(24*time.Hour)))
	}
}

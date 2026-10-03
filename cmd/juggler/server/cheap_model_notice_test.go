//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// newCheapNoticeServer builds a resolve server with a live client hub and one
// registered viewer, so broadcasts can be read back.
func newCheapNoticeServer(t *testing.T, providers []ProviderStatus) (*Server, *WSClient) {
	t.Helper()
	s := newCheapResolveServer(t, providers)
	s.hub = newClientHub()
	viewer := testRoleClient("v1", ClientRoleViewer, "local")
	s.hub.register(viewer)
	return s, viewer
}

// countNotices drains everything the viewer has been sent and returns the
// notices among it. Registration itself broadcasts a clients-changed, so the
// stream is filtered by type rather than counted raw.
//
// The window is generous because a hub broadcast crosses two goroutine hops
// (the actor, then the client's mailbox): a test that reads immediately would
// report zero for a notice that is merely still in flight, and pass for the
// wrong reason.
func countNotices(t *testing.T, c *WSClient) int {
	t.Helper()
	notices := 0
	deadline := time.After(500 * time.Millisecond)
	for {
		select {
		case msg := <-c.send:
			m, ok := msg.json.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "notice" {
				notices++
			}
		case <-deadline:
			return notices
		}
	}
}

// unresolvableProviders is a single available provider that bills per token and
// advertises no cheap tier — the shape that leaves a micro-task with nothing to
// run on.
func unresolvableProviders() []ProviderStatus {
	return []ProviderStatus{
		{Name: "nohint", Available: true, ModelsWithContext: []ModelWithContext{{ID: "big"}}},
	}
}

// TestCheapModelNudgeFiresOnce is the balance the whole nudge rests on. A
// configuration gap affects EVERY micro-task, so announcing each one would put
// a toast on screen for every new conversation — which is exactly why this was
// previously announced not at all, and therefore never discovered. Once per
// run is the compromise: seen, and only once.
func TestCheapModelNudgeFiresOnce(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s, viewer := newCheapNoticeServer(t, unresolvableProviders())

	primary := core.ModelRef{Provider: "nohint", Model: "big"}
	for range 3 {
		if _, ok := s.cheapModelForTask(context.Background(), primary); ok {
			t.Fatal("expected no cheap model to resolve")
		}
	}

	if got := countNotices(t, viewer); got != 1 {
		t.Fatalf("notices = %d, want exactly 1 across three failed micro-tasks", got)
	}
}

// TestCheapModelNudgeWaitsForDiscovery: a lookup that stops waiting before the
// first provider refresh lands — its request cancelled, typically a client that
// aborted during startup — resolves against an empty list. That is "not known
// yet", not "none configured", so it must neither announce nor spend the run's
// single notice: once discovery completes, a genuine gap is still reported.
func TestCheapModelNudgeWaitsForDiscovery(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s, viewer := newCheapNoticeServer(t, unresolvableProviders())
	s.providersReady = make(chan struct{}) // reopen the startup window

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	primary := core.ModelRef{Provider: "nohint", Model: "big"}
	if _, ok := s.cheapModelForTask(ctx, primary); ok {
		t.Fatal("expected no cheap model before discovery")
	}
	if got := countNotices(t, viewer); got != 0 {
		t.Fatalf("notices = %d, want 0 before the first provider refresh completed", got)
	}

	close(s.providersReady) // markProvidersReady's Once was spent by the constructor
	if _, ok := s.cheapModelForTask(context.Background(), primary); ok {
		t.Fatal("expected no cheap model to resolve")
	}
	if got := countNotices(t, viewer); got != 1 {
		t.Fatalf("notices = %d, want 1 once discovery confirmed the gap", got)
	}
}

// TestCheapModelNudgeRespectsOff: having answered the question, the user is not
// asked it again. Without this the off switch would be worse than useless — it
// would stop the tasks running AND keep nagging about their not running.
func TestCheapModelNudgeRespectsOff(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s, viewer := newCheapNoticeServer(t, unresolvableProviders())
	turnCheapOff(t, s)

	primary := core.ModelRef{Provider: "nohint", Model: "big"}
	if _, ok := s.cheapModelForTask(context.Background(), primary); ok {
		t.Fatal("expected no cheap model while off")
	}

	if got := countNotices(t, viewer); got != 0 {
		t.Fatalf("notices = %d, want 0 when the user turned the cheap model off", got)
	}
}

// TestCheapModelNudgeStaysQuietWhenItResolves guards the ordinary case: nothing
// is wrong, so nothing is said.
func TestCheapModelNudgeStaysQuietWhenItResolves(t *testing.T) {
	registerCheapTestProvider("cheaptest", "cheap-mini")
	s, viewer := newCheapNoticeServer(t, []ProviderStatus{
		{Name: "cheaptest", Available: true, ModelsWithContext: []ModelWithContext{{ID: "cheap-mini"}, {ID: "big"}}},
	})

	if _, ok := s.cheapModelForTask(context.Background(), core.ModelRef{Provider: "cheaptest", Model: "big"}); !ok {
		t.Fatal("expected the cheap model to resolve")
	}

	if got := countNotices(t, viewer); got != 0 {
		t.Fatalf("notices = %d, want 0 when a cheap model resolved", got)
	}
}

// TestReadingTheSettingDoesNotNudge: GET /api/cheap-model resolves the same
// question, but the person asking it is looking at the setting. Telling them to
// go and set it would be the app talking over itself, and it would also burn
// the one nudge a run gets on someone already in the right place.
func TestReadingTheSettingDoesNotNudge(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s, viewer := newCheapNoticeServer(t, unresolvableProviders())

	rec := httptest.NewRecorder()
	s.handleCheapModel(rec, httptest.NewRequest(http.MethodGet, "/api/cheap-model", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/cheap-model = %d, want 200", rec.Code)
	}

	if got := countNotices(t, viewer); got != 0 {
		t.Fatalf("notices = %d, want 0 — reading the setting must not nudge about it", got)
	}
}

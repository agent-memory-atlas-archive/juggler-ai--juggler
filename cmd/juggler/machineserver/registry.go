//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"time"
)

// SessionState is the lifecycle state of a session child in the registry.
type SessionState string

const (
	// SessionStarting: reserved in the registry, child spawn in progress.
	SessionStarting SessionState = "starting"
	// SessionRunning: child is up and its address is proxyable.
	SessionRunning SessionState = "running"
	// SessionStopping: a stop was requested; the child is being torn down.
	SessionStopping SessionState = "stopping"
	// SessionError: the child failed to start or exited unexpectedly.
	SessionError SessionState = "error"
)

// Session is the public registry record for one session child, as served by
// the control API.
type Session struct {
	ID        string       `json:"id"`
	Project   string       `json:"project"`
	Addr      string       `json:"addr,omitempty"`
	PID       int          `json:"pid,omitempty"`
	State     SessionState `json:"state"`
	Error     string       `json:"error,omitempty"`
	StartedAt time.Time    `json:"startedAt"`
	// Busy and LastActive come from polling the child (see pollActivity), so
	// both trail the child by up to activityPollInterval, and a turn that
	// starts and ends between two polls is never seen.
	//
	// Busy is what the latest successful poll reported: a turn is running,
	// not merely parked on a tool approval.
	Busy bool `json:"busy"`
	// LastActive is the time of the latest poll that found the child busy;
	// absent when no poll has.
	LastActive *time.Time `json:"lastActive,omitempty"`
}

// sessionEntry pairs the public record with the live child handle.
type sessionEntry struct {
	Session
	child *child
}

// registry is the actor owning the session table. All access is serialized
// through the ops channel — no locks. It lives for the process lifetime.
type registry struct {
	ops chan func(map[string]*sessionEntry)
}

func newRegistry() *registry {
	r := &registry{ops: make(chan func(map[string]*sessionEntry))}
	go func() {
		m := make(map[string]*sessionEntry)
		for fn := range r.ops {
			fn(m)
		}
	}()
	return r
}

// do runs fn inside the actor and returns after it completes.
func (r *registry) do(fn func(map[string]*sessionEntry)) {
	done := make(chan struct{})
	r.ops <- func(m map[string]*sessionEntry) {
		fn(m)
		close(done)
	}
	<-done
}

// snapshot returns a copy of every session, oldest first.
func (r *registry) snapshot() []Session {
	out := make([]Session, 0)
	r.do(func(m map[string]*sessionEntry) {
		for _, e := range m {
			out = append(out, e.Session)
		}
	})
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// get returns the public record for id.
func (r *registry) get(id string) (Session, bool) {
	var s Session
	var ok bool
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found {
			s, ok = e.Session, true
		}
	})
	return s, ok
}

// route returns the public record for id together with its live child's
// ingress secret ("" with no live child) — what the proxy needs to forward a
// request. The secret stays out of Session so it can never be served.
func (r *registry) route(id string) (s Session, secret string, ok bool) {
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found {
			s, ok = e.Session, true
			if e.child != nil {
				secret = e.child.ingressSecret
			}
		}
	})
	return s, secret, ok
}

// reserve returns the live session for project when one exists (any state but
// error — an errored entry is replaced), else inserts a starting entry with a
// fresh ID. created reports whether the caller now owns the spawn.
func (r *registry) reserve(project string) (s Session, created bool) {
	id := newSessionID()
	r.do(func(m map[string]*sessionEntry) {
		for key, e := range m {
			if e.Project != project {
				continue
			}
			if e.State == SessionError {
				delete(m, key)
				continue
			}
			s = e.Session
			return
		}
		e := &sessionEntry{Session: Session{
			ID:        id,
			Project:   project,
			State:     SessionStarting,
			StartedAt: time.Now(),
		}}
		m[id] = e
		s, created = e.Session, true
	})
	return s, created
}

// setRunning records a successful spawn: address, pid, and the child handle.
// Returns false when the reservation no longer exists — the caller then owns
// stopping the just-spawned child rather than leaking it unsupervised.
func (r *registry) setRunning(id string, c *child, pid int) bool {
	var ok bool
	r.do(func(m map[string]*sessionEntry) {
		e, found := m[id]
		if !found {
			return
		}
		e.State = SessionRunning
		e.Addr = c.addr
		e.PID = pid
		e.child = c
		ok = true
	})
	return ok
}

// setError records a failed spawn (or supervisor-observed failure).
func (r *registry) setError(id, msg string) {
	r.do(func(m map[string]*sessionEntry) {
		if e, ok := m[id]; ok {
			e.State = SessionError
			e.Error = msg
			e.Addr = ""
			e.PID = 0
			e.Busy = false
			e.child = nil
		}
	})
}

// beginStop marks the session stopping and hands the caller the child to tear
// down. ok is false when the session doesn't exist or has no live child.
func (r *registry) beginStop(id string) (*child, bool) {
	var c *child
	r.do(func(m map[string]*sessionEntry) {
		if e, ok := m[id]; ok && e.child != nil && e.State == SessionRunning {
			e.State = SessionStopping
			c = e.child
		}
	})
	return c, c != nil
}

// remove drops the session from the registry.
func (r *registry) remove(id string) {
	r.do(func(m map[string]*sessionEntry) {
		delete(m, id)
	})
}

// noteExit records that a session child's process exited on its own (not via
// beginStop): the entry flips to error so the control API surfaces the crash.
// A stopping entry is left alone — its stopper removes it.
func (r *registry) noteExit(id string) {
	r.do(func(m map[string]*sessionEntry) {
		if e, ok := m[id]; ok && e.State != SessionStopping {
			e.State = SessionError
			e.Error = "session child exited"
			e.Addr = ""
			e.PID = 0
			e.Busy = false
			e.child = nil
		}
	})
}

// newSessionID returns a short random hex ID for a session.
func newSessionID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("newSessionID: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

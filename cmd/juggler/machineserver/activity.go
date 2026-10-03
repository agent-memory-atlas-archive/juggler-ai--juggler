//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"juggler/internal/apipaths"
)

// activityPollInterval is how often each session child is asked whether a
// turn is running.
const activityPollInterval = 2 * time.Second

// activityHTTP asks children for their activity. Its timeout keeps one stuck
// child from stalling its poller past a couple of intervals.
var activityHTTP = &http.Client{Timeout: activityPollInterval}

// pollActivity asks c, every interval, whether it is running a turn and
// records the answer on session id (Session.Busy, Session.LastActive). It
// returns when c exits. A poll that fails records nothing: an unreachable
// child is either gone — which noteExit records — or stuck, and a stuck child
// stays whatever it was last seen to be rather than turning idle under a turn.
func (s *Server) pollActivity(id string, c *child, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-c.exited:
			return
		case <-tick.C:
		}
		busy, err := childBusy(c.addr)
		if err != nil {
			continue
		}
		s.reg.setActivity(id, c, busy, time.Now())
	}
}

// childBusy reports whether the child at addr is running a turn, from its
// GET /api/health/active (token-exempt, so the supervisor needs no token).
func childBusy(addr string) (bool, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://"+addr+apipaths.HealthActive, nil)
	if err != nil {
		return false, err
	}
	resp, err := activityHTTP.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("%s: status %d", apipaths.HealthActive, resp.StatusCode)
	}
	var body struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, err
	}
	return body.Active, nil
}

// setActivity records one activity poll of child c on session id: busy, and
// when busy, at as its last activity. A poll of any child but the one the
// entry holds now — one that has crashed, or been replaced — is dropped.
func (r *registry) setActivity(id string, c *child, busy bool, at time.Time) {
	r.do(func(m map[string]*sessionEntry) {
		e, ok := m[id]
		if !ok || e.child != c {
			return
		}
		e.Busy = busy
		if busy {
			e.LastActive = &at
		}
	})
}

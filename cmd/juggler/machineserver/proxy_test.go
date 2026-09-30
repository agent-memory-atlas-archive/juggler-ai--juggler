//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// get performs a GET and returns (statusCode, body).
func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url) //nolint:gosec // test-local httptest URL
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, string(body)
}

func TestSessionProxyRoutesAndStripsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "path="+r.URL.Path)
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)

	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, body := get(t, front.URL+"/s/"+sess.ID+"/api/health"); code != http.StatusOK || body != "path=/api/health" {
		t.Fatalf("proxied request: code=%d body=%q", code, body)
	}
	// The session root proxies to the child's "/".
	if code, body := get(t, front.URL+"/s/"+sess.ID+"/"); code != http.StatusOK || body != "path=/" {
		t.Fatalf("session root: code=%d body=%q", code, body)
	}
	// A bare /s/<id> redirects to /s/<id>/ (the default client follows it).
	if code, body := get(t, front.URL+"/s/"+sess.ID); code != http.StatusOK || body != "path=/" {
		t.Fatalf("bare session path: code=%d body=%q", code, body)
	}
}

// TestSessionProxyForwardsPrefix checks the child is told the prefix it is
// being served under, and that a client cannot choose it: a forged
// X-Forwarded-Prefix is replaced, not passed on.
func TestSessionProxyForwardsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values("X-Forwarded-Prefix"), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/s/"+sess.ID+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Prefix", "/evil")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if got, want := string(body), "/s/"+sess.ID; got != want {
		t.Fatalf("child saw X-Forwarded-Prefix %q, want %q", got, want)
	}
}

func TestSessionProxyRejectsUnknownAndNotRunning(t *testing.T) {
	s := &Server{reg: newRegistry()}
	starting, _ := s.reg.reserve("/p")

	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, _ := get(t, front.URL+"/s/nope/anything"); code != http.StatusNotFound {
		t.Fatalf("unknown session: code=%d, want 404", code)
	}
	if code, _ := get(t, front.URL+"/s/"+starting.ID+"/anything"); code != http.StatusServiceUnavailable {
		t.Fatalf("starting session: code=%d, want 503", code)
	}
}

func TestOriginGuardRejectsCrossOrigin(t *testing.T) {
	s := &Server{reg: newRegistry()}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/api/server/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin request: code=%d, want 403", resp.StatusCode)
	}

	// Same-origin passes.
	req2, err := http.NewRequest("GET", front.URL+"/api/server/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req2.Header.Set("Origin", front.URL)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("same-origin request: code=%d, want 200", resp2.StatusCode)
	}
}

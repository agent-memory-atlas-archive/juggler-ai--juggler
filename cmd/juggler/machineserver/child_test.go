//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"

	"juggler/internal/ingress"
)

// helperChildEnv marks a run of this test binary as a stand-in session child
// (see TestHelperSessionChild).
const helperChildEnv = "JUGGLER_MACHINESERVER_HELPER_CHILD"

// TestHelperSessionChild is not a test: it is the session child that
// spawnHelperChildren execs, this test binary run again with helperChildEnv
// set. It does what a child must for spawnChild — prints JUGGLER_ADDR= once it
// is listening — and answers every request with the ingress secret its
// environment gave it and the ingress header the request carried.
func TestHelperSessionChild(t *testing.T) {
	if os.Getenv(helperChildEnv) != "1" {
		t.Skip("run only as the stand-in session child")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(1)
	}
	fmt.Printf("JUGGLER_ADDR=%s\n", ln.Addr())
	_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(helperReport{
			EnvSecret: os.Getenv(ingress.SecretEnv),
			Header:    r.Header.Get(ingress.Header),
		})
	}))
	os.Exit(0)
}

// helperReport is what the stand-in child answers.
type helperReport struct {
	EnvSecret string `json:"envSecret"`
	Header    string `json:"header"`
}

// spawnHelperChildren spawns n stand-in session children through spawnChild,
// stopped when the test ends.
func spawnHelperChildren(t *testing.T, n int) []*child {
	t.Helper()
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	// An ingress secret in the supervisor's own environment must not reach a
	// child in place of the one spawnChild mints for it.
	t.Setenv(ingress.SecretEnv, "the-supervisor-s-own")
	orig := newChildCommand
	newChildCommand = func(string, string, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSessionChild$") //nolint:gosec // this test binary
		cmd.Env = append(os.Environ(), helperChildEnv+"=1")
		return cmd
	}
	t.Cleanup(func() { newChildCommand = orig })

	out := make([]*child, n)
	for i := range out {
		c, err := spawnChild("unused", t.TempDir(), nil)
		if err != nil {
			t.Fatalf("spawn stand-in child: %v", err)
		}
		t.Cleanup(c.stop)
		out[i] = c
	}
	return out
}

// fetchReport GETs url and decodes the stand-in child's report.
func fetchReport(t *testing.T, url string) helperReport {
	t.Helper()
	code, body := get(t, url)
	if code != http.StatusOK {
		t.Fatalf("GET %s: status %d: %s", url, code, body)
	}
	var rep helperReport
	if err := json.Unmarshal([]byte(body), &rep); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return rep
}

// TestSpawnedChildGetsItsOwnIngressSecret runs the supervisor's whole half of
// caller identity against real processes: spawnChild hands each child a
// secret of its own in its environment, and a remote caller's request through
// the proxy reaches that child carrying exactly that secret.
func TestSpawnedChildGetsItsOwnIngressSecret(t *testing.T) {
	children := spawnHelperChildren(t, 2)

	first := fetchReport(t, "http://"+children[0].addr+"/")
	second := fetchReport(t, "http://"+children[1].addr+"/")
	if first.EnvSecret == "" || first.EnvSecret == second.EnvSecret || first.EnvSecret == "the-supervisor-s-own" {
		t.Fatalf("children were spawned with secrets %q and %q, want two fresh distinct ones", first.EnvSecret, second.EnvSecret)
	}
	if first.EnvSecret != children[0].ingressSecret {
		t.Fatalf("child's environment has %q, but the supervisor holds %q for it", first.EnvSecret, children[0].ingressSecret)
	}

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, children[0], children[0].cmd.Process.Pid)
	front := httptest.NewServer(asCaller("203.0.113.7:54321", s.routes()))
	defer front.Close()

	if got := fetchReport(t, front.URL+"/s/"+sess.ID+"/"); got.Header != first.EnvSecret {
		t.Fatalf("remote caller through the proxy: child saw %s %q, want its own secret %q", ingress.Header, got.Header, first.EnvSecret)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"

	"juggler/internal/ingress"
)

// TestSupervisorIngressHeader checks the child's half of caller identity: only
// its supervisor's secret, arriving over loopback, tags a request as remote
// ingress, and the header never reaches a handler, honoured or not.
func TestSupervisorIngressHeader(t *testing.T) {
	cases := []struct {
		name, secret, header, remoteAddr string
		wantKind                         string
	}{
		{"the supervisor's secret", "right", "right", "127.0.0.1:5000", supervisorIngressKind},
		{"another secret", "right", "wrong", "127.0.0.1:5000", ""},
		{"a prefix of the secret", "right", "righ", "127.0.0.1:5000", ""},
		{"no header", "right", "", "127.0.0.1:5000", ""},
		{"the secret from off loopback", "right", "right", remoteEdgeAddr, ""},
		{"a server with no supervisor", "", "anything", "127.0.0.1:5000", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gotKind, gotHeader string
			reached := false
			s := &Server{router: mux.NewRouter(), ingressSecret: c.secret}
			s.router.Use(s.supervisorIngressMiddleware)
			s.router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				reached = true
				gotKind = RemoteIngressKind(r)
				gotHeader = r.Header.Get(ingress.Header)
			})
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = c.remoteAddr
			if c.header != "" {
				req.Header.Set(ingress.Header, c.header)
			}
			s.router.ServeHTTP(httptest.NewRecorder(), req)
			if !reached {
				t.Fatal("request never reached the handler")
			}
			if gotKind != c.wantKind {
				t.Errorf("remote-ingress kind = %q, want %q", gotKind, c.wantKind)
			}
			if gotHeader != "" {
				t.Errorf("handler saw %s %q, want it stripped", ingress.Header, gotHeader)
			}
		})
	}
}

// TestSupervisorIngressIsRemote pins what the tag means downstream: a request
// the supervisor vouched for is neither local-direct nor allowed the engine
// role, though it arrives over loopback.
func TestSupervisorIngressIsRemote(t *testing.T) {
	r := MarkRemoteIngress(httptest.NewRequest(http.MethodGet, "/api/ws?role=engine", nil), supervisorIngressKind)
	r.RemoteAddr = "127.0.0.1:5000"
	if isLocalDirect(r) || engineRoleAllowed(r) {
		t.Fatalf("supervisor ingress: isLocalDirect=%v engineRoleAllowed=%v, want both false", isLocalDirect(r), engineRoleAllowed(r))
	}
	if got := clientInfoFromRequest(r); got.Origin != "remote" || got.Detail != "Via machine server" {
		t.Fatalf("client info = %+v, want a remote client via the machine server", got)
	}
}

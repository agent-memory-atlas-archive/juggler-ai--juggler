//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/gorilla/mux"

	"juggler/internal/ingress"
)

// handleSessionProxy reverse-proxies /s/<id>/… to the owning session child.
// Clients only ever see the machine server's address; child ports stay
// loopback-internal. WebSocket upgrades pass through via the standard
// ReverseProxy switching-protocols support.
//
// Every proxied request reaches the child from here, over loopback, so the
// child cannot tell its callers apart by address. The proxy tells it instead:
// a caller off loopback is forwarded with the child's ingress secret
// (internal/ingress), which the child turns into its remote-ingress tag — so
// such a caller cannot take the engine slot or pass for a local viewer.
func (s *Server) handleSessionProxy(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	sess, secret, ok := s.reg.route(id)
	if !ok {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	if sess.State != SessionRunning || sess.Addr == "" {
		http.Error(w, "session is not running (state: "+string(sess.State)+")", http.StatusServiceUnavailable)
		return
	}
	remote := callerIsRemote(r)
	if remote && secret == "" {
		// Forwarded untagged, a remote caller would look local to the child.
		http.Error(w, "session cannot identify a remote caller", http.StatusBadGateway)
		return
	}

	target := &url.URL{Scheme: "http", Host: sess.Addr}
	prefix := "/s/" + id
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Strip the session prefix: the child serves the same tree it
			// would serve standalone.
			path := strings.TrimPrefix(pr.In.URL.Path, prefix)
			if path == "" {
				path = "/"
			}
			pr.Out.URL.Path = path
			pr.Out.URL.RawPath = ""
			// Preserve the client-facing Host: the child's same-origin check
			// compares a browser's Origin (the machine server's address)
			// against the Host header, so rewriting it to the child's
			// loopback address would reject every proxied WebSocket upgrade.
			pr.Out.Host = pr.In.Host
			// Tell the child where it is mounted, so the pages it serves
			// address it through this proxy (the child's requestBasePath).
			// Set, never appended: a client's own value must not reach it.
			pr.Out.Header.Set("X-Forwarded-Prefix", prefix)
			// Only this proxy speaks for the caller: a client's own ingress
			// header is dropped whoever sent it.
			pr.Out.Header.Del(ingress.Header)
			if remote {
				pr.Out.Header.Set(ingress.Header, secret)
			}
		},
		// Flush streamed responses immediately — the UI relies on
		// incremental delivery, not just WebSocket frames.
		FlushInterval: -1,
	}
	proxy.ServeHTTP(w, r)
}

// callerIsRemote reports whether a request reached this server from anywhere
// but loopback. An address that does not parse counts as remote, so a doubt
// costs the caller local trust rather than granting it.
func callerIsRemote(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return true
	}
	ip := net.ParseIP(host)
	return ip == nil || !ip.IsLoopback()
}

// redirectSession normalizes a bare /s/<id> to /s/<id>/ so the child sees "/"
// and relative asset URLs resolve under the session prefix. The target is
// rebuilt from the escaped id — never the raw request path — so it can only
// ever be a local session path.
func (s *Server) redirectSession(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/s/"+url.PathEscape(mux.Vars(r)["id"])+"/", http.StatusMovedPermanently)
}

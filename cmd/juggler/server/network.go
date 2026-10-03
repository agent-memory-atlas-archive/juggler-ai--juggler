//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/ingress"
)

// PrintSessionInfo prints a prominent box with the server URL and optional
// extra lines (e.g. interactive key hints).
func (s *Server) PrintSessionInfo(extraLines ...string) {
	content := fmt.Sprintf("http://%s/", s.addr)
	for _, line := range extraLines {
		content += "\n" + line
	}
	core.PrintProminentBox("JUGGLER IS RUNNING", content, core.ColorCyan)
}

// SetPublicMode enables or disables LAN access. When disabled (default), the
// lanGateMiddleware rejects connections from non-loopback IPs with 403.
func (s *Server) SetPublicMode(enabled bool) {
	s.publicMode.Store(enabled)
}

// IsPublicMode reports whether LAN access is currently enabled.
func (s *Server) IsPublicMode() bool {
	return s.publicMode.Load()
}

// isLoopbackAddr reports whether a "host:port" RemoteAddr originates from a
// loopback IP. Used to restrict the engine WS role to in-process callers.
func isLoopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isLocalDirect reports whether a request came from this machine over a plain
// loopback connection. Remote-ingress requests are excluded explicitly: remote
// transports reach the server over loopback too (an http-over-DataChannel
// dispatch, a tunnel forwarder hop, or a machine server's proxy), so the address
// alone would admit them.
func isLocalDirect(r *http.Request) bool {
	return isLoopbackAddr(r.RemoteAddr) && !isRemoteIngress(r)
}

// engineRoleAllowed reports whether a request may claim the engine WS role. The
// engine is the in-process WebView, reachable only over loopback. Remote-ingress
// requests are excluded explicitly — remote transports reach the server over
// loopback (an http-over-DataChannel dispatch, or a tunnel forwarder hop), so a
// remote guest could otherwise claim the engine slot.
func engineRoleAllowed(r *http.Request) bool {
	return isLocalDirect(r)
}

// localViewerOnly guards a write to this project's stored UI preferences (zoom,
// theme). Those describe how the desktop window on this machine is set up, so
// only a viewer on this machine may change them. A phone or laptop browsing in
// over the LAN or a tunnel is handed the stored values as its starting point but
// keeps its own preferences in its own localStorage — it reads the desktop's
// setup without redecorating it, and several remote devices no longer overwrite
// each other through one shared slot.
func localViewerOnly(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLocalDirect(r) {
			http.Error(w, "UI preferences are per-device: a remote viewer keeps its own",
				http.StatusForbidden)
			return
		}
		next(w, r)
	})
}

// lanGateMiddleware rejects non-loopback connections when public mode is off.
// Requests arriving over an explicitly-granted remote transport (an established
// WebRTC DataChannel, or a tunnel the user opened) are admitted regardless: each
// is the user's explicit grant of remote access (possession of an unguessable id
// plus a completed handshake, or an explicitly-started tunnel). They are
// identified by the remote-ingress context tag (see MarkRemoteIngress). The
// engine WS upgrade refuses the tag, so no remote transport can claim the
// in-process engine slot.
func (s *Server) lanGateMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.publicMode.Load() && !isRemoteIngress(r) {
			ip, _, err := net.SplitHostPort(r.RemoteAddr)
			if err == nil && !net.ParseIP(ip).IsLoopback() {
				writeLocalhostOnlyPage(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// supervisorIngressKind is the MarkRemoteIngress kind for a request the
// machine server forwarded from a caller off loopback.
const supervisorIngressKind = "machine-server"

// supervisorIngressMiddleware is a session child's half of the caller-identity
// handshake with its machine server (internal/ingress). The supervisor reaches
// the child over loopback for every caller, so it vouches for a caller off
// loopback with the secret it spawned the child with, and this tags that
// request as remote ingress: from then on the engine role refuses it and
// localViewerOnly treats it as remote, exactly as for a tunnel or data-channel
// guest. Anything else — another value, a server spawned with no secret, a
// connection that is not loopback, so cannot be the supervisor's — leaves the
// request untagged. The header is removed either way, so nothing downstream
// can read the secret back.
func (s *Server) supervisorIngressMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(ingress.Header)
		r.Header.Del(ingress.Header)
		if s.ingressSecret != "" && got != "" && isLoopbackAddr(r.RemoteAddr) &&
			subtle.ConstantTimeCompare([]byte(got), []byte(s.ingressSecret)) == 1 {
			r = MarkRemoteIngress(r, supervisorIngressKind)
		}
		next.ServeHTTP(w, r)
	})
}

// writeLocalhostOnlyPage renders the 403 page shown when a non-loopback client
// hits a server whose public (LAN) mode is off. Styled, centred, and responsive
// so it reads cleanly on a phone; inline CSS only (the served CSP allows
// 'unsafe-inline' for style but no remote fonts, so it uses a system stack).
func writeLocalhostOnlyPage(w http.ResponseWriter) {
	const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Juggler — localhost only</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(1.25rem, 5vw, 3rem);
  }
  .card {
    width: 100%;
    max-width: 34rem;
    text-align: center;
  }
  .mark {
    font-size: clamp(1.6rem, 6vw, 2.25rem);
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 1.75rem;
  }
  h1 {
    font-size: clamp(1.25rem, 4.5vw, 1.5rem);
    font-weight: 600;
    margin: 0 0 1rem;
    line-height: 1.25;
  }
  p {
    font-size: clamp(0.95rem, 3.6vw, 1.0625rem);
    line-height: 1.6;
    margin: 0 0 1rem;
    color: #c9d1d9;
  }
  p:last-of-type { margin-bottom: 0; }
  code, kbd {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.9em;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 0.1em 0.4em;
    color: #e6edf3;
  }
  kbd { box-shadow: 0 1px 0 #30363d; }
  .steps {
    text-align: left;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: clamp(1rem, 4vw, 1.5rem);
    margin: 1.75rem 0 0;
  }
  .steps h2 {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b949e;
    margin: 0 0 0.85rem;
  }
  .steps ol {
    margin: 0;
    padding-left: 1.25rem;
    color: #c9d1d9;
    font-size: clamp(0.9rem, 3.5vw, 1rem);
    line-height: 1.6;
  }
  .steps li { margin-bottom: 0.5rem; }
  .steps li:last-child { margin-bottom: 0; }
  .steps li::marker { color: #58a6ff; font-weight: 600; }
</style>
</head>
<body>
  <main class="card">
    <h1>This Juggler server is localhost-only</h1>
    <p>For security reasons, this server is only accepting connections from its local host machine.</p>
    <p>To let other devices on the same network connect, turn on LAN access:</p>
    <div class="steps">
      <h2>Enable LAN access</h2>
      <ol>
        <li>In Juggler, open <strong>Settings &rarr; Connectivity</strong> and start <strong>LAN access</strong>, or</li>
        <li>If you&rsquo;re running it in a terminal, press <kbd>p</kbd> + <kbd>enter</kbd>.</li>
      </ol>
    </div>
  </main>
</body>
</html>`

	setHTMLSecurityHeaders(w, generateCSPNonce())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(page))
}

// remoteIngressContextKey carries the MarkRemoteIngress kind on a request
// context. Private: taggers use MarkRemoteIngress, readers use RemoteIngressKind.
type remoteIngressContextKey struct{}

// MarkRemoteIngress returns r tagged as having arrived through an
// explicitly-granted remote-access transport of the given kind (a short
// transport name, e.g. "datachannel" or a tunnel mode). Remote transports reach
// the router indirectly — a synthetic http-over-DataChannel dispatch, or a
// tunnel forwarder's loopback hop — so such requests look loopback by
// RemoteAddr, and the tag, not the address, is what identifies them:
// lanGateMiddleware and hostAllowed honour it to admit traffic the user
// explicitly granted remote access, while engineRoleAllowed and the engine WS
// upgrade refuse it so a remote client can never claim the in-process engine
// slot. Exported so external tunnel providers can tag their ingress.
func MarkRemoteIngress(r *http.Request, kind string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), remoteIngressContextKey{}, kind))
}

// RemoteIngressKind returns the transport kind the request was tagged with by
// MarkRemoteIngress, or "" for a direct connection.
func RemoteIngressKind(r *http.Request) string {
	v, _ := r.Context().Value(remoteIngressContextKey{}).(string)
	return v
}

// isRemoteIngress reports whether the request arrived over an explicitly-granted
// remote-access transport (see MarkRemoteIngress).
func isRemoteIngress(r *http.Request) bool {
	return RemoteIngressKind(r) != ""
}

// clientInfoFromRequest derives display metadata for a client from the request
// that opened its connection: how it reached us (local / LAN / remote transport),
// a human detail (LAN IP, or the transport label), its User-Agent, and now as the
// connect time. Presentational only.
func clientInfoFromRequest(r *http.Request) ClientInfo {
	info := ClientInfo{UserAgent: r.UserAgent(), ConnectedAt: time.Now().UnixMilli()}
	if kind := RemoteIngressKind(r); kind != "" {
		info.Origin = "remote"
		info.Detail = remoteTransportLabel(kind)
		return info
	}
	if isLoopbackAddr(r.RemoteAddr) {
		info.Origin = "local"
		return info
	}
	info.Origin = "lan"
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		info.Detail = host
	}
	return info
}

// maxViewerIDLen bounds a caller-supplied viewer id. The ids Juggler mints are
// 34 characters; the cap is what keeps an arbitrary client from parking a large
// string in every other viewer's clients-changed payload.
const maxViewerIDLen = 64

// sanitiseViewerID accepts a viewer's own identity, or returns empty. The id is
// chosen by the client and relayed verbatim to the other viewers sharing the
// session, so it is held to an unambiguous alphabet rather than trusted: nothing
// here may need escaping downstream, and an id that arrives malformed addresses
// nothing rather than addressing something else.
func sanitiseViewerID(id string) string {
	if id == "" || len(id) > maxViewerIDLen {
		return ""
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return ""
		}
	}
	return id
}

// remoteTransportLabel turns a remote-ingress kind (see MarkRemoteIngress) into a
// short human label: the WebRTC data channel, or a registered tunnel mode's
// title, falling back to the raw kind for anything unrecognised.
func remoteTransportLabel(kind string) string {
	if kind == dataChannelIngressKind {
		return "Peer-to-peer"
	}
	if kind == supervisorIngressKind {
		return "Via machine server"
	}
	if spec, ok := findTunnelMode(TunnelMode(kind)); ok {
		return spec.Title
	}
	return kind
}

// lanAddress is a reachable LAN address (IPv4 or IPv6) together with the name of
// the network interface it belongs to, so each can be labelled when several
// exist.
type lanAddress struct {
	iface string
	ip    string
}

// getLANAddresses returns reachable addresses of active non-loopback network
// interfaces, each tagged with its interface name. Both IPv4 and IPv6 global /
// unique-local unicast addresses are included; loopback, link-local (needs a
// zone to be usable), and multicast addresses are skipped. IPv4 addresses are
// listed before IPv6 so the primary, most-broadly-reachable URL comes first.
func getLANAddresses() []lanAddress {
	var v4, v6 []lanAddress
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		ifAddrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range ifAddrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
				ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
				continue
			}
			if ip4 := ip.To4(); ip4 != nil {
				v4 = append(v4, lanAddress{iface: iface.Name, ip: ip4.String()})
			} else {
				v6 = append(v6, lanAddress{iface: iface.Name, ip: ip.String()})
			}
		}
	}
	return append(v4, v6...)
}

// PrintLANStatus prints the LAN access status box and, when enabled, QR codes
// for each detected LAN address.
func (s *Server) PrintLANStatus(enabled bool) {
	_, port, _ := net.SplitHostPort(s.addr)
	if !enabled {
		core.PrintProminentBox("LAN ACCESS DISABLED", "Server is now localhost-only", core.ColorYellow)
		return
	}
	lanAddrs := getLANAddresses()
	if len(lanAddrs) == 0 {
		core.PrintProminentBox("LAN ACCESS ENABLED", "(no LAN interfaces detected)", core.ColorGreen)
		return
	}
	multi := len(lanAddrs) > 1
	var content string
	for i, a := range lanAddrs {
		if i > 0 {
			content += "\n"
		}
		url := fmt.Sprintf("http://%s/", net.JoinHostPort(a.ip, port))
		// Prefix each URL with its interface name when there is more than one, so
		// the labelled QR codes below can be matched back to a line here.
		if multi {
			content += fmt.Sprintf("%s:  %s", a.iface, url)
		} else {
			content += url
		}
	}
	content += "\n\n⚠  No password — anyone on your network can drive this agent\n   (it runs commands and edits files). Press 'p' to restrict to localhost."
	core.PrintProminentBox("LAN ACCESS ENABLED", content, core.ColorGreen)
	for _, a := range lanAddrs {
		url := fmt.Sprintf("http://%s/", net.JoinHostPort(a.ip, port))
		// With several networks, caption each code so it is unambiguous which
		// network it connects to; a lone network needs no caption.
		if multi {
			core.PrintLabeledQRCode(fmt.Sprintf("%s — %s", a.iface, url), url)
		} else {
			core.PrintQRCode(url)
		}
	}
}

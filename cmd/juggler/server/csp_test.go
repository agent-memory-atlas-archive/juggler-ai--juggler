//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// directive returns the one CSP directive starting with name, or "".
func directive(csp, name string) string {
	for _, part := range strings.Split(csp, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, name+" ") || part == name {
			return part
		}
	}
	return ""
}

// An extension may frame a local dev server — that is what makes an embedded
// live view (a Cmajor patch GUI, a docs preview) possible at all — and may not
// frame anything further afield.
//
// Asserted as the whole directive rather than as a search for the origins it
// should contain, because the interesting failure is an origin nobody meant to
// add: a containment check passes just as happily with `https://evil.example`
// on the end of the list.
func TestHTMLCSPFramesLoopbackOnly(t *testing.T) {
	const wantFrameSrc = "frame-src 'self' " +
		"http://127.0.0.1:* http://localhost:* http://[::1]:* " +
		"https://127.0.0.1:* https://localhost:* https://[::1]:*"

	rec := httptest.NewRecorder()
	setHTMLSecurityHeaders(rec, "test-nonce")

	csp := rec.Header().Get("Content-Security-Policy")
	if got := directive(csp, "frame-src"); got != wantFrameSrc {
		t.Errorf("frame-src = %q, want %q", got, wantFrameSrc)
	}
}

// A <video>/<audio> plays from the file content route, or — for a file outside
// the project, which that route refuses — from a blob: of its bytes. Without
// blob: here the second case silently plays nothing; nothing further is allowed.
func TestHTMLCSPMediaFromSelfAndBlob(t *testing.T) {
	rec := httptest.NewRecorder()
	setHTMLSecurityHeaders(rec, "test-nonce")

	csp := rec.Header().Get("Content-Security-Policy")
	if got := directive(csp, "media-src"); got != "media-src 'self' blob:" {
		t.Errorf("media-src = %q, want media-src 'self' blob:", got)
	}
}

// Widening what the page may frame must not widen what may frame the page.
func TestHTMLCSPFrameAncestorsStillNone(t *testing.T) {
	rec := httptest.NewRecorder()
	setHTMLSecurityHeaders(rec, "test-nonce")

	csp := rec.Header().Get("Content-Security-Policy")
	if got := directive(csp, "frame-ancestors"); got != "frame-ancestors 'none'" {
		t.Errorf("frame-ancestors = %q, want frame-ancestors 'none'", got)
	}
}

// The headless-test host page tiles copies of itself, so it — and only it —
// relaxes frame-ancestors to 'self'.
func TestHTMLCSPFramedVariantAllowsSelfAncestor(t *testing.T) {
	rec := httptest.NewRecorder()
	setHTMLSecurityHeadersFramed(rec, "test-nonce", true, "")

	csp := rec.Header().Get("Content-Security-Policy")
	if got := directive(csp, "frame-ancestors"); got != "frame-ancestors 'self'" {
		t.Errorf("frame-ancestors = %q, want frame-ancestors 'self'", got)
	}
}

// The sandbox is a different promise from the app page: it denies by default and
// must not have picked up the app page's framing permission.
func TestSandboxCSPFramesNothing(t *testing.T) {
	rec := httptest.NewRecorder()
	setSandboxSecurityHeaders(rec, "test-nonce", "http://127.0.0.1:3939")

	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.HasPrefix(csp, "default-src 'none'") {
		t.Errorf("sandbox CSP no longer denies by default: %s", csp)
	}
	if got := directive(csp, "frame-src"); got != "" {
		t.Errorf("sandbox gained a frame-src it does not need: %s", got)
	}
}

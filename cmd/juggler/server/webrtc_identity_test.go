//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pion/webrtc/v4"
)

// fingerprintOf returns the SHA-256 DTLS fingerprint value of a certificate,
// failing the test if it cannot be derived.
func fingerprintOf(t *testing.T, cert *webrtc.Certificate) string {
	t.Helper()
	fps, err := cert.GetFingerprints()
	if err != nil || len(fps) == 0 {
		t.Fatalf("GetFingerprints: %v (n=%d)", err, len(fps))
	}
	return fps[0].Value
}

// TestWebRTCIdentityPersistsAndReloads is the core guarantee behind a stable
// Direct P2P link: minting an identity, then loading it again (as a restarted
// process would), yields the SAME fingerprint from a byte-identical file, and
// the file is owner-only because it holds a private key.
func TestWebRTCIdentityPersistsAndReloads(t *testing.T) {
	path := webRTCIdentityPath(t.TempDir())

	first, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("first load-or-create: %v", err)
	}
	fp1 := fingerprintOf(t, first)

	bytesAfterCreate, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read identity file: %v", err)
	}
	if len(bytesAfterCreate) == 0 {
		t.Fatal("identity file is empty after create")
	}

	// Owner-only permissions. File modes are a POSIX concept; skip on Windows.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat identity file: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("identity file perms = %o, want 0600", perm)
		}
	}

	// A second load — standing in for a process restart — must reuse the file
	// verbatim and reproduce the same fingerprint.
	second, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("second load-or-create: %v", err)
	}
	if fp2 := fingerprintOf(t, second); fp1 != fp2 {
		t.Fatalf("fingerprint changed across reload: %q -> %q", fp1, fp2)
	}

	bytesAfterReload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-read identity file: %v", err)
	}
	if string(bytesAfterCreate) != string(bytesAfterReload) {
		t.Fatal("identity file was rewritten on reload; must be reused verbatim")
	}
}

// TestWebRTCIdentityIsPerProject is the reason the identity lives in the
// project's .juggler dir rather than a machine-wide file: two projects on the
// same machine must get DISTINCT identities, so the several servers a user runs
// (one per project) present different fingerprints and stay distinguishable to a
// remote peer, instead of all colliding on one shared identity.
func TestWebRTCIdentityIsPerProject(t *testing.T) {
	a, err := loadOrCreateWebRTCCertificate(webRTCIdentityPath(t.TempDir()))
	if err != nil {
		t.Fatalf("project A load-or-create: %v", err)
	}
	b, err := loadOrCreateWebRTCCertificate(webRTCIdentityPath(t.TempDir()))
	if err != nil {
		t.Fatalf("project B load-or-create: %v", err)
	}
	if fpA, fpB := fingerprintOf(t, a), fingerprintOf(t, b); fpA == fpB {
		t.Fatalf("two projects share identity %q; must be per-project", fpA)
	}
}

// TestWebRTCIdentityRegeneratedWhenCorrupt verifies a garbage identity file is
// replaced with a fresh, valid one rather than wedging startup.
func TestWebRTCIdentityRegeneratedWhenCorrupt(t *testing.T) {
	path := webRTCIdentityPath(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create .juggler dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("not a pem file"), 0o600); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}

	cert, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("load-or-create over corrupt file: %v", err)
	}
	// The file is now a real identity we can reload to the same fingerprint.
	reloaded, ok := loadWebRTCCertificate(path)
	if !ok {
		t.Fatal("identity file still unreadable after regeneration")
	}
	if got, want := fingerprintOf(t, reloaded), fingerprintOf(t, cert); got != want {
		t.Fatalf("regenerated file fingerprint %q != returned %q", got, want)
	}
}

// TestPeerIdentityFingerprint covers the accessor both ways — no identity ->
// ("", false); a loaded identity -> its fingerprint and true.
func TestPeerIdentityFingerprint(t *testing.T) {
	s := &Server{}
	if fp, ok := s.PeerIdentityFingerprint(); ok || fp != "" {
		t.Fatalf("no identity: got (%q, %v), want (\"\", false)", fp, ok)
	}

	cert, err := loadOrCreateWebRTCCertificate(webRTCIdentityPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load-or-create: %v", err)
	}
	s.webrtcCert = cert

	fp, ok := s.PeerIdentityFingerprint()
	if !ok {
		t.Fatal("loaded identity: ok = false, want true")
	}
	if want := fingerprintOf(t, cert); fp != want {
		t.Fatalf("fingerprint = %q, want %q", fp, want)
	}
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"

	"github.com/pion/webrtc/v4"
)

// webRTCIdentityFileName is the durable store for a project's WebRTC peer
// identity: the DTLS certificate (and its private key) Juggler presents on every
// peer connection for that project. It lives in the project's .juggler dir
// alongside the instance lock's instance.json (and at the same 0600), so the
// identity is scoped per project — each project's server keeps its own stable,
// pinnable fingerprint — and survives restarts. Deliberately NOT machine-wide:
// several servers (one per project) run concurrently on one machine, and a
// single shared identity would make them indistinguishable to a remote peer.
const webRTCIdentityFileName = "webrtc-identity.pem"

// webRTCIdentityPath is the path of a project's persistent identity file, inside
// its .juggler dir — the same per-project location the instance lock uses.
func webRTCIdentityPath(projectPath string) string {
	return filepath.Join(projectPath, ".juggler", webRTCIdentityFileName)
}

// PeerIdentityFingerprint returns the SHA-256 DTLS fingerprint of this project's
// persistent WebRTC identity, and true when one is loaded. Because the identity
// is reused across restarts, the fingerprint is stable; GET /api/connectivity
// reports it as peerIdentity so the UI can show a stable device identity and a
// remote client can pin it. Returns "", false when no persistent identity is
// available and pion is minting ephemeral per-connection certificates instead.
func (s *Server) PeerIdentityFingerprint() (string, bool) {
	if s.webrtcCert == nil {
		return "", false
	}
	fps, err := s.webrtcCert.GetFingerprints()
	if err != nil || len(fps) == 0 {
		return "", false
	}
	return fps[0].Value, true
}

// loadOrCreateWebRTCCertificate returns the persistent WebRTC identity at path,
// minting and persisting a fresh one only when the file is absent or unreadable.
//
// A still-usable file is always reused verbatim, so the peer's DTLS fingerprint
// — the identity a remote client (or a rendezvous provider building a link) pins
// — stays byte-for-byte stable across restarts and across every peer connection
// within a run. That stability is the whole point; there is deliberately no
// expiry-driven rotation, because the identity is minted far in the future (see
// newWebRTCIdentity) and WebRTC peers authenticate by the SDP fingerprint, not
// by certificate validity (RFC 8122). Rotating the identity is a manual act:
// delete the file.
func loadOrCreateWebRTCCertificate(path string) (*webrtc.Certificate, error) {
	if cert, ok := loadWebRTCCertificate(path); ok {
		return cert, nil
	}
	cert, err := newWebRTCIdentity()
	if err != nil {
		return nil, err
	}
	if err := writeWebRTCCertificate(path, cert); err != nil {
		return nil, err
	}
	return cert, nil
}

// loadWebRTCCertificate reads and parses a stored identity. It returns ok=false
// (never an error) for any recoverable condition — no file yet, or an
// unparseable one — so the caller mints a replacement instead of failing to
// start. A missing file is silent (the first-run norm); anything else is logged.
func loadWebRTCCertificate(path string) (*webrtc.Certificate, bool) {
	data, err := atomicio.RobustReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			jlog.Info("WebRTC identity: cannot read %s (%v); minting a new one", path, err)
		}
		return nil, false
	}
	cert, err := webrtc.CertificateFromPEM(string(data))
	if err != nil {
		jlog.Info("WebRTC identity: %s is unreadable (%v); minting a new one", path, err)
		return nil, false
	}
	return cert, true
}

// newWebRTCIdentity mints a long-lived self-signed certificate to serve as this
// machine's stable WebRTC identity. It sets a far-future NotAfter (pion's own
// GenerateCertificate expires in a month, which would churn the identity) so a
// persisted identity effectively never needs rotating. The serial is fixed: this
// is a single self-signed leaf authenticated by fingerprint, not a CA-issued
// cert that must be uniquely numbered.
func newWebRTCIdentity() (*webrtc.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate WebRTC identity key: %w", err)
	}
	now := time.Now()
	name := pkix.Name{CommonName: "Juggler WebRTC identity"}
	cert, err := webrtc.NewCertificate(key, x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      name,
		Issuer:       name,
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(100, 0, 0),
		Version:      2,
	})
	if err != nil {
		return nil, fmt.Errorf("create WebRTC identity certificate: %w", err)
	}
	return cert, nil
}

// writeWebRTCCertificate persists cert (certificate + private-key PEM blocks)
// atomically with owner-only permissions, the same way the instance lock writes
// instance.json into .juggler: a unique temp file in the same directory, chmod
// 0600, then an atomic rename — so a torn or world-readable file (it holds a
// private key) is never observable.
func writeWebRTCCertificate(path string, cert *webrtc.Certificate) error {
	pemData, err := cert.PEM()
	if err != nil {
		return fmt.Errorf("encode WebRTC identity: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create WebRTC identity directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "webrtc-identity-*.pem.tmp")
	if err != nil {
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once the rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	if _, err := tmp.WriteString(pemData); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	if err := atomicio.RobustRename(tmpName, path); err != nil {
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	return nil
}

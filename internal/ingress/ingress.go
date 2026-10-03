//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package ingress names the caller-identity handshake between a machine server
// (`juggler serve`) and the session children it proxies to.
//
// Every proxied request reaches a child from its supervisor over loopback, so
// by address alone the child would take every caller for a local one. The
// supervisor therefore spawns each child with a fresh secret in SecretEnv and,
// on a request whose caller it did not see on loopback, sends Header carrying
// that secret. The child tags such a request as remote ingress
// (server.MarkRemoteIngress) and ignores the header in every other form.
//
// Both halves live in one binary, but they meet only across a process
// boundary, so the names are spelled here once.
package ingress

import (
	"crypto/rand"
	"encoding/hex"
	"os"
)

// Header carries the child's secret on a request its supervisor forwards from
// a caller off loopback.
const Header = "X-Juggler-Ingress"

// SecretEnv is the environment variable a session child finds its secret in.
const SecretEnv = "JUGGLER_INGRESS_SECRET"

// NewSecret returns a fresh random secret for one child.
func NewSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// A guessable secret would let anything on loopback pass for the
		// supervisor, so refuse to spawn rather than hand one out.
		panic("ingress.NewSecret: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// TakeSecret returns the secret in SecretEnv and removes it from this process's
// environment, so nothing the process goes on to spawn — a tool's shell
// included — inherits it.
func TakeSecret() string {
	secret := os.Getenv(SecretEnv)
	_ = os.Unsetenv(SecretEnv)
	return secret
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net"
	"testing"
)

// TestFindAvailablePortBindScope pins which interfaces the listener is bound
// to: every interface by default, so the LAN gate decides who gets in, and
// loopback alone for a LoopbackOnly server, so nobody off the machine can
// connect whatever the gate says.
func TestFindAvailablePortBindScope(t *testing.T) {
	cases := []struct {
		name         string
		loopbackOnly bool
		want         func(net.IP) bool
		wantDesc     string
	}{
		{"default binds every interface", false, net.IP.IsUnspecified, "unspecified"},
		{"loopback-only binds loopback", true, net.IP.IsLoopback, "loopback"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &Server{addr: "localhost:0", loopbackOnly: c.loopbackOnly}
			ln, _, err := s.findAvailablePort()
			if err != nil {
				t.Fatalf("findAvailablePort: %v", err)
			}
			defer func() { _ = ln.Close() }()
			ip := ln.Addr().(*net.TCPAddr).IP
			if !c.want(ip) {
				t.Fatalf("bound %s, want a %s address", ip, c.wantDesc)
			}
		})
	}
}

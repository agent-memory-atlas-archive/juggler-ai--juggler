//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"reflect"
	"testing"
	"time"
	"unicode/utf16"
)

// A WSL probe that times out once (a cold VM boot) must not leave the server
// without a shell: the next command after the retry interval probes again, and
// once a probe succeeds its answer is kept.
func TestToolchainCache_RetriesFailureThenKeepsSuccess(t *testing.T) {
	clock := time.Unix(0, 0)
	results := []bool{false, true, false}
	calls := 0
	c := newToolchainCache(func() (string, bool) {
		ok := results[calls]
		calls++
		if ok {
			return "wsl", true
		}
		return "none", false
	}, 10*time.Second)
	c.now = func() time.Time { return clock }

	if got := c.get(); got != "none" || calls != 1 {
		t.Fatalf("first get = %q after %d probes, want none after 1", got, calls)
	}
	clock = clock.Add(5 * time.Second)
	if got := c.get(); got != "none" || calls != 1 {
		t.Fatalf("get inside retry interval = %q after %d probes, want the cached failure without a probe", got, calls)
	}
	clock = clock.Add(6 * time.Second)
	if got := c.get(); got != "wsl" || calls != 2 {
		t.Fatalf("get after retry interval = %q after %d probes, want wsl after 2", got, calls)
	}
	clock = clock.Add(time.Hour)
	if got := c.get(); got != "wsl" || calls != 2 {
		t.Fatalf("get after success = %q after %d probes, want the kept success without a probe", got, calls)
	}
}

func utf16le(s string) []byte {
	var out []byte
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func TestParseWSLDistroList(t *testing.T) {
	cases := []struct {
		name string
		out  []byte
		want []string
	}{
		{"utf-16 with BOM and CRLF", utf16le("\uFEFFUbuntu-22.04\r\ndocker-desktop\r\n"), []string{"Ubuntu-22.04", "docker-desktop"}},
		{"utf-8", []byte("Debian\n\n"), []string{"Debian"}},
		{"no distros", utf16le("Windows Subsystem for Linux has no installed distributions.\r\n"), nil},
		{"stub install hint", []byte("The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\r\n"), nil},
		{"empty", nil, nil},
	}
	for _, tc := range cases {
		if got := parseWSLDistroList(tc.out); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: parseWSLDistroList = %q, want %q", tc.name, got, tc.want)
		}
	}
}

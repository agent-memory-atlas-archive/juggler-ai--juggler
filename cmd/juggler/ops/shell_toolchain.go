//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"strings"
	"time"
	"unicode/utf16"
)

// The pieces of Windows shell resolution (shell_ops_windows.go) that involve no
// Windows API, kept free of a build tag so they are tested on every platform.

// toolchainCache memoises a toolchain resolution that succeeded and retries one
// that did not.
//
// A failed resolution must not be kept for the life of the server. The failure
// that matters in practice is transient: WSL2 parks its VM when idle, and the
// probe that boots it again can outlast its deadline, so a perfectly good WSL
// reads as "no shell" at whatever moment a project's first command happened to
// run. Cached, that one slow boot would fail every command until a restart.
//
// A failure is retried at most once per retryAfter, so a burst of commands on a
// host that genuinely has no shell does not pay a probe each. Callers block on
// gate while a probe runs, which also keeps two probes from racing.
type toolchainCache[T any] struct {
	gate       chan struct{} // size-1 semaphore; the project forbids sync.Mutex
	resolve    func() (T, bool)
	retryAfter time.Duration
	now        func() time.Time

	value    T
	settled  bool // value came from a successful resolve and is final
	failedAt time.Time
	failed   bool
}

func newToolchainCache[T any](resolve func() (T, bool), retryAfter time.Duration) *toolchainCache[T] {
	return &toolchainCache[T]{
		gate:       make(chan struct{}, 1),
		resolve:    resolve,
		retryAfter: retryAfter,
		now:        time.Now,
	}
}

// get returns the cached success, the recent failure, or a fresh resolution.
func (c *toolchainCache[T]) get() T {
	c.gate <- struct{}{}
	defer func() { <-c.gate }()

	if c.settled {
		return c.value
	}
	if c.failed && c.now().Sub(c.failedAt) < c.retryAfter {
		return c.value
	}
	v, ok := c.resolve()
	c.value = v
	if ok {
		c.settled = true
	} else {
		c.failed = true
		c.failedAt = c.now()
	}
	return v
}

// parseWSLDistroList returns the distro names printed by `wsl.exe -l -q`.
//
// wsl.exe writes UTF-16LE to a pipe unless WSL_UTF8=1 is honoured, which older
// builds ignore, so both encodings are accepted: output with a NUL in it is
// decoded as UTF-16LE (a BOM is dropped either way). Blank lines are skipped,
// and so is anything that is not a plain name — the stub wsl.exe on a host with
// no WSL prints its install instructions to the same stream.
func parseWSLDistroList(out []byte) []string {
	var names []string
	for _, line := range strings.Split(decodeWSLOutput(out), "\n") {
		name := strings.TrimSpace(strings.ReplaceAll(line, "\x00", ""))
		if name == "" || strings.ContainsAny(name, " \t:") {
			continue
		}
		names = append(names, name)
	}
	return names
}

// decodeWSLOutput turns wsl.exe's own output into text, in whichever of its two
// encodings it arrived (see parseWSLDistroList), with any BOM removed.
func decodeWSLOutput(out []byte) string {
	text := string(out)
	if strings.IndexByte(text, 0) >= 0 {
		units := make([]uint16, 0, len(out)/2)
		for i := 0; i+1 < len(out); i += 2 {
			units = append(units, uint16(out[i])|uint16(out[i+1])<<8)
		}
		text = string(utf16.Decode(units))
	}
	return strings.TrimPrefix(text, "\uFEFF")
}

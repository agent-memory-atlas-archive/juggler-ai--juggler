//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"os/exec"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/srcroot"
)

// TestSuiteServerReportsItselfAsATestBuild pins the one thing that separates a
// server this suite spawns from somebody's install: the version it reports.
//
// Everything else about it is identical — it polls the update endpoint on the
// same schedule, and several spawn sites here (startHeadlessServer, the
// one-shot runs) start it WITHOUT --test, some in a config dir of their own. The
// endpoint refuses a countme marker only from a -test build (markFirstCheck in
// cmd/juggler/server/update_status.go), and the record that stops a marker being
// spent twice lives in the settings document a throwaway config dir does not
// have. So a suite driving a server stamped anything else reports a brand new
// install per spawn, on every run, from every CI runner.
func TestSuiteServerReportsItselfAsATestBuild(t *testing.T) {
	if testing.Short() {
		t.Skip("runs the juggler binary; skipped in -short mode")
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("srcroot.Find: %v", err)
	}

	binary := serverBinary(root)
	out, err := exec.Command(binary, "--version").Output()
	if err != nil {
		t.Fatalf("%s --version: %v", binary, err)
	}

	// "juggler <version> (commit: <sha>, built: <date>)"
	fields := strings.Fields(string(out))
	if len(fields) < 2 {
		t.Fatalf("%s --version printed %q, which names no version", binary, strings.TrimSpace(string(out)))
	}

	if version := fields[1]; !core.IsTestVersion(version) {
		t.Fatalf("the suite drives %s, which reports %q: a server a suite spawns must carry the -test stamp "+
			"(make test-build), or the update endpoint counts every spawn as an install", binary, version)
	}
}

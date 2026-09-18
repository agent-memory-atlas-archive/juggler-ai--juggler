//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/base64"
	"fmt"
	"html"

	"juggler/cmd/juggler/core"
)

// lockedProjectError means another process still holds a project's OS-level
// lock, but its instance metadata cannot be verified as a running Juggler
// server. The desktop app presents this in an otherwise empty window instead of
// silently dropping a restored session.
type lockedProjectError struct {
	project string
	info    *core.InstanceInfo
}

func newLockedProjectError(project string, info *core.InstanceInfo) *lockedProjectError {
	return &lockedProjectError{project: project, info: info}
}

func (e *lockedProjectError) Error() string {
	return fmt.Sprintf("project is locked: %s", e.project)
}

// lockedProjectPage renders message as a self-contained page for the window's
// URL. There is no server to serve it from — that is the whole problem being
// reported — so it travels as a data URL.
func lockedProjectPage(message string) string {
	doc := `<!doctype html><meta charset="utf-8"><title>Project locked</title>` +
		`<style>body{margin:0;padding:48px;background:#0d1117;color:#e6edf3;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}` +
		`main{max-width:720px;margin:auto}h1{margin-top:0}pre{white-space:pre-wrap;font:inherit}</style>` +
		`<main><h1>Project locked</h1><pre>` + html.EscapeString(message) + `</pre></main>`

	// Base64, not percent-encoding. url.QueryEscape encodes for
	// application/x-www-form-urlencoded, where a space is "+" — a rule no
	// browser applies to a data URL, so every space arrives as a literal "+"
	// and takes the doctype, the charset and the CSS down with it. PathEscape
	// gets the spaces right but still leaves "?" unescaped and would let a
	// stray "#" truncate the document at the fragment. Base64 has no such
	// characters to get wrong.
	return "data:text/html;charset=utf-8;base64," + base64.StdEncoding.EncodeToString([]byte(doc))
}

// message is the text shown in the locked-project window. The wording lives in
// core beside the lock itself, so the window and the terminal explain the same
// situation the same way.
func (e *lockedProjectError) message() string {
	return (&core.ProjectLockedError{Project: e.project, Info: e.info}).Advice()
}

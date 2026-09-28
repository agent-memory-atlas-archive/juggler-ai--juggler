//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDroppedProjectFolder pins what a drop on an empty window resolves to.
func TestDroppedProjectFolder(t *testing.T) {
	base := t.TempDir()
	folder := filepath.Join(base, "myapp")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	file := filepath.Join(folder, "main.go")
	if err := os.WriteFile(file, []byte("package main\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	other := filepath.Join(base, "second")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	cases := []struct {
		label string
		paths []string
		want  string
	}{
		{"a folder opens itself", []string{folder}, folder},
		// Dragging a file out of the project you meant to open is a near miss,
		// not a mistake worth refusing.
		{"a file opens its folder", []string{file}, folder},
		{"nothing dropped", nil, ""},
		{"an empty path", []string{"   "}, ""},
		{"a path that is not there", []string{filepath.Join(base, "ghost")}, ""},
		// Two folders name no single project, and silently taking the first
		// would be a guess the user cannot see being made.
		{"two folders", []string{folder, other}, ""},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			if got := droppedProjectFolder(tc.paths); got != tc.want {
				t.Errorf("droppedProjectFolder(%v) = %q, want %q", tc.paths, got, tc.want)
			}
		})
	}
}

// TestJSStringEscapesPathPunctuation: the resolved path is concatenated into an
// ExecJS payload, so a folder name containing a quote or a backslash has to
// come out as a string literal rather than as an early end to one.
func TestJSStringEscapesPathPunctuation(t *testing.T) {
	cases := []struct {
		label string
		path  string
	}{
		{"a quote", `/tmp/it's here`},
		{"a double quote", `/tmp/say "hi"`},
		{"a backslash", `C:\Users\me\code`},
		{"a newline", "/tmp/one\ntwo"},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			got := jsString(tc.path)
			if !strings.HasPrefix(got, `"`) || !strings.HasSuffix(got, `"`) {
				t.Fatalf("jsString(%q) = %s, want a quoted literal", tc.path, got)
			}
			// The literal must contain no raw newline and no unescaped quote,
			// either of which ends the statement it is embedded in.
			body := got[1 : len(got)-1]
			if strings.Contains(body, "\n") {
				t.Errorf("jsString(%q) = %s, which carries a raw newline", tc.path, got)
			}
			for i := 0; i < len(body); i++ {
				if body[i] == '"' && (i == 0 || body[i-1] != '\\') {
					t.Errorf("jsString(%q) = %s, which closes its own literal early", tc.path, got)
				}
			}
		})
	}
}

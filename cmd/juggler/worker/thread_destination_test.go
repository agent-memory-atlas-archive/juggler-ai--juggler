//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"path/filepath"
	"strings"
	"testing"
)

// TestRunThreadIsSetOnlyWhereATurnBegins pins where a turn's thread can be
// written: beginTurn gives a dispatched turn its thread, and resetThreadContext
// clears it as the run ends. Nothing else assigns it. A handler that writes into
// some other thread resolves it (resolveThread) and passes it to the *In / *To
// helpers in thread_helpers.go.
//
// Re-pointing a run instead is what this rules out. The handlers run on the
// ambient turn, which every handler the run loop serves shares, so a destination
// parked on it had to be saved and restored on every path out of every handler
// that set one, and each of those defers carried a comment explaining what broke
// without it.
func TestRunThreadIsSetOnlyWhereATurnBegins(t *testing.T) {
	allowed := map[string]bool{"beginTurn": true, "resetThreadContext": true}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	scanned, sanctioned := 0, 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", f, err)
		}
		scanned++
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				assign, ok := n.(*ast.AssignStmt)
				if !ok {
					return true
				}
				for _, lhs := range assign.Lhs {
					target := types.ExprString(lhs)
					if !assignsRunThread(target) {
						continue
					}
					if allowed[fn.Name.Name] {
						sanctioned++
						continue
					}
					t.Errorf("%s: %s assigns %s; resolve the destination with resolveThread and pass it instead",
						fset.Position(assign.Pos()), fn.Name.Name, target)
				}
				return true
			})
		}
	}
	if scanned < 20 {
		t.Fatalf("scanned only %d production files — the walk is not seeing the package", scanned)
	}
	if sanctioned < 2 {
		t.Fatalf("found only %d sanctioned thread assignments — the walk is not recognising them", sanctioned)
	}
}

// assignsRunThread reports whether an assignment target is a turn's thread
// context or one of its two fields.
func assignsRunThread(target string) bool {
	for _, suffix := range []string{".thread", ".thread.itemID", ".thread.itemsArray"} {
		if strings.HasSuffix(target, suffix) {
			return true
		}
	}
	return false
}

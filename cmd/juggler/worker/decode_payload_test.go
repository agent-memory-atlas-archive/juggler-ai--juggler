//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// TestHandlersDecodeThroughOnePolicy pins every inbound-message handler to
// decodePayload / ackIDOf. Handlers once decoded their payloads by hand under
// four different policies — log and insert an error item, log only, return
// silently, discard the error with `_ =` — so whether a malformed frame left
// any trace depended on which handler it reached.
//
// A handler is any `handle*` function taking a `payload json.RawMessage`; it
// may not pass that payload to json.Unmarshal itself. handleEngineTrace is the
// one exemption: its probe is optional by design, and it logs the raw frame
// whether or not the probe decodes.
func TestHandlersDecodeThroughOnePolicy(t *testing.T) {
	exempt := map[string]bool{"handleEngineTrace": true}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	handlers := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || !strings.HasPrefix(fn.Name.Name, "handle") || !takesPayload(fn) {
				continue
			}
			handlers++
			if exempt[fn.Name.Name] {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) == 0 {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Unmarshal" {
					return true
				}
				if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != "json" {
					return true
				}
				if arg, ok := call.Args[0].(*ast.Ident); ok && arg.Name == "payload" {
					t.Errorf("%s: %s decodes its payload by hand; use decodePayload (or ackIDOf for a barrier's ack id)",
						fset.Position(call.Pos()), fn.Name.Name)
				}
				return true
			})
		}
	}
	if handlers < 25 {
		t.Fatalf("found only %d payload handlers — the walk is not seeing the package", handlers)
	}
}

// takesPayload reports whether fn has a parameter named payload of type
// json.RawMessage.
func takesPayload(fn *ast.FuncDecl) bool {
	for _, field := range fn.Type.Params.List {
		sel, ok := field.Type.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "RawMessage" {
			continue
		}
		for _, name := range field.Names {
			if name.Name == "payload" {
				return true
			}
		}
	}
	return false
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"path/filepath"
	"testing"
)

// A project's windows are not all the same window. Two boards detached onto two
// displays can be set to two different themes, and each has to come back the way
// it was left — which it cannot do while theme and zoom are one project-wide
// value that every window writes. These tests pin the per-window contract: a
// window's own value wins, a window with none follows the project, the main
// window sets what a new window inherits, and none of it is lost by the geometry
// write that lands every time a window is dragged.

func TestWindowUIThemeFallsBackToTheProject(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	// Nothing set anywhere: no answer, so the page follows its own precedence.
	if _, ok := m.GetWindowUITheme(board); ok {
		t.Fatal("expected no theme for any window on a fresh session")
	}

	// The project's theme is what a window without one of its own wears.
	if err := m.SetUITheme("dark"); err != nil {
		t.Fatalf("SetUITheme: %v", err)
	}
	if got, ok := m.GetWindowUITheme(board); !ok || got != "dark" {
		t.Fatalf("a board with no theme of its own follows the project: got %q ok=%v", got, ok)
	}

	// Once it has been told, it stops following.
	if err := m.SetWindowUITheme(board, "light"); err != nil {
		t.Fatalf("SetWindowUITheme: %v", err)
	}
	if got, _ := m.GetWindowUITheme(board); got != "light" {
		t.Fatalf("the board's own theme wins: got %q want \"light\"", got)
	}
	if got, _ := m.GetWindowUITheme(WindowRoleMain); got != "dark" {
		t.Fatalf("and says nothing about the main window: got %q want \"dark\"", got)
	}
}

func TestWindowUIThemeIsIndependentPerBoard(t *testing.T) {
	m := newManagerForTest(t)
	a := WindowRolePinboardFor("board_a")
	b := WindowRolePinboardFor("board_b")

	if err := m.SetWindowUITheme(a, "light"); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if err := m.SetWindowUITheme(b, "dark"); err != nil {
		t.Fatalf("set b: %v", err)
	}

	if got, _ := m.GetWindowUITheme(a); got != "light" {
		t.Fatalf("board a wearing board b's theme: got %q want \"light\"", got)
	}
	if got, _ := m.GetWindowUITheme(b); got != "dark" {
		t.Fatalf("board b: got %q want \"dark\"", got)
	}
}

// Only the main window sets what the project — and so every window opened
// later — starts out wearing. A restyled board is one window's choice, not a new
// default for the next board detached.
func TestOnlyTheMainWindowSetsTheProjectDefault(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.SetWindowUITheme(board, "light"); err != nil {
		t.Fatalf("set board: %v", err)
	}
	if err := m.SetWindowUIZoom(board, 130); err != nil {
		t.Fatalf("set board zoom: %v", err)
	}
	if _, ok := m.GetUITheme(); ok {
		t.Fatal("a board's theme must not become the project's")
	}
	if _, ok := m.GetUIZoom(); ok {
		t.Fatal("nor its zoom")
	}

	if err := m.SetWindowUITheme(WindowRoleMain, "dark"); err != nil {
		t.Fatalf("set main: %v", err)
	}
	if err := m.SetWindowUIZoom(WindowRoleMain, 110); err != nil {
		t.Fatalf("set main zoom: %v", err)
	}
	if got, ok := m.GetUITheme(); !ok || got != "dark" {
		t.Fatalf("the main window's theme is the project's: got %q ok=%v", got, ok)
	}
	if got, ok := m.GetUIZoom(); !ok || got != 110 {
		t.Fatalf("the main window's zoom is the project's: got %d ok=%v", got, ok)
	}

	// A board opened now inherits that, and the restyled one still does not.
	if got, _ := m.GetWindowUITheme(WindowRolePinboardFor("board_new")); got != "dark" {
		t.Fatalf("a new board inherits the main window's theme: got %q want \"dark\"", got)
	}
	if got, _ := m.GetWindowUITheme(board); got != "light" {
		t.Fatalf("the restyled board keeps its own: got %q want \"light\"", got)
	}
}

// The frame is captured from the live native window, which knows nothing about
// appearance, and it is written on every move and resize. Dragging a window must
// not therefore strip the theme it is wearing, nor the UI preferences the viewer
// keeps in the same slot.
func TestGeometryWritesKeepTheWindowsAppearance(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.SetWindowUITheme(board, "light"); err != nil {
		t.Fatalf("set theme: %v", err)
	}
	if err := m.SetWindowUIZoom(board, 130); err != nil {
		t.Fatalf("set zoom: %v", err)
	}
	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("set ui prefs: %v", err)
	}
	frame := WindowState{X: 1420, Y: 40, Width: 520, Height: 900, HasPos: true}
	if err := m.SetWindowState(board, frame); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}

	got, ok := m.GetWindowState(board)
	if !ok {
		t.Fatal("expected the board's slot after a geometry write")
	}
	if got.Theme != "light" || got.Zoom != 130 {
		t.Fatalf("a drag wiped the window's appearance: got theme=%q zoom=%d", got.Theme, got.Zoom)
	}
	if !got.SameFrame(frame) {
		t.Fatalf("and the frame still has to be the one written: got %+v want %+v", got, frame)
	}
	if want := `"31.5"`; string(m.GetWindowUIPrefs(board)["juggler-column-width"]) != want {
		t.Fatalf("a drag wiped the window's UI preferences: got %s want %s",
			m.GetWindowUIPrefs(board)["juggler-column-width"], want)
	}
}

// A window told only its theme has a slot with no frame in it. That must read as
// "no saved geometry" — the window is placed by the centred default, not at 0,0.
func TestAThemeOnlySlotIsNotGeometry(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.SetWindowUITheme(board, "dark"); err != nil {
		t.Fatalf("set theme: %v", err)
	}
	got, _ := m.GetWindowState(board)
	if got.HasPos || got.Width != 0 || got.Height != 0 {
		t.Fatalf("a theme-only slot must carry no frame: got %+v", got)
	}
}

func TestWindowUIPrefsPersistToDisk(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	a := WindowRolePinboardFor("board_a")
	b := WindowRolePinboardFor("board_b")
	m := startManager(store, dir, "")
	if err := m.SetWindowUITheme(WindowRoleMain, "dark"); err != nil {
		t.Fatalf("set main: %v", err)
	}
	if err := m.SetWindowUITheme(a, "light"); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if err := m.SetWindowUIZoom(b, 140); err != nil {
		t.Fatalf("set b zoom: %v", err)
	}
	m.Shutdown()

	// Reopen the project from disk — the relaunch the whole change exists for.
	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir, "")
	t.Cleanup(m2.Shutdown)
	if got, ok := m2.GetWindowUITheme(a); !ok || got != "light" {
		t.Fatalf("board a came back in the wrong theme from %s: got %q ok=%v",
			filepath.Join(dir, ".juggler", "session.json"), got, ok)
	}
	if got, _ := m2.GetWindowUITheme(WindowRoleMain); got != "dark" {
		t.Fatalf("the main window came back in the wrong theme: got %q want \"dark\"", got)
	}
	if got, _ := m2.GetWindowUIZoom(b); got != 140 {
		t.Fatalf("board b came back at the wrong zoom: got %d want 140", got)
	}
}

func TestWindowUIPrefsInvalidValuesAreNoOps(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.SetWindowUITheme(board, "chartreuse"); err != nil {
		t.Fatalf("SetWindowUITheme: %v", err)
	}
	if err := m.SetWindowUIZoom(board, 0); err != nil {
		t.Fatalf("SetWindowUIZoom: %v", err)
	}
	if _, ok := m.GetWindowUITheme(board); ok {
		t.Fatal("an unrecognised mode must not mark the window as styled")
	}
	if _, ok := m.GetWindowUIZoom(board); ok {
		t.Fatal("nor a zoom of zero")
	}
}

// The desktop app names a window's role from the options it opened it with, and
// the server names the same window from the URL it is serving. They have to
// agree, or a board would write its theme into one slot and read it from
// another. cmd/juggler-app's TestWindowOptsRole pins the other side of this.
func TestWindowRoleForView(t *testing.T) {
	cases := []struct {
		name  string
		view  string
		board string
		want  string
	}{
		{"an ordinary window", "", "", WindowRoleMain},
		{"an unknown view is still the app", "something", "board_a", WindowRoleMain},
		{"a detached board", WindowViewPinboard, "board_a", WindowRolePinboardFor("board_a")},
		{"the docked board detached", WindowViewPinboard, MainBoardID, WindowRolePinboardFor(MainBoardID)},
		{"a board with no id", WindowViewPinboard, "", WindowRolePinboard},
		{"a board with an unusable id", WindowViewPinboard, "../etc", WindowRolePinboard},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := WindowRoleForView(c.view, c.board); got != c.want {
				t.Fatalf("WindowRoleForView(%q, %q) = %q, want %q", c.view, c.board, got, c.want)
			}
		})
	}
}

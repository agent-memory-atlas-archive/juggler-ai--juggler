package windowgeom

import (
	"testing"

	"juggler/cmd/juggler/core"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type fakeWindow struct {
	maximised  bool
	fullscreen bool
	minimised  bool
	x, y       int
	width      int
	height     int
}

func (w fakeWindow) IsMaximised() bool  { return w.maximised }
func (w fakeWindow) IsFullscreen() bool { return w.fullscreen }
func (w fakeWindow) IsMinimised() bool  { return w.minimised }
func (w fakeWindow) Position() (int, int) {
	return w.x, w.y
}
func (w fakeWindow) Size() (int, int) {
	return w.width, w.height
}

func TestCaptureIgnoresMinimisedWindow(t *testing.T) {
	seed := core.WindowState{X: 120, Y: 80, Width: 1400, Height: 900, HasPos: true}
	tracker := NewTracker(seed, testScreens)

	if got, ok := tracker.Capture(fakeWindow{
		minimised: true,
		x:         -32000,
		y:         -32000,
		width:     1400,
		height:    900,
	}); ok {
		t.Fatalf("Capture() while minimised = (%+v, true), want (_, false)", got)
	}

	got, ok := tracker.Capture(fakeWindow{x: 150, y: 100, width: 1300, height: 800})
	if !ok {
		t.Fatal("Capture() after restore returned false")
	}
	if got.X != 150 || got.Y != 100 || got.Width != 1300 || got.Height != 800 {
		t.Fatalf("Capture() after restore = %+v, want restored frame", got)
	}
}

// A window restored from a stale off-screen frame and then maximised by the
// user has never been at the frame it was seeded with. Capture must not write
// that frame back, or the rescue survives only until the window is closed and
// the next launch is stranded all over again.
func TestCaptureMaximisedDoesNotPersistAStrandedSeed(t *testing.T) {
	stranded := core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}
	tracker := NewTracker(stranded, testScreens)

	got, ok := tracker.Capture(fakeWindow{
		maximised: true,
		x:         0,
		y:         0,
		width:     1920,
		height:    1040,
	})
	if ok && got.X == stranded.X && got.Y == stranded.Y {
		t.Fatalf("Capture() while maximised = (%+v, true), want it to refuse the stranded seed", got)
	}
}

func TestPlaceVisibleKeepsFrameWithDraggableHeader(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: -1200, Y: 50, Width: 1000, Height: 800, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Position != application.WindowXY || got.X != saved.X || got.Y != saved.Y {
		t.Fatalf("PlaceVisible() = %+v, want saved placement", got)
	}
	if got.Screen != nil {
		t.Fatalf("PlaceVisible() screen = %+v, want nil for unchanged absolute placement", got.Screen)
	}
}

func TestPlaceVisibleRecentresStrandedFrame(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Position != application.WindowCentered {
		t.Fatalf("PlaceVisible() position = %v, want WindowCentered", got.Position)
	}
	if got.Screen != screens[0] {
		t.Fatalf("PlaceVisible() screen = %+v, want primary screen", got.Screen)
	}
	if got.Width != 1400 || got.Height != 900 {
		t.Fatalf("PlaceVisible() size = %dx%d, want 1400x900", got.Width, got.Height)
	}
}

func TestPlaceVisibleRecentresFrameWithHiddenHeader(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: 100, Y: -850, Width: 1400, Height: 900, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Position != application.WindowCentered || got.Screen != screens[0] {
		t.Fatalf("PlaceVisible() = %+v, want centred on primary", got)
	}
}

func TestPlaceVisibleClampsRescuedFrameToWorkArea(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: 4000, Y: 0, Width: 3000, Height: 2000, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Width != 1920 || got.Height != 1040 {
		t.Fatalf("PlaceVisible() size = %dx%d, want 1920x1040", got.Width, got.Height)
	}
}

// A frame the caller worked out for itself — a window opened over something the
// user was already looking at — is fitted onto the screen it lands on before it
// is placed. PlaceVisible only promises a header you can drag; a window with its
// far edge off the screen is one you can drag but cannot read.
func TestFitOnScreenLeavesAFrameThatAlreadyFits(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: 100, Y: 80, Width: 800, Height: 700, HasPos: true}

	if got := FitOnScreen(frame, screens); !got.SameFrame(frame) {
		t.Fatalf("FitOnScreen() = %+v, want it untouched", got)
	}
}

func TestFitOnScreenPullsBackAnOverhangingFrame(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: 1500, Y: 900, Width: 800, Height: 600, HasPos: true}

	got := FitOnScreen(frame, screens)
	if got.X != 1920-800 || got.Y != 1040-600 {
		t.Fatalf("FitOnScreen() origin = %d,%d, want %d,%d", got.X, got.Y, 1920-800, 1040-600)
	}
	if got.Width != 800 || got.Height != 600 {
		t.Fatalf("FitOnScreen() size = %dx%d, want it unchanged", got.Width, got.Height)
	}
}

// Moving a window is the caller's business; resizing one is not. A frame with
// nowhere to fit goes to the top-left of the work area with its size intact.
func TestFitOnScreenPinsAFrameTooBigForTheScreen(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: 300, Y: 200, Width: 2400, Height: 1200, HasPos: true}

	got := FitOnScreen(frame, screens)
	if got.X != 0 || got.Y != 0 {
		t.Fatalf("FitOnScreen() origin = %d,%d, want the work area's own", got.X, got.Y)
	}
	if got.Width != 2400 || got.Height != 1200 {
		t.Fatalf("FitOnScreen() size = %dx%d, want it unchanged", got.Width, got.Height)
	}
}

// The screen it is on is the one it mostly lies on, so a window popped out on
// the second display is fitted to that display rather than dragged home.
func TestFitOnScreenStaysOnTheScreenTheFrameIsOn(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: -1000, Y: 700, Width: 800, Height: 600, HasPos: true}

	got := FitOnScreen(frame, screens)
	if got.X != -1000 {
		t.Errorf("FitOnScreen() x = %d, want it left where it was on the second display", got.X)
	}
	if got.Y != 984-600 {
		t.Errorf("FitOnScreen() y = %d, want %d — that display's work area is shorter", got.Y, 984-600)
	}
}

// Nothing to fit: a frame with no position of its own is placed by the centring
// default, and inventing coordinates for it here would take that away.
func TestFitOnScreenIgnoresAFrameWithNothingToFit(t *testing.T) {
	screens := testScreens()
	for _, frame := range []core.WindowState{
		{Width: 800, Height: 600},
		{X: 4000, Y: 4000, HasPos: true},
		{},
	} {
		if got := FitOnScreen(frame, screens); !got.SameFrame(frame) {
			t.Errorf("FitOnScreen(%+v) = %+v, want it untouched", frame, got)
		}
	}
	frame := core.WindowState{X: 4000, Y: 4000, Width: 800, Height: 600, HasPos: true}
	if got := FitOnScreen(frame, nil); !got.SameFrame(frame) {
		t.Errorf("FitOnScreen() with no screens = %+v, want it untouched", got)
	}
}

// The startup hole this whole rescue exists for: Wails fills its screen cache
// inside Run(), and the initial window is placed before Run, so the frame is
// judged against nothing. Nothing can be decided from an empty screen list, so
// the saved frame has to pass through untouched — which is why the live frame
// is re-checked once the app is up.
func TestStrandedCannotJudgeWithoutScreens(t *testing.T) {
	frame := core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}

	if Stranded(frame, nil) {
		t.Error("Stranded() with no screens = true, want false — there is nothing to judge against")
	}
	if Stranded(frame, []*application.Screen{}) {
		t.Error("Stranded() with an empty screen list = true, want false")
	}
	if !Stranded(frame, testScreens()) {
		t.Error("Stranded() with real screens = false, want true for a parked frame")
	}

	saved := PlaceVisible(frame, nil)
	if saved.Position != application.WindowXY || saved.X != frame.X || saved.Y != frame.Y {
		t.Errorf("PlaceVisible() with no screens = %+v, want the saved frame passed through", saved)
	}
}

// A frame with no position cannot strand: it is placed by the centring default,
// which is on-screen by construction.
func TestStrandedIgnoresAFrameWithNoPosition(t *testing.T) {
	if Stranded(core.WindowState{Width: 1400, Height: 900}, testScreens()) {
		t.Error("Stranded() for a frame with no position = true, want false")
	}
}

func TestRescueFrameCentresOnPrimaryAndShrinksToFit(t *testing.T) {
	screens := testScreens()
	got, moved := RescueFrame(core.WindowState{X: -32000, Y: -32000, Width: 3000, Height: 2000, HasPos: true}, screens)
	if !moved {
		t.Fatal("RescueFrame() moved = false, want true for a parked frame")
	}
	if got.Width != 1920 || got.Height != 1040 {
		t.Errorf("RescueFrame() size = %dx%d, want it shrunk to the 1920x1040 work area", got.Width, got.Height)
	}
	if got.X != 0 || got.Y != 0 {
		t.Errorf("RescueFrame() position = %d,%d, want it centred on the primary work area", got.X, got.Y)
	}

	smaller, _ := RescueFrame(core.WindowState{X: 9000, Y: 9000, Width: 920, Height: 40, HasPos: true}, screens)
	if smaller.X != (1920-920)/2 || smaller.Y != (1040-40)/2 {
		t.Errorf("RescueFrame() position = %d,%d, want it centred", smaller.X, smaller.Y)
	}
}

// A window that is reachable, and a window with no display to be moved onto,
// are both left exactly where they are.
func TestRescueFrameLeavesAReachableWindowAlone(t *testing.T) {
	onScreen := core.WindowState{X: 100, Y: 100, Width: 800, Height: 600, HasPos: true}
	if got, moved := RescueFrame(onScreen, testScreens()); moved || !got.SameFrame(onScreen) {
		t.Errorf("RescueFrame() = (%+v, %v), want it untouched and false", got, moved)
	}

	// The second display's frame, which is stranded only if you forget it exists.
	onSecond := core.WindowState{X: -1200, Y: 50, Width: 1000, Height: 800, HasPos: true}
	if got, moved := RescueFrame(onSecond, testScreens()); moved || !got.SameFrame(onSecond) {
		t.Errorf("RescueFrame() on the second display = (%+v, %v), want it untouched", got, moved)
	}

	parked := core.WindowState{X: -32000, Y: -32000, Width: 800, Height: 600, HasPos: true}
	if got, moved := RescueFrame(parked, nil); moved || !got.SameFrame(parked) {
		t.Errorf("RescueFrame() with no screens = (%+v, %v), want it untouched", got, moved)
	}
}

// Seeding the tracker from the saved frame rather than the placement is what
// let a rescued window write back the frame it was rescued from. A refused
// frame becomes a centred placement, which seeds a size and no position.
func TestSeedTakesThePlacementNotTheSavedFrame(t *testing.T) {
	strandedSave := core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}

	seed := Seed(PlaceVisible(strandedSave, testScreens()))
	if seed.HasPos {
		t.Errorf("Seed() of a rescued placement = %+v, want no position", seed)
	}
	if seed.Width != 1400 || seed.Height != 900 {
		t.Errorf("Seed() size = %dx%d, want the saved 1400x900 kept", seed.Width, seed.Height)
	}

	kept := core.WindowState{X: 120, Y: 80, Width: 1000, Height: 800, HasPos: true}
	seed = Seed(PlaceVisible(kept, testScreens()))
	if !seed.HasPos || seed.X != 120 || seed.Y != 80 {
		t.Errorf("Seed() of an honoured placement = %+v, want the saved position", seed)
	}
}

// A tracker seeded from a rescued placement has no restore frame to offer while
// the window is maximised, and must say so rather than invent one.
func TestCaptureMaximisedWithNoSeedDeclines(t *testing.T) {
	tracker := NewTracker(Seed(PlaceVisible(
		core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}, testScreens())), testScreens)

	if got, ok := tracker.Capture(fakeWindow{maximised: true, width: 1920, height: 1040}); ok {
		t.Fatalf("Capture() = (%+v, true), want (_, false) with no normal-state frame known", got)
	}

	// Restored: the live frame is real, so it is both kept and reported.
	got, ok := tracker.Capture(fakeWindow{x: 200, y: 150, width: 1000, height: 800})
	if !ok || got.X != 200 || got.Y != 150 {
		t.Fatalf("Capture() after restore = (%+v, %v), want the live frame", got, ok)
	}
}

// The loop this closes: a window restored from a stranded frame has nothing
// true to persist while it is maximised, so it is rescued on every launch and
// repaired on none. Reseeding it with the frame it was actually moved to lets
// the very next capture write a frame that will come back.
func TestReseedRepairsAStrandedMaximisedWindow(t *testing.T) {
	tracker := NewTracker(core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}, testScreens)
	maximised := fakeWindow{maximised: true, width: 1920, height: 1040}

	if got, ok := tracker.Capture(maximised); ok {
		t.Fatalf("Capture() = (%+v, true), want the stranded frame refused", got)
	}

	tracker.Reseed(core.WindowState{X: 0, Y: 0, Width: 1920, Height: 1040, HasPos: true})

	got, ok := tracker.Capture(maximised)
	if !ok {
		t.Fatal("Capture() after Reseed returned false, want the rescued frame")
	}
	if got.X != 0 || got.Y != 0 || got.Width != 1920 || got.Height != 1040 {
		t.Errorf("Capture() = %+v, want the rescued frame", got)
	}
	if !got.Maximised {
		t.Error("Capture() lost the maximised flag")
	}
}

func testScreens() []*application.Screen {
	return []*application.Screen{
		{IsPrimary: true, WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}},
		{WorkArea: application.Rect{X: -1280, Y: 0, Width: 1280, Height: 984}},
	}
}

// Package windowgeom holds the window geometry persistence shared by the two
// Wails hosts: the server's test-pool window (cmd/juggler/app) and the desktop
// app's window registry (cmd/juggler-app). Both read the same frame out of the
// same session store — one in-process, one over the window-state HTTP route —
// so the questions "what frame is this window in", "when do I write it" and
// "where do I put a window given a saved frame" have one answer each.
//
// What deliberately stays with the caller: the sink (which store the frame goes
// to), the error policy, and marshalling onto the main thread. Capture reads
// live native state and so must run on the main thread, but the two hosts hop
// there at different layers, and the server's close path skips the hop on
// purpose — so the hop is documented here and performed by the caller.
package windowgeom

import (
	"time"

	"juggler/cmd/juggler/core"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The smallest window a first launch opens at, and what a caller with no
// screens to consult gets.
//
// The width is the app's own layout read back as a number: the tab sidebar
// (15rem), a conversation column at the width it starts at (50rem) and the
// properties panel at the narrowest it is allowed to be (30rem) come to 95rem,
// which is 1520px at the default root font size. A window narrower than that
// cannot show a conversation and the panel beside it at once, and the first
// thing a new user does that opens a panel is met with a sideways scrollbar.
//
// A display too small even for this caps it (see CapToWorkArea), and the column
// widths then follow the window rather than the other way round
// (startingColumnWidthRem in js/utils/column-resize.js).
const (
	DefaultWidth  = 1520
	DefaultHeight = 900
)

// What a window with no saved geometry takes of the display it opens on, once
// there is a display to ask about (DefaultSize).
//
// The share keeps a first launch from covering the desktop it was started from;
// the maxima keep a large display from being answered with a window nobody
// wants. 1920 is the layout with room to spare — sidebar, a conversation at the
// width it starts at, and 55rem for the panel, nearly twice its floor — past
// which the extra width is going to a properties panel that stopped needing it.
// An ultrawide would otherwise open a window a metre across.
const (
	defaultWidthShare  = 70 // percent of the work area
	defaultHeightShare = 80
	maxDefaultWidth    = 1920
	maxDefaultHeight   = 1360
)

// DefaultSize is the size a window with no saved geometry opens at on these
// screens: a share of the primary display's work area, never below the layout's
// own minimum and never past the maxima above. Falls back to that minimum when
// there are no screens to measure, which is what the initial window gets — it
// is built before Wails knows of any (see fitWindowToScreens in cmd/juggler-app).
func DefaultSize(screens []*application.Screen) (int, int) {
	primary := primaryScreen(screens)
	if primary == nil {
		return DefaultWidth, DefaultHeight
	}
	area := primary.WorkArea
	if area.Width <= 0 || area.Height <= 0 {
		return DefaultWidth, DefaultHeight
	}
	width := min(max(area.Width*defaultWidthShare/100, DefaultWidth), maxDefaultWidth)
	height := min(max(area.Height*defaultHeightShare/100, DefaultHeight), maxDefaultHeight)
	// The minimum can be larger than the display it is being applied to, which
	// is the one case where the layout does not get what it asked for.
	return min(width, area.Width), min(height, area.Height)
}

// DefaultFrame is DefaultSize centred on the primary work area, for a caller
// correcting a window that was placed before there were screens to consult.
// Reported as (frame, false) when there are none now either.
func DefaultFrame(screens []*application.Screen) (core.WindowState, bool) {
	primary := primaryScreen(screens)
	if primary == nil {
		return core.WindowState{}, false
	}
	area := primary.WorkArea
	if area.Width <= 0 || area.Height <= 0 {
		return core.WindowState{}, false
	}
	width, height := DefaultSize(screens)
	return core.WindowState{
		X:      area.X + (area.Width-width)/2,
		Y:      area.Y + (area.Height-height)/2,
		Width:  width,
		Height: height,
		HasPos: true,
	}, true
}

// SaveDebounce collapses a burst of window move/resize events into a single
// geometry write ~this long after the last change.
const SaveDebounce = 300 * time.Millisecond

// Window is the slice of a Wails window a Tracker reads. Taking an interface
// rather than *application.WebviewWindow keeps the capture rules testable
// without an app to host a real window.
type Window interface {
	IsMaximised() bool
	IsFullscreen() bool
	IsMinimised() bool
	Position() (int, int)
	Size() (int, int)
}

// Tracker remembers the last known normal (non-maximised, non-fullscreen)
// frame of one window, which is what makes a maximised window still able to
// persist a sane restore frame alongside its maximised flag.
type Tracker struct {
	lastPos core.WindowState
	screens func() []*application.Screen
}

// NewTracker returns a tracker seeded with a previously saved frame. Seeding
// matters at startup: a window that comes up maximised has no live normal-state
// sample of its own yet, and the saved frame is the right thing to keep
// re-writing until the user restores it.
//
// screens reports the displays as they are at capture time, so a frame that
// could never be restored is never written (see Capture). It is consulted on
// the main thread, along with the rest of the capture. A nil func disables the
// check, which is what a host whose window deliberately lives outside every
// work area wants — the test-pool window is off-screen by design.
func NewTracker(seed core.WindowState, screens func() []*application.Screen) *Tracker {
	return &Tracker{lastPos: seed, screens: screens}
}

// Reseed replaces the remembered normal-state frame with one the caller has
// just put the window at itself. For a window moved out from under the tracker
// — a rescue off a display that no longer exists — where the new frame is both
// true and, while the window is maximised, the only one anybody knows.
func (t *Tracker) Reseed(frame core.WindowState) {
	t.lastPos = frame
}

// stranded reports whether a frame is unrecoverable on the displays present
// right now, and false whenever there is no way to tell.
func (t *Tracker) stranded(frame core.WindowState) bool {
	if t.screens == nil {
		return false
	}
	return Stranded(frame, t.screens())
}

// Capture reads the window's current geometry and state, and updates the
// remembered normal-state frame. Must be called on the main thread.
//
// Returns (zero, false) when there is nothing worth writing: Wails' Size() and
// Position() return zeros when the native window isn't constructed yet (early
// startup) or has been destroyed, and a maximised window with no normal-state
// sample would only write junk for the frame underneath. A frame stranded off
// every display is refused for the same reason — restoring it is what makes a
// window come back invisible, so a window the user rescued by maximising it
// must not persist the very frame it was rescued from. All of these leave the
// stored frame alone rather than clobbering the user's real geometry.
func (t *Tracker) Capture(win Window) (core.WindowState, bool) {
	// Windows parks a minimised HWND outside the virtual desktop. Position() sees
	// those parking coordinates, not the frame Windows will restore, so saving one
	// would strand the next window off-screen. Leave both the store and lastPos
	// untouched until the window has been restored.
	if win.IsMinimised() {
		return core.WindowState{}, false
	}
	maximised := win.IsMaximised()
	fullscreen := win.IsFullscreen()
	if !maximised && !fullscreen {
		x, y := win.Position()
		w, h := win.Size()
		if w <= 0 || h <= 0 {
			return core.WindowState{}, false
		}
		frame := core.WindowState{X: x, Y: y, Width: w, Height: h, HasPos: true}
		if t.stranded(frame) {
			return core.WindowState{}, false
		}
		t.lastPos = frame
	} else if !t.lastPos.HasPos || t.stranded(t.lastPos) {
		return core.WindowState{}, false
	}
	return core.WindowState{
		X:          t.lastPos.X,
		Y:          t.lastPos.Y,
		Width:      t.lastPos.Width,
		Height:     t.lastPos.Height,
		HasPos:     t.lastPos.HasPos,
		Maximised:  maximised,
		Fullscreen: fullscreen,
	}, true
}

// Debouncer collapses the many move/resize events Wails fires during one drag
// into a single write, one SaveDebounce after the last of them.
type Debouncer struct {
	ch chan struct{}
}

// NewDebouncer returns a debouncer ready to be triggered; call Run on its own
// goroutine to do the saving.
func NewDebouncer() *Debouncer {
	return &Debouncer{ch: make(chan struct{}, 1)}
}

// Trigger wakes the save loop. Non-blocking, so it is safe to call from an
// event handler on every frame of a drag.
func (d *Debouncer) Trigger() {
	select {
	case d.ch <- struct{}{}:
	default:
	}
}

// Run calls save once per settled burst of triggers, and returns when stop is
// closed. A nil stop channel never fires, which is what a host wants when its
// window lives as long as the process.
func (d *Debouncer) Run(stop <-chan struct{}, save func()) {
	var timerC <-chan time.Time
	for {
		select {
		case <-d.ch:
			timerC = time.After(SaveDebounce)
		case <-timerC:
			timerC = nil
			save()
		case <-stop:
			return
		}
	}
}

// Placement is a saved frame translated into the window options Wails needs at
// construction time. Position and state have to be right before the page first
// loads — applying them later loses to Wails' own centring default.
type Placement struct {
	Width, Height int
	X, Y          int
	Position      application.WindowStartPosition
	State         application.WindowState
	Screen        *application.Screen
}

// Place turns a saved frame into a Placement, falling back to a centred default
// window for anything the frame doesn't say. A zero WindowState therefore gives
// exactly the first-run placement, which is what a caller with no saved frame
// should pass.
func Place(saved core.WindowState) Placement {
	p := Placement{
		Width:    DefaultWidth,
		Height:   DefaultHeight,
		Position: application.WindowCentered,
		State:    application.WindowStateNormal,
	}
	if saved.Width > 0 && saved.Height > 0 {
		p.Width, p.Height = saved.Width, saved.Height
	}
	if saved.HasPos {
		p.X, p.Y = saved.X, saved.Y
		p.Position = application.WindowXY
	}
	switch {
	case saved.Maximised:
		p.State = application.WindowStateMaximised
	case saved.Fullscreen:
		p.State = application.WindowStateFullscreen
	}
	return p
}

// PlaceVisible restores a saved frame only when enough of its top edge remains
// on a current display to drag it. Absolute desktop coordinates become stale
// when a monitor is removed, an RDP session changes size, or Windows parking
// coordinates were saved by an older build. A stranded frame is centred on the
// primary display and limited to its work area; valid negative coordinates on a
// display left of the primary are retained.
func PlaceVisible(saved core.WindowState, screens []*application.Screen) Placement {
	p := Place(saved)

	// Place answers a window with no saved size with the layout's minimum,
	// because it has no display to ask. Here there is one.
	if saved.Width <= 0 || saved.Height <= 0 {
		p.Width, p.Height = DefaultSize(screens)
	}

	// Size first, and for every placement rather than only a stranded one: a
	// frame can be perfectly reachable and still be wider than the display it
	// opens on — the default is sized for the layout it has to hold, and a saved
	// frame outlives the monitor it was saved on.
	if capped, changed := CapToWorkArea(frameOf(p), screens); changed {
		p.Width, p.Height = capped.Width, capped.Height
		if p.Position == application.WindowXY {
			p.X, p.Y = capped.X, capped.Y
		}
	}

	if p.Position != application.WindowXY || !Stranded(frameOf(p), screens) {
		return p
	}

	primary := primaryScreen(screens)
	if primary == nil {
		return p
	}
	if primary.WorkArea.Width > 0 && p.Width > primary.WorkArea.Width {
		p.Width = primary.WorkArea.Width
	}
	if primary.WorkArea.Height > 0 && p.Height > primary.WorkArea.Height {
		p.Height = primary.WorkArea.Height
	}
	p.X, p.Y = 0, 0
	p.Position = application.WindowCentered
	p.Screen = primary
	return p
}

// FitOnScreen moves a frame onto the work area of the screen it lands on,
// without resizing it. For a frame a caller worked out rather than restored —
// a window opened over something the user is already looking at, whose position
// is arithmetic and can therefore run off the edge.
//
// The screen it lands on is the one it mostly covers, so a window opened on the
// second display is fitted to that display rather than dragged home. A frame
// too big for the work area is pinned to its top-left corner and left at its
// size: moving a window is this function's business, resizing one is the
// caller's.
//
// A frame with no position or no size is returned untouched. There is nothing
// to fit, and inventing coordinates would take away the centring default.
func FitOnScreen(frame core.WindowState, screens []*application.Screen) core.WindowState {
	if !frame.HasPos || frame.Width <= 0 || frame.Height <= 0 {
		return frame
	}
	screen := screenUnder(frame, screens)
	if screen == nil {
		return frame
	}
	area := screen.WorkArea
	if area.Width <= 0 || area.Height <= 0 {
		return frame
	}
	frame.X = max(min(frame.X, area.X+area.Width-frame.Width), area.X)
	frame.Y = max(min(frame.Y, area.Y+area.Height-frame.Height), area.Y)
	return frame
}

// CapToWorkArea shrinks a frame that is larger than the work area of the screen
// it lands on, and pulls what is left back inside that area. Reported as
// (frame, true) only when it changed the size, so a caller can log it and
// persist the result.
//
// Oversize is not the same problem as stranding and is not caught by it: the
// header of a window half a display too wide is perfectly visible and perfectly
// draggable, while the right-hand side of the app — where the properties panel
// and the window controls of a frameless window live — is off the edge of the
// screen with no way to bring it back short of resizing the window, which is
// the thing a new user is least likely to think of.
//
// A frame with no size is returned untouched; there is nothing to cap.
func CapToWorkArea(frame core.WindowState, screens []*application.Screen) (core.WindowState, bool) {
	if frame.Width <= 0 || frame.Height <= 0 {
		return frame, false
	}
	screen := screenUnder(frame, screens)
	if screen == nil {
		return frame, false
	}
	area := screen.WorkArea
	if area.Width <= 0 || area.Height <= 0 {
		return frame, false
	}
	width, height := frame.Width, frame.Height
	if width > area.Width {
		width = area.Width
	}
	if height > area.Height {
		height = area.Height
	}
	if width == frame.Width && height == frame.Height {
		return frame, false
	}
	frame.Width, frame.Height = width, height
	return FitOnScreen(frame, screens), true
}

// screenUnder picks the screen a frame mostly lies on, falling back to the
// primary for one that lies on none of them.
func screenUnder(frame core.WindowState, screens []*application.Screen) *application.Screen {
	var best *application.Screen
	bestArea := 0
	for _, screen := range screens {
		if screen == nil {
			continue
		}
		area := screen.WorkArea
		width := min(frame.X+frame.Width, area.X+area.Width) - max(frame.X, area.X)
		height := min(frame.Y+frame.Height, area.Y+area.Height) - max(frame.Y, area.Y)
		if width <= 0 || height <= 0 {
			continue
		}
		if overlap := width * height; overlap > bestArea {
			best, bestArea = screen, overlap
		}
	}
	if best != nil {
		return best
	}
	return primaryScreen(screens)
}

const (
	minVisibleHeaderWidth  = 80
	minVisibleHeaderHeight = 16
	headerHeight           = 40
)

// Stranded reports whether a frame keeps too little of its header on any
// current display for the user to see or drag it — the state in which a window
// is running, painting and answering the keyboard, yet appears to have
// vanished. Absolute desktop coordinates reach it when a monitor is unplugged,
// an RDP session reconnects smaller, or a minimised window's parking
// coordinates get saved.
//
// A frame with no position, and any frame at all when no displays are known,
// is never stranded. "Cannot tell" has to answer no: a caller that refused work
// on an empty screen list would refuse it every time one was unavailable.
func Stranded(frame core.WindowState, screens []*application.Screen) bool {
	if !frame.HasPos || len(screens) == 0 {
		return false
	}
	height := min(frame.Height, headerHeight)
	for _, screen := range screens {
		if screen == nil {
			continue
		}
		area := screen.WorkArea
		left := max(frame.X, area.X)
		right := min(frame.X+frame.Width, area.X+area.Width)
		top := max(frame.Y, area.Y)
		bottom := min(frame.Y+height, area.Y+area.Height)
		if right-left >= minVisibleHeaderWidth && bottom-top >= minVisibleHeaderHeight {
			return false
		}
	}
	return true
}

// RescueFrame centres a stranded frame on the primary display's work area,
// shrinking it to fit. Reported as (frame, true) only when it actually moved
// something, so a caller can log the rescue and persist the result; a frame
// that is fine where it is, or one with no display to be moved onto, comes
// back untouched and false.
//
// This is the counterpart to PlaceVisible for a window that already exists.
// PlaceVisible answers "where do I open this", from a saved frame and before
// there is a window; RescueFrame answers "is this window reachable", from the
// live frame of one that is already up.
func RescueFrame(frame core.WindowState, screens []*application.Screen) (core.WindowState, bool) {
	if !Stranded(frame, screens) {
		return frame, false
	}
	primary := primaryScreen(screens)
	if primary == nil {
		return frame, false
	}
	area := primary.WorkArea
	if area.Width <= 0 || area.Height <= 0 {
		return frame, false
	}
	if frame.Width > area.Width {
		frame.Width = area.Width
	}
	if frame.Height > area.Height {
		frame.Height = area.Height
	}
	frame.X = area.X + (area.Width-frame.Width)/2
	frame.Y = area.Y + (area.Height-frame.Height)/2
	return frame, true
}

// frameOf reads a placement back as the frame it will put on screen, so the
// same visibility rule serves a placement and a live window.
func frameOf(p Placement) core.WindowState {
	return core.WindowState{X: p.X, Y: p.Y, Width: p.Width, Height: p.Height, HasPos: true}
}

// Seed reads a placement back as the frame to seed a Tracker with: where the
// window is actually being opened, rather than what was saved. The two differ
// exactly when the saved frame was refused, and seeding the refused frame is
// what let a window rescued by maximising it persist the frame it was rescued
// from — restoring the user to the same invisible window next launch.
//
// A centred placement has no coordinates to offer, since where it lands is the
// platform's answer rather than ours, so it seeds a size and no position. A
// window that then comes up maximised declines to write a restore frame until
// the user restores it, which is the honest result: nothing true is known yet.
func Seed(p Placement) core.WindowState {
	if p.Position != application.WindowXY {
		return core.WindowState{Width: p.Width, Height: p.Height}
	}
	return frameOf(p)
}

func primaryScreen(screens []*application.Screen) *application.Screen {
	for _, screen := range screens {
		if screen != nil && screen.IsPrimary {
			return screen
		}
	}
	for _, screen := range screens {
		if screen != nil {
			return screen
		}
	}
	return nil
}

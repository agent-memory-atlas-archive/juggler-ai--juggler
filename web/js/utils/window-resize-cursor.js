//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Edge-resize cursor marker for the frameless desktop window: records on
 * `<html>`, as `data-resize-cursor`, that the pointer is over a window-resize
 * edge, so the CSS in layout/window-chrome.css can let that cursor through.
 *
 * A frameless window has no native resize border, so the runtime hit-tests the
 * pointer itself and reports a hit by writing the cursor to
 * `document.body.style.cursor`. That alone is invisible: `cursor` is inherited,
 * so any element with a cursor of its own — every button's `pointer`, the
 * composer's `text`, the header's `default`, 170-odd declarations in all —
 * overrides it, and the edges that matter are all covered by one. The window
 * could be resized, but nothing said so, which reads as no resize edge at all.
 *
 * So this marks the state and window-chrome.css spends one `!important` on it. The
 * marker is a gate, not data: the cursor itself still comes from `body`, which
 * is why the rule can be a single `inherit` rather than a mapping of the eight
 * edge cursors.
 *
 * Why read the runtime's verdict instead of hit-testing the pointer here: the
 * band's size is the runtime's to know (the app sizes it through the
 * `system.resizeHandle*` flags — see resizeHandleFlags in
 * cmd/juggler-app/app_state.go), and a second copy of the geometry would be a
 * second thing to keep in step, wrong in exactly the places that are hardest to
 * notice. The runtime's listener is registered in the capture phase, so by the
 * time this one runs for the same event the verdict is already written.
 *
 * Inert in a browser tab: there is no window to resize and nothing writes the
 * body cursor, so the marker never appears.
 * @module utils/window-resize-cursor
 */

import { isDesktopWindow } from '../../sdk/lib/window-control.js';

/** Suffix shared by all eight edge cursors (`ew-`, `ns-`, `nwse-`, `nesw-`). */
const RESIZE_CURSOR_SUFFIX = '-resize';

/**
 * Record whether the pointer is over a resize edge, given the cursor the
 * runtime has hit-tested it to. Exported for tests: the browser-test lanes
 * barely paint and deliver no frames, so they drive this directly rather than
 * through a real pointer.
 * @param {string} cursor - The runtime's verdict (`document.body.style.cursor`).
 * @returns {boolean} True when the pointer is over a resize edge.
 */
export function setResizeCursorFlag(cursor) {
  const root = document.documentElement;
  const onEdge = typeof cursor === 'string' && cursor.endsWith(RESIZE_CURSOR_SUFFIX);
  if (onEdge) root.dataset.resizeCursor = cursor;
  else delete root.dataset.resizeCursor;
  return onEdge;
}

/**
 * Follow the runtime's hit-test for the lifetime of the window.
 * @returns {void}
 * @private
 */
function watchResizeCursor() {
  if (!isDesktopWindow()) return;

  // Only written when it changes. The marker gates a universal selector, so
  // flipping it restyles the document — fine when entering or leaving an edge,
  // wasteful once per mousemove for the whole time the pointer tracks along one.
  let last = '';
  window.addEventListener('mousemove', () => {
    const cursor = document.body.style.cursor;
    if (cursor === last) return;
    last = cursor;
    setResizeCursorFlag(cursor);
  }, { passive: true });
}

watchResizeCursor();

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The frameless window's resize edges stay visible.
 *
 * A frameless window has no native resize border, so the Wails runtime
 * hit-tests the pointer itself and reports a hit by setting the cursor on
 * <body>. `cursor` inherits, so that report is invisible wherever an element
 * sets a cursor of its own — which along the window edges is nearly everywhere:
 * every button's `pointer`, the composer's `text`, the header's `default`. The
 * window resized perfectly well; nothing said so.
 *
 * utils/window-resize-cursor.js marks the state on <html> and window-chrome.css spends
 * one `!important` on it. These tests pin both halves:
 *
 *   1. The marker tracks the runtime's verdict, and clears when it goes.
 *   2. With the marker set, an element carrying its own `cursor` really does
 *      show the resize cursor — the assertion the CSS rule exists for, made
 *      against the computed value rather than the rule text.
 *
 * The marker is driven directly rather than through a pointer: a browser-test
 * lane is an offscreen iframe with no pointer to move, and the module's own
 * listener stands down outside a desktop window anyway.
 * @module unit-tests/window-resize-cursor-test
 */

import { assert } from '../utilities/test-helpers.js';
import { setResizeCursorFlag } from '../../js/utils/window-resize-cursor.js';

/** The corner cursor the runtime reports for a bottom-right/top-left grab. */
const CORNER_CURSOR = 'nwse-resize';

/**
 * Mount a button carrying its own `cursor` — the thing that masks the runtime's
 * report in the places a user actually aims at.
 * @returns {{button: HTMLButtonElement, container: HTMLElement}} The button and the container to remove.
 */
function mountCursorOwner() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0;';
  const button = document.createElement('button');
  button.style.cursor = 'pointer';
  button.textContent = 'aim here';
  container.appendChild(button);
  document.body.appendChild(container);
  return { button, container };
}

/**
 * Run the window resize-cursor suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];

  const root = document.documentElement;
  const hadMarker = root.dataset.resizeCursor;
  const bodyCursor = document.body.style.cursor;

  // ── Test 1: the marker tracks the runtime's verdict ───────────────────────
  {
    try {
      assert(setResizeCursorFlag(CORNER_CURSOR) === true,
        'a resize cursor must be recognised as an edge');
      assert(root.dataset.resizeCursor === CORNER_CURSOR,
        `the edge must be marked on <html>, got ${JSON.stringify(root.dataset.resizeCursor)}`);

      // Every ordinary cursor, and the empty string the runtime restores, must
      // clear it — the marker gates a universal selector, so a stuck one would
      // hold the whole document's cursor hostage.
      for (const cursor of ['', 'auto', 'pointer', 'text', 'default']) {
        assert(setResizeCursorFlag(cursor) === false, `${JSON.stringify(cursor)} is not a resize edge`);
        assert(root.dataset.resizeCursor === undefined,
          `${JSON.stringify(cursor)} must clear the marker, got ${JSON.stringify(root.dataset.resizeCursor)}`);
      }

      // All eight edges report through the one marker.
      for (const cursor of ['ew-resize', 'ns-resize', 'nwse-resize', 'nesw-resize']) {
        assert(setResizeCursorFlag(cursor) === true, `${cursor} is a resize edge`);
        assert(root.dataset.resizeCursor === cursor, `${cursor} must be marked`);
      }
      passed++;
    } catch (e) {
      failed++;
      errors.push('marker-tracks-verdict: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setResizeCursorFlag('');
    }
  }

  // ── Test 2: the marker actually beats an element's own cursor ─────────────
  {
    const { button, container } = mountCursorOwner();
    try {
      // Baseline: the button wins, which is the whole problem.
      document.body.style.cursor = CORNER_CURSOR;
      setResizeCursorFlag('');
      assert(getComputedStyle(button).cursor === 'pointer',
        'without the marker the element keeps its own cursor (baseline for the next assertion)');

      setResizeCursorFlag(CORNER_CURSOR);
      assert(getComputedStyle(button).cursor === CORNER_CURSOR,
        `with the marker set, the resize cursor must reach an element that sets its own — got ${getComputedStyle(button).cursor}`);

      // Leaving the edge hands the button its cursor back.
      setResizeCursorFlag('');
      document.body.style.cursor = '';
      assert(getComputedStyle(button).cursor === 'pointer',
        `leaving the edge must restore the element's own cursor — got ${getComputedStyle(button).cursor}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('marker-overrides-own-cursor: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // Leave the document as we found it: the marker is global state.
  if (hadMarker === undefined) delete root.dataset.resizeCursor;
  else root.dataset.resizeCursor = hadMarker;
  document.body.style.cursor = bodyCursor;

  return { passed, failed, errors };
}

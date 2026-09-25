//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The shared reorder drag (`utils/reorder-drag.js`), which both the
 * conversation sidebar and the pinboard tab strip use.
 *
 * The module is exercised directly on plain boxes rather than through either
 * component: what is under test is the gesture and the geometry, and standing
 * up a session to reach them would test neither. The invariants:
 *
 *   1. A press that travels less than the threshold is not a drag — no clone,
 *      no placeholder, nothing committed. Past it, a clone appears.
 *   2. On a strip that does not wrap, the drop position is the number of
 *      midpoints the pointer has passed along the axis.
 *   3. On a strip that WRAPS, it is read in reading order across rows — the
 *      case the pinboard's marker-based predecessor could express only as a
 *      left/right hint, and the reason this module exists.
 *   4. A drag that lands where it started commits nothing.
 *   5. Release leaves no inline transform behind on any item.
 *   6. `pointercancel` abandons the gesture and puts the item back.
 *   7. The pointer is captured on the element the click will land on, and not
 *      before the press is a drag.
 *
 * Indices are asserted through `onCommit`, whose `toIndex` counts the strip
 * WITHOUT the dragged item — the convention the server's `move` op and the
 * conversation bar's reorder both already take.
 * @module unit-tests/reorder-drag-test
 */

import { assert } from '../utilities/test-helpers.js';
import { startReorderDrag } from '../../js/utils/reorder-drag.js';

/** Item box size, in CSS pixels, for the stand-in strips below. */
const ITEM_W = 100;
const ITEM_H = 30;

/** The clone must leave the flow, or it displaces the very items being measured. */
const GHOST_CSS = '.rd-ghost { position: fixed; pointer-events: none; }';

/**
 * Stand up a strip of boxes and a host for the clone to sit on.
 *
 * The strip is placed well down the page so a clone anchored to the wrong box
 * lands visibly wrong rather than coincidentally right, and the items are given
 * hard sizes so the geometry under test is the module's and not the browser's
 * opinion of a div.
 * @param {{count: number, wrap: boolean, width?: number}} opts - How many boxes, whether the strip wraps, and how wide it may be.
 * @returns {{strip: HTMLElement, host: HTMLElement, items: HTMLElement[], teardown: () => void}} The strip, the clone's host, its boxes, and a teardown.
 */
function mountStrip({ count, wrap, width = ITEM_W }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:200px;';
  const style = document.createElement('style');
  style.textContent = GHOST_CSS;
  host.appendChild(style);

  const strip = document.createElement('div');
  strip.style.cssText = `display:flex;gap:0;margin:0;padding:0;width:${width}px;`
    + (wrap ? 'flex-flow:row wrap;' : 'flex-direction:column;');
  host.appendChild(strip);
  document.body.appendChild(host);

  /** @type {HTMLElement[]} */
  const items = [];
  for (let i = 0; i < count; i++) {
    const box = document.createElement('div');
    box.dataset.id = String.fromCharCode(97 + i);
    box.style.cssText = `flex:0 0 auto;box-sizing:border-box;width:${ITEM_W}px;height:${ITEM_H}px;`;
    strip.appendChild(box);
    items.push(box);
  }
  return { strip, host, items, teardown: () => host.remove() };
}

/**
 * Run one gesture over a mounted strip and report what it committed.
 *
 * Synthetic pointers do not exist as far as pointer capture is concerned, so
 * the real calls would throw NotFoundError mid-drag.
 * @param {object} opts - The gesture.
 * @param {HTMLElement} opts.item - The box to grab.
 * @param {HTMLElement} opts.strip - The strip it belongs to.
 * @param {HTMLElement} opts.host - Where the clone is parked.
 * @param {boolean} opts.wrap - Whether the strip wraps.
 * @param {'x'|'y'|'xy'} opts.axis - Which way the clone follows.
 * @param {Array<{x: number, y: number}>} opts.moves - Pointer positions to visit, in client coordinates.
 * @param {'up'|'cancel'|'none'} [opts.end] - How the gesture finishes.
 * @param {() => void} [opts.afterMoves] - Runs once the pointer has travelled, before the gesture ends — for disturbing the strip mid-gesture.
 * @returns {{commits: Array<{fromIndex: number, toIndex: number}>, ends: Array<{dragged: boolean, moved: boolean}>, handle: any}} What was committed, how it ended, and the gesture handle.
 */
function drag({ item, strip, host, wrap, axis, moves, end = 'up', afterMoves }) {
  item.setPointerCapture = () => {};
  item.releasePointerCapture = () => {};

  const rest = item.getBoundingClientRect();
  const startX = rest.left + rest.width / 2;
  const startY = rest.top + rest.height / 2;

  /** @type {Array<{fromIndex: number, toIndex: number}>} */
  const commits = [];
  /** @type {Array<{dragged: boolean, moved: boolean}>} */
  const ends = [];
  const handle = startReorderDrag(
    /** @type {any} */ ({ clientX: startX, clientY: startY, pointerId: 1 }),
    {
      item,
      items: () => /** @type {HTMLElement[]} */ (
        Array.from(strip.children).filter((el) => !el.classList.contains('rd-ghost'))
      ),
      strip,
      ghostHost: host,
      axis,
      wrap,
      classes: { ghost: 'rd-ghost', source: 'rd-source', dragging: 'rd-dragging' },
      onCommit: ({ fromIndex, toIndex }) => commits.push({ fromIndex, toIndex }),
      onDragEnd: ({ dragged, moved }) => ends.push({ dragged, moved }),
    }
  );

  for (const move of moves) {
    document.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, buttons: 1, clientX: move.x, clientY: move.y, bubbles: true,
    }));
  }
  afterMoves?.();
  if (end !== 'none') {
    const last = moves[moves.length - 1] || { x: startX, y: startY };
    document.dispatchEvent(new PointerEvent(end === 'up' ? 'pointerup' : 'pointercancel', {
      pointerId: 1, clientX: last.x, clientY: last.y, bubbles: true,
    }));
  }
  return { commits, ends, handle };
}

/**
 * The strip's order, read off the DOM.
 * @param {HTMLElement} strip - The strip.
 * @returns {string} The ids in order, e.g. "bac".
 */
function orderOf(strip) {
  return Array.from(strip.children)
    .filter((el) => !el.classList.contains('rd-ghost') && el.tagName !== 'STYLE')
    .map((el) => /** @type {HTMLElement} */ (el).dataset.id || '')
    .join('');
}

/**
 * Run the reorder-drag suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => void} body - The check.
   */
  const run = (label, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('a press short of the threshold is not a drag', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const rest = item.getBoundingClientRect();
      const { commits, handle } = drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: rest.left + 4, y: rest.top + rest.height / 2 + 4 }],
      });
      assert(!handle.isActive(), 'a 4px press must not arm the drag');
      assert(!host.querySelector('.rd-ghost'), 'a press short of the threshold must make no clone');
      assert(!item.classList.contains('rd-source'), 'a press short of the threshold must not hide the item');
      assert(commits.length === 0, 'a press short of the threshold must commit nothing');
      assert(orderOf(strip) === 'abc', `the strip must be untouched, got "${orderOf(strip)}"`);
    } finally {
      teardown();
    }
  });

  // The click that selects a tab arrives AFTER pointerup, so anything the
  // gesture does to the DOM on release happens while the browser is still
  // deciding whether to fire it. Taking the item out and putting it straight
  // back — which is what insertBefore does even when the node is already there —
  // loses the click entirely and restarts every animation on the element. A
  // press that never became a drag moved nothing, so it has nothing to undo.
  // A gesture that abandons its move puts the item back where it came from,
  // in front of whatever followed it at the press. That neighbour can be gone
  // by then — the conversation it named was binned in another window — and
  // insertBefore against a node that is no longer a child throws. Everything
  // after it is the tidying up: the clone would stay on screen and the owner's
  // "a drag is in progress" flag would never be lowered, so the strip would
  // stop reconciling for the rest of the session.
  run('a home anchor removed mid-drag still lets the gesture finish', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const follower = /** @type {HTMLElement} */ (items[1]);
      const rest = item.getBoundingClientRect();
      const home = { x: rest.left + rest.width / 2, y: rest.top + rest.height / 2 };

      const { ends } = drag({
        item, strip, host, wrap: false, axis: 'y',
        // Out past the threshold, then back into its own slot, so the gesture
        // is armed but commits nothing and takes the restore path.
        moves: [{ x: home.x, y: home.y + ITEM_H * 1.5 }, home],
        afterMoves: () => follower.remove(),
      });

      assert(ends.length === 1, 'the gesture must report that it ended');
      assert(!host.querySelector('.rd-ghost'),
        'the clone must be cleaned up even though the item could not be put back');
      assert(!item.classList.contains('rd-source'),
        'the dragged item must be shown again even though its anchor was gone');
      assert(document.body.contains(item), 'the dragged item must still be in the document');
    } finally {
      teardown();
    }
  });

  run('a press that never became a drag leaves the DOM alone', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    const observer = new MutationObserver(() => {});
    try {
      const item = /** @type {HTMLElement} */ (items[1]);
      const rest = item.getBoundingClientRect();
      observer.observe(strip, { childList: true });
      drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: rest.left + 2, y: rest.top + rest.height / 2 + 2 }],
      });
      const churn = observer.takeRecords();
      assert(churn.length === 0,
        `releasing a press must not move any tab in or out of the strip, got ${churn.length} childList mutations`);
    } finally {
      observer.disconnect();
      teardown();
    }
  });

  // A strip whose item is a wrapper around the thing that is actually clickable
  // — the pinboard's tab is a button plus a bin — decides the fate of its own
  // click here. The browser sends the click to the common ancestor of the press
  // and the release, and pointer capture is what the release retargets to: take
  // it on the wrapper and the click lands on the wrapper, where nothing is
  // listening, so the tab flashes and never selects. Synthetic pointers cannot
  // be captured at all (the real call throws NotFoundError, which the module
  // swallows), so what is asserted is where the module asks, not the click.
  run('the pointer is captured where the click will land, and only once it is a drag', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[1]);
      const button = document.createElement('button');
      button.style.cssText = 'width:100%;height:100%;';
      item.appendChild(button);

      /** @type {string[]} */
      const captured = [];
      /** @type {string[]} */
      const released = [];
      for (const [name, el] of /** @type {Array<[string, HTMLElement]>} */ ([['wrapper', item], ['button', button]])) {
        el.setPointerCapture = () => captured.push(name);
        el.releasePointerCapture = () => released.push(name);
      }

      const rest = item.getBoundingClientRect();
      const startX = rest.left + rest.width / 2;
      const startY = rest.top + rest.height / 2;
      startReorderDrag(
        /** @type {any} */ ({ clientX: startX, clientY: startY, pointerId: 1 }),
        {
          item,
          captureTarget: button,
          items: () => /** @type {HTMLElement[]} */ (
            Array.from(strip.children).filter((el) => !el.classList.contains('rd-ghost'))
          ),
          strip,
          ghostHost: host,
          axis: 'y',
          classes: { ghost: 'rd-ghost', source: 'rd-source', dragging: 'rd-dragging' },
        }
      );

      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, buttons: 1, clientX: startX, clientY: startY + 2, bubbles: true,
      }));
      assert(captured.length === 0,
        `a press short of the threshold must take no capture, took ${captured.join(', ')}`);

      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, buttons: 1, clientX: startX, clientY: startY + 8, bubbles: true,
      }));
      assert(captured.join(',') === 'button',
        `the drag must capture on the click target alone, captured on ${captured.join(', ') || 'nothing'}`);

      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, clientX: startX, clientY: startY + 8, bubbles: true,
      }));
      assert(released.join(',') === 'button',
        `release must give the pointer back where it was taken, gave it back on ${released.join(', ') || 'nothing'}`);
    } finally {
      teardown();
    }
  });

  run('a press past the threshold lifts a clone', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const rest = item.getBoundingClientRect();
      drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: rest.left, y: rest.top + rest.height / 2 + 6 }],
        end: 'none',
      });
      const ghost = host.querySelector('.rd-ghost');
      assert(!!ghost, 'a 6px press must lift a clone');
      assert(item.classList.contains('rd-source'), 'the dragged item must be left as a placeholder');
      assert(strip.classList.contains('rd-dragging'), 'the strip must be marked while a drag is live');
      // Put the gesture away so its document listeners don't outlive the test.
      document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
    } finally {
      teardown();
    }
  });

  run('a column reads the drop from midpoints passed', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const b = /** @type {HTMLElement} */ (items[1]);
      const bBox = b.getBoundingClientRect();
      // Past b's midpoint, short of c's: a lands after b, at index 1 of [b, c].
      const { commits } = drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: bBox.left + 10, y: bBox.top + bBox.height / 2 + 4 }],
      });
      assert(commits.length === 1, `one commit expected, got ${commits.length}`);
      assert(commits[0]?.fromIndex === 0, `fromIndex must be 0, got ${commits[0]?.fromIndex}`);
      assert(commits[0]?.toIndex === 1, `toIndex must be 1, got ${commits[0]?.toIndex}`);
      assert(orderOf(strip) === 'bac', `the strip must show the result, got "${orderOf(strip)}"`);
    } finally {
      teardown();
    }
  });

  // Two per row: a b / c d. Dropping at the START of the second row is what
  // separates reading order from a bare left/right test — the pointer is to the
  // LEFT of everything on row 0, so an x-only reading puts it at the very front
  // of the board, while reading order puts it where the eye says it is, between
  // b and c.
  run('a wrapping strip reads a drop onto the next row in reading order', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 4, wrap: true, width: ITEM_W * 2 });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const c = /** @type {HTMLElement} */ (items[2]);
      const cBox = c.getBoundingClientRect();
      assert(cBox.top >= items[1].getBoundingClientRect().bottom,
        'the fixture must actually wrap onto a second row');
      const { commits } = drag({
        item, strip, host, wrap: true, axis: 'xy',
        moves: [{ x: cBox.left + 5, y: cBox.top + cBox.height / 2 }],
      });
      assert(commits.length === 1, `one commit expected, got ${commits.length}`);
      assert(commits[0]?.toIndex === 1,
        `a drop at the head of row two must give index 1, got ${commits[0]?.toIndex}`);
      assert(orderOf(strip) === 'bacd', `the strip must show the result, got "${orderOf(strip)}"`);
    } finally {
      teardown();
    }
  });

  run('a wrapping strip drops past the last tab at the end', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 4, wrap: true, width: ITEM_W * 2 });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const d = /** @type {HTMLElement} */ (items[3]);
      const dBox = d.getBoundingClientRect();
      const { commits } = drag({
        item, strip, host, wrap: true, axis: 'xy',
        moves: [{ x: dBox.left + dBox.width / 2 + 10, y: dBox.top + dBox.height / 2 }],
      });
      assert(commits.length === 1, `one commit expected, got ${commits.length}`);
      assert(commits[0]?.toIndex === 3, `dropping past the last tab must give index 3, got ${commits[0]?.toIndex}`);
      assert(orderOf(strip) === 'bcda', `the strip must show the result, got "${orderOf(strip)}"`);
    } finally {
      teardown();
    }
  });

  // A shift does not happen instantly: the siblings are inverted to where they
  // were and released to animate to where they now are, so for the length of
  // that animation their rects report a position between the two. A pointer
  // reporting faster than the screen redraws asks again while it is running,
  // and an answer read off the animation is an answer about a strip the user
  // stopped looking at — one slot out, for as long as the transition lasts.
  run('a move made while the strip is still animating reads the strip it is animating to', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 4, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const b = /** @type {HTMLElement} */ (items[1]);
      const bBox = b.getBoundingClientRect();
      const { commits } = drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [
          // Past b's midpoint: a lands between b and c, and b starts moving up
          // into the slot a has left.
          { x: bBox.left + 10, y: bBox.top + bBox.height / 2 + 5 },
          // Back up into the slot a is now drawn in, which is the one b is
          // animating out of. Where a is, is where a stays.
          { x: bBox.left + 10, y: bBox.top + 5 },
        ],
      });
      assert(orderOf(strip) === 'bacd',
        `a pointer inside the dragged item's own slot must leave it there, got "${orderOf(strip)}"`);
      assert(commits.length === 1 && commits[0]?.toIndex === 1,
        `and commit that slot, got ${JSON.stringify(commits)}`);
    } finally {
      teardown();
    }
  });

  run('a drag that lands where it started commits nothing', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[1]);
      const rest = item.getBoundingClientRect();
      // Past the threshold, but still inside its own slot.
      const { commits } = drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: rest.left, y: rest.top + rest.height / 2 + 6 }],
      });
      assert(commits.length === 0, `a drag back to the start must commit nothing, got ${commits.length}`);
      assert(orderOf(strip) === 'abc', `the strip must be unchanged, got "${orderOf(strip)}"`);
    } finally {
      teardown();
    }
  });

  // Not every gesture gets its release. A native context menu, an OS window
  // switch, or a pointer leaving the webview takes the pointerup with it, and a
  // gesture still waiting for one arms on the next stray movement — the item
  // then follows a pointer with nothing held down, and nothing is coming to put
  // it back. A move reporting no button is proof the gesture is already over.
  run('a move with nothing held ends a gesture whose release was swallowed', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const c = /** @type {HTMLElement} */ (items[2]);
      const cBox = c.getBoundingClientRect();
      const { commits, handle } = drag({
        item, strip, host, wrap: false, axis: 'y', moves: [], end: 'none',
      });

      const far = { x: cBox.left, y: cBox.top + cBox.height / 2 + 4 };
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, clientX: far.x, clientY: far.y, bubbles: true,
      }));
      assert(!handle.isActive(), 'a move with no button held must not arm the drag');
      assert(!host.querySelector('.rd-ghost'), 'a stranded gesture must lift no clone');
      assert(orderOf(strip) === 'abc', `the strip must be untouched, got "${orderOf(strip)}"`);

      // And it is over for good: a later move with a button down belongs to
      // whatever the user does next, not to this gesture.
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, buttons: 1, clientX: far.x, clientY: far.y, bubbles: true,
      }));
      assert(!handle.isActive(), 'a gesture let go must stay let go');
      assert(commits.length === 0, `a stranded gesture must commit nothing, got ${commits.length}`);
    } finally {
      teardown();
    }
  });

  run('release leaves nothing behind', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const c = /** @type {HTMLElement} */ (items[2]);
      const cBox = c.getBoundingClientRect();
      drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: cBox.left, y: cBox.top + cBox.height / 2 + 4 }],
      });
      assert(!host.querySelector('.rd-ghost'), 'the clone must go on release');
      assert(!item.classList.contains('rd-source'), 'the placeholder mark must go on release');
      assert(!strip.classList.contains('rd-dragging'), 'the strip mark must go on release');
      for (const el of items) {
        assert(!el.style.transform, `${el.dataset.id} kept an inline transform: "${el.style.transform}"`);
        assert(!el.style.transition, `${el.dataset.id} kept an inline transition: "${el.style.transition}"`);
      }
    } finally {
      teardown();
    }
  });

  run('a cancelled drag puts the item back', () => {
    const { strip, host, items, teardown } = mountStrip({ count: 3, wrap: false });
    try {
      const item = /** @type {HTMLElement} */ (items[0]);
      const c = /** @type {HTMLElement} */ (items[2]);
      const cBox = c.getBoundingClientRect();
      const { commits } = drag({
        item, strip, host, wrap: false, axis: 'y',
        moves: [{ x: cBox.left, y: cBox.top + cBox.height / 2 + 4 }],
        end: 'cancel',
      });
      assert(commits.length === 0, 'a cancelled drag must commit nothing');
      assert(orderOf(strip) === 'abc', `a cancelled drag must restore the order, got "${orderOf(strip)}"`);
      assert(!host.querySelector('.rd-ghost'), 'a cancelled drag must still take its clone away');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

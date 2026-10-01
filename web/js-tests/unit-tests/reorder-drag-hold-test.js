//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Long-press to lift: how a finger reorders a strip without a grip.
 *
 * A touch or pen press given the `hold` option is not yet a drag. Held still for
 * the hold time it lifts — the clone appears and the page stops scrolling under
 * it — and from then on it is an ordinary drag. A finger that moves past the
 * tolerance first was scrolling, and the gesture steps aside without a trace.
 * A lift released where it was is the long-press itself, and is reported so the
 * strip can open its menu. A mouse is unaffected: it has no scroll to tell a
 * drag apart from, and drags past the threshold as it always did.
 *
 * Timing is taken out of it: a hold of 0 lifts at the press, and a hold of a
 * minute is one the test can move inside.
 * @module unit-tests/reorder-drag-hold-test
 */

import { assert } from '../utilities/test-helpers.js';
import { startReorderDrag, holdGestureLive, holdLifted } from '../../js/utils/reorder-drag.js';

/**
 * A three-item strip, mounted, with pointer capture stubbed (a synthetic
 * pointer cannot be captured).
 * @returns {{strip: HTMLElement, items: HTMLElement[], teardown: () => void}} The strip.
 */
function mountStrip() {
  const strip = document.createElement('ul');
  strip.style.cssText = 'position:absolute;left:0;top:0;width:200px;margin:0;padding:0;list-style:none;';
  strip.innerHTML = ['a', 'b', 'c'].map(id => `<li style="height:30px" data-id="${id}">${id}</li>`).join('');
  document.body.appendChild(strip);
  const items = /** @type {HTMLElement[]} */ (Array.from(strip.children));
  for (const item of items) {
    /** @type {any} */ (item).setPointerCapture = () => {};
    /** @type {any} */ (item).releasePointerCapture = () => {};
  }
  return { strip, items, teardown: () => strip.remove() };
}

/**
 * @param {string} type - The pointer event type.
 * @param {string} pointerType - 'touch', 'pen' or 'mouse'.
 * @param {number} clientY - Where.
 * @returns {PointerEvent} The event.
 */
function pointer(type, pointerType, clientY) {
  return new PointerEvent(type, {
    pointerId: 3, pointerType, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: 50, clientY, bubbles: true, cancelable: true
  });
}

/**
 * Begin a gesture on the first item and report what it did.
 * @param {HTMLElement} strip - The strip.
 * @param {HTMLElement[]} items - Its items.
 * @param {string} pointerType - Who is pressing.
 * @param {number} holdMs - The hold time.
 * @returns {{log: string[], held: any[]}} What the gesture reported, as it reports it.
 */
function press(strip, items, pointerType, holdMs) {
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const held = [];
  startReorderDrag(pointer('pointerdown', pointerType, 15), {
    item: items[0],
    items: () => /** @type {HTMLElement[]} */ (Array.from(strip.children)).filter(el => !el.classList.contains('drag-ghost')),
    strip,
    ghostHost: document.body,
    hold: { ms: holdMs, tolerancePx: 8, onHeldRelease: (point) => held.push(point) },
    onDragStart: () => log.push('start'),
    onDragEnd: ({ dragged, moved }) => log.push(`end dragged=${dragged} moved=${moved}`),
    onCommit: () => log.push('commit')
  });
  return { log, held };
}

/**
 * A touchmove as the browser sends one, cancelable, and whether anything
 * cancelled it.
 * @returns {boolean} True if the page's scroll was blocked.
 */
function touchmoveBlocked() {
  const move = new Event('touchmove', { bubbles: true, cancelable: true });
  document.body.dispatchEvent(move);
  return move.defaultPrevented;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {(strip: HTMLElement, items: HTMLElement[]) => void} body - The check, given a fresh strip.
   */
  const check = (name, body) => {
    const { strip, items, teardown } = mountStrip();
    try {
      body(strip, items);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      document.dispatchEvent(pointer('pointercancel', 'touch', 0));
      teardown();
    }
  };

  check('a finger that moves before the hold is scrolling, and the gesture steps aside', (strip, items) => {
    const { log } = press(strip, items, 'touch', 60000);
    assert(holdGestureLive(), 'a held press is live from the moment it lands');
    assert(!holdLifted(), 'but has not lifted: a drawer under it may still swipe from it');
    document.dispatchEvent(pointer('pointermove', 'touch', 15 + 20));
    assert(!holdGestureLive(), 'moving past the tolerance first ends it');
    assert(!touchmoveBlocked(), 'and leaves the page free to scroll');
    assert(!document.querySelector('.drag-ghost'), 'nothing was lifted');
    assert(log.join('|') === 'end dragged=false moved=false', `it never became a drag, got ${log.join('|')}`);
  });

  check('a finger that stays inside the tolerance is still holding', (strip, items) => {
    const { log } = press(strip, items, 'touch', 60000);
    document.dispatchEvent(pointer('pointermove', 'touch', 15 + 4));
    assert(holdGestureLive(), 'a tremor is not a scroll');
    assert(log.length === 0, `and nothing has happened yet, got ${log.join('|')}`);
  });

  check('held still, it lifts, and the page stops scrolling under it', (strip, items) => {
    const { log } = press(strip, items, 'touch', 0);
    assert(log.join('|') === 'start', `the hold lifts it at once, got ${log.join('|')}`);
    assert(!!document.querySelector('.drag-ghost'), 'the clone is up under the finger');
    assert(holdLifted(), 'and it has lifted, so nothing under it may take the gesture');
    assert(touchmoveBlocked(), 'and a touchmove is no longer the page\'s to scroll');
    document.dispatchEvent(pointer('pointermove', 'touch', 75));
    document.dispatchEvent(pointer('pointerup', 'touch', 75));
    assert(log.join('|') === 'start|commit|end dragged=true moved=true', `then it drags like any drag, got ${log.join('|')}`);
    assert(!touchmoveBlocked(), 'and the page scrolls again once it is over');
    assert(!holdLifted(), 'nor is anything lifted any more');
  });

  check('a lift let go where it was is the long-press, reported for the menu', (strip, items) => {
    const { log, held } = press(strip, items, 'touch', 0);
    document.dispatchEvent(pointer('pointerup', 'touch', 16));
    assert(log.join('|') === 'start|end dragged=true moved=false', `nothing moved, got ${log.join('|')}`);
    assert(held.length === 1 && held[0].clientY === 16, `the release is reported with where it was, got ${JSON.stringify(held)}`);
    assert(!holdGestureLive(), 'and the gesture is over');
  });

  check('a pen holds as a finger does', (strip, items) => {
    press(strip, items, 'pen', 60000);
    assert(holdGestureLive(), 'a pen press waits for the hold');
  });

  check('a mouse ignores the hold and drags past the threshold', (strip, items) => {
    const { log, held } = press(strip, items, 'mouse', 60000);
    assert(!holdGestureLive(), 'a mouse press is not a hold');
    document.dispatchEvent(pointer('pointermove', 'mouse', 75));
    document.dispatchEvent(pointer('pointerup', 'mouse', 75));
    assert(log.join('|') === 'start|commit|end dragged=true moved=true', `a mouse drags as it always has, got ${log.join('|')}`);
    assert(held.length === 0, 'and a mouse release is never a long-press');
  });

  return { passed, failed, errors };
}

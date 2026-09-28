//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A chain of columns wider than the window says so.
 *
 * Two halves of one affordance. A column cut off by an edge of the container is
 * indistinguishable from a column that ends there — macOS draws its scrollbar as
 * an overlay that fades out at rest, so nothing else is saying it. The container
 * fades the edges it is hiding columns behind, and a column-level scroll leaves
 * a sliver of whatever it moved past rather than parking a boundary flush.
 *
 * Both are only worth having if they are keyed to the truth: a fade on a chain
 * that fits is a false cue, and a peek that moves a view the user was already
 * reading is worse than none. That is what these pin.
 * @module unit-tests/column-edge-test
 */

import { assert } from '../utilities/test-helpers.js';
import { columnScrollDelta } from '../../js/utils/column-resize.js';

/** The container, for the CSS half. 1000px of room, 600 tall, off to one side. */
const CONTAINER_STYLE = 'position:absolute;left:0;top:0;width:1000px;height:600px;';

/**
 * A mounted column container, to read computed style off the real stylesheet.
 * @param {string[]} classes - Classes to put on it.
 * @returns {{container: HTMLElement, teardown: () => void}} The container and the removal of it.
 */
function mountContainer(classes) {
  const container = document.createElement('column-container');
  container.setAttribute('style', CONTAINER_STYLE);
  container.classList.add(...classes);
  const column = document.createElement('conversation-area');
  container.appendChild(column);
  document.body.appendChild(container);
  return { container, teardown: () => container.remove() };
}

/** A container occupying 0…1000 in client coordinates. */
const CONTAINER = { left: 0, right: 1000 };

/** The peek every case below is measured against. */
const PEEK = 24;

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const check = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  check('a column already in view is left exactly where it is', () => {
    // Including one resting flush against the right edge. The peek shapes a
    // movement that was happening anyway — it is never a reason to start one,
    // because the view the user is reading is a view they chose.
    assert(columnScrollDelta({ left: 100, right: 600 }, CONTAINER, PEEK) === 0,
      'a column in the middle of the container does not move');
    assert(columnScrollDelta({ left: 500, right: 1000 }, CONTAINER, PEEK) === 0,
      'nor does one already flush against the right edge');
    assert(columnScrollDelta({ left: 0, right: 500 }, CONTAINER, PEEK) === 0,
      'nor one flush against the left');
  });

  check('a column off the right edge lands short of it, showing the next column', () => {
    // 1200 is 200px past the right edge. Scrolling by exactly 200 would park
    // this column's right edge on the container's, which is the one arrangement
    // that cannot be read: a chain that continues looks like a chain that ends.
    const delta = columnScrollDelta({ left: 700, right: 1200 }, CONTAINER, PEEK);
    assert(delta === 200 + PEEK,
      `it scrolls past the column by a peek, got ${delta} rather than ${200 + PEEK}`);
    const restingRight = 1200 - delta;
    assert(restingRight === CONTAINER.right - PEEK,
      `leaving a peek of the column beyond it showing, got ${CONTAINER.right - restingRight}px`);
  });

  check('a column off the left edge lands short of it too', () => {
    const delta = columnScrollDelta({ left: -300, right: 200 }, CONTAINER, PEEK);
    assert(delta === -300 - PEEK,
      `it scrolls back past the column by a peek, got ${delta} rather than ${-300 - PEEK}`);
    const restingLeft = -300 - delta;
    assert(restingLeft === CONTAINER.left + PEEK,
      `leaving a peek of the column before it showing, got ${restingLeft}px`);
  });

  check('a column too wide to fit lands a peek in from its left edge', () => {
    // Wider than the container, so it can never be fully in view. It anchors
    // where its content starts rather than chasing a right edge it cannot reach.
    const delta = columnScrollDelta({ left: 400, right: 1900 }, CONTAINER, PEEK);
    const restingLeft = 400 - delta;
    assert(restingLeft === CONTAINER.left + PEEK,
      `it anchors a peek in from the left, got ${restingLeft}px`);
    assert(delta < 1900 - CONTAINER.right,
      'rather than scrolling its left edge out of view chasing the right one');
  });

  check('and the peek never scrolls the view backwards to get it', () => {
    // A column overflowing the right edge whose left edge is already inside the
    // peek. Subtracting a peek it does not have would make the delta negative —
    // scrolling left, away from the column it was asked to reveal.
    const delta = columnScrollDelta({ left: 10, right: 1400 }, CONTAINER, PEEK);
    assert(delta >= 0, `the delta never goes backwards, got ${delta}`);
  });

  check('a chain that fits is not faded', () => {
    // No classes, because _updateColumnOverflow sets neither when there is
    // nothing past either edge. A fade that is always there says nothing.
    const { container, teardown } = mountContainer([]);
    try {
      const mask = window.getComputedStyle(container).maskImage;
      assert(mask === 'none',
        `an unmarked container carries no mask at all, got ${mask}`);
    } finally {
      teardown();
    }
  });

  check('a chain with columns past an edge fades that edge, and only that edge', () => {
    const { container, teardown } = mountContainer(['overflow-end']);
    try {
      const style = window.getComputedStyle(container);
      const mask = style.maskImage;
      assert(mask !== 'none' && mask.includes('gradient'),
        `the marked container masks its edge, got ${mask}`);
      assert(style.getPropertyValue('--column-fade-end').trim() !== '',
        'the end stop is opened up');
      assert(style.getPropertyValue('--column-fade-start').trim() === '',
        'while the start stop, with nothing hidden behind it, is left closed');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

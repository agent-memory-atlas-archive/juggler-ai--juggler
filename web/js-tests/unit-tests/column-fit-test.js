//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation and the properties panel beside it fit the window they are in.
 *
 * The panel has a floor it cannot be squeezed below, and a conversation column
 * holds a width in rem that came from somewhere else entirely — a drag on a
 * wider window, a window since made smaller, a zoom level that made every rem
 * bigger. When the two no longer fit, `column-container` scrolls sideways, so
 * what the user sees is a properties panel sliced down the middle by the edge
 * of the window, on a screen where nothing else scrolls sideways.
 *
 * Choosing better starting widths does not fix that: a starting width is only
 * ever read once, by a window that has stored nothing. These pin the property
 * that holds for every window — that the pair fits, whatever width the column
 * is carrying — and that a deeper chain still scrolls, which is what Miller
 * columns are for.
 * @module unit-tests/column-fit-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * A column container of a known width, holding the columns named. Absolutely
 * positioned off to one side: this measures layout, so it needs a real box in
 * the real stylesheet, but not a place on screen.
 * @param {number} widthPx - How much room the columns have between them.
 * @param {string[]} tags - Column element names, in order.
 * @returns {{container: HTMLElement, columns: HTMLElement[], teardown: () => void}}
 *   The container, its columns in the order named, and the removal of both.
 */
function mountColumns(widthPx, tags) {
  const container = document.createElement('column-container');
  container.setAttribute(
    'style',
    `position:absolute;left:0;top:0;width:${widthPx}px;height:600px;`,
  );
  const columns = tags.map((tag) => {
    const column = document.createElement(tag);
    container.appendChild(column);
    return /** @type {HTMLElement} */ (column);
  });
  document.body.appendChild(container);
  return { container, columns, teardown: () => container.remove() };
}

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

  check('a conversation and the panel beside it fit the window', () => {
    // 56rem is a width someone dragged to on a window wider than this one, or
    // on the same window before they zoomed in. It is wider than the room left
    // once the panel has its floor, which is the whole case.
    const { container, columns, teardown } = mountColumns(1000, ['conversation-area', 'properties-panel']);
    const [area, panel] = columns;
    area.style.width = '56rem';
    try {
      const box = container.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      assert(box.width > 0 && panelBox.width > 0,
        `both are laid out at all, got container ${box.width}px and panel ${panelBox.width}px`);
      assert(Math.round(panelBox.right) <= Math.round(box.right),
        'the panel ends inside the window rather than past its right edge, where the only thing that '
        + `reveals it is a sideways scrollbar, got ${Math.round(panelBox.right)}px against ${Math.round(box.right)}px`);
      assert(container.scrollWidth <= container.clientWidth,
        `and the pair leaves nothing to scroll to, got ${container.scrollWidth}px of columns in ${container.clientWidth}px`);
    } finally {
      teardown();
    }
  });

  check('the conversation gives up the room, not the panel', () => {
    // Which of the two narrows is the whole point: a panel below its floor is
    // unreadable, while a conversation is a column of prose that reads at any
    // width. The panel keeps 30rem; the conversation takes what is left.
    const { container, columns, teardown } = mountColumns(1000, ['conversation-area', 'properties-panel']);
    const [area, panel] = columns;
    area.style.width = '56rem';
    try {
      const remPx = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const panelWidth = panel.getBoundingClientRect().width;
      const areaWidth = area.getBoundingClientRect().width;
      assert(Math.round(panelWidth) >= Math.round(30 * remPx),
        `the panel keeps its 30rem floor, got ${Math.round(panelWidth)}px`);
      assert(areaWidth < 56 * remPx,
        `and the conversation is the one that gave way, got ${Math.round(areaWidth)}px of the 56rem it asked for`);
      assert(areaWidth > 0,
        'without collapsing to nothing, which would be a different kind of broken');
      void container;
    } finally {
      teardown();
    }
  });

  check('a deeper chain still scrolls rather than squeezing every column', () => {
    // Miller columns: depth is read by scrolling, and a chain that squeezed
    // instead would make every column in it narrower the further you drilled.
    // Only the pair at the end of a two-column chain is made to fit.
    const { container, columns, teardown } = mountColumns(
      1000,
      ['conversation-area', 'conversation-area', 'properties-panel'],
    );
    const [first, second] = columns;
    first.style.width = '40rem';
    second.style.width = '40rem';
    try {
      const remPx = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      assert(Math.round(first.getBoundingClientRect().width) === Math.round(40 * remPx),
        `the first column keeps the width it was given, got ${Math.round(first.getBoundingClientRect().width)}px`);
      assert(container.scrollWidth > container.clientWidth,
        'and the chain scrolls, which is how a chain longer than the window is read');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

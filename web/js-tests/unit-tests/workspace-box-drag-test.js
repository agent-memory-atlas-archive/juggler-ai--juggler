//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dragging a whole workspace box to a new place in the strip.
 *
 * A box keeps a place of its own — the conversation it sits behind, stored on
 * its workspace row — so moving one writes that field and moves no
 * conversation. The assertions here are about what the drop is allowed to
 * write: the place it landed at, and nothing else at all.
 *
 * A box travels among the tabs and boxes of the strip and never into another
 * box. A workspace does not live in a workspace, so the containment question a
 * tab drag has to answer does not arise.
 * @module unit-tests/workspace-box-drag-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @returns {any} The row.
 */
function workspace(id) {
  return { id, root: `/tmp/${id}`, label: id, state: 'ready', available: true, providerId: '(none)' };
}

/**
 * Mount a bar drawing the given workspaces and bindings, over a session stub
 * that records the block moves it is asked for and applies them, so the order
 * it is left holding can be asserted on.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {{bar: any, session: any, calls: any[][], order: () => string, teardown: () => void}} The mounted bar and what to read afterwards.
 */
function mountBar(workspaces, bindings) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  host.appendChild(document.createElement('conversation-tabs-container'));
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  host.appendChild(bar);

  /** @type {any[][]} */
  const calls = [];
  /** @type {any} */
  const session = {
    workspaces,
    projectPath: '/tmp/project',
    binnedCount: 0,
    binSizeBytes: 0,
    visibleConversationId: null,
    conversations: new Map(),
    /**
     * @param {string} id - Which workspace.
     * @returns {any} The row, if the table holds it.
     */
    getWorkspace(id) { return workspaces.find((row) => row.id === id) || null; },
    /**
     * @param {string} workspaceId - Whose box moved.
     * @param {string} place - 'head', or the conversation it now sits behind.
     * @returns {boolean} Whether anything moved.
     */
    moveWorkspaceBox(workspaceId, place) {
      const row = workspaces.find((ws) => ws.id === workspaceId);
      if (!row || !place || row.place === place) return false;
      calls.push(['box', workspaceId, place]);
      row.place = place;
      return true;
    },
    /**
     * @param {string} id - Conversation moved.
     * @param {string} beforeId - Conversation it was dropped in front of.
     * @returns {boolean} Always accepted.
     */
    reorderConversation(id, beforeId) { calls.push(['reorder', id, beforeId]); return true; },
    /**
     * @param {string} id - Conversation moved to the end.
     * @returns {boolean} Always accepted.
     */
    moveConversationToEnd(id) { calls.push(['end', id]); return true; }
  };
  for (const [id, workspaceId] of bindings) {
    session.conversations.set(id, { id, name: id, workspaceId, session });
  }

  bar._session = session;
  bar.render();
  return {
    bar,
    session,
    calls,
    order: () => [...session.conversations.keys()].join(','),
    teardown: () => host.remove()
  };
}

/**
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {HTMLElement} The box element.
 */
function boxFor(bar, id) {
  return /** @type {HTMLElement} */ (bar.querySelector(`.conversation-box[data-workspace-id="${id}"]`));
}

/**
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose tab.
 * @returns {HTMLElement} The tab element.
 */
function tabFor(bar, id) {
  return /** @type {HTMLElement} */ (bar.querySelector(`.conversation-tab[data-conversation-id="${id}"]`));
}

/**
 * Press a box's header, drag it to a height, and let go.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} box - The box to drag.
 * @param {number} clientY - Where to let go.
 * @returns {void}
 */
function dragBoxToY(bar, box, clientY) {
  const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
  /** @type {any} */ (header).setPointerCapture = () => {};
  /** @type {any} */ (header).releasePointerCapture = () => {};
  /** @type {any} */ (box).setPointerCapture = () => {};
  /** @type {any} */ (box).releasePointerCapture = () => {};
  const from = header.getBoundingClientRect();
  const x = from.left + 10;
  bar._startBoxDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, box);
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
}

/**
 * Press a box's header and drag it to a height, without letting go.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} box - The box to drag.
 * @param {number} clientY - Where to drag it to.
 * @returns {(y?: number) => void} Let go, optionally somewhere else.
 */
function holdBoxAtY(bar, box, clientY) {
  const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
  /** @type {any} */ (header).setPointerCapture = () => {};
  /** @type {any} */ (header).releasePointerCapture = () => {};
  /** @type {any} */ (box).setPointerCapture = () => {};
  /** @type {any} */ (box).releasePointerCapture = () => {};
  const from = header.getBoundingClientRect();
  const x = from.left + 10;
  bar._startBoxDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, box);
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  return (y = clientY) => document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true
  }));
}

/**
 * Press something the way a finger or a mouse would, and report whether the box
 * took it for a grab.
 *
 * Through the real `pointerdown` listener, deliberately: the drags above call
 * `_startBoxDrag` directly, so they say nothing about what is allowed to start
 * one. That gate is the whole of what a touch runs into.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} target - What the pointer goes down on.
 * @param {string} pointerType - 'touch', 'pen' or 'mouse'.
 * @returns {boolean} Whether a box drag was started.
 */
function pressStartsDrag(bar, target, pointerType) {
  const started = [];
  const real = bar._startBoxDrag;
  bar._startBoxDrag = (/** @type {any} */ e, /** @type {any} */ box) => started.push(box);
  try {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, button: 0, buttons: 1, pointerType, bubbles: true, composed: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    }));
  } finally {
    bar._startBoxDrag = real;
  }
  return started.length > 0;
}

/**
 * Run the workspace box drag tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('a box being dragged comes off the strip, the way a tab does', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const release = holdBoxAtY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().bottom + 40);

      // The clone is not a box — prepareGhost takes the id off it — so it is
      // found by the class the drag put there.
      const ghost = /** @type {HTMLElement|null} */ (
        bar.querySelector('.conversation-box.drag-ghost'));
      assert(!!ghost, 'the box being dragged is drawn as a clone that follows the pointer');
      assert(getComputedStyle(/** @type {HTMLElement} */ (ghost)).position === 'fixed',
        'floating free of the list it came from, so it can travel the whole height of the sidebar '
        + `rather than being clipped at the short list's edge, got ${getComputedStyle(/** @type {HTMLElement} */ (ghost)).position}`);
      assert(getComputedStyle(box).visibility === 'hidden',
        'and the box it was lifted out of stands in as the placeholder the rest shift around, '
        + `got ${getComputedStyle(box).visibility}`);

      release();
      assert(getComputedStyle(box).visibility !== 'hidden', 'which it stops being once let go');
      assert(!bar.querySelector('.drag-ghost'), 'and the clone goes with the gesture');
    } finally {
      teardown();
    }
  });

  check('a box dragged above every tab comes to sit at the head of the bar', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', ''], ['c2', 'ws_a'], ['c3', 'ws_a']]
    );
    try {
      assert(order() === 'c1,c2,c3', `the strip starts with the flat tab on top, got ${order()}`);
      const first = tabFor(bar, 'c1').getBoundingClientRect();
      dragBoxToY(bar, boxFor(bar, 'ws_a'), first.top + 1);

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_a', 'head']]),
        `dropped in front of everything, the box has nothing left to sit behind: ${JSON.stringify(calls)}`);
      assert(order() === 'c1,c2,c3',
        `and no conversation has moved — a box travels on its own, got ${order()}`);
    } finally {
      teardown();
    }
  });

  check('a box dragged past the end of the strip sits behind the last tab', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c3', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      dragBoxToY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().bottom + 60);

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_a', 'c1']]),
        `the end of the bar is behind the last conversation that is not its own: ${JSON.stringify(calls)}`);
      assert(order() === 'c2,c3,c1',
        `and again nothing else moved, got ${order()}`);
    } finally {
      teardown();
    }
  });

  check('a box let go where it already is writes nothing', () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const rect = box.getBoundingClientRect();
      dragBoxToY(bar, box, rect.top + 2);

      assert(calls.length === 0,
        `a gesture that ends where it began has moved nothing, and must not say it has: ${JSON.stringify(calls)}`);
    } finally {
      teardown();
    }
  });

  check('an empty box commits its place like any other', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_empty')],
      [['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_empty');
      dragBoxToY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().top + 1);

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_empty', 'head']]),
        `a box's place is its own, so one with nothing in it is moved and kept like any other: ${JSON.stringify(calls)}`);
      assert(order() === 'c1',
        `and the conversation it was dragged past stays where it is, got ${order()}`);
    } finally {
      teardown();
    }
  });

  check('a box carries the same grip a tab does', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', 'ws_a']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const grip = /** @type {HTMLElement|null} */ (box.querySelector('.drag-grip'));
      assert(!!grip, 'a box is draggable, so it says so with a grip — the affordance a tab has');
      assert(!!tabFor(bar, 'c1').querySelector('.drag-grip'),
        'and it is the same grip, from the same place, not a second one that looks like it');
      assert(getComputedStyle(/** @type {HTMLElement} */ (grip)).touchAction === 'none',
        'which claims the gesture from the browser: without this the drawer keeps a finger for '
        + `scrolling and the drag is cancelled as soon as it moves, got ${getComputedStyle(/** @type {HTMLElement} */ (grip)).touchAction}`);
    } finally {
      teardown();
    }
  });

  check('a finger may drag a box by its grip, and may scroll from anywhere else', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', 'ws_a']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const grip = /** @type {HTMLElement} */ (box.querySelector('.drag-grip'));
      const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));

      assert(pressStartsDrag(bar, grip, 'touch'),
        'a finger on the grip is reordering the strip');
      assert(!pressStartsDrag(bar, header, 'touch'),
        'a finger anywhere else on the box is scrolling the list it is in — a box header spans '
        + 'the whole width, so taking a touch there would cost the sidebar its scroll');
      assert(pressStartsDrag(bar, header, 'mouse'),
        'a mouse still drags a box from anywhere on it: it has a hover to find the grip with, '
        + 'and nothing else is competing for the press');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

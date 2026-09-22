//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dragging a whole workspace box to a new place in the strip.
 *
 * The order holds conversations and nothing else, and a box is drawn at the
 * first of its own — so moving a box is moving that run of conversations,
 * together, to wherever it was let go. The assertions here are about what the
 * drop is allowed to write: the run arrives whole, keeps the order it had, and
 * takes none of its neighbours with it.
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
     * @param {string[]} ids - The run being moved.
     * @param {string} beforeId - What it lands in front of, or '' for the end.
     * @returns {boolean} Whether anything moved.
     */
    moveConversationBlock(ids, beforeId) {
      calls.push(['block', ids.join(','), beforeId]);
      const moving = ids.filter((id) => session.conversations.has(id));
      if (!moving.length || moving.includes(beforeId)) return false;
      const keys = [...session.conversations.keys()].filter((id) => !moving.includes(id));
      const at = beforeId ? keys.indexOf(beforeId) : -1;
      keys.splice(at >= 0 ? at : keys.length, 0, ...moving);
      const next = new Map(keys.map((id) => [id, session.conversations.get(id)]));
      session.conversations = next;
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

  check('a box dragged above a tab takes its conversations with it', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', ''], ['c2', 'ws_a'], ['c3', 'ws_a']]
    );
    try {
      assert(order() === 'c1,c2,c3', `the strip starts with the flat tab on top, got ${order()}`);
      const first = tabFor(bar, 'c1').getBoundingClientRect();
      dragBoxToY(bar, boxFor(bar, 'ws_a'), first.top + 1);

      assert(JSON.stringify(calls) === JSON.stringify([['block', 'c2,c3', 'c1']]),
        `the box commits its conversations as one run, landing in front of the tab it was dropped above: ${JSON.stringify(calls)}`);
      assert(order() === 'c2,c3,c1',
        `they arrive together and keep the order they had, and the tab they passed stays put, got ${order()}`);
    } finally {
      teardown();
    }
  });

  check('a box dragged past the end of the strip goes to the end of the order', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c3', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      dragBoxToY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().bottom + 60);

      assert(JSON.stringify(calls) === JSON.stringify([['block', 'c2,c3', '']]),
        `past everything there is to land in front of, there is nothing to name: ${JSON.stringify(calls)}`);
      assert(order() === 'c1,c2,c3',
        `so the run goes to the end, still whole and still in order, got ${order()}`);
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

  check('an empty box has no conversations to commit', () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_empty')],
      [['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_empty');
      dragBoxToY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().top + 1);

      assert(calls.length === 0,
        `a workspace nobody is working in owns no place in the conversation order, so there is nothing to write: ${JSON.stringify(calls)}`);
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

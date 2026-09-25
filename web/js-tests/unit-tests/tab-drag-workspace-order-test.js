//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dragging a tab past a workspace box, and what the strip is left showing.
 *
 * The bar draws two things that each keep their own place: a conversation sits
 * where the flat order puts it, a box sits behind the conversation its row
 * names. The strip the user reads is the two merged, so a drop has to be right
 * in both at once — and the assertions here are on the merged result, the
 * sequence of tabs and boxes actually drawn, because that is the only thing the
 * user can see. A commit that names a defensible neighbour and still draws the
 * tab on the wrong side of a box has not done what was asked of it.
 *
 * Two slots make that demand sharply. Immediately above a box and immediately
 * below it are different places to land and the same conversation to land in
 * front of, so a drop that says only "in front of c" has thrown away which of
 * them the user chose. And the tab a box is anchored to is an ordinary tab with
 * nothing to mark it, so dragging it must move it alone: a box that follows the
 * tab it happens to sit behind moves a thing nobody dragged.
 *
 * A real `Session` rather than a recording stub, so the reorder, the
 * re-anchoring and the grouping under test are the shipped ones, and what is
 * asserted is what they would draw.
 * @module unit-tests/tab-drag-workspace-order-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @param {string} [place] - 'head', or the conversation its box sits behind.
 * @returns {any} The row.
 */
function workspace(id, place) {
  const row = { id, root: `/tmp/${id}`, label: id, state: 'ready', available: true, providerId: '(none)' };
  return place ? { ...row, place } : row;
}

/**
 * Mount a bar over a real session holding the given table and bindings.
 *
 * The session is built and populated directly rather than loaded: `setSession`
 * would spin up a panel and a worker per conversation, and the strip needs
 * neither. Its api service answers the one call a reorder makes, so persisting
 * is a no-op instead of a fetch.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {{bar: any, session: any, teardown: () => void}} The mounted bar, its session, and a teardown.
 */
function mountBar(workspaces, bindings) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  host.appendChild(document.createElement('conversation-tabs-container'));
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  host.appendChild(bar);

  const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
    /**
     * @returns {Promise<void>} Persisting is what the server does with an order, not what is under test here.
     */
    reorderConversations: async () => {}
  }))));
  session.workspaces = workspaces;
  session.projectPath = '/tmp/project';
  session.binnedCount = 0;
  session.binSizeBytes = 0;
  for (const [id, workspaceId] of bindings) {
    session.conversations.set(id, { id, name: id, workspaceId, session });
  }

  bar._session = session;
  bar.render();
  for (const tab of Array.from(bar.querySelectorAll('.conversation-tab'))) {
    /** @type {any} */ (tab).setPointerCapture = () => {};
    /** @type {any} */ (tab).releasePointerCapture = () => {};
  }
  return { bar, session, teardown: () => host.remove() };
}

/**
 * The strip as drawn, tabs and boxes in the order they appear.
 *
 * A box is written with what it holds, so a tab landing inside one instead of
 * beside it is legible in the failure rather than silently absent.
 * @param {any} bar - The mounted bar.
 * @returns {string} e.g. `a b [ws] c d`, or `a [ws:m] b` for a box with a member.
 */
function drawn(bar) {
  const menu = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-tabs'));
  if (!menu) return '(no strip)';
  return /** @type {HTMLElement[]} */ (Array.from(menu.children))
    .filter(child => child.classList.contains('conversation-tab')
      || child.classList.contains('conversation-box'))
    .map((child) => {
      if (child.classList.contains('conversation-tab')) return child.dataset.conversationId ?? '?';
      const held = /** @type {HTMLElement[]} */ (
        Array.from(child.querySelectorAll('.conversation-tab')))
        .map(tab => tab.dataset.conversationId ?? '?');
      return held.length ? `[${child.dataset.workspaceId}:${held.join(',')}]` : `[${child.dataset.workspaceId}]`;
    })
    .join(' ');
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
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {HTMLElement} The box element.
 */
function boxFor(bar, id) {
  return /** @type {HTMLElement} */ (bar.querySelector(`.conversation-box[data-workspace-id="${id}"]`));
}

/**
 * Drag one tab to a height in the strip and let go, then redraw.
 *
 * The bar holds its renders for the length of the gesture and is attached here
 * without its session listeners, so the redraw is asked for rather than waited
 * on: what it draws is a function of the session the drop just wrote, which is
 * the thing being asserted.
 * @param {any} bar - The mounted bar.
 * @param {string} id - The conversation to drag.
 * @param {number} clientY - Where to let go.
 * @returns {void}
 */
function dragToY(bar, id, clientY) {
  const tab = tabFor(bar, id);
  const from = tab.getBoundingClientRect();
  const x = from.left + 10;
  bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  bar.render();
}

/**
 * The gutter just above a box: outside it, so the drop is a move past the box
 * rather than a move into it.
 * @param {HTMLElement} box - The box.
 * @returns {number} A clientY in the gap above it.
 */
function justAbove(box) {
  return box.getBoundingClientRect().top - 2;
}

/**
 * The gutter just below a box, on the same terms.
 * @param {HTMLElement} box - The box.
 * @returns {number} A clientY in the gap below it.
 */
function justBelow(box) {
  return box.getBoundingClientRect().bottom + 2;
}

/**
 * Run the tab-past-a-box ordering tests.
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
    } finally {
      // A check that threw mid-gesture must not leave the drag's document
      // listeners running into the next one.
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0, bubbles: true
      }));
    }
  };

  /**
   * The bar the reported fault was found in: an empty box with tabs either
   * side of it, sitting behind `b`.
   * @returns {{bar: any, session: any, teardown: () => void}} The mounted bar.
   */
  const barWithBoxInTheMiddle = () => mountBar(
    [workspace('ws', 'b')],
    [['a', ''], ['b', ''], ['c', ''], ['d', '']]
  );

  check('a tab dragged up to the slot above a box is drawn above it', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      assert(drawn(bar) === 'a b [ws] c d', `the strip starts with the box in the middle, got "${drawn(bar)}"`);
      dragToY(bar, 'd', justAbove(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'a b d [ws] c',
        'a tab let go in the gap above a box belongs above it — the slot above and the slot below '
        + `are the same conversation to land in front of and different places to be, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab dragged down to the slot below a box is drawn below it', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'a', justBelow(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'b [ws] a c d',
        `the other half of the same gesture, and the one that already worked, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab dragged above the tab above a box still lands there', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      const b = tabFor(bar, 'b').getBoundingClientRect();
      dragToY(bar, 'd', b.top + 1);

      assert(drawn(bar) === 'a d b [ws] c',
        `landing in front of a plain tab is untouched by any of this, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('dragging the tab a box sits behind moves the tab and not the box', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'b', justBelow(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'a [ws] b c d',
        'the box is anchored to b, which is an ordinary tab with nothing to mark it as one — '
        + `dragging it past the box must move it alone, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a box keeps its place when its tab is dragged to the head of the bar', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'b', tabFor(bar, 'a').getBoundingClientRect().top + 1);

      assert(drawn(bar) === 'b a [ws] c d',
        'b leaves the top of the bar and the box stays where it was drawn, above c — a box '
        + `re-anchors to what its tab left behind rather than travelling with it, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a box keeps its place when its tab is dragged past the end of the bar', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'b', tabFor(bar, 'd').getBoundingClientRect().bottom + 80);

      assert(drawn(bar) === 'a [ws] c d b',
        `the same on the way down: the tab goes to the end and the box does not follow, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab can be dropped above a box that sits at the head of the bar', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'head')],
      [['a', ''], ['b', ''], ['c', '']]
    );
    try {
      assert(drawn(bar) === '[ws] a b c', `the box starts at the top, got "${drawn(bar)}"`);
      dragToY(bar, 'c', justAbove(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'c [ws] a b',
        'nothing can be drawn above a box anchored to the head unless the box gives the place up, '
        + `so the drop has to move it, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab dropped above a box with a conversation in it clears the box', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'b')],
      [['a', ''], ['b', ''], ['m', 'ws'], ['c', '']]
    );
    try {
      assert(drawn(bar) === 'a b [ws:m] c', `the box holds its member, got "${drawn(bar)}"`);
      dragToY(bar, 'c', justAbove(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'a b c [ws:m]',
        'the tab lands above the box and the box keeps what is inside it — a drop beside a box '
        + `is not a drop into one, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab dropped past the end lands last, behind a box drawn there', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'c')],
      [['a', ''], ['b', ''], ['c', '']]
    );
    try {
      assert(drawn(bar) === 'a b c [ws]', `the box starts at the end, got "${drawn(bar)}"`);
      dragToY(bar, 'a', boxFor(bar, 'ws').getBoundingClientRect().bottom + 80);

      assert(drawn(bar) === 'b c [ws] a',
        `past the end of the strip is the end of the strip, box or no box, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab can be dropped between two boxes drawn side by side', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws1', 'a'), workspace('ws2', 'a')],
      [['a', ''], ['b', '']]
    );
    try {
      assert(drawn(bar) === 'a [ws1] [ws2] b', `two boxes sharing an anchor stack up, got "${drawn(bar)}"`);
      dragToY(bar, 'b', justAbove(boxFor(bar, 'ws2')));

      assert(drawn(bar) === 'a [ws1] b [ws2]',
        `the gap between two boxes is a place to land, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  check('a tab let go where it was picked up moves nothing', () => {
    const { bar, session, teardown } = barWithBoxInTheMiddle();
    try {
      const before = drawn(bar);
      const place = session.getWorkspace('ws').place;
      const tab = tabFor(bar, 'd').getBoundingClientRect();
      dragToY(bar, 'd', tab.top + tab.height / 2);

      assert(drawn(bar) === before,
        `a gesture that ends where it began has moved nothing, got "${drawn(bar)}" from "${before}"`);
      assert(session.getWorkspace('ws').place === place,
        `and must not have rewritten the box's place either, got ${JSON.stringify(session.getWorkspace('ws').place)}`);
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

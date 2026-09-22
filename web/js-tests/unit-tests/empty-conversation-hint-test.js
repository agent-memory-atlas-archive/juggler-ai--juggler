//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The starting hint on the empty background of a conversation with no history.
 *
 * The one thing that can quietly break it is the emptiness test: a new
 * conversation is NOT an empty one — it is seeded with standing context items
 * before the first message, so an item COUNT would hide the hint on exactly the
 * conversation it exists for. The assertions are therefore that it shows while
 * the column holds only standing items, and goes the moment a conversational
 * item lands.
 *
 * It is an absolutely-positioned sibling of the scroller rather than a row in
 * the transcript, so the second assertion also stands for the item diff never
 * having a chance to delete it.
 *
 * The hint also CENTRES ONLY IN THE CLEAR BAND between the rendered content
 * and the composer, and hides when that band cannot hold it: on a small
 * viewport the standing-context items and the footer would otherwise sit
 * under the hint's text. Both are asserted by measuring the real layout —
 * the container is offscreen, which is fine, because every measurement here
 * is a difference of viewport-relative rects.
 * @module unit-tests/empty-conversation-hint-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage } from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let session = null;

  try {
    session = await createTestSession();
    conversation = await createTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    // A tab's first activation defers its transcript sync by a macrotask, and
    // nothing else here mutates the doc to force the rebuild early.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const hint = /** @type {HTMLElement|null} */ (rootCol.querySelector('conversation-empty-hint'));
    assert(!!hint, 'the column should carry the starting hint');

    // The positioned band is set from JS after the first item render, which can
    // land a beat after that macrotask under load — wait for the placement to
    // exist rather than trusting the beat.
    await waitFor(() => hint.style.height !== '', { description: 'the starting hint to be positioned' });

    // --- A fresh conversation shows it, standing context items and all ---

    assert(conversation.rootItems.length > 0,
      'test setup: a new conversation should already hold seeded standing context ' +
      'items, or this proves nothing about counting items instead of history');
    assert(hint.classList.contains('hidden') === false && hint.classList.contains('no-room') === false,
      'a conversation with no history should show the starting hint, but it is hidden or ' +
      `deemed not to fit (the column holds ${conversation.rootItems.length} seeded item(s))`);

    // --- It centres only in the clear band, below the rendered content ---

    const inner = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list-inner'));
    const scroller = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));

    /** @returns {{top: number, bottom: number}} The clear band, in viewport coordinates. */
    const band = () => ({
      top: inner.getBoundingClientRect().bottom,
      bottom: scroller.getBoundingClientRect().bottom
    });
    /** @returns {boolean} Whether the hint is inside the band and centred in it. */
    const centredInBand = () => {
      const { top, bottom } = band();
      const r = hint.getBoundingClientRect();
      return r.top >= top - 1 && r.bottom <= bottom + 1
        && Math.abs((r.top + r.bottom) / 2 - (top + bottom) / 2) <= 1;
    };

    // The placement above is the FIRST one, and the band moves under it: each
    // standing context item that renders pushes the content's bottom down, and
    // the hint is repositioned after. So a placement centred in the band as it
    // was is exactly what a lane sharing a machine with eight others reads —
    // the geometry is right, just one render behind. Wait for the two to agree
    // instead. Non-throwing on the deadline, so a hint that genuinely never
    // settles is reported by the assertions below, with the numbers.
    try {
      await waitFor(centredInBand, { description: 'the starting hint to settle in the clear band' });
    } catch { /* fall through — the assertions report the exact geometry */ }

    const { top: bandTop, bottom: bandBottom } = band();
    assert(hint.classList.contains('no-room') === false,
      'the 800px-tall test column should have room for the hint, but it is marked no-room');
    const hintTop = hint.getBoundingClientRect().top;
    const hintBottom = hint.getBoundingClientRect().bottom;
    assert(hintTop >= bandTop - 1 && hintBottom <= bandBottom + 1,
      `the hint must stay inside the clear band [${bandTop}, ${bandBottom}] but spans ` +
      `[${hintTop}, ${hintBottom}]`);
    const centreOffset = (hintTop + hintBottom) / 2 - (bandTop + bandBottom) / 2;
    assert(Math.abs(centreOffset) <= 1,
      `the hint should centre in the clear band but sits ${centreOffset.toFixed(1)}px off its centre`);

    // --- A viewport too small to hold it hides it ---

    const fullHeight = container.style.height;
    container.style.height = '260px';
    rootCol._positionEmptyHint();
    assert(hint.classList.contains('no-room'),
      'a viewport with no clear room for the hint should hide it, but it is shown');

    // --- And it comes back when the room returns ---

    container.style.height = fullHeight;
    rootCol._positionEmptyHint();
    assert(hint.classList.contains('no-room') === false,
      'the hint should come back when the viewport has room for it again');

    // --- The first real message retires it ---

    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;
    doc.transact(() => {
      conversation.rootMessageThread.addEvent(createUserMessage('Right, off we go'));
    }, author);

    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden'),
      'the hint should go as soon as the conversation has history');

    // --- A thread column never shows it ---

    // Called directly: opening a real sub-thread would prove the same thing at
    // the cost of a whole turn, and the rule under test is one line of state.
    rootCol._threadYMap = {};
    rootCol._updateEmptyHint([]);
    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden'),
      'a thread column is opened from work already done and must not show the hint');
    rootCol._threadYMap = null;

    // Retiring the hint clears its geometry, so a stale band from a smaller
    // viewport can never leak into a later show.
    assert(hint.style.top === '' && hint.style.height === '' && !hint.classList.contains('no-room'),
      'a retired hint should carry no leftover placement');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'empty-conversation-hint:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}

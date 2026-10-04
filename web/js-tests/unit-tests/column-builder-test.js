//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The column builder's memo of what it rendered into each column, driven
 * through a real conversation-tab's rebuilds.
 *
 * A rebuild runs on every selection change and every document change, so the
 * memo is what keeps one cheap: a column whose items are unchanged must not be
 * handed them again. Two things depend on it being right. The tool-grouping
 * toggle changes what a column LISTS without changing its items, so it must
 * still force a repaint. And a properties panel's debounced render must still
 * be reachable, so a command acting on the panel can bring it up to date first.
 *
 * The memo belongs to the builder. These cases also pin that the tab leaves no
 * state of its own on the column elements it drives.
 * @module unit-tests/column-builder-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import { TOOL_GROUPING_EVENT } from '../../js/utils/tool-grouping-pref.js';
import '../../js/components/conversation-tab.js';

/**
 * Let the column rebuild land.
 * @returns {Promise<void>} Resolves once queued callbacks have run.
 */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 20); });
}

/**
 * Let a debounced properties render fire (150ms) with room to spare.
 * @returns {Promise<void>} Resolves once the panel has rendered.
 */
function settlePanel() {
  return new Promise((resolve) => { setTimeout(resolve, 300); });
}

/**
 * Own properties on a column that only the tab or its builder could have put
 * there: render memos and debounce bookkeeping parked on the element. Named
 * exactly, because the panel declares a `_renderedItemId` of its own.
 * @param {HTMLElement} col - A column element.
 * @returns {string[]} The offending property names.
 */
function parkedState(col) {
  return Object.keys(col).filter((k) =>
    k === '_renderedItemKey' || k === '_renderedInputKey' || k.startsWith('_juggler_'));
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case under test, used to label a failure.
   * @param {() => Promise<void>} fn - Assertions; throws to fail.
   * @returns {Promise<void>} Resolves once the case has run.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1600px;height:800px;';
  document.body.appendChild(host);

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const transact = (/** @type {() => void} */ fn) =>
      conversation._doc.doc.transact(fn, conversation._doc.authorId);
    transact(() => {
      root.addEvent(createUserMessage('Look at this'));
      root.addEvent(createAssistantMessage('Looking.'));
      root.addEvent(createAssistantMessage('Found it.'));
    });
    await settle();

    const col = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!col, 'test setup: the root conversation column should exist');

    // Count every render handed to the root column from here on.
    let renders = 0;
    const realRender = col.renderFromItems.bind(col);
    col.renderFromItems = (/** @type {any[]} */ items) => {
      renders++;
      realRender(items);
    };

    await run('a rebuild that changes nothing repaints nothing', async () => {
      renders = 0;
      tab._rebuildColumns();
      tab._rebuildColumns();
      assert(renders === 0, `two no-op rebuilds handed the column its items ${renders} time(s)`);

      transact(() => { root.addEvent(createAssistantMessage('One more thing.')); });
      await settle();
      assert(renders >= 1, 'a new item must reach the column, but nothing was rendered');
    });

    await run('a tool-grouping change repaints a column whose items did not change', async () => {
      // The event alone, without writing the shared preference: the tab
      // re-renders under whatever rule is current, which is the repaint under test.
      renders = 0;
      window.dispatchEvent(new Event(TOOL_GROUPING_EVENT));
      assert(renders >= 1,
        'the grouping change must force a repaint even though the column\'s items are unchanged');
    });

    const ids = root.items.map((/** @type {any} */ i) => i.get('itemId'));
    const first = ids[1];
    const second = ids[2];

    await run('the tab parks no state of its own on its columns', async () => {
      col.selectItem(first);
      await settlePanel();
      const panel = /** @type {any} */ (tab.querySelector('column-container > properties-panel'));
      assert(!!panel, 'selecting an item should have opened a properties panel');
      const parked = [...parkedState(col), ...parkedState(panel)];
      assert(parked.length === 0,
        `the tab left its own bookkeeping on the column elements: ${parked.join(', ')}`);
    });

    await run('a deferred properties render is flushed on demand', async () => {
      const panel = /** @type {any} */ (tab.querySelector('column-container > properties-panel'));
      assert(!!panel, 'test setup: the properties panel should be open');
      assert(panel.getSelectedItemId() === first,
        `test setup: the panel should show the first selection, got ${panel.getSelectedItemId()}`);

      // Mark the selection as churning, so the next change is deferred rather
      // than taking the leading edge. Without this the outcome would depend on
      // how long the settle above really took.
      tab._builder._propsLastChangeTime = Date.now();
      col.selectItem(second);
      assert(panel.getSelectedItemId() === first,
        'test setup: a change mid-churn should have been deferred, but the panel already shows it');

      tab._builder.flushPropertiesRender(panel);
      assert(panel.getSelectedItemId() === second,
        `the flush must render the pending selection now, got ${panel.getSelectedItemId()}`);

      // The flushed render owns its timer: nothing is left to fire later.
      tab._builder.flushPropertiesRender(panel);
      await settlePanel();
      assert(panel.getSelectedItemId() === second,
        `the panel must stay on the flushed selection, got ${panel.getSelectedItemId()}`);
    });
  } catch (e) {
    failed++;
    errors.push(`setup: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.remove();
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (conversation) {
      try {
        await session?.deleteConversation(conversation.id, 'column-builder:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}

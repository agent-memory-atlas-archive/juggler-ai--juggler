//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 4 for sub-threads: a tile the user selected stays selected while the
 * turn runs on.
 *
 * A sub-thread is the one item whose selection was stealable. Two paths did it,
 * and both are exercised here against a live conversation-tab:
 *   - Rule A re-arms auto-follow when the selected item is the last row, and a
 *     working sub-thread's tile IS the last row of its parent column — nothing
 *     is appended there until the thread returns. Selecting one is a request to
 *     read the child column, not to follow the tail.
 *   - maybeAutoSelectThread rewrites the whole column chain when the status
 *     moves to a thread the user isn't viewing, which is exactly the case where
 *     they are reading something else.
 *
 * The last assertion is the other half of the contract: the pin defers the
 * auto-open, it doesn't cancel it. Once the pin lifts, the thread that is
 * running by then opens.
 * @module unit-tests/thread-selection-pin-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
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

  try {
    const session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    // The turn opens a sub-thread. Its tile is the last root row — the parent
    // gets nothing more until the thread returns.
    /** @type {string} */
    let threadA = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Investigate two things'));
      threadA = root.createSubThread({
        goal: 'First look',
        initialItems: [createAssistantMessage('Looking.')],
        extra: { result: 'Found it.' }
      }).threadId;
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');

    // The user clicks that tile to read the sub-thread's transcript.
    rootCol.selectItem(threadA);
    assert(rootCol.selectionOrigin === 'user',
      'selecting a sub-thread tile must pin the column even though the tile is ' +
      'the last row — it is the last row because the thread is still working');

    // The parent turn carries on. Rule 4 holds: nothing it inserts takes the
    // selection off the tile.
    doc.transact(() => {
      root.addEvent(createAssistantMessage('Now the second thing.'));
      root.addEvent(createToolActionMessage({
        toolUseId: 'call_pin_1',
        toolName: 'write',
        toolInput: { file_path: 'pinned.txt', content: 'hello' },
        state: TOOL_STATES.COMPLETED,
        result: { state: 'completed', content: 'File written' }
      }));
    }, author);
    assert(rootCol.getSelectedItemId() === threadA,
      'items arriving in the root must not displace the sub-thread the user selected');

    // A second sub-thread starts running. This is the tab-level auto-open, the
    // one path that rewrites the whole chain.
    /** @type {string} */
    let threadB = '';
    doc.transact(() => {
      threadB = root.createSubThread({
        goal: 'Second look',
        initialItems: [createAssistantMessage('Working.')]
      }).threadId;
    }, author);
    conversation.llmState._handleProcessingStateChange(conversation.id,
      { status: 'streaming', threadItemId: threadB });

    assert(rootCol.getSelectedItemId() === threadA,
      'a newly running sub-thread must not pull the selection off the one being read');
    const openThreadIds = Array.from(tab.querySelectorAll('conversation-area.thread-column'))
      .map((/** @type {any} */ col) => col.getMessageThread?.()?.threadItemId);
    assert(openThreadIds.includes(threadA) && !openThreadIds.includes(threadB),
      `the read sub-thread's column should still be the open one, got ${JSON.stringify(openThreadIds)}`);

    // Rule 3: a new user message hands the column back to auto-follow. The
    // deferred auto-open must then happen — the pin postponed it, and did not
    // spend the status change that asked for it.
    doc.transact(() => {
      root.addEvent(createUserMessage('Carry on'));
    }, author);
    assert(rootCol.selectionOrigin !== 'user',
      'a new user message should clear the pin (rule 3)');

    conversation.llmState._handleProcessingStateChange(conversation.id,
      { status: 'streaming', threadItemId: threadB });
    assert(rootCol.getSelectedItemId() === threadB,
      'once the pin lifts, the running sub-thread opens — the pin defers the ' +
      'auto-open rather than cancelling it');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
  }

  return { passed, failed, errors };
}

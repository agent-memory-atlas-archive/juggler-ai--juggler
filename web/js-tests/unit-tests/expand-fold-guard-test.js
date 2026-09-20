//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Expand into parent never trades a tile for nothing.
 *
 * Expand splices a thread's items up and drops the tile. A thread with no items
 * to splice would make that a plain delete: the tile goes, nothing replaces it,
 * and whatever the tile itself carried goes with it. A compaction fold reaches
 * exactly this shape — a re-fold condenses a prior fold to goal + result and
 * drops its transcript, leaving a tile whose summary is the only surviving
 * record of the conversation it stands for.
 * @module unit-tests/expand-fold-guard-test
 */

import {
  assert,
  initializeRegistries,
  createTestSession,
  createTestConversation,
  releaseTestConversation
} from '../utilities/test-helpers.js';

/**
 * Run the expand-into-parent guard suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;

  try {
    session = await createTestSession();
    conversation = await createTestConversation(session);
    const root = conversation.rootMessageThread;

    /**
     * @param {string} itemId - The thread's item id.
     * @returns {boolean} Whether a tile with that id is still at the root.
     */
    const tilePresent = (itemId) =>
      root.items.some((/** @type {any} */ it) => it.get?.('itemId') === itemId);

    // A condensed fold: goal + result, no items. This is what condenseForRefold
    // writes (worker/compaction.go) — the `items` key is absent, not empty.
    root.addEvent({
      type: 'thread',
      itemId: 'condensed-fold',
      goal: 'Compacted conversation history',
      boundedCompaction: true,
      result: 'The summary that is now the only record of the folded history.'
    });
    assert(tilePresent('condensed-fold'), 'precondition: the condensed fold is at the root');

    const expanded = conversation.expandThread('condensed-fold');
    assert(expanded === false,
      'expanding a thread with nothing to splice must refuse, not report success');
    passed++;

    assert(tilePresent('condensed-fold'),
      'a thread with no items to splice must keep its tile — expand is not a delete');
    passed++;

    // The guard is about having nothing to give back, not about being a fold:
    // a fold that still holds its transcript expands like any other thread.
    root.addEvent({
      type: 'thread',
      itemId: 'intact-fold',
      goal: 'Compacted conversation history',
      boundedCompaction: true,
      result: 'A summary standing over a transcript that is still here.',
      items: [
        { type: 'user', itemId: 'folded-1', content: 'the original task' },
        { type: 'assistant', itemId: 'folded-2', content: 'on it' }
      ]
    });

    assert(conversation.expandThread('intact-fold') === true,
      'a fold that still holds its transcript must expand');
    passed++;

    assert(!tilePresent('intact-fold'), 'the expanded tile is gone');
    assert(
      root.items.some((/** @type {any} */ it) => it.get?.('content') === 'the original task'),
      'and its folded items are at the root'
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (session && conversation) {
      await releaseTestConversation(session, conversation.id, 'expand-fold-guard test cleanup');
    }
  }

  return { passed, failed, errors };
}

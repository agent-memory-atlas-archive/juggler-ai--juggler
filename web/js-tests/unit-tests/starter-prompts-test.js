//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the chips offered in a conversation nobody has said anything in.
 *
 * Starter prompts and LLM reply suggestions share one row and one feed point,
 * which is what makes them mutually exclusive by construction. The predicate
 * that picks between them is `_hasConversationalHistory`, and it is the thing
 * worth pinning: a new conversation is NOT an empty one — it is seeded with
 * standing context items before the first message — so a naive `items.length`
 * test would retire the starter prompts before they were ever shown.
 *
 * The other half is the house rule the shared row inherits: a chip DRAFTS into
 * the composer and sends nothing.
 * @module unit-tests/starter-prompts-test
 */

import { assert } from '../utilities/test-helpers.js';
import { STARTER_PROMPTS } from '../../js/utils/starter-prompts.js';
import { MESSAGE_TYPES } from '../../sdk/lib/message.js';
import '../../js/components/reply-suggestions-row.js';
import '../../js/components/conversation-area.js';

/**
 * Give a plain fixture the Y.Map `get` accessor the item predicates reach for.
 * @param {Record<string, any>} obj - The fields.
 * @returns {any} A Y.Map-like item.
 */
function ymap(obj) {
  return { ...obj, get: (/** @type {string} */ k) => obj[k] };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.id = 'starter-prompts-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  document.body.appendChild(container);

  try {
    // --- 1: a seeded-but-unused conversation still counts as unstarted ------
    // These are the standing context items every new conversation is born
    // with. If any of them reads as history, the starter prompts never appear.
    const column = /** @type {any} */ (document.createElement('conversation-area'));
    column._messageThread = {
      items: [
        ymap({ type: 'system-prompt' }),
        ymap({ type: 'memory' }),
        ymap({ type: 'file-content' }),
      ],
    };
    assert(column._hasConversationalHistory() === false,
      'standing context items were read as conversation history, which retires the '
      + 'starter prompts before anyone has seen them');
    passed++;

    // --- 2: the first real message ends it ----------------------------------
    column._messageThread.items.push(ymap({ type: MESSAGE_TYPES.USER, content: 'hello' }));
    assert(column._hasConversationalHistory() === true,
      'a user message did not count as history, so the starter prompts would sit '
      + 'under a conversation already in progress');
    passed++;

    // --- 3: a thread column is never unstarted ------------------------------
    // It is opened from work that has already happened, whatever its own items
    // say, so its reader is long past needing somewhere to begin.
    const thread = /** @type {any} */ (document.createElement('conversation-area'));
    thread._messageThread = { items: [ymap({ type: 'system-prompt' })] };
    thread._threadYMap = ymap({ id: 'thread_1' });
    assert(thread._hasConversationalHistory() === true,
      'a sub-thread column was treated as a fresh conversation');
    passed++;

    // --- 4: the row draws them, and says what they are ----------------------
    // The default label describes a reply to something; before anything has
    // been said there is nothing to reply to, and a screen reader is told so.
    const row = /** @type {any} */ (document.createElement('reply-suggestions'));
    container.appendChild(row);
    row.update([...STARTER_PROMPTS], 'Things to ask');

    const chips = row.querySelectorAll('.reply-suggestion');
    assert(chips.length === STARTER_PROMPTS.length,
      `expected ${STARTER_PROMPTS.length} chips, got ${chips.length}`);
    assert(row.hidden === false, 'the row stayed hidden with prompts to show');
    assert(row.getAttribute('aria-label') === 'Things to ask',
      `the row is still labelled "${row.getAttribute('aria-label')}" — it is not offering replies`);
    passed++;

    // --- 5: a chip drafts, and sends nothing --------------------------------
    /** @type {string[]} */
    const chosen = [];
    row.addEventListener('reply-suggestion-chosen', (/** @type {any} */ e) => {
      chosen.push(e.detail?.text);
    });
    chips[0].click();
    assert(chosen.length === 1 && chosen[0] === STARTER_PROMPTS[0],
      `clicking a chip reported ${JSON.stringify(chosen)}, want ["${STARTER_PROMPTS[0]}"]`);
    passed++;

    // --- 6: the label is part of what "changed" means -----------------------
    // The row skips a redraw when the suggestions match, which is what stops it
    // swallowing a click mid-stream. The same list under a different label is
    // still a change, or the group keeps a name that no longer fits.
    row.update([...STARTER_PROMPTS], 'Suggested replies');
    assert(row.getAttribute('aria-label') === 'Suggested replies',
      'the row kept its old label when only the label changed');
    passed++;

    // --- 7: an empty list hides it ------------------------------------------
    row.update([], 'Things to ask');
    assert(row.hidden === true, 'the row stayed visible with nothing to offer');
    passed++;
  } catch (error) {
    failed++;
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}

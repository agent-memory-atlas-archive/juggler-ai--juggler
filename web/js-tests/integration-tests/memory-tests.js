//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Project Memory
 *
 * Verifies the `autoInstantiate` seeding wiring end-to-end: when a project's
 * `.juggler/MEMORY.md` exists, a newly-created conversation auto-instantiates
 * the singleton `memory` context item (system position) so its entries inject
 * into the system prompt. The symmetric "absent → not seeded" case is covered
 * by unit:memory-seed (and implicitly by every other test's golden, which would
 * gain a phantom item if seeding were unconditional).
 * @module integration-tests/memory-tests
 */

import { toolUseResponse, textResponse } from '../utilities/integration-test-runner.js';
import { assembleSystemPrompt } from '../../js/services/system-prompt-builder.js';

const CONTEXT_PARAMS = { contextWindowSize: 128000, modelConfig: null, helpers: {} };

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number} The number of non-overlapping occurrences of needle in haystack.
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

/**
 * Compact dump of every memory-relevant root item — used in the failure
 * message so a double-render is diagnosable from one scrollback (which item
 * carries `contextItemId`, which carries a standing `itemId`, the result's
 * `resultType`).
 * @param {import('../../model/conversation.js').default} conversation
 * @returns {string} A newline-joined dump of memory-relevant items, or a fallback message.
 */
function dumpMemoryItems(conversation) {
  const rows = [];
  for (const item of conversation.rootMessageThread.items) {
    const type = item.get('type');
    const itemId = item.get('itemId');
    const ctxId = item.get('contextItemId');
    if (type !== 'memory' && type !== 'tool-action' && !ctxId) continue;
    const result = item.get('result');
    const resultType = result?.get?.('resultType') ?? (result?.toJSON ? result.toJSON()?.resultType : undefined);
    rows.push(`type=${type} itemId=${itemId ?? '∅'} contextItemId=${ctxId ?? '∅'} resultType=${resultType ?? '∅'}`);
  }
  return rows.join('\n      ') || '(no memory-relevant items)';
}

/**
 * Memory file present at the project root → a new conversation gains a memory
 * context item. Touches the fixed `.juggler/MEMORY.md` at the project root
 * (a fixed path no per-test prefix can hide behind), so it is scheduled alone
 * via needsExclusiveRun, exactly like the CLAUDE.md auto-detection test.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const memorySeededWhenFileExistsTest = {
  name: 'memory-seeded-when-file-exists',
  description: 'A new conversation auto-instantiates the memory item when .juggler/MEMORY.md exists',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  llmResponses: [],

  operations: [
    { type: 'write-fixture-file', path: '.juggler/MEMORY.md', content: '# Memory\n\n- [2026-06-14] Build is `make build`\n' },
    // Created AFTER the file exists → seedAutoContextItems gates true → memory seeded.
    // create-conversation switches the active conversation to the new one.
    { type: 'create-conversation', name: 'MemSeed' },
    { type: 'delete-fixture-file', path: '.juggler/MEMORY.md' }
  ],

  // The new conversation carries the seeded memory item alongside the system prompt.
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'memory', itemId: '$ITEM_2' }
  ]
};

/**
 * The assembled system prompt is a pure function of conversation-document state
 * across a mid-conversation `memory remember` round-trip: the memory block
 * appears EXACTLY ONCE and carries both the pre-existing and the newly-
 * remembered entry — not duplicated. A duplicated block would change the cached
 * system-prefix bytes for the same meaningful state and spuriously cold-start
 * the warm claudecode CLI resume.
 *
 * Both facts are present here because this conversation carries no memory item
 * until the tool's own `_ensureSeeded` creates one, DURING the round-trip and
 * after the write — so the snapshot frozen at that moment already includes the
 * new fact. A conversation seeded earlier would keep its own snapshot instead;
 * that freeze is pinned by the unit tests in `_tests/memory-item-test.js`.
 *
 * This guards against the hypothesised double-render vector — `getContextItems`
 * materialising a system-position item from BOTH the standing item AND a
 * context-result tool-action (`resultType==='context'` + `contextItemId`). It
 * cannot happen for `memory`: the item defines `execute()`, so the tool is
 * dispatched through the ACTION path (`_runActionAndComplete`), whose result is
 * always stamped `resultType:'action'` and never carries a `contextItemId`. The
 * assertions below pin exactly that shape, so a future change that re-routed
 * memory through the context-item path (and thus could double-render) trips this
 * test rather than silently regressing cache stability.
 *
 * Touches the fixed `.juggler/MEMORY.md` at the project root, so it is
 * scheduled alone via needsExclusiveRun.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const memorySystemPromptStableAcrossRememberTest = {
  name: 'memory-system-prompt-stable-across-remember',
  description: 'A memory remember round-trip leaves the assembled system prompt with the memory block exactly once',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  // Seed the project memory file so the memory block has prior content.
  // The default harness conversation was created BEFORE this write, so it
  // carries NO standing memory item yet — the memory tool's own _ensureSeeded
  // is what instantiates the single standing item, in the engine, during the
  // round-trip. (Driving the tool on the default conversation, rather than a
  // freshly-created one, keeps the engine's copy of the system-position memory
  // item in sync for the follow-up turn's context-render — a brand-new
  // conversation would race that sync and stall the render-context request.)
  // The runner deletes this path in cleanup, so the appended fact never leaks.
  setupFiles: { '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] Seeded fact\n' },

  // The model calls the memory tool to remember a new fact, then replies.
  llmResponses: [
    toolUseResponse('mem_call_1', 'memory', { action: 'remember', fact: 'Newly learned fact' }),
    textResponse('Remembered.')
  ],

  operations: [
    { type: 'send-message', message: 'remember something for me' }
  ],

  // Fence until the tool round-trip has fully completed (final text landed).
  settleUntil: (conversation) => conversation.rootMessageThread.items.some(
    (/** @type {any} */ it) => it.get('type') === 'assistant' && String(it.get('content') || '').includes('Remembered')
  ),

  customAssertions: async (conversation) => {
    const root = conversation.rootMessageThread;
    const contextItems = root.contextItems;

    // Exactly one standing memory context item — not one per tool-action.
    const memItems = contextItems.filter((/** @type {any} */ i) => i.type === 'memory');
    if (memItems.length !== 1) {
      throw new Error(
        `expected exactly ONE memory context item, found ${memItems.length}.\n` +
				`      ${dumpMemoryItems(conversation)}`
      );
    }

    // Root cause pin: the memory tool-action is ACTION-dispatched, so it can
    // never be picked up by getContextItems' context-result branch (which
    // keys on resultType==='context' + a contextItemId). If either of these
    // changed, the tool-action would double-materialise as a 2nd memory item.
    const memToolAction = root.items.find(
      (/** @type {any} */ it) => it.get('type') === 'tool-action' && it.get('toolName') === 'memory'
    );
    if (!memToolAction) {
      throw new Error(`memory tool-action missing.\n      ${dumpMemoryItems(conversation)}`);
    }
    const result = memToolAction.get('result');
    const resultType = result?.get?.('resultType') ?? (result?.toJSON ? result.toJSON()?.resultType : undefined);
    const contextItemId = memToolAction.get('contextItemId');
    if (resultType !== 'action' || contextItemId) {
      throw new Error(
        `memory tool-action must be action-dispatched (resultType='action', no contextItemId); ` +
				`got resultType=${resultType ?? '∅'} contextItemId=${contextItemId ?? '∅'}.\n` +
				`      ${dumpMemoryItems(conversation)}`
      );
    }

    // Assemble identity + system-position items via the shared production
    // builder. Extension contributions are constant across the round-trip and
    // orthogonal to the memory block, so they are omitted (and would await a
    // registries-ready signal the headless test page never raises).
    const prompt = await assembleSystemPrompt({ contextItems, contextParams: CONTEXT_PARAMS });

    const blockCount = countOccurrences(prompt, '=== Project Memory ===');
    const seededCount = countOccurrences(prompt, 'Seeded fact');
    const newCount = countOccurrences(prompt, 'Newly learned fact');

    if (blockCount !== 1 || seededCount !== 1 || newCount !== 1) {
      throw new Error(
        `assembled system prompt is not a pure function of state — ` +
				`memory block ×${blockCount} (want 1), "Seeded fact" ×${seededCount} (want 1), ` +
				`"Newly learned fact" ×${newCount} (want 1).\n` +
				`      ${dumpMemoryItems(conversation)}\n` +
				`--- assembled prompt ---\n${prompt}`
      );
    }
  }
};

export const tests = [memorySeededWhenFileExistsTest, memorySystemPromptStableAcrossRememberTest];

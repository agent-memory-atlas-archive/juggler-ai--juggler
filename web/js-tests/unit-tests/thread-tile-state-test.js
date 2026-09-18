//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a thread tile claims about itself, against what its state actually is.
 *
 * Two claims, both read without being read consciously. The icon pulse is the
 * only moving pixel on a resting tile, so it is taken as "this is working"
 * whatever the text beside it says. The Stop is the only affordance a parent
 * column has while a run is open — no Continue, nothing processing to stop,
 * Escape with nothing to cancel — so a tile that withholds it is a conversation
 * with no way forward but a root Escape.
 *
 * Driven through the real component and the real classifier, because both bugs
 * this pins lived in the gap between them: `getThreadStatus` said `errored`, and
 * the tile pulsed anyway and offered no way out.
 * @module unit-tests/thread-tile-state-test
 */

import { assert } from '../utilities/test-helpers.js';
import { getThreadStatus } from '../../js/utils/thread-display.js';
import '../../js/components/thread-message.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  const Y = await import('../../js/vendor/yjs.mjs');
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {Record<string, any>} fields - Item fields.
   * @returns {any} a Y.Map shaped like a conversation item
   */
  const item = (fields) => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    return m;
  };

  /**
   * Build one thread item, live in a document, with the given fields and nested
   * items — the shape the tile reads.
   * @param {Record<string, any>} fields - Fields on the thread itself.
   * @param {Array<Record<string, any>>} [nested] - Items inside the thread.
   * @returns {any} The thread Y.Map.
   */
  const thread = (fields, nested = []) => {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'Read the config');
      const items = new Y.Array();
      t.set('items', items);
      for (const [k, v] of Object.entries(fields)) t.set(k, v);
      for (const n of nested) items.push([item(n)]);
    });
    return t;
  };

  /** The fields that mark a thread as standing for one call, with that call's run still open. */
  const openRunFields = {
    runToolUseId: 'tu-1', runToolName: 'create_thread', runToolInput: { goal: 'Read the config' },
  };
  /** The invocation item that open run was started by. */
  const openRunItem = {
    type: 'user', itemId: 'inv-0', content: 'read it', runToolUseId: 'tu-1', runStatus: '', runResult: '',
  };

  // One fixture per state the tile can be in, each paired with the two claims it
  // should make: whether it has work outstanding (the pulse), and whether there
  // is something for a Stop to act on.
  const states = [
    {
      name: 'running', kind: 'running', pulses: true, stop: true,
      thread: () => thread({}),
      live: { byThread: { T1: 'Streaming • 250 tokens' } },
    },
    {
      name: 'pending', kind: 'pending', pulses: true, stop: true,
      thread: () => thread({ needsStrategyRun: true }),
      live: null,
    },
    {
      name: 'paused', kind: 'paused', pulses: true, stop: true,
      thread: () => thread({}, [{ type: 'tool-action', itemId: 'ta-1', toolName: 'bash', state: 'pending' }]),
      live: null,
    },
    {
      // Nothing of this thread's own is moving, but a sibling's is and the
      // worker admits threads as capacity allows: its turn is coming.
      name: 'queued', kind: 'queued', pulses: true, stop: false,
      thread: () => thread({}),
      live: { byThread: { T2: 'Streaming • 250 tokens' } },
    },
    {
      // The incident: a delegated child stopped by a usage cap. Its run never
      // settled, so the caller that made the call is parked on it and nothing is
      // coming to free it — this tile is the only place that can.
      name: 'errored, run still open', kind: 'errored', pulses: false, stop: true,
      thread: () => thread(openRunFields, [openRunItem,
        { type: 'error', itemId: 'e-1', content: 'usage limit reached' }]),
      live: null,
    },
    {
      // The same label with nobody waiting behind it. A Stop here would act on
      // nothing, so offering one is a claim that there is a way out of a state
      // that needs no way out.
      name: 'errored, no run open', kind: 'errored', pulses: false, stop: false,
      thread: () => thread({}, [{ type: 'error', itemId: 'e-1', content: 'usage limit reached' }]),
      live: null,
    },
    {
      name: 'unfinished', kind: 'unfinished', pulses: false, stop: true,
      thread: () => thread(openRunFields, [openRunItem]),
      live: null,
    },
    {
      name: 'idle', kind: 'idle', pulses: false, stop: false,
      thread: () => thread({}),
      live: null,
    },
  ];

  // --- 1: the pulse marks work outstanding, and the Stop marks a way out ---
  for (const state of states) {
    try {
      const t = state.thread();
      const classified = getThreadStatus(t, state.live);
      assert(classified.kind === state.kind,
        `fixture '${state.name}' classified as '${classified.kind}' — the fixture, not the tile, is wrong`);

      const tile = /** @type {any} */ (document.createElement('thread-message'));
      document.body.appendChild(tile);
      try {
        tile.updateFromItem(t, state.live);
        const busy = tile.querySelector('article')?.getAttribute('data-processing') === 'true';
        assert(busy === state.pulses, state.pulses
          ? `a '${state.name}' thread has work outstanding, so its icon must pulse`
          : `a '${state.name}' thread is not working — the pulse would be the only moving pixel in the state, `
            + `saying the opposite of the label beside it ("${classified.message}")`);

        const stop = !!tile.querySelector('.thread-stop-btn');
        assert(stop === state.stop, state.stop
          ? `a '${state.name}' thread has something to stop or an open run to settle, and this tile is where the `
            + 'user gets at it — a parent column parked on an open run has no other affordance'
          : `a '${state.name}' thread has neither work in flight nor an open run, so a Stop would act on nothing`);
      } finally {
        tile.remove();
      }
      passed++;
    } catch (e) { failed++; errors.push(`${state.name}: ${msg(e)}`); }
  }

  // --- 2: the Stop on a thread nothing is driving says what it does ---
  // It settles the run; it stops no work, because there is none. "Stop this
  // thread" would describe an action the click does not perform.
  try {
    const t = thread(openRunFields, [openRunItem, { type: 'error', itemId: 'e-1', content: 'usage limit reached' }]);
    const tile = /** @type {any} */ (document.createElement('thread-message'));
    document.body.appendChild(tile);
    try {
      tile.updateFromItem(t, null);
      const label = tile.querySelector('.thread-stop-btn')?.getAttribute('aria-label') || '';
      assert(label === 'Stop waiting for this thread',
        `a Stop that only settles an open run must say so; got "${label}"`);
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`stop label: ${msg(e)}`); }

  // --- 3: a tile at rest showing its summary claims nothing ---
  try {
    const t = thread({ result: 'The config lives in config.go.' });
    const tile = /** @type {any} */ (document.createElement('thread-message'));
    document.body.appendChild(tile);
    try {
      tile.updateFromItem(t, null);
      assert(getThreadStatus(t, null).showSummary === true, 'a thread at rest with a result shows its summary');
      assert(tile.querySelector('article')?.getAttribute('data-processing') !== 'true',
        'a tile showing the answer it came back with is finished');
      assert(!tile.querySelector('.thread-stop-btn'),
        'and there is nothing left to stop');
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`summary tile: ${msg(e)}`); }

  // --- 4: the mark tracks a state change that adds or removes no spinner ---
  // queued → idle is the transition with nothing else to notice it by: neither
  // state has a spinner and neither offers a Stop, so a tile that keys its
  // structure on those alone keeps the mark it was built with.
  try {
    const t = thread({});
    const tile = /** @type {any} */ (document.createElement('thread-message'));
    document.body.appendChild(tile);
    try {
      /** @returns {boolean} whether the tile face is marked as work outstanding. */
      const busy = () => tile.querySelector('article')?.getAttribute('data-processing') === 'true';

      tile.updateFromItem(t, { byThread: { T2: 'Streaming • 250 tokens' } });
      assert(busy(), 'a thread waiting its turn is work outstanding');
      tile.setLiveStatus(null);
      assert(!busy(), 'once nothing is running at all, the thread is at rest and the mark clears');
      tile.setLiveStatus({ byThread: { T2: 'Streaming • 250 tokens' } });
      assert(busy(), 'and it comes back when the conversation does');
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`mark tracks both ways: ${msg(e)}`); }

  return { passed, failed, errors };
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Column width persistence.
 *
 * A dragged column width belongs to the window (services/prefs.js), so it is
 * kept in the project's session and survives the app being relaunched onto a
 * different port. What that costs is a round trip, and a column cannot wait for
 * one to have a width — so a mount applies the cached width at once and takes
 * the session's answer when it arrives.
 *
 * These pin both halves, and the rule that keeps the second from being
 * destructive: a width a column was merely GIVEN is never written back, or the
 * first window to open would stamp its default over the width another window
 * had stored and this one had not yet heard about.
 * @module unit-tests/column-width-test
 */

import { waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { setupColumnResize } = await import('../../js/utils/column-resize.js');
  const { setDevicePref, __resetPrefsForTests } = await import('../../js/services/prefs.js');

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  let seq = 0;
  const uniqueName = () => `juggler-test-width-${Date.now().toString(36)}-${seq++}`;

  /** @type {Array<{url: string, method: string}>} */
  let calls = [];
  /** @type {Record<string, any>} */
  let realm = {};
  const realFetch = window.fetch;

  /**
   * A column with the resize handle the wiring looks for.
   * @returns {HTMLElement} The mounted element, to be removed by the caller.
   */
  const makeColumn = () => {
    const column = document.createElement('div');
    column.appendChild(document.createElement('col-resize-handle'));
    document.body.appendChild(column);
    return column;
  };

  try {
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      calls.push({ url: String(url), method: (init && init.method) || 'GET' });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ui: realm }),
        json: async () => ({ ui: realm }),
      };
    });

    await run('a cached width is applied without waiting for the session', () => {
      __resetPrefsForTests();
      calls = [];
      realm = {};
      const name = uniqueName();
      setDevicePref(name, 42);
      const column = makeColumn();
      try {
        setupColumnResize(column, name, 12.5, 30);
        // Synchronously, in the same turn as the mount: this is the whole point
        // of keeping a cache in front of an asynchronous store.
        if (column.style.width !== '42rem') {
          throw new Error(`width = ${column.style.width}, want 42rem`);
        }
      } finally {
        column.remove();
      }
    });

    await run('the default is used when this window has stored nothing', () => {
      __resetPrefsForTests();
      calls = [];
      realm = {};
      const column = makeColumn();
      try {
        setupColumnResize(column, uniqueName(), 12.5, 30);
        if (column.style.width !== '30rem') {
          throw new Error(`width = ${column.style.width}, want the caller's 30rem default`);
        }
      } finally {
        column.remove();
      }
    });

    await run('a width stored only in the session arrives and is applied', async () => {
      __resetPrefsForTests();
      calls = [];
      const name = uniqueName();
      realm = { [name]: 55 };
      const column = makeColumn();
      try {
        setupColumnResize(column, name, 12.5, 30);
        await waitFor(() => column.style.width === '55rem', {
          timeoutMs: budgetFor(2000),
          description: "the session's stored width to reach the column",
        });
        // And the arrival is not a choice the user made, so nothing goes back.
        if (calls.some((c) => c.method === 'PUT')) {
          throw new Error('applying a width the session already held wrote it back again');
        }
      } finally {
        column.remove();
      }
    });

    await run('a default is never written back over what a window has stored', async () => {
      __resetPrefsForTests();
      calls = [];
      realm = {};
      const column = makeColumn();
      try {
        setupColumnResize(column, uniqueName(), 12.5, 30);
        await waitFor(() => calls.some((c) => c.method === 'GET'), {
          timeoutMs: budgetFor(2000),
          description: 'the session to be asked for the width',
        });
        if (calls.some((c) => c.method === 'PUT')) {
          throw new Error('a column that was merely given a default stored it');
        }
      } finally {
        column.remove();
      }
    });
  } finally {
    // Each case used a preference name of its own, so nothing is left behind
    // that another lane could read; the module cache is shared within a lane,
    // so that does have to go.
    window.fetch = realFetch;
    __resetPrefsForTests();
  }

  return { passed, failed, errors };
}

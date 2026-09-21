//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UI preference store unit test.
 *
 * services/prefs.js keeps a preference in one of five realms. Three of them are
 * server-side, because localStorage is partitioned by origin and a window's
 * origin is its port — which is not stable per project, so a relaunch onto
 * another port hands the window an empty store and every setting appears to have
 * reverted. What makes those three usable at render time is the rule this pins:
 * localStorage is a warm cache written on every set, the realm is the truth, and
 * a reader takes the cache now and reconciles when the realm answers.
 *
 * Also pinned here: which store wins for a desktop window and which for a remote
 * browser (a phone must not redecorate the desktop it dialled into), that a
 * value left behind in localStorage by an older build is adopted and promoted
 * exactly once, that a drag's worth of writes makes ONE request, and that a
 * remote viewer's refused write still leaves it its own copy.
 * @module unit-tests/prefs-test
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

  const prefs = await import('../../js/services/prefs.js');
  const {
    scopedKey, resolvePref,
    getTabPref, setTabPref,
    getDevicePref, setDevicePref,
    getWindowPref, setWindowPref, cachedWindowPref,
    getUserPref, setUserPref, cachedUserPref,
    __resetPrefsForTests,
  } = prefs;

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {any} actual
   * @param {any} expected
   * @param {string} what
   */
  const eq = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };

  // A name no other lane uses: localStorage is shared by every document on the
  // origin, and these tests write to it.
  let seq = 0;
  const uniqueName = () => `juggler-test-pref-${Date.now().toString(36)}-${seq++}`;

  /** @type {Array<{url: string, method: string, body: any}>} */
  let calls = [];
  /** @type {(url: string, method: string) => {status: number, body: any}} */
  let respond = () => ({ status: 200, body: { ui: {} } });
  const realFetch = window.fetch;

  /**
   * Stand in for the server so the realms answer deterministically and nothing
   * a lane does reaches the session other lanes are sharing.
   * @param {any} url
   * @param {any} init
   * @returns {Promise<any>} The stubbed response: what services/http.js reads.
   */
  const stubFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const answer = respond(String(url), method);
    const text = JSON.stringify(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: '',
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  const originalProjectKey = window.__projectKey;
  const originalWindowMode = document.documentElement.dataset.windowMode;

  /**
   * Start each case from nothing: a fresh module cache, no recorded calls, and
   * a named client (desktop windows and remote browsers rank the realms
   * differently, so every case has to say which it is).
   * @param {boolean} desktop
   */
  const reset = (desktop = true) => {
    __resetPrefsForTests();
    calls = [];
    respond = () => ({ status: 200, body: { ui: {} } });
    if (desktop) document.documentElement.dataset.windowMode = '1';
    else delete document.documentElement.dataset.windowMode;
  };

  try {
    window.fetch = stubFetch;
    window.__projectKey = 'testproject';

    // --- the scoping rule -------------------------------------------------

    await run('scopedKey namespaces by project', () => {
      window.__projectKey = 'abc123';
      eq(scopedKey('juggler-zoom'), 'juggler-zoom:abc123', 'scoped key');
    });

    await run('scopedKey separates two projects', () => {
      window.__projectKey = 'aaa';
      const first = scopedKey('juggler-theme');
      window.__projectKey = 'bbb';
      if (first === scopedKey('juggler-theme')) {
        throw new Error('two projects produced the same key, so their themes would collide');
      }
    });

    await run('scopedKey falls back to the bare key with no project', () => {
      window.__projectKey = '';
      eq(scopedKey('juggler-zoom'), 'juggler-zoom', 'no-project key');
    });

    await run('desktop takes the server realm first, remote its own device', () => {
      eq(resolvePref({ desktop: true, session: 130, device: 90, windowScoped: [70], fallback: 110 }),
        130, 'desktop resolved value');
      eq(resolvePref({ desktop: true, session: null, device: 90, windowScoped: [70], fallback: 110 }),
        70, 'seed outranks device on desktop');
      // The regression the rule exists for: zooming out on a phone must not come
      // home and shrink the desktop window it dialled into.
      eq(resolvePref({ desktop: false, session: 130, device: 70, fallback: 110 }),
        70, 'remote resolved value');
      eq(resolvePref({ desktop: false, session: 130, device: null, fallback: 110 }),
        130, 'a remote device with nothing of its own still starts from the project');
      eq(resolvePref({ desktop: false, session: null, device: null, fallback: 110 }),
        110, 'stock default');
      eq(resolvePref({ desktop: true, session: undefined, device: 90, fallback: 110 }),
        90, 'undefined is skipped like null');
    });

    window.__projectKey = 'testproject';

    // --- the synchronous realms -------------------------------------------

    await run('a tab preference round-trips', () => {
      reset();
      const name = uniqueName();
      eq(getTabPref(name, 'default'), 'default', 'unset');
      setTabPref(name, { a: 1 });
      eq(getTabPref(name, null), { a: 1 }, 'stored');
    });

    await run('a device preference round-trips and is scoped', () => {
      reset();
      const name = uniqueName();
      setDevicePref(name, 42);
      eq(getDevicePref(name, null), 42, 'stored');
      eq(localStorage.getItem(scopedKey(name)), '42', 'stored under the scoped key');
    });

    await run('a corrupt stored value reads as the default', () => {
      reset();
      const name = uniqueName();
      localStorage.setItem(scopedKey(name), '{not json');
      eq(getDevicePref(name, 'fallback'), 'fallback', 'corrupt value');
    });

    // --- the asynchronous realms ------------------------------------------

    await run('a window preference is written to the cache at once and to the realm after', async () => {
      reset();
      const name = uniqueName();
      const done = setWindowPref(name, 31.5);
      // Synchronously, before the request has been made: this is what a render
      // reads, and why an async realm does not cost a flash of the default.
      eq(cachedWindowPref(name, null), 31.5, 'cached immediately');
      await done;
      const put = calls.filter((c) => c.method === 'PUT');
      eq(put.length, 1, 'one PUT');
      eq(put[0].body, { ui: { [name]: 31.5 } }, 'PUT body');
      if (!put[0].url.startsWith('/api/session/ui-prefs')) {
        throw new Error(`PUT went to ${put[0].url}`);
      }
    });

    await run('a burst of writes makes one request carrying the last value', async () => {
      reset();
      const name = uniqueName();
      setWindowPref(name, 20);
      setWindowPref(name, 30);
      await setWindowPref(name, 40);
      const put = calls.filter((c) => c.method === 'PUT');
      eq(put.length, 1, 'one PUT for a drag');
      eq(put[0].body, { ui: { [name]: 40 } }, 'the last value');
      eq(cachedWindowPref(name, null), 40, 'cache holds the last value');
    });

    await run('the realm outranks the cache in a desktop window', async () => {
      reset();
      const name = uniqueName();
      setDevicePref(name, 'stale');
      respond = () => ({ status: 200, body: { ui: { [name]: 'fresh' } } });
      eq(await getWindowPref(name, null), 'fresh', 'resolved value');
      eq(cachedWindowPref(name, null), 'fresh', 'cache reconciled to the realm');
    });

    await run('a remote viewer keeps its own value over the desktop\u2019s', async () => {
      reset(false);
      const name = uniqueName();
      setWindowPref(name, 'mine');
      respond = () => ({ status: 200, body: { ui: { [name]: 'the desktop\u2019s' } } });
      eq(await getWindowPref(name, null), 'mine', 'remote resolved value');
    });

    await run('a value left by an older build is adopted and promoted once', async () => {
      reset();
      const name = uniqueName();
      // How every one of these preferences is stored before this change: one
      // unscoped localStorage key, with nothing in the realm.
      localStorage.setItem(name, JSON.stringify('inherited'));
      eq(await getWindowPref(name, null), 'inherited', 'adopted');
      // The promotion rides the ordinary write queue, so it is on its way rather
      // than already sent.
      await waitFor(() => calls.some((c) => c.method === 'PUT'), {
        timeoutMs: budgetFor(2000),
        description: 'the adopted value to be promoted to the realm',
      });
      eq(calls.filter((c) => c.method === 'PUT')[0].body, { ui: { [name]: 'inherited' } }, 'promoted value');
      eq(await getWindowPref(name, null), 'inherited', 'still there');
      eq(calls.filter((c) => c.method === 'PUT').length, 1, 'and promoted only once');
    });

    await run('the realm is asked for once however many preferences want it', async () => {
      reset();
      const [a, b, c] = [uniqueName(), uniqueName(), uniqueName()];
      await Promise.all([
        getWindowPref(a, null),
        getWindowPref(b, null),
        getWindowPref(c, null),
      ]);
      eq(calls.filter((x) => x.method === 'GET').length, 1, 'one GET for three reads');
    });

    await run('a refused write leaves the viewer its own copy', async () => {
      reset(false);
      const name = uniqueName();
      respond = (_url, method) => method === 'PUT'
        ? { status: 403, body: { error: 'UI preferences are per-device: a remote viewer keeps its own' } }
        : { status: 200, body: { ui: {} } };
      await setWindowPref(name, 'mine');
      eq(cachedWindowPref(name, null), 'mine', 'kept locally after the refusal');
    });

    await run('a user preference rides the settings document', async () => {
      reset();
      const name = uniqueName();
      await setUserPref(name, { seen: ['a'] });
      const put = calls.filter((x) => x.method === 'PUT');
      eq(put.length, 1, 'one PUT');
      eq(put[0].url, '/api/settings', 'to the settings route');
      eq(put[0].body, { ui: { [name]: { seen: ['a'] } } }, 'PUT body');
      eq(cachedUserPref(name, null), { seen: ['a'] }, 'cached');

      reset();
      respond = () => ({ status: 200, body: { ui: { [name]: { seen: ['b'] } } } });
      eq(await getUserPref(name, null), { seen: ['b'] }, 'read back from the realm');
    });

    await run('a user preference is cached unscoped, so it is warm in every project', async () => {
      reset();
      const name = uniqueName();
      await setUserPref(name, true);
      eq(localStorage.getItem(name), 'true', 'cached under the bare name');
    });

    await run('a realm that cannot be reached falls back rather than throwing', async () => {
      reset();
      const name = uniqueName();
      setDevicePref(name, 'cached');
      respond = () => ({ status: 500, body: { error: 'nope' } });
      eq(await getWindowPref(name, 'default'), 'cached', 'the cache carries it');
      eq(await getWindowPref(uniqueName(), 'default'), 'default', 'and nothing at all is the default');
    });
  } finally {
    window.fetch = realFetch;
    window.__projectKey = originalProjectKey;
    if (originalWindowMode === undefined) delete document.documentElement.dataset.windowMode;
    else document.documentElement.dataset.windowMode = originalWindowMode;
    __resetPrefsForTests();
  }

  return { passed, failed, errors };
}

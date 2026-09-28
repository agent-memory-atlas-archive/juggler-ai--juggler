//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Updates tab — settings UI tests.
 *
 * The Updates tab reads the persisted update mode from GET /api/settings and
 * reflects it on a 3-way radio, PUTs the new mode on change, and runs a manual
 * check via POST /api/update-status/check. These cases drive the component
 * against a stubbed backend (no real server) to pin: the radio reflects the
 * loaded mode, changing it PUTs the new value, and the manual button hits the
 * check endpoint and surfaces the result.
 *
 * Also pinned here: a mode chosen in another window arrives on a settings-changed
 * broadcast and moves these radios — one machine runs a server per open project
 * and they all share settings.json — but never while the user is inside the radio
 * group, where it would move the selection under them mid-choice.
 * @module unit-tests/updates-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import { __resetPrefsForTests } from '../../js/services/prefs.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Route window.fetch to an in-memory settings/update backend.
 * @param {{mode?: string, status?: object}} [opts]
 * @returns {{restore: () => void, calls: Array<{method: string, url: string, body: any}>, state: {mode: string}}} A fake backend with a restore fn, recorded calls, and mutable mode state.
 */
function installFetch(opts = {}) {
  const orig = window.fetch;
  const state = { mode: opts.mode || 'automatic' };
  const status = opts.status || { currentVersion: 'v1.0.0', latestVersion: 'v1.2.0', updateAvailable: true };
  /** @type {Array<{method: string, url: string, body: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    if (u === '/api/settings' && method === 'GET') {
      return { ok: true, json: async () => ({ updates: { mode: state.mode } }) };
    }
    if (u === '/api/settings' && method === 'PUT') {
      state.mode = body.updates.mode;
      return { ok: true, json: async () => ({ updates: { mode: state.mode } }) };
    }
    if (u === '/api/update-status') {
      return { ok: true, json: async () => status };
    }
    if (u === '/api/update-status/check') {
      return { ok: true, json: async () => status };
    }
    return { ok: false, json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/** Let non-awaitable async chains (fetch → json) settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  /**
   * Mount a settings-panel wired to a fake backend, run body, then clean up.
   * @param {{mode?: string, status?: object}} opts
   * @param {(el: any, backend: ReturnType<typeof installFetch>) => Promise<void>} body
   */
  const withPanel = async (opts, body) => {
    const backend = installFetch(opts);
    // The prefs store owns the settings document and reads it once per page —
    // already done at boot, against the real server. Forget that read so this
    // case's backend is the one the panel sees.
    __resetPrefsForTests();
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await body(el, backend);
    } finally {
      el.remove();
      backend.restore();
    }
  };

  await run('radio reflects the loaded mode from /api/settings', async () => {
    await withPanel({ mode: 'off' }, async (el) => {
      el._tabs.updates.show();
      await settle();
      const radios = [...el.querySelectorAll('.updates-mode-radio')];
      assert(radios.length === 3, `three modes; got ${radios.length}`);
      const checked = radios.find((r) => r.checked);
      assert(checked && checked.value === 'off', `off is selected; got ${checked && checked.value}`);
    });
  });

  await run('changing the radio PUTs the new mode', async () => {
    await withPanel({ mode: 'automatic' }, async (el, backend) => {
      el._tabs.updates.show();
      await settle();
      const notify = [...el.querySelectorAll('.updates-mode-radio')].find((r) => r.value === 'notify');
      assert(notify, 'notify radio present');
      notify.click();
      await settle();
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(put, 'a PUT /api/settings was issued');
      assert(put.body.updates.mode === 'notify', `PUT body mode = ${put.body.updates.mode}`);
      assert(backend.state.mode === 'notify', `backend mode persisted; got ${backend.state.mode}`);
    });
  });

  await run('manual check hits the check endpoint and surfaces the result', async () => {
    await withPanel({ status: { currentVersion: 'v1.0.0', latestVersion: 'v1.2.0', updateAvailable: true } }, async (el, backend) => {
      el._tabs.updates.show();
      await settle();
      const btn = el.querySelector('#updates-check-btn');
      assert(btn, 'check button present');
      btn.click();
      await settle();
      const check = backend.calls.find((c) => c.url === '/api/update-status/check' && c.method === 'POST');
      assert(check, 'a POST /api/update-status/check was issued');
      const statusText = el.querySelector('#updates-check-status').textContent || '';
      assert(statusText.includes('v1.2.0'), `status mentions the available version; got ${JSON.stringify(statusText)}`);
    });
  });

  // A build from source is never offered updates, but the status it gets still
  // carries the (newer) latest release. Reporting that as "the latest version"
  // tells the user they are running a release they have not got.
  await run('a build from source is never called current', async () => {
    const status = {
      currentVersion: 'v1.0.0-dev', latestVersion: 'v1.2.0', updateAvailable: false, unpublished: true,
    };
    await withPanel({ status }, async (el) => {
      el._tabs.updates.show();
      await settle();
      const info = el.querySelector('#updates-version-info').textContent || '';
      assert(info.includes('v1.0.0-dev'), `version line names this build; got ${JSON.stringify(info)}`);
      assert(info.includes('v1.2.0'), `version line names the latest release; got ${JSON.stringify(info)}`);
      assert(!/latest version/i.test(info), `no "latest version" claim; got ${JSON.stringify(info)}`);

      el.querySelector('#updates-check-btn').click();
      await settle();
      const checked = el.querySelector('#updates-check-status').textContent || '';
      assert(checked.includes('v1.2.0'), `manual check names the latest release; got ${JSON.stringify(checked)}`);
      assert(!/latest version/i.test(checked), `manual check makes no "latest version" claim; got ${JSON.stringify(checked)}`);
    });
  });

  /**
   * A settings document as the server broadcasts it.
   * @param {string} mode
   * @returns {void}
   */
  const broadcastMode = (mode) => {
    wsService._emit('settings-changed', { updates: { mode } });
  };

  await run('a mode set in another window reaches the radios', async () => {
    await withPanel({ mode: 'automatic' }, async (el, backend) => {
      el.switchTab('updates');
      await settle();
      const before = backend.calls.filter((c) => c.url === '/api/settings' && c.method === 'GET').length;

      broadcastMode('off');

      const checked = [...el.querySelectorAll('.updates-mode-radio')].find((r) => r.checked);
      assert(checked && checked.value === 'off', `off is selected; got ${checked && checked.value}`);
      // The document rides the broadcast, so converging costs no request.
      const after = backend.calls.filter((c) => c.url === '/api/settings' && c.method === 'GET').length;
      assert(after === before, `no refetch was needed; ${after - before} GET(s) were made`);
    });
  });

  await run('a broadcast leaves the radio group the user is inside alone', async () => {
    await withPanel({ mode: 'automatic' }, async (el) => {
      // A radio in a hidden panel cannot take focus, and the panel is
      // display:none until it is opened — so this case needs it on screen.
      // open() is not used for it: that also loads the shared config, which this
      // fake backend does not serve, and a failed load raises a modal.
      el.classList.add('show', 'loaded');
      el.switchTab('updates');
      await settle();
      const radios = [...el.querySelectorAll('.updates-mode-radio')];
      const notify = radios.find((r) => r.value === 'notify');
      assert(notify, 'notify radio present');
      notify.focus();
      assert(document.activeElement === notify, 'the radio took focus (the case needs it to)');

      broadcastMode('off');

      const checked = radios.find((r) => r.checked);
      assert(checked && checked.value === 'automatic',
        `the selection under the user is untouched; got ${checked && checked.value}`);
    });
  });

  return { passed, failed, errors };
}

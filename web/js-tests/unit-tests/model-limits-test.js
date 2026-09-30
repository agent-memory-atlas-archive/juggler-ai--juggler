//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Per-model token-limit overrides — settings UI tests.
 *
 * Each row of a provider's model list carries two number fields: the context
 * window and the max output tokens Juggler should assume for that model. Blank
 * means "whatever the provider says", and the provider's own number shows as the
 * placeholder — including on a model the user has already overridden, where it
 * is what clearing the field restores.
 *
 * These drive the tab against a stubbed backend to pin: the fields seed from the
 * published catalogue, an edit PUTs the provider's COMPLETE limits map (the
 * server replaces a named provider's set wholesale rather than merging into it),
 * clearing a field removes just that one, and a rejected save puts the field
 * back rather than leaving a number on screen that was never stored.
 *
 * Also pinned: a catalogue republished because another window changed these
 * settings lands on the controls without rebuilding them — the open list, its
 * filter and a half-typed number all survive.
 * @module unit-tests/model-limits-test
 */

import { assert } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import { ProvidersTab } from '../../js/components/settings/providers-tab.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const PROVIDER = 'test-limits-gateway';

/**
 * Route window.fetch to an in-memory settings backend.
 * @param {{reject?: boolean}} [opts] - `reject` fails every PUT with a 500.
 * @returns {{restore: () => void, calls: Array<{method: string, url: string, body: any}>}} Fake backend with restore and recorded calls.
 */
function installFetch(opts = {}) {
  const orig = window.fetch;
  /** @type {Array<{method: string, url: string, body: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    if (u === '/api/settings' && method === 'PUT') {
      if (opts.reject) return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls };
}

/**
 * Let non-awaitable async chains (fetch → json) settle.
 *
 * Yields via MessageChannel rather than `setTimeout(0)`, for the reason
 * documented at length in proxy-settings-test.js: in this pool's offscreen
 * WebView a `setTimeout(0)` behind a mounted settings panel has been measured at
 * ~1000ms, which would cost this suite its lane.
 * @returns {Promise<void>} Resolves once the queued chains have run.
 */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(undefined); };
      channel.port2.postMessage(undefined);
    });
  }
};

/**
 * The published catalogue this suite renders: one untouched model and one the
 * user has already overridden on both limits.
 * @returns {any} A provider status object as /api/providers publishes it.
 */
function providerFixture() {
  return {
    name: PROVIDER,
    displayName: 'Test Limits Gateway',
    description: '',
    authType: 'api_key',
    configKeyName: 'test_limits_gateway_api_key',
    envVarName: '',
    apiKeyURL: '',
    keySource: '',
    available: true,
    credentialed: true,
    modelsWithContext: [
      { id: 'plain-model', contextWindow: 128000, maxOutputTokens: 16384 },
      {
        id: 'fixed-model',
        contextWindow: 1000000,
        maxOutputTokens: 64000,
        providerContextWindow: 128000,
        providerMaxOutputTokens: 16384,
      },
      // A model whose endpoint published its own limits, which is a different
      // kind of number from the two above and has to read as one.
      { id: 'measured-model', contextWindow: 262144, maxOutputTokens: 32768, fromAPI: true },
      // A server that reported nothing, so the provider's blanket fallback
      // stands in — a guess, unlike the catalogued plain-model above.
      { id: 'guessed-model', contextWindow: 8192, maxOutputTokens: 1638, windowAssumed: true },
    ],
  };
}

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
   * Render a ProvidersTab against a fake backend, run body, then clean up.
   *
   * The tab is driven directly rather than through a mounted settings-panel:
   * the panel's load fans out five fetches and waits on the providers cache,
   * none of which this behaviour depends on.
   * @param {{reject?: boolean}} opts
   * @param {(host: HTMLElement, backend: ReturnType<typeof installFetch>, tab: any) => Promise<void>} body
   */
  const withTab = async (opts, body) => {
    const backend = installFetch(opts);
    const host = document.createElement('div');
    const container = document.createElement('div');
    container.id = 'provider-fields-container';
    host.appendChild(container);
    document.body.appendChild(host);
    try {
      const tab = new ProvidersTab(/** @type {any} */ (host));
      /** @type {any} */ (tab).providers = [providerFixture()];
      /** @type {any} */ (tab).config = {};
      tab.renderProviderFields();
      await body(host, backend, tab);
    } finally {
      host.remove();
      backend.restore();
    }
  };

  /**
   * @param {HTMLElement} host
   * @param {string} modelID
   * @param {string} field - "contextWindow" or "maxOutputTokens"
   * @returns {any} The limit input for that model and field.
   */
  const limitInput = (host, modelID, field) =>
    host.querySelector(`[data-model="${modelID}"] [data-limit="${field}"]`);

  /**
   * @param {ReturnType<typeof installFetch>} backend
   * @returns {any} The limits map from the last PUT /api/settings.
   */
  const lastPutLimits = (backend) => {
    const puts = backend.calls.filter((c) => c.url === '/api/settings' && c.method === 'PUT');
    assert(puts.length > 0, 'a PUT /api/settings was issued');
    return puts[puts.length - 1].body.models.limits[PROVIDER];
  };

  // Hidden models and limits are global settings, so another window can change
  // them. The server folds them into the published catalogue and republishes it,
  // which is how this tab hears: it holds no copy of the settings document.
  //
  // Rebuilding the rows on that would close the model list, clear its filter and
  // throw away the scroll position — for a change that only ever moves a checkbox
  // or a number. So the catalogue is written onto the controls in place.
  await run('a catalogue republished elsewhere lands on the controls in place', async () => {
    await withTab({}, async (host) => {
      const details = host.querySelector('details.model-visibility');
      assert(details, 'the model list exists');
      details.open = true;
      const filter = host.querySelector('.model-visibility-filter');
      filter.value = 'model';

      // Another window hid one model and overrode the other's context window.
      const next = providerFixture();
      next.modelsWithContext[0].hidden = true;
      next.modelsWithContext[2].providerContextWindow = 262144;
      next.modelsWithContext[2].contextWindow = 99000;
      wsService._emit('providers-update', [next]);
      await settle();

      const box = host.querySelector('[data-model="plain-model"] .model-visibility-check');
      assert(box && box.checked === false, 'the hidden model unticked');
      const row = host.querySelector('[data-model="plain-model"]');
      assert(row.classList.contains('is-hidden'), 'and reads as hidden');
      const measured = limitInput(host, 'measured-model', 'contextWindow');
      assert(measured.value === '99000', `the override arrived; got ${JSON.stringify(measured.value)}`);

      // What the user had open and typed is still theirs.
      assert(details.open === true, 'the model list stayed open');
      assert(filter.value === 'model', `the filter query survived; got ${JSON.stringify(filter.value)}`);
    });
  });

  await run('a republished catalogue does not take a number out from under the user', async () => {
    await withTab({}, async (host) => {
      host.querySelector('details.model-visibility').open = true;
      const field = limitInput(host, 'plain-model', 'contextWindow');
      field.focus();
      assert(document.activeElement === field, 'the field took focus (the case needs it to)');
      field.value = '4096';

      const next = providerFixture();
      next.modelsWithContext[0].providerContextWindow = 128000;
      next.modelsWithContext[0].contextWindow = 200000;
      wsService._emit('providers-update', [next]);
      await settle();

      assert(field.value === '4096', `the half-typed number survived; got ${JSON.stringify(field.value)}`);
    });
  });

  await run('fields seed blank with the provider numbers as placeholders', async () => {
    await withTab({}, async (host) => {
      const window_ = limitInput(host, 'plain-model', 'contextWindow');
      const output = limitInput(host, 'plain-model', 'maxOutputTokens');
      assert(window_ && output, 'both limit fields exist on an un-overridden model');
      assert(window_.value === '', `context field is blank; got ${JSON.stringify(window_.value)}`);
      assert(output.value === '', `output field is blank; got ${JSON.stringify(output.value)}`);
      assert(window_.placeholder === '128000', `context placeholder = ${window_.placeholder}, want 128000`);
      assert(output.placeholder === '16384', `output placeholder = ${output.placeholder}, want 16384`);
    });
  });

  await run('each field says where its number came from', async () => {
    await withTab({}, async (host) => {
      // Three numbers that look identical in a box and are not: one the server
      // stated, one Juggler assumed, one the user typed. Without this the only
      // way to tell an assumption from a measurement is to know the code.
      const measured = limitInput(host, 'measured-model', 'contextWindow');
      assert(/reported/i.test(measured.title),
        `a discovered limit should say the provider reported it; got ${JSON.stringify(measured.title)}`);

      const catalogued = limitInput(host, 'plain-model', 'contextWindow');
      assert(/built-in/i.test(catalogued.title) && !/assumed/i.test(catalogued.title),
        `a catalogued limit should say it is built in, not assumed; got ${JSON.stringify(catalogued.title)}`);

      // A provider-wide fallback is a different kind of number again: nobody,
      // not even Juggler's catalogue, knows this model's window.
      const guessed = limitInput(host, 'guessed-model', 'contextWindow');
      assert(/assumed/i.test(guessed.title),
        `a fallback window should say it was assumed; got ${JSON.stringify(guessed.title)}`);

      const overridden = limitInput(host, 'fixed-model', 'contextWindow');
      assert(/128000/.test(overridden.title),
        `an overridden limit should name what clearing restores; got ${JSON.stringify(overridden.title)}`);
    });
  });

  await run('an overridden model shows the override, and what clearing restores', async () => {
    await withTab({}, async (host) => {
      const window_ = limitInput(host, 'fixed-model', 'contextWindow');
      const output = limitInput(host, 'fixed-model', 'maxOutputTokens');
      assert(window_.value === '1000000', `context value = ${window_.value}, want the override 1000000`);
      assert(output.value === '64000', `output value = ${output.value}, want the override 64000`);
      // The placeholder is the provider's own number, not the effective one, so
      // the user can see what emptying the field would go back to.
      assert(window_.placeholder === '128000', `context placeholder = ${window_.placeholder}, want 128000`);
      assert(output.placeholder === '16384', `output placeholder = ${output.placeholder}, want 16384`);
    });
  });

  await run('an edit PUTs the provider\'s complete limits map', async () => {
    await withTab({}, async (host, backend) => {
      const input = limitInput(host, 'plain-model', 'contextWindow');
      input.value = '200000';
      input.dispatchEvent(new Event('change'));
      await settle();
      const limits = lastPutLimits(backend);
      assert(limits['plain-model'].contextWindow === 200000,
        `edited model = ${JSON.stringify(limits['plain-model'])}, want contextWindow 200000`);
      // The other model's existing override has to ride along: the server
      // replaces a named provider's whole set, so omitting it would delete it.
      assert(limits['fixed-model'] && limits['fixed-model'].contextWindow === 1000000
        && limits['fixed-model'].maxOutputTokens === 64000,
      `sibling override dropped from the PUT: ${JSON.stringify(limits['fixed-model'])}`);
    });
  });

  await run('clearing a field drops only that override', async () => {
    await withTab({}, async (host, backend) => {
      const input = limitInput(host, 'fixed-model', 'contextWindow');
      input.value = '';
      input.dispatchEvent(new Event('change'));
      await settle();
      const limits = lastPutLimits(backend);
      assert(!limits['fixed-model'] || limits['fixed-model'].contextWindow === undefined,
        `cleared window still sent: ${JSON.stringify(limits['fixed-model'])}`);
      assert(limits['fixed-model'] && limits['fixed-model'].maxOutputTokens === 64000,
        `the other field was dropped too: ${JSON.stringify(limits['fixed-model'])}`);
    });
  });

  await run('clearing the last override sends an explicit empty set', async () => {
    await withTab({}, async (host, backend) => {
      for (const field of ['contextWindow', 'maxOutputTokens']) {
        const input = limitInput(host, 'fixed-model', field);
        input.value = '';
        input.dispatchEvent(new Event('change'));
        await settle();
      }
      const limits = lastPutLimits(backend);
      // Omitting the provider would leave the stored set untouched, so the only
      // gesture that clears it is naming it with nothing in it.
      assert(limits && Object.keys(limits).length === 0,
        `want an empty set for the provider; got ${JSON.stringify(limits)}`);
    });
  });

  await run('a rejected save puts the field back', async () => {
    await withTab({ reject: true }, async (host) => {
      const input = limitInput(host, 'plain-model', 'contextWindow');
      input.value = '200000';
      input.dispatchEvent(new Event('change'));
      await settle();
      assert(input.value === '', `field reverted to blank; got ${JSON.stringify(input.value)}`);
      const status = host.querySelector('.model-visibility-status');
      assert(status && (status.textContent || '').length > 0, 'a failure message is shown');
    });
  });

  // The deep link a compaction notice or the picker's "assumed" marker follows:
  // the model list starts collapsed, so landing on the tab alone would leave the
  // field to be found by hand.
  await run('revealModel opens the model list and focuses that model\'s window field', async () => {
    await withTab({}, async (host, _backend, tab) => {
      const details = host.querySelector('details.model-visibility');
      assert(details && !details.open, 'the model list starts collapsed (the case needs it to)');
      const revealed = await tab.revealModel(PROVIDER, 'guessed-model');
      assert(revealed === true, `revealModel returned ${revealed}, want true`);
      assert(details.open, 'the model list was left collapsed');
      const field = limitInput(host, 'guessed-model', 'contextWindow');
      assert(document.activeElement === field,
        `focus is on ${document.activeElement?.outerHTML?.slice(0, 80)}, want guessed-model's window field`);
      assert(await tab.revealModel(PROVIDER, 'no-such-model') === false, 'an unknown model reported success');
    });
  });

  await run('a limit field does not toggle the model visibility checkbox', async () => {
    await withTab({}, async (host) => {
      const box = host.querySelector('[data-model="plain-model"] .model-visibility-check');
      assert(box && box.checked, 'the model starts visible');
      const input = limitInput(host, 'plain-model', 'contextWindow');
      // A <label> forwards a click anywhere inside it to its control, so a row
      // that was one big label would hide the model on a click into a number
      // field. Only the checkbox and the name may be inside the label.
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      assert(box.checked, 'clicking a limit field hid the model');
    });
  });

  return { passed, failed, errors };
}

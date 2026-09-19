//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Command editor tests — the model override, from file to picker and back.
 *
 * The dialog now hosts the same `<model-chip>` + `<model-picker>` pair the
 * composer and settings use, and a model reference is four fields, not one. The
 * failure worth guarding is invisible: a dial dropped between the picker and the
 * PUT leaves a command that reads correctly in the editor and runs at settings
 * nobody chose. So these assert the whole reference survives each hop — the
 * file's into the chip, the picker's into the request — and that overrides are
 * written only while the command still opens a thread.
 * @module unit-tests/command-editor-test
 */

import { assert, neutralizeStrayOverlays } from '../utilities/test-helpers.js';
import { openCommandEditor } from '../../js/components/command-editor-dialog.js';
import { buildModelConfig } from '../../js/model/model-config.js';
import providersCache from '../../js/services/providers-cache.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** One provider, one tiered thinking-capable model and one plain one. */
const PROVIDERS = [{
  name: 'p',
  displayName: 'Provider',
  available: true,
  modelsWithContext: [
    {
      id: 'm',
      displayName: 'Model',
      contextWindow: 1000,
      thinkingLevels: ['low', 'high'],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    },
    { id: 'other', displayName: 'Other', contextWindow: 1000 },
  ],
}];

/** A saved sub-thread command carrying a complete model reference. */
const DEF = {
  name: 'review',
  scope: /** @type {'project'} */ ('project'),
  path: '/x/.juggler/commands/review.md',
  frontmatter: {
    description: 'Review a PR',
    run: 'subthread',
    provider: 'p',
    model: 'm',
    thinking: 'high',
    serviceTier: 'priority',
    goal: 'PR review',
  },
  body: 'Review $1',
};

/**
 * A recorded request.
 * @typedef {{url: string, method: string, body: any}} Call
 */

/**
 * Record the command writes rather than sending them, and stand a provider list
 * in for the server-pushed one.
 *
 * Only `/api/user-commands` is answered here; everything else is passed to the
 * real fetch. Saving a command rebuilds the capability registries, and that
 * rebuild refetches the extension catalog: handed this stub's canned command
 * response instead, it caches an EMPTY catalog, and every registry in the lane's
 * shared realm is left empty and marked initialized for the suites that follow.
 * (The rebuild also outlives the save that started it — the suite runner waits
 * it out; see `whenRegistriesSettled`.)
 * @returns {{calls: Call[], restore: () => void}} The harness.
 */
function stubEnvironment() {
  /** @type {Call[]} */
  const calls = [];
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (!String(url).startsWith('/api/user-commands')) return originalFetch.call(window, url, init);
    return { ok: true, status: 200, json: async () => ({ name: DEF.name, scope: DEF.scope, path: DEF.path }) };
  });

  const realGet = providersCache.get;
  const realHasReceived = providersCache.hasReceived;
  providersCache.get = () => /** @type {any} */ (PROVIDERS);
  providersCache.hasReceived = () => true;

  return {
    calls,
    restore: () => {
      window.fetch = originalFetch;
      providersCache.get = realGet;
      providersCache.hasReceived = realHasReceived;
    },
  };
}

/**
 * Open the editor on {@link DEF} and hand back its parts.
 * @returns {{done: Promise<any>, overlay: any, chip: any, save: HTMLElement}} The open dialog.
 */
function openEditor() {
  const done = openCommandEditor({ def: /** @type {any} */ (DEF) });
  const overlay = /** @type {any} */ (document.querySelector('.command-editor-overlay'));
  assert(!!overlay, 'the editor must mount an overlay');
  return {
    done,
    overlay,
    chip: overlay.querySelector('#cmd-model'),
    save: overlay.querySelector('#cmd-save'),
  };
}

/**
 * The PUT the dialog sent.
 * @param {Call[]} calls
 * @returns {any} The request body.
 */
function putBody(calls) {
  const put = calls.find((c) => c.method === 'PUT');
  assert(!!put, `saving must PUT the command, got ${JSON.stringify(calls.map((c) => c.method + ' ' + c.url))}`);
  assert(put.url === '/api/user-commands/project/review', `PUT url = ${put.url}`);
  return put.body;
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test over a freshly stubbed environment, torn down either way.
   * @param {string} label - Test label.
   * @param {(calls: Call[]) => Promise<void>} fn - Test body, given the recorded requests.
   */
  const run = async (label, fn) => {
    const env = stubEnvironment();
    try {
      await fn(env.calls);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      env.restore();
      // Through the sweep, not by removing the element: the overlay holds a
      // popup-manager token that only its own close releases, and a token left
      // registered suppresses every shortcut for the rest of the lane.
      neutralizeStrayOverlays();
      document.querySelector('model-picker')?.remove();
    }
  };

  await run('the chip shows the model the file names', async () => {
    const { done, overlay, save, chip } = openEditor();
    assert(chip?.tagName?.toLowerCase() === 'model-chip', `the model field must be a chip, got ${chip?.tagName}`);
    const config = chip.config;
    assert(config?.provider === 'p' && config?.model === 'm',
      `the chip must show the file's model, got ${JSON.stringify(config)}`);
    assert(config.thinking === 'high' && config.serviceTier === 'priority',
      `the chip must carry both dials, got ${JSON.stringify(config)}`);
    assert((chip.querySelector('.model-name')?.textContent || '').includes('Model'),
      `the button must name the model, got ${JSON.stringify(chip.textContent)}`);
    /** @type {any} */ (save).click();
    await done;
    assert(!overlay.isConnected, 'saving must close the dialog');
  });

  await run('saving writes the whole model reference, dials included', async (calls) => {
    const { done, save } = openEditor();
    /** @type {any} */ (save).click();
    await done;
    const body = putBody(calls);
    assert(body.run === 'subthread', `run = ${body.run}`);
    assert(body.provider === 'p' && body.model === 'm',
      `provider/model = ${body.provider}/${body.model}`);
    assert(body.thinking === 'high', `thinking = ${JSON.stringify(body.thinking)}`);
    assert(body.serviceTier === 'priority', `serviceTier = ${JSON.stringify(body.serviceTier)}`);
  });

  await run('the picker replaces the reference it was opened on', async (calls) => {
    const { done, chip, save } = openEditor();
    chip.dispatchEvent(new CustomEvent('chip-toggle'));
    const picker = /** @type {any} */ (document.querySelector('model-picker'));
    assert(!!picker, 'pressing the chip must open the picker');
    assert(picker.value?.model === 'm', `the picker must open on the current model, got ${JSON.stringify(picker.value)}`);

    picker.dispatchEvent(new CustomEvent('change', { detail: buildModelConfig('p', 'other', '', '') }));
    assert(chip.config?.model === 'other', `the chip must follow the picker, got ${JSON.stringify(chip.config)}`);

    /** @type {any} */ (save).click();
    await done;
    const body = putBody(calls);
    assert(body.model === 'other', `model = ${body.model}`);
    // The new model advertises neither dial, so both are cleared rather than
    // carried over from the model that did.
    assert(body.thinking === '' && body.serviceTier === '',
      `dials must not survive a model that lacks them, got ${JSON.stringify(body)}`);
  });

  await run('a command that no longer opens a thread writes no overrides', async (calls) => {
    const { done, overlay, save } = openEditor();
    const sendSegment = /** @type {HTMLElement} */ (overlay.querySelector('[data-run="send"]'));
    assert(!!sendSegment, 'the run mode must be a segmented control');
    sendSegment.click();
    assert(overlay.querySelector('#cmd-subthread-fields')?.classList.contains('hidden'),
      'leaving thread mode must hide the thread overrides');

    /** @type {any} */ (save).click();
    await done;
    const body = putBody(calls);
    assert(body.run === 'send', `run = ${body.run}`);
    assert(body.provider === '' && body.model === '' && body.thinking === '' && body.serviceTier === '',
      `overrides must be cleared with the thread, got ${JSON.stringify(body)}`);
    assert(body.goal === '' && body.strategy === '', `goal/strategy = ${body.goal}/${body.strategy}`);
  });

  return { passed, failed, errors };
}

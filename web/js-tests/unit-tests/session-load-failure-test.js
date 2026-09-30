//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What ConnectionManager does when the first session load fails.
 *
 * There is one recovery, whatever the failure says: wire the session into the
 * UI anyway, so the project picker is reachable, reject `whenReadyToRun()` with
 * the reason, and tell the user. No failure is special-cased into a page
 * reload. `GET /api/session` has no not-found answer, so a 404 during the load
 * comes from a request made after it — and a reload repeats that request, in a
 * loop the user cannot get out of. Reading "404" out of the message text was
 * worse still: a project path, a conversation name or a file name containing
 * those digits was enough.
 *
 * `window.location.reload` is unforgeable and cannot be stubbed, so these cases
 * assert the recovery happened rather than that a reload did not: the reload
 * branch returned before any of it.
 * @module unit-tests/session-load-failure-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import ConnectionManager from '../../js/services/connection-manager.js';
import Session from '../../js/model/session.js';
import { HttpError } from '../../js/services/http.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run the real `_loadSession` against a Session whose load throws `thrown`,
 * and report what the manager did about it.
 * @param {unknown} thrown - What `Session.load()` throws
 * @returns {Promise<{alerts: string[], readyError: unknown, loaded: boolean}>} The alerts raised, the readiness rejection, and whether the session was marked loaded
 */
async function failLoadWith(thrown) {
  const proto = /** @type {any} */ (Session.prototype);
  const origLoad = proto.load;
  const win = /** @type {any} */ (window);
  const origAlert = win.showAlert;
  /** @type {string[]} */
  const alerts = [];
  const cm = /** @type {any} */ (new ConnectionManager({
    llmState: /** @type {any} */ (null),
    onServerMessage: () => {},
    services: /** @type {any} */ ({})
  }));
  proto.load = async function () {
    throw thrown;
  };
  win.showAlert = (/** @type {string} */ message) => {
    alerts.push(message);
  };
  try {
    await cm._loadSession();
    if (cm._session) trackTestSession(cm._session);
    let readyError = null;
    try {
      await cm.whenReadyToRun();
    } catch (e) {
      readyError = e;
    }
    return { alerts, readyError, loaded: cm._sessionLoaded };
  } finally {
    proto.load = origLoad;
    win.showAlert = origAlert;
    cm._unfollowGit?.();
  }
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
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
   * The recovery every failure must get.
   * @param {{alerts: string[], readyError: unknown, loaded: boolean}} outcome - What failLoadWith reported
   * @param {string} detail - Text of the failure that must reach the user and the waiters
   */
  const assertRecovered = (outcome, detail) => {
    assert(outcome.alerts.length === 1,
      `the failure must be surfaced once, with the picker behind it; got ${outcome.alerts.length} alert(s)`);
    assert(outcome.alerts[0]?.includes(detail),
      `the alert must carry the failure; got ${JSON.stringify(outcome.alerts[0])}`);
    assert(outcome.readyError instanceof Error && outcome.readyError.message.includes(detail),
      `whenReadyToRun() must reject with the load's reason; got ${String(outcome.readyError)}`);
    assert(outcome.loaded === false, 'a failed load must not mark the session loaded');
  };

  await run('a 404 from a request inside the load is a load failure, not a reload', async () => {
    const detail = 'conversation not found';
    assertRecovered(await failLoadWith(new HttpError(`HTTP 404: ${detail}`, 404, detail, { error: detail })), detail);
  });

  await run('"404" in an error message is a load failure, not a reload', async () => {
    const detail = 'open /Users/someone/sites/404-page/.juggler/config.json: permission denied';
    assertRecovered(await failLoadWith(new Error(detail)), detail);
  });

  await run('"Not Found" in an error message is a load failure, not a reload', async () => {
    const detail = 'extension module Not Found: my-plugin';
    assertRecovered(await failLoadWith(new Error(detail)), detail);
  });

  return { passed, failed, errors };
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How `Session.renameConversation` classifies a refused rename.
 *
 * The tab's inline editor acts on the `.code` it gets back: COLLISION keeps the
 * editor open with "already used", INVALID closes it with nothing said, and
 * anything else raises an alert carrying the server's message. So the code must
 * come from the response's status, and from nothing else.
 *
 * The server's 500 arm writes the OS error verbatim, and that error names both
 * folders — `<name>--<id>` — so the new name the user typed is in the message
 * twice. A name containing "409" or "400" is ordinary ("Fix 409 handling",
 * "Q4 2400 budget"), and reading the code out of the message text turned a
 * failed rename into a false "already used", or into a silent close that
 * swallowed the failure outright.
 *
 * Runs against a bare Session with a stub API service — no server, no workers.
 * @module unit-tests/rename-error-code-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import { HttpError } from '../../js/services/http.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A non-OK response as `fetchJson` reports it: "HTTP <status>: <detail>".
 * @param {number} status - HTTP status code
 * @param {string} detail - The server's own error message
 * @returns {HttpError} The error `fetchJson` would throw
 */
function httpError(status, detail) {
  return new HttpError(`HTTP ${status}: ${detail}`, status, detail, { error: detail });
}

/**
 * The server's 500 for a rename the filesystem refused, spelled the way
 * `RobustRename`'s error reaches `WriteError`.
 * @param {string} newName - The name the user typed
 * @returns {HttpError} The error `fetchJson` would throw
 */
function renameRefusedByOS(newName) {
  const dir = '/Users/someone/project/.juggler';
  return httpError(500,
    `rename conv dir: rename ${dir}/Old name--conv_abc ${dir}/${newName}--conv_abc: permission denied`);
}

/**
 * Rename a stub conversation against an API service that throws `thrown`, and
 * return what `renameConversation` threw in turn.
 * @param {unknown} thrown - What the API service's renameConversation throws
 * @param {string} [newName] - The name to ask for
 * @returns {Promise<any>} The error renameConversation rejected with
 */
async function renameThrowing(thrown, newName = 'New name') {
  const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
    renameConversation: async () => { throw thrown; }
  }))));
  session.conversations.set('conv_abc', { id: 'conv_abc' });
  try {
    await session.renameConversation('conv_abc', newName);
  } catch (e) {
    return e;
  }
  throw new Error('renameConversation resolved; the API service threw');
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

  await run('each status the rename route documents maps to its code', async () => {
    for (const [status, detail, want] of /** @type {const} */ ([
      [409, 'Name already in use', 'COLLISION'],
      [400, 'Name is invalid', 'INVALID'],
      [404, 'Conversation not found', 'NOT_FOUND'],
    ])) {
      const err = await renameThrowing(httpError(status, detail));
      assert(err.code === want, `HTTP ${status} should be ${want}, got ${err.code}`);
    }
  });

  await run('a failed rename to a name containing "409" is not a collision', async () => {
    const name = 'Fix 409 handling';
    const err = await renameThrowing(renameRefusedByOS(name), name);
    assert(err.code === undefined,
      `a 500 was reported as ${err.code} — the editor would say "already used" of a name nobody has`);
  });

  await run('a failed rename to a name containing "400" is not swallowed as invalid', async () => {
    const name = 'Q4 2400 budget';
    const err = await renameThrowing(renameRefusedByOS(name), name);
    assert(err.code === undefined,
      `a 500 was reported as ${err.code} — the editor would close without saying the rename failed`);
  });

  await run('a failed rename keeps the server\'s message for the alert', async () => {
    const err = await renameThrowing(renameRefusedByOS('Anything'), 'Anything');
    assert(String(err.message).includes('permission denied'),
      `the alert would lose the reason, message was ${JSON.stringify(err.message)}`);
  });

  await run('a transport failure carries no code', async () => {
    const err = await renameThrowing(new TypeError('Load failed'));
    assert(err.code === undefined, `a network error was reported as ${err.code}`);
    assert(err.message === 'Load failed', `message was ${JSON.stringify(err.message)}`);
  });

  return { passed, failed, errors };
}

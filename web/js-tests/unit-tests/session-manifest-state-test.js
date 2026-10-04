//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How a session manifest's session-level fields — metadata and message
 * history — are adopted by `Session.refreshFromServer`.
 *
 * The manifest is the authority, and the server leaves an empty value out
 * rather than sending it: `metadata` is `omitempty` on core.Session, and an
 * empty history goes out as `null`. So "absent" means "empty". A refresh that
 * kept its old value on absence held state another viewer had already
 * cleared — the last metadata flag removed, the history wiped — until the
 * page was reloaded, while the first load of the same manifest showed it empty.
 *
 * Runs against a bare Session with a stub API service — no server, no workers.
 * @module unit-tests/session-manifest-state-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A bare Session holding some metadata and history, whose API service answers
 * a manifest read with `manifest`. Returns it with the metadata-changed events
 * it raises.
 * @param {object} manifest - What GET /api/session returns
 * @returns {{session: any, metadataEvents: any[]}} The session and its recorded events
 */
function sessionReading(manifest) {
  const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
    getSession: async () => manifest
  }))));
  session.metadata = { staleFlag: true };
  session.messageHistory = [{ content: 'an old message', attachments: [] }];
  /** @type {any[]} */
  const metadataEvents = [];
  session.subscribe((/** @type {any} */ event) => {
    if (event.type === 'session:metadata-changed') metadataEvents.push(event.data);
  });
  return { session, metadataEvents };
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

  await run('a refresh whose manifest omits metadata and history clears both', async () => {
    // Exactly what the server sends once both are empty.
    const { session, metadataEvents } = sessionReading({
      conversationOrder: [],
      conversationNames: {},
      messageHistory: null
    });
    await session.refreshFromServer();
    assert(Object.keys(session.metadata).length === 0,
      `metadata another viewer cleared survived the refresh: ${JSON.stringify(session.metadata)}`);
    assert(session.messageHistory.length === 0,
      `history another viewer cleared survived the refresh: ${JSON.stringify(session.messageHistory)}`);
    assert(metadataEvents.length === 1,
      `subscribers must hear that the metadata changed, heard ${metadataEvents.length} events`);
  });

  await run('a refresh adopts the manifest\'s metadata and history and announces the metadata as remote', async () => {
    const { session, metadataEvents } = sessionReading({
      conversationOrder: [],
      conversationNames: {},
      metadata: { freshFlag: 1 },
      messageHistory: ['a bare legacy entry']
    });
    await session.refreshFromServer();
    assert(session.metadata.freshFlag === 1 && !('staleFlag' in session.metadata),
      `metadata is ${JSON.stringify(session.metadata)}`);
    assert(session.messageHistory.length === 1 && session.messageHistory[0].content === 'a bare legacy entry',
      `history entries must be normalized, got ${JSON.stringify(session.messageHistory)}`);
    assert(metadataEvents.length === 1 && metadataEvents[0].remote === true && metadataEvents[0].keys[0] === 'freshFlag',
      `expected one remote metadata-changed naming freshFlag, got ${JSON.stringify(metadataEvents)}`);
  });

  return { passed, failed, errors };
}

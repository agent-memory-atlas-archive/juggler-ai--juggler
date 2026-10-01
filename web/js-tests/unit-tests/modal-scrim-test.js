//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: a modal's scrim fades out after the modal has gone
 * (utils/modal-scrim.js).
 *
 * The modal closes at once; what is left behind is a stand-in on <body> with
 * the scrim's paint, which must not catch the pointer and must remove itself.
 * A scrim that wasn't showing, or that showed nothing, leaves nothing behind.
 * @module unit-tests/modal-scrim-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { fadeOutScrims } from '../../js/utils/modal-scrim.js';
import { presentModal } from '../../js/utils/modal-surface.js';

/** @returns {HTMLElement[]} The stand-ins currently on <body>. */
const leaving = () => /** @type {HTMLElement[]} */ (Array.from(document.body.querySelectorAll(':scope > modal-backdrop.is-leaving')));

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  const check = async (name, fn) => {
    const before = new Set(leaving());
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`modal-scrim: ${name}: ${/** @type {any} */ (e)?.message || e}`);
    } finally {
      for (const ghost of leaving()) if (!before.has(ghost)) ghost.remove();
    }
  };

  /** @returns {HTMLElement} A shown modal host holding one scrim. */
  const host = () => {
    const el = document.createElement('div');
    el.innerHTML = '<modal-backdrop></modal-backdrop>';
    document.body.appendChild(el);
    return el;
  };

  await check('a shown scrim leaves a stand-in that fades and goes', async () => {
    const modal = host();
    const count = leaving().length;
    fadeOutScrims(modal);
    modal.remove();
    const added = leaving().slice(count);
    assert(added.length === 1, `expected one stand-in on <body>, found ${added.length}`);
    const ghost = added[0];
    const style = getComputedStyle(ghost);
    assert(style.pointerEvents === 'none', 'the stand-in must let the pointer through to the page');
    assert(style.position === 'fixed', 'the stand-in must sit where the scrim was');
    assert(style.backgroundColor !== 'rgba(0, 0, 0, 0)', 'the stand-in must carry the scrim\'s paint');
    await waitFor(() => !ghost.isConnected, { description: 'the stand-in to remove itself' });
  });

  await check('a hidden scrim leaves nothing', () => {
    const modal = host();
    modal.style.display = 'none';
    const count = leaving().length;
    fadeOutScrims(modal);
    modal.remove();
    assert(leaving().length === count, 'a modal that was already hidden must not leave a scrim behind');
  });

  await check('a transparent scrim leaves nothing', () => {
    const modal = host();
    /** @type {HTMLElement} */ (modal.firstElementChild).style.background = 'transparent';
    const count = leaving().length;
    fadeOutScrims(modal);
    modal.remove();
    assert(leaving().length === count, 'a scrim that dims nothing must not fade anything out');
  });

  await check('a transient modal leaves its scrim fading when it closes', () => {
    const modal = presentModal({ className: 'modal-scrim-test-root' });
    modal.root.innerHTML = '<modal-backdrop></modal-backdrop>';
    const count = leaving().length;
    modal.close();
    assert(!modal.root.isConnected, 'the modal itself must be gone the moment it closes');
    assert(leaving().length === count + 1, 'closing must leave the scrim behind to fade');
  });

  return { passed, failed, errors };
}

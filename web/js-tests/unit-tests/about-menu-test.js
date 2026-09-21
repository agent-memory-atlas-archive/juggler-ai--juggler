//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the about box opens from the native menu.
 *
 * The macOS application menu's "About Juggler" is wired to dispatch
 * `juggler:open-about` into the focused window's page (cmd/juggler-app/menu.go),
 * so that the app's own about box opens rather than the platform's stock about
 * panel. This asserts the page end of that bridge: the event opens the modal,
 * and it keeps opening on every further click of the menu item.
 * @module unit-tests/about-menu-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import '../../js/components/about-modal.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const modal = /** @type {any} */ (document.createElement('about-modal'));
  document.body.appendChild(modal);

  /** @returns {HTMLElement|null} The open about panel, if there is one. */
  const panel = () => /** @type {HTMLElement|null} */ (modal.querySelector('.about-container'));

  try {
    // --- 1: nothing is shown until something asks for it ---------------------
    assert(!panel(), 'the about box was open before anything opened it');
    passed++;

    // --- 2: the menu event opens it ------------------------------------------
    window.dispatchEvent(new CustomEvent('juggler:open-about'));
    await waitFor(() => !!panel(), { description: 'the about box to open from the menu event' });
    passed++;

    // --- 3: and it opens again, every time the menu item is picked -----------
    /** @type {HTMLElement} */ (modal.querySelector('#about-close')).click();
    await waitFor(() => !panel(), { description: 'the about box to close' });
    window.dispatchEvent(new CustomEvent('juggler:open-about'));
    await waitFor(() => !!panel(), { description: 'the about box to reopen from the menu event' });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`about-menu: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    const close = /** @type {HTMLElement|null} */ (modal.querySelector('#about-close'));
    if (close) close.click();
    modal.remove();
  }

  return { passed, failed, errors };
}

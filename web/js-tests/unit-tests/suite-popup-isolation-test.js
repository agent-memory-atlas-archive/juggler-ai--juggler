//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The open-state registry is realm-global and unit suites share one realm, so a
 * popup one suite leaves open is a popup every later suite in that lane runs
 * behind. It is not a cosmetic leak: `keyShortcutManager.suppressedByOverlay()`
 * reads it, and conversation-tab's keyboard handler returns early on it — so a
 * stray token silently disables Delete, Escape and every other shortcut for the
 * rest of the lane, and the suites that follow fail for reasons that have
 * nothing to do with them.
 *
 * A suite abandoned by the harness's own 45s timeout is the case that matters:
 * `Promise.race` walks away from it, so its `finally` never runs and whatever it
 * had on screen is still registered. The between-suite sweep is the only thing
 * standing between that and the next suite, which is why it is asserted here
 * rather than left to the suites it protects.
 *
 * `<modal-dialog>` was already swept by element. These cases cover the other
 * half — surfaces presented through `modal-surface`, whose token lives in the
 * popup manager and outlives any amount of tidying of the DOM.
 * @module unit-tests/suite-popup-isolation-test
 */

import { presentModal } from '../../js/utils/modal-surface.js';
import { isAnyPopupOpen } from '../../js/utils/popup-manager.js';
import { neutralizeStrayOverlays, assert } from '../utilities/test-helpers.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';

/**
 * Present a dialog the way the workspace move/reconnect dialogs do.
 * @returns {any} The surface handle, so a case can abandon or close it.
 */
function openDialog() {
  const surface = presentModal({ className: 'suite-popup-isolation-overlay' });
  surface.root.innerHTML = '<p>whatever this dialog was asking</p>';
  return surface;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case under test, used to label a failure.
   * @param {() => void} fn - Assertions; throws to fail.
   * @returns {void}
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Whatever the case proved, the next one starts from a clean registry —
      // and so does the next suite, which is the whole point of the file.
      neutralizeStrayOverlays();
      document.querySelectorAll('.suite-popup-isolation-overlay').forEach((el) => el.remove());
    }
  };

  run('a dialog left open by an abandoned suite is dismissed', () => {
    openDialog();
    assert(isAnyPopupOpen(),
      'the dialog should register as open, or this case proves nothing');

    neutralizeStrayOverlays();

    assert(!isAnyPopupOpen(),
      'the sweep left the dialog registered as open — every later suite in this ' +
      'lane runs with its shortcuts suppressed');
    assert(!document.querySelector('.suite-popup-isolation-overlay'),
      'the sweep released the token but left the overlay on screen');
  });

  run('shortcuts are not suppressed for the suite that follows', () => {
    openDialog();
    assert(keyShortcutManager.suppressedByOverlay(),
      'an open dialog should suppress shortcuts, or this case proves nothing');

    neutralizeStrayOverlays();

    assert(!keyShortcutManager.suppressedByOverlay(),
      'shortcuts are still suppressed after the sweep — this is what stops a ' +
      'later suite\'s Delete keypress reaching the item it is aimed at');
  });

  run('a dialog whose element was removed behind its back is still released', () => {
    // Removing the root without calling close() is how a suite tidies up when
    // it reaches past the handle it was given. The element goes; the token
    // stays, because only close() releases it (modal-surface).
    const surface = openDialog();
    surface.root.remove();
    assert(isAnyPopupOpen(),
      'removing the element should leave the token behind, or this case proves nothing');

    neutralizeStrayOverlays();

    assert(!isAnyPopupOpen(),
      'a token whose element is already gone survived the sweep — nothing else ' +
      'will ever release it');
  });

  return { passed, failed, errors };
}

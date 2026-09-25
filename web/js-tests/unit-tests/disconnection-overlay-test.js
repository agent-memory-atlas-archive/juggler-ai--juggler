//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Disconnection-overlay wording tests: the ladder of lines shown while the
 * connection is gone, and the rule that decides when it may climb.
 *
 * The ladder is only worth anything if it is read from the bottom. A line is
 * promoted on time the overlay spent IN VIEW, never on wall-clock elapsed,
 * because a browser clamps a hidden page's timers to roughly the tick period
 * rather than stopping them: a page left in a background tab keeps ticking at
 * nearly full speed and, counted, arrives back on screen already on its last
 * line — the user meets "This isn't going very well." as an opening remark and
 * never sees the lines that earn it. So the hidden-page cases here are the
 * point of the file, not an edge case.
 *
 * The suite drives `_tick` by hand (the real one-second interval is cleared at
 * mount) so eight minutes of waiting costs milliseconds.
 * @module unit-tests/disconnection-overlay-test
 */

import { assert } from '../utilities/test-helpers.js';
import DisconnectionOverlay from '../../js/components/disconnection-overlay.js';

/**
 * Force `document.hidden` for this lane. The headless test page is itself never
 * visible — every lane is an iframe in a window the runner keeps hidden — so
 * without this the overlay would correctly refuse to advance and every ladder
 * assertion would be vacuous. An own property shadows the prototype getter and
 * `delete` puts the real one back.
 * @param {boolean} hidden - What `document.hidden` should report.
 */
function forceHidden(hidden) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

/**
 * Mount an overlay and take its clock off the real timer.
 * @returns {DisconnectionOverlay} A mounted overlay, ticked only on demand.
 */
function mountOverlay() {
  const overlay = new DisconnectionOverlay();
  overlay.show();
  const self = /** @type {any} */ (overlay);
  clearInterval(self._waitTimer);
  self._waitTimer = null;
  return overlay;
}

/**
 * Run the overlay's clock forward by whole ticks.
 * @param {DisconnectionOverlay} overlay - The mounted overlay.
 * @param {number} ms - How much time passes, in one-second ticks.
 */
function tickFor(overlay, ms) {
  const self = /** @type {any} */ (overlay);
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    self._lastTickAt = Date.now() - 1000;
    self._tick();
  }
}

/**
 * The line currently on the overlay.
 * @param {DisconnectionOverlay} overlay - The mounted overlay.
 * @returns {string} The message text.
 */
function lineOn(overlay) {
  const el = /** @type {any} */ (overlay)._messageElement;
  return el ? el.textContent : '';
}

/**
 * Whether the message block has been revealed (the spinner-only grace is over).
 * @param {DisconnectionOverlay} overlay - The mounted overlay.
 * @returns {boolean} True once the wording is on screen.
 */
function revealed(overlay) {
  const el = /** @type {any} */ (overlay)._infoElement;
  return !!el && el.classList.contains('loading-overlay__info--visible');
}

/**
 * Run the disconnection-overlay tests.
 * @param {any} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>|void} fn - Test body
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
  const hadHiddenAttribute = document.documentElement.hasAttribute('data-doc-hidden');
  document.documentElement.removeAttribute('data-doc-hidden');
  forceHidden(false);

  /** @type {DisconnectionOverlay|null} */
  let overlay = null;

  try {
    await test('the wording stays off screen for the spinner-only grace period', () => {
      overlay = mountOverlay();
      tickFor(overlay, 4000);
      assert(!revealed(overlay), 'a four-second blip must show the spinner alone, with no wording at all');
      tickFor(overlay, 2000);
      assert(revealed(overlay), 'the wording must appear once the grace period has passed');
      overlay.hide();
      overlay = null;
    });

    await test('the ladder opens mild and climbs one rung at a time', () => {
      overlay = mountOverlay();
      tickFor(overlay, 6000);
      assert(lineOn(overlay) === 'Reconnecting.', `expected the mildest line first, got "${lineOn(overlay)}"`);
      tickFor(overlay, 20000);
      assert(lineOn(overlay) === 'Still reconnecting.', `expected "Still reconnecting." at ~26s, got "${lineOn(overlay)}"`);
      tickFor(overlay, 40000);
      assert(lineOn(overlay) === 'Lost the server.', `expected "Lost the server." past a minute, got "${lineOn(overlay)}"`);
      tickFor(overlay, 2 * 60 * 1000);
      assert(lineOn(overlay) === 'Still trying.', `expected "Still trying." past three minutes, got "${lineOn(overlay)}"`);
      tickFor(overlay, 5 * 60 * 1000);
      assert(lineOn(overlay) === 'This isn’t going very well.',
        `expected the last line past eight minutes, got "${lineOn(overlay)}"`);
      overlay.hide();
      overlay = null;
    });

    await test('a hidden page climbs nothing, however long it is left', () => {
      overlay = mountOverlay();
      forceHidden(true);
      tickFor(overlay, 15 * 60 * 1000);
      assert(!revealed(overlay), 'a quarter of an hour unseen must not even reveal the wording');
      forceHidden(false);
      tickFor(overlay, 6000);
      assert(lineOn(overlay) === 'Reconnecting.',
        `coming back must start at the mildest line, not part-way up — got "${lineOn(overlay)}"`);
      overlay.hide();
      overlay = null;
    });

    await test('the app’s own hidden signal counts as unseen too', () => {
      overlay = mountOverlay();
      // What the app sets while the window is minimised, occluded, or on
      // another desktop — the signal that survives a macOS Cmd-Tab back, where
      // visibilitychange never fires.
      document.documentElement.setAttribute('data-doc-hidden', '');
      tickFor(overlay, 10 * 60 * 1000);
      assert(!revealed(overlay), 'an occluded window must not burn through the ladder unread');
      document.documentElement.removeAttribute('data-doc-hidden');
      tickFor(overlay, 6000);
      assert(lineOn(overlay) === 'Reconnecting.', `expected the mildest line on return, got "${lineOn(overlay)}"`);
      overlay.hide();
      overlay = null;
    });

    await test('an interval the page spent partly hidden does not count', () => {
      overlay = mountOverlay();
      tickFor(overlay, 6000);
      const before = /** @type {any} */ (overlay)._waitedMs;
      // The page hid and came back between two ticks: visible at both ends, so
      // only the flag the visibilitychange listener sets can catch it.
      /** @type {any} */ (overlay)._hiddenSinceTick = true;
      tickFor(overlay, 1000);
      assert(/** @type {any} */ (overlay)._waitedMs === before,
        'a tick spanning a hidden period must accrue nothing');
      overlay.hide();
      overlay = null;
    });

    await test('hiding the overlay leaves no listener behind', () => {
      overlay = mountOverlay();
      overlay.hide();
      assert(/** @type {any} */ (overlay)._visibilityListener === null,
        'the visibility listener must come off with the overlay');
      overlay = null;
    });
  } finally {
    if (overlay) /** @type {DisconnectionOverlay} */ (overlay).hide();
    if (hiddenDescriptor) {
      Object.defineProperty(document, 'hidden', hiddenDescriptor);
    } else {
      // @ts-expect-error - removing the shadowing own property restores the real getter
      delete document.hidden;
    }
    document.documentElement.toggleAttribute('data-doc-hidden', hadHiddenAttribute);
  }

  return { passed, failed, errors };
}

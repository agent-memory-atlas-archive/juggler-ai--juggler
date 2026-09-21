//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared column-resize wiring for Miller-column children
 * (conversation-area, properties-panel, conversation-bar). The column
 * itself hosts a `col-resize-handle` on its right edge; dragging it
 * sets a rem-based width on the column and persists it under the
 * caller-supplied preference name, so all columns of the same kind share
 * a width. Storing in rem means widths track the app zoom level (root
 * font-size) automatically.
 *
 * The width belongs to the window (services/prefs.js), which is what makes it
 * survive a relaunch: it is kept in the project's session rather than in a
 * localStorage partitioned by a port that changes. A mount applies the cached
 * value at once and reconciles when the session answers, so the column never
 * waits on a round trip to have a width.
 *
 * Hiding the handle on the rightmost column is handled by CSS
 * (`column-container > *:last-child col-resize-handle`), not here.
 * @module utils/column-resize
 */

import { cachedWindowPref, getWindowPref, setWindowPref } from '../services/prefs.js';

export const COL_MIN_WIDTH_REM = 12.5;
export const COL_MAX_WIDTH_REM = 100;

/**
 * @returns {number} Current root font-size in CSS pixels.
 */
function _remPx() {
  return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Set a column's width without storing it, and report what it settled on.
 * @param {HTMLElement} element
 * @param {number} rem
 * @param {number} minWidthRem
 * @returns {number} The clamped width, in rem.
 * @private
 */
function _styleColumnWidth(element, rem, minWidthRem) {
  const clamped = Math.max(minWidthRem, Math.min(COL_MAX_WIDTH_REM, rem));
  element.style.width = `${clamped}rem`;
  return clamped;
}

/**
 * Apply a width (in rem) to `element` and store it under `prefName`.
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {number} rem
 * @param {number} [minWidthRem]
 */
export function applyColumnWidthRem(element, prefName, rem, minWidthRem = COL_MIN_WIDTH_REM) {
  void setWindowPref(prefName, _styleColumnWidth(element, rem, minWidthRem));
}

/**
 * Apply a width (in CSS pixels) to `element` and store it as rem.
 * Convenience for callers that compute widths in px (e.g. auto-fit
 * tab-bar sizing).
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {number} px
 * @param {number} [minWidthRem]
 */
export function applyColumnWidthPx(element, prefName, px, minWidthRem = COL_MIN_WIDTH_REM) {
  applyColumnWidthRem(element, prefName, px / _remPx(), minWidthRem);
}

/**
 * Attach drag handlers and persistence to `element`'s `.col-resize-handle`
 * child.
 * @param {HTMLElement} element - The column element (must be position: relative).
 * @param {string} prefName - The window preference the width is stored under.
 * @param {number} [minWidthRem] - Minimum width in rem (defaults to COL_MIN_WIDTH_REM).
 * @param {number} [defaultWidthRem] - Initial width (rem) to apply when this
 *   window has stored none. Applied as an inline style only (never stored), so
 *   the first drag is what a window remembers.
 */
export function setupColumnResize(
  element,
  prefName,
  minWidthRem = COL_MIN_WIDTH_REM,
  defaultWidthRem = undefined,
) {
  const handle = element.querySelector('col-resize-handle');
  if (!handle) return;

  _loadColumnWidth(element, prefName, minWidthRem, defaultWidthRem);

  // Prevent resize-handle clicks from bubbling to the column-container's
  // click handler, which would change active column and scroll into view.
  handle.addEventListener('click', (e) => e.stopPropagation());

  // Only highlight on mouse hover — touch devices don't get a hover state.
  handle.addEventListener('pointerenter', (e) => {
    if (/** @type {PointerEvent} */ (e).pointerType === 'mouse') handle.classList.add('hovered');
  });
  handle.addEventListener('pointerleave', () => handle.classList.remove('hovered'));

  handle.addEventListener('pointerdown', (/** @type {Event} */ e) => {
    const pointerEvent = /** @type {PointerEvent} */ (e);
    pointerEvent.preventDefault();
    /** @type {HTMLElement} */ (handle).setPointerCapture(pointerEvent.pointerId);

    const startX = pointerEvent.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const remPx = _remPx();
    const minPx = minWidthRem * remPx;
    const maxPx = COL_MAX_WIDTH_REM * remPx;

    handle.classList.add('dragging');

    const onMove = (/** @type {Event} */ e) => {
      const moveEvent = /** @type {PointerEvent} */ (e);
      const deltaX = moveEvent.clientX - startX;
      let newWidth = startWidth + deltaX;
      newWidth = Math.max(minPx, Math.min(maxPx, newWidth));
      // Use px during drag for smooth pixel-accurate feedback;
      // converted back to rem on pointerup.
      element.style.width = `${newWidth}px`;
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      const finalPx = element.getBoundingClientRect().width;
      applyColumnWidthPx(element, prefName, finalPx, minWidthRem);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

/**
 * A stored width, or null when there is nothing usable.
 * @param {any} value
 * @returns {number|null} The width in rem.
 * @private
 */
function _storedWidthRem(value) {
  const rem = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(rem) && rem > 0 ? rem : null;
}

/**
 * Give a column its width: the cached one now, and the window's stored one when
 * the session answers.
 *
 * Nothing is written back here. A width the column was merely given is not a
 * width the user chose, and storing it would stamp the default over a value
 * this window has not heard about yet. The reconcile stands down mid-drag —
 * a column jumping under the pointer is worse than a late correction.
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {number} minWidthRem
 * @param {number} [defaultWidthRem] - Unstored fallback width (rem) when nothing
 *   is stored for this window.
 */
function _loadColumnWidth(element, prefName, minWidthRem, defaultWidthRem = undefined) {
  const cached = _storedWidthRem(cachedWindowPref(prefName, null));
  if (cached !== null) {
    _styleColumnWidth(element, cached, minWidthRem);
  } else if (typeof defaultWidthRem === 'number') {
    // The caller's default gives a new user a sensible fixed width instead of
    // the flex-fill one, which otherwise has the column resize to fill the page
    // as its siblings are shown and hidden.
    _styleColumnWidth(element, defaultWidthRem, minWidthRem);
  }

  void getWindowPref(prefName, null).then((stored) => {
    const rem = _storedWidthRem(stored);
    if (rem === null || rem === cached) return;
    if (element.querySelector('col-resize-handle.dragging')) return;
    _styleColumnWidth(element, rem, minWidthRem);
  });
}

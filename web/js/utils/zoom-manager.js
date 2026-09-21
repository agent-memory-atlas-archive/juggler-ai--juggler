//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Zoom Manager - Handles UI zoom via root font-size scaling.
 *
 * Who owns the zoom depends on which client is reading it — see services/prefs.js
 * for the rule this shares with the theme. The sources, best first:
 *
 *   - desktop window: this project's saved session zoom (window.__sessionZoom,
 *     server-injected and authoritative) > an inherited ?zoom= seed from the
 *     window that opened this one > this device's cached value > the default.
 *   - remote browser: this device's cached value > the session zoom > the
 *     default. Nothing is written back to the session, so a phone that zooms out
 *     doesn't resize the desktop window it dialled into.
 *
 * One limitation, in the transport rather than here: a Cloudflare quick tunnel
 * hands out a fresh hostname every session, so a device reaching a project that
 * way gets an empty localStorage each time and opens at the session zoom again.
 *
 * The synchronous pre-paint block in index.html applies the same precedence
 * before first paint (a font-size change reflows everything, so a late
 * correction is a visible jump); this module is the authoritative reconciler and
 * owns persistence.
 */

import { onDocumentReady } from './document-ready.js';
import { postWindowControl, isDesktopWindow } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';
import { scopedKey, resolvePref } from '../services/prefs.js';
import { windowRole } from './view-mode.js';

const ZOOM_KEY_BASE = 'juggler-zoom';
const ZOOM_STEP = 10;
const ZOOM_MIN = 60;
const ZOOM_MAX = 160;
const ZOOM_DEFAULT = 110;

/** The live applied zoom level, resolved at init and updated on every change. */
let current = ZOOM_DEFAULT;

/**
 * Clamp a level to the supported range.
 * @param {number} level - Raw zoom percentage.
 * @returns {number} Clamped percentage.
 */
function clamp(level) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

/**
 * Parse and clamp a stored/param string; null when absent or not a number.
 * @param {string|null} raw - Candidate value.
 * @returns {number|null} A valid clamped level, or null.
 */
function parseLevel(raw) {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : clamp(n);
}

/**
 * The project session's saved zoom, injected pre-paint by the server. Absent
 * (null) for a no-project window or a project that has never saved a zoom.
 * @returns {number|null} The authoritative session zoom, or null.
 */
function sessionZoom() {
  const z = Number(window.__sessionZoom);
  return z > 0 ? clamp(z) : null;
}

/**
 * This device's localStorage key for the loaded project (see services/prefs.js).
 * @returns {string} The namespaced storage key.
 * @private
 */
function zoomKey() {
  return scopedKey(ZOOM_KEY_BASE);
}

/** @returns {number|null} This device's cached level for this project, or null. */
function storedZoom() {
  return parseLevel(localStorage.getItem(zoomKey()));
}

/**
 * The inherited seed from the window that opened this one (a ?zoom= param the
 * native host bakes into the URL).
 * @returns {number|null} The seed level, or null.
 */
function seedZoom() {
  try {
    return parseLevel(new URL(window.location.href).searchParams.get('zoom'));
  } catch (_e) {
    return null;
  }
}

/**
 * Apply a zoom level to the document root.
 * @param {number} level - Zoom percentage.
 * @private
 */
function applyZoom(level) {
  document.documentElement.style.fontSize = level + '%';
}

/**
 * Persist the current zoom into this project's session (best-effort). The token
 * fetch shim authorises the request; the server no-ops for a no-project window.
 * Only a desktop window may call this — the server refuses the write from a
 * remote viewer, whose zoom is its own device's business.
 *
 * The window names itself, exactly as the theme does: a detached board is its
 * own window and keeps its own size, and the ordinary window's size is also the
 * project's, which is what a window opened later inherits.
 * @param {number} level - Zoom percentage.
 * @private
 */
function persistToSession(level) {
  // Best-effort — a missing/blocked fetch just skips session persistence.
  const url = `/api/session/ui-zoom?role=${encodeURIComponent(windowRole())}`;
  void fetchJson(url, { method: 'PUT', body: { uiZoom: level }, fallback: null });
}

/**
 * Report the current zoom to the native host so the next window it opens
 * inherits this (last-active) size. A no-op in a plain browser tab.
 * @param {number} level - Zoom percentage.
 * @private
 */
function reportToHost(level) {
  postWindowControl('zoom', '?zoom=' + level);
}

/**
 * The live applied zoom level.
 * @returns {number} Current zoom percentage.
 */
export function getCurrentZoom() {
  return current;
}

/**
 * Set zoom level, apply, store it, and report to the native host so new windows
 * inherit it. A desktop window also persists to the project's session, which is
 * its authoritative store; a remote browser stops at localStorage, so the device
 * remembers its own size without changing the desktop's.
 * @param {number} level - Zoom percentage (clamped to min/max).
 */
function setZoom(level) {
  current = clamp(level);
  applyZoom(current);
  try {
    localStorage.setItem(zoomKey(), current.toString());
  } catch (_e) {
    /* localStorage may be full or unavailable — a desktop window still has the
       session copy; a remote browser loses the size when the page closes */
  }
  if (isDesktopWindow()) {
    persistToSession(current);
  }
  reportToHost(current);
}

/**
 * Increase zoom by one step.
 */
export function zoomIn() {
  setZoom(current + ZOOM_STEP);
}

/**
 * Decrease zoom by one step.
 */
export function zoomOut() {
  setZoom(current - ZOOM_STEP);
}

/**
 * Initialize zoom on page load. Resolves the level by precedence, adopts it
 * (idempotent with the pre-paint block), stores it, and reports it to the host.
 * A desktop window takes the project's saved size first; a remote browser takes
 * this device's, falling back to the project's only when the device has none.
 * When a desktop window inherited a seed into a session that had none of its
 * own, the inherited size is persisted so the project remembers it next time —
 * never overriding a saved session value, and never stamping the plain default.
 * @private
 */
function initZoom() {
  const desktop = isDesktopWindow();
  const session = sessionZoom();
  const seed = seedZoom();

  current = resolvePref({
    desktop,
    session,
    device: storedZoom(),
    windowScoped: [seed],
    fallback: ZOOM_DEFAULT
  });
  applyZoom(current);
  try {
    localStorage.setItem(zoomKey(), current.toString());
  } catch (_e) {
    /* cache write is best-effort */
  }
  // Report to the host so its inheritance seed tracks this window's size.
  reportToHost(current);
  // Remember an inherited seed against the project so a later reopen (with no
  // live inheritance) still restores it. Only when the session had nothing —
  // i.e. this window inherited its size — so a saved session zoom is never
  // overwritten and the plain default is never stamped. A remote browser never
  // writes to the session at all.
  if (desktop && session === null && seed !== null) {
    persistToSession(current);
  }
}

// Auto-initialize when module loads. Zoom is a viewer affordance; onDocumentReady
// skips off the main thread (the engine worker has no document).
onDocumentReady(initZoom);

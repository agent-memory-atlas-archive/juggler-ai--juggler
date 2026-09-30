//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Reply-suggestions setting — a client-side mirror of the global
 * `reply_suggestions_disabled` credential, for synchronous reads on the
 * turn-end path.
 *
 * Unlike auto-naming, nothing server-side reads this key: the suggestions are
 * generated in the browser, so this cache IS the setting as far as the running
 * feature is concerned. The server only persists it, and hands it back in the
 * `/api/config` payload.
 *
 * The cache starts UNSEEDED rather than defaulting to on, which is the one way
 * it deliberately differs from {@link module:services/auto-name-setting}. The
 * feature is on by default, but "on by default" must not mean "on before we
 * have looked": a user who turned suggestions off would otherwise get one
 * round of them on every startup, in the window before `/api/config` lands.
 * A setting whose entire job is making something stop cannot have a gap like
 * that, and the cost of the stricter rule is only that the very first turn of
 * a session may pass unsuggested.
 * @module services/reply-suggestions-setting
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/** @type {boolean|null} Cached "reply suggestions enabled" state; null until seeded. */
let cachedEnabled = null;

/**
 * Whether reply suggestions are currently enabled (synchronous read of the
 * cache). False until the cache has been seeded, so a caller can treat this as
 * the single "may I run?" question.
 * @returns {boolean} True when suggestions are on and the setting is known.
 */
export function areReplySuggestionsEnabled() {
  return cachedEnabled === true;
}

/**
 * Whether the setting has been read from the server yet. Only the seeding path
 * needs this; everything else asks {@link areReplySuggestionsEnabled}.
 * @returns {boolean} True once a load or an explicit set has happened.
 */
export function isReplySuggestionsSettingSeeded() {
  return cachedEnabled !== null;
}

/**
 * Update the cached state directly (used by the Defaults tab after load/toggle,
 * so the change takes effect without re-fetching). Also counts as seeding.
 * @param {boolean} enabled - The new enabled state.
 */
export function setReplySuggestionsEnabledCached(enabled) {
  cachedEnabled = !!enabled;
}

/**
 * Refresh the cache from the server (GET /api/config). Best-effort: a failed
 * fetch leaves the cache as it was, so an offline start stays unseeded and the
 * feature stays quiet rather than guessing.
 * @returns {Promise<boolean>} The refreshed enabled state.
 */
export async function refreshReplySuggestionsSetting() {
  const config = await fetchJson(apiUrl('/config'), { fallback: null });
  if (config) cachedEnabled = !(/** @type {any} */ (config).replySuggestionsDisabled);
  return cachedEnabled === true;
}

/**
 * Reset the cache to unseeded. Tests only — production seeds once per page and
 * never goes back.
 */
export function resetReplySuggestionsSettingForTests() {
  cachedEnabled = null;
}

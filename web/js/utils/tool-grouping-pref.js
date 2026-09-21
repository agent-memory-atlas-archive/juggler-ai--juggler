//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * tool-grouping-pref — the "collapse tool runs" display preference.
 *
 * When on, a run of adjacent tool-use rows in a column is drawn as ONE group
 * tile; selecting it opens the run's rows in the next column. This is purely a
 * display choice — nothing about it is written to the conversation document.
 *
 * It belongs to the person (the `user` realm, services/prefs.js), beside the
 * bell and the tips they have seen: how you like a transcript drawn is a fact
 * about you, and it should hold in every project and every window. What belongs
 * to a WINDOW instead is anything about how that window is arranged — which
 * info cards it has hidden, how wide its columns are — and those are kept in
 * the project's session, per window role.
 * @module utils/tool-grouping-pref
 */

import { cachedUserPref, setUserPref, notifyPrefChanged, reconcilePref } from '../services/prefs.js';

const PREF_KEY = 'juggler-tool-grouping';

/** Fired on window whenever the preference changes, so open views re-render. */
export const TOOL_GROUPING_EVENT = 'juggler:tool-grouping-changed';

/**
 * Whether adjacent tool-use rows should be collapsed into group tiles.
 * Defaults to off: the flat transcript is what a new user should see first.
 * @returns {boolean} True when grouping is enabled.
 */
export function isToolGroupingEnabled() {
  return cachedUserPref(PREF_KEY, false) === true;
}

/**
 * Set the preference and notify listeners.
 * @param {boolean} enabled - True to collapse tool runs into group tiles.
 * @returns {void}
 */
export function setToolGroupingEnabled(enabled) {
  void setUserPref(PREF_KEY, !!enabled);
  notifyPrefChanged(TOOL_GROUPING_EVENT);
}

/**
 * Flip the preference.
 * @returns {boolean} The new state.
 */
export function toggleToolGrouping() {
  const next = !isToolGroupingEnabled();
  setToolGroupingEnabled(next);
  return next;
}

// Ask for this person's choice at boot; a transcript already drawn re-renders on
// the event when the answer differs from what was cached.
if (typeof document !== 'undefined') {
  void reconcilePref('user', PREF_KEY, TOOL_GROUPING_EVENT);
}

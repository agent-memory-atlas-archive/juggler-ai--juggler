//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The main app's live session, for code that reaches the app through
 * `window.jugglerApp` rather than being handed a session (the settings tabs,
 * the plugin catalog, the registry reloader — see JugglerApp.getSession).
 *
 * Null before the session loads, and in any realm with no app at all: the
 * engine page and workers have no `jugglerApp`, which is why this reads
 * `globalThis` rather than `window`.
 * @returns {import('../model/session.js').default|null} The session, or null.
 */
export function getAppSession() {
  return /** @type {any} */ (globalThis).jugglerApp?.getSession?.() ?? null;
}

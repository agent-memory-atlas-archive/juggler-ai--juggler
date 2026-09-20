//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Theme Manager - Handles the light/dark/system theme setting.
 *
 * There are three *modes*:
 *   - 'system' (default): follow the OS light/dark setting, live.
 *   - 'light' / 'dark':   an explicit override that ignores the OS.
 * A mode resolves to a concrete *theme* ('light' or 'dark') for painting.
 *
 * The three modes are what gets stored, but only Settings offers all three by
 * name. The header button is a plain two-state light switch over them: it flips
 * the theme on screen, and a theme is pinned only while it differs from the OS
 * setting — choosing the OS's own theme stores 'system' instead. So the button
 * can never strand anyone in a fixed theme, and 'system' stays reachable
 * without ever being an option someone has to understand. See toggleTheme().
 *
 * Who owns the mode depends on which client is reading it — see ui-pref-scope.js
 * for the rule this shares with the zoom. The sources, best first:
 *
 *   - desktop window: this project's saved session mode (window.__sessionThemeMode,
 *     server-injected and authoritative) > this window's own mode from a prior
 *     load (sessionStorage, survives reload) > a ?mode= seed inherited from the
 *     window that opened this one (carries 'system' faithfully, so 'auto'
 *     survives the hand-off) > a resolved ?theme= seed (concrete colour only, a
 *     fallback) > this device's stored mode > 'system'.
 *   - remote browser: this device's stored mode > the window-scoped hints above >
 *     the session mode > 'system', and nothing is written back. A phone opens in
 *     the theme the desktop is in, but switching it to dark leaves the desktop
 *     alone and doesn't fight whatever a second remote device prefers.
 *
 * The per-window sessionStorage layer sits above the seed so a project switch
 * keeps 'system'/'auto'. Switching projects reloads the page with the same URL,
 * so the baked ?theme= seed (a resolved concrete 'light'/'dark') is still present
 * but stale; without a per-window record it would outrank the window's real
 * 'system' mode and get persisted into the switched-in project, silently pinning
 * it to a fixed theme. sessionStorage is empty in a genuinely fresh window, so
 * the seed still wins there (its intended anti-flash handoff).
 */

import { windowControlURL, isDesktopWindow } from '../../sdk/lib/window-control.js';
import { onDocumentReady } from './document-ready.js';
import { fetchJson } from '../services/http.js';
import { scopedKey, resolvePref } from './ui-pref-scope.js';
import { windowRole } from './view-mode.js';

const THEME_KEY_BASE = 'juggler-theme';

/**
 * This device's localStorage key for the loaded project (see ui-pref-scope.js).
 * @returns {string} The namespaced storage key.
 * @private
 */
function themeKey() {
  return scopedKey(THEME_KEY_BASE);
}

/**
 * Per-window record of the resolved mode, in sessionStorage. Survives a same-URL
 * reload (a project switch reloads the page) but is empty in a genuinely new
 * window, which is exactly what lets a switch preserve 'system' while a fresh
 * window still honours the inherited ?theme= seed. See the module doc comment.
 */
const WINDOW_MODE_KEY = 'juggler-theme-window';

/**
 * This device's record of the OS light/dark setting, in localStorage. Not
 * project-scoped, unlike THEME_KEY_BASE: the OS setting belongs to the device,
 * and every project on it sees the same one. Written whenever the document is
 * painted in 'system' mode, where the painted theme is the OS theme reconciled
 * with the native host. Read by knownSystemTheme().
 */
const SYSTEM_THEME_KEY = 'juggler-system-theme';

/** Concrete themes the document can be painted as. */
const THEMES = {
  DARK: 'dark',
  LIGHT: 'light'
};

/** Selectable modes: 'system' follows the OS; the others pin a theme. */
export const MODES = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark'
};

/**
 * Fired on document whenever the painted theme or the mode changes, from
 * whatever cause — a click, Settings, the OS, or the host's reconciliation.
 * Anything displaying the current theme should follow this rather than read the
 * mode once. detail: {mode, theme}.
 */
export const THEME_MODE_EVENT = 'theme-mode-changed';

/**
 * Resolve the OS-level colour-scheme preference.
 * @returns {string} 'light' if the OS prefers light, otherwise 'dark'
 * @private
 */
function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? THEMES.LIGHT
    : THEMES.DARK;
}

/**
 * The other concrete theme.
 * @param {string} theme - 'dark' or 'light'.
 * @returns {string} 'light' for 'dark', and 'dark' for anything else.
 * @private
 */
function otherTheme(theme) {
  return theme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
}

/**
 * Get the user's selected mode. Anything unrecognised (including a missing
 * value, and legacy stores that only ever held 'light'/'dark') falls back to
 * 'system', so the default is to follow the OS.
 * @returns {string} One of MODES.
 */
export function getMode() {
  const stored = localStorage.getItem(themeKey());
  return stored === MODES.LIGHT || stored === MODES.DARK || stored === MODES.SYSTEM
    ? stored
    : MODES.SYSTEM;
}

/**
 * Resolve the current mode to the concrete theme to paint. In 'system' mode
 * this tracks the OS; otherwise it's the pinned theme. Consumers that need a
 * definite 'dark'/'light' (e.g. the iframe ?theme= handoff) use this.
 * @returns {string} 'dark' or 'light'
 */
export function getTheme() {
  const mode = getMode();
  return mode === MODES.SYSTEM ? systemTheme() : mode;
}

/**
 * The concrete theme currently painted on the document ('dark' or 'light'),
 * read straight from the data-theme attribute. Unlike getTheme(), which
 * re-resolves 'system' via matchMedia — unreliable in a native macOS window
 * whose prefers-color-scheme is pinned by the window's forced appearance, so it
 * can report the opposite of what's on screen — this returns what is actually
 * displayed, already reconciled with the native host (see applyTheme). Use it
 * when handing a resolved theme to a child window so the child inherits exactly
 * what the source shows rather than a stale matchMedia guess.
 * @returns {string} 'dark' or 'light'.
 */
export function getPaintedTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? THEMES.LIGHT
    : THEMES.DARK;
}

/**
 * Whether s is a theme mode the app understands.
 * @param {string|null|undefined} s
 * @returns {boolean} True when s is 'system', 'light', or 'dark'.
 * @private
 */
function isMode(s) {
  return s === MODES.SYSTEM || s === MODES.LIGHT || s === MODES.DARK;
}

/**
 * This project's saved theme mode, injected pre-paint by the server. Null for a
 * no-project window or a project that has never saved one. Authoritative over
 * localStorage: each project's server reuses the same origin, so a bare
 * localStorage value can belong to a DIFFERENT project.
 * @returns {string|null} One of MODES, or null.
 * @private
 */
function sessionMode() {
  const m = window.__sessionThemeMode;
  return isMode(m) ? /** @type {string} */ (m) : null;
}

/**
 * The resolved theme ('light'/'dark') inherited from the window that opened this
 * one (a ?theme= param the native host bakes into the URL). Null when absent.
 * This is only the first-frame paint colour; the actual mode comes from
 * seedMode() when present, so 'system'/'auto' can survive the hand-off.
 * @returns {string|null} The inherited resolved theme ('light'/'dark'), or null.
 * @private
 */
function seedTheme() {
  try {
    const t = new URL(window.location.href).searchParams.get('theme');
    return t === THEMES.LIGHT || t === THEMES.DARK ? t : null;
  } catch (_e) {
    return null;
  }
}

/**
 * The theme *mode* inherited from the window that opened this one (a ?mode= param
 * the native host bakes into the URL alongside ?theme=). Unlike seedTheme(), this
 * carries 'system' faithfully, so a window opened from an 'auto' window stays on
 * 'auto' and follows the OS rather than being pinned to whatever the parent was
 * resolving to at the moment. Null when absent (e.g. an older host, or a launch
 * that carries only a concrete theme hint).
 * @returns {string|null} One of MODES, or null.
 * @private
 */
function seedMode() {
  try {
    const m = new URL(window.location.href).searchParams.get('mode');
    return isMode(m) ? m : null;
  } catch (_e) {
    return null;
  }
}

/**
 * This window's own resolved mode from a prior load in the same window, read from
 * sessionStorage. Non-null only after a same-window reload (e.g. a project
 * switch), and null in a brand-new window — so it can outrank a stale ?theme=
 * seed on a switch without stealing a genuine fresh-window hand-off.
 * @returns {string|null} One of MODES, or null.
 * @private
 */
function windowMode() {
  try {
    const m = sessionStorage.getItem(WINDOW_MODE_KEY);
    return isMode(m) ? m : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Record this window's resolved mode for the next same-window load (best-effort).
 * @param {string} mode - One of MODES.
 * @private
 */
function rememberWindowMode(mode) {
  try {
    sessionStorage.setItem(WINDOW_MODE_KEY, mode);
  } catch (_e) {
    /* best-effort — disabled/private storage just loses the per-window record */
  }
}

/**
 * Record the OS light/dark setting for this device (best-effort).
 * @param {string} theme - The OS theme, 'dark' or 'light'.
 * @private
 */
function rememberSystemTheme(theme) {
  try {
    localStorage.setItem(SYSTEM_THEME_KEY, theme);
  } catch (_e) {
    /* best-effort — a lost record just falls back to the invariant below */
  }
}

/**
 * The OS light/dark setting, as well as this window can know it.
 *
 * matchMedia can't be asked: a native macOS window's forced appearance pins the
 * WKWebView's prefers-color-scheme, and WebKitGTK derives it from the toolkit
 * theme rather than the desktop preference, so in a pinned mode it tends to
 * report the pin back. Instead this uses what the app has already been told:
 *
 *   - in 'system' mode the painted theme IS the OS theme — applyTheme has
 *     reconciled it with the native host, the only reliable reader there is;
 *   - otherwise the value last observed that way, recorded per device;
 *   - failing that, the invariant that a theme is pinned only because it
 *     differs from the OS, so the OS is showing the other one.
 *
 * The record goes stale if the OS setting changes while every window is pinned,
 * which macOS reports to nobody. The cost is one toggle that appears to do
 * nothing, after which the mode is 'system' and the setting is known again.
 * @returns {string} 'dark' or 'light'.
 * @private
 */
function knownSystemTheme() {
  if (getMode() === MODES.SYSTEM) return getPaintedTheme();
  const seen = localStorage.getItem(SYSTEM_THEME_KEY);
  return seen === THEMES.LIGHT || seen === THEMES.DARK
    ? seen
    : otherTheme(getPaintedTheme());
}

/**
 * Persist this window's theme mode into the project's session (best-effort). The
 * server no-ops for a no-project window; per-project storage is what lets a
 * reopened project restore its own theme instead of whichever theme another
 * project left in the origin-shared localStorage. Only a desktop window may call
 * this — the server refuses the write from a remote viewer, whose theme is its
 * own device's business.
 *
 * The window names itself, so a detached board set to light does not restyle
 * every other window of the project at the next launch. The ordinary window's
 * mode is also the project's, which is what a window opened later inherits.
 * @param {string} mode - One of MODES.
 * @private
 */
function persistThemeToSession(mode) {
  // Best-effort — a missing/blocked fetch just skips session persistence.
  const url = `/api/session/ui-theme?role=${encodeURIComponent(windowRole())}`;
  void fetchJson(url, { method: 'PUT', body: { uiTheme: mode }, fallback: null });
}

/**
 * Persist a mode and apply the theme it resolves to. A desktop window stores it
 * both in this project's session (so a reopen restores it) and in localStorage;
 * a remote browser stops at localStorage, so the device remembers its own theme
 * without changing the desktop's.
 * @param {string} mode - One of MODES.
 */
export function setMode(mode) {
  if (mode !== MODES.SYSTEM && mode !== MODES.LIGHT && mode !== MODES.DARK) {
    return;
  }
  localStorage.setItem(themeKey(), mode);
  if (isDesktopWindow()) {
    persistThemeToSession(mode);
  }
  applyTheme(mode === MODES.SYSTEM ? systemTheme() : mode, mode);
}

/**
 * Flip the theme on screen — the header button's whole behaviour.
 *
 * Two states are offered over the three stored underneath: the theme is pinned
 * only when it differs from the OS setting, and landing on the theme the OS is
 * already showing stores 'system' instead of pinning a matching colour. That
 * keeps the OS followed by default, means a second click always undoes the
 * first, and makes it impossible to get stuck in a fixed theme without ever
 * putting the word 'system' in front of anyone. Settings names all three modes
 * for those who do want to say it outright.
 * @returns {string} The newly-selected mode (one of MODES).
 */
export function toggleTheme() {
  const target = otherTheme(getPaintedTheme());
  const mode = target === knownSystemTheme() ? MODES.SYSTEM : target;
  setMode(mode);
  return mode;
}

/**
 * Paint the document to a resolved theme: set data-theme and the inline <html>
 * background.
 *
 * WebKit caches the canvas colour propagated from html's *CSS* background at
 * first paint and doesn't refresh it from CSS variable changes, so the strip
 * under the transparent macOS titlebar (rendered by the html canvas) stays at
 * the load-time colour. An inline style write bypasses that cache. The value is
 * read back from the just-applied theme's --bg-primary rather than hard-coded,
 * so it can't drift from tokens/theme-dark.css.
 * @param {string} theme - Resolved theme to paint ('dark' or 'light').
 * @private
 */
function paintDocument(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const bgPrimary = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-primary').trim();
  if (bgPrimary) document.documentElement.style.background = bgPrimary;
}

/**
 * Apply a resolved theme to the document and sync the native window chrome.
 *
 * The native host repaints the NSWindow chrome (background, opacity, titlebar
 * appearance); without this a light page on a dark window flashes dark during
 * every live resize. Handled in cmd/juggler-app/control.go. Only the desktop
 * app that owns this native window can repaint it, via its loopback nativeCtl
 * endpoint — windowControlURL is null for a browser tab or any page without a
 * native host, so we skip the fetch there.
 *
 * In 'system' mode the native host is authoritative for the OS light/dark
 * setting: the WKWebView's prefers-color-scheme can be pinned by the window's
 * forced appearance, so systemTheme() (matchMedia) may be stale. The host
 * clears that forced appearance and reports the true OS theme back; we repaint
 * to whatever it returns.
 * @param {string} theme - Resolved theme to paint ('dark' or 'light').
 * @param {string} mode - The active mode (one of MODES).
 * @private
 */
function applyTheme(theme, mode) {
  paintDocument(theme);
  settled(theme, mode);

  const url = windowControlURL('theme',
    '?theme=' + encodeURIComponent(theme) + '&mode=' + encodeURIComponent(mode));
  if (!url) return;
  fetchJson(url, { method: 'POST', fallback: null })
    .then((data) => {
      if (mode !== MODES.SYSTEM) return;
      // System mode: repaint to the host's authoritative OS theme if it differs
      // from our (possibly appearance-pinned) guess. Don't re-post — the host
      // has already painted its chrome to match.
      const osTheme = data && data.theme;
      if ((osTheme === THEMES.DARK || osTheme === THEMES.LIGHT)
          && osTheme !== document.documentElement.getAttribute('data-theme')) {
        paintDocument(osTheme);
        settled(osTheme, mode);
      }
    });
}

/**
 * Record what a paint settled on and announce it.
 *
 * A paint in 'system' mode is also the app's one sighting of the OS setting, so
 * it is remembered here for the pinned periods when nothing can read it (see
 * knownSystemTheme). The event is dispatched from this single point so every
 * cause of a repaint — a click, Settings, an OS change, the host's echo —
 * reaches the button and the settings control the same way.
 * @param {string} theme - The theme now painted ('dark' or 'light').
 * @param {string} mode - The active mode (one of MODES).
 * @private
 */
function settled(theme, mode) {
  if (mode === MODES.SYSTEM) rememberSystemTheme(theme);
  document.dispatchEvent(new CustomEvent(THEME_MODE_EVENT, { detail: { mode, theme } }));
}

/**
 * Initialize theme on page load
 */
function initTheme() {
  // Resolve the initial mode by precedence. In a desktop window: this project's
  // saved session mode (authoritative) > this window's own mode from a prior load
  // (sessionStorage — set on a same-window reload, so a project switch keeps
  // 'system' instead of getting pinned by the stale seed) > a ?mode= seed
  // inherited from the window that opened this one > a resolved ?theme= seed >
  // this device's stored mode > follow the OS. The ?mode= seed carries the
  // opener's actual mode ('system' included), so a window opened from an 'auto'
  // window stays 'auto'; the ?theme= seed is only a *resolved* theme (concrete),
  // kept below it as a fallback for hosts that hand off just a colour hint.
  //
  // In a remote browser the device's own stored mode comes first, since the theme
  // belongs to the device rather than the project; the session mode drops to a
  // starting point for a device that has never chosen one. The seeds are absent
  // there — only the native host bakes them into a window URL.
  const desktop = isDesktopWindow();
  const session = sessionMode();
  const windowPref = windowMode();
  const seedMd = seedMode();
  const seed = seedTheme();
  const rawStored = localStorage.getItem(themeKey());
  const mode = resolvePref({
    desktop,
    session,
    device: isMode(rawStored) ? rawStored : null,
    windowScoped: [windowPref, seedMd, seed],
    fallback: MODES.SYSTEM
  });

  // Cache the resolved mode so getMode()/toggleTheme() start from it this window,
  // and record it per-window so the next same-window load (e.g. a project switch)
  // resolves from the window's real mode rather than the stale ?theme= seed.
  localStorage.setItem(themeKey(), mode);
  rememberWindowMode(mode);
  applyTheme(mode === MODES.SYSTEM ? systemTheme() : mode, mode);

  // If the project session held no mode of its own but this window has one (from
  // its own prior load, or an inherited seed), persist it so the project
  // remembers this theme next open. This stores the window's *actual* mode —
  // 'system' included — so a project switch no longer overwrites 'auto' with a
  // fixed light/dark. No-ops server-side for a no-project window, and a remote
  // browser never writes to the session at all.
  if (desktop && session === null && (windowPref !== null || seedMd !== null || seed !== null)) {
    persistThemeToSession(mode);
  }

  // In 'system' mode, follow OS light/dark changes live. An explicit
  // light/dark mode pins the theme and ignores the OS.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getMode() === MODES.SYSTEM) {
      applyTheme(systemTheme(), MODES.SYSTEM);
    }
  });

  // The embedded desktop webview (notably WebKitGTK on Linux) derives
  // prefers-color-scheme from the app toolkit theme, not the desktop's live
  // light/dark preference, so the matchMedia 'change' above never fires there
  // when the desktop is toggled. The native host watches the OS preference
  // directly and pushes this event; in 'system' mode we re-resolve and repaint
  // (applyTheme re-reads the host's authoritative OS theme). Harmless on
  // platforms that never emit it.
  window.addEventListener('juggler:system-theme-changed', () => {
    if (getMode() === MODES.SYSTEM) {
      applyTheme(systemTheme(), MODES.SYSTEM);
    }
  });
}

// Auto-initialize when module loads. Theming is a viewer affordance; the engine
// worker has no document to theme, so onDocumentReady skips off the main thread.
onDocumentReady(initTheme);

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * prefs — where a UI preference is kept, and who it belongs to.
 *
 * Five realms, one function family apiece:
 *
 * | Realm     | Store                                   | Belongs to                     |
 * |-----------|-----------------------------------------|--------------------------------|
 * | `Tab`     | sessionStorage                          | one tab                        |
 * | `Device`  | localStorage, key scoped by project     | one origin — so one port       |
 * | `Window`  | the session, under this window's role   | one window of one project      |
 * | `Project` | the session, at the top level           | every window of one project    |
 * | `User`    | settings.json                           | this person, in every project  |
 *
 * **Why three of them are server-side.** localStorage is partitioned by ORIGIN,
 * and a Juggler window's origin is `http://localhost:<port>`. The port is not
 * stable per project: the default is 3939 and a spawned server increments past
 * whatever is already listening, so which project gets which port depends on the
 * order things were launched. A relaunch that lands on a different port hands
 * the window a different — and usually empty — localStorage, and every
 * preference kept there appears to have reverted. Namespacing the KEY cannot
 * help with that; it is the whole STORE that was swapped. Storing server-side
 * can, which is why zoom and theme already do.
 *
 * **What makes an asynchronous store usable at render time.** Every `set` writes
 * the localStorage mirror synchronously as well, and every read of the realm
 * writes what it learns back to it. localStorage stops being the store and
 * becomes a warm cache: `cachedWindowPref` and its siblings answer instantly
 * from it, and `getWindowPref` reconciles when the realm replies. The worst case
 * on a port change is a brief flash of the default instead of a setting silently
 * lost. (services/recent-models.js is the same shape: a synchronous cached read
 * with a refresh behind it.)
 *
 * **Who wins when the two disagree.** In a desktop window the realm does: it is
 * the store, and the mirror is only a cache of it. In a remote browser — a phone
 * or laptop over the LAN or a tunnel — the device does, and the realm's value is
 * merely where a device that has never chosen one starts. What a remote viewer
 * must never do is write back: one pinch on a phone would otherwise resize the
 * desktop window it dialled into, and a second remote device would fight the
 * first over one shared value. The server refuses those writes too (see
 * localViewerOnly in cmd/juggler/server/network.go), and a refusal here is
 * swallowed — the mirror is that device's store, and it keeps its own copy.
 *
 * The `User` realm is the exception to the paragraph above: settings.json is one
 * document for everyone who can reach the server, its route takes a remote write,
 * so it ranks the same way for every client.
 *
 * Theme and zoom do NOT go through here. They are injected into the page before
 * it paints (index.html, filled by serveIndex) because a late correction to a
 * root font size reflows everything visibly; they use {@link scopedKey} and
 * {@link resolvePref} directly and own their own persistence.
 * @module services/prefs
 */

import { fetchJson } from './http.js';
import { windowRole, WINDOW_ROLE_MAIN } from '../utils/view-mode.js';
import { isDesktopWindow } from '../../sdk/lib/window-control.js';

/**
 * How long a write waits for its neighbours before going to the server.
 *
 * A column drag calls `set` on every pointer move, so an immediate request per
 * call would rewrite the session manifest once a frame. The mirror is still
 * written synchronously — only the request waits — so nothing reading the
 * preference sees the delay.
 */
const WRITE_DELAY_MS = 300;

/** @typedef {'window'|'project'|'user'} ServerRealm */

/**
 * Where each server-side realm lives and what its mirror is keyed by.
 *
 * The mirror key follows what the realm is shared by, so the cache is as warm as
 * it can be: a window's is scoped to this project AND this window, a project's
 * to this project, and a user's not at all — the last of which also means the
 * preferences that were already stored under a bare key (tips, the bell, tool
 * grouping) find their own values there on the first frame after an upgrade.
 * @type {Record<ServerRealm, {url: () => string, key: (name: string) => string}>}
 */
const REALMS = {
  window: {
    url: () => `/api/session/ui-prefs?role=${encodeURIComponent(windowRole())}`,
    key: (name) => scopedKey(name),
  },
  project: {
    url: () => '/api/session/ui-prefs?scope=project',
    key: (name) => (projectKey() ? `${name}:${projectKey()}` : name),
  },
  user: {
    url: () => '/api/settings',
    key: (name) => name,
  },
};

/**
 * Each realm's document once read, plus anything written since.
 * @type {Map<ServerRealm, Record<string, any>>}
 */
const documents = new Map();
/**
 * The in-flight (or settled) read per realm, so N callers make one request.
 * @type {Map<ServerRealm, Promise<Record<string, any>>>}
 */
const reads = new Map();
/**
 * Whether the last read of a realm actually reached the server.
 * @type {Map<ServerRealm, boolean>}
 */
const reachable = new Map();
/**
 * The writes waiting to go out, per realm.
 * @type {Map<ServerRealm, {patch: Record<string, any>, timer: any, promise: Promise<void>, resolve: () => void}>}
 */
const writes = new Map();

/**
 * This project's storage key, as the server injected it into the page.
 * @returns {string} The key, or '' in a window with no project.
 * @private
 */
function projectKey() {
  return (typeof window === 'undefined' ? '' : window.__projectKey) || '';
}

/**
 * Namespace a localStorage key by the loaded project, and by this window when it
 * is not the ordinary one.
 *
 * The page origin identifies a *port*, not a project: the next project's server
 * reuses the port, one process can switch project in place, and a viewer
 * arriving over the studio relay sees a single origin for every project on every
 * machine it connects to. Unnamespaced, this project would read whatever the
 * last one left behind. The server injects the key pre-paint; a no-project
 * window has none and falls back to the bare key, which is all it needs.
 *
 * A detached board is its own window with its own appearance, but localStorage
 * is shared by every document on the origin — so a board gets its role appended
 * and the Juggler shell keeps the plain key.
 * @param {string} base - The unscoped key, e.g. 'juggler-zoom'.
 * @returns {string} The key to read and write.
 */
export function scopedKey(base) {
  const key = projectKey();
  const scoped = key ? `${base}:${key}` : base;
  const role = windowRole();
  return role === WINDOW_ROLE_MAIN ? scoped : `${scoped}@${role}`;
}

/**
 * Resolve which stored value a freshly-opened page should adopt.
 *
 * The window-scoped hints (a mode carried across a same-window reload, a seed
 * the native host baked into the URL of a window it opened) keep their middle
 * position either way; what flips is which store bookends them — the project's
 * session in a desktop window, this device's own in a remote browser. The hints
 * are all absent in a remote browser anyway, since only the native host creates
 * them, so the two orders differ exactly where they should.
 *
 * Every source is either a usable value or null; the first usable one wins.
 * @param {object} sources - Candidate values, each already validated or null.
 * @param {boolean} sources.desktop - True in a native desktop window.
 * @param {any} sources.session - The server-side value for this client.
 * @param {any} sources.device - This device's stored value (localStorage).
 * @param {any[]} [sources.windowScoped] - Window-scoped hints, best first.
 * @param {any} [sources.fallback] - Returned when nothing is stored anywhere.
 * @returns {any} The value to adopt.
 */
export function resolvePref({ desktop, session, device, windowScoped = [], fallback = null }) {
  const ordered = desktop
    ? [session, ...windowScoped, device]
    : [device, ...windowScoped, session];
  return ordered.find((value) => value !== null && value !== undefined) ?? fallback;
}

/**
 * Best-effort broadcast of a named UI-pref change on `window`, so live views can
 * re-sync without waiting for an unrelated render.
 * @param {string} eventName - The CustomEvent name to dispatch.
 * @returns {void}
 */
export function notifyPrefChanged(eventName) {
  try {
    window.dispatchEvent(new CustomEvent(eventName));
  } catch {
    /* no window / CustomEvent — nothing to notify */
  }
}

/**
 * Read a JSON value out of a Web Storage area, tolerant of a missing or corrupt
 * one.
 * @param {Storage|null} store
 * @param {string} key
 * @param {any} fallback
 * @returns {any} The parsed value, or `fallback`.
 * @private
 */
function readStore(store, key, fallback) {
  try {
    const raw = JSON.parse((store && store.getItem(key)) || 'null');
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON value into a Web Storage area, best-effort: a full or
 * unavailable store just means this value is not remembered.
 * @param {Storage|null} store
 * @param {string} key
 * @param {any} value
 * @returns {void}
 * @private
 */
function writeStore(store, key, value) {
  try {
    if (store) store.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

/**
 * This tab's value for a preference.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored.
 * @returns {any} The stored value, or `fallback`.
 */
export function getTabPref(name, fallback = null) {
  return readStore(typeof sessionStorage === 'undefined' ? null : sessionStorage, scopedKey(name), fallback);
}

/**
 * Store a preference for this tab alone. It is gone when the tab is.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value.
 * @returns {void}
 */
export function setTabPref(name, value) {
  writeStore(typeof sessionStorage === 'undefined' ? null : sessionStorage, scopedKey(name), value);
}

/**
 * This device's value for a preference — meaning this origin's, which is to say
 * this port's. Also the store the three server-side realms mirror into, so a
 * preference and its mirror share one cell by design.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored.
 * @returns {any} The stored value, or `fallback`.
 */
export function getDevicePref(name, fallback = null) {
  return readStore(typeof localStorage === 'undefined' ? null : localStorage, scopedKey(name), fallback);
}

/**
 * Store a preference against this device.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value.
 * @returns {void}
 */
export function setDevicePref(name, value) {
  writeStore(typeof localStorage === 'undefined' ? null : localStorage, scopedKey(name), value);
}

/**
 * Read one realm's mirror, falling back to the bare, unscoped key.
 *
 * That fallback is the migration path: every preference moved into a realm was
 * stored under its bare name before, so a value left behind by an older build is
 * found once and promoted by {@link getRealmPref}. Nothing is deleted, and it
 * only ever reaches the origin the user happens to boot on — a value stranded in
 * another port's store is unreachable, because a page cannot enumerate other
 * origins.
 * @param {ServerRealm} realm
 * @param {string} name
 * @returns {any} The mirrored value, or null.
 * @private
 */
function readMirror(realm, name) {
  const store = typeof localStorage === 'undefined' ? null : localStorage;
  const key = REALMS[realm].key(name);
  const mirrored = readStore(store, key, null);
  if (mirrored !== null) return mirrored;
  return key === name ? null : readStore(store, name, null);
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} value
 * @returns {void}
 * @private
 */
function writeMirror(realm, name, value) {
  writeStore(typeof localStorage === 'undefined' ? null : localStorage, REALMS[realm].key(name), value);
}

/**
 * Fetch one realm's whole document, once. Every preference in a realm arrives in
 * the same reply, so a page hydrates all of them for one round trip however many
 * managers ask.
 *
 * A realm that cannot be reached reads as empty rather than as an error: the
 * mirror then carries the answer, which is the same degradation a remote viewer
 * lives in permanently.
 * @param {ServerRealm} realm
 * @returns {Promise<Record<string, any>>} The realm's stored preferences.
 * @private
 */
function readRealm(realm) {
  let pending = reads.get(realm);
  if (!pending) {
    pending = fetchJson(REALMS[realm].url(), { fallback: null }).then((doc) => {
      reachable.set(realm, !!doc);
      const stored = doc && typeof doc.ui === 'object' && doc.ui ? doc.ui : {};
      // Anything written while the read was in flight is newer than what came
      // back, so it stays on top.
      const merged = { ...stored, ...(documents.get(realm) || {}) };
      documents.set(realm, merged);
      for (const [name, value] of Object.entries(stored)) writeMirror(realm, name, value);
      return merged;
    });
    reads.set(realm, pending);
  }
  return pending;
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} fallback
 * @returns {Promise<any>} The value this client should use.
 * @private
 */
async function getRealmPref(realm, name, fallback) {
  const device = readMirror(realm, name);
  const stored = await readRealm(realm);
  const value = stored[name] === undefined ? null : stored[name];
  // The user realm is one document for every client that can reach it, so there
  // is no device-first ordering to apply; the other two are the desktop's own.
  const desktop = realm === 'user' || isDesktopWindow();

  // Nothing in the realm but something on this device: a value an older build
  // left in localStorage. Adopt it and write it up, so the next launch — on
  // whatever port — finds it in the realm. One way, and only once, since the
  // write puts it in this realm's document too.
  if (desktop && value === null && device !== null && reachable.get(realm)) {
    void setRealmPref(realm, name, device);
    return device;
  }
  const resolved = resolvePref({ desktop, session: value, device, fallback });
  if (desktop && resolved !== null && resolved !== undefined) writeMirror(realm, name, resolved);
  return resolved;
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} fallback
 * @returns {any} What is known about this preference right now.
 * @private
 */
function cachedRealmPref(realm, name, fallback) {
  const stored = documents.get(realm);
  // A null reads as "not stored", here and everywhere else: it is what a
  // forgotten preference leaves behind, and what a corrupt one degrades to.
  if (stored && stored[name] !== undefined && stored[name] !== null) return stored[name];
  const mirrored = readMirror(realm, name);
  return mirrored === null ? fallback : mirrored;
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} value
 * @returns {Promise<void>} Resolves once the write has reached the server (or
 *   been refused, which is a remote viewer's ordinary state).
 * @private
 */
function setRealmPref(realm, name, value) {
  writeMirror(realm, name, value);
  const stored = documents.get(realm) || {};
  stored[name] = value;
  documents.set(realm, stored);
  return queueWrite(realm, name, value);
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} value
 * @returns {Promise<void>} Resolves when the batch this joined has been sent.
 * @private
 */
function queueWrite(realm, name, value) {
  let batch = writes.get(realm);
  if (!batch) {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = /** @type {() => void} */ (r); });
    batch = { patch: {}, timer: null, promise, resolve };
    writes.set(realm, batch);
  }
  batch.patch[name] = value;
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => { void flushRealm(realm); }, WRITE_DELAY_MS);
  return batch.promise;
}

/**
 * Send one realm's waiting writes as a single partial update.
 * @param {ServerRealm} realm
 * @returns {Promise<void>} Resolves when the request has settled.
 * @private
 */
async function flushRealm(realm) {
  const batch = writes.get(realm);
  if (!batch) return;
  writes.delete(realm);
  if (batch.timer) clearTimeout(batch.timer);
  // A refusal (a remote viewer's 403) and a failure are the same thing here:
  // this device keeps its own copy in the mirror either way.
  await fetchJson(REALMS[realm].url(), { method: 'PUT', body: { ui: batch.patch }, fallback: null });
  batch.resolve();
}

/**
 * Send everything waiting, whatever its timer says.
 * @returns {void}
 * @private
 */
function flushAll() {
  for (const realm of [...writes.keys()]) void flushRealm(/** @type {ServerRealm} */ (realm));
}

// A page being hidden or torn down may not come back, so anything still waiting
// on its timer goes now. This is best-effort by nature: a request started as the
// page closes is not guaranteed to finish, which is the reason the delay is
// short and the mirror is written first.
if (typeof document !== 'undefined') {
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
}

/**
 * This window's value for a preference, reconciled with the realm.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored anywhere.
 * @returns {Promise<any>} The value this window should use.
 */
export function getWindowPref(name, fallback = null) {
  return getRealmPref('window', name, fallback);
}

/**
 * Store a preference for this window of this project. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setWindowPref(name, value) {
  return setRealmPref('window', name, value);
}

/**
 * This window's value as it is known right now, without waiting for the realm —
 * for a read on the render path. Reconcile with {@link getWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedWindowPref(name, fallback = null) {
  return cachedRealmPref('window', name, fallback);
}

/**
 * This project's value for a preference, shared by all its windows.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored anywhere.
 * @returns {Promise<any>} The value this project should use.
 */
export function getProjectPref(name, fallback = null) {
  return getRealmPref('project', name, fallback);
}

/**
 * Store a preference for every window of this project. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setProjectPref(name, value) {
  return setRealmPref('project', name, value);
}

/**
 * This project's value as it is known right now. See {@link cachedWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedProjectPref(name, fallback = null) {
  return cachedRealmPref('project', name, fallback);
}

/**
 * This person's value for a preference, in every project.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored anywhere.
 * @returns {Promise<any>} The value to use.
 */
export function getUserPref(name, fallback = null) {
  return getRealmPref('user', name, fallback);
}

/**
 * Store a preference against this person, for every project. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setUserPref(name, value) {
  return setRealmPref('user', name, value);
}

/**
 * This person's value as it is known right now. See {@link cachedWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedUserPref(name, fallback = null) {
  return cachedRealmPref('user', name, fallback);
}

/**
 * Read a preference from its realm and announce it if the realm knew something
 * the cache did not.
 *
 * Every manager that answers synchronously needs exactly this at boot: it
 * renders from the cache, and a value that arrives late has to reach the views
 * already on screen. It takes the realm as an argument rather than being one
 * function per realm because the managers differ only in which realm they name.
 * A redundant event is harmless — it is a re-sync signal, not a change record —
 * so the comparison is a plain one rather than anything shape-aware.
 * @param {ServerRealm} realm - The realm the preference lives in.
 * @param {string} name - The preference name.
 * @param {string} eventName - The CustomEvent to fire when it differs.
 * @returns {Promise<any>} The realm's value.
 */
export function reconcilePref(realm, name, eventName) {
  const before = JSON.stringify(cachedRealmPref(realm, name, null) ?? null);
  return getRealmPref(realm, name, null).then((value) => {
    if (JSON.stringify(value ?? null) !== before) notifyPrefChanged(eventName);
    return value;
  });
}

/**
 * Forget every realm read, cached document and waiting write.
 *
 * For tests only, and only because this module deliberately caches for the life
 * of the page: a suite that stands in for the server has to be able to start
 * each case from nothing.
 * @returns {void}
 */
export function __resetPrefsForTests() {
  for (const batch of writes.values()) {
    if (batch.timer) clearTimeout(batch.timer);
    batch.resolve();
  }
  writes.clear();
  documents.clear();
  reads.clear();
  reachable.clear();
}

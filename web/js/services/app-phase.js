//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How far the app has got through starting up: the registries, the socket, the
 * session, and then done. One state for the whole of it, so the UI that covers
 * the window while it happens has a single thing to read and a single place to
 * learn what to call the wait.
 *
 * The phase is only ever used to name the wait ({@link labelForPhase}) and to
 * say when it is over, so adding one is a wording change and nothing else.
 * Nothing about the layout hangs off it: the startup overlay covers the window
 * opaquely, which is what makes a phase a caption rather than a state the rest
 * of the UI has to be arranged around.
 * @module services/app-phase
 */

/**
 * @typedef {'starting'|'extensions'|'connecting'|'session'|'ready'} AppPhase
 */

/**
 * What each phase is called on screen, or `''` for a phase with nothing worth
 * saying: `starting` is over before anything could be read, and `ready` is not
 * a wait at all. Plain descriptions — this is copy a slow launch puts in front
 * of someone who wants to know what the delay is, so it is information.
 * @type {Readonly<Record<AppPhase, string>>}
 */
const PHASE_LABELS = Object.freeze({
  starting: '',
  extensions: 'Loading extensions',
  connecting: 'Connecting',
  session: 'Loading session',
  ready: ''
});

/** @type {AppPhase} */
let _phase = 'starting';

/** @type {Set<(phase: AppPhase) => void>} */
const _subscribers = new Set();

/**
 * Move the app to a phase. Unlike `connection-status.js`, whose state is a
 * mirror of socket events it subscribes to itself, the phases are the bootstrap
 * telling us where it has got to — so this is exported.
 *
 * `ready` is a one-way door: once the app is usable, nothing may put the
 * startup UI back over it. A reconnection later is the disconnection overlay's
 * business, not a return to starting up.
 * @param {AppPhase} next - The phase the app has reached.
 */
export function setAppPhase(next) {
  if (_phase === next) return;
  if (_phase === 'ready') return;
  _phase = next;
  for (const fn of _subscribers) fn(_phase);
}

/**
 * What to call a phase on screen.
 * @param {AppPhase} phase - The phase to name.
 * @returns {string} The label, or `''` for a phase not worth naming.
 */
export function labelForPhase(phase) {
  return PHASE_LABELS[phase] ?? '';
}

const appPhase = {
  /**
   * The phase the app is in. Starts at `starting`, which is the phase this
   * module's own fetch happens during.
   * @returns {AppPhase} Current phase.
   */
  get() {
    return _phase;
  },

  /**
   * Subscribe to phase changes. The callback fires only on change, so callers
   * should seed themselves from `get()` first.
   * @param {(phase: AppPhase) => void} fn - Called with each new phase.
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
  },

  /**
   * Put the phase back to `starting` and drop every subscriber. For tests, which
   * share one page with everything else on it: a module singleton that has
   * reached `ready` refuses every later move, so a suite that cannot reset it
   * can only be run once.
   */
  resetForTests() {
    _phase = 'starting';
    _subscribers.clear();
  }
};

export default appPhase;

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import LoadingOverlay from './loading-overlay.js';
import appPhase, { labelForPhase } from '../services/app-phase.js';

/**
 * Time in view before the overlay says what it is doing. A local server answers
 * in milliseconds, so on the ordinary launch this is never reached and the whole
 * of startup is a spinner in a dimmed window. The wording is for the launch that
 * has gone slow — a cold extension load, a server over the network, a session
 * with a great many conversations — where what is holding it up is the only
 * thing worth knowing.
 * @type {number}
 */
const STARTUP_GRACE_MS = 1500;

/**
 * StartupOverlay
 *
 * The {@link LoadingOverlay} configured for the app starting up, with the
 * current phase for its line. It covers the window from the first frame (the
 * element is in `index.html`, so it is painted before any of this is fetched)
 * until the session is loaded and there is something real to look at.
 *
 * It retires itself when the phase reaches `ready`, so the bootstrap only has to
 * say where it has got to and never has to remember to put the overlay away.
 */
class StartupOverlay extends LoadingOverlay {
  constructor() {
    super({
      variant: 'startup',
      graceMs: STARTUP_GRACE_MS
    });

    /** @type {(() => void)|null} @private */
    this._unsubscribePhase = null;
  }

  /**
   * Show the overlay and keep its line on the phase the app is in.
   */
  show() {
    super.show();
    this.setLine(labelForPhase(appPhase.get()));
    this._unsubscribePhase = appPhase.subscribe((phase) => {
      if (phase === 'ready') {
        this.hide();
        return;
      }
      this.setLine(labelForPhase(phase));
    });
  }

  /**
   * Take the overlay off screen and stop following the phase.
   */
  hide() {
    if (this._unsubscribePhase) {
      this._unsubscribePhase();
      this._unsubscribePhase = null;
    }
    super.hide();
  }
}

export default StartupOverlay;

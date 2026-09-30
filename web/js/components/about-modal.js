//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { markPopupOpen } from '../utils/popup-manager.js';
import { focusWhenShown } from '../utils/focus.js';
import { fetchJson } from '../services/http.js';
import { LOGO_WITH_NAME_SVG } from '../utils/juggler-logo.js';
import { dragGuard } from '../utils/drag-guard.js';
import JugglerElement from './juggler-element.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * AboutModal - Shows information about the application
 *
 * Opens when clicking the logo in the header, or on `juggler:open-about` —
 * which is what the desktop app's "About Juggler" menu item dispatches, so the
 * native menu shows this box rather than the platform's own about panel.
 * Displays app name, version, and a brief description with a link to the website.
 */
class AboutModal extends JugglerElement {
  constructor() {
    super();
    /** @type {boolean} @private */
    this._isOpen = false;
    /** @type {string} @private */
    this._version = '';
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {Animation[]} @private */
    this._clubAnimations = [];
  }

  connectedCallback() {
    this.render();
    this._setupLogoClick();
    this.addCleanup(() => this._cancelClubThrows());
    this.onWindow('juggler:open-about', () => { void this.open(); });
  }

  /**
   * Set up click handler on the logo
   * @private
   */
  _setupLogoClick() {
    const logo = /** @type {HTMLElement|null} */ (document.querySelector('.logo'));
    if (logo) {
      // The logo sits in the window's drag region, and the release that ends a
      // window drag arrives here as a click.
      const drag = dragGuard();
      this.on(logo, 'pointerdown', drag.watch);
      this.on(logo, 'click', () => { if (!drag.dragged()) this.open(); });
    }
  }

  /**
   * Fetch version from the API
   * @private
   * @returns {Promise<string>} The version string or 'Unknown' on error
   */
  async _fetchVersion() {
    const data = await fetchJson(apiUrl('/version'), {
      errorPrefix: '[AboutModal] Failed to fetch version',
      fallback: null,
    });
    return data?.version || 'Unknown';
  }

  /**
   * Open the about modal
   */
  async open() {
    // Fetch version if not already loaded
    if (!this._version) {
      this._version = await this._fetchVersion();
    }

    this._isOpen = true;
    this.render();

    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this._close());
    }
  }

  /**
   * Close the about modal
   * @private
   */
  _close() {
    this._isOpen = false;
    this.render();

    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
  }

  /** @private */
  render() {
    this._cancelClubThrows();
    if (!this._isOpen) {
      this.innerHTML = '';
      return;
    }

    this.innerHTML = `
            <modal-backdrop class="about-backdrop"></modal-backdrop>
            <modal-panel class="about-container">
                <header class="about-header">
                    <div class="about-logo">${LOGO_WITH_NAME_SVG}</div>
                    <span class="about-version">${this._version}</span>
                </header>

                <main class="about-content">
                    <p class="about-description">
                        A plugin-powered visual AI coding agent.
                    </p>
                    <p class="about-description">
                        Created in a moment of madness by <a href="https://github.com/julianstorer" target="_blank" rel="noopener noreferrer" style="white-space: nowrap">Julian Storer</a>
                    </p>
                    <p class="about-description">
                      Juggler is still very new, and I'd love to hear people's opinions about it -
                      please visit the discord group to chat or hear more about the roadmap!
                    </p>
                    <p class="about-link">
                        <a href="https://juggler.studio" target="_blank" rel="noopener noreferrer">https://juggler.studio</a>
                    </p>
                    <p class="about-link">
                        <a href="https://discord.gg/HyqZwKvSMd" target="_blank" rel="noopener noreferrer">Click here to join the discord server</a>
                    </p>
                </main>

                <footer class="about-footer">
                    <button class="about-button primary" id="about-close">
                        Close
                    </button>
                </footer>
            </modal-panel>
        `;

    // Attach event listeners
    const backdrop = this.querySelector('.about-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this._close());
    }

    const closeButton = this.querySelector('#about-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => this._close());
      // Focus the close button
      focusWhenShown(/** @type {HTMLElement} */ (closeButton));
    }

    // Opening and clicking the logo both start a short three-club cascade.
    const logo = /** @type {HTMLElement|null} */ (this.querySelector('.about-logo'));
    if (logo) {
      // Keep the full flight inside the SVG's own painting surface; overflow
      // alone does not expand the raster bounds of accelerated SVG animations.
      logo.querySelector('svg')?.setAttribute('viewBox', '-40 -140 176.238 308.263');
      this._throwClubs(logo);
      logo.addEventListener('click', () => this._throwClubs(logo));
    }
  }

  /** @private */
  _cancelClubThrows() {
    for (const animation of this._clubAnimations) animation.cancel();
    this._clubAnimations = [];
  }

  /**
   * Four alternating throws per club, separated by a hand's catching/scooping
   * beat. Travel is sampled from x = lerp(start, end), y = lerp(start, end)
   * - 4h t(1-t): constant horizontal velocity and constant downward acceleration.
   * Rotation is independent, one full turn per flight, with no spin in the hand.
   * All lengths are SVG user units, so the whole cascade scales with the logo.
   * @param {HTMLElement} logo
   * @private
   */
  _throwClubs(logo) {
    this._cancelClubThrows();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const svg = /** @type {SVGSVGElement} */ (logo.querySelector('svg'));
    const rect = svg.getBoundingClientRect();
    const scale = rect.height / svg.viewBox.baseVal.height;
    const inkTop = rect.top - svg.viewBox.baseVal.y * scale;
    // Reserve half a spinning club plus a small margin at the viewport's top.
    const height = Math.max(0, Math.min(110, (inkTop - 24) / scale));
    const flight = 900;
    const hold = 450;
    const duration = 4 * flight + 3 * hold;

    logo.querySelectorAll('.logo-club').forEach((node, index) => {
      const club = /** @type {SVGGElement} */ (node);
      const box = club.getBBox();
      const homeX = box.x + box.width / 2;
      const homeY = box.y + box.height / 2;
      /** @type {Keyframe[]} */
      const travel = [];
      /** @type {Keyframe[]} */
      const spin = [];
      let x = 0;
      let y = 0;
      let angle = 0;
      /** @type {(time: number, dx: number, dy: number, rotation: number) => void} */
      const frame = (time, dx, dy, rotation) => {
        travel.push({ offset: time / duration, transform: `translate(${dx}px, ${dy}px)` });
        spin.push({ offset: time / duration, transform: `rotate(${rotation}deg)` });
      };

      for (let round = 0; round < 4; round++) {
        const start = round * (flight + hold);
        const right = (round + index) % 2 === 0;
        const targetX = round === 3 ? 0 : (right ? 48 : -18) - homeX;
        const targetY = round === 3 ? 0 : 18 - homeY;
        const turn = right ? 360 : -360;
        for (let step = 0; step <= 24; step++) {
          const t = step / 24;
          frame(start + t * flight, x + (targetX - x) * t,
            y + (targetY - y) * t - 4 * height * t * (1 - t), angle + turn * t);
        }
        angle += turn;
        x = targetX;
        y = targetY;
        if (round < 3) {
          // Catch on the outside, scoop down and inward, then launch across.
          for (let step = 1; step <= 8; step++) {
            const t = step / 8;
            frame(start + flight + t * hold, x + (right ? -12 : 12) * t,
              y + 5 * Math.sin(Math.PI * t), angle);
          }
          x += right ? -12 : 12;
        }
      }
      const options = { duration, delay: 600 + index * hold, easing: 'linear', fill: /** @type {FillMode} */ ('both') };
      this._clubAnimations.push(
        club.animate(travel, { ...options, id: 'about-club-flight' }),
        /** @type {SVGGElement} */ (club.querySelector('.logo-spin')).animate(spin, { ...options, id: 'about-club-spin' }),
      );
    });
  }
}

customElements.define('about-modal', AboutModal);

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { markPopupOpen } from '../utils/popup-manager.js';
import { focusWhenShown } from '../utils/focus.js';
import { fetchJson } from '../services/http.js';
import { LOGO_WITH_NAME_SVG } from '../utils/juggler-logo.js';
import { dragGuard } from '../utils/drag-guard.js';
import JugglerElement from './juggler-element.js';

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
  }

  connectedCallback() {
    this.render();
    this._setupLogoClick();
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
    const data = await fetchJson('/api/version', {
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
    if (!this._isOpen) {
      this.innerHTML = '';
      return;
    }

    this.innerHTML = `
            <modal-backdrop class="about-backdrop"></modal-backdrop>
            <modal-panel class="about-container">
                <header class="about-header">
                    <div class="about-logo tossing">${LOGO_WITH_NAME_SVG}</div>
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

    // The clubs are thrown off the panel and caught again shortly after the box
    // opens; the animation is declared in CSS and starts on its own because
    // render() builds the logo fresh every time. Clicking the logo throws them
    // again, which is the whole reason to click a logo.
    const logo = /** @type {HTMLElement|null} */ (this.querySelector('.about-logo'));
    if (logo) {
      logo.addEventListener('click', () => this._throwClubs(logo));
    }
  }

  /**
   * Re-run the club throw from the top.
   *
   * The animations are spent once they have played, so restarting means taking
   * the class off, forcing a reflow to discard them, and putting it back — the
   * same trick the spinner uses to recover a frozen cascade. Both writes and the
   * reflow happen in one task, so no intermediate frame is ever painted.
   * @param {HTMLElement} logo - The `.about-logo` element carrying the class.
   * @private
   */
  _throwClubs(logo) {
    logo.classList.remove('tossing');
    void logo.offsetWidth;
    logo.classList.add('tossing');
  }
}

customElements.define('about-modal', AboutModal);

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <no-project-overlay> — full-area placeholder shown when no project is
 * loaded. Keeps the empty window calm and points users at the header project
 * button instead of forcing a picker popup.
 */

import { openSettings } from '../services/settings-launcher.js';

class NoProjectOverlay extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {Function|null} @private */
    this._unsubscribe = null;
    /** @type {boolean} @private */
    this._rendered = false;
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  /**
   * @param {import('../model/session.js').default} session
   */
  setSession(session) {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._session = session;
    this._refresh();
    if (session) {
      this._unsubscribe = session.subscribe(/** @param {{type: string}} event */ (event) => {
        if (
          event.type === 'project:changed'
          || event.type === 'session:loaded'
          || event.type === 'conversation:created'
          || event.type === 'conversation:deleted'
        ) {
          this._refresh();
        }
      });
    }
  }

  /** @private */
  _refresh() {
    const empty = !this._session || !this._session.projectPath;

    // The sidebar and the tab column are hidden by one class on <body>, whose
    // rule lives beside this element's own CSS. Writing inline display on each
    // sibling instead would mean this element deciding, from the outside, what
    // "visible" means for two components that style themselves — and the reset
    // to `''` would silently clear any display those components ever set.
    document.body.classList.toggle('no-project', empty);

    if (!empty) {
      this.hidden = true;
      this._rendered = false;
      this.innerHTML = '';
      return;
    }

    this.hidden = false;

    if (!this._rendered) {
      this._rendered = true;
      this._render();
    }
  }

  /** @private */
  _render() {
    this.innerHTML = `
      <section class="onboarding-panel" aria-label="Welcome to Juggler">
        <div class="onboarding-logo" role="img" aria-label="Juggler"></div>
        <h1>Welcome to Juggler</h1>
        <p>
          Juggler is an AI coding agent designed around transparency, control, and fast iteration.
        </p>
        <p>
          Click <button type="button" class="onboarding-link no-project-project-link">'Set project folder'</button>
          above to open the codebase you want to work on.
        </p>
        <p class="no-project-settings-note">
          Set up your LLM provider keys in the
          <button type="button" class="onboarding-link no-project-settings-link">settings</button>.
        </p>
        <p class="no-project-settings-note">
          New here? Browse the
          <button type="button" class="onboarding-link no-project-shortcuts-link">keyboard shortcuts</button>.
        </p>
        <p class="no-project-settings-note">
          Once you've opened a project, you can ask Juggler about itself -
          it can explain its own tools, shortcuts, and features.
        </p>
      </section>
    `;

    const projectLink = this.querySelector('.no-project-project-link');
    if (projectLink) {
      projectLink.addEventListener('click', async () => {
        const { openProjectPicker } = await import('./project-picker.js');
        openProjectPicker(this._session?.projectPath || '', this._session);
      });
    }

    const settingsLink = this.querySelector('.no-project-settings-link');
    if (settingsLink) {
      settingsLink.addEventListener('click', () => {
        openSettings('providers');
      });
    }

    const shortcutsLink = this.querySelector('.no-project-shortcuts-link');
    if (shortcutsLink) {
      shortcutsLink.addEventListener('click', () => {
        openSettings('shortcuts');
      });
    }
  }
}

customElements.define('no-project-overlay', NoProjectOverlay);
export default NoProjectOverlay;

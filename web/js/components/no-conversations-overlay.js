//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <no-conversations-overlay> — full-area placeholder shown when a project is
 * loaded but no conversation is open.
 *
 * One route reaches it: binning the last conversation, which `binConversation`
 * deliberately allows (deleting the last one is refused instead). The session
 * re-seeds a conversation on its next load, so this is a live-session state
 * that ends the moment the user starts one — which is all this says.
 *
 * <no-project-overlay> handles the state before this one, and the two never
 * show together: that one needs a project absent, this one needs it present.
 */

class NoConversationsOverlay extends HTMLElement {
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
    const session = this._session;
    const empty = !!session && !!session.projectPath && session.conversations.size === 0;

    // The tab column is hidden by one class on <body>, whose rule lives beside
    // <no-project-overlay>'s in the layout layer, for the reason given there.
    // The sidebar is NOT hidden: it holds the "+" this copy points at.
    document.body.classList.toggle('no-conversations', empty);

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
      <section class="onboarding-panel" aria-label="No conversations">
        <div class="onboarding-logo" role="img" aria-label="Juggler"></div>
        <p>Click '+ New conversation' in the sidebar to start one.</p>
      </section>
    `;
  }
}

customElements.define('no-conversations-overlay', NoConversationsOverlay);
export default NoConversationsOverlay;

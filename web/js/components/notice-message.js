//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import { wrapWithIcon, TYPE_ICONS } from '../utils/icon-message-renderer.js';
import { NOTICE_TYPE_NAME } from '../utils/item-badge.js';
import { openSettings } from '../services/settings-launcher.js';

/**
 * Notice message component — a durable record of something that happened to a
 * turn and is worth reading after the fact: a provider rebuilding its context
 * cache, say. It stands in the transcript where the event occurred, so the
 * explanation is still there when the user gets round to looking at it.
 *
 * Amber triangle, and no action button unless the notice names a setting: a
 * notice reports, it does not ask. The row is one line — icon, a "Warning"
 * lozenge and a sentence saying what happened — because nothing failed and
 * nothing needs doing. The lozenge says only what kind of item this is; a
 * reader who cannot see why it is there has been told nothing, so the sentence
 * beside it carries the meaning. The rest (the measured values, the provider's
 * verbatim reason) is read by selecting the row, in the properties panel.
 *
 * The one exception is a notice whose cause is a setting the user can correct —
 * a context window Juggler had to assume. Such a notice carries a
 * `notice-settings` target, and the row gains a single link to that field, so
 * the fix is one click from the explanation rather than a hunt through
 * Settings.
 */
class NoticeMessage extends BaseMessage {
  static get observedAttributes() {
    return ['notice-text', 'notice-settings'];
  }

  /** @returns {string} The notice's one-line explanation */
  get text() {
    return this.getAttribute('notice-text') || '';
  }

  /**
   * The setting this notice links to, when it names one Juggler knows how to
   * open. Only a model's Context window field is such a target today.
   * @returns {{provider: string, model: string}|null} The model whose window to open
   */
  get settingsTarget() {
    const raw = this.getAttribute('notice-settings');
    if (!raw) return null;
    try {
      const target = JSON.parse(raw);
      if (target?.tab === 'providers' && target.field === 'contextWindow'
        && typeof target.provider === 'string' && typeof target.model === 'string') {
        return { provider: target.provider, model: target.model };
      }
    } catch {
      // A malformed target is simply not a link.
    }
    return null;
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'notice';

    // A fixed lozenge and the explanation beside it, in the type-name/summary
    // shape every other one-line item uses — so the row is the same height as
    // its neighbours and the sentence truncates rather than wrapping.
    const body = renderResultStatusMessage({ typeName: NOTICE_TYPE_NAME, summary: this.text });

    // The `error` glyph is a warning triangle; amber rather than the error
    // component's red, and distinct from thinking's yellow.
    article.appendChild(wrapWithIcon(body, {
      color: 'amber',
      iconSvg: TYPE_ICONS.error
    }));

    const target = this.settingsTarget;
    if (target) {
      const actions = document.createElement('div');
      actions.className = 'notice-message-actions message-row-body';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-action-btn notice-settings-btn';
      button.textContent = 'Set context window';
      button.title = `Open ${target.model}'s Context window field in Settings → Providers`;
      button.addEventListener('click', (event) => {
        // The row is selectable; opening settings is not a selection.
        event.preventDefault();
        event.stopPropagation();
        openSettings('providers', { model: { provider: target.provider, id: target.model } });
      });
      actions.appendChild(button);
      article.appendChild(actions);
    }

    this.replaceChildren(article);
  }
}

customElements.define('notice-message', NoticeMessage);

export default NoticeMessage;

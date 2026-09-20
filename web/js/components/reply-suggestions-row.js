//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Suggested replies: the row of chips directly above the composer.
 *
 * That position is the whole design. It is where a phone keyboard puts its word
 * suggestions, and the chips are cut from the composer's own material — same
 * background, same corner radius, same font as the box the words land in (see
 * the `reply-suggestions` rules in `components/composer.css`, which share their surface
 * declarations with `composer-box-wrapper` so the two cannot drift apart). A
 * chip then reads as the composer offering to fill itself in, rather than as
 * another control the column owns.
 *
 * The row decides nothing: `services/reply-suggestions-controller.js` decides
 * whether to ask at all, and `conversation-area.js` decides which columns get a
 * row and when it clears. This is handed a list and draws it.
 * @module components/reply-suggestions-row
 */

/**
 * A row of suggested replies. Clicking one dispatches `reply-suggestion-chosen`
 * (bubbling, composed) carrying `{ text }` — the column drafts those words into
 * the composer and sends nothing.
 */
class ReplySuggestionsRow extends HTMLElement {
  /**
   * The suggestions currently drawn, joined — the cheapest way to answer "has
   * anything changed?" before touching a row made entirely of click targets.
   * @type {string}
   * @private
   */
  _key = '';

  connectedCallback() {
    // The chips belong together and the row carries no visible heading, so it
    // says what they are. Each chip's own words are its label; nothing else
    // would be more use to a screen reader than the sentence it is offering.
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Suggested replies');
    if (!this.firstElementChild) this.hidden = true;
  }

  /**
   * Draw one chip per suggestion.
   *
   * Rebuilt only when the suggestions actually change: the owning column calls
   * this from `updateFooter`, which runs several times a second while a turn
   * streams, and replacing a button between a press and its release swallows
   * the press. On a row whose entire purpose is being clicked, that would not
   * be an intermittent annoyance — it would be the feature not working.
   * @param {string[]} suggestions - What to offer; empty hides the row.
   */
  update(suggestions) {
    const key = suggestions.join('\u0000');
    if (key === this._key) return;
    this._key = key;

    this.textContent = '';
    for (const text of suggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reply-suggestion';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('reply-suggestion-chosen', {
          bubbles: true,
          composed: true,
          detail: { text },
        }));
      });
      this.appendChild(chip);
    }
    this.hidden = suggestions.length === 0;
  }
}

customElements.define('reply-suggestions', ReplySuggestionsRow);

export default ReplySuggestionsRow;

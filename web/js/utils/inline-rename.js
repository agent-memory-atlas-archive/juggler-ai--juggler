//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Renaming a thing in place: the small editor that opens over the row carrying
 * its name.
 *
 * It is one gesture wherever it appears — the name arrives selected, Enter
 * keeps what was typed, Escape keeps what was there, and clicking away is
 * Enter — so it is one implementation, styled by `css/patterns/inline-rename.css`.
 * The two files are halves of one thing; change neither alone.
 *
 * Shared by the conversation tabs and the workspace boxes in the sidebar
 * strip. Everything either of them knows that the other does not — what the
 * limit is, what to call the server, what a refusal means, where the keyboard
 * goes afterwards — is the caller's, passed in. What is here is the editor.
 * @module utils/inline-rename
 */

/**
 * The name a row is currently showing, made editable in place.
 *
 * The editor is appended INSIDE `host`, which must be positioned, so it tracks
 * the row through a reorder without anything re-anchoring it. It lies over the
 * row rather than replacing it: the row underneath keeps being painted by
 * whatever owns it, and the overlay is opaque.
 *
 * Calling this again on a host already being renamed does not open a second
 * editor — it puts the keyboard back in the one that is open, with the text
 * selected, which is what a user who asked twice was after.
 * @param {HTMLElement} host - The row the editor opens over. Marked
 *   `.is-renaming` for as long as it is open, which is also how callers know to
 *   leave the row alone (repaints, drags, clicks).
 * @param {object} options
 * @param {string} options.value - The name as it stands. Empty is fine: the
 *   editor opens blank and anything typed is a change.
 * @param {number} options.maxLength - The longest name the field accepts. The
 *   browser stops typed input at it; paste and anything programmatic is the
 *   caller's to catch.
 * @param {(value: string) => (void | string | Promise<void | string>)} options.commit -
 *   What to do with the trimmed, changed name. Return nothing — or an empty
 *   string, which is the same thing — to close the editor; return a message to
 *   keep it open showing that message, with the
 *   text selected to be typed over — which is what a refusal the user can
 *   answer (a name already taken) looks like. A throw closes the editor and is
 *   logged, on the grounds that an editor left open after a failure nobody can
 *   explain is worse than one that closed — so a caller with anything to say
 *   about a failure says it by returning a message, or says it itself.
 * @param {() => void} [options.onClose] - Called once, after the editor has
 *   gone, however it went. Where the keyboard is handed to.
 * @param {(api: {close: () => void}) => (Node|Node[]|null)} [options.actions] -
 *   Anything offered beneath the field as an alternative to typing a name.
 *   Given the editor's own `close` so an action can take over and dismiss it.
 * @returns {HTMLInputElement} The field, focused and selected.
 */
export function openInlineRename(host, { value, maxLength, commit, onClose, actions }) {
  const open = /** @type {HTMLInputElement|null} */ (host.querySelector('.inline-rename-input'));
  if (host.classList.contains('is-renaming') && open) {
    open.focus();
    open.select();
    return open;
  }

  const original = value;

  const block = document.createElement('div');
  block.className = 'inline-rename';
  block.innerHTML = `
    <input class="inline-rename-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
    <div class="inline-rename-error" hidden></div>
    <div class="inline-rename-actions"></div>
  `;
  const input = /** @type {HTMLInputElement} */ (block.querySelector('.inline-rename-input'));
  const errorEl = /** @type {HTMLElement} */ (block.querySelector('.inline-rename-error'));
  const actionsEl = /** @type {HTMLElement} */ (block.querySelector('.inline-rename-actions'));
  input.maxLength = maxLength;
  input.value = original;

  // Stop presses inside the editor from reaching the row underneath, which
  // would take a click for "rename this" all over again and a drag for a
  // reorder.
  block.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  block.addEventListener('click', (e) => { e.stopPropagation(); });

  // `done` blocks any further work once the editor has gone — it covers the
  // blur that fires when close() removes the focused field, and a commit
  // arriving twice from a fast Enter-then-blur.
  let done = false;

  const showError = (/** @type {string} */ message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.focus();
    input.select();
  };

  const close = () => {
    if (done) return;
    done = true;
    host.classList.remove('is-renaming');
    block.remove();
    onClose?.();
  };

  const keep = async () => {
    if (done) return;
    const name = input.value.trim();
    // Nothing typed, or nothing changed: there is no rename to make and no
    // reason to say so. Closing silently is the answer to both.
    if (name === '' || name === original) {
      close();
      return;
    }
    try {
      const refusal = await commit(name);
      if (done) return;
      if (typeof refusal === 'string' && refusal !== '') {
        showError(refusal);
        return;
      }
      close();
    } catch (e) {
      close();
      console.error('[inline-rename] The rename was refused with nothing to say about it:', e);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void keep();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('blur', () => { void keep(); });

  const offered = actions?.({ close });
  if (offered) {
    for (const node of Array.isArray(offered) ? offered : [offered]) actionsEl.appendChild(node);
  }

  host.classList.add('is-renaming');
  host.appendChild(block);
  input.focus();
  input.select();
  return input;
}

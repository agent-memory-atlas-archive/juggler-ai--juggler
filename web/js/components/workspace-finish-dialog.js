//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The dialog an ending raises when it needs something typed first.
 *
 * It is a dialog of its own rather than the generic prompt box because what it
 * asks for has a name. The generic box is one unlabelled input under whatever
 * string the caller flattened together, which is serviceable for "Name this
 * preset:" — a title, a colon, one word — and is not serviceable for a commit
 * message: the reader arrives at a blinking cursor under two sentences of policy
 * with nothing anywhere saying what the box holds.
 *
 * The rule the shape comes from: **an empty field must not mean something other
 * than a full one.** Leaving the box blank used to be how you asked the
 * conversation to write the commit message — a second, unrelated ending, chosen
 * by not typing, stated nowhere. Endings are buttons here, each one saying what
 * it does, and the field is only ever the thing it is labelled as.
 *
 * The field is built from the setup form's furniture (`.setup-field`,
 * `.setup-field-label`, `.setup-field-input`, `.setup-field-note`) so a field
 * looks like a field everywhere in the app. It is built here rather than by
 * `field()` in `extensions/juggler-core/lib/setup-fields.js`, which makes the
 * same DOM: that module is Apache-2.0 inside the extensions tree, and the host
 * does not reach into it. The CSS classes are the host's own.
 * @module components/workspace-finish-dialog
 */

import { presentModal } from '../utils/modal-surface.js';
import { setupButton } from './workspace-setup-form.js';

/** Sole counter behind field ids, so a label binds to its own field. */
let sequence = 0;

/**
 * A declared string, or nothing at all.
 * @param {any} value - Whatever the ending declared.
 * @returns {string} The string it meant, never "[object Object]".
 */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * How many files to draw before saying how many are left.
 *
 * A vendored dependency bump is thousands of paths, and nobody scrolls a
 * thousand rows in a modal to decide anything. The count above the list is the
 * fact that matters; the rows are there to be recognised, and a few dozen is as
 * many as anyone recognises.
 * @type {number}
 */
const FILES_SHOWN = 50;

/**
 * What the ending is about to act on, file by file.
 *
 * A commit takes the whole tree — `git add -A` — and a message box over a count
 * is not something a reader can consent to: what they are agreeing to is a
 * number, and the surprise in it is always a file they had forgotten or never
 * made. So the paths are on screen where the decision is.
 * @param {any} status - What the place last said about itself.
 * @returns {HTMLElement|null} The list, or null when nothing declared one.
 */
function workList(status) {
  const files = Array.isArray(status?.files) ? status.files : [];
  if (!files.length) return null;

  const total = Number.isFinite(status?.fileCount) && status.fileCount > files.length
    ? Number(status.fileCount)
    : files.length;

  const box = document.createElement('div');
  box.className = 'workspace-finish-work';

  const count = document.createElement('div');
  count.className = 'workspace-finish-work-count';
  count.textContent = total === 1 ? '1 file will be committed' : `${total} files will be committed`;
  box.appendChild(count);

  const list = document.createElement('div');
  list.className = 'workspace-finish-work-list';
  for (const file of files.slice(0, FILES_SHOWN)) {
    const row = document.createElement('div');
    row.className = 'workspace-finish-work-row';

    const state = document.createElement('span');
    state.className = 'workspace-finish-work-state';
    state.textContent = text(file?.state);
    row.appendChild(state);

    const path = document.createElement('span');
    path.className = 'workspace-finish-work-path';
    path.textContent = text(file?.path);
    row.appendChild(path);

    list.appendChild(row);
  }

  const hidden = total - Math.min(files.length, FILES_SHOWN);
  if (hidden > 0) {
    const rest = document.createElement('div');
    rest.className = 'workspace-finish-work-rest';
    rest.textContent = `…and ${hidden} more.`;
    list.appendChild(rest);
  }

  box.appendChild(list);
  return box;
}

/**
 * What the host knows about the place, for the dialog to say back.
 * @typedef {object} FinishContext
 * @property {any} [status] - The workspace's status as the chip last read it:
 *   `detail` is the line under the label, `dirty` whether it holds work
 * @property {string} [warning] - What the host wants said before this is done
 * @property {any} [conversation] - The conversation the ending is being carried
 *   out for, where there is one. An alternative hands the work to it — "Let this
 *   conversation write it" — so there is no such button when there is nobody to
 *   hand it to: asked of a workspace three conversations share, the ending names
 *   none of them (see `workspaceFinishActor`)
 */

/**
 * Ask for what an ending needs, and answer with it.
 * @param {any} option - The {@link import('../../sdk/workspace-provider.js').FinishOption}
 *   being carried out. Its `prompt` is what is asked for.
 * @param {FinishContext} [context] - What to say back about the place.
 * @returns {Promise<{message: string}|null>} What was typed, or null if nothing
 *   was chosen. An alternative answers with an empty message, which is the
 *   ending it names rather than an absence of one.
 */
export function openWorkspaceFinish(option, context = {}) {
  const prompt = option?.prompt ?? {};
  const status = context.status ?? null;

  // The ending says whether it needs the place to hold work; the host does not
  // infer it from a status field. "Nothing changed" stops a commit and means
  // nothing at all to an ending that asks for a name.
  const wantsWork = prompt.requiresWork === true;
  const idle = wantsWork && status?.dirty === false;

  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'workspace-finish-overlay',
      dismissSelectors: ['.workspace-finish-backdrop', '.workspace-finish-cancel'],
      onClose: (result) => resolve(result ?? null)
    });

    const backdrop = document.createElement('div');
    backdrop.className = 'workspace-finish-backdrop';
    modal.root.appendChild(backdrop);

    const dialog = document.createElement('div');
    dialog.className = 'workspace-finish-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', text(option?.label) || 'Finish');
    modal.root.appendChild(dialog);

    const title = document.createElement('h2');
    title.className = 'workspace-finish-title';
    title.textContent = text(option?.label);
    dialog.appendChild(title);

    if (option?.description) {
      const about = document.createElement('p');
      about.className = 'workspace-finish-about';
      about.textContent = option.description;
      dialog.appendChild(about);
    }

    // Which of several checkouts this is, and how much is in it. A worktree named
    // only by the branch it is on is not enough to commit into with confidence.
    if (status?.detail) {
      const where = document.createElement('div');
      where.className = 'workspace-finish-status';
      where.textContent = status.detail;
      dialog.appendChild(where);
    }

    const work = workList(status);
    if (work) dialog.appendChild(work);

    if (context.warning) {
      const caution = document.createElement('div');
      caution.className = 'workspace-finish-warning';
      caution.textContent = context.warning;
      dialog.appendChild(caution);
    }

    const id = `workspace-finish-field-${++sequence}`;
    const row = document.createElement('div');
    row.className = 'setup-field workspace-finish-field';

    const caption = document.createElement('label');
    caption.className = 'setup-field-label';
    caption.htmlFor = id;
    // The ending's label names the act; without a label of its own the field is
    // captioned by it, which is coarse but readable, and never nothing.
    caption.textContent = text(prompt.label) || text(option?.label);
    row.appendChild(caption);

    const multiline = prompt.multiline === true;
    const field = /** @type {any} */ (document.createElement(multiline ? 'textarea' : 'input'));
    if (multiline) field.rows = 4;
    else field.type = 'text';
    field.id = id;
    field.className = 'setup-field-input';
    field.placeholder = text(prompt.placeholder);
    field.value = text(prompt.value);
    field.spellcheck = multiline;
    field.autocomplete = 'off';
    row.appendChild(field);

    const note = document.createElement('div');
    note.className = 'setup-field-note';
    note.textContent = idle
      ? 'Nothing has changed here, so there is nothing to put a message on.'
      : text(prompt.hint);
    if (idle) note.classList.add('setup-field-note-error');
    row.appendChild(note);
    dialog.appendChild(row);

    const actions = document.createElement('div');
    actions.className = 'setup-actions';
    actions.appendChild(setupButton('btn-secondary workspace-finish-cancel', 'Cancel',
      () => modal.close(undefined)));

    // The alternative is the conversation's to carry out, so it is offered only
    // when there is one. Without it the field is the whole of the answer, which
    // is the shape this dialog was written for.
    if (prompt.alternative?.label && context.conversation) {
      const other = setupButton('btn-secondary workspace-finish-alternative',
        text(prompt.alternative.label), () => modal.close({ message: '' }));
      // What it does goes ON it, under its own label. It used to sit below the
      // whole row, where it read as a footnote to all three buttons — and the
      // button it explains is the one nobody presses without being told what it
      // will do.
      if (prompt.alternative.hint) {
        const aside = document.createElement('span');
        aside.className = 'workspace-finish-alternative-note';
        aside.textContent = text(prompt.alternative.hint);
        other.appendChild(aside);
      }
      actions.appendChild(other);
    }

    const submit = () => {
      const typed = field.value.trim();
      if (!typed || idle) return;
      modal.close({ message: typed });
    };
    // The act, not the sentence: the ending's own label names a row in a menu
    // beside other rows, and this is a button in a row of buttons.
    const commit = setupButton('btn-primary workspace-finish-commit',
      text(prompt.confirmLabel) || text(option?.label) || 'Continue', submit);
    actions.appendChild(commit);
    dialog.appendChild(actions);

    /** The primary is pressable only when the field holds what it asked for. */
    const sync = () => { commit.disabled = idle || field.value.trim() === ''; };
    field.addEventListener('input', sync);
    sync();

    // A field that takes several lines must let Enter make one, so the keyboard
    // way out is the one every multi-line box in the app uses.
    field.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'Enter') return;
      if (prompt.multiline && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      submit();
    });

    field.focus();
  });
}

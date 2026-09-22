//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a conversation that has already started should work instead.
 *
 * A move, not the question of where to make a workspace. That one is asked by
 * the dialog the tab strip opens, about nothing in particular; this one is about
 * a conversation that is working somewhere, and what it needs said is where that is, what is still in
 * there, and what leaving would cost. It is a dialog rather than a block in the
 * transcript because by then the transcript belongs to the work: a conversation
 * half way through a task is not a conversation with a question at the top of it.
 *
 * It shares the panel's list of places and the panel's rendering of a provider's
 * form — same rows, same look, learned once — and shares none of its state. The
 * setup record is what an *uninitialised* conversation has been told, and the
 * send path reads it: a conversation moving house is already working somewhere
 * and must go on sending while a second tree is built for it, where borrowing
 * that record would close its composer until the build finished. So this holds
 * its own selection, its own form values and its own progress, and calls
 * `provisionWorkspace` directly.
 *
 * Nothing is selected when it opens. The panel defaults to the project because a
 * conversation that answers nothing must still be bound to something; here,
 * answering nothing must move nothing.
 * @module components/workspace-move-dialog
 */

import { presentModal } from '../utils/modal-surface.js';
import {
  NEW_ROW_PREFIX,
  setupRows,
  cachedSetupStatus,
  probeSetupStatuses,
  probeSetupAdoptions,
  adoptSetupRow
} from '../services/workspace-places.js';
import { provisionWorkspace, provisionLeftBehind, recordProgress } from '../services/workspace-provisioning.js';
import {
  rebindConversation,
  workspaceHeldWork,
  workspaceWorkList
} from '../services/workspace-rebinding.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { createFileActions } from '../utils/properties-panel-helpers.js';
import {
  setupButton,
  buildProviderFields,
  buildPlaceRows,
  handlePlaceRowKey,
  buildProvisionProgress
} from './workspace-setup-form.js';

/**
 * The places this conversation could move to: every place there is, less the
 * one it is already in. A row for where you are is not a
 * choice.
 *
 * Exported because whoever offers the move has to know whether there is one:
 * a menu row leading to a dialog with nothing in it is worse than no row.
 * @param {any} conversation - The conversation that would move.
 * @returns {any[]} The rows.
 */
export function workspaceMovePlaces(conversation) {
  const currentId = conversation?.workspaceId || '';
  return setupRows(conversation?.session).filter((row) =>
    !((row.kind === 'project' || row.kind === 'workspace') && row.id === currentId));
}

/**
 * Ask where this conversation should work, and move it there.
 * @param {any} conversation - The conversation to move.
 * @param {object} [options] - How it opens.
 * @param {string} [options.selected] - A place already chosen: a workspace id,
 *   or `''` for the project folder. For a caller that is asking about a place
 *   the user has already pointed at — a tab dropped in another workspace's box
 *   — so the dialog is a confirmation rather than the same question again.
 *   Ignored when it names nowhere this conversation could go.
 * @returns {Promise<{moved: boolean, workspaceId?: string}>} Where it went, if it went.
 */
export function openWorkspaceMove(conversation, { selected } = {}) {
  const session = conversation?.session;
  const currentId = conversation?.workspaceId || '';

  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'workspace-move-overlay',
      dismissSelectors: ['.workspace-move-backdrop', '.workspace-move-close', '.workspace-move-cancel'],
      onClose: (result) => {
        probes.abort();
        // Escape and the backdrop end a build the same way its own Cancel does.
        // The alternative is a tree finished after the question that asked for
        // it was dismissed, with nobody moving into it.
        stop?.abort();
        resolve(result ?? { moved: false });
      }
    });
    const root = modal.root;

    // Speculative, and abandoned with the dialog: statuses for rows nobody has
    // chosen are what make choosing one an informed act, and a dialog closed a
    // moment later has no further interest in the answers.
    const probes = new AbortController();

    /** @type {string|null} Which place is chosen; null until one is, or until the caller says. */
    let selection = null;
    /** @type {string} Why the last attempt did not happen. */
    let error = '';
    /** @type {object} What the selected provider's form last said. */
    let values = {};
    /** @type {boolean} Whether that form may be submitted. */
    let valid = false;
    /** @type {boolean} Whether a workspace is being built right now. */
    let building = false;
    /** @type {{step: string, detail?: string}[]} What that build has announced. */
    let progress = [];
    /** @type {AbortController|null} How to stop it, for as long as it runs. */
    let stop = null;
    /** @type {any} What the tree being left still holds, once that is known. */
    let held = null;
    /** @type {boolean} Whether to bring that work along. */
    let carrying = false;
    /** @type {string[]} What the last attempt would not write over. */
    let conflicts = [];

    /**
     * The places this conversation could move to. See {@link workspaceMovePlaces}.
     * @returns {any[]} The rows.
     */
    const places = () => workspaceMovePlaces(conversation);

    // A caller that already has an answer starts on it. Checked against the
    // rows rather than taken on trust: a place that is not offered here cannot
    // be selected here, and a selection naming nothing would arm the button
    // over a row nobody can see.
    if (selected !== undefined && places().some((row) => row.id === selected)) selection = selected;

    /**
     * The provider a "New…" selection names, or '' for a place that exists.
     * @returns {string} A provider id, or ''.
     */
    const selectedProviderId = () => (selection ?? '').startsWith(NEW_ROW_PREFIX)
      ? /** @type {string} */ (selection).slice(NEW_ROW_PREFIX.length)
      : '';

    /**
     * Build what the selected "New…" row describes.
     *
     * `provisionWorkspace` owns everything difficult about this — the row
     * registered before the first command, each step's inverse recorded before
     * the step, the unwinding of a failure or a cancel. Nothing here touches
     * `ensureInitialised`: this conversation was initialised long ago, and what
     * it needs is somewhere to work, not seeding.
     * @param {string} providerId - Whose form was filled in.
     * @returns {Promise<string>} The new workspace's id, or '' if there is none.
     */
    const build = async (providerId) => {
      // Taken before anything is drawn: a form rebuilt by the redraw below
      // reports itself empty, and these are the values that were filled in.
      const chosen = values;
      const controller = new AbortController();
      building = true;
      stop = controller;
      progress = [];
      error = '';
      render();
      try {
        const outcome = await provisionWorkspace({
          session,
          conversation,
          providerId,
          values: chosen,
          signal: controller.signal,
          onProgress: (step, detail) => {
            recordProgress(progress, step, detail);
            render();
          }
        });
        building = false;
        stop = null;

        // Onto this window's table by hand. The row is the server's the moment
        // it is registered, but a client learns of it through the
        // `workspaces-changed` broadcast — and the move about to happen is
        // refused for a workspace this session cannot resolve, so waiting for
        // the announcement of something we just built would refuse it for being
        // too new. The broadcast will bring it again, harmlessly.
        if (session && !session.workspaces?.some?.((/** @type {any} */ row) => row.id === outcome.workspace.id)) {
          session.workspaces = [...(session.workspaces ?? []), outcome.workspace];
        }

        // Chosen, so that a refusal on the way in is one press from being tried
        // again rather than a second tree.
        selection = outcome.workspace.id;
        return outcome.workspace.id;
      } catch (failure) {
        building = false;
        stop = null;
        // Cancelled and failed are the same unwinding and different things to
        // say. A cancel was the user's own instruction and needs no explanation
        // on screen; a failure is the only account they will get of why there is
        // nowhere new to move to, so it is kept and shown against the form they
        // can correct.
        values = chosen;
        // Except for what the unwinding could not take back, which is said
        // whichever of the two it was: a cancel that left a tree on the disk is
        // still a tree on the disk.
        const leftBehind = provisionLeftBehind(failure);
        const said = controller.signal.aborted ? '' : extractErrorMessage(failure);
        error = [said, leftBehind].filter(Boolean).join(' ');
        render();
        return '';
      }
    };

    /**
     * Move, or say why not. A refusal — a turn in flight, a target that cannot
     * be worked in, work the move will not write over — is shown here rather
     * than in a dialog over this one, and leaves the choice on screen to make
     * again.
     *
     * The work is listed here rather than when the dialog opened, because the
     * list is the expensive question and most moves never ask it. What is on
     * screen by then is the count, which is cheap and comes from the same tree.
     * @param {boolean} [overwrite] - Whether this is the second, deliberate press.
     * @returns {Promise<void>} When it has moved, or has not.
     */
    const commit = async (overwrite = false) => {
      if (selection === null || building) return;

      try {
        /** @type {any} */
        let carry = null;
        if (carrying && held?.listable) {
          const work = await workspaceWorkList(session, currentId, probes.signal);
          if (modal.closed) return;
          if (!work.complete) {
            error = `Couldn't bring the work: what ${held.where} holds could not be listed. Nothing was copied.`;
            conflicts = [];
            render();
            return;
          }
          carry = { paths: work.paths, removed: work.removed, overwrite };
        }

        const providerId = selectedProviderId();
        const target = providerId ? await build(providerId) : selection;
        if (!target && providerId) return;
        if (modal.closed) return;

        const result = await rebindConversation(conversation, target, carry ? { carry } : {});
        if (result.done) {
          modal.close({ moved: true, workspaceId: target });
          return;
        }
        error = result.message || `Couldn't move the conversation.`;
        conflicts = result.conflicts ?? [];
        render();
      } catch (failure) {
        // The press is answered whatever happens. Every refusal below is phrased
        // to be shown here, but a throw nobody expected would leave the dialog
        // as it was — a button that did nothing, which is the one thing it must
        // never be.
        if (modal.closed) return;
        error = extractErrorMessage(failure);
        conflicts = [];
        render();
      }
    };

    /**
     * Take up an offer: register something that already exists, then choose it.
     * @param {any} row - The adopt row that was clicked.
     * @returns {Promise<void>} When it is registered, or has failed to be.
     */
    const adopt = async (row) => {
      const adopted = await adoptSetupRow(session, row.id);
      if (adopted?.id) selection = adopted.id;
      render();
    };

    /** Draw the dialog as it stands. */
    const render = () => {
      if (modal.closed) return;
      root.replaceChildren();

      // The chrome every other dialog in the app wears: the shared scrim, and a
      // panel whose surface, corner and shadow come from the one popup-surface
      // rule. A modal that paints its own card is a modal that drifts from the
      // rest of them one token at a time.
      const backdrop = document.createElement('modal-backdrop');
      backdrop.className = 'workspace-move-backdrop';
      root.appendChild(backdrop);

      const dialog = document.createElement('modal-panel');
      dialog.className = 'workspace-move-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', 'Move this conversation');
      root.appendChild(dialog);

      const header = document.createElement('div');
      header.className = 'workspace-move-header';
      const title = document.createElement('h2');
      title.className = 'workspace-move-title';
      // What pressing on will do. This conversation is somewhere already, and
      // everything below is about leaving it.
      title.textContent = 'Move this conversation';
      header.appendChild(title);
      const close = setupButton('close-button workspace-move-close', '', () => modal.close(undefined));
      close.setAttribute('aria-label', 'Close');
      close.title = 'Close';
      const cross = document.createElement('span');
      cross.className = 'icon-close';
      close.appendChild(cross);
      header.appendChild(close);
      dialog.appendChild(header);

      // Everything between the header and the buttons, in one scrolling column,
      // so a long list of places runs under the title and above the footer
      // rather than carrying them off the screen with it.
      const body = document.createElement('div');
      body.className = 'workspace-move-body';
      dialog.appendChild(body);

      // Where it works now is a standing fact, so it is stated rather than
      // offered: it is not among the rows below. It is set as the rows are —
      // name, then address beneath it — because it is the thing they are all
      // alternatives to, and a reader comparing it with them should not have to
      // translate between two ways of writing down a place.
      const current = currentId ? session?.getWorkspace?.(currentId) : null;
      const now = document.createElement('div');
      now.className = 'workspace-move-now';
      const lead = document.createElement('div');
      lead.className = 'workspace-move-now-lead';
      lead.textContent = 'Working in';
      now.appendChild(lead);
      const named = document.createElement('div');
      named.className = 'workspace-move-now-label';
      named.textContent = current ? (current.label || current.root) : 'The project folder';
      now.appendChild(named);
      // The address, whole and on its own line. It is the one part of this that
      // a reader may want out of the dialog rather than in it — into a terminal,
      // or open in a file manager beside it — so it is offered as a path, with
      // the two things you can do with one, and not as the tail of a sentence.
      // Pinning is not among them: this is a modal, and a pin put on the board
      // behind one is a thing that happened out of sight.
      const where = document.createElement('div');
      where.className = 'workspace-move-now-path-row';
      const tree = current?.root || session?.projectPath || '';
      const box = document.createElement('div');
      box.className = 'workspace-move-now-path';
      box.textContent = tree;
      if (tree) box.dataset.filePath = tree;
      where.appendChild(box);
      const onPath = createFileActions(tree, { directory: true });
      if (onPath) where.appendChild(onPath);
      now.appendChild(where);
      body.appendChild(now);

      // What the tree being left still holds, and the one decision to make about
      // it. The offer is only made where the work can be listed file by file; a
      // tree that holds work nobody can enumerate gets the sentence it always
      // got, which says the work stays where it is and promises nothing.
      if (held?.dirty) {
        const work = document.createElement('div');
        work.className = 'workspace-move-work';
        const lead = document.createElement('div');
        lead.className = 'workspace-move-work-lead';
        lead.textContent = held.listable
          ? `${held.where} holds uncommitted work in ${held.files} file${held.files === 1 ? '' : 's'}.`
          : held.warning;
        work.appendChild(lead);

        if (held.listable) {
          const choice = document.createElement('label');
          choice.className = 'workspace-move-carry';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'workspace-move-carry-box';
          box.checked = carrying;
          // Nothing redraws for a tick: it decides what the button does, not
          // what the dialog looks like.
          box.addEventListener('change', () => { carrying = box.checked; });
          choice.appendChild(box);
          const says = document.createElement('span');
          says.textContent = 'Copy it into the workspace you move to';
          choice.appendChild(says);
          work.appendChild(choice);
        }
        body.appendChild(work);
      }

      // While something is being built there is nothing to choose: the choice
      // has been made, and what is worth showing is what it is waiting on and
      // the way out of it. One Cancel, inside the progress, so there are never
      // two of them meaning different things.
      if (building) {
        body.appendChild(buildProvisionProgress(progress, () => stop?.abort()));
        return;
      }

      // The heading and the list it names are one section, so that the space
      // between them stays smaller than the space around them.
      const section = document.createElement('div');
      section.className = 'workspace-move-places';
      body.appendChild(section);

      const heading = document.createElement('div');
      heading.className = 'setup-section-title';
      heading.textContent = 'Move it to';
      section.appendChild(heading);

      const rows = buildPlaceRows({
        rows: places(),
        selection,
        label: 'Where to move this conversation',
        statusFor: cachedSetupStatus,
        onSelect: (row) => {
          selection = row.id;
          values = {};
          valid = false;
          error = '';
          // A refusal belonged to the place it was refused for. Somewhere else
          // is a fresh question, and the danger button must not survive into it.
          conflicts = [];
          render();
        },
        onAdopt: (row) => { void adopt(row); },
        expandSelected: (row) => {
          const fields = buildProviderFields({
            session,
            conversation,
            providerId: row.providerId,
            values,
            onValue: (value) => {
              values = value?.values ?? {};
              valid = value?.valid !== false;
              // Nothing redraws for a keystroke, so the one thing that has to
              // react is updated in place.
              const commitButton = /** @type {HTMLButtonElement|null} */ (root.querySelector('.workspace-move-commit'));
              if (commitButton) commitButton.disabled = !valid;
            }
          });
          // The same wrapper the panel gives a form, which is both how it is
          // styled and how `renderIfIdle` knows there is one open to protect.
          const expanded = document.createElement('div');
          expanded.className = 'setup-row-body';
          expanded.appendChild(fields.element);
          return expanded;
        },
        // Blocks rather than lines: this is the whole question the dialog exists
        // to ask, and a place is chosen by reading what it means
        // and where it is, neither of which fits on the end of a line.
        asBlocks: true
      });
      rows.addEventListener('keydown', (event) => handlePlaceRowKey(event, root));
      section.appendChild(rows);

      if (error) {
        const failure = document.createElement('div');
        failure.className = 'setup-error';
        failure.textContent = error;
        // The way past a refusal, for someone who has read which files it is
        // about. It is here rather than beside Move because it belongs to the
        // sentence above it, and because it is not the thing to press by habit.
        if (conflicts.length) {
          failure.appendChild(setupButton('btn-danger workspace-move-overwrite',
            'Copy over them', () => { void commit(true); }));
        }
        body.appendChild(failure);
      }

      const actions = document.createElement('div');
      actions.className = 'workspace-move-footer';
      actions.appendChild(setupButton('btn-secondary workspace-move-cancel', 'Cancel',
        () => modal.close(undefined)));
      // The button says what pressing it will do, which for a place that does
      // not exist yet is two things.
      const making = selectedProviderId() !== '';
      const move = setupButton('btn-primary workspace-move-commit',
        building ? 'Creating…' : making ? 'Create and move' : 'Move',
        () => { void commit(); });
      move.disabled = building || selection === null || (making && !valid);
      actions.appendChild(move);
      dialog.appendChild(actions);
    };

    render();
    // The row the keyboard starts on is the chosen one where there is one, so
    // that a dialog opened on an answer opens with that answer under the hands.
    const first = root.querySelector('.setup-row[aria-checked="true"]') || root.querySelector('.setup-row');
    /** @type {HTMLElement|null} */ (first)?.focus();

    /**
     * Redraw for something that arrived on its own, unless a form is open.
     *
     * A form being filled in outranks the rows behind it: rebuilding the dialog
     * around it would take the focus out of the field mid-word and throw away
     * what had been typed. A row that arrived meanwhile appears when the form
     * closes, which is a change of selection and so a redraw in its own right.
     */
    const renderIfIdle = () => {
      if (root.querySelector('.setup-row-body')) return;
      render();
    };

    // All three probes redraw when they settle: a row that arrives, a branch a
    // provider took a round trip to find out, or the work the tree being left
    // turns out to be holding, is worth showing the moment it is known.
    void probeSetupStatuses(session, probes.signal).then(renderIfIdle, () => {});
    void probeSetupAdoptions(session, probes.signal).then(renderIfIdle, () => {});
    void workspaceHeldWork(session, currentId, probes.signal).then((answer) => {
      held = answer;
      renderIfIdle();
    }, () => {});
  });
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The question a new conversation is asked before it starts: where it works.
 *
 * A card in the welcome slot at the foot of an uninitialised conversation's
 * transcript — the space the starting hint occupies on a conversation with
 * nothing to ask, which is where somebody about to type is already looking. It
 * carries that hint's four lines below its own, and is gone the moment the
 * conversation initialises. It renders an ordered list of **sections** — today
 * exactly one, the workspace — because model, strategy and prompt-preset
 * sections are the obvious next inhabitants and the panel should not have to be
 * reshaped to take them. There is deliberately no section *registry*: what
 * extensions contribute is workspace options, through `WorkspaceProvider`, and a
 * registry with one core-internal user would be five wiring points paying for
 * nothing.
 *
 * The panel owns no state. Everything it shows and everything a click does lives
 * in {@link module:services/conversation-setup}, so what is on screen and what a
 * test drives are the same thing.
 * @module components/conversation-setup-panel
 */

import {
  setupButton as button,
  buildProviderFields,
  buildPlaceRows,
  handlePlaceRowKey,
  buildProvisionProgress
} from './workspace-setup-form.js';
import { emptyHintStackMarkup } from './empty-hint-stack.js';
import {
  setupRows,
  getSetupState,
  cachedSetupStatus,
  selectSetupRow,
  setSetupValues,
  createSelectedWorkspace,
  cancelSetupProvision,
  subscribeSetup,
  probeSetupStatuses,
  probeSetupAdoptions,
  adoptSetupRow
} from '../services/conversation-setup.js';
import { listWorkspaces } from '../services/workspaces.js';

/** The element's tag, which is also how the item-diff knows to leave it alone. */
export const SETUP_PANEL_TAG = 'CONVERSATION-SETUP-PANEL';

/**
 * One part of the panel. The shape is fixed and documented rather than
 * registered: `render` fills the container it is handed, `getValue` says what
 * the conversation should be initialised with.
 * @typedef {object} SetupSection
 * @property {string} id - Which field of the commit patch it answers for
 * @property {number} order - Where it sits; lower is higher up
 * @property {string} title - What the section is called
 * @property {(panel: ConversationSetupPanel, body: HTMLElement) => void} render - Fill the body
 */

/**
 * The workspace section: pick somewhere that exists, or make somewhere new.
 * @type {SetupSection}
 */
const workspaceSection = {
  id: 'workspaceId',
  order: 10,
  // A question, because it is one, and because a heading reading WORKSPACE over
  // a list of paths is a label on something already decided. Answering is
  // optional — the first row is already chosen — so it asks plainly and once.
  title: 'Choose a workspace for this conversation',
  render(panel, body) {
    const conversation = panel.conversation;
    const state = getSetupState(conversation);

    if (state.phase === 'provisioning') {
      body.appendChild(panel.buildProgress(state));
      return;
    }

    const rows = buildPlaceRows({
      rows: setupRows(conversation.session),
      selection: state.selection,
      label: 'Workspace',
      statusFor: cachedSetupStatus,
      onSelect: (row) => selectSetupRow(conversation, row.id),
      onAdopt: (row) => { void panel.adopt(row.id); },
      expandSelected: (row) => panel.buildProviderForm(row.providerId)
    });
    rows.addEventListener('keydown', (event) => panel.handleRowKey(event));
    body.appendChild(rows);

    if (state.error) {
      const failure = document.createElement('div');
      failure.className = 'setup-error';
      failure.textContent = state.error;
      body.appendChild(failure);
    }
  }
};

/** @type {SetupSection[]} The panel's sections, in order. */
const SECTIONS = [workspaceSection];

/**
 * ConversationSetupPanel - the setup block at the top of a new conversation.
 */
class ConversationSetupPanel extends HTMLElement {
  constructor() {
    super();

    /** @type {any} The conversation being set up. */
    this._conversation = null;

    /** @type {string} The flow's own state as last rendered: phase, selection, error, progress. */
    this._shape = '';

    /** @type {string} The rows as last rendered, which a redraw only follows while no form is open. */
    this._listing = '';

    /** @type {(() => void)|null} How to stop watching the state it draws. */
    this._unsubscribe = null;

    /** @type {number} The last refused send it has answered for. */
    this._attentionSeq = 0;

    /** @type {AbortController|null} The speculative asking done while it is open. */
    this._sweep = null;

    /** @type {(() => void)|null} How to stop watching the table it offers rows from. */
    this._unwatchSession = null;
  }

  /**
   * Watch the state this panel is a view of, for as long as it is on screen.
   */
  connectedCallback() {
    this._unsubscribe ??= subscribeSetup((conversationId) => {
      if (!conversationId || conversationId === this._conversation?.id) {
        this.render();
        this.pointAtWhatIsMissing();
      }
    });
    this.watchSession();
    this.sweep();
  }

  /**
   * Stop watching, and abandon anything still being asked on its behalf.
   */
  disconnectedCallback() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unwatchSession?.();
    this._unwatchSession = null;
    this._sweep?.abort();
    this._sweep = null;
  }

  /**
   * Redraw when the table moves under it.
   *
   * The rows are a view of `session.workspaces`, which is replaced whole by
   * every `workspaces-changed` broadcast — so a workspace another window made,
   * or an availability the server re-checked as this panel opened, arrives as
   * one of these and not as a change of setup state. Without it the panel shows
   * the table as it stood when it was first drawn.
   */
  watchSession() {
    this._unwatchSession?.();
    this._unwatchSession = /** @type {(() => void)|null} */ (
      this._conversation?.session?.subscribe((/** @type {any} */ event) => {
        if (event?.type === 'session:workspaces-changed') this.render();
      }) || null);
  }

  /**
   * Ask, as the panel opens, about every place it could offer: whether each one
   * is still there, how it is doing, and what exists that has no workspace at
   * all.
   *
   * The first of those is a plain list call, and it is here for its side effect:
   * listing re-stats every root, so a tree removed since this window last heard
   * about the table stops being offered as somewhere to work. It arrives back as
   * a `workspaces-changed` broadcast rather than being applied here.
   *
   * The rest rides one signal, aborted when the panel goes, because they are
   * speculative — questions asked about rows nobody has selected, which a panel
   * closed a moment later has no further interest in.
   */
  sweep() {
    const session = this._conversation?.session;
    if (!session || !this.isConnected || this._sweep) return;
    this._sweep = new AbortController();
    void listWorkspaces().catch(() => {
      // Losing the re-stat costs freshness, not correctness: the rows are
      // still the table as this window last heard it. Nothing to say.
    });
    void probeSetupStatuses(session, this._sweep.signal);
    void probeSetupAdoptions(session, this._sweep.signal);
  }

  /**
   * Register something that already exists, and select it — the click has to do
   * something visible, and what it did was make that row bindable.
   * @param {string} rowId - The offer that was clicked.
   * @returns {Promise<void>} When it is registered, or has failed to be.
   */
  async adopt(rowId) {
    const conversation = this._conversation;
    const adopted = await adoptSetupRow(conversation?.session, rowId);
    if (adopted?.id) selectSetupRow(conversation, adopted.id);
  }

  /**
   * @returns {any} The conversation being set up.
   */
  get conversation() {
    return this._conversation;
  }

  /**
   * @param {any} conversation - The conversation being set up.
   */
  set conversation(conversation) {
    if (this._conversation === conversation) return;
    this._conversation = conversation;
    this._shape = '';
    this._listing = '';
    // A different conversation may be a different session; whatever the last one
    // was being asked is no longer of any interest.
    this._sweep?.abort();
    this._sweep = null;
    this.watchSession();
    this.render();
    this.sweep();
  }

  /**
   * Redraw, unless nothing that shows has moved.
   *
   * The guard is not an optimisation. A form being typed into is inside this
   * element, and rebuilding the panel around it would take the focus out of the
   * field mid-word — so the panel redraws for the things that change its shape
   * (the selection, the phase, a progress line, an error, the rows themselves)
   * and holds still for a keystroke, which is the form's own business.
   */
  render() {
    const conversation = this._conversation;
    if (!conversation) return;
    const state = getSetupState(conversation);
    const rows = setupRows(conversation.session);
    const shape = [state.phase, state.selection, state.error, state.progress.length].join('\u0000');
    const listing = rows
      .map(row => `${row.id}\u0001${row.label}\u0001${cachedSetupStatus(row.id)?.detail ?? row.detail ?? ''}`)
      .join('\u0002');

    // A form being filled in outranks the rows behind it. The speculative sweep
    // answers while the panel is open — a status for a row nobody selected, a
    // tree that turns out to have no workspace — and redrawing for that would
    // rebuild the expanded form, taking with it both the focus and whatever had
    // been typed into it. So while a form is open only the flow's own shape
    // redraws; a row that arrived meanwhile appears when the form closes, which
    // is a change of selection and so a redraw in its own right.
    //
    // The two are remembered separately rather than as one string: a signature
    // that changes SHAPE when a form opens differs from the last one for that
    // reason alone, and would rebuild the very form the guard exists to protect.
    const formOpen = this.querySelector('.setup-row-body') !== null;
    const moved = shape !== this._shape || (!formOpen && listing !== this._listing);
    this._shape = shape;
    this._listing = listing;
    if (!moved) return;

    this.replaceChildren();
    const card = document.createElement('div');
    card.className = 'setup-card';
    this.appendChild(card);
    for (const section of [...SECTIONS].sort((a, b) => a.order - b.order)) {
      const block = document.createElement('div');
      block.className = `setup-section setup-section-${section.id}`;

      const title = document.createElement('div');
      title.className = 'setup-section-title';
      title.textContent = section.title;
      block.appendChild(title);

      const body = document.createElement('div');
      body.className = 'setup-section-body';
      section.render(this, body);
      block.appendChild(body);

      card.appendChild(block);
    }

    // The instructions for the composer, which this card is standing in front
    // of. They are the same four lines a conversation with nothing to ask floats
    // over its empty background — the overlay stands down while the card is up
    // (see ConversationArea._updateEmptyHint), so they are said exactly once.
    const hint = document.createElement('div');
    hint.className = 'setup-hint';
    hint.innerHTML = emptyHintStackMarkup();
    this.appendChild(hint);
  }

  /**
   * Point at whatever turned a send away: the field that is not filled in, or
   * the Create button that has not been pressed.
   *
   * The user typed a message and pressed Enter, so this has to read as *finish
   * this first* — it moves the focus to the thing that is missing and marks it
   * for a moment, and says nothing else. The warning beside it is the send's.
   */
  pointAtWhatIsMissing() {
    const state = getSetupState(this._conversation);
    if (state.attentionSeq === this._attentionSeq) return;
    this._attentionSeq = state.attentionSeq;

    const target = /** @type {HTMLElement|null} */ (
      (state.invalidFieldId && this.querySelector(`#${CSS.escape(state.invalidFieldId)}`))
      || this.querySelector('.setup-create'));
    if (!target) return;
    target.focus();
    target.classList.add('setup-attention');
    setTimeout(() => target.classList.remove('setup-attention'), 1200);
  }

  /**
   * The expanded body of a "New…" row: the provider's own fields, and the
   * button that is the only thing in the panel that builds anything.
   * @param {string} providerId - Whose form this is.
   * @returns {HTMLElement} The form.
   */
  buildProviderForm(providerId) {
    const conversation = this._conversation;
    const form = document.createElement('div');
    form.className = 'setup-row-body';

    const create = /** @type {HTMLButtonElement} */ (button('setup-create', 'Create', () => {
      setSetupValues(conversation, fields.getValue());
      if (getSetupState(conversation).valid) createSelectedWorkspace(conversation);
    }));

    // The form reports itself on every edit. Nothing redraws in response — the
    // state module stays quiet for exactly this reason — so the one thing that
    // has to react, the Create button, is updated here.
    const fields = buildProviderFields({
      session: conversation.session,
      conversation,
      providerId,
      values: getSetupState(conversation).values,
      onValue: (value) => {
        setSetupValues(conversation, value);
        create.disabled = value.valid === false;
      }
    });
    if (!fields.provider) create.disabled = true;
    form.appendChild(fields.element);

    const actions = document.createElement('div');
    actions.className = 'setup-actions';
    actions.appendChild(create);
    form.appendChild(actions);

    return form;
  }

  /**
   * What is happening, while it happens: one line per step, and the Cancel that
   * is available for the whole of it.
   * @param {import('../services/conversation-setup.js').SetupState} state - The running provision.
   * @returns {HTMLElement} The progress view.
   */
  buildProgress(state) {
    const conversation = this._conversation;
    return buildProvisionProgress(state.progress, () => cancelSetupProvision(conversation));
  }

  /**
   * Arrow keys move between rows and select as they go; Enter and Space select
   * the row that has focus. The panel is reachable by Tab — never by having
   * taken the focus, which belongs to the composer.
   * @param {KeyboardEvent} event - The key.
   */
  handleRowKey(event) {
    handlePlaceRowKey(event, this);
  }
}

customElements.define('conversation-setup-panel', ConversationSetupPanel);

export default ConversationSetupPanel;

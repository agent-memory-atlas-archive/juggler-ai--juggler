//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where this conversation works, in the composer's control row.
 *
 * It sits to the left of the strategy and the model because it is the outermost
 * of the three: those two decide how a turn is run and who runs it, and this one
 * decides which files they are run against. A conversation working in the
 * project — every conversation, before any of this existed — shows nothing at
 * all.
 *
 * What it shows is the workspace's **state**: the branch it is on and whether it
 * is holding uncommitted work. Its *identity* — the label and the tree — is said
 * once, at the top of the transcript, by the banner. That split is why both earn
 * their place: one is a standing fact about the conversation, the other changes
 * under you while you work.
 *
 * It appears when there is something to say: a conversation bound to a workspace
 * always, and one working in the project only once somewhere else exists to work
 * — which is also the moment it has something to offer. A user who has never
 * made a workspace has a composer identical to the one before any of this
 * existed, and the project chip shows no branch or dirty state of its own: the
 * project's tree has the git surfaces, the pins and every other conversation
 * looking at it, which is precisely what a workspace elsewhere has not got.
 *
 * Opening it is how a conversation changes its mind. The move itself belongs to
 * {@link module:components/workspace-move-dialog}, which is a dialog rather than
 * a menu because choosing may mean filling in a form and waiting for a tree to
 * be built — and to a conversation already under way the transcript belongs to
 * the work, not to a question.
 * @module components/workspace-chip
 */

import { presentInlineMenu } from '../utils/popup-surface.js';
import {
  workspaceStatus,
  workspaceKind,
  workspaceFinishOptions,
  workspaceFinishWarning,
  finishWorkspace
} from '../services/workspace-provisioning.js';
import { isWorkspaceUsable } from '../services/workspaces.js';
import { createFileActions } from '../utils/properties-panel-helpers.js';
import { showConfirm, showNotice } from './modal-dialog.js';
import { openWorkspaceFinish } from './workspace-finish-dialog.js';
import { openWorkspaceMove } from './workspace-move-dialog.js';

/**
 * WorkspaceChip - the composer's statement of where this conversation works.
 */
class WorkspaceChip extends HTMLElement {
  constructor() {
    super();

    /** @type {any} The conversation this chip is about. */
    this._conversation = null;

    /** @type {any} What its provider last said about the workspace. */
    this._status = null;

    /** @type {boolean} Whether the menu is open. */
    this._open = false;

    /** @type {import('../utils/popup-surface.js').InlineMenu|null} */
    this._menu = null;

    /** @type {AbortController|null} The status read in flight, if there is one. */
    this._probe = null;

    /** @type {number} Which row the keyboard is on, or -1 for none of them. */
    this._cursor = -1;

    /** @type {((event: KeyboardEvent) => void)|null} The key handler, while the menu is open. */
    this._keys = null;

    /** @type {(() => void)|null} How to stop watching the workspace table. */
    this._unsubscribeSession = null;

    /** @type {((event: any) => void)|null} The conversation's metadata observer. */
    this._metadataObserver = null;
  }

  /**
   * Watch the two things that can change what this shows without anything in
   * the composer moving: the workspace table (a peer finishing with the
   * workspace, a root going missing) and the conversation's own binding.
   */
  connectedCallback() {
    this._watchSession();
  }

  /**
   * Let go of everything: the menu, the table, the binding, the probe.
   */
  disconnectedCallback() {
    this.closeMenu();
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
    this._unwatchConversation();
    this._probe?.abort();
    this._probe = null;
  }

  /**
   * Tell the chip which conversation it is about. Called by the composer for
   * every conversation it is pointed at, bound or not.
   * @param {any} conversation - The conversation, or null.
   */
  setConversation(conversation) {
    if (this._conversation === conversation) return;
    this._unwatchConversation();
    this._conversation = conversation;
    this._status = null;
    this.closeMenu();

    if (conversation) {
      this._metadataObserver = (/** @type {any} */ event) => {
        const keys = event?.keysChanged;
        // The binding is the only metadata this shows, and it moves when a
        // provision commits and when its undo takes it back again.
        if (keys?.has?.('workspaceId')) this._refresh();
      };
      conversation.observeMetadata(this._metadataObserver);
    }
    this._watchSession();
    this._refresh();
  }

  /**
   * The workspace this conversation works in, and only when it can be worked in.
   *
   * `workspaceRoot` makes the same four refusals the server makes, so the chip
   * appears exactly when an operation would be honoured. A binding that cannot
   * be honoured says nothing here: that state is the tombstone banner's, which
   * can also offer the rebind that fixes it.
   * @returns {any} The row, or null.
   */
  _workspace() {
    const conversation = this._conversation;
    const id = conversation?.workspaceId || '';
    if (!id || !conversation.workspaceRoot) return null;
    return conversation.session?.getWorkspace(id) ?? null;
  }

  /**
   * Whether this conversation works in the project rather than a workspace.
   * @returns {boolean} True for the binding every conversation starts with.
   */
  _inProject() {
    return !(this._conversation?.workspaceId || '');
  }

  /**
   * Whether there is anywhere else for this conversation to go.
   *
   * A registered workspace it is not already in. A provider that *could* build
   * one is deliberately not enough: an offer to make a first worktree is not
   * worth a permanent control in every composer, and the conversation that has
   * not started yet is asked outright by the setup panel.
   * @returns {boolean} True when the table holds somewhere else usable.
   */
  _elsewhere() {
    const here = this._conversation?.workspaceId || '';
    return (this._conversation?.session?.workspaces ?? []).some((/** @type {any} */ row) =>
      isWorkspaceUsable(row) && row.id !== here);
  }

  /**
   * Subscribe to the current conversation's session, dropping any earlier one.
   */
  _watchSession() {
    this._unsubscribeSession?.();
    this._unsubscribeSession = /** @type {(() => void)|null} */ (
      this._conversation?.session?.subscribe((/** @type {any} */ event) => {
        if (event?.type === 'session:workspaces-changed') this._refresh();
      }) || null);
  }

  /**
   * Stop watching the conversation this chip was about.
   */
  _unwatchConversation() {
    if (this._conversation && this._metadataObserver) {
      this._conversation.unobserveMetadata(this._metadataObserver);
    }
    this._metadataObserver = null;
  }

  /**
   * Redraw, and ask the provider how the workspace is doing.
   */
  _refresh() {
    this.render();
    void this.refreshStatus();
  }

  /**
   * Ask the workspace's provider how it is doing.
   *
   * Lazily, never on a timer: this is ambient information, and a chip polling
   * git every twenty seconds for every open window would be a cost nobody asked
   * for. It is read when the conversation changes, when the table moves, and
   * when the menu is opened — which is the moment someone is actually looking.
   * @returns {Promise<void>} When there is an answer, or it has been abandoned.
   */
  async refreshStatus() {
    const workspace = this._workspace();
    this._probe?.abort();
    this._probe = null;
    if (!workspace) return;

    const controller = new AbortController();
    this._probe = controller;
    const status = await workspaceStatus(this._conversation.session, workspace, controller.signal);
    // Both are worth asking: the answer may be to a question about a workspace
    // this chip has since stopped being about.
    if (controller.signal.aborted || this._workspace()?.id !== workspace.id) return;
    this._probe = null;
    this._status = status;
    this.render();
  }

  /**
   * What the button says: the branch when the provider named one, and the
   * workspace's own label until it has. A conversation in no workspace at all
   * says where it works instead, which is the project — the same place the setup
   * panel offers under that name.
   * @returns {string} The chip's text.
   */
  _label() {
    const workspace = this._workspace();
    if (!workspace) return 'Project';
    return this._status?.label || workspace.label || workspace.root || '';
  }

  render() {
    const workspace = this._workspace();
    // A binding that cannot be honoured says nothing here — that is the
    // tombstone banner's, which can explain it — and the project says nothing
    // until there is somewhere else it could be.
    if (!workspace && !(this._inProject() && this._elsewhere())) {
      this.closeMenu();
      this.replaceChildren();
      this.hidden = true;
      return;
    }
    this.hidden = false;

    const label = this._label();
    const dirty = this._status?.dirty === true;

    // While the menu is open it has been relocated to <body> and anchored to the
    // button, so a re-render must update that button in place rather than
    // replace it: recreating it detaches the node the menu positions against,
    // and the menu jumps to the corner of the window. Scoped to this instance —
    // a sub-thread column has a composer of its own, and a document-wide query
    // would find whichever chip happened to be open.
    const liveMenu = this._menu?.surface ?? null;
    const liveButton = /** @type {HTMLElement|null} */ (this.querySelector('.workspace-chip-button'));
    if (this._open && liveMenu && liveButton) {
      this._updateButton(liveButton, label, dirty);
      const menu = liveMenu.querySelector('menu');
      if (menu) {
        menu.replaceChildren(...this._menuItems());
        // The rows are new elements, so the keyboard cursor has to be put back
        // on the row it was on — a status arriving must not move it.
        this._setCursor(this._cursor);
      }
      return;
    }

    this.replaceChildren();

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-chip-button input-ctrl-btn';
    button.tabIndex = -1;
    button.setAttribute('aria-haspopup', 'menu');
    const icon = document.createElement('span');
    icon.className = `workspace-chip-icon ${workspace ? 'icon-git-branch' : 'icon-folder'}`;
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'workspace-chip-name';
    button.appendChild(name);
    this._updateButton(button, label, dirty);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu();
    });
    this.appendChild(button);

    if (this._open && !liveMenu) {
      const nav = document.createElement('nav');
      nav.className = 'dropdown-menu workspace-menu show';
      const menu = document.createElement('menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Workspace');
      menu.replaceChildren(...this._menuItems());
      nav.appendChild(menu);
      this.appendChild(nav);
    }
  }

  /**
   * Update the button without replacing it, so an open menu keeps a live anchor.
   * @param {HTMLElement} button - The existing button.
   * @param {string} label - What it says.
   * @param {boolean} dirty - Whether the tree holds uncommitted work.
   */
  _updateButton(button, label, dirty) {
    const name = button.querySelector('.workspace-chip-name');
    if (name) name.textContent = label;
    button.classList.toggle('open', this._open);
    button.classList.toggle('dirty', dirty);
    // The detail is the whole sentence; the button is one word of it, so the
    // rest lives where a pointer will find it — including the reason, when the
    // tree could not be asked and there is no sentence to give.
    button.title = [label, this._status?.detail, this._status?.problem]
      .filter(Boolean).join(' — ') || label;
    button.setAttribute('aria-label', `Workspace: ${label}`);
    button.setAttribute('aria-expanded', this._open ? 'true' : 'false');
  }

  /**
   * What the menu holds: where this conversation works, what kind of place that
   * is, how it is doing, and the ways out of it.
   *
   * It is read by someone who has just clicked a word they may not have chosen
   * themselves, so it names the thing it is about — a *workspace* — and then
   * says what kind of place that is, where it is, and how it is doing. A path
   * and a branch with no lead-in are data about something the reader has not
   * been told the name of.
   *
   * Every row below carries what pressing it will do, in the menu, where it is
   * read before the decision rather than after it. The dialog says it again at
   * the point of no return, which is not a duplication anybody has ever
   * complained about.
   * @returns {HTMLElement[]} The items, in order.
   */
  _menuItems() {
    const workspace = this._workspace();
    const session = this._conversation?.session;
    /** @type {HTMLElement[]} */
    const items = [];

    // The band: what this workspace is, where it is, and how it is doing. Those
    // are one statement, so they are one element — a list of rows that happens to
    // start with facts reads as a list of things to press.
    const header = document.createElement('li');
    header.className = 'workspace-menu-header';
    const lead = document.createElement('span');
    lead.className = 'workspace-menu-lead';
    lead.textContent = 'Workspace';
    header.appendChild(lead);

    // What kind of place it is, in the provider's own words; its manifest name
    // is the fallback, and the row's own label the last resort — a workspace
    // whose extension is gone has nobody left to name it.
    const kind = workspace
      ? (this._status?.kind || workspaceKind(session, workspace) || workspace.label || '')
      : 'The project folder — no separate workspace';
    const named = document.createElement('span');
    named.className = 'workspace-menu-kind';
    named.textContent = kind;
    header.appendChild(named);

    header.appendChild(this._pathRow(workspace ? workspace.root : (session?.projectPath ?? '')));

    // How it is doing, and — separately — why that could not be established: a
    // workspace that answered and one nobody could reach must never read alike.
    for (const line of workspace ? [this._status?.detail, this._status?.problem] : []) {
      if (!line) continue;
      const element = document.createElement('span');
      element.className = 'workspace-menu-detail';
      element.textContent = line;
      header.appendChild(element);
    }
    items.push(header);

    // Changing its mind: the one thing every conversation here can do, whether
    // it works in a workspace or in the project, and whether or not whatever
    // made this one is still installed.
    const move = this._row(
      'Use a different workspace…', 'workspace-menu-move',
      'The project folder, another workspace, or a new one. This conversation keeps its history; only where its files and commands happen changes.');
    move.addEventListener('click', () => {
      this.closeMenu();
      void openWorkspaceMove(this._conversation).then(() => this._refresh());
    });
    items.push(move);

    if (!workspace) return items;

    // A provider that is not loaded has nothing to offer, and the reason is said
    // rather than left as an empty menu: "this provider offers no endings" and
    // "the extension that knew how to end this is gone" are different things to
    // be told. Not repeated when the band has already said it.
    const { options, unavailableReason } = workspaceFinishOptions(this._conversation?.session, workspace);
    if (unavailableReason) {
      if (unavailableReason !== this._status?.problem) {
        const note = document.createElement('li');
        note.className = 'workspace-menu-detail workspace-menu-note';
        note.textContent = unavailableReason;
        items.push(note);
      }
      return items;
    }

    // Two groups, because they answer different questions. An action that leaves
    // the workspace in use belongs with the rest of working here; the endings
    // belong under a heading that says, before any label is read, that every one
    // of them is a way of not working here any more.
    for (const option of options.filter(candidate => candidate.keepsWorkspace)) {
      items.push(this._finishRow(option));
    }

    const endings = options.filter(option => !option.keepsWorkspace);
    if (endings.length) {
      const heading = document.createElement('li');
      heading.className = 'category-header workspace-menu-group';
      heading.textContent = 'When you’re done with this workspace';
      items.push(heading);
    }
    endings.forEach((option, index) => {
      // A destructive ending gets a gap above it, so that the row a slipped
      // click lands on is not the one that takes a workspace away. Only the
      // first of a run of them needs it; a provider whose endings are all
      // destructive is not made safer by ruling between them.
      if (option.danger && index > 0 && !endings[index - 1]?.danger) items.push(this._divider());
      items.push(this._finishRow(option));
    });
    return items;
  }

  /**
   * One thing a provider can do with this workspace, as a row.
   *
   * The ellipsis is the promise the rest of the app makes: a row that ends in one
   * asks for something before it does anything. An ending that only wants
   * agreeing to does not get one — a confirmation is not a question.
   * @param {any} option - What the provider offered.
   * @returns {HTMLElement} The row.
   */
  _finishRow(option) {
    const item = this._row(
      option.prompt ? `${option.label}…` : option.label,
      `workspace-menu-action${option.danger ? ' danger' : ''}`,
      option.description);
    item.dataset.action = option.id;
    item.addEventListener('click', () => { void this._finish(option); });
    return item;
  }

  /**
   * Where the work happens, written out in full, with the things one does with a
   * path: copy it, show it on disk, put it on the board.
   *
   * Whole, because no rule about which part of a path matters survives contact
   * with the paths providers actually make. A scratch copy's root ends in the
   * same `work` directory for every copy ever taken, and the segment that says
   * which copy this is sits above it — so emphasising the last segment and
   * eliding the rest showed the one word that is identical everywhere and hid the
   * only one that is not. It wraps rather than clips for the same reason: a path
   * a reader has to hover to finish is a path they were not shown.
   *
   * The buttons are the shared ones, so a workspace root offers what every other
   * path in the app offers. They answer the pointer only: this menu never takes
   * focus — it is anchored to a composer nobody wants to be typing out of — and
   * its arrow keys walk the rows that do something to the workspace, which these
   * do not.
   * @param {string} path - Where the work happens.
   * @returns {HTMLElement} The row.
   */
  _pathRow(path) {
    const row = document.createElement('div');
    row.className = 'workspace-menu-path-row';

    const box = document.createElement('div');
    box.className = 'workspace-menu-path properties-panel-filepath-box';
    box.textContent = path;
    // The same hook the right-click Open / Reveal / Copy menu reads elsewhere,
    // so the path behaves like a path wherever it is met.
    if (path) box.dataset.filePath = path;
    row.appendChild(box);

    const actions = createFileActions(path, { pin: path, directory: true });
    if (actions) row.appendChild(actions);
    return row;
  }

  /**
   * A row that does something: what it is called, and what will happen.
   *
   * The second line is not decoration and is not a tooltip. Every row here
   * changes where a conversation's work happens or ends a place it was happening
   * in, and a label alone cannot carry that — "Stop using this workspace" does
   * not say that nothing is deleted, and nothing a pointer has to hover to find
   * is going to be read by someone deciding whether it is safe to press.
   * @param {string} text - What it says.
   * @param {string} className - What kind of row it is.
   * @param {string} [note] - What happens if it is pressed.
   * @returns {HTMLElement} The row, without its click handler.
   */
  _row(text, className, note = '') {
    const item = document.createElement('li');
    item.className = `menu-item ${className}`;
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    const label = document.createElement('span');
    label.className = 'menu-item-name';
    label.textContent = text;
    item.appendChild(label);
    if (note) {
      const says = document.createElement('span');
      says.className = 'menu-item-note';
      says.textContent = note;
      item.appendChild(says);
    }
    // One highlight at a time: a pointer arriving takes the keyboard's cursor
    // off, rather than leaving two rows looking equally chosen.
    item.addEventListener('pointerenter', () => this._setCursor(-1));
    return item;
  }

  /**
   * @returns {HTMLElement} A rule between two groups of rows.
   */
  _divider() {
    const divider = document.createElement('li');
    divider.className = 'menu-divider';
    divider.setAttribute('role', 'separator');
    return divider;
  }

  /**
   * The rows a key press can reach, in the order they are read.
   * @returns {HTMLElement[]} The interactive rows, wherever the menu now lives.
   */
  _rows() {
    const surface = this._menu?.surface ?? this.querySelector('.workspace-menu');
    if (!surface) return [];
    return /** @type {HTMLElement[]} */ (Array.from(surface.querySelectorAll('[role="menuitem"]')));
  }

  /**
   * Put the keyboard cursor on a row, or on none of them.
   * @param {number} index - Which row, or -1.
   */
  _setCursor(index) {
    this._cursor = index;
    this._rows().forEach((row, position) => row.classList.toggle('nav-active', position === index));
  }

  /**
   * Arrows to move, Enter to choose. Escape is the popup layer's.
   *
   * Nothing takes focus: the menu is anchored to a composer nobody wants to be
   * typing out of, so the keys are read at the document while it is open and the
   * cursor is a class on a row. It starts on no row at all, which is what keeps
   * an Enter meant for the composer from finishing with a workspace.
   * @param {KeyboardEvent} event - The key.
   */
  _onKey(event) {
    const rows = this._rows();
    if (!this._open || !rows.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this._setCursor(this._cursor < 0
        ? (step > 0 ? 0 : rows.length - 1)
        : (this._cursor + step + rows.length) % rows.length);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && this._cursor >= 0) {
      event.preventDefault();
      event.stopPropagation();
      rows[this._cursor]?.click();
    }
  }

  /**
   * Ask, then do it.
   *
   * What is asked is the whole coordination story: nobody owns a workspace, so
   * the confirmation names every other conversation working in this one, and a
   * turn in flight is refused rather than confirmed — removing a tree under a
   * running agent is the one thing here that loses work. The refusal is the
   * service's too; this only says it earlier and in a sentence.
   * @param {any} option - The ending that was chosen.
   * @returns {Promise<void>} When it has run, or been called off.
   */
  async _finish(option) {
    const workspace = this._workspace();
    const conversation = this._conversation;
    const session = conversation?.session;
    this.closeMenu();
    if (!workspace || !session) return;

    const warning = workspaceFinishWarning(session, workspace, {
      conversation,
      action: option,
      status: this._status
    });
    if (warning.refusal) {
      showNotice(warning.refusal);
      return;
    }

    /** @type {object} */
    let input = {};
    if (option.prompt) {
      // Its own dialog, because what it asks for has a name and the answer is
      // not always typed: an ending that offers an alternative is two endings,
      // and a generic box with one OK button can only state the one.
      const answer = await openWorkspaceFinish(option, {
        status: this._status,
        warning: warning.warning
      });
      if (answer === null) return;
      input = answer;
    } else {
      const agreed = await showConfirm(
        [option.description, warning.warning].filter(Boolean).join(' '),
        option.label,
        { confirmText: option.label, danger: option.danger === true });
      if (!agreed) return;
    }

    const result = await finishWorkspace({
      session,
      workspace,
      conversation,
      actionId: option.id,
      input
    });
    if (result?.message) showNotice(result.message);
    this._refresh();
  }

  /**
   * Open the menu, or close it again.
   */
  toggleMenu() {
    if (this._open) {
      this.closeMenu();
      return;
    }
    this._open = true;
    this._cursor = -1;
    this.render();
    this._keys = (/** @type {KeyboardEvent} */ event) => this._onKey(event);
    document.addEventListener('keydown', this._keys, true);
    // Someone is looking at it, which is the one moment worth spending a round
    // trip on.
    void this.refreshStatus();

    this._menu = presentInlineMenu({
      host: this,
      surfaceSelector: '.workspace-menu',
      anchorSelector: '.workspace-chip-button',
      onClose: () => this.closeMenu(),
    });
  }

  /**
   * Close the menu, if one is open.
   */
  closeMenu() {
    if (!this._open) return;
    this._open = false;
    this._cursor = -1;
    if (this._keys) document.removeEventListener('keydown', this._keys, true);
    this._keys = null;
    this._menu?.close();
    this._menu = null;
    this.querySelector('.workspace-menu')?.remove();
    const button = /** @type {HTMLElement|null} */ (this.querySelector('.workspace-chip-button'));
    button?.classList.remove('open');
    button?.setAttribute('aria-expanded', 'false');
  }
}

customElements.define('workspace-chip', WorkspaceChip);

export default WorkspaceChip;

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * conversation-area-rendering — pure-function helpers for conversation-area.js,
 * keeping the widget itself focused on lifecycle, selection, scroll, and footer
 * state.
 *
 * Each helper takes the ConversationArea instance (`area`) as its first
 * argument when it needs to read widget state. Otherwise they're plain
 * DOM-in/DOM-out functions.
 *
 * # ID-Based DOM diffing
 *
 * Conversation items don't map 1:1 to DOM elements — an item can produce
 * 0 elements (e.g. an empty assistant message, a context-item placeholder
 * with isNew=false, a tool-action whose result is a context item). So we
 * look up elements by `message-id`, never by position.
 *
 * Algorithm:
 *   1. Build Map<id, element> of current DOM.
 *   2. Build Set<id> of items that should be kept.
 *   3. Remove elements not in the keep-set (do this BEFORE positioning —
 *      stale elements break `nextSibling` checks).
 *   4. Iterate items backwards, `insertBefore(el, nextEl)`. If the element
 *      exists, move it if needed; otherwise create it.
 * @module components/conversation-area-rendering
 */

import {
  isUserMessage,
  isAssistantMessage,
  isThinkingMessage,
  isProviderStateMessage,
  isToolActionMessage,
  isErrorMessage,
  isNoticeMessage,
  isThreadMessage,
} from '../../sdk/lib/message.js';
import { FINAL_ITEM_ATTR } from './base-message.js';
import { isGroupEntry } from '../utils/item-grouping.js';
import { wrapWithIcon } from '../utils/icon-message-renderer.js';
import { normalizeAttachments } from '../utils/attachments.js';
import { readItemData } from '../utils/item-data.js';
import { renderAssistantContentWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import { itemGoal } from '../model/thread-alias.js';
import { liveMessageForThread } from '../utils/thread-display.js';
import { SETUP_PANEL_TAG } from './conversation-setup-panel.js';
import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import {
  getSetupState,
  undoSetup,
  setupUndoDetail,
  isSetupProvisioning
} from '../services/conversation-setup.js';
import { workspaceStatus } from '../services/workspace-provisioning.js';
import { showConfirm } from './modal-dialog.js';
import { rebindConversation } from '../services/workspace-rebinding.js';
import { openWorkspaceMove } from './workspace-move-dialog.js';
import { openWorkspaceReconnect } from './workspace-reconnect-dialog.js';

/** @typedef {import('../../sdk/lib/message.js').Message} Message */

// DOM element tag names - constants to avoid typos
const FOOTER_TAG = 'CONVERSATION-FOOTER';
const THREAD_ACTIONS_TAG = 'THREAD-COLUMN-ACTIONS';

// Synthesized non-item elements managed outside the item-diff (like the footer
// and context toggle): the terminal thread-result block. Excluded from
// buildElementMap/removeAllElements so the diff never tears it down.
const THREAD_RESULT_CLASS = 'thread-result-final';

// Queued-message zone: a managed non-item container rendered AFTER the footer,
// holding bubbles for messages typed while a turn was in flight. Its bubbles are
// nested (grandchildren of the message list) so the message-id item-diff never
// sees them, but they DO carry message-id so the standard id+DOM selection path
// treats them as first-class (select, properties panel, delete).
const PENDING_ZONE_CLASS = 'pending-messages';

// The tree a bound conversation works in, stated once at the top of its
// transcript. Synthesized from the binding and the session's workspace table —
// neither of which is an item — so it too is managed outside the item-diff.
const WORKSPACE_BANNER_CLASS = 'conversation-workspace-banner';

// On the inner column while the setup card is in it: the column fills the
// scroller so the card can centre in the space below the seeded items, which is
// where the reader is looking. Carried as a class rather than measured, because
// it is a fact about what is in the column, not about how tall anything is.
const AWAITING_SETUP_CLASS = 'awaiting-setup';

// Corner-up-left "return" arrow — the summary is what the thread came back with.
const RESULT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M280-200v-80h360q33 0 56.5-23.5T720-360q0-33-23.5-56.5T640-440H300l84 84-56 56-180-180 180-180 56 56-84 84h340q66 0 113 47t47 113q0 66-47 113t-113 47H280Z"/></svg>';

/**
 * True for a child managed outside the item-diff: the footer, the synthesized
 * terminal thread-result block, the queued-message zone and the workspace
 * banner. These are not conversation items and must not be removed by the
 * message-id diff.
 * @param {Element} child
 * @returns {boolean} True if the element is a managed non-item.
 */
function isManagedNonItem(child) {
  return child.tagName === FOOTER_TAG ||
    child.tagName === THREAD_ACTIONS_TAG ||
    child.tagName === SETUP_PANEL_TAG ||
    child.classList.contains(THREAD_RESULT_CLASS) ||
    child.classList.contains(PENDING_ZONE_CLASS) ||
    child.classList.contains(WORKSPACE_BANNER_CLASS);
}

/**
 * Render the thread's queued (pending) messages in a zone pinned after the
 * footer. Each queued message is a real user bubble carrying its message-id, so
 * the existing selection/properties/delete machinery treats it like any item.
 * Diffs by message-id within the zone so unchanged bubbles are preserved, and
 * removes the zone entirely when the queue drains.
 * @param {any} area - ConversationArea instance (provides _messageThread)
 * @param {HTMLElement} messageList
 */
export function ensurePendingMessages(area, messageList) {
  // A group column shares the parent column's thread, so its queue is the
  // parent's queue — messages typed against a thread, with nothing to do with
  // the run of tool rows this column shows. Treated as empty, which also clears
  // the zone from a column reused as a group column.
  const thread = area?._isGroupColumn ? null : area?._messageThread;
  const pending = (thread && 'pendingItems' in thread) ? thread.pendingItems : [];

  let zone = /** @type {HTMLElement|null} */ (messageList.querySelector(`.${PENDING_ZONE_CLASS}`));

  // The queue can also hold @-mention / dropped-file reads enqueued alongside a
  // message typed while busy (see MessageThread.enqueuePendingItem). Those are
  // not user messages and have no queued bubble of their own — they surface in
  // the main list when the worker promotes the group. Only user messages get a
  // queued bubble here, so the zone is driven purely by the queued user messages
  // (a queue holding only not-yet-joined reads shows nothing).
  const pendingUsers = (pending || []).filter((/** @type {any} */ it) => isUserMessage(it));

  if (pendingUsers.length === 0) {
    if (zone) zone.remove();
    return;
  }

  if (!zone) {
    zone = document.createElement('div');
    zone.className = PENDING_ZONE_CLASS;
    const label = document.createElement('div');
    label.className = 'pending-messages-label';
    label.textContent = 'Queued';
    zone.appendChild(label);
  }
  // Keep the zone pinned at the very end (after the footer).
  if (messageList.lastElementChild !== zone) {
    messageList.appendChild(zone);
  }

  // Diff bubbles by message-id; drop any whose pending item is gone.
  const wantedIds = new Set(pendingUsers.map((/** @type {any} */ it) => it.get('itemId')));
  for (const child of Array.from(zone.querySelectorAll('[message-id]'))) {
    if (!wantedIds.has(child.getAttribute('message-id'))) child.remove();
  }
  // Create/reposition bubbles in queue order (re-append keeps the label first).
  for (const item of pendingUsers) {
    const id = item.get('itemId');
    let el = /** @type {HTMLElement|null} */ (zone.querySelector(`[message-id="${id}"]`));
    if (!el) {
      el = createUserBubble(item);
      if (el) el.classList.add('queued-message');
    }
    if (el) {
      zone.appendChild(el);
      ensureQueuedDeleteButton(area, el, id);
    }
  }
}

/**
 * Ensure a queued message has its inline remove-from-queue affordance. Kept
 * outside `<article>` so user-message can keep rendering/copy behavior exactly
 * like a normal user bubble while the pending zone adds queue-only controls.
 * @param {any} area - ConversationArea instance (provides _messageThread)
 * @param {HTMLElement} el - The queued user-message element
 * @param {string} itemId - Pending item id
 */
function ensureQueuedDeleteButton(area, el, itemId) {
  let button = /** @type {HTMLButtonElement|null} */ (el.querySelector(':scope > .queued-message-delete-btn'));
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'queued-message-delete-btn icon-btn';
    button.title = 'Remove from queue';
    button.setAttribute('aria-label', 'Remove queued message');
    button.innerHTML = '<span class="icon-trashcan"></span>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      area?._messageThread?.removeItemById?.(itemId);
    });
    el.appendChild(button);
  }
}

// Message types - elements are identified by message-id attribute
export const MESSAGE_TAGS = new Set([
  'USER-MESSAGE',
  'ASSISTANT-MESSAGE',
  'THINKING-MESSAGE',
  'CONTEXT-ITEM-MESSAGE',
  'ERROR-MESSAGE',
  'NOTICE-MESSAGE',
  'COMPACT-SUMMARY-MESSAGE',
  'TOOL-ACTION-MESSAGE',
  'TOOL-GROUP-MESSAGE'
]);

// Element ID format helpers
const INVALID_ID_MARKER = 'null';  // IDs containing this are invalid

/**
 * Get unique ID for an item. INVARIANT: items MUST have itemId.
 * @param {any} item
 * @returns {string} Item ID (e.g., "message:abc123")
 */
export function getItemId(item) {
  const message = /** @type {any} */ (item);
  return `message:${message.get('itemId') || ''}`;
}

/**
 * Get unique ID for a DOM element. INVARIANT: elements MUST have message-id.
 * @param {Element} element
 * @returns {string} Element ID (e.g., "message:abc123")
 */
function getElementId(element) {
  return `message:${element.getAttribute('message-id') || ''}`;
}

/**
 * Ensure the column says where its conversation works: the question at the foot
 * of the transcript while it is still being asked, the banner above the first
 * item once it has an answer.
 *
 * The two are one state in two places, and never both. A conversation still
 * being asked has nothing to announce, so the whole of its workspace surface is
 * the card in the welcome slot — with the starting hint inside it, because a
 * question and the instructions for answering it are one block. A conversation
 * that has been told is the reverse: nothing to ask, and a tree its tools,
 * provider and seeds all resolve against that nothing else on screen names —
 * the window title, the project chip and the file pins are project chrome and
 * stay the project, deliberately — so the answer goes at the top of the one
 * surface that belongs to the conversation, above the items it scopes.
 *
 * Idempotent: updates in place, repositions, or removes.
 *
 * The banner is silent in three cases, each for its own reason. A conversation
 * bound to the project is where every conversation worked before workspaces
 * existed and needs no announcing. A binding that cannot be resolved — still
 * provisioning, closed, root gone, never registered — says nothing rather than
 * naming a tree the conversation cannot reach; surfacing that state is phase 3's
 * tombstone banner, which can also offer the rebind that fixes it. And a
 * sub-thread or group column is a lens on part of the same conversation, working
 * in the same tree, so repeating it per column would be noise.
 * @param {any} area - ConversationArea instance (provides `_conversation`, `_threadYMap`, `_isGroupColumn`).
 * @param {HTMLElement} messageList - The column's normal-order inner list.
 */
export function ensureConversationChrome(area, messageList) {
  const isRootColumn = !area?._threadYMap && !area?._isGroupColumn;
  const conversation = isRootColumn ? area?._conversation : null;
  const panel = /** @type {any} */ (messageList.querySelector('conversation-setup-panel'));

  // A conversation whose workspace is being built has nowhere to send to yet —
  // but the wait is exactly when the first message gets written, so the box
  // stays live and only the send is held. Released the moment the workspace
  // exists, which is a setup notification like any other and comes straight back
  // through here.
  if (conversation) {
    const composer = /** @type {any} */ (area?.querySelector?.('composer-box'));
    composer?.setSendBlocked?.(isSetupProvisioning(conversation), 'Still building the workspace');
  }

  // A conversation nobody has asked yet, in an app that could offer it
  // somewhere else to work. With no provider installed there is nothing to ask —
  // the project is the only answer — and the conversation looks exactly as it
  // did before any of this existed. A conversation with history behind it is not
  // asked either: see {@link Conversation#awaitingSetup}.
  const asking = conversation
    && conversation.awaitingSetup
    && workspaceProviderRegistry.getIds().length > 0;

  messageList.classList.toggle(AWAITING_SETUP_CLASS, !!asking);

  if (!asking) {
    panel?.remove();
    ensureWorkspaceBanner(area, messageList);
    return;
  }

  // The card and the banner are two states of one answer, so only one of them
  // is ever here: a conversation being asked where it works has nothing to put
  // in a banner yet.
  messageList.querySelector(`.${WORKSPACE_BANNER_CLASS}`)?.remove();

  const element = panel || document.createElement('conversation-setup-panel');

  // Last in the transcript rather than first in it. A question pinned above the
  // seeded items reads as a heading for them — something printed about the
  // conversation rather than something to answer — so it goes where the reader
  // is already looking before they type: at the foot of the column, in the
  // space the starting hint used to have to itself, carrying that hint with it.
  // The queued-message zone stays below it: a message waiting on a workspace
  // belongs under the thing it is waiting for.
  //
  // Seated before it is told anything, because drawing it raises setup
  // notifications — a provider's form reports itself as it is built, a sweep
  // answers — and what listens to those comes straight back here. A panel that
  // is not in the list yet is not found by that pass, which builds a second one;
  // and every guard against redundant work is per-element (the identity check in
  // `set conversation`, the shape comparison in `render`, the in-flight check in
  // `sweep`), so the second element has released all of them at once.
  const seat = messageList.querySelector(`.${PENDING_ZONE_CLASS}`);
  if (element.parentElement !== messageList || element.nextElementSibling !== seat) {
    messageList.insertBefore(element, seat);
  }

  element.conversation = conversation;
  element.render();
}

/**
 * The banner half of {@link ensureConversationChrome}, which is also the whole
 * of it for every conversation that has already been asked.
 * @param {any} area - ConversationArea instance (provides `_conversation`, `_threadYMap`, `_isGroupColumn`).
 * @param {HTMLElement} messageList - The column's normal-order inner list.
 */
export function ensureWorkspaceBanner(area, messageList) {
  const existing = /** @type {HTMLElement|null} */ (
    messageList.querySelector(`.${WORKSPACE_BANNER_CLASS}`));

  const isRootColumn = !area?._threadYMap && !area?._isGroupColumn;
  const conversation = isRootColumn ? area?._conversation : null;
  const id = conversation?.workspaceId || '';
  // The root, not merely the row: `workspaceRoot` makes the same four refusals
  // the server makes, so a banner exists exactly when an op would be honoured.
  const root = id ? conversation.workspaceRoot : null;
  const workspace = id ? conversation.session?.getWorkspace(id) : null;

  // A binding that cannot be honoured is worth a banner of its own. Every
  // operation of the next turn would fail on its own, each with a true and
  // useless message, so it is said once here instead — with the things that fix
  // it. What there is to say is {@link strandedLead}'s to decide.
  if (!root) {
    // The project is where a conversation has always worked and needs no
    // announcing, in any state: it has no row, and a conversation bound to it is
    // not bound to anything that can go missing.
    const lead = id ? strandedLead(workspace) : '';
    if (!lead) {
      if (existing) existing.remove();
      return;
    }
    // A workspace with no row at all is the one kind of loss that can be undone
    // rather than merely escaped: the place is very likely still on disk, and
    // what went missing is the session's record of it.
    ensureStrandedBanner(conversation, { id, lead, lost: !workspace }, existing, messageList);
    return;
  }

  // Its label when the user gave it one, and nothing when they did not — the id
  // is what the server falls back to in an error, and `ws_k3n8fq2p1` tells a
  // reader less than the root underneath it already does.
  const label = conversation.session?.getWorkspace(id)?.label || '';
  // A workspace made a moment ago can still be given back, and the banner is
  // where that is said: the line already names the tree, so it grows a button
  // rather than being shadowed by a second line saying the same thing.
  const undoable = getSetupState(conversation).undoable === true;
  const undoDetail = undoable ? setupUndoDetail(conversation) : '';
  const signature = `${id}\u0000${label}\u0000${root}\u0000${undoable}\u0000${undoDetail}`;

  const banner = existing || document.createElement('div');
  if (banner.dataset.workspace !== signature) {
    banner.dataset.workspace = signature;
    banner.className = WORKSPACE_BANNER_CLASS;
    banner.replaceChildren();
    const lead = document.createElement('span');
    lead.className = 'workspace-banner-lead';
    // The noun, not a preposition: the menu, the setup panel and the move dialog
    // all call this thing a workspace, and the banner is where a reader meets it
    // first.
    lead.textContent = 'Workspace';
    banner.appendChild(lead);
    if (label) {
      const name = document.createElement('span');
      name.className = 'workspace-banner-label';
      name.textContent = label;
      banner.appendChild(name);
    }
    const where = document.createElement('span');
    where.className = 'workspace-banner-root';
    where.textContent = root;
    banner.appendChild(where);
    if (undoable) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'workspace-banner-undo';
      undo.textContent = 'Undo';
      // One word, and what it runs is a removal. The word is right — this is
      // the undo of the choice just made — but it is not the whole of what
      // happens, so the rest of it travels with the control rather than being
      // discovered afterwards.
      if (undoDetail) {
        undo.title = `Undo — ${undoDetail}`;
        undo.setAttribute('aria-label', `Undo: ${undoDetail}`);
      }
      undo.addEventListener('click', () => { void undoFromBanner(conversation, undoDetail); });
      banner.appendChild(undo);
    }
  }

  // Kept at the very top, above the items and above the thread actions a column
  // reused from a sub-thread may still be carrying.
  if (messageList.firstElementChild !== banner) {
    messageList.insertBefore(banner, messageList.firstElementChild);
  }
}

/**
 * Undo the setup, asking first when the tree holds work.
 *
 * The undo window is open only until the conversation has said anything, so
 * almost always the tree is exactly as it was built and there is nothing to ask
 * about — going straight through is what makes it read as an undo rather than
 * as a third way of finishing with a workspace. The exception is the one that
 * costs something: a tree somebody has already written in by hand, whose files
 * go with the directory when the compensation stack removes it.
 *
 * The status is asked for here rather than read from the setup panel's cache:
 * the panel is gone by the time this banner exists, so its cache is whatever
 * was true before the workspace was built.
 * @param {any} conversation - The conversation to unbind and roll back.
 * @param {string} detail - What the provider says the removal takes with it.
 * @returns {Promise<void>} When it has run, or been called off.
 */
async function undoFromBanner(conversation, detail) {
  const session = conversation?.session;
  const workspace = session?.getWorkspace?.(conversation?.workspaceId || '');
  const status = workspace ? await workspaceStatus(session, workspace) : null;
  if (status?.dirty === true) {
    const agreed = await showConfirm(
      [detail, 'It holds uncommitted work, which goes with it.'].filter(Boolean).join(' '),
      'Undo',
      { confirmText: 'Undo', danger: true });
    if (!agreed) return;
  }
  await undoSetup(conversation);
}

/**
 * What to say about a binding that cannot be honoured, or '' to say nothing.
 *
 * Three of the four refusals are worth a line. Finished with by somebody names
 * them, because that is the whole of the coordination story. A root that is not
 * where it was is reported and nothing more: a place can come back, and an
 * unmounted disk is not an accusation. A binding with no row at all is the state
 * a lost `session.json` leaves behind — the table is deliberately disposable
 * here, the binding lives in the conversation's own document and survives it —
 * and there is no label left to name it by, so the line says only what is known.
 *
 * The fourth is silence. A workspace still being built is a conversation
 * waiting, not one stranded, and the setup panel is already showing it being
 * built.
 * @param {any} workspace - The row it is bound to, or null when the table has none.
 * @returns {string} The line, or '' for a binding that is nobody's problem yet.
 */
function strandedLead(workspace) {
  if (!workspace) return 'There is no record of the workspace this conversation works in.';
  if (workspace.state === 'provisioning') return '';

  const label = workspace.label || workspace.root;
  if (workspace.state === 'closed') {
    // Reached by the conversations that did NOT do it — the one that did is back
    // in the project before the row is tombstoned. So it says who, and it says
    // what this conversation's position now is: nothing refuses a message typed
    // here, and the turn would die in the server.
    const closedBy = typeof workspace.meta?.closedBy === 'string' ? workspace.meta.closedBy : '';
    return `The workspace ${label} was finished with${closedBy ? ` by ${closedBy}` : ''}.`
      + ' This conversation has nowhere to work until you choose.';
  }
  return workspace.available === false
    ? `The workspace ${label} is not where it was.`
    : '';
}

/**
 * The banner a conversation gets when the place it works in cannot be worked in:
 * finished with by somebody, not where it was, or gone from the table entirely.
 *
 * One line of {@link strandedLead}, and two ways out — which is two because there
 * are two answers. The project is one press and is usually the right one; the
 * second opens the picker the chip opens, for a conversation whose work belongs
 * in another tree entirely.
 *
 * Neither goes anywhere near the setup panel. Its choice is applied by
 * `ensureInitialised`, which short-circuits for a conversation that already
 * holds history, so a stranded conversation sent back there would pick a
 * workspace and quietly not get it.
 *
 * The move itself goes through `rebindConversation` rather than writing the
 * binding here: what a conversation read out of the tree it is leaving has to
 * catch up with the one it arrives in, and that is not a thing a click handler
 * should know how to do half of.
 * @param {any} conversation - The stranded conversation.
 * @param {{id: string, lead: string, lost: boolean}} binding - Which workspace,
 *   what to say about it, and whether the table has lost it outright.
 * @param {HTMLElement|null} existing - The banner already there, if any.
 * @param {HTMLElement} messageList - The column's normal-order inner list.
 */
function ensureStrandedBanner(conversation, binding, existing, messageList) {
  const { id: workspaceId, lead, lost } = binding;
  const signature = `stranded\u0000${workspaceId}\u0000${lead}\u0000${lost}`;

  const banner = existing || document.createElement('div');
  if (banner.dataset.workspace !== signature) {
    banner.dataset.workspace = signature;
    banner.className = `${WORKSPACE_BANNER_CLASS} workspace-banner-stranded`;
    banner.replaceChildren();

    const said = document.createElement('span');
    said.className = 'workspace-banner-lead';
    said.textContent = lead;
    banner.appendChild(said);

    // First, and only where the record is what went missing: the binding this
    // conversation still carries is the last trace of that workspace anywhere,
    // and both of the buttons below spend it by rebinding. Putting the
    // workspace back is also the only one of the three that fixes it for every
    // other conversation bound to the same id.
    if (lost) {
      const found = document.createElement('button');
      found.type = 'button';
      found.className = 'workspace-banner-reconnect';
      found.textContent = 'Put it back…';
      found.addEventListener('click', () => { void openWorkspaceReconnect(conversation); });
      banner.appendChild(found);
    }

    const rebind = document.createElement('button');
    rebind.type = 'button';
    rebind.className = 'workspace-banner-rebind';
    rebind.textContent = 'Work in the project';
    rebind.addEventListener('click', () => { void rebindConversation(conversation, ''); });
    banner.appendChild(rebind);

    const elsewhere = document.createElement('button');
    elsewhere.type = 'button';
    elsewhere.className = 'workspace-banner-elsewhere';
    elsewhere.textContent = 'Another workspace…';
    elsewhere.addEventListener('click', () => { void openWorkspaceMove(conversation); });
    banner.appendChild(elsewhere);
  }

  if (messageList.firstElementChild !== banner) {
    messageList.insertBefore(banner, messageList.firstElementChild);
  }
}

/**
 * Ensure footer element exists in message list. Creates it if missing.
 * @param {any} area - ConversationArea instance (provides _messageThread)
 * @param {HTMLElement} messageList
 * @returns {HTMLElement} Footer element
 */
export function ensureFooterExists(area, messageList) {
  let footer = /** @type {import('./conversation-footer.js').default|null} */ (messageList.querySelector('conversation-footer'));
  if (!footer) {
    footer = /** @type {import('./conversation-footer.js').default} */ (document.createElement('conversation-footer'));
    /** @type {any} */ (footer).setMessageThread(area._messageThread);
    messageList.appendChild(footer);
  }
  return footer;
}

/**
 * Remove all elements from message list except footer and context toggle.
 * @param {HTMLElement} messageList
 */
export function removeAllElements(messageList) {
  const children = Array.from(messageList.children);
  for (const child of children) {
    if (!isManagedNonItem(child)) {
      child.remove();
    }
  }
}

/**
 * Header label for the thread-result block.
 * @param {string} text - The fold's summary, or '' when it has none.
 * @returns {string} The label to show above the block.
 */
function threadResultLabel(text) {
  return text ? 'Summary' : 'Not summarised';
}

/**
 * Fill the thread-result body with the summary, or with what stands in for one.
 *
 * The no-summary case says where the content actually is, because the fold has
 * already happened by the time this renders: the transcript is inside this
 * thread and the parent holds only the fold's tile, so the honest information is
 * that nothing is lost and how to get a summary written.
 * @param {HTMLElement} body
 * @param {string} text - The fold's summary, or '' when it has none.
 */
function renderThreadResultBody(body, text) {
  if (text) {
    body.innerHTML = renderAssistantContentWrapped(stripThinkingTags(text));
    decorateCodeBlocks(body);
    return;
  }
  body.textContent = 'The folded transcript is intact in this thread. Re-summarise to write a summary for it.';
}

/**
 * Whether a summary for this fold is still coming: a run driving it right now, or
 * the one-shot trigger that starts one. Either way the fold is mid-flight and has
 * nothing to offer yet.
 * @param {any} area - ConversationArea instance (provides the live snapshot).
 * @param {any} threadYMap - The fold's thread Y.Map.
 * @returns {boolean} True while a summary is still on its way.
 */
function summaryOnItsWay(area, threadYMap) {
  if (threadYMap?.get?.('needsStrategyRun') === true) return true;
  const live = area?._snapshotLiveStatus?.() ?? null;
  return !!liveMessageForThread(live, threadYMap?.get?.('itemId'));
}

/**
 * Ensure the terminal thread-result block reflects a compaction fold's `result`.
 *
 * `result` is a field on the thread Y.Map, not an item, so the item list never
 * renders it. This synthesizes a terminal block from that field and keeps it
 * pinned just before the footer. Idempotent: updates in place, repositions, or
 * removes.
 *
 * A compaction fold alone renders it. The fold's transcript is folded away and
 * the summariser's text is all that stands for it, so the block IS the column —
 * and it carries the Re-summarise button, the only way to write that text again.
 * Every other thread answers its caller through its runs and ends on the reply
 * its last run came to rest on, so a block underneath that message would say the
 * same thing twice.
 * @param {any} area - ConversationArea instance (provides `_threadYMap`).
 * @param {HTMLElement} messageList
 * @param {HTMLElement} footer
 */
export function ensureThreadResult(area, messageList, footer) {
  const existing = /** @type {HTMLElement|null} */ (
    messageList.querySelector(`.${THREAD_RESULT_CLASS}`));

  const threadYMap = area?._threadYMap;
  const isFold = threadYMap?.get?.('boundedCompaction') === true;
  const result = threadYMap?.get?.('result');
  const text = (isFold && typeof result === 'string') ? result : '';
  // A fold with no summary and nothing on its way to write one. The block still
  // has to render: it carries Re-summarise, and this is exactly the state that
  // needs it — the parent thread shows only this fold's tile, so hiding the block
  // here leaves no route back to a summary anywhere.
  //
  // Derived rather than read from a stored marker. The summarizer sets
  // compactionUnsummarized when a run of its own ends badly, but a fold can reach
  // this state without any run ending at all — anything that leaves the fold
  // committed and its summarization undone gets here — and a fold that never had
  // the marker written is precisely the one with no other way out. The two
  // exclusions are the states where a summary is still coming: a run driving it
  // now, and the trigger that starts one.
  // Asked only of a fold with nothing to show, which is the only column the
  // answer can change: every other call would snapshot the live registry to
  // discard it.
  const unsummarized = isFold && !text && !summaryOnItsWay(area, threadYMap);

  if (!text && !unsummarized) {
    if (existing) existing.remove();
    return;
  }

  // What the body is showing, tracked alongside the text rather than folded
  // into it: the two states are answers to different questions, and a summary
  // whose text happened to match a sentinel would defeat a combined key.
  const resultState = text ? 'summary' : 'unsummarized';

  if (existing) {
    // Re-render the body only when the rendered state actually changed, so a
    // routine re-render doesn't thrash the DOM.
    if (existing.dataset.result !== text || existing.dataset.resultState !== resultState) {
      existing.dataset.result = text;
      existing.dataset.resultState = resultState;
      const label = /** @type {HTMLElement|null} */ (existing.querySelector('.thread-result-label'));
      if (label) label.textContent = threadResultLabel(text);
      const body = /** @type {HTMLElement|null} */ (existing.querySelector('.thread-result-body'));
      if (body) renderThreadResultBody(body, text);
    }
    // Keep it pinned immediately before the footer (after the last item).
    if (existing.nextSibling !== footer) {
      messageList.insertBefore(existing, footer);
    }
    return;
  }

  const block = document.createElement('div');
  block.className = `conversation-item ${THREAD_RESULT_CLASS}`;
  block.dataset.result = text;
  block.dataset.resultState = resultState;

  const content = document.createElement('div');
  content.className = 'thread-result-content';

  const header = document.createElement('div');
  header.className = 'thread-result-header';
  const label = document.createElement('div');
  label.className = 'thread-result-label';
  label.textContent = threadResultLabel(text);
  header.appendChild(label);

  const headerActions = document.createElement('div');
  headerActions.className = 'thread-result-header-actions';
  header.appendChild(headerActions);

  // A fold is frozen transcript whose summary the folded-compaction summariser
  // wrote once; nothing else will ever refresh it, so Re-summarise is the only
  // route to a different one.
  const resummariseBtn = document.createElement('button');
  resummariseBtn.type = 'button';
  resummariseBtn.className = 'thread-result-resummarise-btn';
  resummariseBtn.title = 'Summarise this fold again';
  resummariseBtn.setAttribute('aria-label', 'Summarise this fold again');
  resummariseBtn.textContent = 'Re-summarise';
  resummariseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const tid = threadYMap?.get?.('itemId');
    if (!tid || !area?._conversation) return;
    void area._conversation.resolveMessageThread(tid).resummariseFold();
  });
  headerActions.appendChild(resummariseBtn);

  // Expand and Promote live at the start of the thread's scrollable transcript.

  const body = document.createElement('div');
  body.className = 'thread-result-body markdown';
  renderThreadResultBody(body, text);
  content.appendChild(header);
  content.appendChild(body);

  block.appendChild(wrapWithIcon(content, { color: 'purple', iconSvg: RESULT_ICON_SVG }));
  messageList.insertBefore(block, footer);
}

/**
 * Build map of existing elements by ID.
 * @param {HTMLElement} messageList
 * @returns {Map<string, HTMLElement>} Map of element ID to element
 */
export function buildElementMap(messageList) {
  const elementMap = new Map();
  const children = Array.from(messageList.children);
  for (const child of children) {
    if (isManagedNonItem(child)) continue;

    const id = getElementId(/** @type {HTMLElement} */ (child));
    if (id && !id.includes(INVALID_ID_MARKER)) {
      elementMap.set(id, /** @type {HTMLElement} */ (child));
    }
  }
  return elementMap;
}

/**
 * Identify which elements should be kept (exist in items).
 * @param {Array<any>} items
 * @param {Map<string, HTMLElement>} currentElements
 * @returns {Set<string>} Set of element IDs to keep
 */
export function identifyElementsToKeep(items, currentElements) {
  const idsToKeep = new Set();
  for (const item of items) {
    if (!item) continue;
    const itemId = getItemId(item);
    if (currentElements.has(itemId)) {
      idsToKeep.add(itemId);
    }
  }
  return idsToKeep;
}

/**
 * Remove elements that are no longer in items.
 * CRITICAL: Must happen BEFORE positioning (affects nextSibling checks).
 * @param {Map<string, HTMLElement>} currentElements
 * @param {Set<string>} elementsToKeep
 */
export function removeDeletedElements(currentElements, elementsToKeep) {
  for (const [id, element] of currentElements) {
    if (!elementsToKeep.has(id)) {
      element.remove();
      currentElements.delete(id);
    }
  }
}

/**
 * Mark (or unmark) an element as belonging to the thread's final item.
 *
 * An explicit marker rather than a `:last-child` rule or an index comparison
 * inside the component: the element is created once and then only moved, so
 * nothing in it re-runs when an item is appended after it, and the managed
 * non-items (footer, thread result) sit after the items anyway. Elements that
 * care observe the attribute; for everything else it is inert.
 * @param {HTMLElement} element - Element rendering a conversation item
 * @param {boolean} isFinal - Whether its item is the last in the thread
 */
function markFinalItem(element, isFinal) {
  if (element.hasAttribute(FINAL_ITEM_ATTR) === isFinal) return;
  element.toggleAttribute(FINAL_ITEM_ATTR, isFinal);
}

/**
 * Position elements in correct order (backwards iteration, insert before next).
 * Elements handle their own updates via Yjs observers - this just creates/removes/positions.
 * @param {any} area - ConversationArea instance (passed to bubble creators that need _messageThread)
 * @param {HTMLElement} messageList
 * @param {HTMLElement} footer
 * @param {Array<any>} items
 * @param {Map<string, HTMLElement>} currentElements
 */
export function positionElements(area, messageList, footer, items, currentElements) {
  let insertBefore = footer;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;

    const itemId = getItemId(item);
    const existingElement = currentElements.get(itemId);
    const isFinal = i === items.length - 1;

    if (existingElement) {
      // Update item-index attribute to match current position
      const currentIndex = existingElement.getAttribute('item-index');
      if (currentIndex !== i.toString()) {
        existingElement.setAttribute('item-index', i.toString());
      }
      markFinalItem(existingElement, isFinal);

      // Sync content from live Yjs item for streamable elements
      if (typeof /** @type {any} */ (existingElement).updateFromItem === 'function') {
        /** @type {any} */ (existingElement).updateFromItem(item);
      }

      // Reposition if needed
      if (existingElement.nextSibling !== insertBefore) {
        messageList.insertBefore(existingElement, insertBefore);
      }
      insertBefore = existingElement;
    } else {
      // CREATE new element(s)
      const newElements = createBubblesForEvent(area, /** @type {Message} */ (item), i);
      for (const el of newElements) {
        markFinalItem(el, isFinal);
        messageList.insertBefore(el, insertBefore);
        insertBefore = el;
      }
    }
  }
}

/**
 * Create message element(s) for a single message.
 * @param {any} area - ConversationArea instance (provides _messageThread for context items)
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement[]} Created elements (zero or more).
 */
function createBubblesForEvent(area, message, itemIndex) {
  // Durable provider continuation state is conversation history, not a
  // user-facing message or a standing context item.
  if (isProviderStateMessage(message)) return [];

  /** @type {HTMLElement[]} */
  const elements = [];

  if (isGroupEntry(message)) {
    const live = area?._snapshotLiveStatus?.() || null;
    elements.push(createToolGroupTile(/** @type {any} */ (message), itemIndex, live));
  } else if (isUserMessage(message)) {
    const el = createUserBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isAssistantMessage(message) || isThinkingMessage(message)) {
    const el = createAssistantBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isToolActionMessage(message)) {
    const el = createToolActionElement(message, itemIndex);
    if (el) elements.push(el);
  } else if (isErrorMessage(message)) {
    const el = createErrorBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isNoticeMessage(message)) {
    const el = createNoticeBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isThreadMessage(message)) {
    const live = area?._snapshotLiveStatus?.() || null;
    const el = createThreadBubble(message, itemIndex, live);
    if (el) elements.push(el);
  } else {
    const el = createContextItemBubble(area, message, itemIndex);
    if (el) elements.push(el);
  }

  return elements;
}

/**
 * Create a message element with common attributes.
 * CRITICAL: ensures message-id is ALWAYS set (required for ID-based diffing).
 * @param {string} tagName
 * @param {object} options
 * @param {string|undefined} options.itemId
 * @param {number} [options.itemIndex]
 * @param {Record<string, string>} [options.attributes]
 * @returns {HTMLElement} Created element.
 */
function createMessageElement(tagName, options) {
  const { itemId, itemIndex, attributes = {} } = options;

  const element = document.createElement(tagName);
  element.classList.add('conversation-item');
  element.setAttribute('message-id', itemId || '');

  if (itemIndex !== undefined && itemIndex >= 0) {
    element.setAttribute('item-index', itemIndex.toString());
  }

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }

  return element;
}

/**
 * Create a user message element, or null for a message that paints nothing.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null.
 */
function createUserBubble(message, itemIndex) {
  const msg = /** @type {import('../../sdk/lib/message.js').UserMessage} */ (message);
  // A Continue's marker is a run record, not a message: it holds the outcome of
  // the run that click started (worker/sessions.go continuationMarker) and says
  // nothing. Painting it would put an empty bubble where a Continue has always
  // left the transcript alone. Mirrored by rendersNothing in utils/item-grouping.js.
  if (msg.get('continuation')) return null;
  /** @type {Record<string, string>} */
  const attributes = { content: msg.get('content') || '' };
  const attachments = normalizeAttachments(msg.get('attachments'));
  if (attachments.length > 0) {
    attributes.attachments = JSON.stringify(attachments);
  }
  return createMessageElement('user-message', {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes
  });
}

/**
 * Create an assistant or thinking message bubble.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null if the item has no visible body.
 */
function createAssistantBubble(message, itemIndex) {
  let textContent = '';

  if (isAssistantMessage(message)) {
    textContent = message.get('content') || '';
  } else if (isThinkingMessage(message)) {
    textContent = message.get('content') || '';
  }

  // Strip ephemeral <plan> tags before checking — plan content is displayed
  // via the next-steps indicator, not as an assistant message
  const visibleContent = textContent.replace(/<plan>[\s\S]*?<\/plan>/g, '').replace(/<plan[\s\S]*$/, '').trim();

  // Only create element if there's actual non-whitespace content
  if (!visibleContent) {
    return null;
  }

  const msg = /** @type {any} */ (message);
  const tagName = isThinkingMessage(message) ? 'thinking-message' : 'assistant-message';

  return createMessageElement(tagName, {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes: { content: textContent }
  });
}

/**
 * Create tool-action element (self-rendering component).
 * The tool-action-message component handles all states internally.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null if the item has no visible body.
 */
function createToolActionElement(message, itemIndex) {
  if (message.get('type') !== 'tool-action') {
    return null;
  }

  const msg = /** @type {import('../../sdk/lib/message.js').ToolActionMessage} */ (message);

  // Context item results are rendered by context item messages, not here
  const result = msg.get('result');
  if ((result?.get ? result.get('resultType') : result?.resultType) === 'context') {
    return null;
  }

  const el = document.createElement('tool-action-message');
  el.classList.add('conversation-item');
  el.setAttribute('message-id', msg.get('itemId') || '');
  if (itemIndex !== undefined && itemIndex >= 0) {
    el.setAttribute('item-index', itemIndex.toString());
  }
  return el;
}

/**
 * Create an error message element.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement} Created element.
 */
function createErrorBubble(message, itemIndex) {
  /** @type {Record<string, string>} */
  const attributes = {
    content: message.get('summary') || message.get('message') || message.get('content') || 'An error occurred'
  };
  // The worker classifies the failure; the row only reads the verdict. Matching
  // on the error text here instead would put the taxonomy in two places and let
  // them disagree.
  const kind = readItemData(message)?.errorKind;
  if (kind) attributes['error-kind'] = String(kind);
  return createMessageElement('error-message', {
    itemId: message.get('itemId'),
    itemIndex,
    attributes
  });
}

/**
 * Create a notice message element — a durable record of something that happened
 * to a turn, standing where it happened. The row gets the one-line explanation;
 * the measured detail is the properties panel's, which reads it from the item
 * itself.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement} Created element.
 */
function createNoticeBubble(message, itemIndex) {
  return createMessageElement('notice-message', {
    itemId: message.get('itemId'),
    itemIndex,
    attributes: { 'notice-text': message.get('summary') || '' }
  });
}

/**
 * Create a context item message element with enhanced preview.
 * Renders for all context items to provide inline visibility.
 * @param {any} area - ConversationArea instance (for _messageThread lookup)
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null if the item has no visible body.
 */
function createContextItemBubble(area, message, itemIndex) {
  const msg = /** @type {import('../../sdk/lib/message.js').ContextItemMessage} */ (message);

  // Only render items with a registered context item plugin
  const contextItem = msg.get('itemId') ? area._messageThread?.getContextItem(msg.get('itemId')) : null;
  if (!contextItem) return null;
  // Items may opt out of a standing transcript card while still contributing
  // to LLM context and persisting their data (e.g. the todo list, whose live
  // state shows on each tool-action row and will move to the pinboard).
  if (!contextItem.isVisible()) return null;
  const itemType = contextItem.type;
  const badge = contextItem?.getBadgeOptions() ?? /** @type {{color: string, icon?: string}} */ ({ color: 'slate' });
  const colorPreset = badge.color;
  const icon = badge.icon;

  /** @type {Record<string, string>} */
  const attrs = {
    'item-type': itemType,
    'color-preset': colorPreset,
  };

  if (icon) attrs['icon'] = icon;
  if (msg.get('itemId')) attrs['item-id'] = msg.get('itemId');
  if (msg.get('error')) attrs['error'] = msg.get('error');

  return createMessageElement('context-item-message', {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes: attrs
  });
}

/**
 * Create the collapsed tile for a folded run of tool rows. The tile stands in
 * for items that are still in the document untouched; selecting it opens them
 * in the next column.
 * @param {import('../utils/item-grouping.js').ItemGroup} group - The group entry.
 * @param {number} [itemIndex]
 * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} [live] - Conversation's live LLM status snapshot.
 * @returns {HTMLElement} Created element.
 */
function createToolGroupTile(group, itemIndex, live) {
  const el = createMessageElement('tool-group-message', {
    itemId: group.get('itemId'),
    itemIndex,
    attributes: { 'child-count': String(group.members.length) }
  });
  /** @type {any} */ (el).updateFromItem?.(group, live);
  return el;
}

/**
 * Create a thread message element.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} [live] - Conversation's live LLM status snapshot.
 * @returns {HTMLElement} Created element.
 */
function createThreadBubble(message, itemIndex, live) {
  const msg = /** @type {import('../../sdk/lib/message.js').ThreadMessage} */ (message);

  // Count child items in the thread's nested Y.Array
  const itemsArray = msg.get('items');
  const childCount = itemsArray ? itemsArray.length : 0;

  /** @type {Record<string, string>} */
  const attributes = {
    goal: itemGoal(msg),
    'child-count': childCount.toString()
  };

  const el = createMessageElement('thread-message', {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes
  });
  if (el) {
    /** @type {any} */ (el).updateFromItem?.(msg, live);
  }
  return el;
}

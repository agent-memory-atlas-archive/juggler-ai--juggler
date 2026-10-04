//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Builds, or reuses, the column element for one entry of a conversation tab's
 * column chain: a conversation-area for a thread or a folded group, and a
 * properties-panel for an item's details or one LLM round-trip.
 *
 * It also remembers what it last rendered into each column, so a rebuild that
 * changes nothing a column shows costs that column nothing. That memo belongs
 * to the builder and not to the columns: it records what the builder fed them,
 * which is not the column's own state. It is kept in WeakMaps keyed by element,
 * so a column the tab drops takes its entries with it.
 */

/**
 * @typedef {import('./conversation-area.js').default} ConversationArea
 * @typedef {import('./properties-panel.js').default} PropertiesPanel
 * @typedef {import('../model/conversation.js').default} Conversation
 * @typedef {import('../model/message-thread.js').MessageThread} MessageThread
 * @typedef {import('../utils/column-selection.js').ColumnChainEntry} ColumnChainEntry
 */

import { createMessageThread } from '../model/message-thread.js';
import { groupRenderKey } from '../utils/item-grouping.js';
import { recordTape } from '../utils/event-tape.js';
// Columns are created with createElement('conversation-area' | 'properties-panel').
// Importing the defining modules registers the custom elements before any is
// created; an un-upgraded element has no setMessageThread or any other method.
import './conversation-area.js';
import './properties-panel.js';

/** Properties-panel content render debounce, once selections are churning. */
const PROPS_RENDER_DEBOUNCE_MS = 150;

/** Selection stillness after which the next change renders on the leading edge. */
const PROPS_RENDER_IDLE_MS = 1000;

/**
 * A column as a conversation-area, or null when it is some other column.
 * @param {Element|null|undefined} col - A column element.
 * @returns {ConversationArea|null} The column, typed, or null.
 */
export function asArea(col) {
  return col?.tagName === 'CONVERSATION-AREA' ? /** @type {ConversationArea} */ (col) : null;
}

/**
 * A column as a properties-panel, or null when it is some other column.
 * @param {Element|null|undefined} col - A column element.
 * @returns {PropertiesPanel|null} The column, typed, or null.
 */
export function asPanel(col) {
  return col?.tagName === 'PROPERTIES-PANEL' ? /** @type {PropertiesPanel} */ (col) : null;
}

export class ColumnBuilder {
  constructor() {
    /**
     * What each column was last rendered from: an area's item key, or a
     * panel's conversation-and-selection (or transaction) key.
     * @type {WeakMap<HTMLElement, string>} @private
     */
    this._renderedKeys = new WeakMap();

    /**
     * A properties panel's debounced render, while one is waiting.
     * @type {WeakMap<HTMLElement, {render: () => void, timer: ReturnType<typeof setTimeout>}>} @private
     */
    this._pendingRenders = new WeakMap();

    /** @type {number} @private - Date.now() of the last properties-panel selection change */
    this._propsLastChangeTime = 0;
  }

  /**
   * Forget what was rendered into `col`, so the next build repaints it even if
   * its key is unchanged. For a change to how a column LISTS its items (the
   * tool-grouping preference) that the key does not capture.
   * @param {HTMLElement} col - A column element.
   */
  invalidate(col) {
    this._renderedKeys.delete(col);
  }

  /**
   * Build (or reuse) the conversation-area column for chain entry `index`.
   * @param {object} args
   * @param {HTMLElement} args.container - The tab's column container; a new column is appended to it.
   * @param {HTMLElement|undefined} args.existing - The column already at this index, if any.
   * @param {number} args.index - Position in the chain.
   * @param {ColumnChainEntry} args.entry - The chain entry.
   * @param {Conversation} args.conversation - The tab's conversation.
   * @param {any} args.session - The conversation's session, if any.
   * @param {HTMLElement|undefined} args.previous - The column just built to the left of this one.
   * @param {string|null} args.selectedItemId - This column's selection in the tab's state.
   * @returns {ConversationArea} The conversation-area column element.
   */
  conversationColumn({ container, existing, index, entry, conversation, session, previous, selectedItemId }) {
    let col = asArea(existing);
    if (!col) {
      if (existing) existing.remove();
      col = document.createElement('conversation-area');
      if (index > 0) col.classList.add('thread-column');
      container.appendChild(col);
    }

    // A group column shows a subset of the PARENT column's rows, so it shares
    // the parent's message thread outright: approvals, deletes, permissions and
    // context lookups inside it are the same operations they'd be one column to
    // the left. Only the list of rows differs.
    const messageThread = /** @type {MessageThread} */ (entry.groupId
      ? asArea(previous)?.getMessageThread()
      : (index === 0)
        ? conversation.rootMessageThread
        : createMessageThread(conversation, entry.container, /** @type {string} */ (entry.threadItemId)));

    // Set before the thread: setMessageThread configures the footer from it.
    col.setGroupItems(entry.groupId ? (entry.groupItems || []) : null);

    col.setMessageThread(messageThread);
    col.conversation = conversation;

    // Pre-sync selection BEFORE renderFromItems so a stale selection (from a
    // thread this column previously displayed) doesn't trigger clearSelection
    // and a re-entrant rebuild.
    col.presetSelectedItemId(selectedItemId || null);

    if (entry.groupId) {
      // Group column: the folded rows, in order. No thread context (it isn't a
      // thread) and no header — the rows carry their own identity.
      col.setThreadContext(null);
      col.hideThreadHeader();
      const groupItems = entry.groupItems || [];
      this._renderIfChanged(col, groupRenderKey(entry.groupId, groupItems), () => [...groupItems]);
    } else {
      // The root column has no thread context; a thread column's is its thread.
      if (index === 0) {
        col.setThreadContext(null);
        col.hideThreadHeader();
      } else {
        col.setThreadContext(entry.threadYMap || null);
      }

      const { items, key } = messageThread.renderSnapshot();
      this._renderIfChanged(col, key, () => items);

      // Show thread header with parent message thread for delete operations
      if (index > 0 && entry.threadYMap) {
        const goal = messageThread.goal;
        const parentMessageThread = (index === 1)
          ? conversation.rootMessageThread
          : asArea(previous)?.getMessageThread() ?? undefined;
        col.showThreadHeader(goal, entry.threadYMap, parentMessageThread, entry.viewItemId);
      }
    }

    // Restore scroll after render
    const area = col;
    window.requestAnimationFrame(() => {
      area.restoreScrollPosition();
    });

    // Set session/conversation on composer-box
    const composer = col.querySelector('composer-box');
    if (composer) {
      if (session) {
        composer.setSession(session);
      }
      composer.setConversation(conversation);
      composer.setMessageThread(messageThread);
    }

    return col;
  }

  /**
   * Hand `col` the items `getItems` returns, unless it was last rendered from
   * the same `key`.
   * @param {ConversationArea} col - The column.
   * @param {string} key - What the items are a function of.
   * @param {() => any[]} getItems - The items to render.
   * @private
   */
  _renderIfChanged(col, key, getItems) {
    if (this._renderedKeys.get(col) === key) return;
    this._renderedKeys.set(col, key);
    col.renderFromItems(getItems());
  }

  /**
   * Build (or reuse) the properties-panel column for chain entry `index`.
   * @param {object} args
   * @param {HTMLElement} args.container - The tab's column container; a new column is appended to it.
   * @param {HTMLElement|undefined} args.existing - The column already at this index, if any.
   * @param {ColumnChainEntry} args.entry - The chain entry.
   * @param {ColumnChainEntry|undefined} args.parentEntry - The chain entry to its left.
   * @param {Conversation} args.conversation - The tab's conversation.
   * @returns {PropertiesPanel} The properties-panel column element.
   */
  propertiesColumn({ container, existing, entry, parentEntry, conversation }) {
    let col = asPanel(existing);
    if (!col) {
      if (existing) existing.remove();
      col = document.createElement('properties-panel');
      container.appendChild(col);
    }

    // Debounce properties-panel content rendering so rapid arrow-key
    // navigation doesn't pay for markdown parsing / syntax highlighting
    // on every item traversed.  The panel DOM element exists immediately
    // for layout; expensive content waits for the selection to settle.
    // Skip entirely when the selection + conversation haven't changed.
    //
    // The debounce fires on the LEADING edge once the selection has been
    // still for PROPS_RENDER_IDLE_MS, so an isolated click pays nothing and
    // only the changes that follow it inside the churn window wait.
    // Idleness is measured from the last selection change, not from the last
    // render: under a held arrow key the trailing timer never fires, so a
    // render clock would read as idle mid-churn and let a full render through
    // every second — exactly what the debounce exists to prevent.
    const selectedItemId = entry.selectedItemId;
    const propInputKey = `${conversation.id}:${selectedItemId}`;
    if (this._renderedKeys.get(col) !== propInputKey) {
      this._renderedKeys.set(col, propInputKey);
      const panel = col;
      const renderContent = () => {
        this._pendingRenders.delete(panel);
        panel.setConversation(conversation);
        const parentMessageThread = parentEntry?.threadItemId
          ? createMessageThread(conversation, parentEntry.container, parentEntry.threadItemId)
          : conversation.rootMessageThread;
        panel.setMessageThread(parentMessageThread);
        panel.selectItem(selectedItemId ?? null);
        // Render settle: the properties panel paints either with the selection
        // key change or ~150ms after it. A flake that asserts the panel's
        // content before this fires shows the assert ts < props-render ts.
        recordTape('props-render', conversation.id, { selectedItemId });
      };
      const now = Date.now();
      // Rendering needs the shell the panel builds in connectedCallback, so a
      // column appended to a tab that isn't in the document yet keeps the timer.
      const wasStill = col.isConnected
        && now - this._propsLastChangeTime >= PROPS_RENDER_IDLE_MS;
      this._propsLastChangeTime = now;
      clearTimeout(this._pendingRenders.get(col)?.timer);
      this._pendingRenders.delete(col);
      if (wasStill) {
        renderContent();
      } else {
        this._pendingRenders.set(col, {
          render: renderContent,
          timer: setTimeout(renderContent, PROPS_RENDER_DEBOUNCE_MS),
        });
      }
    }

    return col;
  }

  /**
   * Render a properties panel's deferred content NOW, if it has some waiting.
   *
   * The debounce above trades panel freshness for not re-parsing markdown on
   * every item an arrow key passes over, which is the right trade for content
   * the user is only reading. It is the wrong trade for anything that ACTS on
   * what the panel shows: for up to PROPS_RENDER_DEBOUNCE_MS the panel's
   * buttons still belong to the previously selected item, so a command that
   * reaches for one gets the wrong item — a delete that silently takes the
   * row above the highlighted one. Such a command flushes first.
   * @param {HTMLElement|null} col - A properties-panel column, or null.
   */
  flushPropertiesRender(col) {
    const pending = col ? this._pendingRenders.get(col) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.render();
  }

  /**
   * Build (or reuse) the transaction-mode properties-panel column for a chain
   * entry: it renders the input/output blob for one LLM round-trip, and is a
   * leaf that never nests further.
   * @param {object} args
   * @param {HTMLElement} args.container - The tab's column container; a new column is appended to it.
   * @param {HTMLElement|undefined} args.existing - The column already at this index, if any.
   * @param {ColumnChainEntry} args.entry - The chain entry.
   * @param {Conversation} args.conversation - The tab's conversation.
   * @returns {PropertiesPanel} The transaction-mode properties-panel column element.
   */
  transactionColumn({ container, existing, entry, conversation }) {
    let col = asPanel(existing);
    if (!col) {
      if (existing) existing.remove();
      col = document.createElement('properties-panel');
      col.classList.add('properties-panel-transaction');
      container.appendChild(col);
    }
    const txInputKey = `${conversation.id}:${entry.transactionId}`;
    if (this._renderedKeys.get(col) !== txInputKey) {
      this._renderedKeys.set(col, txInputKey);
      col.setTransaction(conversation.id, /** @type {string} */ (entry.transactionId));
    }
    return col;
  }
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatDisplayPath, formatFileContentForLLM, basename } from 'juggler/item-utils';
import { extractFileSource } from 'juggler/registry';
import { createElement, injectStylesOnce } from 'juggler/ui';
import { addFilePath } from 'juggler/ui';
import { buildPickerPanel } from 'juggler/ui';
import { smartTruncate } from 'juggler/ui';
import { gitignoreDisabled } from './path-approval.js';
import { fetchLiveFile, liveFileSource, liveFileInfo, renderLiveFileBody } from '../lib/live-file.js';

/**
 * Safety ceiling (characters) on the file body a single pinned/@-mentioned file
 * contributes to the request. A pin is deliberate, so this is far more generous
 * than the per-`read`-call budget — it never touches a normal pinned file — but
 * a provider rejects any single content field past a hard byte limit (OpenAI:
 * 10 MiB) regardless of the token budget, and that rejection is not a
 * context-overflow the compaction/recovery ladder can resolve. The pin renders
 * live every turn, so an oversized or minified file (one enormous line slips the
 * per-line cap) would otherwise trip that limit on every turn until the pin is
 * removed. The ceiling stays under the byte limit even for worst-case
 * 4-byte UTF-8, and the truncation is applied to the rendered text itself so the
 * transaction view shows exactly what the model received.
 */
const MAX_PINNED_FILE_CHARS = 2_000_000;

/**
 * Ceiling (characters) on the snapshot a SEEDED item freezes into `this.data`.
 * Far tighter than {@link MAX_PINNED_FILE_CHARS}, and for a different reason:
 * that one is a send-time bound on a body that is never persisted, whereas this
 * text is written into the Yjs document, so it is replicated to every peer and
 * kept for the life of the conversation. An agents file is prose measured in
 * kilobytes; anything past this is not one, and truncating it beats syncing it.
 */
const MAX_SEEDED_SNAPSHOT_CHARS = 256_000;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Persisted Yjs shape for a pinned or seeded file/directory.
 *
 * For a PIN this is deliberately minimal: only the path and a directory marker.
 * The bytes are resolved live at send time (see {@link FetchResult}) and never
 * round-tripped through Yjs — a pin means "this file, kept current", so there is
 * nothing to freeze.
 *
 * A SEEDED item (`seeded: true`) is the other case, and it does persist bytes:
 * `content` holds the snapshot taken at the first transaction, bounded by
 * {@link MAX_SEEDED_SNAPSHOT_CHARS}.
 * @typedef {object} FileContentData
 * @property {string} path - File or directory path (trailing "/" for dirs)
 * @property {boolean} [isDirectory] - True when path refers to a directory
 * @property {boolean} [seeded] - Added by the session, not the user; freezes at the first transaction
 * @property {string} [content] - Frozen snapshot; seeded items only
 */

/** @typedef {import('../lib/live-file.js').LiveFileResult} LiveFileResult */

// ============================================================================
// FileContentContextItem
// ============================================================================

/**
 * FileContentContextItem - a "keep this file current" pin, or a frozen seed.
 *
 * SEMANTICS (see docs/extension_guide.md §"Pinned file content"):
 *  - Every USER-driven file reference is this item: the file picker / paperclip,
 *    and an `@file` mention (composer.js and scheduled-send-service.js both create
 *    one per mention). What is NOT this is a `read` TOOL CALL — that is
 *    ReadFileContextItem, an immutable record of bytes the model saw at one turn,
 *    living in the append-only history. The split is who asked, not how casually.
 *  - `data.seeded` splits this class in two, on exactly that question:
 *
 *    A PIN (no flag) is LIVE. It persists only a `path`; file bytes are NEVER
 *    persisted. Content is resolved from disk on every render. Because it rides
 *    `contextPosition:'prefix'` (leading messages, before the growing history),
 *    the render is byte-identical while the file is unchanged → the prompt cache
 *    hits and the pin is paid for once; a real change busts the cache from that
 *    point (one cold start) — which is exactly the point of a pin. No watcher:
 *    nothing is in flight between sends.
 *
 *    A SEEDED item is FROZEN — the CLAUDE.md / AGENTS.md a session adds to
 *    itself (session.js `addAIAssistantFiles`). Nobody asked for it, so it may
 *    not spend the user's time: it snapshots once into `data.content` and serves
 *    that for the life of the conversation. Live would be the expensive default
 *    here, because the agent editing its own agents file is routine — the file
 *    it is most often asked to update — and every such edit would cold-start the
 *    whole cached prefix. Freezing also stops the same bytes being sent twice:
 *    after such an edit they are already in the history, verbatim, in the
 *    tool_use pair that wrote them. Skills and memory freeze for the sibling
 *    reason (memory-context-item.js).
 *  - The snapshot is taken at the FIRST TRANSACTION, not at add-time: a
 *    conversation can sit open for an hour before its first send, and what
 *    belongs in context is what was true when work began. `contextParams.forRequest`
 *    is what distinguishes a dispatch render from a properties-panel one.
 *  - The properties panel always reads LIVE. For a pin there is nothing to be
 *    stale against; for a seeded item it is deliberately showing the file rather
 *    than the snapshot, says so, and offers a refresh that re-freezes on demand.
 * @class
 * @augments ContextItem
 */
class FileContentContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'file-content',
    name: 'File Content',
    version: '1.0.0',
    description: 'Add file content to context',
    author: 'Juggler Team',
    idPrefix: 'FILE',
    userAddable: true,
    watchesFileChanges: false,
    contextPosition: /** @type {const} */ ('prefix'),
    exampleData: {
      path: 'src/main.go',
      isDirectory: false,
      seeded: false
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-document' };
  }

  /**
   * Status UI configuration.
   *
   * Sync only — no disk read here (called on every render). Shows just
   * the filename / folder name; per-fetch details (line count, warnings)
   * live in the properties panel, which is async.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status UI config
   */
  getStatusUI() {
    if (!this.data.path) {
      return { typeName: 'File Content', summary: 'No file selected' };
    }
    if (this.data.isDirectory) {
      const displayPath = basename(this.data.path) || this.data.path;
      return { typeName: 'Folder', summary: `${displayPath}/`, status: 'success' };
    }
    const filename = basename(this.data.path) || this.data.path;
    return { typeName: 'File Content', summary: filename, status: 'success' };
  }

  /** @returns {Promise<Record<string,string>|null>} Params for the new item, or null if cancelled */
  static async showAddDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'pp-overlay';
    document.body.appendChild(overlay);

    const { element, promise, cancel } = buildPickerPanel({
      title: 'Add File Content',
      placeholder: 'File path…',
      dirsOnly: false,
      confirmLabel: 'Add',
      showCancel: true,
    });
    overlay.appendChild(element);

    /** @param {KeyboardEvent} e */
    const onKeydown = (e) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });

    const chosen = await promise;
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();

    return chosen ? { path: chosen } : null;
  }

  /**
   * Check if new params can be merged with an existing item
   *
   * Files with the same path are deduplicated - reuse existing item.
   * @static
   * @param {Record<string, any>} newParams - Parameters for the new item request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null if no merge possible
   */
  static mergeOrReplace(newParams, existingItems) {
    if (!newParams.path) {
      return null;
    }

    // Normalize path for comparison
    const newPath = newParams.path.replace(/^\/+/, '');

    const existing = existingItems.find(f => {
      const data = /** @type {FileContentData} */ (f.data);
      const existingPath = (data.path || '').replace(/^\/+/, '');
      return existingPath === newPath;
    });

    if (existing) {
      return { action: 'reuse', item: existing };
    }

    return null;
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    /**
     * TTL cache for live fetches. See {@link _fetchLive}.
     * @type {{path: string, workspaceId: string, ts: number, pending: Promise<LiveFileResult>|null, result: LiveFileResult|null}|null}
     * @private
     */
    this._lastFetch = null;

    // Initialize data with defaults. The pin persists only path + a
    // directory marker; actual bytes are resolved via _fetchLive().
    /** @type {FileContentData} */
    const defaults = { path: '', isDirectory: false };
    this.data = { ...defaults, ...this.data };
    FileContentContextItem._stripLegacyFields(this.data);
  }

  /**
   * Restore item from JSON. Strips any legacy snapshot fields that older
   * conversations may have persisted (content, size, totalLines, …) so a
   * pin's Yjs footprint stays bounded regardless of file size — a pin persists
   * only its path; bytes are resolved live.
   * @param {import('juggler/context-item').ItemJSON} json
   */
  fromJSON(json) {
    super.fromJSON(json);
    FileContentContextItem._stripLegacyFields(this.data);
  }

  /**
   * Remove legacy/transient snapshot fields from a data object in place.
   *
   * `content` is stripped for a PIN, whose footprint is a path and nothing else,
   * and kept for a SEEDED item, where it is the live snapshot rather than a
   * leftover. Getting that exception wrong is silent: the item would reload with
   * no snapshot, take a fresh one, and behave as a live pin again — which is the
   * whole bug this split exists to prevent. The other fields are stale companions
   * of the old snapshot format and are dead weight for both kinds.
   * @param {Record<string, unknown>} data - The data object to clean
   * @private
   */
  static _stripLegacyFields(data) {
    const dead = ['language', 'size', 'totalLines', 'lineOffset',
      'lineCount', 'exists', 'warning', 'readMode'];
    if (!data.seeded) dead.push('content');
    for (const k of dead) {
      if (k in data) delete data[k];
    }
  }

  /**
   * Execute tool call - record the path, and whether this was seeded.
   *
   * No content fetch here, for either kind. A pin resolves live at send time; a
   * seeded item takes its snapshot at the first transaction, which is later than
   * this and deliberately so (see the class comment). The properties panel and
   * any UI badge that needs a line count will fetch on demand.
   * @param {string} _toolName - Tool name (unused, only one tool)
   * @param {Record<string, any>} params - Tool parameters
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, params) {
    if (!params.path || typeof params.path !== 'string') {
      throw new Error('Missing required parameter: path');
    }
    this.data.path = params.path;
    if (params.seeded) this.data.seeded = true;
  }

  /**
   * Fetch live file/directory contents.
   *
   * Returns a transient {@link LiveFileResult}; does NOT touch `this.data` —
   * writing what disk said back into the item would mutate the Yjs document
   * across peers on every change to the file.
   *
   * A 500ms TTL cache is kept in `this._lastFetch` so a send-time read and
   * a properties-panel render in the same tick share one round-trip.
   * Concurrent callers join the same in-flight promise.
   * @returns {Promise<LiveFileResult>} Live file or directory contents
   * @private
   */
  async _fetchLive() {
    const path = this.data.path || '';
    if (!path) {
      return { path: '', isDirectory: false, exists: false, content: '' };
    }

    const now = Date.now();
    // The tree is half the key. A relative path means a different file in each
    // workspace, so a conversation that has just moved would otherwise be served
    // the tree it left for the rest of the window — and keying on the path alone
    // cannot be fixed by telling the item the binding moved, because in a second
    // window the move arrives as a document update with nothing to tell.
    const where = this.getWorkspaceId();
    if (this._lastFetch && this._lastFetch.path === path && this._lastFetch.workspaceId === where) {
      if (this._lastFetch.pending) return this._lastFetch.pending;
      if (this._lastFetch.result && (now - this._lastFetch.ts) < 500) {
        return this._lastFetch.result;
      }
    }

    const pending = this._doFetch(path);
    this._lastFetch = { path, workspaceId: where, ts: now, pending, result: null };
    try {
      const result = await pending;
      this._lastFetch = { path, workspaceId: where, ts: Date.now(), pending: null, result };
      return result;
    } catch (err) {
      this._lastFetch = null;
      throw err;
    }
  }

  /**
   * Underlying single-shot fetch. Always returns a usable {@link LiveFileResult}
   * (errors collapse to `exists:false`); callers should not catch.
   *
   * A pin is always user-initiated — the user explicitly chose this path via
   * `@`-mention or the file picker, so it may legitimately point outside the
   * project root — and the shared reader says so on its behalf.
   *
   * The read carries this item's scope, so a relative path resolves in the tree
   * its conversation works in. That is what makes a seeded AGENTS.md the one the
   * session probed for, rather than the same name in the project.
   * @param {string} path - File or directory path to load
   * @returns {Promise<LiveFileResult>} Fetched result; `exists:false` on error
   * @private
   */
  async _doFetch(path) {
    return fetchLiveFile(path, { noIgnore: gitignoreDisabled(this), ops: this.ops });
  }

  /**
   * Build the FileSource for a live fetch result, for either realm's use of it
   * (the panel renders it, createContextText extracts from it).
   * @param {LiveFileResult} r - A live fetch result
   * @returns {import('juggler/file-source').FileSource} The file, ready to render or extract
   * @private
   */
  _liveFileSource(r) {
    return liveFileSource(r, this.getAbsolutePath() || r.path || '', {
      conversationId: this.conversation?.id,
    });
  }

  /**
   * Get the full absolute path by resolving a relative one against the tree this
   * conversation works in — the same root the read itself resolves against, so
   * the path shown and the bytes shown are the same file.
   * @returns {string} Absolute file path, or the raw path when there is no root
   *   to resolve against (no project, or a binding that cannot be honoured).
   */
  getAbsolutePath() {
    const p = this.data.path || '';
    if (!p) return '';
    if (p.startsWith('/')) return p;
    const root = this.getWorkspaceRoot();
    if (root) return `${root.replace(/\/+$/, '')}/${p}`;
    return p;
  }

  /**
   * Get human-readable title
   * @returns {string} Item title
   */
  getTitle() {
    if (!this.data.path) {
      return 'File Content';
    }
    if (this.data.isDirectory) {
      return formatDisplayPath(this.data.path.replace(/\/+$/, '')) + '/';
    }
    return formatDisplayPath(this.data.path);
  }

  /**
   * Get brief summary string for transaction display
   * @returns {string} Brief summary
   */
  getBriefSummary() {
    if (!this.data.path) {
      return 'Empty file content';
    }
    if (this.data.isDirectory) {
      return `Directory listing: ${this.data.path}`;
    }
    return formatDisplayPath(this.data.path);
  }

  /**
   * Create properties panel view.
   *
   * The panel always shows LIVE disk contents. For a pin that is simply the
   * truth — there is no snapshot to be stale against. For a seeded item it is a
   * deliberate mismatch: the panel is the curation UI, so it must show what the
   * file actually says, not what this conversation happens to be reading. A note
   * states the difference and offers the refresh, because a panel that silently
   * showed one thing while the model read another would be the worst of both.
   *
   * We render a `Loading…` placeholder synchronously, kick off a `_fetchLive()`
   * (which reuses the 500ms TTL cache from any just-completed send), and swap the
   * result in when it resolves.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'file-content-expanded');

    // Expose item identity + an unpin hook so the file-path right-click menu
    // (see properties-panel-helpers.js) can offer "Remove from context". The
    // closure is local UI wiring, not persisted state — removeContextItem
    // drives the Yjs mutation through the message thread (single owner).
    if (this.id) {
      container.dataset.contextItemId = this.id;
      /** @type {any} */ (container)._jugglerRemoveFromContext = () => {
        /** @type {any} */ (this.messageThread)?.removeContextItem?.(this.id);
      };
    }

    const headerHost = createElement('div', 'file-content-header-host');
    container.appendChild(headerHost);

    const body = createElement('div', 'file-content-body');
    container.appendChild(body);

    addFilePath(headerHost, this.getAbsolutePath() || 'No file', undefined,
      { pin: this.getAbsolutePath() });

    if (!this.data.path) {
      body.appendChild(createElement('div', 'file-content-loading', 'No file selected'));
      return container;
    }

    body.appendChild(createElement('div', 'file-content-loading', 'Loading…'));

    this._fetchLive().then(r => {
      // Swap body. Replace the header info with the just-fetched stats.
      headerHost.replaceChildren();
      const absolute = this.getAbsolutePath() || r.path || '';
      addFilePath(headerHost, absolute || 'No file', liveFileInfo(r), { pin: absolute });

      if (this.data.seeded) {
        body.replaceChildren();
        body.appendChild(this._buildSeededNote(container));
      }

      // The header above already carries the path and the current stats, so the
      // body renders content alone.
      const fileBody = this.data.seeded ? createElement('div') : body;
      if (this.data.seeded) body.appendChild(fileBody);
      renderLiveFileBody(fileBody, r, {
        absolutePath: this.getAbsolutePath() || r.path || this.data.path,
        conversationId: this.conversation?.id,
      });
    }).catch(err => {
      console.error('[FileContentContextItem] properties panel fetch failed:', err);
      body.replaceChildren(createElement('div', 'file-content-not-found',
        `Failed to load: ${this.data.path}`));
    });

    return container;
  }

  /**
   * Create context text for the LLM.
   *
   * A PIN resolves LIVE from disk every time the prompt is built. Because it
   * rides `contextPosition:'prefix'` (before the growing history), an unchanged
   * file renders byte-identically each turn → the prompt cache hits; only a
   * genuine change busts it. Disk bytes are never persisted to Yjs.
   *
   * A SEEDED item serves its frozen snapshot, and takes that snapshot here on
   * the first render where `contextParams.forRequest` is set — the first actual
   * transaction. Display renders (the properties panel's token chip) deliberately
   * do not latch it, so looking at the item cannot decide what it is going to say.
   * @param {import('juggler/context-item').ContextParams} [contextParams] - Context parameters
   * @returns {Promise<string>} Formatted file content for LLM context
   */
  async createContextText(contextParams) {
    if (!this.data.path) {
      return '';
    }

    if (this.data.seeded) {
      if (typeof this.data.content === 'string') return this.data.content;
      const text = FileContentContextItem._boundSnapshot(await this._renderLive());
      // Latch only on a real request. Until one arrives this renders live, so a
      // conversation left open all morning still snapshots the file as it stands
      // when work starts rather than as it stood when the tab was opened.
      //
      // The announcement is what makes the snapshot a snapshot. This instance is
      // a transient wrapper and its `data` a detached copy of what the document
      // holds, so the bytes reach the document only through the change handler
      // the thread wires up; without it they would last exactly as long as this
      // object, and the next turn would render a fresh wrapper and read the file
      // again. It happens once per item: every later render is served by the
      // branch above and has nothing to say. What is stored is what is sent —
      // `_boundSnapshot` is applied before both.
      if (contextParams?.forRequest) {
        this.data.content = text;
        this.onContentChange?.();
      }
      return text;
    }

    return this._renderLive();
  }

  /**
   * Take the snapshot again, from the file as it stands now.
   *
   * The only way a seeded item's frozen bytes are ever replaced: the properties
   * panel's Update and a conversation moving to another tree both arrive here,
   * so neither can produce bytes the other would not have. An item that has not
   * latched anything yet is left alone — it renders live until its first
   * transaction, which will snapshot the right tree by itself.
   * @returns {Promise<boolean>} Whether the snapshot changed.
   */
  async refreezeSnapshot() {
    if (!this.data.seeded || typeof this.data.content !== 'string') return false;
    // A file that is not there reads as "File does not exist", which is an
    // answer and not a snapshot. Writing it over the real one would destroy the
    // conversation's only copy of something its user may well still want, so a
    // snapshot is only ever replaced by another snapshot. The read is the one
    // `_renderLive` goes on to share through the TTL cache, not a second trip.
    if (!(await this._fetchLive()).exists) return false;
    const text = FileContentContextItem._boundSnapshot(await this._renderLive());
    if (text === this.data.content) return false;
    this.data.content = text;
    // An item instance is a transient wrapper and its `data` a detached copy of
    // what the document holds, so a snapshot reaches the document only through
    // the change handler the thread wires up. Without this the new bytes would
    // live exactly as long as this object.
    this.onContentChange?.();
    return true;
  }

  /**
   * Follow the conversation into the tree it has moved to.
   *
   * A seeded snapshot is this class's one piece of materialised state. The path
   * beside it resolves live, so after a move the item already names the right
   * file in the new tree while serving the bytes of the old one — the model
   * reading one tree's instructions while working in another.
   * @returns {Promise<void>} When the snapshot is of the tree it now works in.
   */
  async onWorkspaceChanged() {
    await this.refreezeSnapshot();
  }

  /**
   * Bound a snapshot to what is reasonable to keep in the document.
   *
   * Applied to the text BEFORE it is both stored and returned, so the snapshot
   * and the bytes the model reads are the same thing — a bound applied only on
   * the way into `data` would make the first turn and every later one differ,
   * which is precisely the cold start the freeze exists to avoid.
   * @param {string} text - The rendered context text
   * @returns {string} The text, truncated if it exceeded the ceiling
   * @private
   */
  static _boundSnapshot(text) {
    const { content, truncated } = smartTruncate(text, { maxChars: MAX_SEEDED_SNAPSHOT_CHARS });
    return truncated
      ? content + `\n\n(Truncated from ${text.length} to ${content.length} chars)`
      : text;
  }

  /**
   * Render the file's current contents as LLM context text.
   *
   * The shared body of a pin's every-turn render, a seeded item's one-off
   * snapshot, and the re-snapshot behind the properties panel's refresh — so all
   * three are byte-identical for the same file, and a refresh cannot quietly
   * produce something a send would have rendered differently.
   * @returns {Promise<string>} Formatted file content for LLM context
   * @private
   */
  async _renderLive() {
    const r = await this._fetchLive();

    if (!r.exists) {
      return `File does not exist: ${r.path || this.data.path}`;
    }

    if (r.isDirectory) {
      return `Directory listing of ${r.path}:\n${r.content || '(empty)'}`;
    }

    if (r.warning) {
      return `File ${r.path}: ${r.warning}`;
    }

    // A file whose bytes are not text carries no `content` of its own — its
    // viewer is what turns it into something the model can read (a PDF's pages).
    // Without this the pin would render as formatFileContentForLLM's "exists but
    // is empty" warning, telling the model the opposite of the truth about a
    // file the user deliberately pinned. Mirrors ReadFileContextItem.execute,
    // except that a pin is live: there is nothing persisted to extract once, so
    // the extraction runs with the read, every turn.
    if (r.isBinary && !r.content) {
      const extracted = await extractFileSource(this._liveFileSource(r), {
        maxChars: MAX_PINNED_FILE_CHARS,
        conversationId: this.conversation?.id,
      });
      if (extracted.text) return extracted.text;
      if (extracted.warning) return `File ${r.path}: ${extracted.warning}`;
    }

    const formatted = formatFileContentForLLM({
      content: r.content || '',
      path: r.path,
      lineOffset: r.lineOffset || 1,
      lineCount: r.lineCount,
      totalLines: r.totalLines,
      readMode: r.readMode
    });
    // Backstop against a single oversized field tripping the provider's per-field
    // byte cap (see MAX_PINNED_FILE_CHARS). Truncating the rendered text keeps the
    // transaction view and the wire identical.
    const { content: bounded, truncated } = smartTruncate(formatted, { maxChars: MAX_PINNED_FILE_CHARS });
    return truncated
      ? bounded + `\n\n(File content truncated from ${formatted.length} to ${bounded.length} chars to fit the request)`
      : formatted;
  }

  /**
   * Build the note that explains a seeded item's frozen state, and the update
   * affordance when there is something to update to.
   *
   * The update control appears only once the file has actually diverged from the
   * snapshot: an "Update" that would change nothing is a button that teaches the
   * user it does nothing. The re-read it costs is stated next to it rather than
   * discovered afterwards.
   * @param {HTMLElement} container - The panel container, re-rendered after an update
   * @returns {HTMLElement} The note element
   * @private
   */
  _buildSeededNote(container) {
    const note = createElement('div', 'file-content-seeded-note');

    if (typeof this.data.content !== 'string') {
      note.appendChild(createElement('div', 'file-content-seeded-line',
        'Added at the start of this conversation. It is frozen as it stands when the first message is sent.'));
      return note;
    }

    note.appendChild(createElement('div', 'file-content-seeded-line',
      'Added at the start of this conversation and frozen when it began, so that editing this file does not make the conversation re-read itself. The file below is live.'));

    // Offer the update only against a real difference.
    this._renderLive().then(live => {
      if (!note.isConnected) return;
      const current = FileContentContextItem._boundSnapshot(live);
      if (current === this.data.content) return;

      const row = createElement('div', 'file-content-seeded-actions');
      row.appendChild(createElement('span', 'file-content-seeded-changed',
        'The file has changed since. Updating re-reads the conversation once.'));

      const update = document.createElement('button');
      update.className = 'file-content-seeded-update';
      update.textContent = 'Update';
      update.setAttribute('aria-label', 'Update the frozen copy of this file');
      update.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        update.disabled = true;
        await this.refreezeSnapshot();
        container.replaceChildren(...Array.from(this.createPropertiesPanelElement().childNodes));
      });
      row.appendChild(update);
      note.appendChild(row);
    }).catch(() => {
      // Couldn't read the file to compare; the note above still stands and the
      // live body below will report the failure itself.
    });

    return note;
  }

  // ========== PRIVATE HELPERS ==========

  /**
   * Get filename from path
   * @private
   * @param {string} path - File path
   * @returns {string} Filename portion of path
   */
  _getFilename(path) {
    return basename(path) || path;
  }
}

const FILE_CONTENT_STYLES = `
.file-content-seeded-note {
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 0 0 0.5rem 0;
  font-size: 0.75rem; line-height: 1.5;
  color: var(--text-tertiary, var(--text-secondary));
}
.file-content-seeded-actions {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
}
.file-content-seeded-changed { color: var(--text-secondary); }
.file-content-seeded-update {
  padding: 0.125rem 0.625rem; border-radius: 4px;
  font-size: 0.75rem; cursor: pointer;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.3));
  background: var(--bg-raised, rgba(127, 127, 127, 0.15));
  color: var(--text-primary);
}
.file-content-seeded-update:hover:not(:disabled) { background: var(--bg-hover, rgba(127, 127, 127, 0.25)); }
.file-content-seeded-update:disabled { opacity: 0.5; cursor: default; }
`;

injectStylesOnce('file-content-styles', FILE_CONTENT_STYLES);

export default FileContentContextItem;

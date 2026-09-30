//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { formatBytes } from '../../utils/format.js';
import { addFilePath } from '../../utils/properties-panel-helpers.js';
import { fetchJson } from '../../services/http.js';
import { apiUrl } from '../../utils/api-url.js';

/** Polling interval (ms) for tailing the selected log while the Logs tab is open. */
const LOGS_POLL_MS = 2000;

/**
 * Cap on the characters kept in the log viewer. Incremental appends never stop,
 * so a chatty log tailed for a long sitting would grow the <pre> unbounded;
 * once past this we drop the oldest characters (a whole-line boundary) to keep
 * the DOM bounded. Decoupled from the byte offset (which tracks file position),
 * so trimming what's shown never affects tailing.
 */
const LOGS_VIEWER_MAX_CHARS = 512 * 1024;

/**
 * Logs tab: lists the current session's log files in a grouped picker, shows the
 * selected file's path with the standard copy + reveal control, and tails the
 * file live. Self-fetching (independent of the shared loadConfig), so it works
 * even when opened directly on first load; its tail poll runs only while the tab
 * is visible.
 */
export class LogsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {number|undefined} @private - setInterval id for the Logs tab's tail poll. */
    this._logsPollId = undefined;
    /** @type {any[]} @private - Session log files reported by GET /api/logs. */
    this._logFiles = [];
    /** @type {string} @private - Absolute path of the log file shown in the viewer. */
    this._selectedLogPath = '';
    /** @type {number} @private - Byte offset already loaded into the viewer for the selected log. */
    this._logOffset = 0;
    /** @type {string} @private - Signature of the last-rendered picker file set (rebuild guard). */
    this._logFilesKey = '';
    /** @type {string} @private - Path the file-path control was last rendered for (rebuild guard). */
    this._filePathPath = '';
    /** @type {boolean} @private - True while a log tail fetch is in flight, so overlapping poll ticks don't double-append. */
    this._logTailBusy = false;
    /** @type {Promise<void>|null} @private - Resolves when this showing's first list+tail fetch has landed. */
    this._ready = null;
  }

  /**
   * Wire the persistent picker `change` listener (called from the shell's
   * render()). The <select> is persistent — only its <option>s are rebuilt — so
   * this one listener survives every list refresh.
   */
  render() {
    const logsPicker = this.host.querySelector('#logs-picker');
    if (logsPicker) {
      logsPicker.addEventListener('change', (e) =>
        this._selectLog(/** @type {HTMLSelectElement} */ (e.target).value));
    }
  }

  /** Tab became visible: load the logs and arm the tail poll. */
  show() {
    // The Logs tab fetches its own data (independent of loadConfig), so it
    // works even when opened directly on first load. The promise is kept so a
    // deep link arriving right behind this call can wait for the list.
    this._ready = this._openLogsTab();
    this._logsPollId = setInterval(() => this._pollLogTail(), LOGS_POLL_MS);
  }

  /**
   * Deep-link into this tab: show one conversation's log instead of the default
   * server.log.
   *
   * A deep link lands here immediately after `show()`, whose fetch is
   * deliberately not awaited — so without this wait there would be no file list
   * to resolve the id against and the tab would sit on server.log. The conv id
   * is the stable half of the file name (`<name>--<convID>.log`), so a renamed
   * conversation still matches.
   * @param {string} conversationId - Conversation whose log to select
   * @returns {Promise<boolean>} True if that log existed and is now shown
   */
  async revealEntry(conversationId) {
    if (!conversationId) return false;
    await this._ready;
    const file = this._logFiles.find(
      (f) => f.group === 'conversations' && String(f.name).endsWith(`${conversationId}.log`));
    if (!file) return false;
    this._selectLog(file.path);
    return true;
  }

  /** Tab hidden: stop the tail poll. */
  hide() {
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
  }

  /** Panel closed: stop the tail poll. */
  close() {
    this.hide();
  }

  /**
   * Open (or re-open) the Logs tab: fetch the current session's log list,
   * populate the picker, and load the selected file's tail. Safe to call
   * repeatedly — it preserves the current selection across refreshes. Shares the
   * tail-busy guard with the poll so the two never overlap.
   * @private
   */
  async _openLogsTab() {
    if (this._logTailBusy) return;
    this._logTailBusy = true;
    try {
      await this._refreshLogList();
      await this._fetchLogContent(true);
    } finally {
      this._logTailBusy = false;
    }
  }

  /**
   * Fetch the session log list and reconcile the UI: toggle the empty state,
   * keep (or default) the selection, and rebuild the picker only when the file
   * set actually changed so a 2s poll never disrupts an open dropdown.
   * @private
   */
  async _refreshLogList() {
    /** @type {any[]} */
    let files = [];
    // Treat a failed fetch as "no logs" and fall through to the empty state.
    const data = await fetchJson(apiUrl('/logs'), { fallback: null });
    if (data) files = data.files || [];
    this._logFiles = files;

    const hasFiles = files.length > 0;
    const empty = this.host.querySelector('#logs-empty');
    const controls = this.host.querySelector('#logs-controls');
    const viewer = this.host.querySelector('#logs-viewer');
    if (empty) /** @type {HTMLElement} */ (empty).hidden = hasFiles;
    if (controls) /** @type {HTMLElement} */ (controls).hidden = !hasFiles;
    if (viewer) /** @type {HTMLElement} */ (viewer).hidden = !hasFiles;

    // Keep the current selection; if it vanished (log rotated away) or is unset,
    // default to server.log, then the first file.
    if (!files.some((f) => f.path === this._selectedLogPath)) {
      const preferred = files.find((f) => f.name === 'server.log') || files[0];
      this._selectedLogPath = preferred ? preferred.path : '';
      this._logOffset = 0;
    }

    // Rebuild the picker only when the set of files changed (added/removed),
    // and the path control only when the selection changed — so <reveal-button>
    // and the <option>s aren't recreated on every tick.
    const key = files.map((f) => f.path).join('\n');
    if (key !== this._logFilesKey) {
      this._logFilesKey = key;
      this._renderLogPicker();
    }
    if (this._selectedLogPath !== this._filePathPath) {
      this._filePathPath = this._selectedLogPath;
      this._updateLogFilePathControl();
    }
  }

  /**
   * Rebuild the picker's <option>s from this._logFiles, grouped by kind
   * (Server / Conversations / App) with a size hint per entry, reflecting the
   * current selection. The change listener lives on the persistent <select>
   * (see render()), so it is not re-wired here.
   * @private
   */
  _renderLogPicker() {
    const picker = /** @type {HTMLSelectElement|null} */ (this.host.querySelector('#logs-picker'));
    if (!picker) return;
    picker.textContent = '';

    for (const group of [
      { key: 'server', label: 'Server' },
      { key: 'conversations', label: 'Conversations' },
      { key: 'app', label: 'App' },
    ]) {
      const inGroup = this._logFiles.filter((f) => f.group === group.key);
      if (inGroup.length === 0) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const file of inGroup) {
        const opt = document.createElement('option');
        opt.value = file.path;
        opt.textContent = `${file.name} — ${formatBytes(file.size)}`;
        if (file.path === this._selectedLogPath) opt.selected = true;
        optgroup.appendChild(opt);
      }
      picker.appendChild(optgroup);
    }
  }

  /**
   * Switch the viewer to a different log file: reset the tail offset, clear the
   * viewer, refresh the path control, and load the new file's tail.
   *
   * The picker is put in step here rather than by the caller, because this is
   * also reached from a deep link — where the <select> is still showing whatever
   * was selected before. From the `change` listener it is already correct and
   * the write is a no-op.
   * @param {string} path - Absolute path of the newly-selected log
   * @private
   */
  _selectLog(path) {
    if (!path || path === this._selectedLogPath) return;
    this._selectedLogPath = path;
    this._logOffset = 0;
    const picker = /** @type {HTMLSelectElement|null} */ (this.host.querySelector('#logs-picker'));
    if (picker) picker.value = path;
    const viewer = this.host.querySelector('#logs-viewer');
    if (viewer) viewer.textContent = '';
    this._filePathPath = path;
    this._updateLogFilePathControl();
    this._fetchLogContent(true);
  }

  /**
   * Render the standard file-path control (copy + reveal-in-Finder) for the
   * selected log into the #logs-filepath row, replacing any previous one.
   * @private
   */
  _updateLogFilePathControl() {
    const host = this.host.querySelector('#logs-filepath');
    if (!host) return;
    host.textContent = '';
    if (this._selectedLogPath) addFilePath(/** @type {HTMLElement} */ (host), this._selectedLogPath);
  }

  /**
   * Fetch the selected log from the current offset and render it. On `reset`
   * (file switch / first open) or a server-reported replaced window (initial
   * tail / rotation) the viewer content is replaced; otherwise the newly
   * appended bytes are appended. Autoscroll sticks to the bottom only when the
   * user was already there, so scrolling up to read history isn't interrupted.
   * @param {boolean} [reset=false]
   * @private
   */
  async _fetchLogContent(reset = false) {
    const path = this._selectedLogPath;
    const viewer = this.host.querySelector('#logs-viewer');
    if (!path || !viewer) return;

    const offset = reset ? 0 : this._logOffset;
    // A failure is transient; the next poll retries.
    const data = await fetchJson(apiUrl(`/logs/content?path=${encodeURIComponent(path)}&offset=${offset}`),
      { fallback: null });
    if (!data) return;
    // Drop a stale response for a file the user has since switched away from.
    if (path !== this._selectedLogPath) return;

    const pinned = this._isViewerAtBottom(/** @type {HTMLElement} */ (viewer));
    if (reset || data.replaced) {
      viewer.textContent = data.content;
    } else if (data.content) {
      viewer.appendChild(document.createTextNode(data.content));
    }
    this._trimViewer(/** @type {HTMLElement} */ (viewer));
    this._logOffset = data.size;
    if (reset || pinned) viewer.scrollTop = viewer.scrollHeight;
  }

  /**
   * Keep the viewer's text bounded (see LOGS_VIEWER_MAX_CHARS): when it grows
   * past the cap, drop the oldest characters, rounding forward to the next line
   * boundary so a partial first line isn't left dangling. No-op below the cap.
   * @param {HTMLElement} viewer
   * @private
   */
  _trimViewer(viewer) {
    const text = viewer.textContent || '';
    if (text.length <= LOGS_VIEWER_MAX_CHARS) return;
    let cut = text.length - LOGS_VIEWER_MAX_CHARS;
    const nl = text.indexOf('\n', cut);
    if (nl !== -1) cut = nl + 1;
    viewer.textContent = text.slice(cut);
  }

  /**
   * One tail poll while the Logs tab is open. Tails only the selected file's
   * newly-appended bytes — one cheap incremental read. The list is refreshed on
   * open (not every tick), so new files / size changes are picked up on reopen
   * rather than costing a second request per poll. The in-flight guard drops a
   * tick if the previous poll's fetch hasn't returned, so a slow response can't
   * double-append. When nothing is selected yet (opened before any log existed),
   * it keeps re-listing until a file appears.
   * @private
   */
  async _pollLogTail() {
    if (this._logTailBusy) return;
    this._logTailBusy = true;
    try {
      if (this._selectedLogPath) {
        await this._fetchLogContent(false);
      } else {
        await this._refreshLogList();
        await this._fetchLogContent(true);
      }
    } finally {
      this._logTailBusy = false;
    }
  }

  /**
   * Whether the viewer is scrolled to (within a line or two of) the bottom —
   * the condition under which new log lines should keep it pinned there.
   * @param {HTMLElement} el
   * @returns {boolean} True when pinned to (or within a couple of lines of) the bottom.
   * @private
   */
  _isViewerAtBottom(el) {
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
  }
}

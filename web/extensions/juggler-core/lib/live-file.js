//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a path off disk and showing it, for the surfaces that mean "this file,
 * as it is now" rather than "these bytes, as they were then".
 *
 * Two of those exist: the pinned file-content context item, whose panel and
 * every prompt it rides in resolve live, and the File pin on the pinboard. They
 * agree on what a live file is — the same directory probe, the same
 * `userInitiated` escape hatch, the same viewer for whatever is on disk — so they
 * share the reading and the rendering here. They share nothing else: a pin on the
 * board is not a context item, has no Yjs behind it, and is visible to nobody but
 * the person looking at it.
 * @module lib/live-file
 */

import { readFile, getTree, stat } from 'juggler/ops';
import { formatFileSize, injectFileContentStyles } from 'juggler/item-utils';
import { fileSourceFromReadResult } from 'juggler/file-source';
import { createElement } from 'juggler/ui';

injectFileContentStyles();

/**
 * What one live read found. Transient by construction: it is what disk said at
 * the moment it was asked, and it is never written to durable state anywhere.
 * @typedef {object} LiveFileResult
 * @property {string} path - Resolved (possibly absolute) path
 * @property {boolean} isDirectory - True if the path is a directory listing
 * @property {boolean} exists - False if the file/dir could not be read
 * @property {string} content - File body or rendered tree listing
 * @property {string} [language] - Detected language identifier for syntax highlight
 * @property {number} [size] - File size in bytes (files only)
 * @property {number} [totalLines] - Line count for files, entry count for dirs
 * @property {number} [lineOffset] - First line number of `content` (1-indexed)
 * @property {number} [lineCount] - Number of lines actually included in `content`
 * @property {string|null} [warning] - Backend warning (e.g. binary file)
 * @property {string} [readMode] - Human-readable read-mode description
 * @property {string} [mime] - Mime type reported by the read op ('' when unknown)
 * @property {boolean} [isBinary] - True when the bytes are not text; the file's viewer decides what to do with them
 */

/**
 * Read a path as it stands. Always resolves to a usable {@link LiveFileResult} —
 * a failure collapses to `exists: false` rather than throwing, because every
 * caller here has somewhere to show "not found" and nowhere to show a stack.
 *
 * The read is user-initiated by construction: someone named this path, in a
 * picker or an `@`-mention or by pinning it. That is what `userInitiated` says to
 * the read/tree ops, and it is what lets the path resolve WITHOUT the
 * working-directory containment check — for a relative `../…` as much as for an
 * absolute one. Without it a path outside the project root fails as "path is
 * outside working directory", which the panel would render as a misleading
 * "File not found".
 *
 * Only the read op takes a signal; `stat` and `getTree` do not, so a caller that
 * can be torn down mid-read must check its own signal before using what comes
 * back rather than assuming this rejected.
 *
 * A relative path is resolved by whoever performs the read, so `ops` decides
 * WHICH tree this is a live view of. A context item passes its own scoped ops
 * and gets its conversation's workspace; a pin passes none and gets the project,
 * which is what a pin is — board furniture showing the project, not a view into
 * whatever conversation happens to be open.
 * @param {string} path - File or directory path. A trailing "/" means directory.
 * @param {{signal?: AbortSignal, noIgnore?: boolean, head?: number, whole?: boolean,
 *   userInitiated?: boolean, ops?: import('juggler/ops').BoundOps}} [options] - Abort
 *   signal for the file read, whether a directory listing ignores .gitignore, a line
 *   ceiling for a caller showing a preview rather than the whole file, whether the
 *   path came from a user gesture, `whole` for a caller that wants every line, and
 *   the scope to read in. With neither of the line options the read op's own
 *   default cap applies, which is generous but is still a cap.
 * @returns {Promise<LiveFileResult>} What disk said; `exists: false` on any failure.
 */
export async function fetchLiveFile(path, options = {}) {
  if (!path) {
    return { path: '', isDirectory: false, exists: false, content: '' };
  }
  const userInitiated = options.userInitiated !== false;
  // All three reads go through one scope, so the probe below cannot answer for a
  // different tree than the read it is deciding.
  const ops = options.ops || { readFile, getTree, stat };

  // Completion paths conventionally carry a trailing slash for directories, but a
  // user may type or paste an absolute directory path without one. Probe first in
  // that ambiguous case so folders never reach `readFile`.
  let isDirectory = path.endsWith('/');
  if (!isDirectory) {
    try {
      const metadata = await ops.stat({ path, userInitiated });
      isDirectory = metadata.isDirectory === true;
    } catch (err) {
      // Preserve the read operation's error/result behavior when metadata is
      // unavailable (for example, a deleted path).
    }
  }

  if (isDirectory) {
    try {
      const treeParams = /** @type {Record<string, unknown>} */ (
        { path, depth: 2, maxTokens: 4000, userInitiated });
      if (options.noIgnore) treeParams.noIgnore = true;
      const r = await ops.getTree(treeParams);
      return {
        path,
        isDirectory: true,
        exists: true,
        content: r.content || '',
        totalLines: (r.fileCount || 0) + (r.dirCount || 0),
        size: 0,
        language: '',
        lineOffset: 1,
        lineCount: 0,
        warning: null,
      };
    } catch (err) {
      console.error(`[LiveFile] Couldn't list directory ${path}:`, err);
      return { path, isDirectory: true, exists: false, content: '' };
    }
  }

  try {
    /** @type {import('../../../js/services/ops-api.js').ReadFileLoadParams} */
    const readParams = { path, userInitiated };
    if (options.head && options.head > 0) readParams.head = options.head;
    else if (options.whole) readParams.maxLines = 0;

    const r = await ops.readFile(readParams, options.signal);
    return {
      path: r.path || path,
      isDirectory: false,
      exists: r.exists !== false,
      content: r.content || '',
      language: r.language || languageFromPath(r.path || path),
      size: r.size || 0,
      totalLines: r.totalLines || 0,
      lineOffset: r.lineOffset || 1,
      lineCount: r.lineCount || 0,
      warning: r.warning || null,
      // Carried, not interpreted: a binary file has no `content`, and both the
      // viewer and the LLM-side extraction need these to hand the file to the
      // right reader rather than treating it as an empty text file.
      mime: r.mime || '',
      isBinary: r.isBinary === true,
    };
  } catch (err) {
    console.error(`[LiveFile] Couldn't load ${path}:`, err);
    return { path, isDirectory: false, exists: false, content: '' };
  }
}

/**
 * Build the FileSource for a live result, for either realm's use of it: a viewer
 * renders it, the LLM-side extraction pulls text out of it.
 *
 * The source says the read was user-initiated for the same reason
 * {@link fetchLiveFile} does — without it the viewer's byte transport refuses a
 * file the user named from the Desktop, having just been shown its contents.
 * @param {LiveFileResult} result - A live read.
 * @param {string} absolutePath - The path to attribute the bytes to.
 * @param {{conversationId?: string, userInitiated?: boolean}} [options] - Conversation
 *   the bytes are for, and whether a user gesture approved paths outside the project.
 * @returns {import('juggler/file-source').FileSource} The file, ready to render or extract.
 */
export function liveFileSource(result, absolutePath, options = {}) {
  return fileSourceFromReadResult(result, absolutePath || result.path || '', {
    conversationId: options.conversationId,
    access: options.userInitiated === false ? {} : { userInitiated: true },
  });
}

/**
 * The one-line annotation that goes beside a path: how big, how many lines, how
 * many entries. Empty when there is nothing worth saying.
 * @param {LiveFileResult} result - A live read.
 * @returns {string} The annotation, or '' for none.
 */
export function liveFileInfo(result) {
  if (!result.exists) return '';
  if (result.isDirectory) return result.totalLines ? `${result.totalLines} items` : '';
  if (!result.size) return '';
  return `${formatFileSize(result.size)} | ${result.totalLines || 0} lines`;
}

/**
 * Render a live read into a container, replacing whatever was there: the missing
 * path, the directory listing, or the file handed to whichever viewer claims it.
 *
 * The path is not repeated here — every caller has already said which file this
 * is, above — so `<file-view>` renders content alone.
 * @param {HTMLElement} container - The region to fill.
 * @param {LiveFileResult} result - A live read.
 * @param {{absolutePath?: string, conversationId?: string, userInitiated?: boolean,
 *   codeRefPath?: string, codeRefAbsolute?: boolean}} [options] - The path to
 *   attribute the bytes to, the conversation they are for, its path provenance,
 *   and the spelling a reference to a selection should print.
 * @returns {void}
 */
export function renderLiveFileBody(container, result, options = {}) {
  const absolutePath = options.absolutePath || result.path || '';
  container.replaceChildren();

  if (!result.exists) {
    container.appendChild(createElement('div', 'file-content-not-found',
      `File not found: ${absolutePath}`));
    return;
  }

  if (result.isDirectory) {
    container.appendChild(createElement('pre', 'file-content-tree', result.content || '(empty)'));
    return;
  }

  const view = /** @type {any} */ (document.createElement('file-view'));
  view.showPath = false;
  if (options.codeRefPath) {
    view.codeRefPath = options.codeRefPath;
    view.codeRefAbsolute = !!options.codeRefAbsolute;
  }
  view.setSource(liveFileSource(result, absolutePath, options));
  container.appendChild(view);
}

/**
 * Guess a language identifier from a path's extension, for syntax highlighting
 * when the read op did not name one itself.
 * @param {string} path - File path.
 * @returns {string} Language identifier, or the bare extension when unmapped.
 */
export function languageFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  /** @type {Record<string, string>} */
  const langMap = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash'
  };
  return langMap[ext] || ext;
}

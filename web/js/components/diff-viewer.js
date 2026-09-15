//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { computeDiff } from '../lib/diff-utils.js';
import { escapeHtml, escapeAttr } from '../../sdk/lib/html.js';
import { highlightCodeLines } from '../../sdk/lib/syntax-highlight.js';
import { languageForPath } from '../../sdk/lib/languages.js';
import { registerContextMenuProvider, codeReferenceMenuItem } from '../services/context-menu-service.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { isAbsolutePath } from '../utils/code-selection.js';

/** @typedef {import('../lib/diff-types.js').DiffHunk} DiffHunk */
/** @typedef {import('../lib/diff-types.js').DiffLine} DiffLine */
/** @typedef {import('../lib/diff-types.js').DiffPatch} DiffPatch */
/** @typedef {import('../lib/diff-types.js').DiffAnnotation} DiffAnnotation */
/** @typedef {{source: string[], markup: string[]}} DiffSide */
/** @typedef {{oldLine: number|null, newLine: number|null, side: 'old'|'new', text: string}} DiffRow */
/** @typedef {{kind: string, text: string, detail?: string}} DiffNotice */

/**
 * Largest side of a diff that is syntax-highlighted. Both sides are tokenised
 * whole so a hunk sees the file around it, which is linear but not free; past
 * this the diff stays plain rather than stalling the panel it renders into.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;

/** How a file with no text patch to show says so, by the status git gave it. */
const STATUS_NOTICES = {
  binary: 'Binary file. No text diff.',
  conflicted: 'Unresolved merge conflict.',
  truncated: 'This patch was cut short; the counts cover the whole file.',
  large: 'This file is too large to diff here.',
};

/**
 * One hunk of a server patch in the renderer's own shape. The server counts
 * lines from one and names its sides `old`/`new`; the client diff numbers lines
 * the same way, so the two inputs meet here and part of the renderer beyond this
 * point knows which produced them.
 * @param {any} hunk - A hunk as `GET /api/git/diff` returned it.
 * @returns {DiffHunk} The hunk to render.
 */
function hunkFromPatch(hunk) {
  const lines = (Array.isArray(hunk?.lines) ? hunk.lines : []).map((/** @type {any} */ line) => /** @type {DiffLine} */ ({
    type: line?.kind === 'add' ? 'add' : (line?.kind === 'remove' ? 'remove' : 'equal'),
    content: typeof line?.text === 'string' ? line.text : '',
    oldLineNum: typeof line?.oldLine === 'number' ? line.oldLine : null,
    newLineNum: typeof line?.newLine === 'number' ? line.newLine : null,
  }));
  return /** @type {DiffHunk} */ ({
    oldStart: Number(hunk?.oldStart) || 0,
    oldCount: Number(hunk?.oldLines) || 0,
    newStart: Number(hunk?.newStart) || 0,
    newCount: Number(hunk?.newLines) || 0,
    heading: typeof hunk?.heading === 'string' ? hunk.heading : '',
    lines,
  });
}

/**
 * How one side of a hunk reads aloud.
 * @param {string} label - "Old" or "new".
 * @param {number} start - First line covered.
 * @param {number} count - Lines covered.
 * @returns {string} A literal phrase for the hunk's accessible label.
 */
function sideRange(label, start, count) {
  if (count <= 0) return `no ${label} lines`;
  if (count === 1) return `${label} line ${start}`;
  return `${label} lines ${start} to ${start + count - 1}`;
}

/**
 * DiffViewer — one file, drawn as a unified diff with both line-number gutters.
 *
 * Two inputs feed it and one renderer draws them. `setDiff` takes the whole of
 * each side, as a tool action persists them, and computes the hunks here.
 * `setPatch` takes a patch the server already produced from git, and draws it
 * exactly as sent: recomputing it client-side would replace what git says the
 * change is with a guess made from two files it never returned.
 *
 * It knows about one file and no more. A file rail, a draft, and where comments
 * are kept belong to whatever mounts it; all it does for review is anchor them —
 * it offers a comment anchor per line when it is not read-only, reports the line
 * the reader chose, and draws the comments it is handed back.
 * @class
 * @augments HTMLElement
 */
class DiffViewer extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.oldContent = '';
    /** @type {string} @private */
    this.newContent = '';
    /** @type {string} @private */
    this.filePath = '';
    /** @type {number} @private */
    this.startLineNumber = 1;
    /** @type {{old: DiffSide, new: DiffSide}|null} @private */
    this.highlighted = null;
    /** @type {'snapshot'|'patch'|'loading'|'error'} @private */
    this.mode = 'snapshot';
    /** @type {DiffPatch|null} @private */
    this.patch = null;
    /** @type {string} @private */
    this.errorText = '';
    /** @type {DiffAnnotation[]} @private */
    this.annotations = [];
    /** @type {boolean} @private */
    this._readOnly = true;
    /** @type {DiffRow[]} @private */
    this._rows = [];
    /** @type {{side: 'old'|'new', line: number}|null} @private */
    this._anchor = null;
    this.addEventListener('click', (event) => this._onClick(event));
  }

  connectedCallback() {
    // wait for setDiff/setPatch to be called
  }

  /**
   * Whether the diff offers comment anchors. Read-only is the default, because
   * every existing host of this component shows history rather than a review.
   * @returns {boolean} True when no anchors are offered.
   */
  get readOnly() {
    return this._readOnly;
  }

  /**
   * @param {boolean} value - False to offer comment anchors.
   */
  set readOnly(value) {
    const next = value !== false;
    if (next === this._readOnly) return;
    this._readOnly = next;
    this.render();
  }

  /**
   * Set diff data and render.
   * @param {string} oldContent
   * @param {string} newContent
   * @param {string} filePath
   * @param {number} [startLineNumber=1]
   */
  setDiff(oldContent, newContent, filePath, startLineNumber = 1) {
    this.mode = 'snapshot';
    this.patch = null;
    this.errorText = '';
    this.oldContent = oldContent || '';
    this.newContent = newContent || '';
    this.filePath = filePath || '';
    this.startLineNumber = startLineNumber;
    this.render();
  }

  /**
   * Draw a patch the server produced, hunk for hunk.
   * @param {any} patch - A `GitFileDiff`, as `services.git.diff()` answers with.
   */
  setPatch(patch) {
    this.mode = 'patch';
    this.errorText = '';
    this.oldContent = '';
    this.newContent = '';
    this.startLineNumber = 1;
    this.filePath = typeof patch?.path === 'string' ? patch.path : '';
    this.patch = /** @type {DiffPatch} */ ({
      repo: typeof patch?.repo === 'string' ? patch.repo : '',
      path: this.filePath,
      oldPath: typeof patch?.oldPath === 'string' ? patch.oldPath : '',
      status: typeof patch?.status === 'string' ? patch.status : '',
      binary: patch?.binary === true,
      conflicted: patch?.conflicted === true,
      truncated: patch?.truncated === true,
      added: Number(patch?.added) || 0,
      removed: Number(patch?.removed) || 0,
      revision: typeof patch?.revision === 'string' ? patch.revision : '',
      hunks: (Array.isArray(patch?.hunks) ? patch.hunks : []).map(hunkFromPatch),
    });
    this.render();
  }

  /** Show that a patch has been asked for and has not arrived. */
  setLoading() {
    this.mode = 'loading';
    this.errorText = '';
    this.render();
  }

  /**
   * Show that the patch could not be had, and what went wrong.
   * @param {unknown} error - The failure, whose own text is kept verbatim.
   */
  setError(error) {
    this.mode = 'error';
    this.errorText = error instanceof Error ? error.message : String(error ?? '');
    this.render();
  }

  /**
   * Draw these comments against the diff. Each is anchored to a side and a line
   * of the patch it was written against; one whose revision has moved on, or
   * whose line this patch no longer holds, is set aside rather than attached to
   * whatever now occupies that number.
   * @param {DiffAnnotation[]} annotations - The comments to draw.
   */
  setAnnotations(annotations) {
    this.annotations = Array.isArray(annotations) ? annotations : [];
    this.render();
  }

  /**
   * Tokenise both sides of the diff, once, into per-line markup.
   *
   * Highlighting the whole of each side rather than the visible hunks is
   * deliberate: a hunk is a window into the middle of a file, and a line taken
   * on its own tokenises wrong — the inside of a block comment reads as code.
   * The arrays are indexed by `lineNum - startLineNumber`, the numbering
   * `computeDiff` derives from splitting these same two strings; the source
   * lines are kept beside the markup so a line is only ever coloured when the
   * text at that index is provably the line being rendered.
   *
   * A server patch is never highlighted: its hunks are snippets, and the lexical
   * state that decides whether a line is inside a block comment or a multiline
   * string is in the part of the file the patch left out.
   * @returns {{old: DiffSide, new: DiffSide}|null} Per-line markup, or null when
   *   the diff is left plain (unknown file type, or too large to be worth it).
   * @private
   */
  highlightSides() {
    if (this.mode !== 'snapshot') return null;
    const language = languageForPath(this.filePath);
    if (language === 'text') return null;
    if (this.oldContent.length > MAX_HIGHLIGHT_CHARS) return null;
    if (this.newContent.length > MAX_HIGHLIGHT_CHARS) return null;
    return {
      old: { source: this.oldContent.split('\n'), markup: highlightCodeLines(this.oldContent, language) },
      new: { source: this.newContent.split('\n'), markup: highlightCodeLines(this.newContent, language) },
    };
  }

  /**
   * What to draw, from whichever input was given.
   * @returns {{hunks: DiffHunk[], notices: DiffNotice[], added: number, removed: number, drawable: boolean}}
   *   The hunks, what has to be said about them, and the counts to report.
   * @private
   */
  viewModel() {
    /** @type {DiffNotice[]} */
    const notices = [];

    if (this.mode === 'loading') {
      return { hunks: [], notices: [{ kind: 'loading', text: 'Loading…' }], added: 0, removed: 0, drawable: false };
    }
    if (this.mode === 'error') {
      notices.push({ kind: 'error', text: "Couldn't load this diff.", detail: this.errorText });
      return { hunks: [], notices, added: 0, removed: 0, drawable: false };
    }

    const patch = this.patch;
    if (this.mode === 'patch' && patch) {
      if (patch.binary) notices.push({ kind: 'binary', text: STATUS_NOTICES.binary });
      if (patch.conflicted) notices.push({ kind: 'conflicted', text: STATUS_NOTICES.conflicted });
      if (patch.truncated) notices.push({ kind: 'truncated', text: STATUS_NOTICES.truncated });
      return { hunks: patch.hunks, notices, added: patch.added, removed: patch.removed, drawable: !patch.binary };
    }

    // A snapshot is diffed here and now, in the only thread there is, so the
    // line diff refuses a changed region past its own budget rather than stall
    // the panel. A server patch arrives already hunked and never meets this:
    // nothing is computed to draw it, however large the file it came from.
    const hunks = computeDiff(this.oldContent, this.newContent, this.startLineNumber);
    if (hunks === null) {
      notices.push({ kind: 'large', text: STATUS_NOTICES.large });
      return { hunks: [], notices, added: 0, removed: 0, drawable: false };
    }

    return { hunks, notices, added: this.countAdded(hunks), removed: this.countRemoved(hunks), drawable: true };
  }

  /** @private */
  render() {
    const model = this.viewModel();
    this.indexRows(model.hunks);
    this.highlighted = this.highlightSides();

    const body = this.renderInlineView(model.hunks, model.drawable);
    const fileComments = this.renderFileComments();
    const label = this.diffLabel();

    this.innerHTML = `
      <diff-content>
        <diff-header>
          ${escapeHtml(this.filePath || 'File diff')}
        </diff-header>
        ${model.notices.map((notice) => this.renderNotice(notice)).join('')}
        <diff-inline-view role="group" aria-label="${escapeAttr(label)}">
          ${body}
        </diff-inline-view>
        ${fileComments}
        <diff-stats>
          <span class="add-count">+${model.added}</span>
          <span class="remove-count">-${model.removed}</span>
        </diff-stats>
      </diff-content>
    `;
  }

  /**
   * Note every line the diff is about to draw, before any of it is drawn. The
   * comment layer asks whether a line is still in the diff, and a line further
   * down the file must not read as missing merely because the renderer has not
   * reached it yet.
   * @param {DiffHunk[]} hunks - What is about to be drawn.
   * @private
   */
  indexRows(hunks) {
    this._rows = [];
    for (const hunk of hunks || []) {
      for (const line of hunk.lines) {
        // A removal exists only in the old file and an addition only in the new,
        // so each anchors where it lives. A context line is in both: it anchors
        // to the new side, which is the file as it now stands.
        const side = /** @type {'old'|'new'} */ (
          line.type === 'remove' || line.newLineNum === null ? 'old' : 'new');
        this._rows.push({ oldLine: line.oldLineNum, newLine: line.newLineNum, side, text: line.content });
      }
    }
  }

  /**
   * What the diff as a whole is of.
   * @returns {string} The accessible name for the diff region.
   * @private
   */
  diffLabel() {
    const path = this.filePath || 'this file';
    const from = this.patch?.oldPath;
    return from && from !== this.filePath ? `Diff of ${path}, renamed from ${from}` : `Diff of ${path}`;
  }

  /**
   * @param {DiffNotice} notice - What has to be said.
   * @returns {string} The notice as HTML.
   * @private
   */
  renderNotice(notice) {
    const detail = notice.detail
      ? `<span class="diff-notice-detail">${escapeHtml(notice.detail)}</span>`
      : '';
    return `<diff-notice data-kind="${escapeAttr(notice.kind)}">${escapeHtml(notice.text)}${detail}</diff-notice>`;
  }

  /**
   * Render inline view (unified diff).
   * @param {DiffHunk[]} hunks
   * @param {boolean} drawable - Whether a file with no hunks has nothing to show
   *   (rather than nothing showable, which the notices have already said).
   * @returns {string} HTML string representing the inline diff view.
   * @private
   */
  renderInlineView(hunks, drawable) {
    if (!hunks || hunks.length === 0) {
      return drawable ? '<diff-no-changes>No changes</diff-no-changes>' : '';
    }

    let html = '';
    for (const hunk of hunks) {
      const label = `${sideRange('old', hunk.oldStart, hunk.oldCount)}, ${sideRange('new', hunk.newStart, hunk.newCount)}`;
      const heading = hunk.heading ? ` ${hunk.heading}` : '';
      html += `<diff-hunk role="group" aria-label="${escapeAttr(label)}">`;
      html += `<diff-hunk-header>${escapeHtml(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${heading}`)}</diff-hunk-header>`;
      for (const line of hunk.lines) html += this.renderRow(line);
      html += '</diff-hunk>';
    }
    return html;
  }

  /**
   * One line of the diff, and whatever is anchored under it.
   * @param {DiffLine} line - The line.
   * @returns {string} The row as HTML.
   * @private
   */
  renderRow(line) {
    const kind = line.type === 'equal' ? 'equal' : line.type;
    const prefix = line.type === 'remove' ? '-' : (line.type === 'add' ? '+' : ' ');
    const side = /** @type {'old'|'new'} */ (
      line.type === 'remove' || line.newLineNum === null ? 'old' : 'new');

    const numbers = [
      `<span class="line-num old">${line.oldLineNum ?? ''}</span>`,
      `<span class="line-num new">${line.newLineNum ?? ''}</span>`,
    ].join('');
    const data = [
      line.oldLineNum !== null ? ` data-old-line="${line.oldLineNum}"` : '',
      line.newLineNum !== null ? ` data-new-line="${line.newLineNum}"` : '',
    ].join('');

    let html = `<div class="diff-line ${kind}"${data}>`;
    html += numbers;
    html += this.renderAnchor(side, side === 'old' ? line.oldLineNum : line.newLineNum);
    html += `<span class="line-prefix">${prefix}</span>`;
    html += `<span class="line-content">${this.renderLineWithCharChanges(line)}</span>`;
    html += '</div>';
    return html + this.renderLineComments(line);
  }

  /**
   * The control that asks for a comment on this line.
   * @param {'old'|'new'} side - Which file the line is in.
   * @param {number|null} number - Its line number there.
   * @returns {string} The button as HTML, or nothing when the diff is read-only.
   * @private
   */
  renderAnchor(side, number) {
    if (this._readOnly || number === null) return '';
    const where = this.filePath ? ` in ${this.filePath}` : '';
    const label = `Add comment to ${side} line ${number}${where}`;
    return `<button type="button" class="diff-comment-btn" data-side="${side}" data-line="${number}"`
      + ` title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">+</button>`;
  }

  /**
   * The comments anchored to a line, drawn under it. They sit outside the code
   * row on purpose: the row is as wide as its longest line and scrolls sideways,
   * and a comment dragged off the side of the panel by someone reading the end of
   * a long line would be unreadable exactly when it is being written.
   * @param {DiffLine} line - The line.
   * @returns {string} The comment holder as HTML, or nothing when the line has none.
   * @private
   */
  renderLineComments(line) {
    const here = this.annotations.filter((annotation) => {
      const number = annotation.side === 'old' ? line.oldLineNum : line.newLineNum;
      return number !== null && this.anchorLine(annotation) === number && !this.isStale(annotation);
    });
    if (here.length === 0) return '';
    const side = /** @type {'old'|'new'} */ (here[0]?.side === 'old' ? 'old' : 'new');
    const number = this.anchorLine(/** @type {DiffAnnotation} */ (here[0]));
    return `<div class="diff-comments" data-side="${side}" data-line="${number}">`
      + here.map((annotation) => this.renderComment(annotation, false)).join('')
      + '</div>';
  }

  /**
   * The comments that belong to the file rather than to a line of it: those
   * written about the whole file, and those whose anchor the file has since
   * moved out from under.
   * @returns {string} The section as HTML, or nothing when there is none.
   * @private
   */
  renderFileComments() {
    const whole = this.annotations.filter((a) => a.side === 'file' && !this.isStale(a));
    const stale = this.annotations.filter((a) => this.isStale(a));
    if (whole.length === 0 && stale.length === 0) return '';

    let html = '<diff-file-comments>';
    if (whole.length > 0) {
      html += '<div class="diff-file-comment-list">'
        + '<h4 class="diff-comment-heading">Comments on this file</h4>'
        + whole.map((annotation) => this.renderComment(annotation, false)).join('')
        + '</div>';
    }
    if (stale.length > 0) {
      html += '<div class="diff-file-comment-list stale">'
        + '<h4 class="diff-comment-heading">Outdated comments</h4>'
        + stale.map((annotation) => this.renderComment(annotation, true)).join('')
        + '</div>';
    }
    return `${html}</diff-file-comments>`;
  }

  /**
   * @param {DiffAnnotation} annotation - The comment.
   * @param {boolean} stale - Whether the diff has moved on from under it.
   * @returns {string} The comment as HTML.
   * @private
   */
  renderComment(annotation, stale) {
    const about = this.commentSubject(annotation);
    const quote = stale && Array.isArray(annotation.lineText) && annotation.lineText.length > 0
      ? `<pre class="diff-comment-quote">${escapeHtml(annotation.lineText.join('\n'))}</pre>`
      : '';
    const actions = this._readOnly ? '' : '<div class="diff-comment-actions">'
      + `<button type="button" class="diff-comment-edit" aria-label="${escapeAttr(`Edit comment on ${about}`)}">Edit</button>`
      + `<button type="button" class="diff-comment-delete" aria-label="${escapeAttr(`Delete comment on ${about}`)}">Delete</button>`
      + '</div>';
    const id = typeof annotation.id === 'string' ? annotation.id : '';
    const body = typeof annotation.body === 'string' ? annotation.body : '';
    return `<div class="diff-comment${stale ? ' stale' : ''}" data-id="${escapeAttr(id)}">`
      + quote
      + `<div class="diff-comment-body">${escapeHtml(body)}</div>`
      + actions
      + '</div>';
  }

  /**
   * What a comment is about, said literally enough for a label.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {string} The subject phrase.
   * @private
   */
  commentSubject(annotation) {
    const where = this.filePath || 'this file';
    const line = this.anchorLine(annotation);
    if (annotation.side === 'file' || line === null) return where;
    const start = annotation.startLine;
    const span = typeof start === 'number' && start !== line ? `lines ${start} to ${line}` : `line ${line}`;
    return `${annotation.side} ${span} in ${where}`;
  }

  /**
   * The line a comment hangs from: a range hangs from its last line, the way it
   * reads on the page.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {number|null} The line number, or null when it names none.
   * @private
   */
  anchorLine(annotation) {
    const line = typeof annotation.endLine === 'number' ? annotation.endLine : annotation.startLine;
    return typeof line === 'number' ? line : null;
  }

  /**
   * Whether the diff under a comment has changed since it was written. Silence
   * here would be the worst outcome of all: a line number that still exists in a
   * rewritten file would carry the comment onto code the reader never saw.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {boolean} True when it can no longer be trusted to its line.
   * @private
   */
  isStale(annotation) {
    if (annotation.stale === true) return true;
    const revision = this.patch?.revision;
    if (revision && annotation.revision && annotation.revision !== revision) return true;
    if (annotation.side === 'file') return false;
    const line = this.anchorLine(annotation);
    if (line === null) return true;
    return !this._rows.some((row) => (annotation.side === 'old' ? row.oldLine : row.newLine) === line);
  }

  /**
   * The syntax-highlighted markup for a line, or its escaped text when the diff
   * is not being highlighted.
   * @param {DiffLine} line
   * @returns {string} Safe HTML for the line's content.
   * @private
   */
  lineMarkup(line) {
    const sides = this.highlighted;
    if (sides) {
      const side = line.type === 'add' ? sides.new : sides.old;
      const number = line.type === 'add' ? line.newLineNum : line.oldLineNum;
      const index = (number ?? 0) - this.startLineNumber;
      // Only take the tokenised line when the text at that index is the line in
      // hand: an index that has drifted would show the wrong line's content and
      // look like a diff bug rather than a highlighting one.
      if (side.source[index] === line.content) return side.markup[index] ?? escapeHtml(line.content);
    }
    return escapeHtml(line.content);
  }

  /**
   * Render a line, applying character highlights if present.
   *
   * The character ranges and the syntax tokens are two layers over the same
   * text, so the marks go onto the *rendered* line rather than being spliced
   * into the source: the line is parsed, its text nodes are walked to find the
   * range, and only that run is wrapped. A range straddling a token boundary
   * therefore yields one `<mark>` per token instead of breaking either layer.
   * @param {DiffLine} line
   * @returns {string} HTML string of the line with character changes highlighted.
   * @private
   */
  renderLineWithCharChanges(line) {
    const html = this.lineMarkup(line);
    const changes = line.charChanges;
    if (!changes || changes.length === 0) return html;

    const template = document.createElement('template');
    template.innerHTML = html;

    /** @type {{node: Text, start: number}[]} */
    const nodes = [];
    let offset = 0;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = /** @type {Text} */ (walker.currentNode);
      nodes.push({ node, start: offset });
      offset += node.data.length;
    }

    for (const { node, start } of nodes) {
      const end = start + node.data.length;
      // Clipped to this text node, then applied right to left: splitting keeps
      // the head in `node`, so every range still to come stays addressable.
      const ranges = changes
        .map((change) => ({
          from: Math.max(change.start, start) - start,
          to: Math.min(change.start + change.length, end) - start,
          type: change.type,
        }))
        .filter((range) => range.to > range.from)
        .sort((a, b) => b.from - a.from);

      for (const range of ranges) {
        node.splitText(range.to);
        const changed = node.splitText(range.from);
        const mark = document.createElement('mark');
        mark.className = `char-${range.type}`;
        changed.parentNode?.insertBefore(mark, changed);
        mark.appendChild(changed);
      }
    }

    return template.innerHTML;
  }

  /**
   * Count added lines
   * @param {DiffHunk[]} hunks
   * @returns {number} The total count of added lines.
   * @private
   */
  countAdded(hunks) {
    let count = 0;
    for (const hunk of hunks || []) for (const line of hunk.lines) if (line.type === 'add') count++;
    return count;
  }

  /**
   * Count removed lines
   * @param {DiffHunk[]} hunks
   * @returns {number} The total count of removed lines.
   * @private
   */
  countRemoved(hunks) {
    let count = 0;
    for (const hunk of hunks || []) for (const line of hunk.lines) if (line.type === 'remove') count++;
    return count;
  }

  /**
   * The text of the lines a side holds between two numbers, in file order. It is
   * what the reader is looking at, so it goes out with the request: a comment
   * keeps its quote even after the file it was about has moved on.
   * @param {'old'|'new'} side - Which file.
   * @param {number} start - First line.
   * @param {number} end - Last line.
   * @returns {string[]} The lines.
   * @private
   */
  quote(side, start, end) {
    return this._rows
      .filter((row) => {
        const number = side === 'old' ? row.oldLine : row.newLine;
        return number !== null && number >= start && number <= end;
      })
      .map((row) => row.text);
  }

  /**
   * Dispatch the clicks the review layer listens for. Delegated from the element
   * itself so a re-render never leaves a stale listener behind.
   * @param {MouseEvent} event - The click.
   * @private
   */
  _onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const anchor = target.closest('.diff-comment-btn');
    if (anchor instanceof HTMLElement) {
      this._requestComment(anchor, event.shiftKey === true);
      return;
    }

    const comment = target.closest('.diff-comment');
    if (!(comment instanceof HTMLElement)) return;
    const id = comment.dataset.id || '';
    if (target.closest('.diff-comment-edit')) this._emit('diff-annotation-edit', { id });
    else if (target.closest('.diff-comment-delete')) this._emit('diff-annotation-delete', { id });
  }

  /**
   * Ask for a comment on the line this anchor names, or — held with shift — on
   * everything from the last anchor to this one. A range only ever covers one
   * side: a span of old lines and new lines together is not a place a comment
   * could be put back.
   * @param {HTMLElement} anchor - The clicked anchor.
   * @param {boolean} extend - Whether shift was held.
   * @private
   */
  _requestComment(anchor, extend) {
    const side = anchor.dataset.side === 'old' ? 'old' : 'new';
    const line = Number(anchor.dataset.line);
    if (!Number.isFinite(line)) return;

    const from = extend && this._anchor?.side === side ? this._anchor.line : line;
    const startLine = Math.min(from, line);
    const endLine = Math.max(from, line);
    this._anchor = { side, line };
    this._emit('diff-comment-request', {
      repo: this.patch?.repo ?? '',
      path: this.filePath,
      revision: this.patch?.revision ?? '',
      side,
      startLine,
      endLine,
      lines: this.quote(side, startLine, endLine),
    });
  }

  /**
   * @param {string} type - Event name.
   * @param {object} detail - What happened.
   * @private
   */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

customElements.define('diff-viewer', DiffViewer);

/**
 * Which side of the diff a selection is wholly within, or undefined when it
 * covers both or neither. A span of removals is the old file and a span of
 * additions the new one; anything mixed has no one answer, and a reference that
 * picked a side would be naming lines in a file half of them are not in.
 * @param {Element} subject - The diff-viewer element.
 * @returns {'old'|'new'|undefined} The side, when there is exactly one.
 */
function selectedDiffSide(subject) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const touched = Array.from(subject.querySelectorAll('.diff-line'))
    .filter((line) => range.intersectsNode(line));
  if (touched.length === 0) return undefined;
  if (touched.every((line) => line.classList.contains('remove'))) return 'old';
  if (touched.every((line) => line.classList.contains('add'))) return 'new';
  return undefined;
}

// Right-click menu for diffs: copy the changed file's path, the line under the
// pointer and its new content, and paste a reference to the selection. Reads the
// DiffViewer instance's own fields (set via setDiff/setPatch). Offered here
// rather than left to the text-edit menu, which this provider is reached before
// and so would hide.
registerContextMenuProvider({
  match: (start) => start?.closest('diff-viewer') || null,
  build: (subject, event) => {
    const diffViewer = /** @type {any} */ (subject);
    const filePath = diffViewer.filePath || '';
    const newContent = diffViewer.newContent || '';
    const clicked = event?.target instanceof Element ? event.target.closest('.diff-line') : null;
    const lineText = clicked?.querySelector('.line-content')?.textContent || '';
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [{
      label: 'Copy file path',
      disabled: !filePath,
      onClick: () => { void copyToClipboard(filePath).catch(() => {}); },
    }, {
      label: 'Copy line',
      disabled: !lineText,
      onClick: () => { void copyToClipboard(lineText).catch(() => {}); },
    }, {
      label: 'Copy new content',
      disabled: !newContent,
      onClick: () => { void copyToClipboard(newContent).catch(() => {}); },
    }];
    if (filePath) {
      const paste = codeReferenceMenuItem({
        path: filePath,
        outOfRoot: isAbsolutePath(filePath),
        side: selectedDiffSide(subject),
        within: subject,
      });
      if (paste) items.push(paste);
    }
    return items;
  },
});

/**
 * A diff viewer, ready to be given a patch or a pair of snapshots.
 *
 * The element is registered by importing this module, which is why a host that
 * wants one asks for it here rather than calling `document.createElement`: an
 * extension has no way of knowing whether anything else in the window has loaded
 * the component yet, and an unregistered custom element is an inert `<div>` that
 * silently ignores every method called on it.
 * @param {object} [options] - How the viewer should behave.
 * @param {boolean} [options.readOnly=true] - False to offer a comment anchor per
 *   line. An annotatable viewer reports the reader's choice as a bubbling
 *   `diff-comment-request` event and draws back whatever `setAnnotations` is
 *   given; it keeps no comments of its own.
 * @returns {DiffViewer} The element, not yet in the document.
 */
export function createDiffViewer({ readOnly = true } = {}) {
  const viewer = /** @type {DiffViewer} */ (document.createElement('diff-viewer'));
  viewer.readOnly = readOnly;
  return viewer;
}

export default DiffViewer;

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { createTextBlock, formatFileContentForLLM } from 'juggler/item-utils';
import { formatGrepResults } from './search/grep-format.js';

/**
 * Wrap a value as markdown inline code, widening the fence when the value
 * itself contains a backtick — a grep pattern very often does.
 * @param {string} value - Raw value from the tool input
 * @returns {string} The value as an inline code span
 */
function code(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const fence = '`'.repeat(Math.max(...[0, ...text.match(/`+/g)?.map(r => r.length) || []]) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * @typedef {object} BatchReadFile
 * @property {string} file_path - Absolute file path
 * @property {number} [offset] - Line number to start reading from (1-indexed)
 * @property {number} [limit] - Number of lines to read
 */

/**
 * @typedef {object} BatchGrepSearch
 * @property {string} pattern - Regex pattern to search for
 * @property {string} [path] - Directory to search in
 * @property {string} [glob] - File glob filter
 * @property {string} [output_mode] - "content" | "files_with_matches" | "count"
 */

/**
 * BatchContextItem - Batch read and grep operations
 *
 * Provides batch_read and batch_grep tools that combine multiple operations
 * into a single tool call, reducing context overhead.
 * @class
 * @augments ContextItem
 */
class BatchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'search', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'batch',
    name: 'Batch Operations',
    version: '1.0.0',
    description: 'Batch read and grep operations for context efficiency',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for batch operations
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'batch_read',
        category: 'read',
        description: 'Read up to 10 files in a single call. Returns combined content with file separators. More efficient than multiple read calls.',
        input_schema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: 'Array of files to read (max 10)',
              items: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'Absolute file path'
                  },
                  offset: {
                    type: 'number',
                    description: 'Line number to start from (1-indexed)'
                  },
                  limit: {
                    type: 'number',
                    description: 'Number of lines to read'
                  }
                },
                required: ['file_path']
              },
              maxItems: 10
            }
          },
          required: ['files']
        }
      },
      {
        name: 'batch_grep',
        category: 'read',
        description: 'Run up to 10 grep searches in a single call. Returns combined results with search separators. More efficient than multiple grep calls.',
        input_schema: {
          type: 'object',
          properties: {
            searches: {
              type: 'array',
              description: 'Array of searches to run (max 10)',
              items: {
                type: 'object',
                properties: {
                  pattern: {
                    type: 'string',
                    description: 'Regex pattern to search for'
                  },
                  path: {
                    type: 'string',
                    description: 'Directory to search in'
                  },
                  glob: {
                    type: 'string',
                    description: 'File glob filter'
                  },
                  output_mode: {
                    type: 'string',
                    enum: ['content', 'files_with_matches', 'count'],
                    description: 'Output format (default: files_with_matches)'
                  }
                },
                required: ['pattern']
              },
              maxItems: 10
            }
          },
          required: ['searches']
        }
      }
    ];
  }

  /**
   * Coerce a value that should be an array. Some models double-encode array
   * arguments as a JSON string (e.g. searches: "[{...}]"); parse those back
   * into an array. Anything that isn't a JSON-string-of-an-array is returned
   * unchanged so the caller's array/length validation reports the real error.
   * @param {unknown} value - Raw argument value
   * @returns {unknown} The array if coercible, otherwise the original value
   * @private
   */
  static _coerceArray(value) {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }

  /**
   * Validate input parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    // Determine which batch tool this is
    if (toolInput.files) {
      const files = /** @type {BatchReadFile[]} */ (BatchContextItem._coerceArray(toolInput.files));
      if (!Array.isArray(files) || files.length === 0) {
        return { valid: false, error: 'files must be a non-empty array' };
      }
      if (files.length > 10) {
        return { valid: false, error: 'Maximum 10 files per batch_read call' };
      }
      for (const f of files) {
        if (!f.file_path || typeof f.file_path !== 'string') {
          return { valid: false, error: 'Each file must have a file_path string' };
        }
      }
      return { valid: true, params: { _batchType: 'read', files } };
    }

    if (toolInput.searches) {
      const searches = /** @type {BatchGrepSearch[]} */ (BatchContextItem._coerceArray(toolInput.searches));
      if (!Array.isArray(searches) || searches.length === 0) {
        return { valid: false, error: 'searches must be a non-empty array' };
      }
      if (searches.length > 10) {
        return { valid: false, error: 'Maximum 10 searches per batch_grep call' };
      }
      for (const s of searches) {
        if (!s.pattern || typeof s.pattern !== 'string') {
          return { valid: false, error: 'Each search must have a pattern string' };
        }
      }
      return { valid: true, params: { _batchType: 'grep', searches } };
    }

    return { valid: false, error: 'Must provide either "files" (batch_read) or "searches" (batch_grep)' };
  }

  /**
   * Execute batch operation
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Combined results
   */
  async execute(params) {
    if (params._batchType === 'read') {
      return this._executeBatchRead(/** @type {BatchReadFile[]} */ (params.files));
    }
    return this._executeBatchGrep(/** @type {BatchGrepSearch[]} */ (params.searches));
  }

  /**
   * Execute batch file reads
   * @param {BatchReadFile[]} files - Files to read
   * @returns {Promise<Record<string, unknown>>} Combined results
   * @private
   */
  async _executeBatchRead(files) {
    const results = await Promise.all(
      files.map(async (f) => {
        try {
          /** @type {Record<string, unknown>} */
          const readParams = { path: f.file_path };
          if (f.offset !== undefined || f.limit !== undefined) {
            const offset = f.offset || 1;
            const limit = f.limit || 2000;
            readParams.lineRange = { start: offset, end: offset + limit - 1 };
          }
          const result = await this.ops.readFile(/** @type {any} */ (readParams), this.signal);
          return { file: f.file_path, success: true, result };
        } catch (err) {
          return { file: f.file_path, success: false, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    return { _batchType: 'read', results };
  }

  /**
   * Execute batch grep searches
   * @param {BatchGrepSearch[]} searches - Searches to run
   * @returns {Promise<Record<string, unknown>>} Combined results
   * @private
   */
  async _executeBatchGrep(searches) {
    const results = await Promise.all(
      searches.map(async (s) => {
        try {
          /** @type {Record<string, unknown>} */
          const searchParams = { pattern: s.pattern };
          if (s.path) searchParams.path = s.path;
          if (s.glob) searchParams.include = s.glob;
          const result = await this.ops.grep(/** @type {any} */ (searchParams), this.signal);
          return { pattern: s.pattern, success: true, result, outputMode: s.output_mode || 'files_with_matches' };
        } catch (err) {
          return { pattern: s.pattern, success: false, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    return { _batchType: 'grep', results };
  }

  /**
   * Format batch results for LLM
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Batch operation failed');
    }

    const result = /** @type {Record<string, unknown>} */ (outcome.result);
    let content;

    if (result._batchType === 'read') {
      content = this._formatBatchReadResults(/** @type {any[]} */ (result.results));
    } else {
      content = this._formatBatchGrepResults(/** @type {any[]} */ (result.results));
    }

    return this.successSummary(this.truncateForLLM(content));
  }

  /**
   * Format batch read results
   * @param {Array<{file: string, success: boolean, result?: any, error?: string}>} results
   * @returns {string} Formatted output
   * @private
   */
  _formatBatchReadResults(results) {
    // Every file gets its own share of the budget and its own footer. Sharing
    // one budget across the joined text spends it in reading order, so a file
    // in the middle disappears entirely and gets read again on its own; a file
    // that is merely short says where to pick it up. The margin leaves room for
    // the separators and error lines, which are outside the per-file shares.
    const rendersContent = (/** @type {{success: boolean, result?: any}} */ r) =>
      r.success && r.result?.exists !== false && !r.result?.warning;
    const readable = results.filter(rendersContent).length;
    const perFile = Math.floor((this.truncationBudget() * 0.9) / Math.max(1, readable));

    /** @type {string[]} */
    const parts = [];
    for (const r of results) {
      if (!r.success) {
        parts.push(`=== file: ${r.file} ===`);
        parts.push(`Error: ${r.error}`);
      } else if (r.result.exists === false) {
        // Worded as read_file words it: the trailing instruction is what stops
        // the model re-reading a path that will not appear.
        parts.push(`=== file: ${r.file} ===`);
        parts.push(`File does not exist: ${r.file}. Do not attempt to read it again.`);
      } else if (r.result.warning) {
        parts.push(`=== file: ${r.file} ===`);
        parts.push(r.result.warning);
      } else {
        // The shared helper supplies the <file> wrapper and its own path, so
        // this branch needs no === header — and the model now sees one file
        // format whether it read via read_file or batch_read.
        parts.push(formatFileContentForLLM({
          content: r.result.extracted?.text || r.result.content || '',
          path: r.file,
          lineOffset: r.result.lineOffset || 1,
          totalLines: r.result.totalLines,
          maxChars: perFile
        }));
      }
      parts.push('');
    }
    return parts.join('\n').trim();
  }

  /**
   * Format batch grep results
   * @param {Array<{pattern: string, success: boolean, result?: any, error?: string, outputMode?: string}>} results
   * @returns {string} Formatted output
   * @private
   */
  _formatBatchGrepResults(results) {
    /** @type {string[]} */
    const parts = [];
    for (const r of results) {
      parts.push(`=== grep: ${r.pattern} ===`);
      if (!r.success) {
        parts.push(`Error: ${r.error}`);
      } else {
        // The same renderer the search tool uses. batch passes no
        // head_limit/offset (its schema has neither), so the pagination
        // footers stay inert and only the three output modes apply.
        parts.push(formatGrepResults(r.result, {
          pattern: r.pattern,
          output_mode: r.outputMode || 'files_with_matches'
        }));
      }
      parts.push('');
    }
    return parts.join('\n').trim();
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status config
   */
  getStatusUI(actionStatus, toolInput) {
    const files = BatchContextItem._coerceArray(toolInput?.files);
    const searches = BatchContextItem._coerceArray(toolInput?.searches);
    const isBatchRead = Array.isArray(files);
    const count = isBatchRead
      ? /** @type {any[]} */ (files).length
      : /** @type {any[]} */ (Array.isArray(searches) ? searches : []).length;
    const noun = isBatchRead ? 'files' : 'searches';

    return this.buildStatusUI(actionStatus, {
      typeName: isBatchRead ? 'BatchRead' : 'BatchGrep',
      pending: `${count} ${noun}...`,
      success: `${count} ${noun} completed`,
      failurePrefix: 'failed'
    });
  }

  /**
   * @override
   * @param {string} toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(toolName) {
    if (toolName === 'batch_grep') return 'Matches';
    if (toolName === 'batch_read') return 'Content';
    return 'Result';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolName, input, helpers } = ctx;

    // One numbered list rather than a subsection per entry: a batch is a list
    // of like things, and a ten-file read used to stack ten "File" headings.
    const isGrep = toolName === 'batch_grep';
    const coerced = BatchContextItem._coerceArray(isGrep ? input.searches : input.files);
    const entries = Array.isArray(coerced) ? coerced : [];
    if (entries.length === 0) return;

    const lines = entries.map((/** @type {any} */ e, /** @type {number} */ i) =>
      `${i + 1}. ${isGrep ? BatchContextItem._grepLine(e) : BatchContextItem._readLine(e)}`
    );

    const label = isGrep ? 'Searches' : 'Files';
    const section = helpers.labeledSubsection(
      entries.length === 1 ? label.slice(0, -1) : `${label} (${entries.length})`
    );
    section.appendChild(createTextBlock(lines.join('\n') + '\n'));
    wrapper.appendChild(section);
  }

  /**
   * One search as a markdown line: the pattern, then whatever narrows it.
   * @param {{pattern?: string, path?: string, glob?: string}} search - A batch_grep entry
   * @returns {string} Markdown for a single list item
   * @private
   */
  static _grepLine(search) {
    const scope = [
      search.path ? `in ${code(search.path)}` : '',
      search.glob ? `matching ${code(search.glob)}` : '',
    ].filter(Boolean);
    return code(search.pattern || '') + (scope.length ? ` — ${scope.join(', ')}` : '');
  }

  /**
   * One file as a markdown line: the path, and the line range when it is not
   * being read whole.
   * @param {{file_path?: string, offset?: number, limit?: number}} file - A batch_read entry
   * @returns {string} Markdown for a single list item
   * @private
   */
  static _readLine(file) {
    const path = code(file.file_path || '');
    if (file.offset === undefined && file.limit === undefined) return path;
    const start = file.offset || 1;
    const range = file.limit ? `lines ${start}–${start + file.limit - 1}` : `from line ${start}`;
    return `${path} (${range})`;
  }
}

export default BatchContextItem;

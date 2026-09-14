//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import EditBase from './edit-base.js';
import { normalizeFilePath, basename } from 'juggler/item-utils';
import { checkFileFreshness, recordWrittenHash, restageBaseline, acquirePathLock } from './read-history.js';
import { absolutePathKey } from './path-approval.js';

/**
 * @typedef {object} ReplaceTextParams
 * @property {string} path - File path relative to project root
 * @property {string} old_str - Exact content to find and replace (aliases: oldContent, old, pattern, search)
 * @property {string} new_str - New content to replace with (aliases: newContent, new, replacement, replace)
 */

/**
 * @typedef {object} ReplaceTextResult
 * @property {string} path - Path of edited file
 * @property {string} [method] - Edit method used
 */

/**
 * ReplaceTextContextItem - Search and replace text in files with diff preview
 *
 * Superior to WriteFileContextItem for modifying existing files.
 * Shows a diff view in approval modal before applying changes.
 * @class
 * @augments EditBase
 */
class ReplaceTextContextItem extends EditBase {
  static MANIFEST = {
    id: 'replace-text',
    name: 'Replace Text',
    version: '1.0.0',
    description: 'Find and replace text in files',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'edit', icon: 'icon-edit-file' };
  }

  /**
   * Get tool definitions for Edit action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify. Must be inside the working directory unless the user explicitly asked for a location outside it.'
        },
        old_string: {
          type: 'string',
          description: 'The text to replace (must be different from new_string)'
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)'
        },
        replace_all: {
          type: 'boolean',
          default: false,
          description: 'Replace all occurrences of old_string (default false)'
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    };

    const description = 'Performs exact string replacements in files. Read the file first — the edit is refused if this conversation has not read it, or if it changed on disk since. It also fails if old_string is not unique in the file: include more surrounding context, or use replace_all.';

    return [
      {
        name: 'edit',
        category: 'write',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Normalize parameter names to standard path/old_str/new_str
   * Handles current-style (file_path, old_string, new_string) and legacy style (old_str, new_str)
   * @param {Record<string, any>} params - Raw parameters from LLM
   * @returns {ReplaceTextParams & {replace_all?: boolean}} Normalized parameters
   * @private
   */
  _normalizeParams(params) {
    const normalized = normalizeFilePath({ ...params });

    // Handle current-style: old_string -> old_str
    if (normalized.old_string && !normalized.old_str) {
      normalized.old_str = normalized.old_string;
    }

    // Handle current-style: new_string -> new_str
    if (normalized.new_string && !normalized.new_str) {
      normalized.new_str = normalized.new_string;
    }

    // Use shared normalization utilities from EditBase as fallback
    if (!normalized.old_str) {
      normalized.old_str = EditBase._normalizeOldContent(params);
    }
    if (!normalized.new_str) {
      normalized.new_str = EditBase._normalizeNewContent(params);
    }

    return /** @type {ReplaceTextParams & {replace_all?: boolean}} */ (normalized);
  }

  /**
   * Validate and normalize parameters for execution.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    // Normalize params before validation
    const params = this._normalizeParams(/** @type {Record<string, any>} */ (toolInput));

    // Validation - use current-style names in error messages
    if (params.path === undefined || params.path === null) {
      return { valid: false, error: 'Missing required parameter: file_path' };
    }
    if (typeof params.path !== 'string') {
      return { valid: false, error: 'Parameter "file_path" must be a string' };
    }
    if (params.old_str === undefined || params.old_str === null) {
      return { valid: false, error: 'Missing required parameter: old_string' };
    }
    if (typeof params.old_str !== 'string') {
      return { valid: false, error: 'Parameter "old_string" must be a string' };
    }
    if (params.new_str === undefined || params.new_str === null) {
      return { valid: false, error: 'Missing required parameter: new_string' };
    }
    if (typeof params.new_str !== 'string') {
      return { valid: false, error: 'Parameter "new_string" must be a string' };
    }

    // Read-before-edit guard (Claude Code-style): refuse to edit a file the
    // model hasn't looked at this session, so a blind search-and-replace can't
    // corrupt a file it's only guessing at. Seen-ness is derived from the
    // durable transcript (read-history.js) — a prior successful
    // read/write/edit/batch_read or a pinned file — so it survives relaunch,
    // extra clients, and both realms. Checked before the dryRun so a never-read
    // file gets the read-first message rather than a search-mismatch one.
    const neverRead = checkFileFreshness(this.conversation, this.session, params.path, undefined);
    if (!neverRead.ok) {
      return { valid: false, error: neverRead.error };
    }

    // Call backend with dryRun to get complete file content for diff
    /** @type {import('../../../js/services/ops-api.js').ReadFileEditResult} */
    let result;
    try {
      result = await this.ops.editFile(
        /** @type {import('../../../js/services/ops-api.js').ReadFileEditParams} */ ({ ...params, dryRun: true })
      );
    } catch (err) {
      // If string not found, check if size was the likely cause and give helpful error.
      // The caps are deliberately generous: a single prose paragraph (one long
      // line of Markdown) is a legitimate, common edit target, so a paragraph-
      // sized old_str must NOT be waved off to the write tool — the backend
      // matcher (exact → flexible-whitespace → regex) handles blocks this size
      // fine. Only a genuinely huge multi-paragraph block is better rewritten
      // wholesale, so the "use write" advice fires only past that.
      const oldContentLines = params.old_str.split('\n').length;
      const oldContentChars = params.old_str.length;
      const MAX_LINES = 40;
      const MAX_CHARS = 4000;

      if (oldContentLines > MAX_LINES || oldContentChars > MAX_CHARS) {
        return {
          valid: false,
          error: `The old_str is very large (${oldContentLines} lines, ${oldContentChars} characters) and did not match. ` +
                        `For a block this big, the write tool is usually more reliable than reproducing it exactly. ` +
                        `Otherwise re-read the file and copy the exact text (including whitespace) for a smaller, unique old_str.`
        };
      }
      // String was small enough but still didn't match - return validation error
      // (includes ambiguous matches, file not found, etc.)
      return {
        valid: false,
        error: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
      };
    }

    // The backend returns search-not-found / file-not-found / ambiguous-match
    // as `{ success: false, errorCode, ... }` data WITHOUT throwing, so the
    // try/catch above doesn't see them. Inspect the dryRun result here and
    // reject at validation time — otherwise the framework would proceed to
    // request approval for an edit that cannot apply, surfacing a useless
    // diff-less approval modal to the user before the action ultimately
    // fails at execute time.
    if (result && /** @type {any} */ (result).success === false) {
      // A stale file explains a failed match better than the generic
      // search-not-found guidance, so check freshness against the hash the
      // backend reports alongside the structured error.
      const failedHash = /** @type {any} */ (result).contentHash;
      const staleOnFail = checkFileFreshness(this.conversation, this.session, params.path, failedHash);
      if (!staleOnFail.ok) {
        return { valid: false, error: staleOnFail.error };
      }
      const { llmMessage } = this.formatError(/** @type {any} */ (result), 'edit');
      return { valid: false, error: llmMessage };
    }

    // Staleness is deliberately NOT re-checked on a successful match. Reaching
    // here means the file was seen this session (the read-before-edit guard
    // above) AND old_str uniquely matched the file's CURRENT bytes (the dryRun
    // succeeded). Replacing text that is present verbatim is lossless even if
    // the file changed out-of-band since it was read — any surrounding change is
    // preserved — so refusing would only burn a turn on a needless re-read
    // (commonly after the agent's own formatter/codegen touched the file). The
    // "file moved under me" case instead fails to match and is caught above
    // (staleOnFail) with a re-read message. Full overwrites (the write tool)
    // stay strict, since they DO destroy unseen bytes. The approval-window race
    // (file changes between this dryRun and execute) is still caught at execute
    // time by the backend expectedHash guard.

    // Cache dryRun result for getApprovalConfig()
    return {
      valid: true,
      params: { ...params, _dryRunResult: result }
    };
  }

  /**
   * Build approval UI configuration with diff preview.
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const path = /** @type {string} */ (params.path);
    const result = /** @type {import('../../../js/services/ops-api.js').ReadFileEditResult} */ (params._dryRunResult);

    const diffData = {
      oldContent: result.oldContent || '',
      newContent: result.newContent || /** @type {string} */ (params.new_str),
      path,
      startLineNumber: 1
    };

    return this._buildApprovalConfig(path, diffData);
  }

  /**
   * Execute the replace text action
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<ReplaceTextResult>} Action result
   */
  async execute(params) {
    // Normalize params (may have been passed raw toolInput)
    const normalizedParams = this._normalizeParams(/** @type {Record<string, any>} */ (params));

    // The dryRun result is validation-local: keep it off the wire, but carry
    // its contentHash as expectedHash so the backend refuses if the file
    // changed between the approved preview and this write (the approval modal
    // can be open for arbitrarily long).
    const anyParams = /** @type {any} */ (normalizedParams);
    const dryRunResult = /** @type {{contentHash?: string, oldContent?: string, newContent?: string}|undefined} */ (anyParams._dryRunResult);
    delete anyParams._dryRunResult;
    const frozenHash = dryRunResult?.contentHash;
    const oldFull = dryRunResult?.oldContent;
    const newFull = dryRunResult?.newContent;

    // Serialize edits to the SAME file: a single turn can dispatch several to
    // one path concurrently, each having frozen its expectedHash baseline at
    // validation time — before any sibling wrote. Holding this per-path lock
    // across execute makes those siblings run one at a time, so each re-bases
    // onto the previous sibling's committed bytes below instead of carrying a
    // baseline the backend rejects as stale. Different files never block.
    const lock = await acquirePathLock(this.session, anyParams.path);
    try {
      if (frozenHash) {
        // A same-turn sibling may have advanced the on-disk bytes past our
        // frozen baseline. Re-probe and re-base onto the current bytes when
        // they are our own just-written output (restageBaseline vets them via
        // the freshness guard); keep the frozen baseline for a genuine
        // out-of-band change so the backend still refuses it.
        let currentHash;
        try {
          const probe = await this.ops.readFile({ path: anyParams.path });
          currentHash = /** @type {any} */ (probe)?.contentHash;
        } catch {
          // Unreadable here (e.g. removed out-of-band): let editFile surface it.
        }
        anyParams.expectedHash = restageBaseline(
          this.conversation, this.session, anyParams.path, frozenHash, currentHash
        );
      }

      // Mark an out-of-root target as approved so the backend's defence-in-depth
      // check admits the edit (see EditBase._authorizeWrite).
      const sendParams = this._authorizeWrite(normalizedParams);

      const result = await this.ops.editFile(
        /** @type {import('../../../js/services/ops-api.js').ReadFileEditParams} */ (sendParams),
        this.signal
      );

      // Remember the post-edit hash synchronously so a follow-up edit of the same
      // file later in this turn passes the freshness guard even before this edit's
      // tool-action lands in the durable transcript (see read-history.js).
      if (result && /** @type {any} */ (result).success !== false &&
          typeof (/** @type {any} */ (result).contentHash) === 'string') {
        recordWrittenHash(this.conversation, this.session, anyParams.path, /** @type {any} */ (result).contentHash);
      }

      // Attach a line diffstat so the status tile can show `+A -B` beside the
      // filename. The dryRun captured the full before/after file content, which
      // counts every occurrence for a replace_all; fall back to the single
      // old_str/new_str region when it isn't available.
      if (result && /** @type {any} */ (result).success !== false) {
        const stats = (typeof oldFull === 'string' && typeof newFull === 'string')
          ? EditBase._lineStats(oldFull, newFull)
          : EditBase._lineStats(anyParams.old_str, anyParams.new_str);
        if (stats) {
          /** @type {any} */ (result).linesAdded = stats.added;
          /** @type {any} */ (result).linesRemoved = stats.removed;
        }
      }

      return result;
    } finally {
      lock.release();
    }
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    // Extract path from prepared params for cancelled messages
    const prepared = outcome.prepared;
    const prepParams = /** @type {{path?: string}} */ (prepared?.params || {});
    const prepPath = prepParams.path || 'unknown';

    // Handle non-success cases
    if (outcome.cancelled) {
      return this.failureSummary(`Replace text cancelled: ${prepPath}`);
    }
    if (!outcome.success) {
      // Check if we have structured error info from backend
      const result = /** @type {{success: boolean, errorCode: string, path: string, hasEscaping?: boolean, hasNearMatch?: boolean, nearMatchLine?: number, contextLines?: string}|undefined} */ (outcome.result);
      if (result && result.path) {
        const { userMessage, llmMessage } = this.formatError(result, 'edit');
        return this.failureSummary(`Replace text failed: ${userMessage}`, { feedbackForLLM: llmMessage });
      }
      return this.failureSummary(`Replace text failed: ${outcome.error}`);
    }

    // Success case
    const result = /** @type {ReplaceTextResult} */ (outcome.result);
    return this._formatEditResult(
      result.path,
      `Modified ${result.path} using ${result.method || 'edit'}`
    );
  }

  /**
   * Format structured error from backend into user and LLM messages.
   * Called when backend returns success: false with error diagnostics.
   * @param {object} result - Structured error result from backend
   * @param {boolean} result.success - Always false for errors
   * @param {string} result.errorCode - Error code (e.g., 'SEARCH_NOT_FOUND')
   * @param {string} result.path - File path
   * @param {boolean} [result.hasEscaping] - Whether escaping issues detected
   * @param {boolean} [result.hasNearMatch] - Whether similar content found nearby
   * @param {number} [result.nearMatchLine] - Line number of near match
   * @param {string} [result.contextLines] - Raw context lines for LLM
   * @param {string} _toolName - Name of the tool that failed
   * @returns {{userMessage: string, llmMessage: string}} Dual messages
   */
  formatError(result, _toolName) {
    // User-friendly message - short and clear with filename
    const filename = result.path ? basename(result.path) || result.path : 'unknown';
    const userMessage = `failed in ${filename}`;

    // LLM message with technical details for self-correction (built as array to avoid += lint rule)
    const llmParts = [`Search failed in '${result.path}'.`];
    if (result.hasEscaping) {
      llmParts.push("ESCAPING ERROR: old_str is LITERAL, don't escape backticks, ${}, (), [], {}.");
    }
    if (result.hasNearMatch && result.nearMatchLine) {
      llmParts.push(`Similar content near line ${result.nearMatchLine}.`);
    }
    if (result.contextLines) {
      llmParts.push(result.contextLines);
    }
    llmParts.push('Re-read file and use exact text including whitespace.');
    const llmMessage = llmParts.join(' ');

    return { userMessage, llmMessage };
  }

  /**
   * Get status UI configuration
   *
   * Provides status message with expandable diff view.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) {
      return null;
    }

    /** @type {any} */
    const displayData = actionStatus.displayData;

    /** @type {any} */
    const result = actionStatus.result || {};
    const path = result.path || toolInput?.file_path || toolInput?.path || 'unknown';
    // Get just the filename for display
    const filename = basename(path) || path;

    // Build summary
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;

    if (actionStatus.pending) {
      // Pending/approval state - use title from display data
      summary = displayData?.title || filename;
      status = 'running';
    } else if (actionStatus.success) {
      summary = EditBase._editStatSummary(filename, EditBase._editStats(displayData, result));
      status = 'success';
    } else if (actionStatus.cancelled) {
      summary = `cancelled: ${filename}`;
      status = 'cancelled';
    } else {
      // When no path is available (e.g. validation rejected the call
      // before it ran), `failed in unknown` hides the actual reason —
      // surface the raw error message instead.
      const hasPath = result.path || toolInput?.file_path || toolInput?.path;
      summary = hasPath
        ? `failed in ${filename}`
        : (actionStatus.error || /** @type {any} */ (actionStatus).content || 'failed');
      status = 'error';
    }

    return { typeName: 'Replace', summary, status };
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input, helpers } = ctx;
    const filePath = input.file_path || input.path || '';

    const result = toolAction.get('result');
    const isError = result
      ? (result.get ? result.get('isError') : result?.isError)
      : false;
    const cancelled = result
      ? (result.get ? result.get('cancelled') : result?.cancelled)
      : false;

    // An edit that happened offers to pin the file it changed, at its
    // canonical path. A failed or cancelled one changed nothing to look at.
    helpers.addFilePath(wrapper, filePath, undefined,
      (!isError && !cancelled) ? { pin: absolutePathKey(ctx.session, filePath) } : {});

    if (isError) {
      if (input.old_string !== undefined) {
        helpers.addSubsection(wrapper, 'Search', input.old_string, 'properties-panel-code');
      }
      if (input.new_string !== undefined) {
        helpers.addSubsection(wrapper, 'Replace', input.new_string, 'properties-panel-code');
      }
      const fullResult = result.get ? result.get('fullResult') : result?.fullResult;
      const fullObj = fullResult?.toJSON ? fullResult.toJSON() : fullResult;
      const errorText = fullObj?.llmFeedback || fullObj?.error || 'Edit failed';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'properties-panel-result error';
      errorDiv.textContent = errorText;
      wrapper.appendChild(errorDiv);
    } else if (!helpers.addDiffViewer(wrapper, toolAction, filePath)) {
      if (input.old_string !== undefined) {
        helpers.addSubsection(wrapper, 'Search', input.old_string, 'properties-panel-code');
      }
      if (input.new_string !== undefined) {
        helpers.addSubsection(wrapper, 'Replace', input.new_string, 'properties-panel-code');
      }
    }
    return { skipResultSection: true };
  }
}

export default ReplaceTextContextItem;

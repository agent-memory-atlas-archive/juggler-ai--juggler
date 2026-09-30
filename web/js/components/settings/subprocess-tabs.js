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

/**
 * The "MCP servers" and "ACP agents" settings tabs. Both manage the same shape —
 * a scope-keyed map of {command, args, env, enabled} subprocess entries — so they
 * share the generic {@link ConfigTabController} (from config-tab.js) and differ
 * only in a small per-tab spec plus a thin wrapper that owns lifecycle. The MCP
 * wrapper additionally live-refreshes off the `plugin-changed` broadcast while
 * visible; the ACP wrapper auto-enables the ACP provider after a successful save.
 * @module components/settings/subprocess-tabs
 */

import wsService from '../../services/websocket.js';
import { fetchJson } from '../../services/http.js';
import {
  mcpListServers,
  mcpGetConfig,
  mcpSetConfig,
  mcpServerControl,
  mcpGetLog,
  mcpListTools,
  acpListAgents,
  acpGetConfig,
  acpSetConfig,
} from '../../services/ops-api.js';
import { ConfigTabController, makeNameValidator } from '../config-tab.js';
import { isMcpExtensionDisabled, MCP_DISABLED_NOTICE } from '../../services/mcp-availability.js';
import { apiUrl } from '../../utils/api-url.js';

/** Polling interval (ms) for refreshing the MCP servers tab while it's open. */
const MCP_POLL_MS = 2000;

/** Polling interval (ms) for refreshing the ACP agents tab while it's open. */
const ACP_POLL_MS = 3000;

/**
 * Format an MCP server's tool count and schema-token cost as a short one-liner,
 * e.g. "3 tools · ~1.2k tokens/request" or "1 tool". The token clause is dropped
 * when the server reports zero schema tokens (e.g. before discovery completes).
 * @param {{toolCount?: number, schemaTokens?: number}} status - A McpServerStatus
 * @returns {string} The formatted "N tools · ~Xk tokens/request" summary.
 */
export function formatMcpTokenCost(status) {
  const n = (status && status.toolCount) || 0;
  const t = (status && status.schemaTokens) || 0;
  const tok = t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
  return `${n} tool${n === 1 ? '' : 's'}${t ? ` · ~${tok} tokens/request` : ''}`;
}

/**
 * The MCP-only working-state fields the add/edit form carries alongside the
 * generic ones (command/args/url/…). Seeded by {@link mcpSeedFormExtra}.
 * @typedef {object} McpFormState
 * @property {string} [name] - Server name (set by the generic controller)
 * @property {string} [mode] - 'add' | 'edit' (set by the generic controller)
 * @property {string[]|null} toolAllow - Seeded allowlist, or null when none configured
 * @property {string[]} toolDeny - Seeded denylist
 * @property {string} defaultArgsText - Fixed-arguments JSON as edited text
 * @property {boolean} toolsLoaded - Whether the live tool list has been fetched
 * @property {boolean} toolsLoading - Whether a fetch is in flight
 * @property {string[]} toolNames - Discovered raw tool names (once loaded)
 * @property {Record<string, boolean>} toolChecked - Per-tool exposed/hidden state
 */

/**
 * Whether a tool name is exposed under a {allow, deny} filter, mirroring the
 * Go `ToolFilter.allowsTool` semantics: a non-empty allow list is strict, then
 * deny subtracts. Pure — exported for unit testing.
 * @param {string} name - Raw MCP tool name
 * @param {{allow?: string[]|null, deny?: string[]}} filter - The filter
 * @returns {boolean} True when the tool is exposed
 */
export function mcpToolAllowed(name, filter) {
  const allow = filter && filter.allow;
  const deny = (filter && filter.deny) || [];
  if (Array.isArray(allow) && allow.length && !allow.includes(name)) return false;
  if (deny.includes(name)) return false;
  return true;
}

/**
 * Seed the MCP form's extra working state from a stored server entry. `toolAllow`
 * is null when no allowlist is configured (all tools exposed); `defaultArgsText`
 * is the pretty-printed JSON of the fixed arguments.
 * @param {import('../config-tab.js').SubprocessConfig} cfg - Stored entry (or {} when adding)
 * @returns {McpFormState} Extra working-state fields
 */
export function mcpSeedFormExtra(cfg) {
  const tools = (cfg && cfg.tools) || {};
  const args = (cfg && cfg.defaultArguments) || {};
  return {
    toolAllow: Array.isArray(tools.allow) ? tools.allow.slice() : null,
    toolDeny: Array.isArray(tools.deny) ? tools.deny.slice() : [],
    defaultArgsText: Object.keys(args).length ? JSON.stringify(args, null, 2) : '',
    toolsLoaded: false,
    toolsLoading: false,
    toolNames: [],
    toolChecked: {},
  };
}

/**
 * Build the `{tools, defaultArguments}` keys to persist from the MCP form's
 * working state. When the live tool list was loaded, the checkbox state drives an
 * allowlist (omitted entirely when every tool is checked). When it was never
 * loaded (adding, or server offline), the seeded filter is preserved verbatim so
 * an unreachable server's config is never silently rewritten. Throws on malformed
 * fixed-arguments JSON. Pure — exported for unit testing.
 * @param {McpFormState} f - The form working state
 * @returns {{tools?: {allow?: string[], deny?: string[]}, defaultArguments?: object}} Extra entry keys
 */
export function mcpFormToConfigExtra(f) {
  /** @type {{tools?: {allow?: string[], deny?: string[]}, defaultArguments?: object}} */
  const out = {};

  if (f.toolsLoaded) {
    const checked = (f.toolNames || []).filter((n) => f.toolChecked[n]);
    if (checked.length < (f.toolNames || []).length) {
      out.tools = { allow: checked };
    }
    // Every tool checked ⇒ omit `tools` (expose all).
  } else {
    /** @type {{allow?: string[], deny?: string[]}} */
    const tools = {};
    if (Array.isArray(f.toolAllow)) tools.allow = f.toolAllow;
    if (Array.isArray(f.toolDeny) && f.toolDeny.length) tools.deny = f.toolDeny;
    if (Object.keys(tools).length) out.tools = tools;
  }

  const text = (f.defaultArgsText || '').trim();
  if (text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Fixed arguments must be valid JSON.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Fixed arguments must be a JSON object.');
    }
    if (Object.keys(parsed).length) out.defaultArguments = parsed;
  }
  return out;
}

/**
 * Render the MCP-only form section: per-tool visibility checkboxes and a
 * fixed-arguments JSON field. Fetches the server's live tool list once (edit of a
 * running server); on add or when offline it shows a hint and leaves the seeded
 * filter untouched. Kept out of the generic controller via the renderFormExtra
 * spec hook.
 * @param {McpFormState} f - Form working state
 * @param {HTMLElement} wrap - Form element to append to
 * @param {import('../config-tab.js').ConfigTabController} ctrl - Owning controller (for re-render)
 * @returns {void}
 */
function renderMcpFormExtra(f, wrap, ctrl) {
  // --- Tools section ---
  const toolsField = document.createElement('div');
  toolsField.className = 'mcp-form-field';
  const toolsLabel = document.createElement('label');
  toolsLabel.className = 'mcp-field-label';
  toolsLabel.textContent = 'Tools';
  toolsField.appendChild(toolsLabel);

  if (f.mode === 'add' || !f.name) {
    toolsField.appendChild(mcpHint('Save the server first, then edit it to choose which tools are exposed. New servers expose all tools.'));
  } else if (f.toolsLoaded) {
    const names = f.toolNames || [];
    if (!names.length) {
      toolsField.appendChild(mcpHint('No tools discovered yet — the server may be stopped or still connecting. All tools stay exposed until you pick.'));
    } else {
      const enabled = names.filter((n) => f.toolChecked[n]).length;
      const summary = document.createElement('div');
      summary.className = 'mcp-field-hint';
      summary.textContent = `${enabled} / ${names.length} tools enabled. Unchecked tools are hidden from the model and cannot be called.`;
      toolsField.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'mcp-tool-filter-list';
      for (const name of names) {
        list.appendChild(mcpToolRow(f, name, ctrl));
      }
      toolsField.appendChild(list);

      // Warn about configured names no longer offered by the server.
      const configured = [...(f.toolAllow || []), ...(f.toolDeny || [])];
      const unknown = configured.filter((n) => !names.includes(n));
      if (unknown.length) {
        toolsField.appendChild(mcpHint(`Config references tools not offered by this server: ${unknown.join(', ')}. They will be dropped on save.`));
      }
    }
  } else {
    toolsField.appendChild(mcpHint('Loading tools…'));
    if (!f.toolsLoading) {
      f.toolsLoading = true;
      mcpListTools({ server: f.name })
        .then((res) => {
          if (ctrl.editing !== f) return; // form closed or switched
          const tools = Array.isArray(res && res.tools) ? res.tools : [];
          f.toolNames = tools.map((t) => t.name);
          f.toolChecked = {};
          for (const n of f.toolNames) {
            f.toolChecked[n] = mcpToolAllowed(n, { allow: f.toolAllow, deny: f.toolDeny });
          }
          f.toolsLoaded = true;
          f.toolsLoading = false;
          ctrl.render();
        })
        .catch(() => {
          if (ctrl.editing !== f) return;
          f.toolNames = [];
          f.toolsLoaded = true;
          f.toolsLoading = false;
          ctrl.render();
        });
    }
  }
  wrap.appendChild(toolsField);

  // --- Fixed arguments section ---
  const argsField = document.createElement('div');
  argsField.className = 'mcp-form-field';
  const argsLabel = document.createElement('label');
  argsLabel.className = 'mcp-field-label';
  argsLabel.textContent = 'Fixed arguments';
  argsField.appendChild(argsLabel);
  const ta = document.createElement('textarea');
  ta.className = 'mcp-input mcp-default-args-input';
  ta.rows = 4;
  ta.placeholder = '{\n  "bank_id": "general"\n}';
  ta.value = f.defaultArgsText || '';
  ta.addEventListener('input', () => { f.defaultArgsText = ta.value; });
  argsField.appendChild(ta);
  argsField.appendChild(mcpHint('A JSON object merged into every call to this server and hidden from the model. The configured value overrides anything the model supplies — use it to fix routing keys.'));
  wrap.appendChild(argsField);
}

/**
 * One tool checkbox row for the visibility filter.
 * @param {McpFormState} f - Form working state
 * @param {string} name - Raw tool name
 * @param {import('../config-tab.js').ConfigTabController} ctrl - Owning controller
 * @returns {HTMLElement} The row element
 */
function mcpToolRow(f, name, ctrl) {
  const row = document.createElement('label');
  row.className = 'mcp-tool-filter-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'mcp-tool-filter-cb';
  cb.checked = !!f.toolChecked[name];
  cb.addEventListener('change', () => {
    f.toolChecked[name] = cb.checked;
    ctrl.render(); // refresh the "N / M enabled" summary
  });
  const text = document.createElement('span');
  text.className = 'mcp-tool-filter-name';
  text.textContent = name;
  row.appendChild(cb);
  row.appendChild(text);
  return row;
}

/**
 * A small hint line reusing the form's hint styling.
 * @param {string} text - Hint text
 * @returns {HTMLElement} The hint element
 */
function mcpHint(text) {
  const hint = document.createElement('div');
  hint.className = 'mcp-field-hint';
  hint.textContent = text;
  return hint;
}

/**
 * Validate a proposed MCP server name. Names become part of the LLM tool id
 * (`mcp__<name>__<tool>`), so "juggler" is reserved for the built-in CLI bridge.
 * @type {(name: string, existingNames?: string[]) => string}
 */
export const validateMcpServerName = makeNameValidator({
  article: 'A',
  noun: 'server',
  reserved: 'juggler',
  reservedMsg: '"juggler" is reserved for the built-in tools.',
});

/**
 * Validate a proposed ACP agent name. Names become the model id under the ACP
 * provider — not a tool prefix — so no word is reserved (unlike MCP).
 * @type {(name: string, existingNames?: string[]) => string}
 */
export const validateAcpAgentName = makeNameValidator({ article: 'An', noun: 'agent' });

/**
 * Map an ACP agent's status string to the shared MCP status-dot CSS class
 * (reused for visual consistency): available→running (green), unavailable→
 * failed (red), disabled→stopped (grey).
 * @param {string} status
 * @returns {'running'|'failed'|'stopped'} The dot class suffix.
 */
export function acpDotClass(status) {
  if (status === 'available') return 'running';
  if (status === 'unavailable') return 'failed';
  return 'stopped';
}

/**
 * Best-effort: enable the "acp" provider so a newly-added agent shows up in the
 * picker immediately — the handler queues a provider recompute, whose
 * `providers-update` broadcast reaches every model selector. Failure is
 * non-fatal: the provider can still be toggled on manually in the Provider API
 * Keys tab.
 * @returns {Promise<void>}
 */
async function ensureAcpProviderEnabled() {
  try {
    await fetchJson(apiUrl('/config/provider-enabled'), {
      method: 'POST',
      body: { provider: 'acp', enabled: true },
    });
  } catch {
    // Non-fatal: the ACP provider can still be enabled manually.
  }
}

/**
 * Spec for the "MCP servers" tab: a stdio MCP server is a managed subprocess,
 * so it reports live status, supports Restart and a stderr Log disclosure, and
 * its name is a tool prefix (reserved-word validated). See {@link ConfigTabController}.
 * @type {import('../config-tab.js').ConfigTabSpec}
 */
const MCP_SPEC = {
  id: 'mcp',
  noun: 'server',
  formHostSelector: '#mcp-form',
  pollMs: MCP_POLL_MS,
  loadError: 'Failed to load MCP servers.',
  ops: {
    list: async () => (await mcpListServers()).servers || [],
    getConfig: () => mcpGetConfig(),
    setConfig: (scope, servers) => mcpSetConfig({ scope, servers }),
    restart: (name) => mcpServerControl({ server: name, action: 'restart' }),
    getLog: async (name) => (await mcpGetLog({ server: name })).log,
  },
  addLabel: 'Add server',
  emptyText: 'No MCP servers yet. Add one to give the assistant extra tools — for example a filesystem, GitHub, or database server.',
  // The rows below report the manager's view: servers run, discover tools, and
  // show green dots whether or not anything publishes those tools to the model.
  // With the extension off, every one of them is telling the truth and the whole
  // page is still wrong, so the page says which.
  notice: async () => (await isMcpExtensionDisabled() ? MCP_DISABLED_NOTICE : ''),
  // Importer seam: an "Import from…" button slots in next to Add later.
  toolbarExtra: (toolbar) => {
    const soon = document.createElement('span');
    soon.className = 'mcp-import-soon';
    soon.textContent = 'Importing from other apps is coming soon.';
    toolbar.appendChild(soon);
  },
  validateName: validateMcpServerName,
  dotClass: (s) => s.status || 'stopped',
  dotTitle: (s) => s.status || 'stopped',
  identityExtras: (s) => {
    if (!s.serverName) return null;
    const impl = document.createElement('span');
    impl.className = 'mcp-impl';
    impl.textContent = s.serverVersion ? `(${s.serverName} ${s.serverVersion})` : `(${s.serverName})`;
    return impl;
  },
  describe: (s) => formatMcpTokenCost(s),
  rowError: (s) => (s.status === 'failed' && s.error) ? (String(s.error).split('\n')[0] || '') : '',
  deleteConfirm: (name) => ({
    message: `Remove the MCP server "${name}"? Its tools will disappear from conversations.`,
    title: 'Remove server',
  }),
  formAddTitle: 'Add MCP server',
  namePlaceholder: 'name',
  nameHintAdd: 'A short id — becomes the tool prefix (mcp__<name>__…). No spaces or “/”.',
  nameHintEdit: 'Renaming means deleting and re-adding the server.',
  commandPlaceholder: 'npx',
  commandHint: 'The executable to launch (stdio transport).',
  argFirstPlaceholder: '-y',
  argRestPlaceholder: '@modelcontextprotocol/server-github',
  envKeyPlaceholder: 'API_TOKEN',
  saveFailMsg: 'Failed to save the server.',
  // MCP servers can be local subprocesses (stdio) or remote endpoints (http/sse).
  supportsTransport: true,
  urlPlaceholder: 'https://example.com/mcp',
  urlHint: 'The remote MCP endpoint URL (http/sse transport).',
  headerKeyPlaceholder: 'Authorization',
  // Per-server tool visibility filter + fixed arguments (MCP only).
  seedFormExtra: mcpSeedFormExtra,
  renderFormExtra: renderMcpFormExtra,
  formToConfigExtra: mcpFormToConfigExtra,
};

/**
 * Spec for the "ACP agents" tab: an ACP agent is spawned per-conversation with
 * no persistent process, so status is just PATH-resolvability (no Restart/Log),
 * its name is a model id (no reserved word), and a successful save auto-enables
 * the ACP provider. See {@link ConfigTabController}.
 * @type {import('../config-tab.js').ConfigTabSpec}
 */
const ACP_SPEC = {
  id: 'acp',
  noun: 'agent',
  formHostSelector: '#acp-form',
  pollMs: ACP_POLL_MS,
  loadError: 'Failed to load ACP agents.',
  ops: {
    list: async () => (await acpListAgents()).agents || [],
    getConfig: () => acpGetConfig(),
    setConfig: (scope, agents) => acpSetConfig({ scope, agents }),
  },
  addLabel: 'Add agent',
  emptyText: 'No ACP agents yet. Add one — for example Gemini CLI in ACP mode — and it will appear as a model in the picker.',
  validateName: validateAcpAgentName,
  dotClass: (s) => acpDotClass(s.status),
  dotTitle: (s) => s.status || 'unavailable',
  describe: (s) => s.command || '(no command)',
  rowError: (s) => (s.status === 'unavailable' && s.error) ? s.error : '',
  deleteConfirm: (name) => ({
    message: `Remove the ACP agent "${name}"? It will disappear from the model picker.`,
    title: 'Remove agent',
  }),
  formAddTitle: 'Add ACP agent',
  namePlaceholder: 'gemini',
  nameHintAdd: 'A short id — becomes the model name in the picker. No spaces or “/”.',
  nameHintEdit: 'Renaming means deleting and re-adding the agent.',
  commandPlaceholder: 'gemini',
  commandHint: 'The agent executable to launch (resolved on PATH).',
  argFirstPlaceholder: '--experimental-acp',
  argRestPlaceholder: 'value',
  envKeyPlaceholder: 'API_KEY',
  saveFailMsg: 'Failed to save the agent.',
  // Provider AutoDetect is computed once at startup (sync.Once), so it won't
  // notice an agent added mid-session; enabling the provider closes that gap.
  // Only for an enabled agent — a disabled one adds nothing to the picker.
  onAfterSave: async ({ enabled }) => { if (enabled) await ensureAcpProviderEnabled(); },
};

/**
 * "MCP servers" tab: managed stdio subprocesses (Restart + Log). Wraps a
 * {@link ConfigTabController} and, while visible, live-refreshes off the
 * `plugin-changed` broadcast — every config write / lifecycle change
 * auto-reconciles Go-side and broadcasts it, which is what flips a server
 * starting→running without the user clicking (the 2 s poll is a backstop).
 */
export class McpTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {ConfigTabController} @private */
    this.controller = new ConfigTabController(host, MCP_SPEC);
    /** @type {boolean} @private - True while this tab is the visible one. */
    this._visible = false;
    /** @type {(() => void)|null} @private - Live refresh off the plugin-changed broadcast. */
    this._onMcpChanged = () => {
      if (this._visible) this.controller.refresh();
    };
    wsService.on('plugin-changed', this._onMcpChanged);
  }

  /** Tab became visible: fetch and arm the controller's status poll. */
  show() {
    this._visible = true;
    this.controller.show();
  }

  /** Tab hidden: stop the controller's status poll. */
  hide() {
    this._visible = false;
    this.controller.stopPolling();
  }

  /**
   * Deep-link target: open the edit form for one server, so a tool elsewhere in
   * the UI can lead back to the server that provides it.
   * @param {string} name - MCP server name
   * @returns {Promise<boolean>} True if that server exists and its form opened
   */
  revealEntry(name) {
    return this.controller.revealEntry(name);
  }

  /** Panel closed: reset the controller to a clean list view. */
  close() {
    this._visible = false;
    this.controller.close();
  }

  /** Element disconnected: drop the plugin-changed subscription and stop polling. */
  dispose() {
    if (this._onMcpChanged) {
      wsService.off('plugin-changed', this._onMcpChanged);
      this._onMcpChanged = null;
    }
    this.controller.stopPolling();
  }
}

/**
 * "ACP agents" tab: per-conversation agents with no persistent process. A thin
 * {@link ConfigTabController} wrapper with no extra broadcast wiring.
 */
export class AcpTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {ConfigTabController} @private */
    this.controller = new ConfigTabController(host, ACP_SPEC);
  }

  /** Tab became visible: fetch and arm the controller's status poll. */
  show() {
    this.controller.show();
  }

  /** Tab hidden: stop the controller's status poll. */
  hide() {
    this.controller.stopPolling();
  }

  /** Panel closed: reset the controller to a clean list view. */
  close() {
    this.controller.close();
  }

  /** Element disconnected: stop polling. */
  dispose() {
    this.controller.stopPolling();
  }
}

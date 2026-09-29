//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { pinToPinboard, loadPinAgentDescriptors } from 'juggler/pinboard';

/**
 * The installed pinboard item types that describe themselves to the agent, by id.
 * Refreshed by prepareToolDefinitions() before each tool list is built, because
 * the set changes when the user installs, enables or disables an extension.
 * @type {Map<string, import('juggler/pinboard-item-type').PinAgentDescriptor>}
 */
let catalog = new Map();

/**
 * Stable JSON for a parameter object: same keys in the same order whatever order
 * the model wrote them in, so a repeat of the same request hashes to the same pin.
 * @param {Record<string, any>} parameters - The parameters to spell.
 * @returns {string} A stable spelling.
 */
function stableStringify(parameters) {
  return JSON.stringify(parameters, Object.keys(parameters).sort());
}

/**
 * Fold one type's parameters to the spelling that will be persisted, or null to
 * reject them. A type with a descriptor normalizes its own; anything else gets
 * only the check this tool can make without knowing the type — that there is an
 * object there at all — and is judged properly by its `normalizeConfig` when the
 * pin mounts.
 * @param {import('juggler/pinboard-item-type').PinAgentDescriptor|null} descriptor - The type's descriptor, if it has one.
 * @param {any} parameters - Raw parameters from the model.
 * @returns {Record<string, any>|null} Normalized parameters, or null.
 */
function normalizeParameters(descriptor, parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  return descriptor?.normalize ? descriptor.normalize(parameters) : parameters;
}

/**
 * What makes two requests the same pin.
 * @param {import('juggler/pinboard-item-type').PinAgentDescriptor|null} descriptor - The type's descriptor, if it has one.
 * @param {Record<string, any>} parameters - Normalized parameters.
 * @returns {string} The type-owned identity.
 */
function identityOf(descriptor, parameters) {
  return descriptor?.identity ? descriptor.identity(parameters) : stableStringify(parameters);
}

/**
 * What to call this pin in the UI and in the summary the model reads back. A type
 * that knows what identifies one of its pins says so; the rest are known by type.
 * @param {string} type - The pin type.
 * @param {Record<string, any>} [parameters] - Normalized parameters.
 * @returns {string} A short label.
 */
function pinLabel(type, parameters) {
  const descriptor = catalog.get(type);
  return (parameters && descriptor?.identity?.(parameters)) || type;
}

/**
 * Spell one type's parameter schema as a phrase, rather than making the model
 * read JSON schema inside a description.
 * @param {any} schema - The descriptor's `parameters` schema.
 * @returns {string} A phrase describing the parameters.
 */
function describeParameters(schema) {
  const properties = schema?.properties || {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const names = Object.keys(properties);
  if (!names.length) return 'No parameters.';
  const parts = names.map((name) => {
    const property = properties[name] || {};
    const kind = [property.type, required.has(name) ? 'required' : null].filter(Boolean).join(', ');
    return `\`${name}\`${kind ? ` (${kind})` : ''}${property.description ? ` — ${property.description}` : ''}`;
  });
  return `Parameters: ${parts.join(' ')}`;
}

/**
 * Mint the stable id for an agent-requested pin. A repeated call with the same
 * normalized request is the same id, so the server's idempotent add cannot stack
 * copies if a response was lost or the model asks twice.
 * @param {string} type - Public request type.
 * @param {string} identity - Type-owned stable identity.
 * @returns {Promise<string>} A pinboard-safe id.
 */
async function pinIdFor(type, identity) {
  const bytes = new TextEncoder().encode(`${type}\n${identity}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `agent_${hex}`;
}

/** The `pin_to_pinboard` tool: a one-way request to show something to the user. */
class PinToPinboardContextItem extends ContextItem {
  static MANIFEST = {
    id: 'pin-to-pinboard',
    name: 'Pin to Pinboard',
    version: '1.0.0',
    description: 'Show something on the user’s pinboard',
    author: 'Juggler',
    requiresApproval: false,
  };

  static getBadgeOptions() {
    return { color: 'meta', icon: 'icon-document' };
  }

  static getTypeName() {
    return 'Pin to Pinboard';
  }

  /**
   * Read the installed pin types before the tool list is built. The tool's whole
   * job is to name them, and a type the model is never told about is one it never
   * picks — which is how a `.cmajorpatch` ends up pinned as raw text.
   * @returns {Promise<void>} Resolves once the catalog is current.
   */
  static async prepareToolDefinitions() {
    try {
      catalog = new Map((await loadPinAgentDescriptors()).map((d) => [d.id, d]));
    } catch (err) {
      // Keep whatever we had. An empty catalog would silently take every type
      // away from the model, which is worse than describing a stale one.
      console.error('[PinToPinboard] Couldn’t read the pinboard item types:', err);
    }
  }

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definition.
   */
  static getToolDefinitions() {
    const listed = [...catalog.values()]
      .map((d) => `- \`${d.id}\` — ${d.description} ${describeParameters(d.parameters)}`)
      .join('\n');
    const description = [
      'Attach something to the user’s Pinboard and bring it into view. This is a one-way display action: you cannot list or read the user’s existing pins, and repeating a request reveals the existing pin instead of adding another.',
      'Choose the type that is *for* the thing you are showing, not the one that will accept it — several types accept a path, and the specific one knows how to run, render or summarize what is at the end of it.',
      'It is also how to show the user something you have made rather than describe it: write it to a file in the project and pin that file. An HTML file is shown as the rendered page, scripts running, with its source a click away — so a report, chart or mock-up can be looked at, not just read.',
      listed ? `Installed types:\n${listed}` : '',
      'A type installed after this list was built is accepted too: use its id and give it whatever parameters it expects, and it will validate its own config.',
    ].filter(Boolean).join('\n\n');

    return [{
      name: 'pin_to_pinboard',
      category: 'write',
      description,
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Which kind of Pinboard item to add — the id of one of the installed types listed above.',
          },
          parameters: {
            type: 'object',
            description: 'Parameters for the requested type, as listed above. Pass an empty object for a type that takes none.',
          },
        },
        required: ['type', 'parameters'],
      },
    }];
  }

  /**
   * Validate and normalize one type-specific request.
   * @param {Record<string, unknown>} toolInput - Raw model parameters.
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result.
   */
  async validate(toolInput) {
    const type = typeof toolInput?.type === 'string' ? toolInput.type.trim() : '';
    if (!type) {
      return { valid: false, error: 'Which pin type? Name one of the installed types.' };
    }
    const parameters = normalizeParameters(catalog.get(type) || null, toolInput.parameters);
    if (!parameters) {
      return { valid: false, error: `${type} parameters are invalid` };
    }
    return { valid: true, params: { type, parameters } };
  }

  /**
   * Add the pin to the shared main board and ask eligible viewers to reveal it.
   * @param {{type: string, parameters: Record<string, any>}} params - Validated request.
   * @returns {Promise<Record<string, unknown>>} Added pin descriptor.
   */
  async execute(params) {
    const descriptor = catalog.get(params.type) || null;
    const parameters = normalizeParameters(descriptor, params.parameters);
    if (!parameters) throw new Error(`${params.type} parameters are invalid`);

    const config = { ...parameters, agentRequested: true };
    const pin = await pinIdFor(params.type, identityOf(descriptor, parameters));
    const from = this.conversation?.id || '';
    if (!from) throw new Error('No conversation available to attribute the Pinboard request');
    const data = await pinToPinboard({
      id: pin,
      type: params.type,
      config,
      from,
      signal: this.signal,
    });
    const kept = Array.isArray(data?.pins)
      ? data.pins.find((candidate) => candidate?.id === pin)
      : null;
    if (!kept || kept.type !== params.type || JSON.stringify(kept.config) !== JSON.stringify(config)) {
      throw new Error('The pinboard did not keep the requested pin');
    }
    return { pin, type: params.type, parameters };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Tool outcome.
   * @returns {import('juggler/context-item').ItemSummary} Model-facing summary.
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Could not pin that');
    }
    const result = /** @type {{type?: string, parameters?: Record<string, any>}} */ (outcome.result) || {};
    const label = result.type ? pinLabel(result.type, result.parameters) : '';
    return this.successSummary(`Pinned ${label || 'the item'} and asked the user’s Pinboard to show it.`);
  }

  /**
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Execution state.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status row.
   */
  getStatusUI(actionStatus) {
    const typeName = 'pinned';
    if (!actionStatus || actionStatus.pending) {
      return { typeName, summary: actionStatus ? 'Pinning…' : 'Pin to Pinboard', status: actionStatus ? 'running' : undefined };
    }
    if (actionStatus.success) {
      const result = /** @type {{type?: string, parameters?: Record<string, any>}} */ (actionStatus.result || {});
      const summary = result.type ? pinLabel(result.type, result.parameters) : '';
      return { typeName, summary: summary || 'item', status: 'success' };
    }
    const terminal = this.resolveTerminalStatus(actionStatus, 'Could not pin that');
    return { typeName, summary: terminal.summary, status: terminal.status };
  }

  /**
   * Properties panel for a `pin_to_pinboard` action. Show the pin type and one
   * labeled row per argument the type was given, rather than the raw tool-call
   * JSON. Owns its whole display, so the generic Result section is suppressed.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection: boolean}} Suppress the generic result dump
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction } = ctx;
    const raw = toolAction && toolAction.get ? toolAction.get('result') : null;
    const result = raw && raw.toJSON ? raw.toJSON() : (raw || {});
    const data = (result.fullResult && result.fullResult.result) || {};

    const type = String(data.type || input.type || '').trim();
    helpers.addSubsection(wrapper, 'Type', type || 'unknown', 'properties-panel-code');

    // Prefer the normalized parameters the pin was actually created with.
    const parameters = (data.parameters && typeof data.parameters === 'object' ? data.parameters : input.parameters) || {};
    const entries = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? Object.entries(parameters)
      : [];
    if (!entries.length) {
      helpers.addSubsection(wrapper, 'Parameters', 'None.', 'properties-panel-text');
    }
    for (const [name, value] of entries) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      if (value !== null && typeof value === 'object') {
        helpers.addSubsection(wrapper, label, JSON.stringify(value, null, 2), 'properties-panel-code', { language: 'json' });
      } else {
        helpers.addSubsection(wrapper, label, String(value), 'properties-panel-code');
      }
    }

    return { skipResultSection: true };
  }
}

export default PinToPinboardContextItem;

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

import { modelLabelFromList } from '../../model/model-display.js';
import { buildModelConfig } from '../../model/model-config.js';
import { presentPopup } from '../../utils/popup-surface.js';
import { closePopupById } from '../../utils/popup-manager.js';
import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';
import { buildToggleRow } from './notifications-tab.js';
import '../model-picker/model-chip.js';
import { MODEL_PICKER_OFF } from '../model-picker/model-picker.js';
import { isDefaultFileEditingOn, setDefaultFileEditingOn } from '../../services/file-editing-permission.js';
import { setAutoNameEnabledCached } from '../../services/auto-name-setting.js';
import defaultModelCache from '../../services/default-model-cache.js';
import { setReplySuggestionsEnabledCached } from '../../services/reply-suggestions-setting.js';
import strategyRegistry from '../../registries/strategy-registry.js';
import { getDefaultStrategyId, setDefaultStrategyId, BUILTIN_DEFAULT_STRATEGY_ID } from '../../services/default-strategy.js';
import {
  CONTEXT_CHOICES, contextLabel, defaultDiffView, setDefaultDiffView,
  defaultDiffContext, setDefaultDiffContext,
} from '../../utils/diff-view-prefs.js';
import { fetchJson } from '../../services/http.js';
import { showAlert } from '../modal-dialog.js';

/**
 * Popup id shared by both model rows, so opening one row's picker closes the
 * other's — two pickers over one modal would be two answers to one question.
 */
const MODEL_PICKER_POPUP_ID = 'settings-model-picker';

/**
 * "Defaults" tab (id `defaults`): the default-model picker and new-conversation
 * defaults, the cheap-model section (the picker plus a row per background job
 * that spends it — naming conversations, suggesting replies), the global
 * stream-idle-timeout field, and how diffs are drawn. Seeded from the shared
 * loadConfig() fetch; the pickers persist immediately via PUT /api/default-model
 * and PUT /api/cheap-model, the rest via PUT /api/config.
 *
 * The diff rows are the exception to that last clause: they are display
 * preferences nothing on the server reads, so they persist through
 * utils/diff-view-prefs.js (the `user` realm) rather than to credentials.json,
 * and they take effect in every diff already on screen rather than on the next
 * turn.
 */
export class DefaultsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    /** @type {{provider: string, model: string, thinking?: string, serviceTier?: string, explicit?: boolean}} @private - Model new conversations are seeded with; explicit=false means automatic. thinking empty ⇒ the model's default level, serviceTier empty ⇒ standard serving. */
    this.defaultModel = { provider: '', model: '', explicit: false };
    /** @type {{provider?: string, model?: string, thinking?: string, serviceTier?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}} @private - Cheap model for out-of-band micro-tasks. explicit=false means Auto; disabled=true means the user wants none, which Auto cannot express. */
    this.cheapModel = { explicit: false };
  }

  /**
   * Receive the shared loadConfig() payload: store config/providers/defaultModel
   * and (on a full render) build the fields.
   * @param {{config: object, providers: any[], defaultModel: {provider: string, model: string, thinking?: string, serviceTier?: string, explicit?: boolean}, cheapModel?: {provider?: string, model?: string, thinking?: string, serviceTier?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    this.defaultModel = data.defaultModel;
    if (data.cheapModel) this.cheapModel = data.cheapModel;
    // Keep the client-side auto-naming cache in step with the server on every
    // config load, so the conversation bar's new-tab decision stays current even
    // when the settings panel isn't rendering fields.
    setAutoNameEnabledCached(!(/** @type {any} */ (this.config).autoNameDisabled));
    // The same for reply suggestions, which the server never reads back — this
    // load is how the browser learns the setting at all, and until it lands the
    // feature holds its tongue.
    setReplySuggestionsEnabledCached(!(/** @type {any} */ (this.config).replySuggestionsDisabled));
    if (renderFields) {
      this.renderGlobalSettings();
      this.renderDefaultModelField();
      this.renderCheapModelField();
      this.renderAutoNameSettings();
      this.renderReplySuggestionsSettings();
      this.renderNewConversationDefaults();
    }
  }

  /**
   * Resolve the currently attached UI session (for reading/writing per-project
   * new-conversation defaults). Null when no session is attached (e.g. settings opened
   * before a project loads).
   * @returns {import('../../model/session.js').default|null} The active session, or null.
   * @private
   */
  _getSession() {
    return /** @type {any} */ (window).jugglerApp?.getSession?.() || null;
  }

  /**
   * Render the "New conversation defaults" section's per-project fields: the strategy
   * a conversation starts on, and whether it starts with edits allowed instead of
   * asking. Persisted to session metadata, so they survive restarts and are shared
   * across windows on the same project. The section's other field, the default model,
   * is rendered separately by renderDefaultModelField() into a sibling container, since
   * it's a global setting rather than a per-project one.
   * @private
   */
  renderNewConversationDefaults() {
    const container = this.host.querySelector('#new-conversation-defaults-fields');
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(this._buildDefaultStrategyRow());

    const { row } = buildToggleRow(
      'Allow file edits in new conversations',
      'Start each new conversation with file editing already allowed, so the agent can edit ' +
      'without asking first — handy when your project is in version control. Each conversation ' +
      'can still be toggled individually, and edits outside the project and allowed ' +
      'paths always prompt.',
      isDefaultFileEditingOn(this._getSession()),
      (on) => setDefaultFileEditingOn(this._getSession(), on),
    );
    container.appendChild(row);
  }

  /**
   * Render the auto-naming row inside the cheap-model card: the global on/off
   * switch with an optional custom instruction stacked beneath it, shown only
   * while auto-naming is on. Both persist to credentials.json via PUT
   * /api/config; the server reads them live for the next naming attempt. When
   * on (the default), a new conversation keeps its "Untitled N" name and the composer takes
   * focus, and the cheap model derives a title after the first message; when
   * off, the new conversation opens its inline rename editor instead and no title is
   * auto-derived.
   * @private
   */
  renderAutoNameSettings() {
    const container = this.host.querySelector('#auto-name-form');
    if (!container) return;
    container.innerHTML = '';

    // The optional custom instruction, built first so the toggle's handler can
    // reveal or hide it. It shares the toggle's card (appended into the same
    // control column below), so the switch and the prompt it shapes read as one
    // grouped setting rather than two separate rows.
    const instruction = this._buildAutoNameInstructionControl();
    instruction.hidden = !!(/** @type {any} */ (this.config).autoNameDisabled);

    // On/off switch. Checked = enabled; we persist the *disabled* bool so the
    // stored key is absent by default (default-on).
    const { row, input: toggleInput } = buildToggleRow(
      'Name new conversations',
      'Derives a tab title from your first message. Turn this off to name new ' +
      'conversations yourself.',
      !(/** @type {any} */ (this.config).autoNameDisabled),
      async (on) => {
        const previous = toggleInput.checked;
        try {
          await fetchJson('/api/config', { method: 'PUT', body: { auto_name_disabled: !on } });
          /** @type {any} */ (this.config).autoNameDisabled = !on;
          setAutoNameEnabledCached(on);
          // The instruction only shapes an auto-derived title, so hide it while
          // auto-naming is off; the stored value is kept and reappears on re-enable.
          instruction.hidden = !on;
        } catch (e) {
          console.error('[SettingsPanel] Failed to save auto-naming setting:', e);
          toggleInput.checked = !previous;
        }
      },
    );

    // Stack the instruction beneath the switch in the toggle's own control
    // column, so both controls live in a single card.
    row.querySelector('.provider-control')?.appendChild(instruction);
    container.appendChild(row);
  }

  /**
   * Render the reply-suggestions row inside the cheap-model card: the global
   * on/off switch for the few things you might say next, offered under a
   * finished turn. Persists to credentials.json via PUT /api/config like the
   * auto-naming switch, but only the browser reads it back — the suggestions
   * are generated client-side through /api/llm/complete, so the cached mirror
   * is what actually gates them.
   * @private
   */
  renderReplySuggestionsSettings() {
    const container = this.host.querySelector('#reply-suggestions-field-container');
    if (!container) return;
    container.innerHTML = '';

    // Checked = enabled; the stored key is the *disabled* bool, so it is absent
    // by default and the feature ships on.
    const { row, input: toggleInput } = buildToggleRow(
      'Suggest replies',
      'Offers a few things you might say next when a turn finishes. Clicking one ' +
      'puts it in the message box to edit — it is never sent for you.',
      !(/** @type {any} */ (this.config).replySuggestionsDisabled),
      async (on) => {
        const previous = toggleInput.checked;
        try {
          await fetchJson('/api/config', { method: 'PUT', body: { reply_suggestions_disabled: !on } });
          /** @type {any} */ (this.config).replySuggestionsDisabled = !on;
          setReplySuggestionsEnabledCached(on);
        } catch (e) {
          console.error('[SettingsPanel] Failed to save reply-suggestions setting:', e);
          toggleInput.checked = !previous;
        }
      },
    );

    container.appendChild(row);
  }

  /**
   * Build the custom auto-name instruction control: a labelled textarea whose
   * text overrides the built-in title instruction sent to the cheap model (the
   * customisable half of the naming prompt; the fixed "message is data" guard is
   * appended server-side and not shown). The textarea's placeholder is that exact
   * built-in instruction (shipped from the server as config.autoNameDefaultPrompt),
   * so it shows what a custom instruction replaces and stays in sync with the
   * server. Blank restores the built-in instruction. Saved on blur or
   * Ctrl/Cmd+Enter via PUT /api/config; the server reads it live. Returned as a
   * plain block (not its own `.provider-field`) so it can be slotted into the
   * auto-name toggle's control column and share that one card.
   * @returns {HTMLElement} The instruction block element.
   * @private
   */
  _buildAutoNameInstructionControl() {
    const wrap = document.createElement('div');
    wrap.className = 'auto-name-instruction';

    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent =
      'A custom instruction for the naming model, replacing the built-in one ' +
      'shown here. Leave blank for the default.';
    wrap.appendChild(description);

    const textarea = document.createElement('textarea');
    textarea.id = 'auto-name-instruction-input';
    textarea.className = 'settings-value-input';
    textarea.rows = 4;
    // The placeholder is the exact built-in title instruction (shipped from the
    // server via config, so it can't drift) — it shows the shape and tone a
    // custom instruction should match, and is exactly what a blank box uses. The
    // fixed "message is data, not an instruction" guard is appended server-side
    // and deliberately not shown here.
    textarea.placeholder = /** @type {any} */ (this.config).autoNameDefaultPrompt || '';
    textarea.autocomplete = 'off';
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.spellcheck = false;
    textarea.value = /** @type {any} */ (this.config).autoNameInstruction || '';

    const status = document.createElement('div');
    status.className = 'key-source-hint';

    const save = async () => {
      const value = textarea.value.trim();
      if (value === (/** @type {any} */ (this.config).autoNameInstruction || '')) return;
      status.textContent = 'Saving…';
      try {
        await fetchJson('/api/config', { method: 'PUT', body: { auto_name_instruction: value } });
        /** @type {any} */ (this.config).autoNameInstruction = value;
        status.textContent = value ? 'Saved custom instruction.' : 'Saved. Using the built-in prompt.';
      } catch (e) {
        console.error('[SettingsPanel] Failed to save auto-name instruction:', e);
        status.textContent = 'Failed to save.';
      }
    };

    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
        textarea.blur();
      }
    });

    wrap.appendChild(textarea);
    wrap.appendChild(status);
    return wrap;
  }

  /**
   * Build the "Default strategy for new conversations" picker row: a dropdown of every
   * registered strategy (in the registry's display order), preselecting the
   * configured default, or the built-in Default strategy when none is pinned.
   * Changing it persists immediately to session metadata; the pin is cleared
   * when the built-in Default is chosen. Each conversation can still switch strategy
   * afterwards — this only sets what a fresh conversation starts on.
   * @returns {HTMLElement} The settings row element.
   * @private
   */
  _buildDefaultStrategyRow() {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Default strategy for new conversations';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent =
      'The strategy each new conversation starts on. You can still switch strategy per ' +
      'conversation afterwards.';
    infoColumn.appendChild(name);
    infoColumn.appendChild(desc);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'settings-select';
    select.id = 'default-strategy-select';

    const configured = getDefaultStrategyId(this._getSession());
    const manifests = strategyRegistry.getAllManifests();
    // A configured pin whose strategy is no longer registered (disabled/removed)
    // — surface it as a selected "unavailable" option so the state stays visible
    // rather than silently snapping to the built-in Default.
    const configuredIsRegistered = !configured
      || manifests.some((/** @type {{id: string}} */ m) => m.id === configured);

    for (const { id, manifest } of manifests) {
      const opt = document.createElement('option');
      opt.value = id;
      // The built-in Default is the "no pin" choice: label it so, and select it
      // when nothing (or 'default') is configured.
      opt.textContent = id === BUILTIN_DEFAULT_STRATEGY_ID
        ? `${manifest.name} (built-in default)`
        : manifest.name;
      if (configuredIsRegistered
        ? (configured ? id === configured : id === BUILTIN_DEFAULT_STRATEGY_ID)
        : false) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    if (!configuredIsRegistered && configured) {
      const opt = document.createElement('option');
      opt.value = configured;
      opt.textContent = `${configured} — unavailable`;
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }

    select.addEventListener('change', () => {
      setDefaultStrategyId(this._getSession(), select.value);
    });

    controlColumn.appendChild(select);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    return row;
  }

  /**
   * Render global settings that apply across every provider, shown as a section
   * on the Defaults tab: the automatic-compaction on/off switch, the stream
   * idle timeout (the window a streaming provider waits for the next event
   * before declaring the connection dead, "stream stalled: no data for 3m0s";
   * raising it helps gateways whose cold starts exceed the 180s default), and
   * the conversation spend ceiling (how many NEW input tokens one conversation
   * may spend across all its threads — cache reads excluded, since a re-sent
   * prompt is not fresh spend — before delegated work is asked to land). All
   * persist to credentials.json via PUT /api/config; the server reads them live.
   * @private
   */
  renderGlobalSettings() {
    const container = this.host.querySelector('#global-settings');
    if (!container) return;
    container.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'Context';
    container.appendChild(heading);

    // Automatic compaction on/off. Checked = enabled; we persist the *disabled*
    // bool so the stored key is absent by default (default-on). The honest
    // second sentence discloses the "fully off" consequence to the person
    // deliberately flipping the switch.
    const { row: autoCompactRow, input: autoCompactInput } = buildToggleRow(
      'Automatic compaction',
      'When a conversation nears the model\u2019s context limit, Juggler summarizes ' +
      'older turns to make room. Turn this off to keep full transcripts \u2014 long ' +
      'conversations may then hit the model\u2019s limit and error.',
      !(/** @type {any} */ (this.config).autoCompactDisabled),
      async (on) => {
        const previous = autoCompactInput.checked;
        try {
          await fetchJson('/api/config', { method: 'PUT', body: { auto_compact_disabled: !on } });
          /** @type {any} */ (this.config).autoCompactDisabled = !on;
        } catch (e) {
          console.error('[SettingsPanel] Failed to save automatic compaction setting:', e);
          autoCompactInput.checked = !previous;
        }
      },
    );
    container.appendChild(autoCompactRow);

    this._appendNumberField(container, {
      heading: 'Stream idle timeout',
      name: 'Seconds to wait',
      description:
        'Seconds to wait for the next stream event before treating the connection ' +
        'as dropped ("stream stalled"). Raise it for gateways with slow cold ' +
        'starts. Leave blank for the default (180).',
      inputId: 'stream-idle-timeout-input',
      placeholder: '180',
      current: () => /** @type {any} */ (this.config).streamIdleTimeout || '',
      validate: (value) => (parseInt(value, 10) <= 0 ? 'Must be greater than zero.' : ''),
      save: async (value) => {
        await fetchJson('/api/config', { method: 'PUT', body: { stream_idle_timeout: value } });
        /** @type {any} */ (this.config).streamIdleTimeout = value;
        return value ? `Saved. Waiting up to ${value}s.` : 'Saved. Using default (180s).';
      },
      failureLog: 'stream idle timeout',
    });

    // The conversation spend ceiling. Stored in tokens and shown in millions:
    // the figure people reason about is "twenty million", and a field asking
    // them to count zeroes invites the slip that switches the guard off.
    this._appendNumberField(container, {
      heading: 'Spend ceiling',
      name: 'Million tokens per conversation',
      description:
        'Counts the input a conversation has not already paid for, across all of ' +
        'its threads: context re-read from cache does not add to it. Past the ' +
        'ceiling, sub-threads an agent started are asked to finish up and report ' +
        'what they have, and no new ones are started — in your own threads too, ' +
        'though your turns are never stopped. Leave blank for the default (10). ' +
        '0 removes the ceiling.',
      inputId: 'spend-limit-input',
      placeholder: '10',
      current: () => {
        const tokens = parseInt(/** @type {any} */ (this.config).spendLimitTokens, 10);
        return Number.isFinite(tokens) ? String(Math.round(tokens / 1_000_000)) : '';
      },
      save: async (value) => {
        const tokens = value === '' ? '' : String(parseInt(value, 10) * 1_000_000);
        await fetchJson('/api/config', { method: 'PUT', body: { spend_limit_tokens: tokens } });
        /** @type {any} */ (this.config).spendLimitTokens = tokens;
        if (value === '') return 'Saved. Using the default (10M).';
        return value === '0' ? 'Saved. No ceiling.' : `Saved. Stopping delegated work past ${value}M.`;
      },
      failureLog: 'spend ceiling',
    });

    this._appendDiffSettings(container);
  }

  /**
   * How diffs are drawn, everywhere one is shown: the two-column layout, and how
   * much of the file to show around each change.
   *
   * These are what a NEW diff starts on. Any diff can be set on its own from the
   * controls on it, and while it is, it stops following these — so changing one
   * here moves every diff the reader has not already had an opinion about.
   *
   * Unlike everything above, they persist through the `user` preference realm
   * rather than PUT /api/config: nothing on the server reads them, and a display
   * choice belongs with the tips you have seen and the bell, not in
   * credentials.json beside the spend ceiling.
   * @param {Element} container - The form to append to.
   * @private
   */
  _appendDiffSettings(container) {
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'Diffs';
    container.appendChild(heading);

    const { row: splitRow } = buildToggleRow(
      'Side-by-side diffs',
      'Show the old and new file in two columns instead of one combined list. ' +
      'Needs a wide enough panel — a diff with no room for two columns shows the ' +
      'combined list whatever this says.',
      defaultDiffView() === 'split',
      (on) => setDefaultDiffView(on ? 'split' : 'inline'),
    );
    container.appendChild(splitRow);

    const contextRow = document.createElement('div');
    contextRow.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Lines of context';
    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent =
      'Unchanged lines shown above and below each change, so you can see what it ' +
      'sits in. More is more to read; the whole file is every line of it.';
    info.appendChild(name);
    info.appendChild(description);

    const control = document.createElement('div');
    control.className = 'provider-control';
    const select = document.createElement('select');
    select.className = 'settings-select';
    select.id = 'diff-context-select';
    const current = defaultDiffContext();
    for (const lines of CONTEXT_CHOICES) {
      const option = document.createElement('option');
      option.value = String(lines);
      option.textContent = contextLabel(lines);
      if (lines === current) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => setDefaultDiffContext(Number(select.value)));
    control.appendChild(select);

    contextRow.appendChild(info);
    contextRow.appendChild(control);
    container.appendChild(contextRow);
  }

  /**
   * Append one labelled whole-number setting: heading, name, description, and a
   * text input that saves on blur and on Enter. Blank always means "use the
   * default", so every field built here can be cleared back to the shipped
   * behaviour without a separate control saying so.
   *
   * `current` is read rather than captured because the saved value is written
   * back onto `this.config`, and a re-render must show what was saved rather
   * than what was there when the field was built.
   * @private
   * @param {Element} container
   * @param {object} opts
   * @param {string} opts.heading - Section heading above the field.
   * @param {string} opts.name - Short label for the value itself.
   * @param {string} opts.description - The explanatory line under the label.
   * @param {string} opts.inputId - DOM id for the input.
   * @param {string} opts.placeholder - Shown when the field is blank (the default).
   * @param {() => string} opts.current - The currently saved value, as displayed.
   * @param {(value: string) => string} [opts.validate] - Returns an error message for a non-blank value, or ''.
   * @param {(value: string) => Promise<string>} opts.save - Persists the value; resolves with the status line to show.
   * @param {string} opts.failureLog - What to call this setting in the console on failure.
   */
  _appendNumberField(container, opts) {
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = opts.heading;
    container.appendChild(heading);

    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = opts.name;
    infoColumn.appendChild(nameLabel);
    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent = opts.description;
    infoColumn.appendChild(description);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const row = document.createElement('div');
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = opts.inputId;
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.inputMode = 'numeric';
    input.placeholder = opts.placeholder;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = opts.current();
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === opts.current()) return;
      if (value !== '' && !/^\d+$/.test(value)) {
        status.textContent = 'Enter a whole number.';
        return;
      }
      const invalid = value === '' ? '' : (opts.validate?.(value) || '');
      if (invalid) {
        status.textContent = invalid;
        return;
      }
      status.textContent = 'Saving…';
      try {
        status.textContent = await opts.save(value);
      } catch (e) {
        console.error(`[SettingsPanel] Failed to save ${opts.failureLog}:`, e);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    controlColumn.appendChild(row);
    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Render the "Default model" row: the model new conversations are seeded
   * with. The chip opens the shared picker, whose bottom row ("Automatic")
   * clears the stored value and lets the server pick a preferred available
   * model. Every change persists immediately via PUT /api/default-model, and the
   * resolved choice is described in the status line under the chip.
   * @private
   */
  renderDefaultModelField() {
    this._renderModelRow({
      containerId: '#default-model-field-container',
      nameLabel: 'Default model for new conversations',
      current: this.defaultModel || { provider: '', model: '', explicit: false },
      statusText: (ref) => this._defaultModelStatusText(ref),
      onSave: (config) => this._saveDefaultModel(config),
    });
  }

  /**
   * Render the "Cheap model" row: the picker at the head of the section's card,
   * above the rows for the jobs that spend it. "Automatic" clears the stored
   * value and derives one from the model in use. Persists via PUT
   * /api/cheap-model.
   *
   * The label is bare because the section heading and its description already
   * say what a cheap model is and what uses it; only the "Automatic" half needs
   * explaining on the row itself.
   * @private
   */
  renderCheapModelField() {
    this._renderModelRow({
      containerId: '#cheap-model-field-container',
      nameLabel: 'Cheap model',
      description: '"Automatic" derives one from the model in use.',
      current: this.cheapModel || { explicit: false },
      // The one row with a third state. Turning it off is a real answer — the
      // tasks it runs are optional — and recording it is what stops the server
      // deriving a model anyway, and stops it mentioning that it can't.
      offLabel: 'Off — no cheap model',
      statusText: (ref) => this._cheapModelStatusText(ref),
      onSave: (config) => this._saveCheapModel(config),
    });
  }

  /**
   * Shared renderer for the Default/Cheap model rows: a `<model-chip>` that
   * opens the same `<model-picker>` the composer uses, and a status line
   * describing the current (or auto-resolved) choice.
   *
   * The picker is the whole control here — model, thinking level and serving
   * speed all come back on one `change` as a complete config, so these rows
   * store exactly what a conversation stores.
   * @param {object} opts
   * @param {string} opts.containerId - CSS selector for the field container.
   * @param {string} opts.nameLabel - Field label text.
   * @param {string} [opts.description] - Optional description under the label.
   * @param {{provider?: string, model?: string, thinking?: string, serviceTier?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}} opts.current
   * @param {string} [opts.offLabel] - Label for the picker's Off row; omitted leaves the row out.
   * @param {(ref: any) => string} opts.statusText - Builds the status line.
   * @param {(config: import('../../model/model-config.js').ModelConfigShape) => void} opts.onSave - Persists the chosen config, or null for Automatic.
   * @private
   */
  _renderModelRow({ containerId, nameLabel, description, current, offLabel, statusText, onSave }) {
    const container = this.host.querySelector(containerId);
    if (!container) return;
    container.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = nameLabel;
    infoColumn.appendChild(name);

    if (description) {
      const desc = document.createElement('div');
      desc.className = 'provider-description';
      desc.textContent = description;
      infoColumn.appendChild(desc);
    }

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const ref = current || { explicit: false };
    // Automatic is the ABSENCE of a config, which is exactly what the picker's
    // none row and the chip's placeholder already mean.
    const config = ref.explicit && ref.provider && ref.model
      ? buildModelConfig(ref.provider, ref.model, ref.thinking, ref.serviceTier)
      : null;
    const isOff = !!ref.disabled;

    const chip = /** @type {any} */ (document.createElement('model-chip'));
    chip.update({
      providers: this.providers,
      // Off has no config either, so without its own word on the chip it would
      // be indistinguishable from Automatic without opening the picker.
      placeholder: isOff ? 'Off' : 'Automatic',
      buttonTitle: nameLabel,
      config,
    });
    chip.addEventListener('chip-toggle', () => this._openModelPicker(chip, config, onSave, { offLabel, isOff }));
    // The pill promises its mini popover, so an open picker gets out of the way
    // first. Closing leaves the chip's DOM alone, so the pill is still the
    // anchor the popover then attaches to.
    chip.addEventListener('mini-requested', () => closePopupById(MODEL_PICKER_POPUP_ID));
    // The chip's own mini popover changes the thinking level without the picker.
    chip.addEventListener('change', (/** @type {Event} */ e) => {
      onSave(/** @type {CustomEvent} */ (e).detail);
    });

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = statusText(ref);

    controlColumn.appendChild(chip);
    controlColumn.appendChild(status);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    container.appendChild(row);
  }

  /**
   * Open the shared picker against one settings row.
   *
   * The settings panel is a modal, so two things matter here: the picker's own
   * Escape handling closes only the picker (popup-manager's Escape dismisses
   * every overlay, modal included), and one popup id across both rows means
   * opening the second row's picker closes the first.
   * @param {any} chip - The `<model-chip>` the picker anchors to.
   * @param {import('../../model/model-config.js').ModelConfigShape} value - The config in effect.
   * @param {(config: import('../../model/model-config.js').ModelConfigShape) => void} onSave
   * @param {{offLabel?: string, isOff?: boolean}} [opts] - The Off row, for a row that has one.
   * @private
   */
  _openModelPicker(chip, value, onSave, { offLabel, isOff } = {}) {
    // Second press on the same chip dismisses rather than re-opening.
    if (closePopupById(MODEL_PICKER_POPUP_ID)) return;

    const picker = /** @type {any} */ (document.createElement('model-picker'));
    picker.providers = this.providers;
    picker.value = value;
    picker.noneLabel = 'Automatic';
    if (offLabel) picker.offLabel = offLabel;
    picker.off = !!isOff;

    /** @type {(() => void)|null} */
    let release = null;
    const close = () => {
      if (release) {
        release();
        release = null;
      }
    };

    picker.addEventListener('change', (/** @type {Event} */ e) => {
      close();
      onSave(/** @type {CustomEvent} */ (e).detail);
    });
    picker.addEventListener('close', close);

    release = presentPopup({
      surface: picker,
      anchor: chip.button || chip,
      id: MODEL_PICKER_POPUP_ID,
      onClose: close,
      insideSelectors: ['model-chip', '.model-picker'],
    });
  }

  /**
   * The request body for a model row: the whole config, or the empty pair that
   * clears the stored value back to Automatic. Both dials ride along, since a
   * stored default that dropped one would seed something the user never chose.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @returns {{provider: string, model: string, thinking?: string, serviceTier?: string}} The PUT body.
   * @private
   */
  _modelRowBody(config) {
    if (!config?.provider || !config?.model) return { provider: '', model: '' };
    /** @type {{provider: string, model: string, thinking?: string, serviceTier?: string}} */
    const body = { provider: config.provider, model: config.model };
    if (config.thinking) body.thinking = config.thinking;
    if (config.serviceTier) body.serviceTier = config.serviceTier;
    return body;
  }

  /**
   * Persist the chosen cheap model: a config pins it, null is Automatic, and
   * the picker's Off sentinel records that the user wants none at all.
   *
   * Off is sent as its own flag rather than as the empty pair, because the
   * empty pair is Automatic — stored that way, "no cheap model" would be read
   * back as "pick me one", which is the opposite instruction.
   *
   * Applied optimistically — the row repaints before the request lands, and is
   * put back as it was if the save fails, so the chip never shows a choice the
   * server rejected.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @private
   */
  async _saveCheapModel(config) {
    const previous = this.cheapModel;
    const off = /** @type {any} */ (config) === MODEL_PICKER_OFF || !!(/** @type {any} */ (config)?.off);
    const body = off ? { provider: '', model: '', disabled: true } : this._modelRowBody(config);
    this.cheapModel = {
      provider: body.provider,
      model: body.model,
      thinking: /** @type {any} */ (body).thinking || '',
      serviceTier: /** @type {any} */ (body).serviceTier || '',
      explicit: !!(body.provider && body.model),
      disabled: off,
    };
    this.renderCheapModelField();
    try {
      await fetchJson('/api/cheap-model', { method: 'PUT', body });
      // Cleared to Automatic: re-fetch so the auto-derived name in the status
      // line is the one the server actually resolved. Off needs no such trip —
      // there is nothing for the server to have derived.
      if (!off && (!body.provider || !body.model)) {
        this.cheapModel = await fetchJson('/api/cheap-model', { fallback: null }) || { explicit: false };
        this.renderCheapModelField();
      }
    } catch (err) {
      console.error('[SettingsPanel] Failed to save cheap model:', err);
      this.cheapModel = previous;
      this.renderCheapModelField();
      await showAlert(`Couldn't save the cheap model.\n\n${extractErrorMessage(err)}`, 'Error');
    }
  }

  /**
   * @param {{provider: string, model: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} ref
   * @returns {string} short status describing the current default-model state
   * @private
   */
  _defaultModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      if (ref && ref.provider && ref.model) {
        return `Auto — currently ${modelLabelFromList(this.providers, ref.provider, ref.model)}.`;
      }
      return 'Auto — no provider is configured yet.';
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * The cheap row's status line, which has three states to tell apart and used
   * to have two. "Auto" with nothing resolved is the one that matters: it is a
   * provider offering no cheap tier, and while the row described that as a
   * model having been derived, the tasks were silently not running with nothing
   * on screen to suggest it.
   * @param {{provider?: string, model?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}} ref
   * @returns {string} short status describing the current cheap-model state
   * @private
   */
  _cheapModelStatusText(ref) {
    if (ref && ref.disabled) return 'Off — background tasks won\'t run.';
    if (!ref || !ref.explicit) {
      const auto = ref && ref.autoResolved;
      if (auto && auto.provider && auto.model) {
        return `Auto — currently ${modelLabelFromList(this.providers, auto.provider, auto.model)}.`;
      }
      return 'Auto — nothing available for this provider.';
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * Status hint shared by both pickers for an explicitly-pinned model: reports
   * whether its provider is registered/available and the model still listed.
   * @param {{provider?: string, model?: string}} ref
   * @returns {string} the status hint for the pinned model
   * @private
   */
  _explicitModelStatusText(ref) {
    const p = this.providers.find((/** @type {any} */ pp) => pp.name === ref.provider);
    if (!p) return 'Provider not registered.';
    if (!p.available) return p.authType === 'oauth_bearer'
      ? (p.authHint || 'Provider is unavailable. Sign in to continue.')
      : 'Provider is configured but has no API key.';
    const hasModel = p.modelsWithContext && p.modelsWithContext.some((/** @type {{id: string}} */ m) => m.id === ref.model);
    if (p.modelsWithContext && !hasModel) {
      return 'Model is not in the provider’s current model list.';
    }
    return 'Active.';
  }

  /**
   * Persist the chosen default model. A null config clears it (Automatic).
   *
   * Applied optimistically, and reverted if the save fails — same contract as
   * the cheap model's row.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @private
   */
  async _saveDefaultModel(config) {
    const previous = this.defaultModel;
    const body = this._modelRowBody(config);
    this.defaultModel = {
      provider: body.provider,
      model: body.model,
      thinking: body.thinking || '',
      serviceTier: body.serviceTier || '',
      explicit: !!(body.provider && body.model),
    };
    this.renderDefaultModelField();
    try {
      await fetchJson('/api/default-model', { method: 'PUT', body });
      // Displays that fall back to the default (the sidebar's Usage card, when
      // no conversation is on screen) read a cached copy of the server's answer.
      defaultModelCache.invalidate();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save default model:', err);
      this.defaultModel = previous;
      this.renderDefaultModelField();
      await showAlert(`Couldn't save the default model.\n\n${extractErrorMessage(err)}`, 'Error');
    }
  }
}

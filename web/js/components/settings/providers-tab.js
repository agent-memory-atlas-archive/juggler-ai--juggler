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

import { openExternalURL } from '../../../sdk/lib/window-control.js';
import wsService from '../../services/websocket.js';
import providersCache from '../../services/providers-cache.js';
import { fetchJson, httpErrorText } from '../../services/http.js';
import { customProvidersList } from '../../services/ops-api.js';
import { showAlert, showConfirm } from '../modal-dialog.js';
import { sortModelsByVersion } from '../../utils/model-filter.js';
import { buildEndpointCard, buildAddEndpointForm } from './custom-endpoint-card.js';

// Standard refresh glyph for the OAuth "re-check sign-in" button. Fill is left to
// CSS (currentColor) so it tracks the button's theme colour.
const OAUTH_REFRESH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true">' +
  '<path d="M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z"/></svg>';

/**
 * "Providers" tab: one field per registered provider — OAuth (bearer), keyless
 * (toggle), or API-key (input + save/delete) — plus the Ollama host and the
 * Claude Code binary path, and, last, the user's own endpoints. Seeded from the
 * shared loadConfig() fetch; keys persist via PUT /api/config. `updateAllButtons`
 * is providers-only (despite the generic name) and is also invoked by the shell's
 * close() after its panel-wide secret-input sweep.
 *
 * A custom endpoint is a provider like any other, so it belongs here rather than
 * in a tab of its own: it is the same card, with the same key row, model list and
 * token limits, plus the base URL and headers that only it has. Its own cards are
 * built from the endpoint definitions (see the section below), so the ones that
 * did not register — switched off, or a base URL that no longer parses — still
 * have somewhere to be fixed.
 */
export class ProvidersTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope and
   *   the owner of loadConfig(), which this tab calls to re-sync after a save).
   */
  constructor(host) {
    /** @type {any} @private */
    this.host = host;
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    // The user's own endpoints, read as definitions rather than as published
    // providers: the ones that did not register are exactly the ones needing a
    // card.
    /** @type {any[]} @private */
    this.endpoints = [];
    // Whether the "new endpoint" form is open.
    /** @type {boolean} @private */
    this.addingEndpoint = false;
    // The drawn cards, so one endpoint can be updated or taken out on its own.
    /** @type {Map<string, {element: HTMLElement, refresh: (opts?: {remodel?: boolean}) => void, endpoint: any}>} @private */
    this.endpointCards = new Map();
    /** @type {HTMLElement|null} @private */
    this.endpointSection = null;
  }

  /** Tab became visible: pick up endpoints added or removed since it was last drawn. */
  show() {
    this._refreshEndpoints();
  }

  /** Panel closed: an abandoned add form must not be there on reopen. */
  close() {
    if (this.addingEndpoint) this._closeAddForm();
  }

  /**
   * Receive the shared loadConfig() payload: store config/providers, (on a full
   * render) build the provider fields, and always refresh the buttons.
   * @param {{config: object, providers: any[]}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    // Generate provider form fields dynamically (only on initial load)
    if (renderFields) {
      this.renderProviderFields();
    }
    // Update all buttons and placeholders
    this.updateAllButtons();
  }

  /**
   * Render provider form fields dynamically based on available providers
   * @private
   */
  renderProviderFields() {
    const container = this.host.querySelector('#provider-fields-container');
    if (!container) return;

    // Clear existing fields
    container.innerHTML = '';

    // A custom endpoint is in this list too, since it registers as a provider.
    // Its card is built from its definition instead, in the section below, so it
    // is skipped here rather than drawn twice with half the controls each time.
    const ownEndpoints = new Set(this.endpoints.map(e => e.providerId));

    // Generate a field for each provider
    for (const provider of this.providers) {
      if (ownEndpoints.has(provider.name)) continue;

      if (provider.authType === 'oauth_bearer') {
        this._buildOAuthProviderField(provider, container);
        continue;
      }

      // Keyless provider (like Claude Code, Ollama) - show toggle instead of API key input
      if (provider.configKeyName === '') {
        this._buildKeylessProviderField(provider, container);
        continue;
      }

      // API key provider - show input field
      this._buildApiKeyProviderField(provider, container);
    }

    this.endpointSection = document.createElement('div');
    this.endpointSection.id = 'custom-endpoints-section';
    container.appendChild(this.endpointSection);
    this._renderEndpointSection();
    this._refreshEndpoints();
  }

  /**
   * Draw the "Your own endpoints" section from the definitions in hand.
   *
   * This is the only method that empties the section, and it runs when the tab
   * is built — never in response to a save. Everything after that edits the
   * section in place: a card is added, removed or refreshed on its own, so
   * nothing a save touches moves anything else on the page.
   * @private
   */
  _renderEndpointSection() {
    const root = this.endpointSection;
    if (!root) return;
    root.innerHTML = '';
    this.endpointCards.clear();

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'Your own endpoints';
    root.appendChild(heading);

    const note = document.createElement('div');
    note.className = 'custom-endpoints-note';
    note.textContent = 'Anything that speaks the OpenAI Chat Completions API — a gateway, a tenant, a local server. Each one is a provider of its own in the model picker.';
    root.appendChild(note);

    for (const endpoint of this.endpoints) root.appendChild(this._buildCard(endpoint));
    root.appendChild(this._buildAddControl());
  }

  /**
   * Build one endpoint's card and remember how to update it.
   * @param {any} endpoint - The endpoint to draw.
   * @returns {HTMLElement} The card element.
   * @private
   */
  _buildCard(endpoint) {
    const card = buildEndpointCard(endpoint, {
      // Only a registered endpoint has a published provider to draw models from.
      // Asking the endpoint rather than the provider list means a card is right
      // the moment it is switched off, without waiting for the server's next
      // provider recompute to drop it from that list.
      providerFor: (providerId) => this.providers.find(p => p.name === providerId),
      modelRow: (provider) => this._buildModelVisibilityRow(provider),
      applyEndpoints: (endpoints) => { this.endpoints = Array.isArray(endpoints) ? endpoints : []; },
      refreshProviders: () => this.host.loadConfig(false),
      onRemoved: (endpoints) => this._onEndpointRemoved(endpoints),
      reportError: (message) => { showAlert(message, 'Custom endpoints'); },
    });
    this.endpointCards.set(endpoint.id, { ...card, endpoint });
    return card.element;
  }

  /**
   * Build whatever sits at the end of the section: the form for a new endpoint,
   * or the button that opens it.
   * @returns {HTMLElement} The control.
   * @private
   */
  _buildAddControl() {
    if (this.addingEndpoint) {
      return buildAddEndpointForm({
        takenIds: this.endpoints.map(e => e.id),
        onAdded: (endpoints) => this._onEndpointAdded(endpoints),
        onCancel: () => this._closeAddForm(),
      });
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'settings-btn small custom-endpoint-add-open';
    add.textContent = 'Add endpoint';
    add.addEventListener('click', () => {
      this.addingEndpoint = true;
      const form = this._buildAddControl();
      add.replaceWith(form);
      /** @type {HTMLInputElement|null} */ (form.querySelector('.custom-endpoint-add-name'))?.focus();
    });
    return add;
  }

  /**
   * Put the Add button back where the form was.
   * @private
   */
  _closeAddForm() {
    this.addingEndpoint = false;
    const form = this.endpointSection?.querySelector('.custom-endpoint-add');
    if (form) form.replaceWith(this._buildAddControl());
  }

  /**
   * A new endpoint exists: its card takes the place of the form that made it.
   * The provider list above is left alone — a provider registered a moment ago
   * has no card up there to remove, and the next full render will skip it.
   * @param {any[]} endpoints - The list as the server now holds it.
   * @private
   */
  _onEndpointAdded(endpoints) {
    const known = new Set(this.endpoints.map(e => e.id));
    this.endpoints = Array.isArray(endpoints) ? endpoints : [];
    this.addingEndpoint = false;
    const root = this.endpointSection;
    if (!root) return;
    const cards = this.endpoints.filter(e => !known.has(e.id)).map(e => this._buildCard(e));
    const form = root.querySelector('.custom-endpoint-add');
    if (form) form.replaceWith(...cards, this._buildAddControl());
    else for (const card of cards) root.appendChild(card);
  }

  /**
   * An endpoint is gone: its card goes with it, and nothing else moves.
   * @param {any[]} endpoints - The list as the server now holds it.
   * @private
   */
  _onEndpointRemoved(endpoints) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : [];
    const left = new Set(this.endpoints.map(e => e.id));
    for (const [id, card] of this.endpointCards) {
      if (left.has(id)) continue;
      card.element.remove();
      this.endpointCards.delete(id);
    }
  }

  /**
   * Fetch the endpoint definitions and bring the section into line with them.
   *
   * Called when the tab is drawn and whenever it is shown again, so it is how a
   * change made in another window arrives. Cards that already exist are updated
   * where they stand rather than replaced.
   * @private
   */
  async _refreshEndpoints() {
    try {
      const { endpoints } = await customProvidersList();
      const next = Array.isArray(endpoints) ? endpoints : [];
      if (JSON.stringify(next) === JSON.stringify(this.endpoints)) return;
      this.endpoints = next;
      this._syncEndpointCards();
    } catch (error) {
      // The built-in providers are unaffected, and the section says nothing
      // rather than claiming the user has no endpoints.
      console.error('[SettingsPanel] Could not list custom endpoints:', error);
    }
  }

  /**
   * Match the drawn cards to the endpoints in hand, and take out any built-in
   * card that has turned out to be one of them — which is what the first pass
   * after a fresh render finds, since the provider list is drawn before the
   * definitions that say which of those providers are the user's own.
   * @private
   */
  _syncEndpointCards() {
    const root = this.endpointSection;
    if (!root) return;
    const container = this.host.querySelector('#provider-fields-container');

    for (const endpoint of this.endpoints) {
      const drawn = this.endpointCards.get(endpoint.id);
      if (drawn) {
        Object.assign(drawn.endpoint, endpoint);
        drawn.refresh();
      } else {
        root.insertBefore(this._buildCard(endpoint), root.lastElementChild);
      }
      const duplicate = container?.querySelector(`.provider-field[data-provider="${endpoint.providerId}"]`);
      if (duplicate) duplicate.remove();
    }

    const live = new Set(this.endpoints.map(e => e.id));
    for (const [id, card] of this.endpointCards) {
      if (live.has(id)) continue;
      card.element.remove();
      this.endpointCards.delete(id);
    }
  }

  /**
   * Build the field for an OAuth (bearer) provider: name, optional
   * description and a sign-in status line, with no API-key input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildOAuthProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';
    // Names the provider this card is for, so one that turns out to be a custom
    // endpoint can be taken out without rebuilding the whole list.
    fieldGroup.dataset.provider = provider.name;

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.id = `${provider.name}-oauth-status`;
    status.style.display = 'block';
    status.textContent = provider.available
      ? (provider.authHint || 'Signed in')
      : (provider.authHint || 'Sign in to continue');
    controlColumn.appendChild(status);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'provider-buttons';

    // Providers with an in-app sign-in (currently GitHub Copilot's device flow)
    // get Sign in / Sign out controls; others rely on the refresh button alone.
    if (provider.signInMethod === 'github_device') {
      if (provider.available) {
        const signOutBtn = document.createElement('button');
        signOutBtn.type = 'button';
        signOutBtn.className = 'settings-btn danger small';
        signOutBtn.textContent = 'Sign out';
        signOutBtn.title = 'Sign out of the GitHub login stored by Juggler';
        signOutBtn.addEventListener('click', () => this._copilotSignOut(provider, signOutBtn));
        buttonGroup.appendChild(signOutBtn);
      } else {
        const signInBtn = document.createElement('button');
        signInBtn.type = 'button';
        signInBtn.className = 'settings-btn primary small';
        signInBtn.textContent = 'Sign in with GitHub';
        signInBtn.addEventListener('click', () => this._copilotSignIn(provider, signInBtn));
        buttonGroup.appendChild(signInBtn);
      }
      // A host field lets Enterprise Cloud users point Copilot at their
      // <tenant>.ghe.com instead of the public github.com (for both editor-login
      // reuse and the in-app device sign-in).
      controlColumn.appendChild(this._buildCopilotHostField(provider));
    }

    // Every OAuth provider gets a refresh button: the login it depends on lives in
    // an external app/CLI (or another editor), so re-checking picks up a fresh or
    // expired sign-in without relaunching Juggler.
    buttonGroup.appendChild(this._buildOAuthRefreshButton(provider));
    controlColumn.appendChild(buttonGroup);

    // Which of this provider's models to offer in the model menu.
    const visibility = this._buildModelVisibilityRow(provider);
    if (visibility) controlColumn.appendChild(visibility);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the refresh (re-check sign-in) button shared by every OAuth provider.
   * @param {any} provider - Provider info object
   * @returns {HTMLButtonElement} The refresh button to append to the button group.
   * @private
   */
  _buildOAuthRefreshButton(provider) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn icon';
    btn.title = 'Re-check sign-in';
    btn.setAttribute('aria-label', `Re-check ${provider.displayName} sign-in`);
    btn.innerHTML = OAUTH_REFRESH_ICON;
    btn.addEventListener('click', () => this._refreshOAuthProvider(provider, btn));
    return btn;
  }

  /**
   * Re-check an OAuth provider's external login without relaunching. Asks the
   * server to recompute providers (which re-reads the CLI token file / re-probes
   * the editor login) and waits for the settled `providers-update`, then
   * re-renders this tab so the status line and Sign in/out controls reflect the
   * fresh availability. The same push reaches every model selector (they all
   * subscribe to `providers-update`), so newly-available models appear there
   * without this tab reaching across to poke them.
   * @param {any} provider
   * @param {HTMLButtonElement} button
   * @private
   */
  async _refreshOAuthProvider(provider, button) {
    const status = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-oauth-status`));
    const originalStatus = status ? status.textContent : '';
    button.disabled = true;
    button.classList.add('spinning');
    if (status) status.textContent = 'Checking sign-in\u2026';
    try {
      const fresh = await this._recheckOAuthProvider(provider.name);
      if (fresh) {
        const idx = this.providers.findIndex((p) => p.name === provider.name);
        if (idx !== -1) this.providers[idx] = fresh;
      }
      // Re-render rebuilds this button (dropping the spinning state) and the
      // status line, so no manual cleanup is needed on the success path.
      this.renderProviderFields();
      this.updateAllButtons();
    } catch (err) {
      button.disabled = false;
      button.classList.remove('spinning');
      if (status) status.textContent = originalStatus;
      await showAlert(err instanceof Error ? err.message : 'Refresh failed', provider.displayName);
    }
  }

  /**
   * Trigger a server provider refresh and resolve with the named provider's fresh
   * entry from the settled `providers-update`. Resolves with the current cached
   * list if no push arrives within the timeout, so the caller never hangs.
   * @param {string} providerName
   * @returns {Promise<any|undefined>} The provider's fresh entry, or undefined if absent.
   * @private
   */
  async _recheckOAuthProvider(providerName) {
    const next = new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null;
      /** @param {unknown} data */
      const handler = (data) => {
        if (timer) clearTimeout(timer);
        wsService.off('providers-update', handler);
        resolve(Array.isArray(data) ? data : this.providers);
      };
      wsService.on('providers-update', handler);
      timer = setTimeout(() => {
        wsService.off('providers-update', handler);
        resolve(this.providers);
      }, 4000);
    });
    await providersCache.refresh();
    const list = /** @type {any[]} */ (await next);
    return list.find((p) => p.name === providerName);
  }

  /**
   * Build the "GitHub host" field for a device-flow provider. Enterprise Cloud
   * users enter their `<tenant>.ghe.com`; everyone else leaves the default
   * `github.com`. Prefilled from the saved host and, on change, persisted (which
   * re-checks the provider so an editor login on that host is picked up).
   * @param {any} provider
   * @returns {HTMLElement} The host field wrapper.
   * @private
   */
  _buildCopilotHostField(provider) {
    const wrap = document.createElement('div');
    wrap.className = 'copilot-host-field';

    const inputId = `${provider.name}-host`;
    const label = document.createElement('label');
    label.className = 'copilot-host-label';
    label.setAttribute('for', inputId);
    label.textContent = 'GitHub host';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.className = 'settings-input small';
    input.value = 'github.com';
    input.placeholder = 'github.com or your-tenant.ghe.com';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;

    // Prefill with the saved host; the default above shows until this resolves.
    // Best-effort prefill — a failure just keeps the default host.
    fetchJson('/api/providers/copilot/host', { fallback: null })
      .then((d) => { if (d && d.success && d.host) input.value = d.host; });

    input.addEventListener('change', () => this._copilotSetHost(provider, input));

    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  /**
   * Persist the chosen GitHub host, then re-check the provider so an editor
   * Copilot login on that host is reused without relaunching.
   * @param {any} provider
   * @param {HTMLInputElement} input
   * @private
   */
  async _copilotSetHost(provider, input) {
    const host = input.value.trim() || 'github.com';
    try {
      const data = await fetchJson('/api/providers/copilot/host', { method: 'POST', body: { host } });
      if (!data?.success) throw new Error(data?.error || 'Failed to set host');
      // Re-check against the new host (rebuilds this field with the saved value).
      await this._refreshOAuthProvider(provider, this._buildOAuthRefreshButton(provider));
    } catch (err) {
      await showAlert(httpErrorText(err, 'Failed to set host'), 'GitHub Copilot');
    }
  }

  /**
   * Run the GitHub OAuth device flow: start it, open the verification page with
   * the user code (copied to the clipboard), then poll until GitHub authorizes.
   * On success re-syncs the settings panel and the model selector.
   * @param {any} provider
   * @param {HTMLButtonElement} button
   * @private
   */
  async _copilotSignIn(provider, button) {
    const status = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-oauth-status`));
    const setStatus = (/** @type {string} */ t) => { if (status) status.textContent = t; };
    const hostInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-host`));
    const host = (hostInput && hostInput.value.trim()) || 'github.com';
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Starting\u2026';
    try {
      const data = await fetchJson('/api/providers/copilot/device/start', { method: 'POST', body: { host } });
      if (!data?.success) throw new Error(data?.error || 'Failed to start sign-in');

      const { userCode, verificationUri, deviceCode, interval } = data;
      try { await navigator.clipboard.writeText(userCode); } catch { /* clipboard is best-effort */ }
      if (verificationUri) openExternalURL(verificationUri);
      button.textContent = 'Waiting\u2026';
      setStatus(`Enter code ${userCode} at ${verificationUri} (opened in your browser, copied to clipboard). Waiting for authorization\u2026`);

      await this._pollCopilotLogin(deviceCode, Number(interval) || 5, host);
      setStatus('Signed in with GitHub');
      await this._refreshAfterAuthChange(provider, true);
    } catch (err) {
      setStatus(provider.authHint || 'Sign in to continue');
      button.disabled = false;
      button.textContent = originalText;
      await showAlert(httpErrorText(err, 'Sign-in failed'), 'GitHub Copilot');
    }
  }

  /**
   * Poll the device-login endpoint until it resolves. Resolves on authorization;
   * throws on expiry, denial, error, or timeout.
   * @param {string} deviceCode
   * @param {number} interval - seconds between polls (GitHub-provided)
   * @param {string} host - GitHub host the flow was started against
   * @private
   */
  async _pollCopilotLogin(deviceCode, interval, host) {
    let delayMs = Math.max(2, interval) * 1000;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delayMs));
      const data = await fetchJson('/api/providers/copilot/device/poll', {
        method: 'POST',
        body: { deviceCode, host },
      });
      if (!data?.success) throw new Error(data?.error || 'Sign-in check failed');
      switch (data.status) {
        case 'authorized': return;
        case 'pending': break;
        case 'slow_down': delayMs += 5000; break;
        case 'expired': throw new Error('The code expired before you authorized. Please try again.');
        case 'denied': throw new Error('Access was denied on GitHub.');
        default: throw new Error('Unexpected sign-in status from GitHub.');
      }
    }
    throw new Error('Timed out waiting for authorization.');
  }

  /**
   * Sign out of the GitHub login Juggler stored (leaves any editor login alone).
   * @param {any} provider
   * @param {HTMLButtonElement} button
   * @private
   */
  async _copilotSignOut(provider, button) {
    const ok = await showConfirm(
      'Sign out of the GitHub login stored by Juggler? Copilot becomes unavailable until you sign in again (any editor Copilot login on this machine will still be used).',
      'Sign out'
    );
    if (!ok) return;
    button.disabled = true;
    try {
      const data = await fetchJson('/api/providers/copilot/signout', { method: 'POST' });
      if (!data?.success) throw new Error(data?.error || 'Sign out failed');
      await this._refreshAfterAuthChange(provider, false);
    } catch (err) {
      button.disabled = false;
      await showAlert(httpErrorText(err, 'Sign out failed'), 'GitHub Copilot');
    }
  }

  /**
   * Re-sync after a sign in/out. Optimistically flips this provider's cached
   * availability and re-renders the fields so the Sign in/out control updates
   * immediately (the backend's queued RefreshProviders broadcasts the settled
   * state shortly after via `providers-update`). Re-rendering is non-destructive:
   * API-key inputs always render empty and are reconciled by updateAllButtons.
   * That same broadcast is what puts the new provider's models in every model
   * selector, so this tab has nothing to tell them.
   * @param {any} provider
   * @param {boolean} available
   * @private
   */
  async _refreshAfterAuthChange(provider, available) {
    provider.available = available;
    provider.authHint = available ? 'Signed in with GitHub' : '';
    this.renderProviderFields();
    this.updateAllButtons();
  }

  /**
   * Build the field for a keyless provider (like Claude Code, Ollama): name,
   * optional description and an enable/disable toggle in place of an API-key
   * input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildKeylessProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';
    // Names the provider this card is for, so one that turns out to be a custom
    // endpoint can be taken out without rebuilding the whole list.
    fieldGroup.dataset.provider = provider.name;

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const toggleWrapper = document.createElement('div');
    toggleWrapper.className = 'provider-toggle-wrapper';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `${provider.name}-toggle`;
    toggle.className = 'provider-toggle';
    // The toggle shows what the user chose, not whether the provider can serve a
    // turn this second. Those come apart when a readiness check refuses — a CLI
    // whose sign-in has lapsed is still switched on — and drawing the switch from
    // availability would tell the user they had turned something off themselves.
    toggle.checked = provider.credentialed ?? provider.available;

    const toggleLabel = document.createElement('label');
    toggleLabel.setAttribute('for', toggle.id);
    toggleLabel.className = 'toggle-switch';

    toggle.addEventListener('change', async () => {
      await this.toggleProviderEnabled(provider, toggle.checked);
    });

    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(toggleLabel);
    controlColumn.appendChild(toggleWrapper);

    // A keyless provider that is switched on but can't serve — a CLI that is
    // installed and enabled, yet not signed in — has nowhere else to say so. Its
    // models are gone from the menu and the toggle still reads on, so without
    // this the first news of it is a failed turn. Same status line and re-check
    // the OAuth providers get, shown only when there is something to report.
    if (toggle.checked && provider.authHint) {
      const status = document.createElement('div');
      status.className = 'key-source-hint';
      status.id = `${provider.name}-oauth-status`;
      status.style.display = 'block';
      status.textContent = provider.authHint;
      controlColumn.appendChild(status);

      const buttonGroup = document.createElement('div');
      buttonGroup.className = 'provider-buttons';
      buttonGroup.appendChild(this._buildOAuthRefreshButton(provider));
      controlColumn.appendChild(buttonGroup);
    }

    // Ollama: expose the daemon host so users can point at a
    // non-default (LAN / remote) Ollama instance without
    // restarting the app. Saved as the `ollama_host` raw
    // credential; backend re-fetches the model list on change.
    if (provider.name === 'ollama') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'ollama-host-input',
        placeholder: 'http://localhost:11434',
        configField: 'ollamaHost',
        configKey: 'ollama_host',
        defaultLabel: 'http://localhost:11434',
      }));
    }

    // llama.cpp: expose the server host so users can point at a non-default
    // (LAN / remote / custom port) instance without restarting the app. The
    // same field reaches an LM Studio server, which serves this API on 1234.
    // Saved as the `llamacpp_host` raw credential; backend re-fetches the model
    // list, and each model's context window, on change.
    if (provider.name === 'llamacpp') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'llamacpp-host-input',
        placeholder: 'http://127.0.0.1:8080',
        configField: 'llamacppHost',
        configKey: 'llamacpp_host',
        defaultLabel: 'http://127.0.0.1:8080',
      }));
    }

    // LocalAI: expose the server host so users can point at a non-default
    // (LAN / remote / custom port) instance without restarting the app. Saved
    // as the `localai_host` raw credential; backend re-fetches the model list,
    // and each model's context window, on change.
    if (provider.name === 'localai') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'localai-host-input',
        placeholder: 'http://127.0.0.1:8080',
        configField: 'localaiHost',
        configKey: 'localai_host',
        defaultLabel: 'http://127.0.0.1:8080',
      }));
    }

    // Claude Code: let users point at the `claude` CLI explicitly for obscure
    // install locations auto-detection can't reach. Saved as the
    // `claudecode_binary_path` raw credential; a non-empty save also enables
    // the provider so it becomes selectable without restarting.
    if (provider.name === 'claudecode') {
      controlColumn.appendChild(this._buildClaudeBinaryRow(provider, toggle));
    }

    // Which of this provider's models to offer in the model menu.
    const visibility = this._buildModelVisibilityRow(provider);
    if (visibility) controlColumn.appendChild(visibility);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for an API-key provider: name, optional "Get API Key"
   * link, the key input with save/delete buttons, active badge and source
   * hint.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildApiKeyProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';
    // Names the provider this card is for, so one that turns out to be a custom
    // endpoint can be taken out without rebuilding the whole list.
    fieldGroup.dataset.provider = provider.name;

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const fieldId = `${provider.name}-key`;
    const saveButtonId = `${provider.name}-save`;
    const deleteButtonId = `${provider.name}-delete`;

    const nameLabel = document.createElement('label');
    nameLabel.className = 'provider-name';
    nameLabel.setAttribute('for', fieldId);
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    // "Get API Key" link
    if (provider.apiKeyURL) {
      const keyLink = document.createElement('a');
      keyLink.href = provider.apiKeyURL;
      keyLink.target = '_blank';
      keyLink.rel = 'noopener noreferrer';
      keyLink.className = 'get-api-key-link';
      keyLink.textContent = 'Get API Key \u2192';
      infoColumn.appendChild(keyLink);
    }

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = fieldId;
    input.name = provider.configKeyName;
    input.placeholder = '...';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;

    const activeBadge = document.createElement('span');
    activeBadge.id = `${provider.name}-active-badge`;
    activeBadge.className = 'provider-active-badge';
    activeBadge.style.display = 'none';
    activeBadge.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg><span>key is active</span>';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'provider-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.id = saveButtonId;
    saveButton.className = 'settings-btn primary small';
    saveButton.textContent = 'Save';
    saveButton.style.display = 'none';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.id = deleteButtonId;
    deleteButton.className = 'settings-btn danger small';
    deleteButton.textContent = 'Delete';
    deleteButton.style.display = 'none';

    // Add input event listener to update buttons
    input.addEventListener('input', () => {
      this.updateAllButtons();
    });

    // Save button handler
    saveButton.addEventListener('click', async () => {
      await this.saveProviderKey(provider, input.value.trim());
    });

    // Delete button handler
    deleteButton.addEventListener('click', async () => {
      await this.deleteProviderKey(provider);
    });

    buttonGroup.appendChild(saveButton);
    buttonGroup.appendChild(deleteButton);

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(activeBadge);
    inputWrapper.appendChild(buttonGroup);

    const sourceHint = document.createElement('div');
    sourceHint.id = `${provider.name}-source`;
    sourceHint.className = 'key-source-hint';
    sourceHint.style.display = 'none';

    controlColumn.appendChild(inputWrapper);
    controlColumn.appendChild(sourceHint);

    // Which of this provider's models to offer in the model menu.
    const visibility = this._buildModelVisibilityRow(provider);
    if (visibility) controlColumn.appendChild(visibility);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the collapsible per-model list for a provider: one row per model,
   * carrying a visibility checkbox and the two token limits, plus a filter box.
   *
   * The visibility preference is a deny-list (`models.hidden` in the global
   * settings), so a model the provider adds later shows up on its own and only
   * what the user explicitly turned off stays off. Unchecking writes the id into
   * that list; the server then flags the model `hidden` everywhere it publishes
   * the catalogue, which is what actually keeps it out of the model menu and out
   * of default/cheap-model resolution.
   *
   * The limits (`models.limits`) are the escape hatch for a model whose real
   * context window or output cap differs from what this build believes. That is
   * not cosmetic: the window decides admission and when a conversation compacts,
   * so a model catalogued at 128k that really serves 1M compacts eight times
   * sooner than it needs to. Correcting it here is what saves the user waiting
   * on a release to carry a new number.
   *
   * The filter isn't decoration: OpenRouter publishes several hundred models, and
   * an unfiltered list of that is unusable.
   * @param {any} provider - Provider info object, including `modelsWithContext`
   * @returns {HTMLElement|null} The row to append, or null when the provider
   *   lists no models (nothing to choose between).
   * @private
   */
  _buildModelVisibilityRow(provider) {
    /** @type {Array<{id: string, displayName?: string, hidden?: boolean, fromAPI?: boolean, contextWindow?: number, maxOutputTokens?: number, providerContextWindow?: number, providerMaxOutputTokens?: number}>} */
    const models = Array.isArray(provider.modelsWithContext) ? provider.modelsWithContext : [];
    if (models.length === 0) return null;

    // Seeded from the published flags, then kept in step locally: a save
    // triggers a providers refresh, but the fields aren't rebuilt on that, so
    // this Set is the live truth for the summary and the checkboxes.
    const hidden = new Set(models.filter(m => m.hidden).map(m => m.id));

    const details = document.createElement('details');
    details.className = 'model-visibility';

    const summary = document.createElement('summary');
    summary.className = 'model-visibility-summary';
    details.appendChild(summary);

    const summaryLabel = document.createElement('span');
    summaryLabel.className = 'model-visibility-label';
    summaryLabel.textContent = 'Models';
    summary.appendChild(summaryLabel);

    // The count carries the state, so it's the part that stays legible when the
    // label dims — hence its own element rather than one string.
    const summaryCount = document.createElement('span');
    summaryCount.className = 'model-visibility-count';
    summary.appendChild(summaryCount);

    const updateSummary = () => {
      summaryCount.textContent = hidden.size === 0
        ? `${models.length}`
        : `${models.length - hidden.size} of ${models.length} shown`;
    };
    updateSummary();

    const status = document.createElement('div');
    status.className = 'model-visibility-status';
    status.style.display = 'none';

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'settings-value-input model-visibility-filter';
    filter.placeholder = 'Filter models';
    filter.autocomplete = 'off';
    filter.setAttribute('autocorrect', 'off');
    filter.setAttribute('autocapitalize', 'off');
    filter.setAttribute('aria-label', `Filter ${provider.displayName} models`);
    filter.spellcheck = false;

    const list = document.createElement('div');
    list.className = 'model-visibility-list';

    const empty = document.createElement('div');
    empty.className = 'model-visibility-empty';
    empty.textContent = 'Nothing.';
    empty.style.display = 'none';

    // The overrides this provider currently has, seeded from the catalogue: the
    // server publishes the provider's own number beside the effective one for
    // exactly the models it replaced, so a present `providerContextWindow` is
    // what marks a field as overridden — the effective value is then the
    // override. Kept as one object because a save has to send the provider's
    // COMPLETE set (see saveLimits).
    /** @type {Record<string, {contextWindow?: number, maxOutputTokens?: number}>} */
    const limits = {};
    for (const model of models) {
      /** @type {{contextWindow?: number, maxOutputTokens?: number}} */
      const entry = {};
      if (model.providerContextWindow !== undefined && model.providerContextWindow !== null) {
        entry.contextWindow = model.contextWindow;
      }
      if (model.providerMaxOutputTokens !== undefined && model.providerMaxOutputTokens !== null) {
        entry.maxOutputTokens = model.maxOutputTokens;
      }
      if (Object.keys(entry).length > 0) limits[model.id] = entry;
    }

    /**
     * Persist every override this provider has. The server replaces a named
     * provider's whole set rather than merging into it, so a partial send would
     * silently delete the models it left out.
     * @returns {Promise<any>} The settings PUT.
     */
    const saveLimits = () => fetchJson('/api/settings', {
      method: 'PUT',
      body: { models: { limits: { [provider.name]: limits } } },
    });

    /**
     * One token-limit field: blank means "use whatever the provider reports",
     * which is also what the placeholder shows — on an overridden model that is
     * the number clearing the field restores, not the override in force.
     * @param {any} model - The catalogue entry this row is for.
     * @param {'contextWindow'|'maxOutputTokens'} field - Which limit to edit.
     * @param {string} label - Human name of the limit, for the aria-label.
     * @returns {HTMLInputElement} The input to append to the row.
     */
    const buildLimitInput = (model, field, label) => {
      const overridden = field === 'contextWindow'
        ? model.providerContextWindow !== undefined && model.providerContextWindow !== null
        : model.providerMaxOutputTokens !== undefined && model.providerMaxOutputTokens !== null;
      const reported = field === 'contextWindow'
        ? (model.providerContextWindow ?? model.contextWindow)
        : (model.providerMaxOutputTokens ?? model.maxOutputTokens);
      const stored = () => limits[model.id]?.[field];

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.className = 'model-limit-input';
      input.dataset.limit = field;
      input.placeholder = reported > 0 ? String(reported) : 'auto';
      input.value = stored() ? String(stored()) : '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', `${label} for ${model.id}`);
      // Three numbers that look identical in a box: one the provider stated,
      // one Juggler assumed because the provider states none, and one typed
      // here. Which it is decides how much to trust it, and nothing else on the
      // row says.
      if (overridden) {
        input.title = `Your figure. Clearing the field goes back to ${reported}.`;
      } else if (model.fromAPI) {
        input.title = `${reported} — reported by the provider for this model.`;
      } else {
        input.title = `${reported} — Juggler's built-in figure. This provider doesn't publish its limits; correct it here if you know better.`;
      }

      input.addEventListener('change', async () => {
        const previous = limits[model.id] ? { ...limits[model.id] } : undefined;
        const restore = () => {
          if (previous) limits[model.id] = previous;
          else delete limits[model.id];
          input.value = previous?.[field] ? String(previous[field]) : '';
        };
        const raw = input.value.trim();
        const parsed = raw === '' ? 0 : Number.parseInt(raw, 10);
        // A blank or a zero is how "no override" is spelled; anything that isn't
        // a usable number is a typo, and putting the field back says so more
        // clearly than an error line would.
        if (!Number.isFinite(parsed) || parsed < 0) {
          restore();
          return;
        }
        const entry = { ...(limits[model.id] || {}) };
        if (parsed > 0) entry[field] = parsed;
        else delete entry[field];
        if (Object.keys(entry).length > 0) limits[model.id] = entry;
        else delete limits[model.id];
        try {
          await saveLimits();
          status.style.display = 'none';
        } catch (err) {
          // Nothing was stored, so leaving the number on screen would misreport
          // the window every later turn is admitted against.
          restore();
          status.textContent = `Couldn't save the token limits. ${httpErrorText(err)}`;
          status.style.display = '';
        }
      });
      return input;
    };

    /** @type {Array<{row: HTMLElement, haystack: string}>} */
    const rows = [];
    // Same lineage grouping the model menu uses, so the two lists read alike.
    for (const model of sortModelsByVersion(models)) {
      const row = document.createElement('div');
      row.className = 'model-visibility-row';
      row.dataset.model = model.id;

      // The checkbox and the name are the label; the number fields are not. A
      // label forwards a click anywhere inside it to its control, so wrapping
      // the whole row would hide the model every time one was clicked into.
      const toggle = document.createElement('label');
      toggle.className = 'model-visibility-toggle';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'model-visibility-check';
      box.checked = !hidden.has(model.id);

      const name = document.createElement('span');
      name.className = 'model-visibility-name';
      name.textContent = model.id;

      // Dims the name of a model that won't be offered, so the shown/hidden
      // split is readable down the list without checking every box.
      const applyRowState = () => row.classList.toggle('is-hidden', !box.checked);
      applyRowState();

      box.addEventListener('change', async () => {
        const show = box.checked;
        if (show) hidden.delete(model.id);
        else hidden.add(model.id);
        updateSummary();
        applyRowState();
        try {
          // Always send this provider's COMPLETE list. The server merges the
          // hidden map key by key, so an omitted provider keeps whatever it had
          // and re-showing the last hidden model has to be an explicit [].
          await fetchJson('/api/settings', {
            method: 'PUT',
            body: { models: { hidden: { [provider.name]: [...hidden] } } },
          });
          status.style.display = 'none';
        } catch (err) {
          // Put the checkbox back where it was: the stored list is unchanged, so
          // leaving it flipped would misreport what the model menu will do.
          if (show) hidden.add(model.id);
          else hidden.delete(model.id);
          box.checked = !show;
          updateSummary();
          applyRowState();
          status.textContent = `Couldn't save which models to show. ${httpErrorText(err)}`;
          status.style.display = '';
        }
      });

      toggle.appendChild(box);
      toggle.appendChild(name);
      row.appendChild(toggle);

      const limitFields = document.createElement('span');
      limitFields.className = 'model-limit-fields';
      limitFields.appendChild(buildLimitInput(model, 'contextWindow', 'Context window'));
      limitFields.appendChild(buildLimitInput(model, 'maxOutputTokens', 'Max output tokens'));
      row.appendChild(limitFields);

      list.appendChild(row);
      rows.push({ row, haystack: `${model.id} ${model.displayName || ''}`.toLowerCase() });
    }

    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLowerCase();
      let matches = 0;
      for (const { row, haystack } of rows) {
        const hit = query === '' || haystack.includes(query);
        row.style.display = hit ? '' : 'none';
        if (hit) matches++;
      }
      empty.style.display = matches === 0 ? '' : 'none';
    });

    // The empty state lives inside the scroller so a filter that matches nothing
    // leaves a box saying so, rather than an empty box with a note under it.
    list.appendChild(empty);

    const legend = document.createElement('div');
    legend.className = 'model-limit-legend';
    legend.textContent = 'Context and output token limits. Blank uses the provider’s own.';

    details.appendChild(filter);
    details.appendChild(legend);
    details.appendChild(list);
    details.appendChild(status);
    return details;
  }

  /**
   * Build a host-URL input row for a keyless local-server provider (Ollama,
   * llama.cpp, LocalAI). Loads the current value from `this.config[configField]`; saves
   * via /api/config on blur or Enter. Empty value clears the override (falls
   * back to the env var or the server-side default).
   * @param {{inputId: string, placeholder: string, configField: string, configKey: string, defaultLabel: string}} opts
   *   inputId/placeholder for the input; configField is the /api/config field
   *   this value round-trips through; configKey is the raw credential key the
   *   PUT body posts; defaultLabel is shown when the override is cleared.
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildHostRow({ inputId, placeholder, configField, configKey, defaultLabel }) {
    // Wrapper is a no-op fragment-like div so the caller can append a
    // single child; visual layout comes from the parent `.provider-control`
    // column (`flex-direction: column; gap: 0.375rem`).
    const row = document.createElement('div');

    // Reuse the same wrapper as API-key rows so the input picks up the
    // shared border / focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config)[configField] || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config)[configField] || '')) return;
      status.textContent = 'Saving…';
      try {
        await fetchJson('/api/config', { method: 'PUT', body: { [configKey]: value } });
        /** @type {any} */ (this.config)[configField] = value;
        status.textContent = value
          ? `Saved. Pointing at ${value}.`
          : `Saved. Using default (${defaultLabel}).`;
      } catch (err) {
        console.error(`[SettingsPanel] Failed to save host for ${configField}:`, err);
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

    return row;
  }

  /**
   * Build the CLI binary-path input row for the Claude Code provider. Loads the
   * current value from `this.config.claudecodeBinaryPath`; saves via /api/config
   * on blur or Enter. Empty clears the override (falls back to JUGGLER_CLAUDE_PATH
   * then auto-detection on the server). A non-empty save also enables the
   * provider so it becomes selectable without a restart.
   * @param {any} provider - Provider info object (for the enable call)
   * @param {HTMLInputElement} toggle - The provider's enable checkbox, kept in sync
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildClaudeBinaryRow(provider, toggle) {
    const row = document.createElement('div');

    // Reuse the API-key row wrapper so the input inherits the shared border /
    // focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'claudecode-binary-input';
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.placeholder = 'CLI path (leave blank for auto)';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).claudecodeBinaryPath || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).claudecodeBinaryPath || '')) return;
      status.textContent = 'Saving…';
      try {
        await fetchJson('/api/config', { method: 'PUT', body: { claudecode_binary_path: value } });
        /** @type {any} */ (this.config).claudecodeBinaryPath = value;
        if (value) {
          // A user pointing us at a binary means "use Claude Code" — enable it
          // (and reflect that in the toggle) so the model is immediately
          // selectable without a separate click.
          if (!toggle.checked) {
            toggle.checked = true;
            await this.toggleProviderEnabled(provider, true);
          }
          status.textContent = `Saved. Using ${value}.`;
        } else {
          status.textContent = 'Saved. Auto-detecting the claude CLI.';
        }
      } catch (err) {
        console.error('[SettingsPanel] Failed to save Claude Code binary path:', err);
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

    return row;
  }

  /**
   * Toggle enabled state for a keyless provider
   * @param {any} provider - Provider info object
   * @param {boolean} enabled - Whether to enable or disable the provider
   * @private
   */
  async toggleProviderEnabled(provider, enabled) {
    try {
      await fetchJson('/api/config/provider-enabled', {
        method: 'POST',
        body: { provider: provider.name, enabled },
        errorPrefix: 'Failed to update provider',
      });
      // The handler queues a provider recompute; the resulting providers-update
      // is what refreshes every model selector.
    } catch (error) {
      console.error('Failed to toggle provider:', error);
      // Revert toggle on error
      const toggle = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-toggle`));
      if (toggle) {
        toggle.checked = !enabled;
      }
      await showAlert(error instanceof Error ? error.message : 'Failed to update provider', 'Error');
    }
  }

  /**
   * Update all provider buttons and placeholders based on current state
   * @private
   */
  updateAllButtons() {
    const configObj = /** @type {any} */ (this.config);

    for (const provider of this.providers) {
      const hasKey = configObj.keys?.[provider.name] || false;
      const input = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-key`));
      const saveButton = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-save`));
      const deleteButton = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-delete`));
      const sourceHint = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-source`));
      const activeBadge = /** @type {HTMLElement|null} */ (this.host.querySelector(`#${provider.name}-active-badge`));

      const inputHasValue = !!(input && input.value.trim() !== '');

      // Update placeholder based on key source
      if (input) {
        if (provider.keySource === 'env') {
          input.placeholder = `using $${provider.envVarName}`;
          input.disabled = true;
        } else if (hasKey) {
          input.placeholder = '';
          input.disabled = false;
        } else {
          input.placeholder = 'enter a key';
          input.disabled = false;
        }
      }

      // Show "key is active" badge when a credentials-file key exists and the
      // input is empty (i.e. user isn't currently typing a replacement).
      if (activeBadge) {
        const showBadge = hasKey && provider.keySource !== 'env' && !inputHasValue;
        activeBadge.style.display = showBadge ? 'inline-flex' : 'none';
      }

      // Update source hint
      if (sourceHint) {
        if (provider.keySource === 'env') {
          sourceHint.textContent = `Using environment variable $${provider.envVarName}`;
          sourceHint.style.display = 'block';
        } else {
          sourceHint.textContent = '';
          sourceHint.style.display = 'none';
        }
      }

      // Show save button only if input has value and key is not from env var
      if (saveButton) {
        const hasInputValue = input && input.value.trim() !== '';
        saveButton.style.display = (hasInputValue && provider.keySource !== 'env') ? 'block' : 'none';
      }

      // Show delete button only if key exists in credentials file (not env var)
      if (deleteButton) {
        deleteButton.style.display = (hasKey && provider.keySource !== 'env') ? 'block' : 'none';
      }
    }
  }

  /**
   * Save API key for a specific provider
   * @param {any} provider - Provider info object
   * @param {string} apiKey - API key to save
   * @returns {Promise<void>} Completes when the API key is saved
   * @private
   */
  async saveProviderKey(provider, apiKey) {
    if (!apiKey) return;

    try {
      await fetchJson('/api/config', {
        method: 'PUT',
        body: { [provider.configKeyName]: apiKey },
        errorPrefix: 'Failed to save API key',
      });

      // Clear the input so the UI returns to the "key is active" state
      const input = /** @type {HTMLInputElement|null} */ (this.host.querySelector(`#${provider.name}-key`));
      if (input) input.value = '';

      // Reload config from server to get actual state (don't re-render fields)
      await this.host.loadConfig(false);
      // PUT /api/config queues a provider recompute of its own; the resulting
      // providers-update is what refreshes every model selector.
    } catch (error) {
      console.error('Failed to save API key:', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to save API key', 'Error');
    }
  }

  /**
   * Delete API key for a specific provider
   * @param {any} provider - Provider info object
   * @private
   */
  async deleteProviderKey(provider) {
    try {
      // Send empty string to delete the key
      await fetchJson('/api/config', {
        method: 'PUT',
        body: { [provider.configKeyName]: '' },
        errorPrefix: 'Failed to delete API key',
      });

      // Reload config from server to get actual state (don't re-render fields)
      await this.host.loadConfig(false);
      // PUT /api/config queues a provider recompute of its own; the resulting
      // providers-update is what drops the key from every model selector.
    } catch (error) {
      console.error('Failed to delete API key:', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to delete API key', 'Error');
    }
  }
}

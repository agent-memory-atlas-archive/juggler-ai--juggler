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

import { getUpdaterState, startCheck } from '../../services/updater-control.js';
import { fetchJson } from '../../services/http.js';
import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';
import { apiUrl } from '../../utils/api-url.js';

/**
 * The three update modes, matching core.UpdateMode* on the server.
 * @type {Array<{value: string, label: string, description: string}>}
 */
const MODES = [
  {
    value: 'automatic',
    label: 'Automatic',
    description: 'Check periodically and download updates in the background.',
  },
  {
    value: 'notify',
    label: 'Notify only',
    description: 'Check periodically and show an Update button, but never download automatically.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Never check automatically. You can still check manually below.',
  },
];

/**
 * Updates tab: shows version info, lets the user pick an update mode
 * (Automatic / Notify only / Off, backed by GET/PUT /api/settings), and offers a
 * manual "Check for updates" button (POST /api/update-status/check, plus the
 * in-app updater's check-only op when present). It fetches its own data in
 * show(); it does not use the shell's shared loadConfig payload.
 */
export class UpdatesTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {string} @private — the mode last persisted/loaded, for revert on error. */
    this._mode = 'automatic';
    /** @type {boolean} @private — whether an in-app updater is present. */
    this._updaterPresent = false;
  }

  /** Build the static tab DOM and wire persistent listeners. */
  render() {
    const container = this.host.querySelector('#updates-form');
    if (!container) return;
    container.innerHTML = '';

    // ── Version info ────────────────────────────────────────────────────
    const versionBlock = document.createElement('div');
    versionBlock.className = 'settings-group provider-field updates-version-row';
    const versionInfo = document.createElement('div');
    versionInfo.className = 'provider-info';
    const versionName = document.createElement('div');
    versionName.className = 'provider-name';
    versionName.textContent = 'Version';
    const versionDesc = document.createElement('div');
    versionDesc.className = 'provider-description';
    versionDesc.id = 'updates-version-info';
    versionDesc.textContent = 'Loading…';
    versionInfo.appendChild(versionName);
    versionInfo.appendChild(versionDesc);
    versionBlock.appendChild(versionInfo);
    container.appendChild(versionBlock);

    // ── Update mode radios ──────────────────────────────────────────────
    const modeHeading = document.createElement('div');
    modeHeading.className = 'settings-section-heading';
    modeHeading.textContent = 'When updates are available';
    container.appendChild(modeHeading);

    const modeGroup = document.createElement('div');
    modeGroup.className = 'settings-form updates-mode-group';
    modeGroup.setAttribute('role', 'radiogroup');
    modeGroup.setAttribute('aria-label', 'Update mode');
    for (const mode of MODES) {
      const row = document.createElement('label');
      row.className = 'settings-group provider-field updates-mode-row';

      const info = document.createElement('div');
      info.className = 'provider-info';
      const name = document.createElement('div');
      name.className = 'provider-name';
      name.textContent = mode.label;
      const desc = document.createElement('div');
      desc.className = 'provider-description';
      desc.textContent = mode.description;
      info.appendChild(name);
      info.appendChild(desc);

      const ctrl = document.createElement('div');
      ctrl.className = 'provider-control';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'updates-mode';
      input.className = 'updates-mode-radio';
      input.value = mode.value;
      input.addEventListener('change', () => {
        if (input.checked) void this._setMode(mode.value);
      });
      ctrl.appendChild(input);

      row.appendChild(info);
      row.appendChild(ctrl);
      modeGroup.appendChild(row);
    }
    container.appendChild(modeGroup);

    // ── Manual check ────────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'settings-group provider-field updates-check-row';
    const actionInfo = document.createElement('div');
    actionInfo.className = 'provider-info';
    const status = document.createElement('div');
    status.className = 'provider-description';
    status.id = 'updates-check-status';
    status.textContent = '';
    actionInfo.appendChild(status);

    const actionCtrl = document.createElement('div');
    actionCtrl.className = 'provider-control';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'updates-check-btn';
    btn.className = 'settings-btn primary small';
    btn.textContent = 'Check for updates';
    btn.addEventListener('click', () => void this._checkNow());
    actionCtrl.appendChild(btn);

    actions.appendChild(actionInfo);
    actions.appendChild(actionCtrl);
    container.appendChild(actions);
  }

  /**
   * Tab became visible: fetch the version info. The update mode is not read here
   * — the panel hands the settings document to every tab, so the radios are
   * already showing it.
   */
  show() {
    void this._loadVersion();
  }

  /**
   * Fetch version info from /api/update-status (and the in-app updater snapshot,
   * when present) and render it into the version line.
   * @private
   */
  async _loadVersion() {
    // Offline — show what little we have.
    /** @type {any} */
    const status = await fetchJson(apiUrl('/update-status'), { fallback: {} });
    const updater = await getUpdaterState();
    this._updaterPresent = !!updater.present;
    this._renderVersion(status, updater);
  }

  /**
   * @private
   * @param {any} status - The /api/update-status result.
   * @param {import('../../services/updater-control.js').UpdaterState} updater
   */
  _renderVersion(status, updater) {
    const el = this.host.querySelector('#updates-version-info');
    if (!el) return;
    const current = status.currentVersion || (updater && updater.appVersion) || 'unknown';
    const latest = status.latestVersion || '';
    const parts = [`Current version ${current}.`];
    if (status.updateAvailable && latest) {
      parts.push(`Version ${latest} is available.`);
    } else if (status.unpublished) {
      // No comparison was made, and latest is usually newer than this build —
      // so it is reported as what it is, never as the version being run.
      parts.push(latest
        ? `Latest release is ${latest}; a build from source is never offered updates.`
        : 'A build from source is never offered updates.');
    } else if (latest) {
      parts.push(`This is the latest version (${latest}).`);
    } else {
      parts.push('No update information yet.');
    }
    // App-bundle / server skew: an in-app updater whose bundle version differs
    // from the viewed server (a server started outside the app), mirroring
    // update-notice.js's _hasServerSkew. Updating the app won't touch that server.
    if (updater && updater.present && updater.appVersion && status.currentVersion
      && updater.appVersion !== status.currentVersion) {
      parts.push(`The app bundle is v${updater.appVersion}, but this server is ${status.currentVersion};`
        + ` updating the app won't update a server started outside it.`);
    }
    el.textContent = parts.join(' ');
  }

  /**
   * The settings document changed, here or in another window. The radios are one
   * focusable group, so they are left alone while the user is inside it — writing
   * `.checked` across them mid-arrow-key would move the selection under them, and
   * the choice they are making is the one that should win.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    const mode = (settings.updates && settings.updates.mode) || 'automatic';
    this._mode = mode;
    // activeElement rather than a `:focus` match: `:focus` only matches while the
    // DOCUMENT itself has focus, so it reports nothing in a window sitting behind
    // another — or under a test runner — and the guard would quietly never hold.
    const radios = Array.from(this.host.querySelectorAll('.updates-mode-radio'));
    if (radios.some((radio) => radio === document.activeElement)) return;
    this._reflectMode(mode);
  }

  /**
   * Reflect a mode value onto the radios.
   * @private
   * @param {string} mode
   */
  _reflectMode(mode) {
    const radios = this.host.querySelectorAll('.updates-mode-radio');
    radios.forEach((r) => {
      const input = /** @type {HTMLInputElement} */ (r);
      input.checked = input.value === mode;
    });
  }

  /**
   * Persist a new mode via PUT /api/settings, reverting the radios on failure.
   * @private
   * @param {string} mode
   */
  async _setMode(mode) {
    const prev = this._mode;
    this._mode = mode;
    try {
      const data = await fetchJson(apiUrl('/settings'), { method: 'PUT', body: { updates: { mode } } });
      const saved = (data && data.updates && data.updates.mode) || mode;
      this._mode = saved;
      this._reflectMode(saved);
    } catch (err) {
      // Revert the UI to the last-known-good mode.
      this._mode = prev;
      this._reflectMode(prev);
      this._setStatus(`Couldn't save the update setting (${extractErrorMessage(err)}).`);
    }
  }

  /**
   * Run a manual check: POST /api/update-status/check (server notice) plus — when
   * an in-app updater is present — its check-only op (reveal availability without
   * downloading). Surfaces the result inline; opens the update dialog when an
   * update is found.
   * @private
   */
  async _checkNow() {
    const btn = /** @type {HTMLButtonElement|null} */ (this.host.querySelector('#updates-check-btn'));
    if (btn) btn.disabled = true;
    this._setStatus('Checking…');
    try {
      // Kick the in-app updater's check-only probe first (fire-and-forget; the
      // result arrives via the pushed snapshot the header button consumes).
      if (this._updaterPresent) void startCheck();

      const status = await fetchJson(apiUrl('/update-status/check'), { method: 'POST' });
      if (status.error) {
        this._setStatus('Couldn’t reach the update server. Try again later.');
      } else if (status.updateAvailable) {
        this._setStatus(`Version ${status.latestVersion || ''} is available.`.trim());
        // Surface the full dialog (with download/install affordances).
        window.dispatchEvent(new CustomEvent('juggler:open-update-dialog'));
      } else if (status.unpublished) {
        this._setStatus(status.latestVersion
          ? `Latest release is ${status.latestVersion}; a build from source is never offered updates.`
          : 'A build from source is never offered updates.');
      } else {
        this._setStatus('You’re on the latest version.');
      }
      const updater = await getUpdaterState();
      this._renderVersion(status, updater);
    } catch (err) {
      this._setStatus(`Check failed (${extractErrorMessage(err)}).`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * @private
   * @param {string} text
   */
  _setStatus(text) {
    const el = this.host.querySelector('#updates-check-status');
    if (el) el.textContent = text;
  }
}

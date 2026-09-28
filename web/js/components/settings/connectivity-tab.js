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

import { formatTimeAgo } from '../../utils/format.js';
import { createCopyButton } from '../../../sdk/lib/copy-button.js';
import wsService from '../../services/websocket.js';
import { ProxySettings } from './proxy-settings.js';
import { fetchJson, httpErrorText } from '../../services/http.js';

/** Polling interval (ms) for refreshing the Connectivity tab while it's open. */
const CONNECTIVITY_POLL_MS = 2000;

/**
 * One WAN tunnel mode this server's build registered, as reported by
 * GET /api/connectivity `wanModes`. The Connectivity tab's WAN section is
 * rendered entirely from this list; an empty list means the build has no WAN
 * feature and the section is hidden.
 * @typedef {object} WANMode
 * @property {string} mode - Wire id sent to POST /api/connectivity/tunnel
 * @property {string} title - Short mode name, e.g. "Direct P2P"
 * @property {string} description - One-paragraph explanation of trade-offs
 * @property {string} startLabel - Start-button label
 * @property {string} relayNote - Optional note shown while active
 * @property {string} unavailableHint - Shown instead of Start when unavailable
 * @property {boolean} available - Whether the mode can start on this machine
 */

/**
 * One connected viewer client, as reported by GET /api/connectivity `clients`
 * and the clients-changed event. The `id` lets a client exclude itself.
 * @typedef {object} ClientDescriptor
 * @property {string} id - Server-assigned client id
 * @property {string} origin - "local" (same machine), "lan", or "remote"
 * @property {string} detail - LAN IP, or remote transport label; "" for local
 * @property {string} userAgent - Raw User-Agent, when the transport had one
 * @property {number} connectedAt - Connect time, unix milliseconds
 */

/**
 * Human label for a client's origin, e.g. "Same machine", "LAN · 192.168.1.4",
 * or the remote transport name ("Cloudflare Tunnel relay", "Peer-to-peer").
 * @param {ClientDescriptor} c
 * @returns {string} The origin label.
 */
function clientOriginLabel(c) {
  switch (c.origin) {
    case 'local': return 'Same machine';
    case 'lan': return c.detail ? `LAN · ${c.detail}` : 'LAN';
    case 'remote': return c.detail || 'Remote';
    default: return 'Connected';
  }
}

/**
 * Coarse "Browser · OS" label from a User-Agent, best-effort. Returns '' when
 * nothing recognisable is present (UA parsing is deliberately shallow).
 * @param {string} ua
 * @returns {string} A "Browser · OS" label, or '' when nothing is recognised.
 */
function clientDeviceLabel(ua) {
  if (!ua) return '';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\//.test(ua)) br = 'Opera';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return [br, os].filter(Boolean).join(' · ');
}

/**
 * Fetch a QR-code SVG for `url` from the server and inline it into `host`.
 * Inline (rather than <img>) so `fill="currentColor"` inherits the surrounding
 * text colour. The SVG is transparent (no background rect).
 * @param {HTMLElement} host
 * @param {string} url
 */
async function loadQRCodeSVG(host, url) {
  try {
    const res = await fetch(`/api/connectivity/qr?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    host.innerHTML = await res.text();
  } catch {
    // Network failure: leave the host empty rather than throwing.
  }
}

/**
 * Connectivity tab: LAN/WAN access controls, per-address URL/QR blocks, and a
 * live list of the other clients sharing this session. Seeded from the shared
 * loadConfig() fetch, then kept current by its own 2 s poll while visible and by
 * the `clients-changed` ws event even between polls (only the clients box
 * re-renders on that event — open QR images/controls are left untouched).
 */
export class ConnectivityTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /**
     * The outbound-proxy box shown at the bottom of this tab. It renders into
     * its own `#proxy-form` container, so the connectivity poll never touches
     * it; this tab just forwards render()/load() to it.
     * @type {ProxySettings} @private
     */
    this._proxy = new ProxySettings(host);
    /** @type {number|undefined} @private */
    this._connectivityPollId = undefined;
    /** @type {{lanEnabled: boolean, lanURLs: string[], tunnelEnabled: boolean, tunnelURL: string, tunnelMode: string, tunnelRelay: boolean, wanModes: WANMode[], clientCount: number, clients: ClientDescriptor[]}} @private */
    this.connectivity = { lanEnabled: false, lanURLs: [], tunnelEnabled: false, tunnelURL: '', tunnelMode: '', tunnelRelay: false, wanModes: [], clientCount: 1, clients: [] };
    /**
     * Persisted "Start on launch" preferences, from the `connectivity` section of
     * the settings document the panel hands over. Held here so the 2 s runtime
     * poll — which rebuilds the form from /api/connectivity — renders these
     * controls from the cache rather than flickering or refetching them.
     * `wanOnLaunch` is a single mode id ('' = none): only one WAN tunnel can be
     * armed, so the per-mode toggles are mutually exclusive by construction.
     * @type {{lanOnLaunch: boolean, wanOnLaunch: string}} @private
     */
    this._launchPrefs = { lanOnLaunch: false, wanOnLaunch: '' };
    /** @type {string} @private - Inline error from the most recent WAN action, set at the action site and cleared at the start of the next one. */
    this._wanError = '';
    /** @type {boolean} @private - True once the shared loadConfig() has seeded this tab (gates the poll/live-update like the panel's first-load flag did). */
    this._loaded = false;
    /** @type {boolean} @private - True while this tab is the visible one. */
    this._visible = false;

    // Keep the connected-clients box live as viewers join or leave, independent
    // of the 2 s poll (which only runs while this tab is open). Only the clients
    // section re-renders — never the whole form — so open LAN/WAN QR images and
    // controls are left untouched.
    /** @type {((data: any) => void)|null} @private */
    this._onClientsChanged = (data) => {
      this.connectivity.clientCount = data.count;
      this.connectivity.clients = data.clients || [];
      if (this._visible && this._loaded) {
        this._refreshClientsSection();
      }
    };
    wsService.on('clients-changed', this._onClientsChanged);
  }

  /** Build the static DOM the shell owns for this tab (the proxy box). */
  render() {
    this._proxy.render();
  }

  /**
   * Receive the shared loadConfig() payload: store the connectivity state and
   * (on a full render) build the fields.
   * @param {{connectivity: object}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.connectivity = /** @type {any} */ (data.connectivity);
    this._loaded = true;
    if (renderFields) this.renderConnectivityFields();
  }

  /** Tab became visible: refresh and arm the background poll (once loaded). */
  show() {
    this._visible = true;
    if (!this._loaded) return;
    this.refreshConnectivity();
    this._connectivityPollId = setInterval(() => this.refreshConnectivity(), CONNECTIVITY_POLL_MS);
  }

  /**
   * The settings document arrived — from the panel's fetch, or because it changed
   * here or in another window, which share the one file. The proxy box owns its
   * own section of it; this tab owns the "Start on launch" preferences.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    this._proxy.onSettingsChanged(settings);
    const conn = settings.connectivity || {};
    const next = { lanOnLaunch: !!conn.lanOnLaunch, wanOnLaunch: conn.wanOnLaunch || '' };
    const unchanged = next.lanOnLaunch === this._launchPrefs.lanOnLaunch
      && next.wanOnLaunch === this._launchPrefs.wanOnLaunch;
    this._launchPrefs = next;
    if (unchanged) return;
    this._reflectLaunchToggles();
  }

  /**
   * Write the cached launch preferences onto the toggles, in place.
   *
   * Deliberately not a re-render: renderConnectivityFields() empties the whole
   * form, which kills focus and refetches every QR image — for a change that can
   * only ever move a checkbox. A toggle the user is on keeps what they see, since
   * the value they are about to send is the one that matters.
   * @private
   */
  _reflectLaunchToggles() {
    this.host.querySelectorAll('.connectivity-launch-checkbox').forEach((el) => {
      const input = /** @type {HTMLInputElement} */ (el);
      if (document.activeElement === input) return;
      input.checked = input.dataset.launch === 'wan'
        ? this._launchPrefs.wanOnLaunch === input.dataset.wanMode
        : this._launchPrefs.lanOnLaunch;
    });
  }

  /** Tab hidden: stop the background poll. */
  hide() {
    this._visible = false;
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
  }

  /** Panel closed: stop the background poll. */
  close() {
    this.hide();
  }

  /** Element disconnected: drop the clients-changed subscription. */
  dispose() {
    if (this._onClientsChanged) {
      wsService.off('clients-changed', this._onClientsChanged);
      this._onClientsChanged = null;
    }
    this.hide();
  }

  /**
   * Fetch current connectivity state and re-render the connectivity fields.
   * @param {boolean} [force=false] - Re-render even when the server state is
   *   unchanged. Action handlers pass true so a busy button resets and any
   *   inline error shows even on a no-op result; the background poll leaves it
   *   false so an unchanged tick is a no-op.
   * @private
   */
  async refreshConnectivity(force = false) {
    try {
      const next = await fetchJson('/api/connectivity');
      if (!next) return;
      const prev = this.connectivity;
      this.connectivity = next;
      // The connected-clients section owns no inputs or QR images, so refresh it
      // every tick — that keeps the relative "connected N ago" times and the
      // membership current without a full-form rebuild.
      this._refreshClientsSection();
      // Skip the full re-render if nothing observable in the LAN/WAN form has
      // changed. Without this the 2 s poll wipes the connectivity form
      // (innerHTML = '') every tick, killing input focus and re-loading QR
      // images. The client list is excluded here — it's handled just above.
      const serialise = (/** @type {any} */ c) => JSON.stringify({
        lanEnabled: c.lanEnabled,
        lanURLs: c.lanURLs || [],
        tunnelEnabled: c.tunnelEnabled,
        tunnelURL: c.tunnelURL || '',
        tunnelMode: c.tunnelMode || '',
        tunnelRelay: !!c.tunnelRelay,
        wanModes: c.wanModes || [],
      });
      if (!force && prev && serialise(prev) === serialise(next)) return;
      this.renderConnectivityFields();
    } catch (e) {
      console.error('Failed to refresh connectivity:', e);
    }
  }

  /**
   * Render the Connectivity tab content.
   * @private
   */
  renderConnectivityFields() {
    const container = this.host.querySelector('#connectivity-form');
    if (!container) return;
    const c = this.connectivity;

    container.innerHTML = '';

    // ── Connected clients ─────────────────────────────────────────────
    // Lists the OTHER clients sharing this session (this window excluded). The
    // box IS the section element (a standard provider-field row) so it keeps the
    // normal inter-box gap; _refreshClientsSection rebuilds only its contents,
    // so live updates never touch the LAN/WAN form below.
    const clientsSection = document.createElement('div');
    clientsSection.id = 'connectivity-clients-section';
    clientsSection.className = 'settings-group provider-field connectivity-clients';
    container.appendChild(clientsSection);
    this._refreshClientsSection();

    // ── LAN access row ────────────────────────────────────────────────
    container.appendChild(this._buildLANAccessRow(c));

    // ── WAN access section (one block per server-registered mode) ─────
    // A build with no registered WAN modes reports an empty list and gets
    // no WAN section at all.
    if ((c.wanModes || []).length > 0) {
      container.appendChild(this._buildWANAccessRow(c));
    }
  }

  /**
   * (Re)build the connected-clients box contents in place: a "Connected clients"
   * label on the left, and on the right a list with one line per OTHER client
   * (this window is filtered out by id) — its origin, device, and how long it's
   * been connected — or a muted "none" line. Safe to call before the box exists
   * (no-op) and cheap to call on every poll tick (no inputs or QR images).
   * @private
   */
  _refreshClientsSection() {
    const section = this.host.querySelector('#connectivity-clients-section');
    if (!section) return;

    const all = this.connectivity.clients || [];
    // Exclude our own window by id. Before the session id is known (a brief
    // window at startup) nothing matches, so drop one entry so we never count
    // ourselves as an "other" client.
    const selfId = wsService.clientId;
    let others = selfId ? all.filter((c) => c.id !== selfId) : all.slice(1);
    // Oldest first, so the list order stays stable as clients join.
    others = others.slice().sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));

    section.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Connected clients';
    info.appendChild(name);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (others.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'connectivity-clients-empty';
      empty.textContent = 'No other clients connected';
      ctrl.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'connectivity-client-list';
      for (const c of others) {
        const li = document.createElement('li');
        li.className = 'connectivity-client';

        const dot = document.createElement('span');
        dot.className = `connectivity-client-dot origin-${c.origin || 'unknown'}`;
        li.appendChild(dot);

        const originEl = document.createElement('span');
        originEl.className = 'connectivity-client-origin';
        originEl.textContent = clientOriginLabel(c);
        li.appendChild(originEl);

        // Device + connected-since, muted. Either may be absent.
        const parts = [clientDeviceLabel(c.userAgent), formatTimeAgo(c.connectedAt)].filter(Boolean);
        if (parts.length) {
          const meta = document.createElement('span');
          meta.className = 'connectivity-client-meta';
          meta.textContent = parts.join(' — ');
          li.appendChild(meta);
        }

        list.appendChild(li);
      }
      ctrl.appendChild(list);
    }

    section.appendChild(info);
    section.appendChild(ctrl);
  }

  /**
   * Build the LAN access row: a Start/Stop control (matching the WAN mode
   * blocks) plus a URL/QR block per reachable LAN address when enabled.
   * @param {{lanEnabled: boolean, lanURLs: string[]}} c - Connectivity state
   * @returns {HTMLElement} The row element to append to the connectivity form.
   * @private
   */
  _buildLANAccessRow(c) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'LAN access';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Allow other devices on your local network to connect.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (c.lanEnabled) {
      if (c.lanURLs && c.lanURLs.length > 0) {
        // Lay the per-address URL/QR blocks out as a left-to-right flow that
        // wraps onto new lines, rather than a single stacked column. The LAN
        // URL is http://<ip>, which a native window's WebKit won't hand to the
        // system browser; the block routes clicks via the loopback opener.
        const list = document.createElement('div');
        list.className = 'connectivity-url-list';
        for (const url of c.lanURLs) {
          list.appendChild(this._buildConnectivityURLBlock(url));
        }
        ctrl.appendChild(list);
      } else {
        const hint = document.createElement('div');
        hint.className = 'key-source-hint';
        hint.style.display = 'block';
        hint.textContent = 'No LAN interfaces detected.';
        ctrl.appendChild(hint);
      }

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'settings-btn danger small';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        this._setLAN(false);
      });
      ctrl.appendChild(stopBtn);
    } else {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'settings-btn primary small';
      startBtn.textContent = 'Start LAN access';
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        this._setLAN(true);
      });
      ctrl.appendChild(startBtn);
    }

    // "Start on launch" preference — independent of whether LAN is running now.
    ctrl.appendChild(this._buildLaunchToggle({
      checked: this._launchPrefs.lanOnLaunch,
      onChange: (on) => this._setLANOnLaunch(on),
    }));

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Build a "Start on launch" toggle: a labelled checkbox appended to a row's
   * control column. The LAN row uses one directly; each WAN mode block uses one
   * radio-style (only one WAN mode can be armed, since they all write the single
   * wanOnLaunch preference). Applies to desktop-app launches only — a terminal
   * launch uses CLI flags.
   * Each toggle carries which preference it stands for, so a document arriving
   * from another window can be written onto the checkboxes without rebuilding the
   * form around them (see {@link ConnectivityTab#_reflectLaunchToggles}).
   * @param {{checked: boolean, onChange: (checked: boolean) => void, wanMode?: string}} opts
   * @returns {HTMLElement} The toggle label element.
   * @private
   */
  _buildLaunchToggle(opts) {
    const label = document.createElement('label');
    label.className = 'connectivity-launch-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'connectivity-launch-checkbox';
    if (opts.wanMode === undefined) {
      input.dataset.launch = 'lan';
    } else {
      input.dataset.launch = 'wan';
      input.dataset.wanMode = opts.wanMode;
    }
    input.checked = !!opts.checked;
    input.addEventListener('change', () => opts.onChange(input.checked));
    const text = document.createElement('span');
    text.textContent = 'Start on launch';
    label.appendChild(input);
    label.appendChild(text);
    return label;
  }

  /**
   * Persist the LAN "Start on launch" preference (optimistic; revert + re-render
   * on failure). Sends only its own section — the server merges it into the
   * existing settings document.
   * @param {boolean} on
   * @private
   */
  async _setLANOnLaunch(on) {
    const prev = this._launchPrefs.lanOnLaunch;
    this._launchPrefs = { ...this._launchPrefs, lanOnLaunch: on };
    if (!(await this._putLaunchPrefs({ lanOnLaunch: on }))) {
      this._launchPrefs = { ...this._launchPrefs, lanOnLaunch: prev };
      this.renderConnectivityFields();
    }
  }

  /**
   * Arm (or clear) a WAN mode's "Start on launch" preference. Selecting a mode
   * sets wanOnLaunch to it; clicking the currently-armed mode clears it to ''.
   * Because it's a single stored value the mode blocks are mutually exclusive.
   * Optimistic (re-renders immediately to reflect the single selection); reverts
   * on failure.
   * @param {string} mode - The mode id whose toggle was clicked.
   * @private
   */
  async _setWANOnLaunch(mode) {
    const prev = this._launchPrefs.wanOnLaunch;
    const next = prev === mode ? '' : mode; // clicking the armed mode clears it
    this._launchPrefs = { ...this._launchPrefs, wanOnLaunch: next };
    this.renderConnectivityFields();
    if (!(await this._putLaunchPrefs({ wanOnLaunch: next }))) {
      this._launchPrefs = { ...this._launchPrefs, wanOnLaunch: prev };
      this.renderConnectivityFields();
    }
  }

  /**
   * PUT a partial connectivity settings patch to /api/settings. The server
   * merges it into the existing document, so sending only the changed field
   * preserves every other section. Returns true on success.
   * @param {{lanOnLaunch?: boolean, wanOnLaunch?: string}} connectivity
   * @returns {Promise<boolean>} True when the server accepted the patch.
   * @private
   */
  async _putLaunchPrefs(connectivity) {
    try {
      await fetchJson('/api/settings', { method: 'PUT', body: { connectivity } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Enable or disable LAN access, then re-render from authoritative state.
   * @param {boolean} enabled
   * @private
   */
  async _setLAN(enabled) {
    try {
      await fetchJson('/api/connectivity/lan', { method: 'POST', body: { enabled } });
    } catch (e) {
      console.error('Failed to set LAN access:', e);
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Build the WAN access section: one block per WAN mode the server's build
   * registered, rendered entirely from the `wanModes` the connectivity API
   * reports. Only one tunnel is ever active; the active mode shows its URL/QR
   * and a Stop button. Driven purely from connectivity state — never from
   * optimistic local toggles.
   * @param {{tunnelEnabled: boolean, tunnelURL: string, tunnelMode: string, wanModes: WANMode[]}} c - Connectivity state
   * @returns {DocumentFragment} The heading + mode blocks to append to the connectivity form.
   * @private
   */
  _buildWANAccessRow(c) {
    // A flat fragment (not a wrapper div) so the heading and mode boxes are
    // direct children of #connectivity-form — matching the Defaults tab, where a
    // .settings-section-heading is a sibling of its .provider-field rows. That
    // lets the shared section-heading margins space this section like the others.
    const section = document.createDocumentFragment();

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'WAN access';
    section.appendChild(heading);

    const activeMode = c.tunnelEnabled ? (c.tunnelMode || '') : '';

    for (const mode of c.wanModes || []) {
      section.appendChild(this._buildWANModeBlock({
        mode: mode.mode,
        title: mode.title,
        description: mode.description,
        startLabel: mode.startLabel || `Start ${mode.title}`,
        available: !!mode.available,
        isActive: activeMode === mode.mode,
        url: activeMode === mode.mode ? c.tunnelURL : '',
        relayNote: mode.relayNote || '',
        unavailableHint: mode.unavailableHint || '',
      }));
    }

    if (this._wanError) {
      const err = document.createElement('div');
      err.className = 'key-source-hint connectivity-wan-error';
      err.style.display = 'block';
      err.textContent = this._wanError;
      section.appendChild(err);
    }

    return section;
  }

  /**
   * Build a single WAN-mode block: title + copy on the left, and on the right
   * either a Start button, or (when this mode is the active tunnel) its URL/QR
   * and a Stop button, or (when unavailable) the mode's install hint.
   * @param {{mode: string, title: string, description: string, startLabel: string, available: boolean, isActive: boolean, url: string, relayNote?: string, unavailableHint?: string}} opts
   * @returns {HTMLElement} The mode block element.
   * @private
   */
  _buildWANModeBlock(opts) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = opts.title;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = opts.description;
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (opts.isActive) {
      const statusHint = document.createElement('div');
      statusHint.className = 'key-source-hint';
      statusHint.style.display = 'block';
      statusHint.textContent = opts.url
        ? 'Open this URL in a remote browser to connect.'
        : 'Connecting…';
      ctrl.appendChild(statusHint);

      if (opts.url) {
        ctrl.appendChild(this._buildConnectivityURLBlock(opts.url));
      }

      if (opts.relayNote) {
        const note = document.createElement('div');
        note.className = 'key-source-hint';
        note.style.display = 'block';
        note.textContent = opts.relayNote;
        ctrl.appendChild(note);
      }

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'settings-btn danger small';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        this._stopTunnel();
      });
      ctrl.appendChild(stopBtn);
    } else if (opts.available) {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'settings-btn primary small';
      startBtn.textContent = opts.startLabel;
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        this._startTunnel(opts.mode);
      });
      ctrl.appendChild(startBtn);
    } else {
      ctrl.appendChild(this._buildWANUnavailableHint(opts.unavailableHint || `${opts.title} is not available on this machine.`));
    }

    // "Start on launch" preference for this mode — radio-style across the WAN
    // blocks (arming one clears the others via the single wanOnLaunch value),
    // shown regardless of whether this mode is currently running or available.
    ctrl.appendChild(this._buildLaunchToggle({
      checked: this._launchPrefs.wanOnLaunch === opts.mode,
      onChange: () => this._setWANOnLaunch(opts.mode),
      wanMode: opts.mode,
    }));

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Render a WAN-mode unavailable hint as text, turning any http(s) URLs it
   * contains into external links so a plain-text hint from the server can still
   * point at install docs.
   * @param {string} text - The mode's unavailableHint
   * @returns {HTMLElement} The hint element.
   * @private
   */
  _buildWANUnavailableHint(text) {
    const hint = document.createElement('div');
    hint.className = 'key-source-hint';
    hint.style.display = 'block';
    for (const part of text.split(/(https?:\/\/[^\s]+)/)) {
      if (/^https?:\/\//.test(part)) {
        const link = document.createElement('a');
        link.href = part;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'connectivity-url';
        link.textContent = part;
        hint.appendChild(link);
      } else if (part) {
        hint.appendChild(document.createTextNode(part));
      }
    }
    return hint;
  }

  /**
   * Start a WAN tunnel in the given mode. The backend auto-stops any other-mode
   * tunnel on an explicit different-mode start. Re-renders from authoritative
   * state afterwards.
   * @param {string} mode - A wire mode id from the server's wanModes list
   * @private
   */
  async _startTunnel(mode) {
    this._wanError = '';
    try {
      const data = await fetchJson('/api/connectivity/tunnel', {
        method: 'POST',
        body: { enabled: true, mode },
      });
      if (!data?.ok) this._wanError = data?.error || 'Failed to start tunnel';
    } catch (e) {
      this._wanError = httpErrorText(e, 'Failed to start tunnel');
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Stop whichever WAN tunnel is currently active.
   * @private
   */
  async _stopTunnel() {
    this._wanError = '';
    try {
      const data = await fetchJson('/api/connectivity/tunnel', {
        method: 'POST',
        body: { enabled: false },
      });
      if (!data?.ok) this._wanError = data?.error || 'Failed to stop tunnel';
    } catch (e) {
      this._wanError = httpErrorText(e, 'Failed to stop tunnel');
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Build a connectivity URL block: a clickable link (routed through the
   * loopback opener) with a copy-to-clipboard button, alongside an inline QR
   * code for the same URL.
   * @param {string} url - The URL to link to and encode as a QR code
   * @returns {HTMLElement} The URL block element to append to a control column.
   * @private
   */
  _buildConnectivityURLBlock(url) {
    const urlBlock = document.createElement('div');
    urlBlock.className = 'connectivity-url-block';
    const urlRow = document.createElement('div');
    urlRow.className = 'connectivity-url-row';
    const urlLink = document.createElement('a');
    urlLink.href = url;
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.className = 'connectivity-url';
    urlLink.textContent = url;
    const copyBtn = createCopyButton(url, 'connectivity-url-copy', 'Copy URL to clipboard');
    urlRow.appendChild(urlLink);
    urlRow.appendChild(copyBtn);
    const qrHost = document.createElement('div');
    qrHost.className = 'connectivity-qr';
    qrHost.setAttribute('role', 'img');
    qrHost.setAttribute('aria-label', 'QR code');
    loadQRCodeSVG(qrHost, url);
    urlBlock.appendChild(urlRow);
    urlBlock.appendChild(qrHost);
    return urlBlock;
  }
}

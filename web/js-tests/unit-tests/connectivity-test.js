//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Connectivity tab — data-driven WAN access UI tests.
 *
 * The Connectivity tab renders one WAN-mode block per entry in the `wanModes`
 * list the connectivity API reports (a build that registers no modes reports
 * an empty list and shows no WAN section at all). These cases drive the
 * component with fake modes to pin that an unavailable mode degrades to its
 * install hint (URLs linkified), that each Start/Stop button issues the
 * correct POST body, and that the rendered UI is driven purely from
 * `this.connectivity` (no optimistic local state). The component is driven via
 * its own render path with a stubbed connectivity state + a captured fetch —
 * no real tunnel is started.
 * @module unit-tests/connectivity-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Mount a settings-panel, seed its connectivity state, and render the
   * connectivity fields directly (bypassing the network load).
   * @param {object} connectivity
   * @returns {any} The mounted element (caller removes it).
   */
  const mountWith = (connectivity) => {
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    const tab = el._tabs.connectivity;
    tab.connectivity = connectivity;
    tab.renderConnectivityFields();
    return el;
  };

  /**
   * Two fake WAN modes mirroring the shape GET /api/connectivity reports.
   * @param {{relayAvailable?: boolean}} [opts]
   * @returns {object[]} The fake wanModes list
   */
  const fakeModes = ({ relayAvailable = false } = {}) => ([
    {
      mode: 'p2p',
      title: 'Direct P2P',
      description: 'Connects your browser directly using WebRTC.',
      startLabel: 'Start Direct P2P',
      relayNote: '',
      unavailableHint: '',
      available: true,
    },
    {
      mode: 'cloudflared',
      title: 'Cloudflare Tunnel relay',
      description: 'Uses your installed cloudflared.',
      startLabel: 'Start relay',
      relayNote: 'Traffic is relayed through Cloudflare.',
      unavailableHint: 'Requires cloudflared. Install with brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      available: relayAvailable,
    },
  ]);

  const baseIdle = (modeOpts = {}) => ({
    lanEnabled: false,
    lanURLs: [],
    tunnelEnabled: false,
    tunnelURL: '',
    tunnelMode: '',
    tunnelRelay: false,
    wanModes: fakeModes(modeOpts),
  });

  await run('no registered WAN modes -> no WAN section at all', async () => {
    const el = mountWith({ ...baseIdle(), wanModes: [] });
    try {
      assert(!el.querySelector('#connectivity-form .settings-section-heading'),
        'WAN section heading must be absent when the build registers no modes');
      const text = el.querySelector('#connectivity-form').textContent || '';
      assert(!/WAN access/.test(text), `no WAN heading expected; got: ${text}`);
    } finally {
      el.remove();
    }
  });

  await run('an unavailable mode shows its install hint (no button), with URLs linkified', async () => {
    const el = mountWith(baseIdle());
    try {
      const buttons = [...el.querySelectorAll('#connectivity-form button')];
      const labels = buttons.map((b) => (b.textContent || '').trim());
      assert(labels.includes('Start Direct P2P'), `P2P start button present; got: ${labels.join(', ')}`);
      assert(!labels.includes('Start relay'), `relay start button must be absent when unavailable; got: ${labels.join(', ')}`);

      const hint = [...el.querySelectorAll('#connectivity-form .key-source-hint')]
        .map((h) => h.textContent || '').join(' | ');
      assert(/Requires cloudflared/.test(hint), `expected the mode's install hint; got: ${hint}`);
      assert(/brew install cloudflared/.test(hint), 'install hint mentions the brew command');
      const docLink = el.querySelector('#connectivity-form a[href*="developers.cloudflare.com"]');
      assert(docLink, 'URL inside the hint is rendered as a link');
    } finally {
      el.remove();
    }
  });

  await run('an available mode shows its start button', async () => {
    const el = mountWith(baseIdle({ relayAvailable: true }));
    try {
      const labels = [...el.querySelectorAll('#connectivity-form button')]
        .map((b) => (b.textContent || '').trim());
      assert(labels.includes('Start Direct P2P'), 'P2P start button present');
      assert(labels.includes('Start relay'), `relay start button present when available; got: ${labels.join(', ')}`);
    } finally {
      el.remove();
    }
  });

  /**
   * Click a button by its label and capture the single /api/connectivity/tunnel
   * POST it issues. The follow-up GET (refreshConnectivity) is stubbed to the
   * same idle state so the handler completes.
   * @param {any} el
   * @param {string} label
   * @returns {Promise<any>} parsed POST body
   */
  const capturePost = async (el, label) => {
    const orig = window.fetch;
    /** @type {any} */
    let body = null;
    window.fetch = /** @type {any} */ (async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/connectivity/tunnel')) {
        body = JSON.parse(opts.body);
        return /** @type {any} */ ({ ok: true, json: async () => ({ success: true }) });
      }
      // refreshConnectivity GET — keep state unchanged.
      return /** @type {any} */ ({ ok: true, json: async () => el._tabs.connectivity.connectivity });
    });
    try {
      const btn = [...el.querySelectorAll('#connectivity-form button')]
        .find((b) => (b.textContent || '').trim() === label);
      assert(btn, `button "${label}" present`);
      btn.click();
      // Let the async click handler's fetch + refresh settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      window.fetch = orig;
    }
    return body;
  };

  await run('Start Direct P2P posts {enabled:true, mode:"p2p"}', async () => {
    const el = mountWith(baseIdle());
    try {
      const body = await capturePost(el, 'Start Direct P2P');
      assert(body && body.enabled === true && body.mode === 'p2p',
        `expected {enabled:true,mode:"p2p"}; got: ${JSON.stringify(body)}`);
    } finally {
      el.remove();
    }
  });

  await run('Start relay posts {enabled:true, mode:"cloudflared"}', async () => {
    const el = mountWith(baseIdle({ relayAvailable: true }));
    try {
      const body = await capturePost(el, 'Start relay');
      assert(body && body.enabled === true && body.mode === 'cloudflared',
        `expected {enabled:true,mode:"cloudflared"}; got: ${JSON.stringify(body)}`);
    } finally {
      el.remove();
    }
  });

  await run('active P2P tunnel shows its URL + a Stop button that posts {enabled:false}', async () => {
    const el = mountWith({
      ...baseIdle(),
      tunnelEnabled: true,
      tunnelMode: 'p2p',
      tunnelURL: 'https://juggler.studio/c/abc',
    });
    try {
      const link = el.querySelector('#connectivity-form .connectivity-url');
      assert(link && (link.textContent || '').includes('juggler.studio/c/abc'),
        'active tunnel shows its URL');
      const labels = [...el.querySelectorAll('#connectivity-form button')]
        .map((b) => (b.textContent || '').trim());
      assert(labels.includes('Stop'), `active tunnel shows a Stop button; got: ${labels.join(', ')}`);
      assert(!labels.includes('Start Direct P2P'),
        'the active mode shows Stop rather than its own Start');

      const body = await capturePost(el, 'Stop');
      assert(body && body.enabled === false,
        `Stop posts {enabled:false}; got: ${JSON.stringify(body)}`);
    } finally {
      el.remove();
    }
  });

  /**
   * Click a launch toggle (or run any DOM action) and capture the single
   * PUT /api/settings body it issues. Any other fetch (GET) resolves benignly.
   * @param {any} el
   * @param {() => void} doAction
   * @returns {Promise<any>} parsed PUT body
   */
  const captureSettingsPut = async (el, doAction) => {
    const orig = window.fetch;
    /** @type {any} */
    let body = null;
    window.fetch = /** @type {any} */ (async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/settings') && opts && opts.method === 'PUT') {
        body = JSON.parse(opts.body);
        return /** @type {any} */ ({ ok: true, json: async () => ({}) });
      }
      return /** @type {any} */ ({ ok: true, json: async () => el._tabs.connectivity.connectivity });
    });
    try {
      doAction();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      window.fetch = orig;
    }
    return body;
  };

  /**
   * Find the provider-field row whose provider-name matches title exactly.
   * @param {any} el
   * @param {string} title
   * @returns {any} the row element (or undefined)
   */
  const rowByName = (el, title) => [...el.querySelectorAll('#connectivity-form .provider-field')]
    .find((r) => {
      const n = r.querySelector('.provider-name');
      return n && (n.textContent || '').trim() === title;
    });

  await run('LAN row "Start on launch" checkbox PUTs {connectivity:{lanOnLaunch:true}}', async () => {
    const el = mountWith(baseIdle());
    try {
      const lanRow = rowByName(el, 'LAN access');
      assert(lanRow, 'LAN access row present');
      const cb = lanRow.querySelector('.connectivity-launch-checkbox');
      assert(cb, 'LAN row has a Start-on-launch checkbox');
      const body = await captureSettingsPut(el, () => {
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      });
      assert(body && body.connectivity && body.connectivity.lanOnLaunch === true,
        `expected {connectivity:{lanOnLaunch:true}}; got ${JSON.stringify(body)}`);
    } finally {
      el.remove();
    }
  });

  await run('WAN mode "Start on launch" toggle PUTs {connectivity:{wanOnLaunch:"p2p"}}', async () => {
    const el = mountWith(baseIdle());
    try {
      const p2pRow = rowByName(el, 'Direct P2P');
      assert(p2pRow, 'P2P mode block present');
      const cb = p2pRow.querySelector('.connectivity-launch-checkbox');
      assert(cb, 'P2P block has a Start-on-launch toggle');
      const body = await captureSettingsPut(el, () => {
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      });
      assert(body && body.connectivity && body.connectivity.wanOnLaunch === 'p2p',
        `expected {connectivity:{wanOnLaunch:"p2p"}}; got ${JSON.stringify(body)}`);
    } finally {
      el.remove();
    }
  });

  await run('armed WAN mode renders checked, others unchecked; re-click clears to ""', async () => {
    const el = mountWith(baseIdle({ relayAvailable: true }));
    try {
      const tab = el._tabs.connectivity;
      tab._launchPrefs = { lanOnLaunch: false, wanOnLaunch: 'p2p' };
      tab.renderConnectivityFields();

      const p2pCb = rowByName(el, 'Direct P2P').querySelector('.connectivity-launch-checkbox');
      const relayCb = rowByName(el, 'Cloudflare Tunnel relay').querySelector('.connectivity-launch-checkbox');
      assert(p2pCb.checked, 'armed mode checkbox is checked');
      assert(!relayCb.checked, 'the other WAN mode checkbox is unchecked (single selection)');

      const body = await captureSettingsPut(el, () => {
        p2pCb.checked = false;
        p2pCb.dispatchEvent(new Event('change'));
      });
      assert(body && body.connectivity && body.connectivity.wanOnLaunch === '',
        `re-clicking the armed mode clears the preference; got ${JSON.stringify(body)}`);
    } finally {
      el.remove();
    }
  });

  await run('active cloudflared tunnel notes that traffic is relayed', async () => {
    const el = mountWith({
      ...baseIdle({ relayAvailable: true }),
      tunnelEnabled: true,
      tunnelMode: 'cloudflared',
      tunnelRelay: true,
      tunnelURL: 'https://foo.trycloudflare.com',
    });
    try {
      const text = el.querySelector('#connectivity-form').textContent || '';
      assert(/relayed through Cloudflare/.test(text),
        `active relay notes the Cloudflare relay; got: ${text}`);
    } finally {
      el.remove();
    }
  });

  return { passed, failed, errors };
}

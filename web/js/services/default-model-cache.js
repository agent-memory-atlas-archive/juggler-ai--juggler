//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client-side cache of the model a new conversation would be seeded with
 * (`GET /api/default-model` — the user's explicit default, or the server's
 * preferred available provider when they have none).
 *
 * The server owns that resolution and there is no push for it, so this is a
 * pull with an in-memory copy behind a synchronous `get()` for render paths.
 * Displays read it as a last resort — what to show when nothing on screen names
 * a provider — never to decide what to send: a conversation's model is captured
 * at creation and nothing here retargets it.
 *
 * `refresh()` is debounced to one live call per REFRESH_INTERVAL_MS and de-dupes
 * concurrent callers, because the endpoint waits out provider discovery at
 * startup and is therefore not free. A change made in Settings is picked up on
 * the next interval rather than announced, which is the whole reason the
 * interval is minutes and not hours.
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/** @typedef {{ provider: string, model: string, thinking?: string, serviceTier?: string, explicit: boolean }} DefaultModel */

/** Minimum gap between live lookups. */
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

/** Gap applied instead when the last lookup failed or named no provider. */
const RETRY_INTERVAL_MS = 15 * 1000;

/** @type {DefaultModel|null} */
let _cache = null;
let _nextFetch = 0;
/** @type {Promise<DefaultModel|null>|null} */
let _inFlight = null;

const defaultModelCache = {
  /**
   * The cached default, or null before the first successful lookup.
   * @returns {DefaultModel|null} The default model ref.
   */
  get() {
    return _cache;
  },

  /**
   * Drop the cached value and the debounce with it, so the next {@link refresh}
   * goes to the server. Call it after writing a new default: displays reading
   * this would otherwise show the old provider until the interval elapsed.
   * @returns {void}
   */
  invalidate() {
    _cache = null;
    _nextFetch = 0;
  },

  /**
   * Look the default up, debounced. Never rejects — on failure it resolves with
   * the previous value, or null if there isn't one.
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<DefaultModel|null>} The cached default.
   */
  async refresh({ force = false } = {}) {
    if (!force && Date.now() < _nextFetch) return _cache;
    if (_inFlight) return _inFlight;

    _inFlight = (async () => {
      try {
        const data = await fetchJson(apiUrl('/default-model'), { fallback: null });
        if (data && typeof data.provider === 'string') {
          _cache = {
            provider: data.provider,
            model: typeof data.model === 'string' ? data.model : '',
            explicit: data.explicit === true,
          };
          if (data.thinking) _cache.thinking = String(data.thinking);
          if (data.serviceTier) _cache.serviceTier = String(data.serviceTier);
        }
        // A blank provider means no provider is usable yet (discovery still
        // running, or nothing configured); ask again soon rather than sitting on
        // the answer for the full interval.
        const healthy = !!_cache?.provider;
        _nextFetch = Date.now() + (healthy ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS);
        return _cache;
      } finally {
        _inFlight = null;
      }
    })();
    return _inFlight;
  },
};

export default defaultModelCache;

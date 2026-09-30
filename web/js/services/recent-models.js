//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Recently-used concrete models for quick re-access from the model selector.
 * Most-recent first, deduped by provider+model+thinking+serviceTier (the same
 * model at two thinking levels, or at two serving tiers, is two distinct
 * entries), capped at MAX. An absent `thinking` means the model's default
 * level; an absent `serviceTier` means standard serving. Both dials are stored
 * because an entry is re-applied verbatim — one recorded without its tier would
 * quietly re-select standard serving for a model the user is paying a premium
 * to run.
 *
 * Persisted SERVER-SIDE (GET/POST /api/recent-models), not in browser
 * localStorage: localStorage is partitioned by origin (including port), so an
 * app relaunch that lands the spawned server on a different port would reset
 * it. Server-side storage survives both. The persisted list is independent of
 * current provider availability; callers use {@link getAvailable} when building
 * selectable UI.
 *
 * An in-memory cache backs the synchronous `get()` the model selector needs at
 * render time; `refresh()` repopulates it from the server (call it when opening
 * the menu), and `record()` updates it optimistically before POSTing.
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

const MAX = 6;

/** @typedef {{ provider: string, model: string, thinking?: string, serviceTier?: string }} RecentModel */

/** @type {RecentModel[]} */
let _cache = [];

/**
 * Build an entry with each dial present only when it is set, so an absent key
 * is the neutral setting rather than an empty string — the same shape
 * `buildModelConfig` stores.
 * @param {string} provider
 * @param {string} model
 * @param {string} [thinking]
 * @param {string} [serviceTier]
 * @returns {RecentModel} The entry.
 */
function entryOf(provider, model, thinking, serviceTier) {
  /** @type {RecentModel} */
  const entry = { provider, model };
  if (thinking) entry.thinking = thinking;
  if (serviceTier) entry.serviceTier = serviceTier;
  return entry;
}

/**
 * @param {unknown} data
 * @returns {RecentModel[]} Sanitised, capped list.
 */
function sanitize(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter(x => x && typeof x.provider === 'string' && typeof x.model === 'string')
    .map(x => entryOf(
      x.provider,
      x.model,
      typeof x.thinking === 'string' ? x.thinking : '',
      typeof x.serviceTier === 'string' ? x.serviceTier : '',
    ))
    .slice(0, MAX);
}

const recentModels = {
  /**
   * Recently-used models, most-recent first, from the in-memory cache.
   * Synchronous so it can be read during render; call {@link refresh} to
   * repopulate from the server first.
   * @returns {RecentModel[]} Cached recent models.
   */
  get() {
    return _cache;
  },

  /**
   * Cached recent models whose provider and model are present in the supplied
   * provider snapshot. Unavailable providers are excluded because these entries
   * back selection UI rather than history display — and so are models the user
   * has hidden, so ⌥⌘M cycling and the Recent list never land on one.
   * @param {Array<{name: string, available: boolean, modelsWithContext?: Array<{id: string, hidden?: boolean}>}>} providers
   * @returns {RecentModel[]} Selectable recent models.
   */
  getAvailable(providers) {
    const available = new Map(providers
      .filter(provider => provider.available)
      .map(provider => [provider.name, new Set((provider.modelsWithContext || [])
        .filter(model => !model.hidden)
        .map(model => model.id))]));
    return _cache.filter(entry => available.get(entry.provider)?.has(entry.model));
  },

  /**
   * Reload the list from the server into the in-memory cache.
   * @returns {Promise<RecentModel[]>} The refreshed list (also cached).
   */
  async refresh() {
    // Network/parse failure — keep the existing cache; recents are best-effort
    // convenience state.
    const data = await fetchJson(apiUrl('/recent-models'), { fallback: null });
    if (data) _cache = sanitize(data.models);
    return _cache;
  },

  /**
   * Record a concrete model selection, moving it to the front. Entries dedupe
   * by provider+model+thinking+serviceTier. Updates the cache optimistically,
   * then persists to the server.
   * @param {string} provider
   * @param {string} model
   * @param {string} [thinking] Canonical thinking level; absent/empty means
   *   the model's default level.
   * @param {string} [serviceTier] Advertised tier id; absent/empty means
   *   standard serving.
   * @returns {Promise<void>}
   */
  async record(provider, model, thinking, serviceTier) {
    if (!provider || !model) return;
    const entry = entryOf(provider, model, thinking, serviceTier);
    _cache = [entry, ..._cache.filter(x =>
      !(x.provider === provider && x.model === model
        && (x.thinking || '') === (thinking || '')
        && (x.serviceTier || '') === (serviceTier || '')))].slice(0, MAX);
    // Best-effort persistence; the optimistic cache update already reflects the
    // pick for this session.
    await fetchJson(apiUrl('/recent-models'), { method: 'POST', body: entry, fallback: null });
  },
};

export default recentModels;

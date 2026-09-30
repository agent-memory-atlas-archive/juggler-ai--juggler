//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Skills marketplace service — the client for the discover/install endpoints in
 * skills_registry.go. Sibling to skills.js (which stays read-only discovery of
 * already-installed skills). All catalog filtering is client-side over the cached
 * catalog, so this module only fetches the whole catalog (and forces refreshes),
 * fetches one entry for preview, installs, and uninstalls.
 *
 *   GET    /api/skills/catalog[?refresh=1]        → { entries, sources }
 *   GET    /api/skills/catalog/entry?source=&path= → { entry, body, files }
 *   POST   /api/skills/install                     → { installedPath, name, ... }
 *   DELETE /api/skills/{scope}/{source}/{name}     → uninstall
 *   GET    /api/skills/registries                  → source status
 *   POST   /api/skills/registries { url }          → add custom source
 *   DELETE /api/skills/registries/{id}             → remove custom source
 *
 * Every entry field is remote, attacker-controllable data — callers escape it in
 * the DOM and render bodies only through renderMarkdown(..., { escapeXml:true }).
 * @module services/skills-registry
 */

import { fetchJson, HttpError } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * @typedef {object} CatalogInstalled
 * @property {'user'|'project'} scope - Provenance scope of the install.
 * @property {'juggler'|'agents'} source - Root source of the install.
 * @property {string} path - Absolute installed directory
 * @property {boolean} upToDate - False when an update is available (dirSha differs)
 */

/**
 * @typedef {object} CatalogEntry
 * @property {string} id - "<source>:<path>"
 * @property {string} source - Source id
 * @property {string} path - Remote skill directory (the identity within a source)
 * @property {string} name - Slugified suggested install name
 * @property {boolean} slugged - True when name differs from the remote basename
 * @property {string[]} category - Path segments between skillsRoot and the skill dir
 * @property {string} description - Effective description from frontmatter.
 * @property {string} [license] - License name if declared.
 * @property {boolean} hasScripts - Whether the skill ships a scripts/ dir.
 * @property {boolean} hasHooks - Whether the skill ships a hooks/ dir.
 * @property {number} fileCount - Number of files in the skill dir.
 * @property {number} totalSize - Aggregate byte size (tree-reported).
 * @property {string} sourceUrl - Human 'View on GitHub' URL.
 * @property {string} ref - Configured ref (branch/tag/sha).
 * @property {string} commit - Resolved commit the catalog is pinned to.
 * @property {string} dirSha - The skill dir's tree sha (update signal).
 * @property {CatalogInstalled|null} installed - Local install info, or null.
 * @property {string} [error] - Error message, if any.
 */

/**
 * @typedef {object} CatalogSourceStatus
 * @property {string} id - Source id.
 * @property {string} label - Human-facing source name.
 * @property {string} repo - 'owner/name'.
 * @property {'official'|'community'|'custom'} trust - Trust tier.
 * @property {string} [fetchedAt] - Last fetch time (RFC3339), if cached.
 * @property {boolean} stale - Whether the cache is past its TTL.
 * @property {boolean} [truncated] - Whether the git tree was truncated.
 * @property {number} entryCount - Number of skills discovered.
 * @property {string} [error] - Error message, if any.
 */

/**
 * @typedef {object} CatalogResponse
 * @property {CatalogEntry[]} entries - Every source's entries merged.
 * @property {CatalogSourceStatus[]} sources - Per-source fetch status.
 */

/** @type {CatalogResponse|null} */
let cachedCatalog = null;

/**
 * Fetch the merged catalog across all sources. Cached in-memory after the first
 * call; pass `force` to bypass the memory cache, and `refresh` to make the
 * backend re-fetch from the registries (network) rather than serve its disk cache.
 * @param {{ force?: boolean, refresh?: boolean }} [opts]
 * @returns {Promise<CatalogResponse>} The merged catalog and per-source status.
 */
export async function fetchCatalog({ force = false, refresh = false } = {}) {
  if (cachedCatalog && !force && !refresh) {
    return cachedCatalog;
  }
  const url = refresh ? apiUrl('/skills/catalog?refresh=1') : apiUrl('/skills/catalog');
  const data = await fetchJson(url, { errorPrefix: 'Failed to load skill catalog' });
  cachedCatalog = {
    entries: Array.isArray(data?.entries) ? data.entries : [],
    sources: Array.isArray(data?.sources) ? data.sources : [],
  };
  return cachedCatalog;
}

/** Drop the in-memory catalog cache (e.g. after add/remove source or install). */
export function resetCatalogCache() {
  cachedCatalog = null;
}

/**
 * Fetch one entry's SKILL.md body and file manifest for the preview drawer.
 * @param {string} source - Source id
 * @param {string} path - Remote skill directory
 * @returns {Promise<{ entry: CatalogEntry, body: string, files: Array<{path:string,size:number,runs:boolean}> }>} The entry, its SKILL.md body, and file manifest.
 */
export async function fetchCatalogEntry(source, path) {
  const url = apiUrl(`/skills/catalog/entry?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`);
  return await fetchJson(url, { errorPrefix: 'Failed to load skill preview' });
}

/**
 * Install a skill into a local root. Resolves to the backend result on success;
 * on a name collision the backend returns 409 — this surfaces it as a typed
 * error the caller can branch on (`err.collision === true`).
 * @param {object} req
 * @param {string} req.source - Source id
 * @param {string} req.path - Remote skill directory
 * @param {string} req.targetName - Confirmed, valid install name
 * @param {'user'|'project'} req.scope
 * @param {'juggler'|'agents'} req.target - Root source
 * @param {'install'|'overwrite'} [req.mode]
 * @returns {Promise<{ installedPath: string, name: string, scope: string, source: string }>} The installed location.
 */
export async function installSkill(req) {
  let result;
  try {
    result = await fetchJson(apiUrl('/skills/install'), {
      method: 'POST',
      body: { mode: 'install', ...req },
      errorPrefix: 'Install failed',
    });
  } catch (err) {
    // 409 is the name-collision answer, not a transport failure: re-shape it
    // into the typed error the install flow branches on.
    if (err instanceof HttpError && err.status === 409) {
      const body = err.body && typeof err.body === 'object' ? err.body : {};
      const collision = new Error(body.error || 'A skill with that name already exists');
      /** @type {any} */ (collision).collision = true;
      /** @type {any} */ (collision).existing = body.existing;
      throw collision;
    }
    throw err;
  }
  resetCatalogCache();
  return result;
}

/**
 * Uninstall a skill from a managed root (works on any skill there, not only
 * marketplace installs).
 * @param {'user'|'project'} scope
 * @param {'juggler'|'agents'} source
 * @param {string} name
 * @returns {Promise<void>} Resolves once removed.
 */
export async function uninstallSkill(scope, source, name) {
  const url = apiUrl(`/skills/${encodeURIComponent(scope)}/${encodeURIComponent(source)}/${encodeURIComponent(name)}`);
  await fetchJson(url, { method: 'DELETE', errorPrefix: 'Uninstall failed' });
  resetCatalogCache();
}

/**
 * Add a custom source from a github.com URL or "owner/repo".
 * @param {string} url
 * @param {string} [label]
 * @returns {Promise<CatalogSourceStatus>} The added source status.
 */
export async function addSource(url, label) {
  const source = await fetchJson(apiUrl('/skills/registries'), {
    method: 'POST',
    body: { url, label },
    errorPrefix: 'Could not add source',
  });
  resetCatalogCache();
  return source;
}

/**
 * Fetch the seed sources a fresh install starts with, so the add-source menu can
 * offer to restore any that were removed.
 * @returns {Promise<Array<{id:string,label:string,repo:string,trust:string}>>} The default sources.
 */
export async function fetchDefaultSources() {
  return await fetchJson(apiUrl('/skills/registries/defaults'), {
    errorPrefix: 'Could not load default sources',
  });
}

/**
 * Restore a default source by its seed id, re-adding the exact curated definition
 * (label, trust) rather than a generic custom source.
 * @param {string} id
 * @returns {Promise<{id:string,label:string,repo:string,trust:string}>} The restored source.
 */
export async function restoreDefaultSource(id) {
  const source = await fetchJson(apiUrl(`/skills/registries/defaults/${encodeURIComponent(id)}`), {
    method: 'POST',
    errorPrefix: 'Could not add source',
  });
  resetCatalogCache();
  return source;
}

/**
 * Remove a source by id. All sources are equal — seeded defaults are removable
 * too, and the removal persists (a removed seed is not re-added).
 * @param {string} id
 * @returns {Promise<void>} Resolves once removed.
 */
export async function removeSource(id) {
  await fetchJson(apiUrl(`/skills/registries/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    errorPrefix: 'Could not remove source',
  });
  resetCatalogCache();
}

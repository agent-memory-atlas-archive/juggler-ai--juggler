//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { escapeHtml } from '../../sdk/lib/html.js';

/** Usage snapshots older than this are stale. */
export const USAGE_STALE_MS = 5 * 60 * 1000;

/**
 * Human-friendly "resets in …" string from an ISO reset timestamp.
 * @param {string|undefined} resetsAt
 * @returns {string} e.g. "Resets in 3h 12m", or '' when unknown.
 */
export function formatResetIn(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Resets now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `Resets in ${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `Resets in ${days}d ${hours % 24}h`;
}

/**
 * Title-case a plan label ("pro" → "Pro").
 * @param {string} plan
 * @returns {string} Title-cased plan label.
 */
export function formatPlan(plan) {
  if (!plan) return '';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * Whether a usage snapshot is older than {@link USAGE_STALE_MS}.
 * A missing or invalid timestamp is treated as fresh.
 * @param {import('../services/usage-stats-cache.js').UsageStats} usage
 * @returns {boolean} True when the snapshot is older than the stale window.
 */
export function isUsageStale(usage) {
  if (!usage || !usage.updatedAt) return false;
  const age = Date.now() - new Date(usage.updatedAt).getTime();
  return age >= USAGE_STALE_MS;
}

/**
 * Smallest elapsed fraction the pace calculation will divide by, as a
 * percentage. Inside the opening stretch of a window a single large turn is many
 * times the average rate, and a meter that opened red every window would say
 * nothing; flooring the divisor means the first quarter warns only when the
 * burst is large enough to exhaust the quota on its own.
 */
const PACE_FLOOR_PCT = 25;

/** Fraction of the exhausting rate at which a meter starts to warn. */
const PACE_WARN = 0.8;

/**
 * How far through its window a stat is.
 * @param {import('../services/usage-stats-cache.js').UsageStat} stat
 * @returns {number|null} Elapsed percentage, 0-100, or null when the stat
 *   carries no window (a balance, or a provider that reports no reset).
 */
function elapsedPercent(stat) {
  const windowSecs = Number(stat.windowSecs) || 0;
  if (!stat.resetsAt || windowSecs <= 0) return null;
  const windowMs = windowSecs * 1000;
  const msElapsed = windowMs - (new Date(stat.resetsAt).getTime() - Date.now());
  if (!Number.isFinite(msElapsed)) return null;
  return Math.max(0, Math.min(100, msElapsed / windowMs * 100));
}

/**
 * Warning level for a meter. What matters is not how much of the quota is gone
 * but whether it is going faster than the clock: usage level with the elapsed
 * fraction — the tick — is on course to run the quota out exactly at the reset,
 * so that is the red line, and {@link PACE_WARN} of the way there is the
 * warning. A stat with no window has no pace to judge, and falls back to
 * absolute thresholds.
 * @param {number} pct - Percentage of the quota used, 0-100.
 * @param {number|null} timePct - Percentage of the window elapsed, or null.
 * @returns {string} A modifier class for `.usage-stat-fill`, or '' for none.
 */
function usageLevel(pct, timePct) {
  if (timePct === null) return pct > 80 ? 'usage-high' : (pct > 60 ? 'usage-medium' : '');
  const pace = pct / Math.max(timePct, PACE_FLOOR_PCT);
  return pace >= 1 ? 'usage-high' : (pace >= PACE_WARN ? 'usage-medium' : '');
}

/**
 * Render one usage signal. A stat with a percentage renders as a labelled meter;
 * one without (for example, a raw balance) renders its absolute value instead.
 * @param {import('../services/usage-stats-cache.js').UsageStat} stat
 * @returns {string} HTML for one `.usage-stat` row.
 */
export function renderUsageRow(stat) {
  const reset = formatResetIn(stat.resetsAt);
  const resetRow = reset ? `<div class="usage-stat-reset">${escapeHtml(reset)}</div>` : '';
  const detail = stat.detail ? escapeHtml(stat.detail) : '';

  const hasPct = stat.usedPercent !== null && stat.usedPercent !== undefined
    && Number.isFinite(Number(stat.usedPercent));
  if (!hasPct) {
    return `
            <div class="usage-stat usage-stat-value">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${detail || '—'}</span>
                </div>
                ${resetRow}
            </div>`;
  }

  const pct = Math.max(0, Math.min(100, Number(stat.usedPercent) || 0));
  const timePct = elapsedPercent(stat);
  const level = usageLevel(pct, timePct);
  const timeMarker = timePct === null ? ''
    : `<div class="usage-stat-time-marker" style="left:${timePct.toFixed(1)}%" aria-hidden="true"></div>`;

  return `
            <div class="usage-stat">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${Math.round(pct)}%</span>
                </div>
                <div class="usage-stat-bar-wrap">
                    <div class="usage-stat-bar">
                        <div class="usage-stat-fill ${level}" style="width: ${pct}%;"></div>
                    </div>
                    ${timeMarker}
                </div>
                ${detail ? `<div class="usage-stat-detail">${detail}</div>` : ''}
                ${resetRow}
            </div>`;
}

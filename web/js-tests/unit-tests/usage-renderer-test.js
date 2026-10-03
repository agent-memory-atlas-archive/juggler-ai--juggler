//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * usage-renderer meter-colour tests.
 *
 * A meter warns about PACE, not about how much of the quota is gone. A bar at or
 * behind the tick (the elapsed fraction of the window) is on course to last, so
 * it never warns. Past the tick, the overshoot is weighed against the time left
 * to absorb it: the colour follows the share of the average rate the rest of the
 * window can still afford, so ten points over reads mildly a third of the way in
 * and urgently near the end. A stat with no window has nothing to pace against
 * and keeps absolute thresholds. `Date.now` is stubbed so boundary ratios land
 * exactly rather than drifting by the test's runtime.
 * @module unit-tests/usage-renderer-test
 */

import { renderUsageRow } from '../../js/utils/usage-renderer.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** Fixed instant for the stubbed clock. */
const NOW = Date.parse('2026-01-01T12:00:00Z');

/** Window length every windowed case uses, in seconds. */
const WINDOW_SECS = 3600;

/**
 * Build a usage stat whose window is `elapsed` percent through.
 * @param {number} usedPercent - Percentage of the quota consumed.
 * @param {number|null} elapsed - Percentage of the window elapsed, or null for a
 *   stat with no window at all.
 * @returns {import('../../js/services/usage-stats-cache.js').UsageStat} The stat.
 */
function stat(usedPercent, elapsed) {
  if (elapsed === null) return /** @type {any} */ ({ name: 'Session', usedPercent });
  const remainingMs = WINDOW_SECS * 1000 * (1 - elapsed / 100);
  return /** @type {any} */ ({
    name: 'Session',
    usedPercent,
    windowSecs: WINDOW_SECS,
    resetsAt: new Date(NOW + remainingMs).toISOString()
  });
}

/**
 * Render a stat and report the warning level its fill carries.
 * @param {import('../../js/services/usage-stats-cache.js').UsageStat} s - Stat.
 * @returns {string|null} 'usage-high', 'usage-medium', '' for the plain fill, or
 *   null when the row rendered no meter at all.
 */
function levelOf(s) {
  const host = document.createElement('div');
  host.innerHTML = renderUsageRow(s);
  const fill = host.querySelector('.usage-stat-fill');
  if (!fill) return null;
  if (fill.classList.contains('usage-high')) return 'usage-high';
  if (fill.classList.contains('usage-medium')) return 'usage-medium';
  return '';
}

/** @type {Array<{used: number, elapsed: number|null, want: string, why: string}>} */
const CASES = [
  // No window: nothing to pace against, so absolute thresholds stand.
  { used: 50, elapsed: null, want: '', why: 'no window, under 60%' },
  { used: 70, elapsed: null, want: 'usage-medium', why: 'no window, over 60%' },
  { used: 90, elapsed: null, want: 'usage-high', why: 'no window, over 80%' },

  // At or behind the tick never warns: the quota lasts at the average rate.
  { used: 30, elapsed: 50, want: '', why: 'well behind the tick' },
  { used: 50, elapsed: 50, want: '', why: 'level with the tick' },
  { used: 85, elapsed: 90, want: '', why: 'over 80% but still short of the tick' },

  // Past the tick, the overshoot is weighed against the time left to absorb it.
  { used: 55, elapsed: 50, want: 'usage-medium', why: 'nine tenths of the rate left for half the window' },
  { used: 60, elapsed: 50, want: 'usage-medium', why: 'eight tenths of the rate left' },
  { used: 65, elapsed: 50, want: 'usage-high', why: 'seven tenths of the rate left' },

  // Early in the window the same overshoot matters less: there is time to absorb it.
  { used: 30, elapsed: 30, want: '', why: 'level with the tick a third of the way in' },
  { used: 40, elapsed: 30, want: 'usage-medium', why: 'ten points over with most of the window left' },
  { used: 25, elapsed: 10, want: 'usage-medium', why: 'fifteen points over a tenth of the way in' },
  { used: 33, elapsed: 10, want: 'usage-high', why: 'a third of the quota gone a tenth of the way in' },
  { used: 30, elapsed: 1, want: 'usage-high', why: 'a big burst almost immediately' },

  // Late in the window a small overshoot matters more: there is little time left.
  { used: 83, elapsed: 80, want: 'usage-medium', why: 'three points over with a fifth of the window left' },
  { used: 93, elapsed: 90, want: 'usage-high', why: 'three points over with a tenth of the window left' },

  // Ends of the range.
  { used: 0, elapsed: 50, want: '', why: 'nothing used' },
  { used: 100, elapsed: 50, want: 'usage-high', why: 'exhausted mid-window' },
  { used: 100, elapsed: 100, want: 'usage-high', why: 'exhausted as the window closes' },
  { used: 99, elapsed: 100, want: '', why: 'quota left as the window closes' }
];

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const origNow = Date.now;
  Date.now = () => NOW;
  try {
    for (const c of CASES) {
      const got = levelOf(stat(c.used, c.elapsed));
      if (got === c.want) {
        passed++;
      } else {
        failed++;
        const where = c.elapsed === null ? 'no window' : `${c.elapsed}% elapsed`;
        errors.push(`${c.used}% used, ${where}: level "${got}", want "${c.want}" (${c.why})`);
      }
    }

    // The tick still marks the elapsed fraction the colour is judged against.
    const host = document.createElement('div');
    host.innerHTML = renderUsageRow(stat(40, 50));
    const marker = /** @type {HTMLElement|null} */ (host.querySelector('.usage-stat-time-marker'));
    const left = marker ? parseFloat(marker.style.left) : NaN;
    if (left === 50) {
      passed++;
    } else {
      failed++;
      errors.push(`time marker at "${marker ? marker.style.left : 'absent'}", want 50%`);
    }

    // A stat with no percentage renders its value, not a meter.
    const valueRow = renderUsageRow(/** @type {any} */ ({ name: 'Balance', detail: '$4.20' }));
    if (valueRow.includes('usage-stat-value') && !valueRow.includes('usage-stat-fill')) {
      passed++;
    } else {
      failed++;
      errors.push('a stat with no percentage should render a value row, not a meter');
    }
  } finally {
    Date.now = origNow;
  }

  return { passed, failed, errors };
}

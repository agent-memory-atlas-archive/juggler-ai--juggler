//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * usage-renderer meter-colour tests.
 *
 * A meter warns about PACE, not about how much of the quota is gone: the colour
 * is driven by usage measured against the elapsed fraction of the window — the
 * same figure the tick marker sits at — so a bar level with the tick is on
 * course to exhaust the quota exactly at the reset. That divisor is floored, so
 * the opening stretch of a window (where one large turn is many times the
 * average rate) does not read as a runaway. A stat with no window has nothing to
 * pace against and keeps absolute thresholds. These cases pin all three rules,
 * including ones where pace and absolute usage disagree; `Date.now` is stubbed
 * so boundary ratios land exactly rather than drifting by the test's runtime.
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

  // Level with the tick is the red line: that rate exhausts the quota at reset.
  { used: 30, elapsed: 50, want: '', why: 'well behind the tick' },
  { used: 40, elapsed: 50, want: 'usage-medium', why: 'eight tenths of the way to the tick' },
  { used: 50, elapsed: 50, want: 'usage-high', why: 'level with the tick' },
  { used: 65, elapsed: 50, want: 'usage-high', why: 'past the tick' },

  // Where pace and absolute usage disagree, pace wins — both ways.
  { used: 70, elapsed: 90, want: '', why: 'over 60% but comfortably behind the tick' },
  { used: 85, elapsed: 90, want: 'usage-medium', why: 'over 80% but still short of the tick' },
  { used: 30, elapsed: 30, want: 'usage-high', why: 'under 60% but level with the tick' },

  // The floored divisor: a burst in the opening stretch is not a runaway.
  { used: 15, elapsed: 5, want: '', why: 'three times the instantaneous rate, damped by the floor' },
  { used: 20, elapsed: 10, want: 'usage-medium', why: 'a fifth of the quota inside the floor' },
  { used: 25, elapsed: 1, want: 'usage-high', why: 'a quarter of the quota gone almost immediately' },

  // Ends of the range.
  { used: 0, elapsed: 50, want: '', why: 'nothing used' },
  { used: 100, elapsed: 100, want: 'usage-high', why: 'exhausted as the window closes' }
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

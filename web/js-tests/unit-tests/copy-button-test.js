//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the shared copy button's "Copied" bubble.
 *
 * The property under test: ANY button made by `createCopyButton` shows the
 * bubble while it carries `.copied`, whatever class its caller gave it, and the
 * bubble has a positioned anchor. A copy button must not need its class added
 * to a list in some stylesheet to get its confirmation — a button whose class
 * is on no list is exactly the one a new surface would build.
 * @module unit-tests/copy-button-test
 */

import { createCopyButton } from '../../sdk/lib/copy-button.js';

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Run the copy-button test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  const errors = [];
  let passed = 0;
  let total = 0;

  // The default, the class the transaction view passes, and one no sheet names.
  const classNames = [undefined, 'properties-panel-header-icon-btn tx-row-copy', 'some-future-copy-button'];

  for (const className of classNames) {
    const label = className ?? '(default class)';
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const btn = createCopyButton('text', className);
      host.appendChild(btn);
      btn.classList.add('copied');

      total++;
      passed += check(getComputedStyle(btn, '::after').content === '"Copied"',
        `${label}: a .copied copy button shows no "Copied" bubble (::after content is ${getComputedStyle(btn, '::after').content})`, errors);

      total++;
      passed += check(getComputedStyle(btn).position !== 'static',
        `${label}: the button is position: static, so its absolutely placed bubble anchors to some ancestor instead`, errors);
    } finally {
      host.remove();
    }
  }

  return { passed, failed: total - passed, errors };
}

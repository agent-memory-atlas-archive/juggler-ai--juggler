//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: how a thinking row presents itself in the transcript.
 *
 * A short thinking block is usually a sentence or two addressed as much to the
 * user as to the model, so the row shows its text inline — no icon, no badge —
 * in the space a summary line would take anyway. A long one is reasoning the
 * user rarely wants in the transcript, so it collapses to the "Thinking · N
 * tokens" summary and its text waits in the properties panel. A block that
 * streams past the threshold switches from the first to the second.
 *
 * Inline text follows the properties panel's rule for reasoning: Markdown when
 * a construct is actually present (Claude's summaries carry bold titles and
 * code spans), verbatim otherwise (raw chain-of-thought, where `*` is
 * arithmetic and `_` is part of an identifier).
 * @module unit-tests/thinking-message-test
 */

import { assert } from '../utilities/test-helpers.js';
import { SHORT_THINKING_TOKENS } from '../../js/components/thinking-message.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
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
   * Mount a thinking row seeded with some content.
   * @param {string} content - The seed content attribute.
   * @returns {any} The connected element.
   */
  const mount = (content) => {
    const el = /** @type {any} */ (document.createElement('thinking-message'));
    el.setAttribute('message-id', 'think-1');
    el.setAttribute('content', content);
    document.body.appendChild(el);
    return el;
  };

  /**
   * A fake Yjs item carrying the given content.
   * @param {string} content - Accumulated content.
   * @returns {{get: (k: string) => any}} Fake item.
   */
  const itemWith = (content) => ({ get: (k) => (k === 'content' ? content : undefined) });

  // Characters per token, as the row estimates it.
  const CHARS = 4;

  await run('a short block shows its text inline, with no icon or badge', () => {
    const text = 'Let me check the config loader before touching the parser.';
    const el = mount(text);
    try {
      const article = el.querySelector('article.thinking');
      assert(!!article, 'the row renders an article.thinking');
      assert(article.classList.contains('thinking-inline'), 'a short block is marked inline for styling');
      assert(!el.querySelector('.message-icon-box'), 'an inline block has no icon');
      assert(!el.querySelector('.context-item-type-badge'), 'an inline block has no badge');
      assert(!el.querySelector('.thinking-summary'), 'an inline block has no token summary');
      assert(article.textContent.trim() === text, `expected the text itself, got "${article.textContent.trim()}"`);
      assert(!!el.querySelector('.llm-description'),
        'the text takes the shared style for LLM-written descriptions');
    } finally { el.remove(); }
  });

  await run('an inline block that carries Markdown is rendered as Markdown', () => {
    const el = mount('**Checking the loader**\n\nThe `parse` call comes first.');
    try {
      assert(!!el.querySelector('article.thinking-inline strong'), 'the bold title renders as a title');
      assert(!!el.querySelector('article.thinking-inline code'), 'inline code renders as code');
      assert(!el.textContent.includes('**'), 'the markers are consumed, not shown');
    } finally { el.remove(); }
  });

  await run('a long block collapses to the token summary with its icon', () => {
    const el = mount('x'.repeat(SHORT_THINKING_TOKENS * CHARS + CHARS));
    try {
      const article = el.querySelector('article.thinking');
      assert(!article.classList.contains('thinking-inline'), 'a long block is not inline');
      assert(!!el.querySelector('.message-icon-box'), 'a long block keeps its icon');
      const span = el.querySelector('.thinking-summary');
      assert(!!span && /^Thinking · \d+ tokens$/.test(span.textContent), `expected a summary, got "${span && span.textContent}"`);
    } finally { el.remove(); }
  });

  await run('a block streaming past the threshold switches to the summary', () => {
    const el = mount('Starting.');
    try {
      el.updateFromItem(itemWith('Starting. Looking at the loader.'));
      assert(el.querySelector('article.thinking-inline')?.textContent.includes('Looking at the loader'),
        'while short, the streamed text is shown inline');

      el.updateFromItem(itemWith('y'.repeat(SHORT_THINKING_TOKENS * CHARS * 2)));
      assert(!el.querySelector('article.thinking-inline'), 'past the threshold the row stops being inline');
      assert(!!el.querySelector('.thinking-summary'), 'past the threshold the row shows the summary');
    } finally { el.remove(); }
  });

  await run('inline reasoning is shown verbatim, not parsed as Markdown', () => {
    const raw = 'Weighing 2 * 3 against foo_bar_baz first.';
    const el = mount(raw);
    try {
      assert(!el.querySelector('em, strong'), 'no emphasis may be invented from stray punctuation');
      assert(el.querySelector('article.thinking').textContent.trim() === raw, 'the text arrives as written');
    } finally { el.remove(); }
  });

  return { passed, failed, errors };
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * computeDiff tests.
 *
 * The diff viewer renders a hunk's lines in array order, so `computeDiff`
 * (web/js/lib/diff-utils.js) owns the order the user reads. The invariant that
 * matters: walking a hunk and keeping everything that is not a '-' must
 * reproduce the new file verbatim from `newStart`, and everything that is not
 * a '+' must reproduce the old file from `oldStart`. Changes closer together
 * than the context width are where that is easiest to get wrong.
 * @module unit-tests/diff-utils-test
 */

import { computeDiff } from '../../js/lib/diff-utils.js';
import { assert } from '../utilities/test-helpers.js';

/** @typedef {import('../../js/lib/diff-types.js').DiffHunk} DiffHunk */

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** Old side of an edit that inserts five lines at three nearby points. */
const OLD_TEXT = [
  'class PlayableTests(TestCase):',
  '    def test_playable(self):',
  '        playable = Playable.objects.create(',
  '            slug="demo",',
  '            game=self.game,',
  '            template="instead",',
  '        )',
  '',
  '        self.assertEqual(str(playable), "demo")',
  '        self.assertEqual(playable.template, "instead")',
  '        self.assertIsInstance(',
  '            Playable._meta.get_field("template"), models.SlugField',
  '        )',
  '        self.assertEqual(playable.config, {})',
  '        self.assertIsNotNone(playable.created)'
].join('\n');

/** New side: three insertions separated by one and by three context lines. */
const NEW_TEXT = [
  'class PlayableTests(TestCase):',
  '    def test_playable(self):',
  '        playable = Playable.objects.create(',
  '            slug="demo",',
  '            game=self.game,',
  '            template="instead",',
  '            template_version="1",',
  '        )',
  '',
  '        self.assertEqual(str(playable), "demo")',
  '        self.assertEqual(playable.template, "instead")',
  '        self.assertEqual(playable.template_version, "1")',
  '        self.assertIsInstance(',
  '            Playable._meta.get_field("template"), models.SlugField',
  '        )',
  '        self.assertIsInstance(',
  '            Playable._meta.get_field("template_version"), models.SlugField',
  '        )',
  '        self.assertEqual(playable.config, {})',
  '        self.assertIsNotNone(playable.created)'
].join('\n');

/**
 * Numbered lines, so a case can be described by which of them changed.
 * @param {number} count - How many lines to generate.
 * @returns {string[]} Lines 'l1'..'lN'.
 */
function lines(count) {
  return Array.from({ length: count }, (_, k) => `l${k + 1}`);
}

/**
 * Checks the invariants of one diff: each hunk's rows must reproduce both
 * sides contiguously from the hunk's declared start, its counts must match the
 * rows it holds, and line numbers must ascend down the hunk.
 * @param {string} oldText - Old file content.
 * @param {string} newText - New file content.
 * @param {string} why - Case description, used in failure messages.
 * @returns {void}
 */
function checkHunks(oldText, newText, why) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const computed = computeDiff(oldText, newText, 1);
  assert(computed !== null, `${why}: the diff was refused, and these cases are all well inside the budget`);
  const hunks = /** @type {DiffHunk[]} */ (computed);

  for (const hunk of hunks) {
    for (const [side, source, start, count, dropped] of /** @type {Array<[string, string[], number, number, string]>} */ ([
      ['old', oldLines, hunk.oldStart, hunk.oldCount, 'add'],
      ['new', newLines, hunk.newStart, hunk.newCount, 'remove']
    ])) {
      const rows = hunk.lines.filter(l => l.type !== dropped);
      assert(rows.length === count, `${why}: hunk ${side}Count ${count} but ${rows.length} ${side} rows`);
      rows.forEach((line, k) => {
        assert(source[start - 1 + k] === line.content,
          `${why}: ${side} row ${k} of hunk at ${start} is ${JSON.stringify(line.content)}, ` +
          `but ${side} line ${start + k} is ${JSON.stringify(source[start - 1 + k])} — rows are out of order`);
      });
    }

    let lastOld = 0;
    let lastNew = 0;
    for (const line of hunk.lines) {
      if (line.oldLineNum !== null) {
        assert(line.oldLineNum > lastOld, `${why}: old line numbers go backwards at ${JSON.stringify(line.content)}`);
        lastOld = line.oldLineNum;
      }
      if (line.newLineNum !== null) {
        assert(line.newLineNum > lastNew, `${why}: new line numbers go backwards at ${JSON.stringify(line.content)}`);
        lastNew = line.newLineNum;
      }
    }
  }
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} why - Case description.
   * @param {() => void} body - Assertions to run.
   * @returns {void}
   */
  const check = (why, body) => {
    try {
      body();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${why}: ${e?.message ?? e}`);
    }
  };

  // The reported case: an added line one context line after a previous change
  // was rendered ahead of the context that precedes it.
  check('nearby insertions keep file order', () => {
    const hunks = /** @type {DiffHunk[]} */ (computeDiff(OLD_TEXT, NEW_TEXT, 1));
    assert(hunks.length === 1, `expected one hunk, got ${hunks.length}`);
    const rendered = /** @type {DiffHunk} */ (hunks[0]).lines
      .map(l => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.content.trim()}`);
    const want = [
      ' slug="demo",',
      ' game=self.game,',
      ' template="instead",',
      '+template_version="1",',
      ' )',
      ' ',
      ' self.assertEqual(str(playable), "demo")',
      ' self.assertEqual(playable.template, "instead")',
      '+self.assertEqual(playable.template_version, "1")',
      ' self.assertIsInstance(',
      ' Playable._meta.get_field("template"), models.SlugField',
      ' )',
      '+self.assertIsInstance(',
      '+Playable._meta.get_field("template_version"), models.SlugField',
      '+)',
      ' self.assertEqual(playable.config, {})',
      ' self.assertIsNotNone(playable.created)'
    ];
    assert(rendered.join('\n') === want.join('\n'), `rows read:\n${rendered.join('\n')}\nwant:\n${want.join('\n')}`);
  });

  // What the budget is spent on is the region that differs, not the file it
  // sits in: the table is built between the last common leading line and the
  // first common trailing one.
  check('a small edit to a big file is diffed, not refused', () => {
    const before = lines(5000);
    const after = [...before];
    after[2500] = 'X';
    const computed = computeDiff(before.join('\n'), after.join('\n'), 1);
    assert(computed !== null, 'a one-line edit must be diffed however long the file is');
    const hunks = /** @type {DiffHunk[]} */ (computed);
    assert(hunks.length === 1, `expected one hunk, got ${hunks.length}`);
    const hunk = /** @type {DiffHunk} */ (hunks[0]);
    assert(hunk.oldStart === 2498 && hunk.newStart === 2498,
      `the hunk should open three lines above the change, got ${hunk.oldStart}/${hunk.newStart}`);
    assert(hunk.lines.length === 8, `expected the change and six context lines, got ${hunk.lines.length}`);
    const changed = hunk.lines.filter(line => line.type !== 'equal').map(line => `${line.type} ${line.content}`);
    assert(changed.join(', ') === 'remove l2501, add X', `expected one line replaced, got ${changed.join(', ')}`);
  });

  check('only the region that differs is charged to the budget', () => {
    const rewritten = (/** @type {string} */ tag) => Array.from({ length: 2100 }, (_, k) => `${tag} ${k}`).join('\n');
    assert(computeDiff(rewritten('was'), rewritten('now'), 1) === null,
      'two 2,100-line files sharing no line are past the budget and must be refused');
    const shared = lines(20000).join('\n');
    assert(computeDiff(`${shared}\n${rewritten('was')}`, `${shared}\n${rewritten('now')}`, 1) === null,
      'the same rewrite is still past the budget with 20,000 common lines above it');
    assert(computeDiff(`${shared}\nX`, `${shared}\nY`, 1) !== null,
      'one changed line under 20,000 common ones costs one cell, not four hundred million');
  });

  // Where the trim stops. Only the ends of a file are trimmed, so two changes
  // far apart leave every line between them inside the region and charged to
  // the budget, identical or not: a span of some two thousand lines between one
  // change and the next is refused, however little of it differs.
  check('the span between two distant changes is charged whole', () => {
    const before = lines(20000);
    const after = [...before];
    after[2000] = 'X';
    after[14000] = 'Y';
    assert(computeDiff(before.join('\n'), after.join('\n'), 1) === null,
      'two changes 12,000 lines apart put all 12,000 in the region');
    const near = [...before];
    near[2000] = 'X';
    near[2500] = 'Y';
    assert(computeDiff(before.join('\n'), near.join('\n'), 1) !== null,
      'two changes 500 lines apart stay well inside it');
  });

  const l = lines(20).join('\n');
  /** @type {Array<[string, string, string]>} */
  const cases = [
    ['the reported edit', OLD_TEXT, NEW_TEXT],
    ['changes one line apart', l, [...lines(20).slice(0, 5), 'X', 'l6', 'Y', ...lines(20).slice(6)].join('\n')],
    ['adjacent changes', l, [...lines(20).slice(0, 5), 'X', 'Y', ...lines(20).slice(5)].join('\n')],
    ['changes far apart', l, [...lines(20).slice(0, 3), 'X', ...lines(20).slice(3, 18), 'Y', ...lines(20).slice(18)].join('\n')],
    ['removal beside an addition', l, [...lines(20).slice(0, 5), 'X', ...lines(20).slice(7)].join('\n')],
    ['change at the first line', l, ['X', ...lines(20).slice(1)].join('\n')],
    ['change at the last line', l, [...lines(20).slice(0, 19), 'X'].join('\n')],
    ['insert at the very start', l, ['X', ...lines(20)].join('\n')],
    ['insert at the very end', l, [...lines(20), 'X'].join('\n')],
    ['every other line changed', l, lines(20).map((s, k) => (k % 2 ? 'X' + s : s)).join('\n')],
    ['no changes', l, l],
    ['one line changed deep in a big file', lines(5000).join('\n'), [...lines(5000).slice(0, 2500), 'X', ...lines(5000).slice(2501)].join('\n')],
    ['big file changed at its first line', lines(5000).join('\n'), ['X', ...lines(5000).slice(1)].join('\n')],
    ['big file changed at its last line', lines(5000).join('\n'), [...lines(5000).slice(0, 4999), 'X'].join('\n')],
    ['big file with a rewritten middle', lines(5000).join('\n'),
      [...lines(5000).slice(0, 2000), ...lines(300).map(s => `X${s}`), ...lines(5000).slice(2300)].join('\n')],
    ['from empty', '', lines(3).join('\n')],
    ['to empty', lines(3).join('\n'), '']
  ];

  for (const [why, oldText, newText] of cases) {
    check(why, () => checkHunks(oldText, newText, why));
    check(`${why} (reversed)`, () => checkHunks(newText, oldText, `${why} (reversed)`));
  }

  return { passed, failed, errors };
}

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

import { computeDiff, regroupHunks } from '../../js/lib/diff-utils.js';
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
 * @param {number} [contextLines=3] - Context width to diff at.
 * @returns {void}
 */
function checkHunks(oldText, newText, why, contextLines = 3) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const computed = computeDiff(oldText, newText, 1, contextLines);
  assert(computed !== null, `${why}: the diff was refused, and these cases are all well inside the budget`);
  const hunks = /** @type {DiffHunk[]} */ (computed);

  for (const hunk of hunks) {
    // A hunk shows at most `contextLines` unchanged lines either side of what it
    // is about. Interior context — lines between two changes close enough to
    // share a hunk — is exempt, since dropping those would split the hunk.
    if (hunk.lines.some((line) => line.type !== 'equal')) {
      const lead = hunk.lines.findIndex((line) => line.type !== 'equal');
      const lastChange = hunk.lines.reduce(
        (at, line, k) => (line.type === 'equal' ? at : k), -1);
      const trail = hunk.lines.length - 1 - lastChange;
      assert(lead <= contextLines,
        `${why}: hunk at ${hunk.oldStart} opens with ${lead} unchanged lines, more than the ${contextLines} asked for`);
      assert(trail <= contextLines,
        `${why}: hunk at ${hunk.oldStart} ends with ${trail} unchanged lines, more than the ${contextLines} asked for`);
    }

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

  // Every invariant above holds at every context width the viewer offers, and
  // the width is now the reader's to choose: a diff drawn at 0 or at whole-file
  // has to reproduce both sides as faithfully as one drawn at 3.
  for (const contextLines of [0, 1, 10, Infinity]) {
    for (const [why, oldText, newText] of cases) {
      const at = `${why} at context ${contextLines}`;
      check(at, () => checkHunks(oldText, newText, at, contextLines));
    }
  }

  check('context 0 shows the changes and nothing around them', () => {
    const hunks = /** @type {DiffHunk[]} */ (computeDiff(OLD_TEXT, NEW_TEXT, 1, 0));
    assert(hunks.length === 3, `the three insertions should stand as three hunks, got ${hunks.length}`);
    const equal = hunks.flatMap(h => h.lines).filter(line => line.type === 'equal');
    assert(equal.length === 0, `expected no unchanged lines, got ${equal.length}`);
    const added = hunks.flatMap(h => h.lines).filter(line => line.type === 'add');
    assert(added.length === 5, `all five added lines must still be shown, got ${added.length}`);
  });

  // A hunk holding only insertions has no old lines to start at, and git names
  // the old line it was inserted after — 0 when there is none. Reporting the
  // hunk's own first new line there instead would claim an old line the change
  // never touched, which only shows up once the context is narrow enough for a
  // hunk to hold no unchanged line at all.
  check('a pure insertion names the old line it follows', () => {
    const hunks = /** @type {DiffHunk[]} */ (computeDiff(OLD_TEXT, NEW_TEXT, 1, 0));
    const first = /** @type {DiffHunk} */ (hunks[0]);
    assert(first.oldCount === 0, `an insertion covers no old lines, got ${first.oldCount}`);
    assert(first.oldStart === 6, `expected the old line it follows (6), got ${first.oldStart}`);
    const fromNothing = /** @type {DiffHunk[]} */ (computeDiff('', 'one\ntwo', 1, 0));
    assert(/** @type {DiffHunk} */ (fromNothing[0]).oldStart === 0,
      `a file that did not exist has no old line to follow, got ${/** @type {DiffHunk} */ (fromNothing[0]).oldStart}`);
  });

  check('whole-file context draws the file as one hunk', () => {
    const hunks = /** @type {DiffHunk[]} */ (computeDiff(OLD_TEXT, NEW_TEXT, 1, Infinity));
    assert(hunks.length === 1, `expected one hunk, got ${hunks.length}`);
    const hunk = /** @type {DiffHunk} */ (hunks[0]);
    assert(hunk.oldStart === 1 && hunk.newStart === 1, `the hunk must open at line 1, got ${hunk.oldStart}/${hunk.newStart}`);
    assert(hunk.oldCount === 15 && hunk.newCount === 20,
      `expected the whole of both sides (15/20), got ${hunk.oldCount}/${hunk.newCount}`);
  });

  // Narrowing a patch the server already hunked. Each hunk is regrouped over its
  // own lines, which is exact because those lines are contiguous; lines either
  // side of the gap between two hunks are not, and regrouping across a gap would
  // invent a hunk spanning lines the patch never held.
  check('regroupHunks narrows a hunk it is given', () => {
    const wide = /** @type {DiffHunk[]} */ (computeDiff(OLD_TEXT, NEW_TEXT, 1, 3));
    assert(wide.length === 1, `the fixture should arrive as one hunk, got ${wide.length}`);
    const narrow = regroupHunks(wide, 0);
    assert(narrow.length === 3, `expected the hunk to split into three, got ${narrow.length}`);
    assert(narrow.flatMap(h => h.lines).every(line => line.type !== 'equal'),
      'no unchanged line survives a regroup at context 0');
    assert(narrow.flatMap(h => h.lines).filter(line => line.type === 'add').length === 5,
      'every added line survives a regroup');
  });

  check('regroupHunks keeps the heading and never widens', () => {
    const wide = /** @type {DiffHunk[]} */ (computeDiff(OLD_TEXT, NEW_TEXT, 1, 3));
    /** @type {DiffHunk} */ (wide[0]).heading = 'def test_playable';
    assert(/** @type {DiffHunk} */ (regroupHunks(wide, 1)[0]).heading === 'def test_playable',
      'the heading git gave the hunk belongs to the first of whatever it becomes');
    const asked = regroupHunks(wide, 99).flatMap(h => h.lines).length;
    assert(asked === /** @type {DiffHunk} */ (wide[0]).lines.length,
      'asking for more context than the patch holds cannot conjure lines it does not have');
    assert(regroupHunks([], 3).length === 0, 'nothing regroups to nothing');
  });

  return { passed, failed, errors };
}

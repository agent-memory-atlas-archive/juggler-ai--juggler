//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<diff-viewer>`'s two layouts, and the two things the reader can set.
 *
 * Three claims are pinned here. Pairing: in the two-column layout a line and the
 * line that replaced it are read ACROSS, and a side with no line for a row shows
 * that there is none rather than an empty line. Room: two columns are refused
 * where they will not fit, whatever the preference says, because the preference
 * is about how the reader likes diffs and not about how wide this one is. And
 * precedence: a viewer the reader has set for themselves stops following the
 * default, while one they have not follows it the moment it moves.
 * @module unit-tests/diff-split-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { SPLIT_MIN_REM } = await import('../../js/components/diff-viewer.js');
  const prefs = await import('../../js/utils/diff-view-prefs.js');

  const priorView = prefs.defaultDiffView();
  const priorContext = prefs.defaultDiffContext();

  /** @type {HTMLElement[]} */
  const mounted = [];

  /**
   * @param {string} label - Case name
   * @param {() => void} fn - Case body
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      while (mounted.length > 0) mounted.pop()?.remove();
      prefs.setDefaultDiffView(priorView);
      prefs.setDefaultDiffContext(priorContext);
    }
  };

  // The width the component refuses two columns below, taken from the component
  // and converted the way it converts it. Neither half of that is incidental: a
  // pixel count written here would be a different threshold on a zoomed page, and
  // a rem count written here would go stale the day the real one moved — leaving
  // cases that still pass while testing widths nobody chose.
  const threshold = SPLIT_MIN_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
  const wideEnough = Math.round(threshold * 1.5);
  const tooNarrow = Math.round(threshold / 2);

  /**
   * A viewer in a box of a stated width, in the document, so it can measure
   * itself. Lanes do not reliably paint, but they do lay out on demand, which is
   * all `clientWidth` needs.
   * @param {number} width - The box's width, in pixels.
   * @returns {any} The viewer.
   */
  const mountedViewer = (width) => {
    const host = document.createElement('div');
    host.style.width = `${width}px`;
    host.style.position = 'absolute';
    host.style.left = '-9999px';
    const el = document.createElement('diff-viewer');
    host.appendChild(el);
    document.body.appendChild(host);
    mounted.push(host);
    return /** @type {any} */ (el);
  };

  /**
   * A viewer filled BEFORE it is put in the document, which is the order its
   * hosts actually use — see `addDiffViewer` in utils/properties-panel-helpers.js,
   * which calls `setDiff` on a detached element and appends it afterwards. A
   * detached element has no width, so everything the first render decided from
   * width decided it from zero.
   * @param {number} width - The box's width, in pixels.
   * @returns {any} The viewer, drawn and then mounted.
   */
  const filledThenMounted = (width) => {
    const host = document.createElement('div');
    host.style.width = `${width}px`;
    host.style.position = 'absolute';
    host.style.left = '-9999px';
    const el = /** @type {any} */ (document.createElement('diff-viewer'));
    el.setDiff('a\nX', 'a\nY', '/src/main.js');
    host.appendChild(el);
    document.body.appendChild(host);
    mounted.push(host);
    return el;
  };

  /**
   * Each row of the two-column layout as "old|new". A side with no line for the
   * row reads as `∅`, which an EMPTY line must not: the difference between "there
   * is no line here" and "there is a blank line here" is most of what the layout
   * has to get right, and a failure that rendered both as nothing would hide it.
   * @param {HTMLElement} el - A rendered viewer.
   * @returns {string[]} The rows.
   */
  const pairs = (el) => [...el.querySelectorAll('.diff-row')].map((row) => {
    const text = (/** @type {string} */ side) => {
      const cell = row.querySelector(`.diff-line.${side}`);
      return cell ? (cell.querySelector('.line-content')?.textContent ?? '') : '∅';
    };
    return `${text('old')}|${text('new')}`;
  });

  /**
   * @param {HTMLElement} el - A rendered viewer.
   * @returns {number} How many unchanged lines it is showing.
   */
  const contextShown = (el) =>
    [...el.querySelectorAll('.diff-line.equal')].length;

  // Two lines becoming three. The first two pair off, and the third has nothing
  // on the old side because nothing there was replaced by it.
  run('two columns pair a replacement across the row', () => {
    prefs.setDefaultDiffView('split');
    const el = mountedViewer(wideEnough);
    el.setDiff('a\nX1\nX2\nb', 'a\nY1\nY2\nY3\nb', '/src/main.js');

    assert(el.dataset.view === 'split', `expected the split layout, got ${el.dataset.view}`);
    const got = pairs(el);
    const want = ['a|a', 'X1|Y1', 'X2|Y2', '∅|Y3', 'b|b'];
    assert(got.join(' / ') === want.join(' / '),
      `rows read:\n  ${got.join('\n  ')}\nwant:\n  ${want.join('\n  ')}`);
  });

  run('a side with no line for a row is not drawn as an empty line', () => {
    prefs.setDefaultDiffView('split');
    const el = mountedViewer(wideEnough);
    el.setDiff('a\nX1\nX2\nb', 'a\nY1\nY2\nY3\nb', '/src/main.js');

    const fillers = el.querySelectorAll('.diff-cell-filler');
    assert(fillers.length === 1, `expected one filler, got ${fillers.length}`);
    const filler = /** @type {HTMLElement} */ (fillers[0]);
    assert(filler.classList.contains('old'), 'the missing side here is the old one');
    assert(filler.textContent === '', `a filler holds nothing, got ${JSON.stringify(filler.textContent)}`);
    assert(filler.getAttribute('aria-hidden') === 'true',
      'there is no line there, so there is nothing to announce');
    assert(filler.querySelector('.line-num') === null, 'a line that does not exist has no number');
  });

  // An unchanged line is the same line in both files, so it is one row holding
  // itself twice — and both halves carry a number, which is what makes the two
  // gutters read as two files rather than one.
  run('an unchanged line is shown on both sides', () => {
    prefs.setDefaultDiffView('split');
    const el = mountedViewer(wideEnough);
    el.setDiff('a\nX', 'a\nY', '/src/main.js');

    const first = el.querySelector('.diff-row');
    const cells = first.querySelectorAll('.diff-line.equal');
    assert(cells.length === 2, `an unchanged row has both sides, got ${cells.length}`);
    const numbered = [...cells].map((c) => c.querySelector('.line-num').textContent);
    assert(numbered.join('/') === '1/1',
      `both halves of an unchanged row carry their own line number, got ${numbered.join('/')}`);
  });

  run('a viewer with no room for two columns does not use them', () => {
    prefs.setDefaultDiffView('split');
    const narrow = mountedViewer(tooNarrow);
    narrow.setDiff('a\nX', 'a\nY', '/src/main.js');

    assert(narrow.dataset.view === 'inline',
      `expected the combined layout in ${tooNarrow}px, got ${narrow.dataset.view}`);
    assert(narrow.querySelector('.diff-row') === null, 'no two-column rows were drawn');
  });

  run('the layout switch is offered where the layout fits', () => {
    const wide = mountedViewer(wideEnough);
    wide.setDiff('a\nX', 'a\nY', '/src/main.js');
    const buttons = wide.querySelectorAll('.diff-view-btn');
    assert(buttons.length === 2, `the switch offers both layouts, got ${buttons.length}`);
    assert([...buttons].every((/** @type {any} */ b) => !b.disabled),
      'where both layouts fit, both are offered');
    assert(wide.querySelector('.diff-view-btn[data-view="inline"]').getAttribute('aria-pressed') === 'true',
      'the combined layout is the one in force, and the switch says so');
    assert(wide.querySelector('.diff-view-switch').getAttribute('title') === null,
      'nothing needs explaining when nothing is being refused');
  });

  // Nobody clicks a control to be left where they are, so the button already in
  // force is a way back rather than a no-op.
  run('either button switches the layout, including the one in force', () => {
    const wide = mountedViewer(wideEnough);
    wide.setDiff('a\nX', 'a\nY', '/src/main.js');

    wide.querySelector('.diff-view-btn[data-view="split"]').click();
    assert(wide.dataset.view === 'split',
      `clicking the other layout takes it, got ${wide.dataset.view}`);

    wide.querySelector('.diff-view-btn[data-view="split"]').click();
    assert(wide.dataset.view === 'inline',
      `clicking the layout in force goes back to the other one, got ${wide.dataset.view}`);

    wide.querySelector('.diff-view-btn[data-view="inline"]').click();
    assert(wide.dataset.view === 'split',
      `and it toggles from either button, got ${wide.dataset.view}`);
  });

  // The switch stays where it is when it cannot be used. Hiding it would leave a
  // reader who only ever opens diffs in a narrow panel with no way of learning
  // that the other layout exists, and a control that vanishes is indistinguishable
  // from one that was never built.
  run('a switch that cannot be used is shown disabled, and says why', () => {
    const narrow = mountedViewer(tooNarrow);
    narrow.setDiff('a\nX', 'a\nY', '/src/main.js');

    const buttons = narrow.querySelectorAll('.diff-view-btn');
    assert(buttons.length === 2, `the switch is still there, got ${buttons.length} buttons`);
    assert([...buttons].every((/** @type {any} */ b) => b.disabled),
      'neither layout can be chosen here, so neither is offered as choosable');
    const why = narrow.querySelector('.diff-view-switch').getAttribute('title');
    assert(typeof why === 'string' && why.length > 0,
      'a control that refuses has to say what would let it work');
    assert(/wider|narrow|room|width/i.test(why),
      `the reason must be about the room there is, got ${JSON.stringify(why)}`);
  });

  // Being filled before being mounted is not an edge case — it is what every
  // host of this component does. A viewer that measured itself at zero width and
  // never looked again offers no layout at all, in a panel with room for both.
  run('a viewer filled before it is mounted still finds its width', () => {
    const el = filledThenMounted(wideEnough);
    assert([...el.querySelectorAll('.diff-view-btn')].every((/** @type {any} */ b) => !b.disabled),
      'a mounted viewer with room for two columns must offer them, however it was filled');
    assert(el.querySelector('.diff-view-switch').getAttribute('title') === null,
      'and must not still be explaining a refusal it is no longer making');
  });

  run('a viewer filled before it is mounted takes the layout it was asked for', () => {
    prefs.setDefaultDiffView('split');
    const el = filledThenMounted(wideEnough);
    assert(el.dataset.view === 'split',
      `the split preference must survive being applied before there was a width, got ${el.dataset.view}`);
    assert(el.querySelector('.diff-row') !== null, 'and the two-column rows must actually be drawn');
  });

  run('a disabled switch cannot be used even so', () => {
    const narrow = mountedViewer(tooNarrow);
    narrow.setDiff('a\nX', 'a\nY', '/src/main.js');
    narrow.querySelector('.diff-view-btn[data-view="split"]').click();
    assert(narrow.dataset.view === 'inline',
      'clicking a layout there is no room for must not produce it');
  });

  run('a viewer can be set on its own, and then stops following the default', () => {
    const own = mountedViewer(wideEnough);
    own.setDiff('a\nX', 'a\nY', '/src/own.js');
    const following = mountedViewer(wideEnough);
    following.setDiff('a\nX', 'a\nY', '/src/following.js');

    own.setView('split');
    assert(own.dataset.view === 'split', 'the viewer took the layout it was given');
    assert(following.dataset.view === 'inline', 'and said nothing about any other viewer');

    // The default moves the one that never had an opinion, and leaves the one
    // that does — even though it is being moved TO what that one already shows.
    prefs.setDefaultDiffView('split');
    assert(following.dataset.view === 'split', 'a viewer following the default follows it');
    own.setView('inline');
    prefs.setDefaultDiffView('split');
    assert(own.dataset.view === 'inline',
      'a viewer set for itself is not moved by the default, even back onto it');
  });

  run('the context width narrows what a snapshot diff shows', () => {
    const el = mountedViewer(wideEnough);
    const body = Array.from({ length: 21 }, (_, k) => `l${k + 1}`);
    const edited = [...body];
    edited[10] = 'CHANGED';
    el.setDiff(body.join('\n'), edited.join('\n'), '/src/main.js');
    assert(contextShown(el) === 6, `the default shows three lines each side, got ${contextShown(el)}`);

    el.setContextLines(0);
    assert(contextShown(el) === 0, `at no context, got ${contextShown(el)} unchanged lines`);
    el.setContextLines(prefs.WHOLE_FILE);
    assert(contextShown(el) === 20, `the whole file is 20 unchanged lines, got ${contextShown(el)}`);
  });

  run('changing the context width says so, for whoever fetched the patch', () => {
    const el = mountedViewer(wideEnough);
    el.setDiff('a\nX', 'a\nY', '/src/main.js');
    /** @type {any[]} */
    const heard = [];
    el.addEventListener('diff-context-change', (/** @type {any} */ e) => heard.push(e.detail));

    el.setContextLines(10);
    assert(heard.length === 1, `expected one announcement, got ${heard.length}`);
    assert(heard[0]?.contextLines === 10,
      `it must say which width was asked for, got ${JSON.stringify(heard[0])}`);
    assert(el.contextLines === 10, 'and the viewer must answer with the same width when asked');
  });

  // A server patch holds only the lines it was produced with. Narrowing it is
  // exact and immediate; widening it is not this component's to do, and claiming
  // otherwise would draw a width the patch cannot support.
  run('a server patch can be narrowed here but not widened', () => {
    const el = mountedViewer(wideEnough);
    el.setPatch({
      repo: '', path: 'src/main.js', status: 'modified', added: 1, removed: 1,
      revision: 'r1', context: 3,
      hunks: [{
        oldStart: 10, oldLines: 7, newStart: 10, newLines: 7, heading: '',
        lines: [
          { kind: 'context', oldLine: 10, newLine: 10, text: 'a' },
          { kind: 'context', oldLine: 11, newLine: 11, text: 'b' },
          { kind: 'context', oldLine: 12, newLine: 12, text: 'c' },
          { kind: 'remove', oldLine: 13, newLine: null, text: 'was' },
          { kind: 'add', oldLine: null, newLine: 13, text: 'now' },
          { kind: 'context', oldLine: 14, newLine: 14, text: 'd' },
          { kind: 'context', oldLine: 15, newLine: 15, text: 'e' },
          { kind: 'context', oldLine: 16, newLine: 16, text: 'f' },
        ],
      }],
    });
    assert(contextShown(el) === 6, `the patch carries six unchanged lines, got ${contextShown(el)}`);

    el.setContextLines(1);
    assert(contextShown(el) === 2, `narrowed to one each side, got ${contextShown(el)}`);

    el.setContextLines(25);
    assert(contextShown(el) === 6,
      `asking for more than the patch holds must show what it holds, got ${contextShown(el)}`);
  });

  return { passed, failed, errors };
}

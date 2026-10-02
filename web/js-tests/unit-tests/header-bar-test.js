//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The header bar's button row, asserted against the markup index.html really
 * serves rather than a hand-copied fixture, so a test cannot keep passing
 * against a button the page no longer has.
 *
 * The real header is fetched and parsed inert; each case clones just the part
 * it needs into an `.app-header` wrapper in this lane, where the app's own
 * stylesheets (loaded by the headless page) style it exactly as they do the
 * live header.
 *
 *   1–2. Toggles show their CURRENT state through the glyph alone — never a
 *        tint or a dimmed icon that only the pressed state gets.
 *   3. The network button carries the count of other connected clients, in
 *      its badge and its accessible name; the project chip carries none.
 *   4. Undo/redo act on the conversation, so they sit beside the project chip,
 *      and join the button row on a phone.
 *   5. The app-wide controls come in groups (view, status, app, panel) whose
 *      spacing grows with the header; with room, the network count is a label.
 *   6. Below 900px, help and zoom fold into a "…" menu that offers them back,
 *      with their shortcuts.
 *   7. Tooltips name shortcuts, and never restore a title that changed under them.
 * @module unit-tests/header-bar-test
 */

import { assert, styledProbeFrame } from '../utilities/test-helpers.js';
import { serverPath } from '../../js/utils/api-url.js';
import { bindNetworkClients } from '../../js/utils/header-controls.js';
import { setupHeaderOverflowMenu } from '../../js/utils/header-overflow-menu.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import tooltipManager from '../../js/services/tooltip-manager.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The header exactly as index.html serves it, parsed into an inert document
 * (nothing upgrades or runs there).
 * @returns {Promise<HTMLElement>} The served `.app-header`.
 */
async function servedHeader() {
  const res = await fetch(serverPath('/index.html'));
  assert(res.ok, `precondition: index.html is served (HTTP ${res.status})`);
  // A document with no browsing context: its scripts never run and its custom
  // elements never upgrade.
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = await res.text();
  const header = /** @type {HTMLElement|null} */ (doc.querySelector('header.app-header'));
  assert(!!header, 'precondition: index.html has a header.app-header');
  return /** @type {HTMLElement} */ (header);
}

/**
 * Mount copies of some served header buttons in a live `.app-header >
 * header-actions`, so the header stylesheets select them as they do in the app.
 * @param {HTMLElement} served - The parsed header from servedHeader().
 * @param {string[]} ids - Ids of the buttons to copy.
 * @returns {{root: HTMLElement, get: (id: string) => HTMLElement}} The mounted
 *   wrapper and a lookup for the copies.
 */
function mountButtons(served, ids) {
  const root = document.createElement('header');
  root.className = 'app-header';
  const actions = document.createElement('header-actions');
  root.appendChild(actions);
  for (const id of ids) {
    const button = served.querySelector(`#${id}`);
    assert(!!button, `precondition: the served header has #${id}`);
    actions.appendChild(document.importNode(/** @type {Element} */ (button), true));
  }
  document.body.appendChild(root);
  return {
    root,
    get: (id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`)),
  };
}

/**
 * The whole served header, laid out in a child document of a chosen width
 * that wears the app's stylesheets — the only way to measure the breakpoint
 * layouts, since a lane's own width varies by platform. The child document has
 * its own element registry, so the header's custom elements stay inert.
 * @param {HTMLElement} served - The parsed header from servedHeader().
 * @param {number} width - The frame's width in px.
 * @returns {Promise<{doc: Document, frame: HTMLIFrameElement, el: (sel: string) => HTMLElement, box: (sel: string) => DOMRect}>}
 *   The child document, its frame, and lookups for elements and their boxes.
 */
async function framedHeader(served, width) {
  const { doc, frame } = await styledProbeFrame(width);
  doc.body.appendChild(doc.importNode(served, true));
  const el = (/** @type {string} */ sel) => {
    const found = doc.querySelector(sel);
    assert(!!found, `precondition: the framed header has ${sel}`);
    return /** @type {HTMLElement} */ (found);
  };
  return { doc, frame, el, box: (sel) => el(sel).getBoundingClientRect() };
}

/**
 * @param {Element} button - A header button holding one or more SVG glyphs.
 * @returns {SVGElement[]} The glyphs CSS is currently showing.
 */
function shownGlyphs(button) {
  return /** @type {SVGElement[]} */ ([...button.querySelectorAll('svg')])
    .filter((svg) => getComputedStyle(svg).display !== 'none');
}

/**
 * Run the header bar suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const served = await servedHeader();

  // --- 1: the grouping toggle's glyph shows the current state, untinted ---
  try {
    const { root, get } = mountButtons(served, ['tool-grouping-button', 'bell-button']);
    try {
      const button = get('tool-grouping-button');
      const reference = /** @type {SVGElement} */ (get('bell-button').querySelector('svg'));

      /**
       * @param {boolean} on - Whether grouping is on.
       * @returns {SVGElement} The one glyph shown in that state.
       */
      const glyphFor = (on) => {
        button.classList.toggle('is-active', on);
        const shown = shownGlyphs(button);
        assert(shown.length === 1, `exactly one glyph shows with grouping ${on ? 'on' : 'off'}, got ${shown.length}`);
        return shown[0];
      };

      // Grouping on means the transcript IS folded, so the folded glyph shows;
      // off, the rows stand individually and the unfolded one does.
      assert(glyphFor(true).classList.contains('tool-grouping-fold'),
        'with grouping on the button shows the folded glyph — the state the transcript is in');
      assert(glyphFor(false).classList.contains('tool-grouping-unfold'),
        'with grouping off it shows the unfolded glyph');

      // The glyph change is the whole signal. Both states paint exactly like an
      // untoggled header icon: no accent tint on, no dimming off.
      const ref = getComputedStyle(reference);
      for (const on of [true, false]) {
        const style = getComputedStyle(glyphFor(on));
        assert(style.fill === ref.fill,
          `grouping ${on ? 'on' : 'off'}: glyph fill ${style.fill} must match a plain header icon's ${ref.fill}`);
        assert(style.opacity === ref.opacity,
          `grouping ${on ? 'on' : 'off'}: glyph opacity ${style.opacity} must match a plain header icon's ${ref.opacity}`);
      }
    } finally {
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`grouping toggle state: ${msg(e)}`); }

  // --- 2: the pinboard toggle's glyph shows whether the board is open ---
  try {
    const { root, get } = mountButtons(served, ['pinboard-header-button']);
    try {
      const button = get('pinboard-header-button');
      button.hidden = false;

      /**
       * @param {boolean} open - Whether the board is open.
       * @returns {SVGElement} The one glyph shown in that state.
       */
      const glyphFor = (open) => {
        // pinboard-shell reflects the board's state in aria-expanded alone.
        button.setAttribute('aria-expanded', String(open));
        const shown = shownGlyphs(button);
        assert(shown.length === 1, `exactly one glyph shows with the board ${open ? 'open' : 'closed'}, got ${shown.length}`);
        return shown[0];
      };

      assert(glyphFor(true).classList.contains('pinboard-glyph-open'),
        'with the board open the toggle shows the filled-panel glyph');
      assert(glyphFor(false).classList.contains('pinboard-glyph-closed'),
        'with the board closed it shows the outline glyph');
    } finally {
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`pinboard toggle state: ${msg(e)}`); }

  // --- 3: the network button carries the connected-clients count ---
  try {
    assert(!served.querySelector('#project-clients-indicator, project-path-display [class*="clients"]'),
      'the project chip carries no clients indicator — the count lives on the network button');

    const { root, get } = mountButtons(served, ['network-button']);
    /** @type {Map<string, Set<(data: any) => void>>} */
    const listeners = new Map();
    // A private event source: the lane's real socket hears every other lane
    // join and leave, which would move the count under the assertions.
    const events = {
      on: (/** @type {string} */ type, /** @type {(data: any) => void} */ fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(fn);
      },
      off: (/** @type {string} */ type, /** @type {(data: any) => void} */ fn) => { listeners.get(type)?.delete(fn); },
    };
    const clientsChanged = (/** @type {number} */ count) => {
      for (const fn of listeners.get('clients-changed') || []) fn({ count, clients: [] });
    };
    const binding = bindNetworkClients(get('network-button'), { events, seed: async () => 2 });
    try {
      const button = get('network-button');
      const clients = /** @type {HTMLElement|null} */ (button.querySelector('.network-button__clients'));
      assert(!!clients, 'the network button has a clients element');
      const shown = () => !!clients && getComputedStyle(clients).display !== 'none';
      const count = () => button.querySelector('.network-button__count')?.textContent;

      await binding.ready;
      assert(shown() && count() === '1',
        `the seeded total of 2 shows one OTHER client, got shown=${shown()} count=${count()}`);

      clientsChanged(1);
      assert(!shown(), 'alone, the button shows no count');
      assert(button.title === 'Network settings' && button.getAttribute('aria-label') === 'Network settings',
        `alone, the button is plain "Network settings", got "${button.title}"`);
      const aloneWidth = button.getBoundingClientRect().width;

      clientsChanged(4);
      assert(shown() && count() === '3', `four connected shows 3 others, got shown=${shown()} count=${count()}`);
      assert(button.title === 'Network settings — 3 other clients connected',
        `the title names the count, got "${button.title}"`);
      assert(button.getAttribute('aria-label') === button.title, 'the accessible name says the same');
      assert(button.classList.contains('has-clients'), 'the button is marked as carrying a count');
      assert(button.getBoundingClientRect().width === aloneWidth,
        `the badge sits over the icon, never widening the button (${aloneWidth} → ${button.getBoundingClientRect().width})`);

      clientsChanged(2);
      assert(button.title === 'Network settings — 1 other client connected',
        `one other client reads in the singular, got "${button.title}"`);

      clientsChanged(1);
      assert(!shown() && button.title === 'Network settings' && !button.classList.contains('has-clients'),
        'the count goes away when the others leave');

      binding.dispose();
      clientsChanged(5);
      assert(!shown(), 'a disposed binding stops listening');
    } finally {
      binding.dispose();
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`network clients: ${msg(e)}`); }

  // --- 4: undo/redo sit with the project, not with the app-wide controls ---
  try {
    const history = served.querySelector('.header-history');
    assert(!!history, 'the header has a .header-history group');
    assert(history?.previousElementSibling?.tagName === 'PROJECT-PATH-DISPLAY',
      'it follows the project chip directly');
    assert(!!history?.querySelector('#control-undo-button') && !!history?.querySelector('#control-redo-button'),
      'it holds undo and redo');
    assert(!served.querySelector('header-actions #control-undo-button, header-actions #control-redo-button'),
      'and the app-wide cluster no longer does');

    // Wide: the free space opens AFTER undo/redo, so they hug the chip.
    const wide = await framedHeader(served, 1400);
    try {
      const chip = wide.box('project-path-display');
      const undo = wide.box('#control-undo-button');
      const redo = wide.box('#control-redo-button');
      const actions = wide.box('header-actions');
      assert(undo.left - chip.right < 40,
        `undo sits beside the chip (${Math.round(undo.left - chip.right)}px away)`);
      assert(actions.left - redo.right > 200,
        `the open space is between redo and the app-wide controls (${Math.round(actions.left - redo.right)}px)`);

      // Window mode: the header is a drag region, and the group must opt out.
      wide.doc.body.classList.add('window-mode');
      const drag = wide.doc.defaultView?.getComputedStyle(wide.el('#control-undo-button'))
        .getPropertyValue('--wails-draggable').trim();
      assert(drag === 'no-drag', `undo is clickable in a desktop window, not a drag handle (got "${drag}")`);
      wide.doc.body.classList.remove('window-mode');

      // A detached board window keeps none of the opener's conversation controls.
      wide.doc.documentElement.dataset.view = 'pinboard';
      assert(wide.doc.defaultView?.getComputedStyle(wide.el('.header-history')).display === 'none',
        'a detached board window has no undo/redo');
    } finally {
      wide.frame.remove();
    }

    // Phone: the chip keeps row 1; undo/redo join the button row beneath it.
    const phone = await framedHeader(served, 400);
    try {
      const chip = phone.box('project-path-display');
      const undo = phone.box('#control-undo-button');
      const settings = phone.box('#settings-button');
      const middle = (/** @type {DOMRect} */ r) => r.top + r.height / 2;
      assert(undo.top >= chip.bottom - 1,
        `undo drops below the chip on a phone (undo top ${Math.round(undo.top)}, chip bottom ${Math.round(chip.bottom)})`);
      assert(Math.abs(middle(undo) - middle(settings)) < 2,
        `undo shares the button row with settings (${Math.round(middle(undo))} vs ${Math.round(middle(settings))})`);
      assert(undo.right <= 400 && settings.right <= 400, 'nothing spills off the right edge');
    } finally {
      phone.frame.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`history group: ${msg(e)}`); }

  // --- 5: the app-wide controls are grouped, and the groups spread with room ---
  try {
    /** @type {Record<string, string[]>} */
    const expected = {
      view: ['tool-grouping-button', 'zoom-out-button', 'zoom-in-button', 'theme-button'],
      status: ['bell-button', 'network-button'],
      app: ['help-button', 'settings-button'],
      panel: ['pinboard-header-button'],
    };
    const groups = [...served.querySelectorAll('.header-actions-controls > .header-group')];
    assert(groups.map((g) => g.className).join() === Object.keys(expected).map((k) => `header-group header-group--${k}`).join(),
      `the controls are grouped view, status, app, panel — got ${groups.map((g) => g.className).join(' | ')}`);
    for (const [name, ids] of Object.entries(expected)) {
      const got = [...served.querySelectorAll(`.header-group--${name} button`)].map((b) => b.id);
      assert(got.filter((id) => ids.includes(id)).join() === ids.join(),
        `the ${name} group holds ${ids.join(', ')} in order, got ${got.join(', ')}`);
    }

    /**
     * @param {number} width - Header width to lay out at.
     * @returns {Promise<{between: number, within: number}>} The gap between two
     *   groups (theme → bell) and between two buttons of one group (zoom-in → theme).
     */
    const gapsAt = async (width) => {
      const f = await framedHeader(served, width);
      try {
        return {
          between: f.box('#bell-button').left - f.box('#theme-button').right,
          within: f.box('#theme-button').left - f.box('#zoom-in-button').right,
        };
      } finally {
        f.frame.remove();
      }
    };
    const narrow = await gapsAt(1000);
    const roomy = await gapsAt(2000);
    for (const [label, g] of /** @type {const} */ ([['1000px', narrow], ['2000px', roomy]])) {
      assert(Math.round(g.within) === 4, `${label}: buttons within a group sit 4px apart, got ${g.within}`);
      assert(g.between > g.within * 2, `${label}: groups sit visibly further apart (${g.between}px) than their buttons (${g.within}px)`);
    }
    assert(roomy.between > narrow.between + 6,
      `the gap between groups grows with the header (${narrow.between}px at 1000 → ${roomy.between}px at 2000)`);

    // With room to spare the network count reads as a label, not a badge.
    for (const [width, label] of /** @type {const} */ ([[2000, true], [1000, false]])) {
      const f = await framedHeader(served, width);
      try {
        const button = f.el('#network-button');
        f.el('.network-button__clients').hidden = false;
        f.el('.network-button__count').textContent = '2';
        button.classList.add('has-clients');
        const view = /** @type {Window} */ (f.doc.defaultView);
        const suffixShown = view.getComputedStyle(f.el('.network-button__suffix')).display !== 'none';
        assert(suffixShown === label,
          `${width}px: "connected" ${label ? 'is' : 'is not'} spelled out (shown=${suffixShown})`);
        const w = button.getBoundingClientRect().width;
        assert(label ? w > 60 : Math.round(w) === 32,
          `${width}px: the button is ${label ? 'widened to hold the label' : 'icon-sized'}, got ${w}px`);
      } finally {
        f.frame.remove();
      }
    }
    passed++;
  } catch (e) { failed++; errors.push(`grouped controls: ${msg(e)}`); }

  // --- 6: below 900px the rarely-used controls fold into a "…" menu ---
  try {
    const folded = ['#help-button', '#zoom-out-button', '#zoom-in-button'];
    for (const [width, overflowing] of /** @type {const} */ ([[1200, false], [800, true], [400, true]])) {
      const f = await framedHeader(served, width);
      try {
        // Rendered, not merely un-hidden itself: what folds is a wrapper, and a
        // button inside a hidden wrapper still reports its own display.
        const displayed = (/** @type {string} */ sel) => f.el(sel).getClientRects().length > 0;
        assert(displayed('#header-overflow-button') === overflowing,
          `${width}px: the "…" button is ${overflowing ? 'shown' : 'not shown'}`);
        for (const sel of folded) {
          assert(displayed(sel) === !overflowing,
            `${width}px: ${sel} is ${overflowing ? 'folded into the menu' : 'in the row'}`);
        }
        assert(displayed('#settings-button') && displayed('#network-button') && displayed('#theme-button'),
          `${width}px: settings, network and theme always stay in the row`);
      } finally {
        f.frame.remove();
      }
    }

    // The menu offers exactly what the row gave up, each with its shortcut.
    const { root, get } = mountButtons(served, ['header-overflow-button']);
    const button = get('header-overflow-button');
    /** @type {string[]} */
    const ran = [];
    const menu = setupHeaderOverflowMenu(button, [
      { label: 'Decrease font size', shortcutId: 'zoom-out', run: () => ran.push('zoom-out') },
      { label: 'Increase font size', shortcutId: 'zoom-in', run: () => ran.push('zoom-in') },
      { label: 'Tips & keyboard shortcuts', shortcutId: 'show-shortcuts', run: () => ran.push('help') },
    ]);
    try {
      const surface = () => document.querySelector('.header-overflow-menu');
      assert(!surface() && button.getAttribute('aria-expanded') === 'false', 'the menu starts closed');

      button.click();
      const rows = [...(surface()?.querySelectorAll('.menu-item') || [])];
      assert(rows.length === 3, `three rows, got ${rows.length}`);
      assert(button.getAttribute('aria-expanded') === 'true', 'the button says the menu is open');
      const labelOf = (/** @type {Element} */ r) => r.querySelector('.menu-item-name')?.textContent;
      const keysOf = (/** @type {Element} */ r) => r.querySelector('.menu-item-shortcut')?.textContent;
      assert(rows.map(labelOf).join('|') === 'Decrease font size|Increase font size|Tips & keyboard shortcuts',
        `the rows are labelled for what they do, got ${rows.map(labelOf).join('|')}`);
      for (const [i, id] of ['zoom-out', 'zoom-in', 'show-shortcuts'].entries()) {
        assert(keysOf(rows[i]) === keyShortcutManager.formatBinding(id) && !!keysOf(rows[i]),
          `row ${i} shows its shortcut ${keyShortcutManager.formatBinding(id)}, got "${keysOf(rows[i])}"`);
      }

      /** @type {HTMLElement} */ (rows[1]).click();
      assert(ran.join() === 'zoom-in', `choosing a row runs its action and only its action, got [${ran}]`);
      assert(!surface() && button.getAttribute('aria-expanded') === 'false', 'choosing a row closes the menu');

      button.click();
      assert(!!surface(), 'the button opens it again');
      button.click();
      assert(!surface(), 'and a second click on the button closes it');
      assert(ran.join() === 'zoom-in', 'without running anything');
    } finally {
      menu.dispose();
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`overflow menu: ${msg(e)}`); }

  // --- 7: tooltips carry shortcuts, and follow a title that changes under them ---
  try {
    assert(served.querySelector('#help-button')?.getAttribute('data-shortcut-id') === 'show-shortcuts',
      'the help button names its shortcut, so its tooltip shows it');

    // A header title can change while its tooltip is up — undo going busy
    // under the pointer. Leaving must not put the stale text back.
    const button = document.createElement('button');
    button.title = 'Undo';
    document.body.appendChild(button);
    try {
      tooltipManager.showFor(button);
      assert(!button.hasAttribute('title'), 'precondition: the tooltip has taken the native title');
      button.title = 'Unavailable while the agent is running';
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      assert(button.title === 'Unavailable while the agent is running',
        `the title set while the tooltip was up survives it, got "${button.title}"`);
    } finally {
      button.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`tooltips: ${msg(e)}`); }

  return { passed, failed, errors };
}

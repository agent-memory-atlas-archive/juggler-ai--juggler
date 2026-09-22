//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <workspace-panel> — what a selected workspace box shows in the main area.
 *
 * The panel exists because the same facts and the same endings used to be
 * crammed into a box header three tabs wide and a menu you had to hold a
 * pointer inside. So the assertions here are mostly about room and separation:
 * the path is a path with the things one does to a path beside it, the endings
 * are ruled off from the actions that leave the workspace in use, and a row
 * that asks something before it does anything says so in its label.
 *
 * The last case is the one that costs nothing and would hurt: a workspace
 * finished with while its own panel is open leaves a selection naming nothing,
 * and the panel has to get out of the way rather than draw a ghost.
 * @module unit-tests/workspace-panel-test
 */

import { assert, initializeRegistries } from '../utilities/test-helpers.js';
import { FixtureProvider, ensureFixtureProvider } from '../utilities/conversation-workspace-helpers.js';
import '../../js/components/workspace-panel.js';
// For the width comparison: the column a workspace panel stands in place of.
import '../../js/components/conversation-area.js';

/**
 * A workspace row bound to the fixture provider, so the panel has real endings
 * to lay out rather than a provider-missing note.
 * @param {string} id - The workspace id.
 * @returns {any} The row.
 */
function workspace(id) {
  return {
    id,
    root: `/tmp/${id}/work`,
    label: id,
    state: 'ready',
    available: true,
    providerId: FixtureProvider.MANIFEST.id
  };
}

/**
 * A session carrying only what the panel reads. The panel asks the table for
 * the row behind the selected id on every draw, which is the behaviour the
 * last case is about, so the table is a live array the case can edit.
 * @param {any[]} workspaces - The workspace table.
 * @returns {any} The session.
 */
function makeSession(workspaces) {
  return {
    workspaces,
    projectPath: '/tmp/project',
    conversations: new Map(),
    selection: null,
    loadedConversationId: null,
    /**
     * @param {string} id - Which workspace.
     * @returns {any} The row, if the table still holds it.
     */
    getWorkspace(id) { return workspaces.find((row) => row.id === id) || null; },
    /**
     * @returns {() => void} How to stop listening.
     */
    subscribe() { return () => {}; }
  };
}

/**
 * Mount a panel over a session.
 * @param {any} session - The session to draw.
 * @returns {{panel: any, column: HTMLElement, teardown: () => void}} The panel, its column container, and a teardown.
 */
function mountPanel(session) {
  // In a column container, because that is where it lives: the panel is a
  // column, and its width comes from being one.
  const column = document.createElement('column-container');
  column.className = 'workspace-panel-column';
  column.setAttribute('style', 'position:absolute;left:0;top:0;width:1600px;height:800px;');
  const panel = /** @type {any} */ (document.createElement('workspace-panel'));
  panel.hidden = true;
  column.appendChild(panel);
  document.body.appendChild(column);
  panel.setSession(session);
  return {
    panel,
    column,
    teardown: () => {
      column.remove();
      // The panel hides the tab column with a class on <body>, which outlives
      // the element that set it.
      document.body.classList.remove('workspace-selected');
    }
  };
}

/**
 * What a section of the panel offers, by the ids the provider gave.
 * @param {any} panel - The mounted panel.
 * @param {string} selector - Which section.
 * @returns {string} The action ids, in order.
 */
function actionsIn(panel, selector) {
  const section = panel.querySelector(selector);
  if (!section) return '(no section)';
  return /** @type {HTMLElement[]} */ (Array.from(section.querySelectorAll('[data-action]')))
    .map((button) => button.dataset.action)
    .join(',');
}

/**
 * Run the workspace panel tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();
  ensureFixtureProvider();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('nothing selected is nothing shown', () => {
    const { panel, teardown } = mountPanel(makeSession([workspace('ws_a')]));
    try {
      assert(panel.hidden === true,
        'a panel for no workspace is not a panel, and takes none of the room a conversation wants');
      assert(!document.body.classList.contains('workspace-selected'),
        'and the tab column keeps the main area');
    } finally {
      teardown();
    }
  });

  check('a selected workspace takes the place of the conversation', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      assert(panel.hidden === false, 'the panel is what is on screen');
      assert(document.body.classList.contains('workspace-selected'),
        'and the tab column stands down, the way it does for the two onboarding overlays');
      assert(panel.querySelector('.workspace-panel-title')?.textContent === 'ws_a',
        `the place is named, got ${JSON.stringify(panel.querySelector('.workspace-panel-title')?.textContent)}`);
      assert(panel.querySelector('.workspace-panel-kind')?.textContent === FixtureProvider.MANIFEST.name,
        'and said to be the kind of place whatever made it calls it');
    } finally {
      teardown();
    }
  });

  check('the panel says what kind of thing this is, and what that kind is for', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const eyebrow = panel.querySelector('.workspace-panel-eyebrow')?.textContent;
      assert(eyebrow === 'Workspace',
        `a box is clicked before it is understood, so the panel it opens uses the word, got ${JSON.stringify(eyebrow)}`);

      const note = panel.querySelector('.workspace-panel-kind-note')?.textContent;
      assert(note === FixtureProvider.MANIFEST.description,
        `and the kind's name is followed by what that kind is for, which the provider already wrote, got ${JSON.stringify(note)}`);
    } finally {
      teardown();
    }
  });

  check('the conversations working here are named, and each is a way back to itself', () => {
    const session = makeSession([workspace('ws_a')]);
    session.conversations = new Map([
      ['c_here', { id: 'c_here', name: 'in the tree', workspaceId: 'ws_a' }],
      ['c_elsewhere', { id: 'c_elsewhere', name: 'in the project', workspaceId: '' }]
    ]);
    let switched = '';
    session.switchConversation = (/** @type {string} */ id) => { switched = id; };

    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const named = /** @type {HTMLElement[]} */ (Array.from(panel.querySelectorAll('.workspace-panel-conversation')))
        .map((row) => row.textContent).join(',');
      assert(named === 'in the tree',
        `the panel has replaced the box's own tabs on screen, so it is the one thing that can say who is working in the tree — and only who is, got "${named}"`);

      /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-conversation')).click();
      assert(switched === 'c_here',
        `naming one and not going to it would be a list of places you cannot get to, got ${JSON.stringify(switched)}`);
    } finally {
      teardown();
    }
  });

  check('a workspace nobody is working in says so', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const said = panel.querySelector('.workspace-panel-doing .workspace-panel-note')?.textContent;
      assert(said === 'No conversations yet.',
        `an empty tree is a place waiting to be used, not a panel with a section missing, got ${JSON.stringify(said)}`);
    } finally {
      teardown();
    }
  });

  check('the panel is a column, exactly as wide as the conversation it replaces', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, column, teardown } = mountPanel(session);
    // A real conversation column beside it, because the width under test is
    // "the same as that one" — asserting a number instead would let the two
    // drift apart and still pass.
    const area = document.createElement('conversation-area');
    column.appendChild(area);
    try {
      document.body.classList.add('workspace-selected');
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const width = panel.getBoundingClientRect().width;
      // Two unlaid-out columns are both nothing wide and would agree on it.
      assert(width > 0, `the panel is laid out at all, got ${width}px`);
      assert(width === area.getBoundingClientRect().width,
        'a workspace opens in the column a conversation would have opened in, at the width that column '
        + `has, got ${width}px against the conversation's ${area.getBoundingClientRect().width}px`);
      assert(width < column.getBoundingClientRect().width,
        'rather than stretching across a window that may be very wide, which nothing else the tab strip '
        + 'selects does');
      assert(!!panel.querySelector('col-resize-handle'),
        'and it is widened the way every other column is, by the grip on its own edge');
    } finally {
      area.remove();
      teardown();
    }
  });

  check('the path is a path, with the things one does to a path beside it', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const box = /** @type {HTMLElement|null} */ (panel.querySelector('.workspace-panel-path'));
      assert(box?.textContent === '/tmp/ws_a/work',
        `written out whole — no rule about which part of a path matters survives the paths providers make, got ${JSON.stringify(box?.textContent)}`);
      assert(box?.dataset.filePath === '/tmp/ws_a/work',
        'and carrying the hook the right-click Open / Reveal / Copy menu reads everywhere else');
      assert(!!panel.querySelector('.properties-panel-filepath-actions'),
        'with copy, reveal and pin beside it, as a path has everywhere else');
    } finally {
      teardown();
    }
  });

  check('the endings are ruled off from the things that keep the workspace', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const working = actionsIn(panel, '.workspace-panel-doing');
      assert(working === 'note',
        `an action that leaves the workspace in use belongs with the rest of working here, got "${working}"`);

      const endings = actionsIn(panel, '.workspace-panel-endings');
      assert(endings === 'done,leave',
        `and every way of not working here any more goes under the heading that says so, got "${endings}"`);

      assert(!!panel.querySelector('.workspace-panel-create'),
        'starting a conversation is the first thing you do in a place you are keeping');
    } finally {
      teardown();
    }
  });

  check('a row that asks something first says so', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const asks = /** @type {HTMLElement|null} */ (panel.querySelector('[data-action="note"] .workspace-panel-action-name'));
      assert(asks?.textContent === 'Leave a note…',
        `the ellipsis is the promise the rest of the app makes, got ${JSON.stringify(asks?.textContent)}`);

      const agrees = /** @type {HTMLElement|null} */ (panel.querySelector('[data-action="leave"] .workspace-panel-action-name'));
      assert(agrees?.textContent === 'Leave it be',
        `and an ending that only wants agreeing to does not get one — a confirmation is not a question, got ${JSON.stringify(agrees?.textContent)}`);

      const note = panel.querySelector('[data-action="done"] .workspace-panel-action-note');
      assert(note?.textContent === 'Removes the directory.',
        'what a press will do is written under it, where someone deciding whether it is safe will read it');
    } finally {
      teardown();
    }
  });

  check('a workspace finished with under its own panel stops being selected', () => {
    const table = [workspace('ws_a')];
    const session = makeSession(table);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();
      assert(panel.hidden === false, 'it starts out showing');

      // What finishing with one leaves behind: an id naming nothing.
      table.length = 0;
      panel._refresh();

      assert(panel.hidden === true,
        'a selection that names nothing selects nothing, rather than drawing a workspace that is gone');
      assert(!document.body.classList.contains('workspace-selected'),
        'and the tab column takes the room back without anyone having to tidy the id');
    } finally {
      teardown();
    }
  });

  check('a workspace that closes under its panel stops being selected too', () => {
    const table = [workspace('ws_a')];
    const session = makeSession(table);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      // Still on the table, but no longer somewhere to work — which is exactly
      // when the strip stops drawing a box for it.
      table[0].state = 'closed';
      panel._refresh();

      assert(panel.hidden === true,
        'a selection has to mean the box that is drawn, and no box is drawn for a place nobody can work in');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}

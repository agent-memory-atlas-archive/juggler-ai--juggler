//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Grouping a session's conversations by the workspace they work in.
 *
 * The tab bar draws this and stores none of it: the flat conversation order
 * stays the only persisted one, and a grouping is a reading of it. So the
 * assertions here are about what that reading is allowed to say — which
 * workspaces get a group, where each group lands, and what happens to a
 * conversation whose binding names a place nobody can work in.
 * @module unit-tests/workspace-groups-test
 */

import { assert } from '../utilities/test-helpers.js';
import { workspaceGroups, placeForNewConversation } from '../../js/services/workspace-provisioning.js';

/**
 * A workspace row as the session holds one.
 * @param {string} id - The workspace id.
 * @param {object} [overrides] - What makes it unusable, where it is not ready.
 * @returns {any} The row.
 */
function workspace(id, overrides = {}) {
  return { id, root: `/tmp/${id}`, label: id, state: 'ready', available: true, ...overrides };
}

/**
 * A session with conversations in tab-bar order.
 * @param {any[]} workspaces - The workspace table, in the order the server holds it.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {any} Enough session for the grouping to read.
 */
function session(workspaces, bindings) {
  return {
    workspaces,
    conversations: new Map(bindings.map(([id, workspaceId]) => [id, { id, name: id, workspaceId }]))
  };
}

/**
 * The tab-bar order a create would leave behind, so the grouping can be asked
 * what it draws afterwards.
 * @param {[string, string][]} bindings - The order before.
 * @param {number} index - Where the new conversation goes.
 * @param {[string, string]} entry - The new `[conversation id, workspace id]`.
 * @returns {[string, string][]} The order after.
 */
function insert(bindings, index, entry) {
  const next = [...bindings];
  next.splice(index, 0, entry);
  return next;
}

/**
 * A grouping written small enough to assert on and to read in a failure.
 * @param {any[]} groups - What {@link workspaceGroups} answered.
 * @returns {string} `ws_a:[c1,c2] project:[c3]`.
 */
function shape(groups) {
  return groups
    .map(group => `${group.workspace?.id ?? 'project'}:[${group.conversations.map((/** @type {any} */ c) => c.id).join(',')}]`)
    .join(' ');
}

/**
 * Run the workspace-groups tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
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

  check('a session with no workspaces is one flat group', () => {
    const groups = workspaceGroups(session([], [['c1', ''], ['c2', '']]));
    assert(shape(groups) === 'project:[c1,c2]',
      `the project's conversations stay flat and unboxed, got "${shape(groups)}"`);
    assert(groups[0].workspace === null,
      `the remainder names no workspace — the project has no row, so there is nothing to draw a box from, got ${JSON.stringify(groups[0].workspace)}`);
  });

  check('a session with nothing in it groups nothing', () => {
    const groups = workspaceGroups(session([], []));
    assert(groups.length === 0,
      `an empty remainder is not a group: there is nothing to put in it, got "${shape(groups)}"`);
  });

  check('conversations bound to a workspace are its group', () => {
    const groups = workspaceGroups(session(
      [workspace('ws_a')],
      [['c1', 'ws_a'], ['c2', 'ws_a'], ['c3', '']]
    ));
    assert(shape(groups) === 'ws_a:[c1,c2] project:[c3]',
      `both conversations working in a tree belong to it, and the third to nothing, got "${shape(groups)}"`);
    assert(groups[0].workspace.root === '/tmp/ws_a',
      `a group carries the row itself, which is what a header is drawn from, got ${JSON.stringify(groups[0].workspace)}`);
  });

  check('a workspace nothing is bound to still has a group', () => {
    const groups = workspaceGroups(session(
      [workspace('ws_a'), workspace('ws_empty')],
      [['c1', 'ws_a']]
    ));
    assert(shape(groups) === 'ws_a:[c1] ws_empty:[]',
      `a tree outlives the conversations started in it, and is the one thing with no other way of being seen, got "${shape(groups)}"`);
  });

  check('empty groups keep the table order, behind everything with a member', () => {
    const groups = workspaceGroups(session(
      [workspace('ws_first'), workspace('ws_second'), workspace('ws_busy')],
      [['c1', 'ws_busy']]
    ));
    assert(shape(groups) === 'ws_busy:[c1] ws_first:[] ws_second:[]',
      `having no member, an empty group has no place to take from one: it keeps the table's, got "${shape(groups)}"`);
  });

  check('a group is placed by its first member', () => {
    const boxLast = workspaceGroups(session(
      [workspace('ws_a')],
      [['c1', ''], ['c2', 'ws_a']]
    ));
    assert(shape(boxLast) === 'project:[c1] ws_a:[c2]',
      `the flat order decides, and c1 is first in it, got "${shape(boxLast)}"`);

    const boxFirst = workspaceGroups(session(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c1', '']]
    ));
    assert(shape(boxFirst) === 'ws_a:[c2] project:[c1]',
      `and the same two conversations the other way round draw the other way round, got "${shape(boxFirst)}"`);
  });

  check('a box sits between the conversations either side of it', () => {
    const groups = workspaceGroups(session(
      [workspace('ws_a')],
      [['c1', ''], ['c2', 'ws_a'], ['c3', '']]
    ));
    assert(shape(groups) === 'project:[c1] ws_a:[c2] project:[c3]',
      `every unboxed conversation keeps its own place, so a box lands between the tabs either side of it rather than above or below the lot of them, got "${shape(groups)}"`);
  });

  check('a new conversation at the top leaves the boxes where they were', () => {
    const before = workspaceGroups(session(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c1', ''], ['c0', '']]
    ));
    assert(shape(before) === 'ws_a:[c2] project:[c1,c0]',
      `the box is drawn first, its only member being first in the flat order, got "${shape(before)}"`);

    const after = workspaceGroups(session(
      [workspace('ws_a')],
      [['new', ''], ['c2', 'ws_a'], ['c1', ''], ['c0', '']]
    ));
    assert(shape(after) === 'project:[new] ws_a:[c2] project:[c1,c0]',
      `and a conversation started above it moves it down by that one conversation, not past every flat tab there is, got "${shape(after)}"`);
  });

  check('a conversation started in a workspace goes to the top of its box', () => {
    const bindings = /** @type {[string, string][]} */ ([['c0', ''], ['c1', 'ws_a'], ['c2', '']]);
    const table = [workspace('ws_a')];
    const before = workspaceGroups(session(table, bindings));
    assert(shape(before) === 'project:[c0] ws_a:[c1] project:[c2]',
      `the box is drawn second, between the tabs either side of it, got "${shape(before)}"`);

    const place = placeForNewConversation(session(table, bindings), 'ws_a');
    assert(place === 1,
      `a new member goes in at the index its box already holds, which is 1, got ${place}`);

    const after = workspaceGroups(session(table, insert(bindings, place, ['new', 'ws_a'])));
    assert(shape(after) === 'project:[c0] ws_a:[new,c1] project:[c2]',
      `so the conversation is first in the box and the box has not moved an inch, got "${shape(after)}"`);
  });

  check('a conversation started in an empty workspace lands where its box is drawn', () => {
    const bindings = /** @type {[string, string][]} */ ([['c0', ''], ['c1', '']]);
    const table = [workspace('ws_empty')];
    const before = workspaceGroups(session(table, bindings));
    assert(shape(before) === 'project:[c0,c1] ws_empty:[]',
      `an empty box is drawn past every conversation there is, got "${shape(before)}"`);

    const place = placeForNewConversation(session(table, bindings), 'ws_empty');
    assert(place === 2,
      `and its first member goes to the end, where the box already is, got ${place}`);

    const after = workspaceGroups(session(table, insert(bindings, place, ['new', 'ws_empty'])));
    assert(shape(after) === 'project:[c0,c1] ws_empty:[new]',
      `so a workspace that has waited at the bottom does not leap to the top the moment it is used, got "${shape(after)}"`);
  });

  check('a conversation belonging to nowhere in particular still goes to the top', () => {
    const table = [workspace('ws_a')];
    const bindings = /** @type {[string, string][]} */ ([['c0', ''], ['c1', 'ws_a']]);
    assert(placeForNewConversation(session(table, bindings), '') === 0,
      'the newest tab is the top tab: that is unchanged for everything outside a box');
    assert(placeForNewConversation(session(table, bindings), 'ws_never_registered') === 0,
      'and for a binding naming nothing, which is drawn flat with them');
  });

  check('a workspace nobody can work in has no box to go to the top of', () => {
    const table = [workspace('ws_closed', { state: 'closed' })];
    const bindings = /** @type {[string, string][]} */ ([['c0', ''], ['c1', 'ws_closed']]);
    assert(placeForNewConversation(session(table, bindings), 'ws_closed') === 0,
      'its conversations are drawn flat, so one more of them goes where the flat ones go');
  });

  check('an unusable binding falls into the remainder', () => {
    const groups = workspaceGroups(session(
      [
        workspace('ws_ready'),
        workspace('ws_building', { state: 'provisioning', available: false }),
        workspace('ws_done', { state: 'closed' }),
        workspace('ws_gone', { available: false })
      ],
      [['c1', 'ws_ready'], ['c2', 'ws_building'], ['c3', 'ws_done'], ['c4', 'ws_gone'], ['c5', 'ws_never_registered']]
    ));
    assert(shape(groups) === 'ws_ready:[c1] project:[c2,c3,c4,c5]',
      `a box is somewhere to work, so only a usable row gets one — the rest is the stranded banner's to explain, got "${shape(groups)}"`);
  });

  check('a flat order that splits a workspace groups it anyway', () => {
    const groups = workspaceGroups(session(
      [workspace('ws_a')],
      [['c1', 'ws_a'], ['c2', ''], ['c3', 'ws_a']]
    ));
    assert(shape(groups) === 'ws_a:[c1,c3] project:[c2]',
      `contiguity is a property of the layout, not a precondition for it: the members group and the next reorder writes the flat order back into agreement, got "${shape(groups)}"`);
  });

  check('a session that has not loaded yet groups nothing', () => {
    assert(workspaceGroups(undefined).length === 0,
      'the tab bar renders before the session is there, and must not be handed an exception for it');
    assert(workspaceGroups({}).length === 0,
      'nor for a session with no table and no conversations yet');
  });

  return { passed, failed, errors };
}

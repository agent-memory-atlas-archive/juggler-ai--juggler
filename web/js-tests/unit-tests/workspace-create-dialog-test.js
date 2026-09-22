//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Making a workspace with no conversation in the question.
 *
 * The dialog the tab strip opens. What is asserted here is mostly what it does
 * NOT do: it offers no place that already exists, because offering one would be
 * offering to do nothing; it binds nothing, seeds nothing, and leaves a
 * workspace with no conversations in it, which is the whole point of being able
 * to make one before there is anything to put inside. The rest is the shape of
 * a master-and-detail dialog — that the kind chosen on the way in has its form
 * and its provider's advice on screen without a click to get them there.
 * @module unit-tests/workspace-create-dialog-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { createBoundOps } from '../../sdk/ops.js';
import { unregisterWorkspace } from '../../js/services/workspaces.js';
import { setupRows, probeSetupAdoptions } from '../../js/services/workspace-places.js';
import {
  openWorkspaceCreate,
  workspaceCreatePlaces
} from '../../js/components/workspace-create-dialog.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import {
  runWorkspaceSuite,
  FixtureProvider
} from '../utilities/conversation-workspace-helpers.js';

/**
 * A second kind, so that the rail has something to walk between. It builds
 * nothing: every case that reaches a provision uses the fixture, and this one
 * exists to be a row.
 */
class SecondKindProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'second-kind-workspace-provider',
    name: 'Somewhere else again',
    version: '1.0.0',
    description: 'Stands in the list so there are two kinds to walk between'
  };

  /** @param {HTMLElement} container - Where its fields go. */
  renderSetup(container) {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'second-kind-dir';
    container.appendChild(field);
    this._field = field;
  }

  /** @returns {any} What the form says, and whether Create may be pressed. */
  getSetupValue() {
    const dir = this._field?.value ?? '';
    return dir ? { valid: true, values: { dir } } : { valid: false, values: {}, invalidFieldId: 'second-kind-dir' };
  }
}

/**
 * It builds directories in the shared fixture root, which a sibling lane
 * walking the project reads as they come and go.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * The dialog's rows, as the DOM holds them.
 * @returns {HTMLElement[]} Every place row on screen.
 */
function rowsOnScreen() {
  return /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.workspace-create-overlay .setup-row')));
}

/**
 * Fill the fixture provider's directory field and report the edit, the way a
 * keystroke does.
 * @param {string} dir - Where the workspace is going.
 */
function typeDirectory(dir) {
  const field = /** @type {HTMLInputElement|null} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
  if (!field) throw new Error('the fixture provider\'s form is not on screen');
  field.value = dir;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Press one of the dialog's buttons.
 * @param {string} selector - Which one.
 */
function press(selector) {
  const button = /** @type {HTMLButtonElement|null} */ (document.querySelector(`.workspace-create-overlay ${selector}`));
  if (!button) throw new Error(`no ${selector} on screen`);
  button.click();
}

/**
 * Run the workspace-create-dialog tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('workspace-create-dialog-test', async ({ run, session, projectPath }) => {
    const projectOps = createBoundOps(() => ({}));

    // Registered rather than reset into place, like the fixture: a reset would
    // take the real providers out from under whatever else is on this page, and
    // an id nobody else uses needs no room made for it. It lands after the
    // fixture, so the fixture stays the kind the dialog opens on.
    if (!workspaceProviderRegistry.get(SecondKindProvider.MANIFEST.id)) {
      workspaceProviderRegistry.registerClass(SecondKindProvider, { extensionId: 'test', modulePath: '(test)' });
    }

    await run('it offers only the ways to make one', async () => {
      // The suite has a registered workspace on the table and the session has a
      // project, so both of the bands this dialog drops are populated: if it
      // were sharing the setup panel's list they would be here.
      const everywhere = setupRows(session);
      assert(everywhere.some((row) => row.kind === 'project'),
        'the shared list still offers the project folder');
      assert(everywhere.some((row) => row.kind === 'workspace'),
        'and the workspace this suite registered');

      const offered = workspaceCreatePlaces(session);
      assert(!offered.some((row) => row.kind === 'project' || row.kind === 'workspace'),
        `but making one offers neither, got ${JSON.stringify(offered.map((row) => row.kind))}`);
      assert(offered.some((row) => row.kind === 'new'),
        'and does offer the providers that could build one');

      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => rowsOnScreen().length > 0, 2000);
        const kinds = rowsOnScreen().map((row) => row.dataset.rowKind);
        assert(!kinds.includes('project') && !kinds.includes('workspace'),
          `and draws neither either, got ${JSON.stringify(kinds)}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('it opens on a kind, with that kind\'s advice beside its form', async () => {
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-detail') !== null, 2000);
        const detail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-detail'));

        assert(detail.querySelector('.workspace-create-detail-title')?.textContent === FixtureProvider.MANIFEST.name,
          `the chosen kind names itself in its own half, got ${JSON.stringify(detail.textContent)}`);
        // The point of splitting the dialog: what a provider says one of its
        // places is good and bad for is on screen while the form is filled in,
        // rather than behind the click that selects the row.
        assert(detail.textContent?.includes('a test that wants to read its own advice back'),
          `with what it is best for, unasked, got ${JSON.stringify(detail.textContent)}`);
        assert(detail.textContent?.includes('anything anybody is relying on'),
          `and what it is not for, got ${JSON.stringify(detail.textContent)}`);
        assert(detail.querySelector('#fixture-dir'),
          'and the provider\'s own fields, with no click to get to them');

        // Nothing is built by arriving: a selection says which form is showing.
        const create = /** @type {HTMLButtonElement} */ (document.querySelector('.workspace-create-commit'));
        assert(create.disabled,
          'and Create is refused until the form says it may be pressed');
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('Create makes a workspace with nothing bound to it', async () => {
      const name = 'create-dialog-tree';
      const dir = `${projectPath}/${name}`;
      /** @type {any} */
      let made = null;
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-overlay #fixture-dir') !== null, 2000);
        typeDirectory(dir);
        press('.workspace-create-commit');

        made = await settled;
        assert(made.created === true && typeof made.workspaceId === 'string' && made.workspaceId !== '',
          `it reports what it made, got ${JSON.stringify(made)}`);

        const row = (session.workspaces ?? []).find((/** @type {any} */ w) => w.id === made.workspaceId);
        assert(row,
          'and puts it on this window\'s table rather than waiting for the broadcast');
        assert(row.root === dir,
          `where the form said, got ${JSON.stringify(row.root)}`);

        // The whole reason for the dialog: a place, with nothing in it. Every
        // conversation this session holds is somewhere else.
        const inside = Array.from(session.conversations.values())
          .filter((/** @type {any} */ c) => c.workspaceId === made.workspaceId);
        assert(inside.length === 0,
          `and nothing is bound to it, got ${inside.length} conversation(s)`);
        // No undo comes back with it. Making one selects it, which puts the
        // panel for it on screen, and that panel already carries the provider's
        // own ways of being finished with a tree.
        assert(made.undo === undefined,
          'and offers no second, briefer way to discard it');
      } finally {
        if (made?.workspaceId) await unregisterWorkspace(made.workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('the rail is one tab stop, and the arrows walk it', async () => {
      // The kinds are a radio group, so the whole rail holds one stop in the tab
      // order and the arrows move within it. A group that took a stop per row
      // would put every provider an extension installs between the dialog and
      // its Create button.
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => rowsOnScreen().length > 1, 2000);
        const stops = rowsOnScreen().filter((row) => row.tabIndex === 0);
        assert(stops.length === 1,
          `the rail holds exactly one tab stop, got ${stops.length} of ${rowsOnScreen().length} rows`);

        const first = rowsOnScreen()[0];
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

        // Selecting rebuilds the rail under the key that selected it, so the row
        // to read is the one now in that position rather than the node that was
        // there before.
        const after = rowsOnScreen();
        assert(after[1]?.getAttribute('aria-checked') === 'true',
          `walking down selects as it goes, got ${JSON.stringify(after.map((r) => r.getAttribute('aria-checked')))}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('a form being filled in survives what the dialog learns behind it', async () => {
      // The adoption probe lands whenever it lands. Redrawing the dialog around
      // an open form would take the focus out of the field mid-word and throw
      // away what had been typed, so a form on screen outranks anything that
      // arrived on its own.
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-overlay #fixture-dir') !== null, 2000);
        const field = /** @type {HTMLInputElement} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
        field.focus();
        typeDirectory(`${projectPath}/half-typed`);

        // The probe the dialog runs as it opens, settled and asking for a redraw.
        await probeSetupAdoptions(session);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const still = /** @type {HTMLInputElement|null} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
        assert(still === field,
          'the field being typed into is the same element afterwards, not one rebuilt under the cursor');
        assert(still?.value === `${projectPath}/half-typed`,
          `and still holds what was typed into it, got ${JSON.stringify(still?.value)}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('cancelling builds nothing', async () => {
      const before = (session.workspaces ?? []).length;
      const settled = openWorkspaceCreate(session);
      await waitFor(() => document.querySelector('.workspace-create-overlay #fixture-dir') !== null, 2000);
      typeDirectory(`${projectPath}/never-built`);
      press('.workspace-create-cancel');

      const outcome = await settled;
      assert(outcome.created === false,
        `a dialog dismissed made nothing, got ${JSON.stringify(outcome)}`);
      assert((session.workspaces ?? []).length === before,
        'and left the table as it was');
      assert(!document.querySelector('.workspace-create-overlay'),
        'and took itself off the screen');
    });
  });
}

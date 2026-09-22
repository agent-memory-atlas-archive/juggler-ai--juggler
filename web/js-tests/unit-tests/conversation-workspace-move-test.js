//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The box header, the workspace panel, the move dialog, and reconcile.
 *
 * The surfaces a workspace is seen and steered through, and the sweep that puts
 * the table back together. A move is the act with the most to lose,
 * so it is asked about work it would leave behind, refused audibly when the
 * service says no, and able to build somewhere new and move into it in one act
 * — or be called off leaving nothing behind and nobody moved.
 * @module unit-tests/conversation-workspace-move-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { registerWorkspace, unregisterWorkspace, listWorkspaces } from '../../js/services/workspaces.js';
import {
  workspaceStatus,
  workspaceFinishOptions,
  PROVIDER_UNAVAILABLE
} from '../../js/services/workspace-provisioning.js';
import { reconcileWorkspaces } from '../../js/services/workspace-reconcile.js';
import {
  NEW_ROW_PREFIX,
  setupRows,
  probeSetupAdoptions,
  adoptSetupRow
} from '../../js/services/workspace-places.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import { openWorkspaceMove } from '../../js/components/workspace-move-dialog.js';
import '../../js/components/workspace-box-header.js';
import '../../js/components/workspace-panel.js';
import {
  runWorkspaceSuite,
  FixtureProvider,
  abandonProvision,
  fileTurnsUp,
  makeConversation,
  readIn,
  seededFile,
  workspaceRow
} from '../utilities/conversation-workspace-helpers.js';

/**
 * This suite makes and removes directories directly in the shared fixture root,
 * which a sibling lane walking the project reads as they come and go, so no
 * other lane may be in flight while it runs.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * Run the conversation-workspace-move tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-move-test', async ({ run, session, projectPath, release }) => {
    await run('the box names the place; the panel says everything else about it', async () => {
      // Everything here is true of the TREE and not of whoever is working in
      // it — the label, the kind, the path, the endings — which is why it is
      // said once for the workspace instead of once inside each conversation's
      // composer. What is missing is as deliberate: moving ONE conversation
      // names none of the tabs in a box, so it is not here, and neither is the
      // project, which is drawn flat and has nothing to be finished with.
      //
      // The split between the two surfaces is the subject: a strip two hundred
      // pixels wide gets the name, and the panel a selected box opens gets
      // everything that wants room to be read and aimed at.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_head', '/tmp/head-tree', {
          label: 'feat/heads',
          providerId: FixtureProvider.MANIFEST.id
        }),
        workspaceRow('ws_orphan', '/tmp/orphan-tree', {
          label: 'made by something gone',
          providerId: '@someone/uninstalled'
        })
      ];
      const header = /** @type {any} */ (document.createElement('workspace-box-header'));
      document.body.appendChild(header);
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      try {
        const bound = await makeConversation(session, 'header-bound', { workspaceId: 'ws_head' });
        release(bound);
        header.setContext({ session, workspace: session.workspaces[0] });

        const label = header.querySelector('.conversation-box-label');
        assert(label?.textContent === 'feat/heads',
          `the box names the place its conversations work in, got ${JSON.stringify(label?.textContent)}`);
        assert(!header.querySelector('button'),
          'and nothing else: a title, a status line and two buttons in the width of a tab is what the panel exists to undo');

        session.selectWorkspace('ws_head');
        panel._refresh();
        assert(panel.textContent?.includes('/tmp/head-tree'),
          `selecting it says which tree that is, got ${JSON.stringify(panel.textContent)}`);
        assert(panel.querySelector('[data-action="done"]'),
          `with the ways to be done with it, from the provider that made it, got ${JSON.stringify(panel.textContent)}`);
        assert(!panel.querySelector('[data-action="move"]'),
          'and not the move, which is one conversation\'s business and belongs on its tab');

        // An extension can be uninstalled while its workspaces stay on the
        // table. The conversations keep working; only what the provider
        // supplied goes, and it goes for a stated reason.
        session.selectWorkspace('ws_orphan');
        panel._refresh();
        assert(!panel.querySelector('[data-action]'),
          'a workspace whose provider is gone offers no endings');
        assert(panel.textContent?.includes(PROVIDER_UNAVAILABLE),
          `and says why rather than looking like a workspace with nothing to do, got ${JSON.stringify(panel.textContent)}`);
        assert(panel.querySelector('.workspace-panel-title')?.textContent === 'made by something gone',
          `keeping the row's own name, which nothing else here is left to say, got ${JSON.stringify(panel.textContent)}`);

        // A box is only ever drawn for a workspace there is something to say
        // about: the bar draws one per usable row and nothing for the rest. A
        // header told about no workspace draws nothing rather than a frame
        // around an empty statement.
        header.setContext({ session, workspace: null });
        assert(!header.querySelector('.conversation-box-title'),
          `a header about nothing shows nothing, got ${JSON.stringify(header.textContent)}`);
      } finally {
        header.remove();
        panel.remove();
        session.selection = null;
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
      }
    });

    await run('an ending that asks for something is asked; one that does not is confirmed', async () => {
      // The host used to know one provider's action id by name — it collected a
      // commit message for anything called `commit` — which is a promise it
      // could only keep for the provider that was written first. An ending now
      // says for itself whether it needs something typed, and the panel asks
      // for it exactly when it is wanted.
      //
      // The two are asked for in different surfaces, which is the point of the
      // assertions below: an ending that wants something typed gets the finish
      // dialog, where the field is named; one that wants nothing gets a confirm.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_asked', '/tmp/asked-tree', {
          label: 'feat/asked',
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return request.type === 'prompt' ? 'a note' : true;
      };
      try {
        const bound = await makeConversation(session, 'header-asked', { workspaceId: 'ws_asked' });
        release(bound);
        session.selectWorkspace('ws_asked');
        panel._refresh();
        FixtureProvider.lastFinish = null;

        /** @type {any} */ (panel.querySelector('[data-action="note"]')).click();

        await waitFor(() => !!document.querySelector('.workspace-finish-overlay .setup-field-input'),
          'the finish dialog for an ending that asks for something');
        const dialog = /** @type {any} */ (document.querySelector('.workspace-finish-overlay'));
        assert(!asked.length,
          `an ending declaring a prompt gets its own dialog, not the generic box, got ${JSON.stringify(asked[0]?.type)}`);

        const caption = /** @type {any} */ (dialog.querySelector('label.setup-field-label'));
        const field = /** @type {any} */ (dialog.querySelector('.setup-field-input'));
        assert(caption?.htmlFor === field?.id && caption?.textContent === 'Note',
          `with the field named as the ending named it, got ${JSON.stringify(caption?.textContent)}`);
        assert(dialog.textContent?.includes('It is written into the workspace'),
          `and the hint the ending wrote, got ${JSON.stringify(dialog.textContent)}`);

        field.value = 'a note';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        /** @type {any} */ (dialog.querySelector('.workspace-finish-commit')).click();

        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'note',
          'the ending that asks for something to run');
        assert(FixtureProvider.lastFinish?.input?.message === 'a note',
          `and what was typed reaches finish, got ${JSON.stringify(FixtureProvider.lastFinish?.input)}`);

        asked.length = 0;
        FixtureProvider.lastFinish = null;
        panel._refresh();
        /** @type {any} */ (panel.querySelector('[data-action="leave"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'leave',
          'the ending that asks for nothing to run');
        assert(asked[0]?.type === 'confirm',
          `an ending declaring none is confirmed instead, got ${JSON.stringify(asked[0]?.type)}`);
        assert(!FixtureProvider.lastFinish?.input?.message,
          `and carries nothing it never collected, got ${JSON.stringify(FixtureProvider.lastFinish?.input)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        panel.remove();
        session.selection = null;
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
        FixtureProvider.lastFinish = null;
      }
    });

    await run('the panel says each thing once, in the order it is wanted', async () => {
      // A small menu found four ways to say "feat/menu", and every ending
      // printed the sentence the dialog was about to print again. What a row is
      // FOR decides where its words go: the head names the place, the state
      // section names the state, and the sentence somebody agrees to belongs
      // where they agree to it.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_menu', '/tmp/menu-tree', {
          label: 'feat/menu (worktree)',
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return request.type === 'prompt' ? '' : true;
      };
      FixtureProvider.reported = { detail: 'feat/menu · clean' };
      FixtureProvider.discardDescription = 'Removes the tree and deletes feat/menu.';
      try {
        const bound = await makeConversation(session, 'header-menu', { workspaceId: 'ws_menu' });
        release(bound);
        session.selectWorkspace('ws_menu');
        panel._refresh();
        await waitFor(() => panel.textContent?.includes('feat/menu · clean'),
          'the status the provider reported to reach the panel');

        const text = String(panel.textContent ?? '');
        const says = (/** @type {string} */ selector) =>
          panel.querySelector(`${selector} .workspace-panel-action-name`)?.textContent ?? '';
        assert(panel.querySelector('.workspace-panel-title')?.textContent === 'feat/menu (worktree)',
          `the panel names the place, which is the name on its row, got ${JSON.stringify(text)}`);
        assert(panel.querySelector('.workspace-panel-kind')?.textContent === FixtureProvider.MANIFEST.name,
          `then what kind of place that is, got ${JSON.stringify(text)}`);
        assert(text.includes('/tmp/menu-tree') && text.includes('feat/menu · clean'),
          `then where it is and how it is doing, got ${JSON.stringify(text)}`);
        assert(text.split('(worktree)').length - 1 === 1,
          `each of which is said once: a small menu once found four ways to say "feat/menu", got ${JSON.stringify(text)}`);

        // The address, whole and in one piece. Anything that elides part of a
        // path hides the one segment that tells two places apart: every scratch
        // copy ever made ends in the same `work` directory, and what it is a
        // copy OF is the segment above that — which is exactly what an ellipsis
        // ate.
        const box = panel.querySelector('.workspace-panel-path');
        assert(box?.textContent === '/tmp/menu-tree',
          `the path is shown whole, in one element, got ${JSON.stringify(box?.textContent)}`);
        const acts = (/** @type {string} */ selector) =>
          panel.querySelector(`.workspace-panel-path-row ${selector}`);
        assert(acts('[aria-label="Copy path to clipboard"]') && acts('reveal-button'),
          'and carries the copy and reveal buttons every other path in the app has');

        // Left edges, because the fault this catches — `align-items: center`
        // inherited into a column, which centres every stacked section —
        // changes no class name and nothing else would see it.
        const edge = (/** @type {any} */ element) => element?.getBoundingClientRect().left ?? -1;
        const headings = [...panel.querySelectorAll('.workspace-panel-heading')];
        const gutter = edge(headings[0]);
        assert(gutter > 0 && headings.every((/** @type {any} */ h) => Math.abs(edge(h) - gutter) < 1),
          `every section starts at the same edge, got ${JSON.stringify(headings.map(edge))}`);
        assert(Math.abs(edge(panel.querySelector('.workspace-panel-path-row')) - gutter) < 1,
          'and so does the path');

        // What pressing a button will do is written under it, where it is read
        // BEFORE the decision. A label cannot carry it: "Leave it be" does not
        // say whether anything on disk is about to go, and a sentence somebody
        // has to hover to find is a sentence nobody reads. An ending says what
        // becomes of the PLACE; what becomes of the conversations working in it
        // is the host's to say, since it is the host that moves them and a
        // provider cannot know how many there are.
        const note = (/** @type {string} */ selector) =>
          panel.querySelector(`${selector} .workspace-panel-action-note`)?.textContent ?? '';
        assert(note('[data-action="leave"]').includes('Nothing changes on disk'),
          `every ending says what becomes of the tree, got ${JSON.stringify(note('[data-action="leave"]'))}`);
        assert(says('[data-action="note"]') === 'Leave a note…',
          `one that will ask for something says so with an ellipsis, got ${JSON.stringify(says('[data-action="note"]'))}`);
        assert(says('[data-action="leave"]') === 'Leave it be',
          'and one that only needs agreeing to does not');

        // An action that leaves the workspace in use is not an ending and is not
        // filed under one: committing is the case this exists for, and it sat
        // under "when you're done" for as long as it closed the workspace half
        // the time.
        const endings = panel.querySelector('.workspace-panel-endings');
        assert(endings?.querySelector('.workspace-panel-heading')?.textContent
          === 'When you’re done with this workspace',
        'the endings are grouped under what they are for');
        const doing = [...panel.querySelectorAll('.workspace-panel-doing [data-action]')];
        assert(doing.map((/** @type {any} */ row) => row.dataset.action).join(',') === 'note',
          `what keeps the workspace sits above the endings, got ${JSON.stringify(doing.map((/** @type {any} */ row) => row.textContent))}`);
        assert([...endings.querySelectorAll('[data-action]')]
          .map((/** @type {any} */ row) => row.dataset.action).join(',') === 'done,leave,discard',
        'and every way of not working here any more is under the heading that says so');

        // A destructive ending is marked as one. That is what warns, and it
        // warns wherever the button happens to sit.
        assert(panel.querySelector('[data-action="discard"]')?.classList.contains('danger')
          && !panel.querySelector('[data-action="leave"]')?.classList.contains('danger'),
        'an ending that takes something away is marked, and one that does not is not');

        // And again at the point of no return, where it is agreed to.
        asked.length = 0;
        FixtureProvider.lastFinish = null;
        /** @type {any} */ (panel.querySelector('[data-action="discard"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'discard',
          'the destructive ending to run once it is agreed to');
        assert(String(asked[0]?.message ?? '').includes('Removes the tree and deletes feat/menu.'),
          `with what it costs said in the dialog, got ${JSON.stringify(asked[0]?.message)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        panel.remove();
        session.selection = null;
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
        FixtureProvider.reported = null;
        FixtureProvider.discardDescription = null;
        FixtureProvider.lastFinish = null;
      }
    });

    await run('the dialog moves a conversation, and its instructions move with it', async () => {
      // The box header reports and finishes; this is where one conversation
      // changes its mind about where it belongs. The
      // move itself is `rebindConversation`'s — what the dialog adds is the
      // choice, which is why the assertion below is about the instructions the
      // model reads and not only about the id in the metadata.
      const stamp = Math.random().toString(36).slice(2, 8);
      const from = `dialog-from-${stamp}`;
      const to = `dialog-to-${stamp}`;
      const fromMarker = `# instructions of the tree it started in ${stamp}`;
      const toMarker = `# instructions of the tree it moved to ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${from}/AGENTS.md`, content: fromMarker });
      await writeFileOp({ path: `${to}/AGENTS.md`, content: toMarker });
      const madeFrom = await registerWorkspace({
        root: `${projectPath}/${from}`, label: 'where it started', state: 'ready'
      });
      const madeTo = await registerWorkspace({
        root: `${projectPath}/${to}`, label: 'where it moved to', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom, madeTo];
      // Lanes share one project fixture and another of them builds git
      // repositories in it, so whether the tree being left reads as dirty is
      // not this case's business: whatever is asked, the answer is yes.
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      try {
        const moved = await makeConversation(session, 'moved-by-the-dialog',
          { workspaceId: madeFrom.id });
        release(moved);
        const before = await seededFile(moved, 'AGENTS.md').createContextText({ forRequest: true });
        assert(before.includes(fromMarker),
          `precondition: it reads the instructions of the tree it starts in, got ${JSON.stringify(before)}`);
        await waitFor(() => typeof seededFile(moved, 'AGENTS.md')?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const settled = openWorkspaceMove(moved);
        const dialog = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        assert(dialog, 'opening it puts a dialog on screen');
        // Where it works now is a standing fact, and an address is only a fact
        // when it is whole: the dialog states the tree being left in full and
        // offers the two things anybody wants from a path on screen.
        const stated = dialog.querySelector('.workspace-move-now-path');
        assert(stated?.textContent === `${projectPath}/${from}`,
          `the tree being left is stated in full, got ${JSON.stringify(stated?.textContent)}`);
        assert(dialog.querySelector('.workspace-move-now [aria-label="Copy path to clipboard"]')
          && dialog.querySelector('.workspace-move-now reveal-button'),
        'and can be copied or shown on disk without leaving the dialog');
        assert(!dialog.querySelector(`.setup-row[data-row-id="${madeFrom.id}"]`),
          'the tree it already works in is not one of the places it could move to');
        const row = /** @type {any} */ (dialog.querySelector(`.setup-row[data-row-id="${madeTo.id}"]`));
        assert(row, `while every other ready workspace is, got ${JSON.stringify(dialog.textContent)}`);
        assert(/** @type {HTMLButtonElement} */ (dialog.querySelector('.workspace-move-commit')).disabled,
          'and with nothing chosen there is nothing to press');

        row.click();
        /** @type {any} */ (dialog.querySelector('.workspace-move-commit')).click();
        const outcome = await settled;
        assert(outcome.moved === true && moved.workspaceId === madeTo.id,
          `choosing one and pressing it moves the conversation, got ${JSON.stringify(outcome)}`);
        assert(!document.querySelector('.workspace-move-overlay'),
          'and the dialog closes behind it');

        await waitFor(() => (seededFile(moved, 'AGENTS.md')?.data.content || '') !== before,
          { description: 'the move to take the snapshot again' });
        const after = await seededFile(moved, 'AGENTS.md').createContextText({});
        assert(after.includes(toMarker),
          `a conversation moved through the dialog reads the instructions of the tree it is in, got ${JSON.stringify(after)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        // An assertion that fails between opening the dialog and pressing it
        // leaves the overlay on screen, and every case after this one queries
        // for one and finds it — one failure then reads as the whole suite
        // hanging. Whatever happened above, the screen is cleared here.
        document.querySelector('.workspace-move-overlay')?.remove();
        session.workspaces = saved;
        await unregisterWorkspace(madeFrom.id).catch(() => {});
        await unregisterWorkspace(madeTo.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [from, to] });
      }
    });

    await run('a move out of a tree holding work offers to bring it, and never half brings it', async () => {
      // The offer is on screen before the button is pressed, rather than in a
      // dialog stacked over this one: what it decides is what the press will do,
      // so it has to be readable at the moment of pressing. Nothing is brought
      // unless it is asked for — copying files into somebody's tree is a write,
      // and an unasked write is as wrong as the loss it would be preventing.
      const stamp = Math.random().toString(36).slice(2, 8);
      const fromDir = `offer-from-${stamp}`;
      const toDir = `offer-to-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      for (const dir of [fromDir, toDir]) {
        await writeFileOp({ path: `${dir}/shared.txt`, content: 'the commit both trees start from\n' });
        const git = `git -C ${dir} -c user.name=Juggler -c user.email=tests@juggler.invalid -c commit.gpgsign=false`;
        await project.shell({ command: `git -C ${dir} init -q` });
        await project.shell({ command: `${git} add -A` });
        await project.shell({ command: `${git} commit -q -m baseline` });
      }
      await writeFileOp({ path: `${fromDir}/note.txt`, content: 'look at this file I created\n' });

      const madeFrom = await registerWorkspace({
        root: `${projectPath}/${fromDir}`, label: 'a tree with work in it', state: 'ready'
      });
      const madeTo = await registerWorkspace({
        root: `${projectPath}/${toDir}`, label: 'somewhere else', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom, madeTo];
      const destination = createBoundOps(() => ({ workspaceId: madeTo.id }));
      // Nothing here should ask anything in a modal of its own. Stubbed so that
      // an accidental one is an assertion rather than a suite hung to its cap.
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return true;
      };
      try {
        const left = await makeConversation(session, 'moving-and-leaving-it', { workspaceId: madeFrom.id });
        release(left);
        const first = openWorkspaceMove(left);
        const dialog = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        await waitFor(() => dialog.querySelector('.workspace-move-carry'),
          { description: 'the dialog to find out what the tree it is leaving holds' });
        assert(/uncommitted work in 1 file/.test(String(dialog.querySelector('.workspace-move-work-lead')?.textContent ?? '')),
          `it says what is there and how much of it, got ${JSON.stringify(dialog.querySelector('.workspace-move-work-lead')?.textContent)}`);
        assert(/** @type {HTMLInputElement} */ (dialog.querySelector('.workspace-move-carry-box')).checked === false,
          'and offers to bring it without having decided to');

        /** @type {any} */ (dialog.querySelector(`.setup-row[data-row-id="${madeTo.id}"]`)).click();
        /** @type {any} */ (dialog.querySelector('.workspace-move-commit')).click();
        const leftBehind = await first;
        assert(leftBehind.moved === true && left.workspaceId === madeTo.id,
          `a move nobody ticked moves the conversation, got ${JSON.stringify(leftBehind)}`);
        assert((await destination.stat({ path: 'note.txt' })).exists === false,
          'and leaves the work where it was made');

        // The same move, ticked. The tick is made before the choice of where, so
        // that surviving the redraw a choice causes is part of what is asserted.
        const bringing = await makeConversation(session, 'moving-and-bringing-it', { workspaceId: madeFrom.id });
        release(bringing);
        const second = openWorkspaceMove(bringing);
        const again = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        await waitFor(() => again.querySelector('.workspace-move-carry-box'),
          { description: 'the offer to appear again' });
        /** @type {any} */ (again.querySelector('.workspace-move-carry-box')).click();
        /** @type {any} */ (again.querySelector(`.setup-row[data-row-id="${madeTo.id}"]`)).click();
        assert(/** @type {HTMLInputElement} */ (again.querySelector('.workspace-move-carry-box')).checked === true,
          'choosing where to go does not quietly untick bringing the work');
        /** @type {any} */ (again.querySelector('.workspace-move-commit')).click();
        const brought = await second;
        assert(brought.moved === true, `it moves, got ${JSON.stringify(brought)}`);
        const arrived = await destination.readFile({ path: 'note.txt' });
        assert(String(arrived?.content ?? '').includes('look at this file I created'),
          `and the file is there to be looked at, got ${JSON.stringify(arrived?.content)}`);

        // Now the two trees disagree about a file. The refusal is shown where
        // the choice was made, and the way past it is a second, deliberate press.
        await writeFileOp({ path: `${toDir}/shared.txt`, content: 'the destination went its own way\n' });
        await writeFileOp({ path: `${fromDir}/shared.txt`, content: 'the source went its own way\n' });
        const contested = await makeConversation(session, 'moving-into-an-argument', { workspaceId: madeFrom.id });
        release(contested);
        const third = openWorkspaceMove(contested);
        const last = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        await waitFor(() => last.querySelector('.workspace-move-carry-box'),
          { description: 'the offer to appear a third time' });
        /** @type {any} */ (last.querySelector('.workspace-move-carry-box')).click();
        /** @type {any} */ (last.querySelector(`.setup-row[data-row-id="${madeTo.id}"]`)).click();
        /** @type {any} */ (last.querySelector('.workspace-move-commit')).click();

        await waitFor(() => last.querySelector('.workspace-move-overwrite'),
          { description: 'the refusal and the way past it' });
        assert(/shared\.txt/.test(String(last.querySelector('.setup-error')?.textContent ?? '')),
          `the file they disagree about is named, got ${JSON.stringify(last.querySelector('.setup-error')?.textContent)}`);
        assert(contested.workspaceId === madeFrom.id,
          `and until that is answered nobody has moved, got ${JSON.stringify(contested.workspaceId)}`);

        /** @type {any} */ (last.querySelector('.workspace-move-overwrite')).click();
        const forced = await third;
        assert(forced.moved === true,
          `someone who read that and meant it gets it, got ${JSON.stringify(forced)}`);
        const overwritten = await destination.readFile({ path: 'shared.txt' });
        assert(String(overwritten?.content ?? '').includes('the source went its own way'),
          `and the tree moved out of is what is there, got ${JSON.stringify(overwritten?.content)}`);

        assert(asked.length === 0,
          `none of it is asked in a dialog over the dialog, got ${JSON.stringify(asked)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        session.workspaces = saved;
        await unregisterWorkspace(madeFrom.id).catch(() => {});
        await unregisterWorkspace(madeTo.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [fromDir, toDir] });
      }
    });

    await run('a move the service refuses is said in the dialog, not swallowed', async () => {
      // The refusal belongs to `rebindConversation` — a service whose safety
      // lives in its caller has none — so what is tested here is that the caller
      // does something with the answer. A dialog that closes on a refusal would
      // read as a move that happened.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'somewhere it cannot go yet', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      // As above: the shared fixture's cleanliness is another case's subject.
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      try {
        const busy = await makeConversation(session, 'busy-when-asked-to-move');
        release(busy);
        Object.defineProperty(busy, 'isProcessing', { get: () => true, configurable: true });

        const settled = openWorkspaceMove(busy);
        const dialog = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        /** @type {any} */ (dialog.querySelector(`.setup-row[data-row-id="${made.id}"]`)).click();
        /** @type {any} */ (dialog.querySelector('.workspace-move-commit')).click();

        await waitFor(() => document.querySelector('.workspace-move-overlay .setup-error'),
          { description: 'the refusal to be shown where the choice was made' });
        const said = document.querySelector('.workspace-move-overlay .setup-error')?.textContent ?? '';
        assert(/turn/i.test(said),
          `and to say what stopped it, got ${JSON.stringify(said)}`);
        assert((busy.workspaceId || '') === '',
          `with the conversation left where it was, got ${JSON.stringify(busy.workspaceId)}`);

        // The dialog is still open on the same choice, so the answer to "now
        // then?" is one press rather than starting again.
        Object.defineProperty(busy, 'isProcessing', { get: () => false, configurable: true });
        /** @type {any} */ (document.querySelector('.workspace-move-commit')).click();
        const outcome = await settled;
        assert(outcome.moved === true && busy.workspaceId === made.id,
          `and once the turn is over the same press goes through, got ${JSON.stringify(outcome)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('the dialog can build somewhere new and move into it in one act', async () => {
      // Provisioning for a conversation that already exists is
      // `provisionWorkspace` and nothing else — `ensureInitialised` is nowhere
      // in this path, and neither is the setup record, which the send path reads
      // to decide whether to park a message. A conversation moving house goes on
      // sending while its tree is built.
      const name = `dialog-new-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      /** @type {string} */
      let built = '';
      // As in the cases above: this conversation is leaving the shared project
      // fixture, whose dirtiness belongs to whichever lane is building a
      // repository in it just now.
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      try {
        const moving = await makeConversation(session, 'moving-into-a-new-one');
        release(moving);

        const settled = openWorkspaceMove(moving);
        const dialog = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        const newRow = /** @type {any} */ (dialog.querySelector(
          `.setup-row[data-row-id="${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}"]`));
        assert(newRow,
          `a conversation under way may make somewhere new, not only pick what exists, got ${JSON.stringify(dialog.textContent)}`);

        newRow.click();
        const field = /** @type {HTMLInputElement} */ (document.querySelector('.workspace-move-overlay #fixture-dir'));
        assert(field, 'choosing it expands the provider\'s own form, the same one the panel shows');
        const before = /** @type {HTMLButtonElement} */ (document.querySelector('.workspace-move-commit'));
        assert(before.disabled,
          'and the button waits until the form says it may be pressed');
        assert(/create/i.test(before.textContent ?? ''),
          `saying what pressing it will do, got ${JSON.stringify(before.textContent)}`);

        field.value = dir;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        assert(document.querySelectorAll('.workspace-move-overlay').length === 1,
          `precondition: one dialog on screen, got ${document.querySelectorAll('.workspace-move-overlay').length}`);
        const armed = /** @type {HTMLButtonElement} */ (document.querySelector('.workspace-move-commit'));
        assert(!armed.disabled,
          'naming a destination arms the button, which is the form reporting itself');
        armed.click();

        // A provision that cannot finish leaves the dialog open on its own
        // error, which is right for a user and a hang for a case that only ever
        // waits to be closed.
        await waitFor(() => (moving.workspaceId || '') !== '' || !!document.querySelector('.workspace-move-overlay .setup-error'),
          { description: 'the workspace to be built and the conversation moved into it' });
        const failure = document.querySelector('.workspace-move-overlay .setup-error')?.textContent ?? '';
        assert(!failure, `the provision finished, got ${JSON.stringify(failure)}`);

        const outcome = await settled;
        built = moving.workspaceId;
        assert(outcome.moved === true && built,
          `the conversation ends up in what was built, got ${JSON.stringify(outcome)}`);
        const row = (await listWorkspaces()).find((/** @type {any} */ ws) => ws.id === built);
        assert(row?.state === 'ready' && row?.root === dir,
          `left as a ready row rooted where the form said, got ${JSON.stringify(row)}`);
        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'and really built there, by the provider that offered to');
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        if (built) await unregisterWorkspace(built).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('calling off a move\'s build leaves nothing behind and nobody moved', async () => {
      // The same compensation stack the setup panel's Cancel runs, reached from
      // the other view. What makes this worth its own case is that a move can be
      // called off *after* the conversation has work in it: the thing that must
      // survive intact is a conversation that is already under way.
      const name = `dialog-cancel-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      try {
        const moving = await makeConversation(session, 'called-it-off');
        release(moving);

        const settled = openWorkspaceMove(moving);
        /** @type {any} */ (document.querySelector(
          `.workspace-move-overlay .setup-row[data-row-id="${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}"]`)).click();
        const field = /** @type {HTMLInputElement} */ (document.querySelector('.workspace-move-overlay #fixture-dir'));
        const stall = /** @type {HTMLInputElement} */ (document.querySelector('.workspace-move-overlay #fixture-stall'));
        field.value = dir;
        // Long enough that the cancel lands inside the slow step rather than
        // after a provision that finished while nobody was looking.
        stall.value = '3000';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        /** @type {any} */ (document.querySelector('.workspace-move-commit')).click();

        await waitFor(() => /Waiting about/.test(
          document.querySelector('.workspace-move-overlay')?.textContent ?? ''),
        { description: 'the slow step to be named, which is the dialog saying what it is waiting on' });
        /** @type {any} */ (document.querySelector('.workspace-move-overlay .setup-cancel')).click();

        await waitFor(() => !document.querySelector('.workspace-move-overlay .setup-progress'),
          { description: 'the unwinding to finish and the choice to come back' });
        assert((moving.workspaceId || '') === '',
          `a move called off moves nobody, got ${JSON.stringify(moving.workspaceId)}`);
        assert(!(await projectOps.stat({ path: name })).exists,
          'and what had been built is unwound rather than left for someone to find');
        assert(!(await listWorkspaces()).some((/** @type {any} */ ws) => ws.root === dir),
          'with no half-made row left on the table');
        assert(document.querySelector('.workspace-move-overlay'),
          'while the dialog is still open, because the user cancelled a build and not the question');

        /** @type {any} */ (document.querySelector('.workspace-move-cancel')).click();
        const outcome = await settled;
        assert(outcome.moved === false,
          `and closing it reports that nothing happened, got ${JSON.stringify(outcome)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('the dialog offers a tree that exists and no row knows about', async () => {
      // The pool, from the other end: a tree somebody built by hand is one click
      // from being somewhere this conversation works, with no provisioning and
      // no recompile. Adoption is what makes "move into wt2" cost nothing.
      const name = `dialog-adopt-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      /** @type {string} */
      let adoptedId = '';
      try {
        await writeFileOp({ path: `${name}/AGENTS.md`, content: `# a tree nobody registered ${name}` });
        FixtureProvider.report = {
          orphanedWorkspaces: [],
          orphanedArtifacts: [{
            id: name,
            label: 'a tree nobody registered',
            detail: dir,
            workspace: { kind: 'local', root: dir, label: 'a tree nobody registered' }
          }],
          confirmed: []
        };

        const moving = await makeConversation(session, 'moving-into-what-was-there');
        release(moving);
        const settled = openWorkspaceMove(moving);

        await waitFor(() => document.querySelector('.workspace-move-overlay .setup-row-adopt'),
          { description: 'the provider to say what exists that the table has never heard of' });
        /** @type {any} */ (document.querySelector('.workspace-move-overlay .setup-row-adopt')).click();

        await waitFor(() => (session.workspaces ?? []).some((/** @type {any} */ row) => row.root === dir),
          { description: 'the offer to be taken up and registered' });
        adoptedId = (session.workspaces ?? []).find((/** @type {any} */ row) => row.root === dir)?.id ?? '';
        const chosen = /** @type {HTMLElement|null} */ (
          document.querySelector(`.workspace-move-overlay .setup-row[data-row-id="${adoptedId}"]`));
        assert(chosen?.getAttribute('aria-checked') === 'true',
          'adopting chooses it, because the click has to do something visible');

        /** @type {any} */ (document.querySelector('.workspace-move-commit')).click();
        const outcome = await settled;
        assert(outcome.moved === true && moving.workspaceId === adoptedId,
          `and one more press moves the conversation into it, got ${JSON.stringify(outcome)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        FixtureProvider.report = null;
        if (adoptedId) await unregisterWorkspace(adoptedId).catch(() => {});
        session.workspaces = (session.workspaces ?? []).filter((/** @type {any} */ row) => row.root !== dir);
        await projectOps.copyTree({ to: '.', delete: [name] });
      }
    });

    // The three cases below share one thing that can only happen once: the
    // server's reconcile claim is spent by the first client that asks for it.
    // They therefore run in this order deliberately — the first proves it does
    // NOT spend the claim, and the proof of that is the second one still
    // getting it.
    await run('a client with no providers loaded leaves the claim for one that has', async () => {
      // The engine realm is the case this is really about: it runs a
      // ConnectionManager too, and has no provider registry at all. It cannot
      // be stood up inside a viewer test, but the condition that matters is the
      // same one — nothing loaded that could do the work — and burning the
      // one-shot claim from there would disable reconcile for the whole run.
      workspaceProviderRegistry.reset();
      let pass;
      try {
        pass = await reconcileWorkspaces(session);
      } finally {
        workspaceProviderRegistry.registerClass(FixtureProvider, { extensionId: 'test', modulePath: '(test)' });
      }
      assert(pass.ran === false,
        'a client that can reconcile nothing does not offer to');
      assert(/no workspace providers/.test(pass.reason ?? ''),
        `and says why, got ${JSON.stringify(pass.reason)}`);
    });

    await run('reconcile undoes an interrupted provision and leaves other providers alone', async () => {
      const name = `fixture-sweep-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));

      // One row this provider made and never finished, and one belonging to a
      // provider nothing has loaded — an extension the user disabled after
      // making a workspace with it.
      const mine = await abandonProvision(session, { dir, dirStallMs: 2000 },
        () => fileTurnsUp(projectOps, name, 5000).then(() => {}));
      const theirs = await registerWorkspace({
        kind: 'local',
        root: `${projectPath}/src`,
        providerId: '@someone/uninstalled',
        state: 'provisioning',
        meta: { dir: `${projectPath}/src` }
      });
      // And a third: a place that is still there but is no longer what its row
      // says — a pooled tree switched to another branch while the app was shut.
      // It is the one failure nothing downstream catches, because every
      // operation against it succeeds, so the sweep closes it here.
      const moved = await registerWorkspace({
        kind: 'local',
        root: `${projectPath}/src`,
        providerId: FixtureProvider.MANIFEST.id,
        state: 'ready',
        meta: { dir: `${projectPath}/src` }
      });
      FixtureProvider.report = {
        orphanedWorkspaces: [{ ...moved, tombstone: true, reason: 'it is on somebody/else now.' }],
        orphanedArtifacts: [],
        confirmed: []
      };

      try {
        const pass = await reconcileWorkspaces(session);
        assert(pass.ran === true,
          `this client took the claim, got ${JSON.stringify(pass.reason)}`);
        assert(pass.cleaned.includes(mine.id),
          `the interrupted provision was undone and removed, got ${JSON.stringify(pass.cleaned)}`);
        assert(!(await projectOps.stat({ path: name })).exists,
          'and what it had built is gone from disk');

        const remaining = await listWorkspaces();
        assert(remaining.some(ws => ws.id === theirs.id),
          'while the row whose provider is not loaded is left exactly where it was');
        assert((await projectOps.stat({ path: 'src' })).exists,
          'and nothing of its went near the tree it names');

        const tombstoned = remaining.find(ws => ws.id === moved.id);
        assert(tombstoned?.state === 'closed',
          `a row its provider says is no longer what it claims is closed, got ${JSON.stringify(tombstoned?.state)}`);
        assert(/somebody\/else/.test(String(tombstoned?.meta?.closedReason ?? '')),
          `carrying the reason, for the banner its conversations will show, got ${JSON.stringify(tombstoned?.meta)}`);
        assert((await projectOps.stat({ path: 'src' })).exists,
          'and closing a row is not removing a tree — the place itself is untouched');
      } finally {
        FixtureProvider.report = null;
        await unregisterWorkspace(moved.id).catch(() => {});
        await unregisterWorkspace(theirs.id).catch(() => {});
        await unregisterWorkspace(mine.id).catch(() => {});
      }
    });

    await run('a place with no workspace is offered, adopted in one click, and then bindable', async () => {
      // The cheapest honest version of pooled working: a tree that exists and is
      // already built is one click from being somewhere a conversation works,
      // with no pool-release machinery and no fresh-tree recompile.
      const name = `adopt-me-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      // A second tree, found by the same sweep and belonging to nothing this
      // case is about. The offer band lists what every provider can find, and
      // the project root is shared, so "the offer" is never this case's offer
      // on its own: an assertion that counted the adopt rows, or read the only
      // one, was asserting that no sibling case had a tree of its own out at
      // the same moment. Every assertion below names its tree by the id the row
      // carries, and the decoy is what holds them to it.
      const decoy = `adopt-decoy-${Math.random().toString(36).slice(2, 8)}`;
      const decoyDir = `${projectPath}/${decoy}`;
      /**
       * @param {string} tree - The directory whose offer is wanted.
       * @returns {(row: any) => boolean} Whether a row is that tree's offer.
       */
      const offerOf = (tree) => (row) =>
        row.kind === 'adopt' && String(row.id).endsWith(`\u0000${tree}`);
      const projectOps = createBoundOps(() => ({}));
      const saved = session.workspaces;
      /** @type {any} */
      let adopted = null;
      /** @type {any} The decoy, taken up at the end so the offer table is left as it was found. */
      let adoptedDecoy = null;
      try {
        await projectOps.shell({ command: `mkdir -p ${name} ${decoy}` });
        FixtureProvider.report = {
          orphanedWorkspaces: [],
          orphanedArtifacts: [{
            id: `fixture\u0000${name}`,
            label: name,
            detail: 'somewhere with no workspace',
            workspace: { root: dir, label: `${name} (adopted)`, meta: { dir } }
          }, {
            id: `fixture\u0000${decoy}`,
            label: decoy,
            detail: 'somewhere else with no workspace',
            workspace: { root: decoyDir, label: decoy, meta: { dir: decoyDir } }
          }],
          confirmed: []
        };

        await probeSetupAdoptions(session);
        const offered = setupRows(session).filter(offerOf(name));
        assert(offered.length === 1 && offered[0]?.label === name,
          `what exists and has no row is offered in the panel, got ${JSON.stringify(offered)}`);
        assert(setupRows(session).some(offerOf(decoy)),
          'alongside every other place a provider can find, which is no business of this case');

        adopted = await adoptSetupRow(session, String(offered[0]?.id));
        assert(adopted?.state === 'ready',
          `adopting registers it, ready to be worked in, got ${JSON.stringify(adopted)}`);
        assert(adopted?.providerId === FixtureProvider.MANIFEST.id,
          `owned by the provider that found it, so it can be finished with, got ${JSON.stringify(adopted?.providerId)}`);
        assert(adopted?.root === dir,
          `where the provider said it was, got ${JSON.stringify(adopted?.root)}`);

        session.workspaces = [...saved, adopted];
        const rows = setupRows(session);
        assert(rows.some((/** @type {any} */ row) => row.kind === 'workspace' && row.id === adopted.id),
          'and it is then offered exactly where every other workspace is');
        assert(!rows.some(offerOf(name)),
          'while the offer to adopt it is gone, having been taken');
        // What "gone" is measured against. An adopt band that emptied would
        // satisfy the line above without the offer having been taken at all.
        const stray = rows.find(offerOf(decoy));
        assert(stray,
          'and the offer nobody took is still there, which is what makes the one above an answer about this tree');

        // Taken up as well, because the offer table belongs to the panel rather
        // than to this case: an offer invented here and left on it is the fault
        // the decoy exists to catch, arriving one case later.
        adoptedDecoy = await adoptSetupRow(session, String(stray?.id));
      } finally {
        FixtureProvider.report = null;
        session.workspaces = saved;
        if (adopted) await unregisterWorkspace(adopted.id).catch(() => {});
        if (adoptedDecoy) await unregisterWorkspace(adoptedDecoy.id).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name} ${decoy}` }).catch(() => {});
      }
    });

    await run('a workspace outlives the provider that made it', async () => {
      // The guarantee the whole indirection was built for. An extension can be
      // disabled at any moment, and when it is, the conversations bound to the
      // workspaces it made must lose the provider's FEATURES and nothing else.
      // `src/` again, because `greeter.js` exists only there: a read that
      // quietly resolved against the project would come back missing.
      const made = await registerWorkspace({
        root: `${projectPath}/src`,
        label: 'made by something no longer installed',
        providerId: '@someone/uninstalled',
        state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        const bound = await makeConversation(session, 'orphaned-provider', { workspaceId: made.id });
        release(bound);
        const read = await readIn(session, bound, 'greeter.js');
        assert(read.exists !== false,
          `a bound conversation still works in its tree with no provider loaded, got ${JSON.stringify(read)}`);
        assert(bound.workspaceRoot === `${projectPath}/src`,
          `and still resolves its binding, got ${JSON.stringify(bound.workspaceRoot)}`);

        const status = await workspaceStatus(session, made);
        assert(status.providerMissing === true && status.problem === PROVIDER_UNAVAILABLE,
          `status says the provider is gone rather than throwing, got ${JSON.stringify(status)}`);
        assert(!status.detail,
          `and says it as a problem, not as a description of the tree, got ${JSON.stringify(status.detail)}`);
        assert(made.label === 'made by something no longer installed',
          `while the row goes on naming the workspace, which is what every surface reads, got ${JSON.stringify(made.label)}`);

        const finish = await workspaceFinishOptions(session, made);
        assert(finish.options.length === 0 && finish.unavailableReason === PROVIDER_UNAVAILABLE,
          `and the finish menu is empty for a stated reason rather than silently, got ${JSON.stringify(finish)}`);
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('a second client finds the reconcile already claimed', async () => {
      const pass = await reconcileWorkspaces(session);
      assert(pass.ran === false,
        'the claim answers yes once and no afterwards');
      assert(/another client/.test(pass.reason ?? ''),
        `and the second client is told which of the two reasons applies, got ${JSON.stringify(pass.reason)}`);
    });
  });
}

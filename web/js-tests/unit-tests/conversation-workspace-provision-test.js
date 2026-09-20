//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Building the place a conversation will work in.
 *
 * A provision makes something on disk, so every way it can stop half way is a
 * case here: cancelled, aborted inside a step, or interrupted by a restart that
 * leaves only the checkpoints behind. Each must leave nothing, and say so. The
 * setup form is the other half — what it offers, what selecting a row does, and
 * the undo window that closes once the conversation has content.
 * @module unit-tests/conversation-workspace-provision-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { registerWorkspace, unregisterWorkspace, listWorkspaces } from '../../js/services/workspaces.js';
import { provisionWorkspace } from '../../js/services/workspace-provisioning.js';
import {
  PROJECT_ROW_ID,
  NEW_ROW_PREFIX,
  setupRows,
  getSetupState,
  selectSetupRow,
  setSetupValues,
  createSelectedWorkspace,
  cancelSetupProvision,
  undoSetup,
  subscribeSetup
} from '../../js/services/conversation-setup.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import { ensureConversationChrome } from '../../js/components/conversation-area-rendering.js';
import { buildPlaceRows } from '../../js/components/workspace-setup-form.js';
import {
  runWorkspaceSuite,
  FixtureProvider,
  abandonProvision,
  bannerFor,
  columnFor,
  fileTurnsUp,
  makeConversation,
  readIn,
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
 * Run the conversation-workspace-provision tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-provision-test', async ({ run, session, projectPath, release }) => {
    await run('a workspace provider is built from the registry, and a missing one is simply missing', async () => {
      // The registry is asked for providers by id, and the id comes off a
      // workspace row that outlives whatever made it. So the miss is not an
      // error case — it is what a user gets for disabling an extension after
      // making a worktree with it, and it must cost them the provider rather
      // than the workspace.
      //
      // From an empty registry, because the suite is handed one that already
      // has the fixture provider in it and `registerClass` refuses an id that
      // is taken: asked without the reset, this would be proving the refusal.
      workspaceProviderRegistry.reset();
      const registration = workspaceProviderRegistry.registerClass(FixtureProvider, {
        extensionId: 'test',
        modulePath: '(test)'
      });
      assert(registration.registered,
        `registerClass refused the fixture provider: ${registration.reason}`);

      const provider = workspaceProviderRegistry.createProvider(FixtureProvider.MANIFEST.id, session);
      assert(provider instanceof FixtureProvider,
        `the registry builds the class it was given, got ${provider?.constructor?.name}`);
      assert(provider?.getSetupLabel() === 'Somewhere else',
        `a provider with no setupLabel is offered under its name, got ${provider?.getSetupLabel()}`);

      assert(workspaceProviderRegistry.createProvider('nothing-of-the-sort', session) === undefined,
        'while a provider nothing registered comes back as nothing, rather than throwing');
    });

    await run('the seeds also read the instructions of a tree the provider names', async () => {
      // A workspace root is not always the only place whose instructions apply.
      // A worktree of a subrepo, and a folder inside the project, both leave the
      // project's own AGENTS.md unread when the root is the only place probed.
      // The host cannot work out which other place counts — walking up from a
      // worktree reaches the user's home directory, not the project — so the
      // provider is asked, and the host still owns which names count, the
      // content-hash dedup and the skip for what the user pinned themselves.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `instructions-${stamp}`;
      const marker = `# instructions from the place the provider named ${stamp}`;
      const ownMarker = `# instructions of the workspace itself ${stamp}`;
      await writeFileOp({ path: `${elsewhere}/.cursorrules`, content: marker });
      // Writing the workspace's own file is also what makes its root exist,
      // which the server insists on before anything may be worked in there.
      await writeFileOp({ path: `folder-${stamp}/.instructions`, content: ownMarker });

      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: {
          root: `${projectPath}/folder-${stamp}`,
          label: 'a folder with instructions above it',
          state: 'ready',
          providerId: 'fixture-workspace-provider'
        }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      FixtureProvider.extraRoots = [`${projectPath}/${elsewhere}`];
      try {
        const bound = await makeConversation(session, `seeded-from-above-${stamp}`, { workspaceId: id });
        release(bound);

        const files = bound.rootMessageThread.contextItems
          .filter((/** @type {any} */ item) => item.type === 'file-content');
        const named = files.find(
          (/** @type {any} */ item) => item.data.path === `${projectPath}/${elsewhere}/.cursorrules`);
        assert(named,
          `the conversation is seeded from the directory the provider named, got ${JSON.stringify(files.map((/** @type {any} */ i) => i.data.path))}`);

        // The path is absolute because it is outside the tree the conversation
        // works in: a workspace-relative `../` would read as a file of the
        // workspace's own, both to the model and in the properties panel.
        const text = await named.createContextText({});
        assert(text.includes(marker),
          `and reads it from there rather than from its own root, got ${JSON.stringify(text)}`);

        // Nearest last. What the tree says for itself is the last word, so it
        // sits below the wider instructions rather than above them.
        const own = files.findIndex((/** @type {any} */ item) => item.data.path === '.instructions');
        assert(own > files.indexOf(named),
          `and the workspace's own instructions are seeded after the wider ones, got ${JSON.stringify(files.map((/** @type {any} */ i) => i.data.path))}`);
      } finally {
        FixtureProvider.extraRoots = [];
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a provision builds the place, registers it ready, and can be taken back', async () => {
      const name = `fixture-ws-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));

      const outcome = await provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir }
      });
      try {
        assert(outcome.workspace.state === 'ready',
          `a finished provision leaves a ready row, got ${outcome.workspace.state}`);
        assert(outcome.workspace.root === dir,
          `rooted where the provider said, got ${outcome.workspace.root}`);
        assert(outcome.workspace.label === 'made by the fixture',
          `labelled as the provider named it, got ${outcome.workspace.label}`);
        assert(outcome.workspace.providerId === FixtureProvider.MANIFEST.id,
          `attributed to the provider that built it, got ${outcome.workspace.providerId}`);

        // Through the new workspace's own id, which only resolves because the
        // row reached `ready` — the same path a bound conversation's tools take.
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        assert((await inside.stat({ path: 'made-here.txt' })).exists,
          'and the thing it built is really there');
      } finally {
        await outcome.undo();
      }

      assert(!(await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
        'undo runs the same compensations and removes what was built');
      const remaining = await listWorkspaces();
      assert(!remaining.some(ws => ws.id === outcome.workspace.id),
        'and takes the row off the table with it');
    });

    await run('cancelling mid-provision rejects and leaves nothing behind', async () => {
      // The claim the whole feature is sold on: a mis-click costs nothing. It
      // has to be true of the disk as well as of the table, which is why this
      // looks for the directory afterwards rather than trusting the row count.
      const name = `fixture-cancel-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const controller = new AbortController();

      const running = provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir, stallMs: 2000 },
        signal: controller.signal
      });
      /** @type {any[]} */
      const rejections = [];
      const settled = running.then(() => {}, (error) => { rejections.push(error); });

      assert(await fileTurnsUp(projectOps, name, 5000),
        'the provision never got as far as making anything, so cancelling it proves nothing');
      controller.abort();
      await settled;

      assert(rejections.length === 1,
        `a cancelled provision rejects rather than resolving, got ${rejections.length} rejections`);
      assert(!(await projectOps.stat({ path: name })).exists,
        'and the directory it had already made is gone again');
      // By the tree this provision was building, not by its provider: the table
      // is the whole project's, and every other case's workspaces are on it.
      const remaining = await listWorkspaces();
      assert(!remaining.some(ws => ws.root === dir),
        'and no half-built row is left on the table');
    });

    await run('an abort inside a step still unwinds the thing that step made', async () => {
      // The window an inverse pushed AFTER its step falls through. The command
      // makes the directory and then keeps running; the abort rejects the
      // operation, so a provider that records its undo on the next line never
      // records it at all, and the directory it made outlives the provision
      // that made it. Recording before the step is what closes that, and this
      // case is what fails if the ordering is ever quietly reversed.
      const name = `fixture-window-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const controller = new AbortController();

      const running = provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir, dirStallMs: 2000 },
        signal: controller.signal
      });
      /** @type {any[]} */
      const rejections = [];
      const settled = running.then(() => {}, (error) => { rejections.push(error); });

      assert(await fileTurnsUp(projectOps, name, 5000),
        'the step never made its directory, so there is no window to land in');
      controller.abort();
      await settled;

      assert(rejections.length === 1,
        `the provision is abandoned at the abort, got ${rejections.length} rejections`);
      assert(!(await projectOps.stat({ path: name })).exists,
        'and the directory that existed at the instant of the abort is removed anyway');
    });

    await run('a provision interrupted by a restart is undone from its checkpoints alone', async () => {
      // No closure survives a restart, so the compensation stack cannot be the
      // whole story: what is left is the row, its `meta`, and whatever reached
      // disk. This runs the same provision to each checkpoint boundary, throws
      // the closures away, and asks the provider to undo it from `meta` — which
      // is exactly what the load-time sweep will do.
      const projectOps = createBoundOps(() => ({}));
      const provider = workspaceProviderRegistry.createProvider(FixtureProvider.MANIFEST.id, session);
      const cleanupCtx = {
        session,
        ops: projectOps,
        baseWorkspaceId: '',
        signal: new AbortController().signal,
        rollback: { push: () => {} },
        checkpoint: async () => {},
        progress: () => {}
      };

      // Boundary one: the directory is made, the marker is not.
      const firstName = `fixture-restart-a-${Math.random().toString(36).slice(2, 8)}`;
      const firstDir = `${projectPath}/${firstName}`;
      const first = await abandonProvision(session, { dir: firstDir, dirStallMs: 2000 },
        () => fileTurnsUp(projectOps, firstName, 5000).then(() => {}));
      try {
        assert(first?.meta?.dir === firstDir && first?.meta?.marked === undefined,
          `the row records the step it reached and no further, got ${JSON.stringify(first?.meta)}`);
        assert((await projectOps.stat({ path: firstName })).exists,
          'and what it built is still on disk, which is the mess to be cleared');

        const cleaned = await provider?.cleanupPartial(first, cleanupCtx);
        assert(cleaned?.removed === true,
          `cleanupPartial reports it dealt with the row, got ${JSON.stringify(cleaned)}`);
        assert(!(await projectOps.stat({ path: firstName })).exists,
          'and leaves the same nothing behind that cancelling would have');
      } finally {
        await unregisterWorkspace(first.id).catch(() => {});
      }

      // Boundary two: both steps landed; the row was simply never flipped to ready.
      const secondName = `fixture-restart-b-${Math.random().toString(36).slice(2, 8)}`;
      const secondDir = `${projectPath}/${secondName}`;
      const second = await abandonProvision(session, { dir: secondDir });
      try {
        assert(second?.meta?.marked === true,
          `the row records having got as far as the marker, got ${JSON.stringify(second?.meta)}`);
        assert((await projectOps.stat({ path: `${secondName}/made-here.txt` })).exists,
          'and the marker really is there, so removing it means something');

        await provider?.cleanupPartial(second, cleanupCtx);
        assert(!(await projectOps.stat({ path: secondName })).exists,
          'cleanupPartial removes the later step and the earlier one together');
      } finally {
        await unregisterWorkspace(second.id).catch(() => {});
      }

      // A checkpoint is written BEFORE the step it describes, so `meta` routinely
      // claims a step that never happened. Undoing that must be uneventful.
      const ghostName = `fixture-restart-c-${Math.random().toString(36).slice(2, 8)}`;
      const ghost = await registerWorkspace({
        kind: 'local',
        root: `${projectPath}/${ghostName}`,
        providerId: FixtureProvider.MANIFEST.id,
        state: 'provisioning',
        meta: { dir: `${projectPath}/${ghostName}`, marked: true }
      });
      try {
        const cleaned = await provider?.cleanupPartial(ghost, cleanupCtx);
        assert(cleaned?.removed === true,
          `a checkpoint describing a step that never landed cleans up quietly, got ${JSON.stringify(cleaned)}`);
      } finally {
        await unregisterWorkspace(ghost.id).catch(() => {});
      }
    });

    await run('a probe that failed does not become the row it was probing', async () => {
      // `detail` describes the place; `problem` says why nobody could describe
      // it. They are separate fields precisely so this cannot happen: the row's
      // detail line is where a reader looks for WHERE a place is, and a stale
      // row whose tree had gone once rendered an HTTP status there.
      const rows = [{
        kind: 'workspace',
        id: 'ws_probe_failed',
        label: 'feat/tunnels',
        detail: '/tmp/juggler-feat-tunnels'
      }];
      const failure = 'workspace feat/tunnels is missing its root: /tmp/juggler-feat-tunnels';
      const group = buildPlaceRows({
        rows,
        selection: PROJECT_ROW_ID,
        label: 'Workspace',
        statusFor: () => ({ label: 'feat/tunnels', problem: failure, statusFailed: true, available: false }),
        onSelect: () => {}
      });

      const note = group.querySelector('.setup-row-detail');
      assert(note?.textContent === '/tmp/juggler-feat-tunnels',
        `the line says where the place is, got ${JSON.stringify(note?.textContent)}`);

      // Not dropped, though — it is the only thing that says why the row is
      // dimmed, and the underlying text is never ours to throw away.
      const element = /** @type {HTMLElement|null} */ (group.querySelector('.setup-row'));
      assert(element?.title === failure,
        `and the failure is still reachable, got ${JSON.stringify(element?.title)}`);
      assert(element?.classList.contains('setup-row-away'),
        'and the row reads as somewhere that cannot be worked in');

      // A probe that succeeded is unchanged: its detail is the description, and
      // there is nothing to put in a tooltip.
      const fine = buildPlaceRows({
        rows,
        selection: PROJECT_ROW_ID,
        label: 'Workspace',
        statusFor: () => ({ label: 'feat/tunnels', detail: 'on feat/tunnels · clean', available: true }),
        onSelect: () => {}
      });
      assert(fine.querySelector('.setup-row-detail')?.textContent === 'on feat/tunnels · clean',
        'a working probe still describes the place');
      assert(!(/** @type {HTMLElement|null} */ (fine.querySelector('.setup-row'))?.title),
        'and carries no tooltip, because nothing went wrong');
    });

    await run('the setup offers the project, then what exists, then what could be made', async () => {
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_usable', '/tmp/usable', { label: 'already there' }),
        workspaceRow('ws_half', '/tmp/half', { state: 'provisioning' }),
        workspaceRow('ws_over', '/tmp/over', { state: 'closed' }),
        workspaceRow('ws_gone', '/tmp/gone', { available: false })
      ];
      try {
        const rows = setupRows(session);
        assert(rows[0]?.kind === 'project' && rows[0]?.id === PROJECT_ROW_ID,
          `the project is always the first row, got ${JSON.stringify(rows[0])}`);
        assert(rows[0]?.detail === session.projectPath,
          `and says where it is, got ${JSON.stringify(rows[0]?.detail)}`);

        const offered = rows.map((/** @type {any} */ row) => row.id);
        assert(offered.includes('ws_usable'),
          `a workspace that can be worked in is offered, got ${JSON.stringify(offered)}`);
        assert(!offered.includes('ws_half') && !offered.includes('ws_over'),
          `while one still being built and one finished with are not — both refuse every op, got ${JSON.stringify(offered)}`);
        // A ready row whose tree has gone refuses every operation just as
        // surely, and says so nowhere: offering it is offering somewhere the
        // first command will fail.
        assert(!offered.includes('ws_gone'),
          `nor is one whose root is not there, got ${JSON.stringify(offered)}`);

        // Every loaded provider, by name rather than by position: which
        // provider registered first is nobody's guarantee, and an assertion
        // that reads the first "New…" row is asserting the load order of the
        // extensions rather than the rule it says it is testing.
        const newRows = rows.filter((/** @type {any} */ row) => row.kind === 'new');
        const newIds = newRows.map((/** @type {any} */ row) => row.id);
        for (const providerId of workspaceProviderRegistry.getIds()) {
          assert(newIds.includes(`${NEW_ROW_PREFIX}${providerId}`),
            `each loaded provider offers a row to make one with; ${providerId} did not, got ${JSON.stringify(newIds)}`);
        }
        const made = newRows.find(
          (/** @type {any} */ row) => row.id === `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
        assert(made, `including this test's own, got ${JSON.stringify(newIds)}`);
        assert(made?.label === 'Somewhere else',
          `labelled as the provider asks to be offered, got ${JSON.stringify(made?.label)}`);
        assert(rows.indexOf(made) > rows.findIndex((/** @type {any} */ r) => r.id === 'ws_usable'),
          'and is offered below what already exists, which is the common path');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('selecting a row builds nothing, and committing binds what was selected', async () => {
      // The pair of rules the panel rests on: a click costs nothing, and the
      // conversation commits at its first content — so a selection made and
      // then changed leaves no trace of the one it changed from.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'src, as a choice', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        const conversation = await makeConversation(session, 'selects-a-workspace', { initialise: false });
        release(conversation);

        selectSetupRow(conversation, made.id);
        assert(conversation.workspaceId === '' && conversation.initialised === false,
          'selecting a row binds nothing and initialises nothing');
        assert(getSetupState(conversation).selection === made.id,
          `it is merely remembered, got ${JSON.stringify(getSetupState(conversation).selection)}`);

        await conversation.ensureInitialised();
        assert(conversation.workspaceId === made.id,
          `and the first content commits to it, got ${JSON.stringify(conversation.workspaceId)}`);
        // `greeter.js` is only in `src`, so a conversation seeded against the
        // project would read nothing here.
        const read = await readIn(session, conversation, 'greeter.js');
        assert(read.exists !== false,
          `with its tools working in that tree from the first turn, got ${JSON.stringify(read)}`);
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('Create builds the place, binds to it, and Undo takes both back', async () => {
      const name = `setup-create-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'creates-a-workspace', { initialise: false });
      release(conversation);
      const before = conversation.rootMessageThread.contextItems.length;

      selectSetupRow(conversation, `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
      setSetupValues(conversation, { valid: true, values: { dir } });

      /** @type {string[]} */
      const announced = [];
      const unsubscribe = subscribeSetup(() => {
        const step = getSetupState(conversation).progress.at(-1)?.step;
        if (step && announced.at(-1) !== step) announced.push(step);
      });
      try {
        const result = await createSelectedWorkspace(conversation);
        assert(result.ok, `Create finished, got ${JSON.stringify(result)}`);
        assert(announced.includes('Making the directory'),
          `and the panel was told what it was waiting on as it went, got ${JSON.stringify(announced)}`);
        assert(getSetupState(conversation).phase === 'settled',
          `the flow is over, got ${JSON.stringify(getSetupState(conversation).phase)}`);

        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'the place really was built');
        assert(conversation.workspaceId && conversation.initialised === true,
          `and the conversation is bound to it and seeded, without anything having been sent, got ${JSON.stringify(conversation.workspaceId)}`);
        assert(getSetupState(conversation).undoable === true,
          'with an undo for as long as the panel would have lived');

        await undoSetup(conversation);

        assert(!(await projectOps.stat({ path: name })).exists,
          'undo runs the same compensations the cancel would have, and the tree is gone');
        assert(conversation.workspaceId === '' && conversation.initialised === false,
          'the conversation is unbound and back to being asked');
        assert(conversation.rootMessageThread.contextItems.length === before,
          `and holds nothing that binding added, got ${conversation.rootMessageThread.contextItems.length} items against ${before}`);
        assert(getSetupState(conversation).undoable === false,
          'and the undo is spent');
      } finally {
        unsubscribe();
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('Undo says what it will remove, and asks before it takes work with it', async () => {
      // The button says one word, and what it runs is the provision's whole
      // compensation stack — for a worktree, `git worktree remove --force` and
      // a branch delete. "Undo" reads as unbinding the conversation, so the
      // sentence saying otherwise has to be on the control itself.
      const name = `setup-undo-warn-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'undo-is-not-silent', { initialise: false });
      release(conversation);

      const savedTable = session.workspaces;
      const realShowModal = /** @type {any} */ (window).showModal;
      /** @type {string[]} */
      const asked = [];
      /** @type {boolean} */
      let answer = false;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
        asked.push(options?.message || '');
        return answer;
      };
      FixtureProvider.discardDescription = 'Removes the tree and deletes feat/tunnels.';

      selectSetupRow(conversation, `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
      setSetupValues(conversation, { valid: true, values: { dir } });
      try {
        const result = await createSelectedWorkspace(conversation);
        assert(result.ok, `precondition: Create finished, got ${JSON.stringify(result)}`);
        // The banner resolves its root through the session's table, which
        // arrives as a broadcast rather than with the registration's reply.
        // The banner resolves its root through the session's own table, which
        // this harness does not keep in step with the server on its own.
        session.workspaces = await listWorkspaces();
        assert(typeof conversation.workspaceRoot === 'string',
          `precondition: the binding resolves, got row ${JSON.stringify(session.getWorkspace(conversation.workspaceId))}`);

        const undo = /** @type {HTMLButtonElement|null} */ (
          bannerFor(conversation)?.querySelector('.workspace-banner-undo'));
        assert(undo, 'the banner offers an undo while the window is open');
        assert((undo?.title ?? '').includes('Removes the tree and deletes feat/tunnels.'),
          `and carries what pressing it costs, in the provider's words, got ${JSON.stringify(undo?.title)}`);
        assert((undo?.getAttribute('aria-label') ?? '').includes('Removes the tree'),
          `including for a reader who cannot hover, got ${JSON.stringify(undo?.getAttribute('aria-label'))}`);

        // A tree somebody has written in: asked, and a no leaves everything
        // exactly where it was.
        FixtureProvider.reported = { dirty: true };
        answer = false;
        undo?.click();
        await waitFor(() => asked.length === 1, 'a dirty tree was removed without asking');
        assert(asked[0]?.includes('Removes the tree and deletes feat/tunnels.'),
          `the question names what goes, got ${JSON.stringify(asked[0])}`);
        assert(asked[0]?.includes('uncommitted work'),
          `and why it is being asked at all, got ${JSON.stringify(asked[0])}`);
        assert(getSetupState(conversation).undoable === true,
          'declining leaves the undo where it was');
        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'and leaves the tree standing, which is the whole point of asking');

        // The ordinary case — nothing has touched it — goes straight through.
        // An undo that asked every time would not be an undo.
        FixtureProvider.reported = { dirty: false };
        undo?.click();
        // Unbinding happens after the compensations have run, so this is the
        // signal that the rollback is finished rather than merely started —
        // `undoable` goes false before the first command is sent.
        await waitFor(() => conversation.workspaceId === '',
          'the undo never ran on a clean tree');
        assert(asked.length === 1,
          `and nothing further was asked, got ${JSON.stringify(asked)}`);
        assert(!(await projectOps.stat({ path: name })).exists,
          'the tree is gone, so the undo that ran was the real one');
      } finally {
        /** @type {any} */ (window).showModal = realShowModal;
        FixtureProvider.discardDescription = null;
        FixtureProvider.reported = null;
        session.workspaces = savedTable;
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('cancelling Create leaves the form as it was, and a failure says why', async () => {
      const name = `setup-cancel-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'cancels-a-workspace', { initialise: false });
      release(conversation);

      selectSetupRow(conversation, `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
      setSetupValues(conversation, { valid: true, values: { dir, stallMs: 2000 } });

      const creating = createSelectedWorkspace(conversation);
      assert(await fileTurnsUp(projectOps, name, 5000),
        'the provision never started, so cancelling it proves nothing');
      cancelSetupProvision(conversation);
      const cancelled = await creating;

      assert(cancelled.ok === false, `cancelling does not bind, got ${JSON.stringify(cancelled)}`);
      assert(!(await projectOps.stat({ path: name })).exists,
        'and what had been built is unwound');
      assert(conversation.workspaceId === '' && conversation.initialised === false,
        'the conversation is untouched by an attempt that was called off');

      const state = getSetupState(conversation);
      assert(state.phase === 'choosing', `the panel is back to the choice, got ${state.phase}`);
      assert(/** @type {any} */ (state.values).dir === dir,
        `with the values still in the form — a cancel over a typo costs one edit, got ${JSON.stringify(state.values)}`);
      assert(state.error === '',
        `and nothing that reads as an error, because the user asked for this, got ${JSON.stringify(state.error)}`);

      // A failure is the same unwinding and a different thing to say: the
      // provider gets part way and then cannot go on, and the reason is what
      // the panel has to show against the form the user can correct.
      const failName = `setup-failed-${Math.random().toString(36).slice(2, 8)}`;
      setSetupValues(conversation, {
        valid: true,
        values: { dir: `${projectPath}/${failName}`, failWith: 'fatal: invalid reference: develop' }
      });
      const failed = await createSelectedWorkspace(conversation);
      assert(failed.ok === false, 'a provision that cannot finish does not bind either');
      assert(getSetupState(conversation).error === 'fatal: invalid reference: develop',
        `and this time the panel is given the provider's own words, got ${JSON.stringify(getSetupState(conversation).error)}`);
      assert(getSetupState(conversation).phase === 'choosing',
        'while returning to the same choice state');
      assert(!(await projectOps.stat({ path: failName })).exists,
        'with the part it had built already unwound, not left for someone to find');
    });

    await run('the undo window closes when the conversation gets content', async () => {
      const name = `setup-window-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'closes-its-window', { initialise: false });
      release(conversation);

      selectSetupRow(conversation, `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
      setSetupValues(conversation, { valid: true, values: { dir } });
      const result = await createSelectedWorkspace(conversation);
      const workspaceId = conversation.workspaceId;
      try {
        assert(result.ok && getSetupState(conversation).undoable === true,
          'precondition: there is something to undo');

        await conversation.ensureInitialised();
        assert(getSetupState(conversation).undoable === false,
          'content arriving ends the window, the same trigger that would have committed the panel');

        await undoSetup(conversation);
        assert(conversation.workspaceId === workspaceId,
          'and undoing afterwards does nothing — from here it is the workspace’s own finish menu');
        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'with what was built left standing');
      } finally {
        await unregisterWorkspace(workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('with no provider loaded the transcript looks exactly as it always did', async () => {
      // The install state most people are in. There is only one place a
      // conversation could work, so there is nothing to ask and the panel
      // renders nothing at all — not an empty panel, not a heading.
      const conversation = await makeConversation(session, 'nothing-to-ask', { initialise: false });
      release(conversation);
      const { area, list } = columnFor(conversation);

      workspaceProviderRegistry.reset();
      try {
        ensureConversationChrome(area, list);
        assert(!list.querySelector('conversation-setup-panel'),
          'a conversation with one possible answer is not asked the question');
        assert(!list.querySelector('.conversation-workspace-banner'),
          'and nothing announces the project, which is where everything worked before any of this');
      } finally {
        workspaceProviderRegistry.registerClass(FixtureProvider, { extensionId: 'test', modulePath: '(test)' });
      }
    });

    await run('an unasked conversation is asked, and an answered one is not', async () => {
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'src, as an option', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        const conversation = await makeConversation(session, 'gets-asked', { initialise: false });
        release(conversation);
        const { area, list } = columnFor(conversation);
        ensureConversationChrome(area, list);

        const panel = list.querySelector('conversation-setup-panel');
        assert(panel, 'a conversation nobody has told where it works gets the panel');
        const labels = Array.from(panel.querySelectorAll('.setup-row-label'))
          .map((/** @type {any} */ row) => row.textContent);
        assert(labels[0] === 'The project folder',
          `with the project first and preselected, named after the place rather than after its position, got ${JSON.stringify(labels)}`);
        assert(labels.includes('src, as an option'),
          `and what already exists is offered, got ${JSON.stringify(labels)}`);
        // By name rather than by position. Which provider registered first is
        // nobody's guarantee, so reading the last row asks what else is loaded
        // and in what order, rather than the rule this line is about.
        const makers = Array.from(panel.querySelectorAll('.setup-row[data-row-kind="new"]'))
          .map((/** @type {any} */ row) => row.querySelector('.setup-row-label')?.textContent);
        assert(makers.includes('Somewhere else'),
          `and one row per provider that could make another, got ${JSON.stringify(makers)}`);
        assert(labels.indexOf('Somewhere else') > labels.indexOf('src, as an option'),
          `what already exists above what could be made, got ${JSON.stringify(labels)}`);
        const project = panel.querySelector('.setup-row[aria-checked="true"]');
        assert(project?.dataset.rowId === '',
          `the project is the selected row until something else is picked, got ${JSON.stringify(project?.dataset.rowId)}`);

        // Asked where the reader is, not filed above the transcript: the card
        // is the LAST thing in the column, in the slot the starting hint has to
        // itself when there is nothing to ask — and it carries that hint, so
        // the question and what to do next are one block.
        assert(list.lastElementChild === panel,
          'the card is the last thing in the column, not chrome pinned above the items, but ' +
          `the column ends with ${list.lastElementChild?.tagName}`);
        assert(panel.querySelector('.setup-hint')?.textContent?.includes('Type your message below'),
          'and the card carries the starting hint, which the overlay stands down for');

        // What happens to somebody who answers nothing, said on the row it
        // happens to. Preselection alone is a highlight nobody can read as "and
        // this is what you get" — the row's own name is, which is why it does
        // not also wear a chip saying the same word twice.
        assert(!project?.querySelector('.setup-row-badge'),
          'the project row does not also carry a badge saying it is the default, got ' +
          JSON.stringify(project?.querySelector('.setup-row-badge')?.textContent));
        assert(project?.querySelector('.setup-row-meaning')?.textContent?.includes('project folder'),
          'and says in plain words what choosing it does');

        // Every offer explains itself, including the ones an extension wrote.
        const makeOne = /** @type {any} */ (panel.querySelector('.setup-row-new'));
        assert(makeOne?.querySelector('.setup-row-meaning')?.textContent,
          'a "New…" row carries its provider\'s description as its meaning, not a bare label');

        await conversation.ensureInitialised();
        ensureConversationChrome(area, list);
        assert(!list.querySelector('conversation-setup-panel'),
          'and the panel is gone the moment the conversation has been told');
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

  });
}

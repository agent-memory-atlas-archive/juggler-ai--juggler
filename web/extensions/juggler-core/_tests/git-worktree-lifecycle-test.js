//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What happens to a worktree after it exists.
 *
 * Reconcile is the pooled entry point: trees are made and abandoned outside
 * this application entirely, so the provider has to walk what git reports and
 * say which of it it recognises, which of it it has lost, and which of it was
 * never ours. Everything after that is a way of being finished — discarding the
 * tree, unbinding from it, committing what is in it — and each one is a
 * different answer to what survives.
 * @module _tests/git-worktree-lifecycle-test
 */

import { waitFor, assert } from '../../../js-tests/utilities/test-helpers.js';
import { unregisterWorkspace, listWorkspaces } from '../../../js/services/workspaces.js';
import { provisionWorkspace, workspaceStatus, finishWorkspace } from '../../../js/services/workspace-provisioning.js';
import { setupRows, probeSetupAdoptions } from '../../../js/services/workspace-places.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import GitWorktreeWorkspaceProvider, { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  makeConversation,
  mustRun,
  buildRepo,
  snapshot,
  reconcileCtx
} from './git-worktree-helpers.js';

/**
 * This suite builds real git repositories inside the shared fixture project and
 * removes them again, so no sibling lane may be in flight while it runs.
 *
 * The directories are stamped per case and cleaned up by the case that made
 * them, which keeps them from colliding with each other — but it cannot keep
 * them out of the way of a lane that walks the *project*. Anything copying the
 * tree, listing it, or reporting on the repositories under it reads a
 * `wt-…/greeting.txt` that a case here is in the middle of deleting, and fails
 * carrying a path it has never heard of.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the git-worktree-lifecycle tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-lifecycle-test', async ({ run, ops, session, projectPath, separator, release }) => {
    await run('reconcile confirms the tree it finds, and offers the one with no workspace', async () => {
      // The pooled entry point. A heavy worktree user keeps several trees
      // compiled and switches branches in them; none of them was made by
      // Juggler, so none of them has a row — and enumerating is the whole of
      // what turns that into one click.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const repoRoot = `${projectPath}${separator}${repo}`;
      const location = defaultLocation(repoRoot, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      const pool = `${repo}-pool`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        // Made by hand, the way a pooled tree is: git knows about it and the
        // workspace table does not.
        await mustRun(ops, `git -C ${repo} worktree add -q -b pool/one ../${pool} main`);

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        const report = await provider.reconcile([outcome.workspace], reconcileCtx(session, ops));

        assert(report.confirmed?.includes(outcome.workspace.id),
          `the row whose tree is really there is vouched for, got ${JSON.stringify(report.confirmed)}`);
        assert((report.orphanedWorkspaces ?? []).length === 0,
          `and nothing is called an orphan that is not one, got ${JSON.stringify(report.orphanedWorkspaces)}`);

        const offered = (report.orphanedArtifacts ?? [])
          .find((/** @type {any} */ found) => String(found.label ?? '').includes('pool/one'));
        assert(offered,
          `the tree with no workspace is offered, got ${JSON.stringify(report.orphanedArtifacts)}`);
        assert(offered?.workspace?.root === `${repoRoot}-pool`,
          `with somewhere the server can find, in its own terms rather than the shell's, got ${JSON.stringify(offered?.workspace?.root)}`);
        assert(offered?.workspace?.meta?.branchCreatedByUs === false,
          `and a note that its branch was never ours, so finishing with it cannot delete it, got ${JSON.stringify(offered?.workspace?.meta)}`);
        assert(!(report.orphanedArtifacts ?? []).some(
          (/** @type {any} */ found) => String(found.workspace?.root ?? '').includes('feat-tunnels')),
        'while the tree that does have a row is not offered a second time');
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${pool}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${pool} ${repo}` }).catch(() => {});
      }
    });

    await run('a tree that was removed, and a tree that moved branch, are reported and left alone', async () => {
      // Two ways a row stops describing anything real, and they need different
      // answers. A tree that is gone is caught by everything downstream — the
      // server's own stat marks it unavailable and the conversation gets a
      // banner. A tree that is still there but on another branch is caught by
      // NOTHING: every operation succeeds, against work the conversation never
      // chose. Only that one is asked to be tombstoned.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const repoRoot = `${projectPath}${separator}${repo}`;
      const goneLocation = defaultLocation(repoRoot, 'gone/tree');
      const movedLocation = defaultLocation(repoRoot, 'moved/tree');
      /** @type {any} */
      let gone = null;
      /** @type {any} */
      let moved = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        gone = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: 'gone/tree', base: 'main', location: goneLocation }
        });
        moved = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: 'moved/tree', base: 'main', location: movedLocation }
        });

        // Removed by hand, behind Juggler's back — the usual way.
        await mustRun(ops, `git -C ${repo} worktree remove --force ../${repo}-gone-tree`);
        // And re-switched by hand, which is exactly what returning a pooled tree
        // to the pool does.
        await mustRun(ops, `git -C ${repo}-moved-tree switch -q -c somebody/else`);

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        const report = await provider.reconcile(
          [gone.workspace, moved.workspace], reconcileCtx(session, ops));

        const missing = (report.orphanedWorkspaces ?? [])
          .find((/** @type {any} */ row) => row.id === gone.workspace.id);
        assert(missing, `the row whose tree is gone is reported, got ${JSON.stringify(report.orphanedWorkspaces)}`);
        assert(missing?.tombstone !== true,
          'and is not asked to be closed — a tree can come back, and the stat that marks it unavailable already speaks for it');

        const wrong = (report.orphanedWorkspaces ?? [])
          .find((/** @type {any} */ row) => row.id === moved.workspace.id);
        assert(wrong?.tombstone === true,
          `while the tree on another branch is asked to be closed, got ${JSON.stringify(wrong)}`);
        assert(/somebody\/else/.test(String(wrong?.reason ?? '')),
          `saying what it is on now, got ${JSON.stringify(wrong?.reason)}`);

        assert((await ops.shell({ command: `ls ${repo}-moved-tree` })).success === true,
          'and nothing was removed by the looking: reconcile only looks');
      } finally {
        if (gone) await gone.undo().catch(() => {});
        if (moved) await moved.undo().catch(() => {});
        await ops.shell({ command: `rm -rf ${repo}-gone-tree ${repo}-moved-tree ${repo}` }).catch(() => {});
      }
    });

    await run('discarding takes the tree, and the branch when it was ours to make', async () => {
      // The destructive ending, driven through the host the chip drives: the
      // provider removes, the host tombstones, and between them the repository
      // ends up as it started.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        const before = await snapshot(ops, repo);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });

        const finished = await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'discard'
        });
        assert(finished.done === true,
          `discard reports the workspace finished with, got ${JSON.stringify(finished)}`);
        assert((await ops.shell({ command: `ls ${tree}` })).success === false,
          'the tree is gone');
        assert(await snapshot(ops, repo) === before,
          'and so is the branch we made, leaving the repository as it was found');

        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === outcome.workspace.id);
        assert(row?.state === 'closed',
          `the row is tombstoned rather than deleted, got ${JSON.stringify(row?.state)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('discarding is done from the repository, never from inside the tree', async () => {
      // Where the removal is run FROM is the whole of this case. Operations
      // handed to a finish are pinned to the workspace, so a discard driven
      // through them starts a shell whose working directory is the tree it is
      // about to delete. A POSIX shell can step out of that and carry on; on
      // Windows the directory cannot be removed at all while any process holds
      // it, and `Git\bin\bash.exe` is a launcher that holds it for the whole
      // command while the real shell it spawned does the stepping out. The
      // removal therefore goes through the base operations, naming the
      // repository relative to them, exactly as the provision's own rollback
      // does.
      //
      // Asked with a recorder rather than a real tree because the question is
      // which facade was used, which no amount of removed directories can show
      // — and asked with Windows-shaped paths so the platform that has to be
      // right about this is the one being described.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      /** @type {string[]} */
      const fromTree = [];
      /** @type {string[]} */
      const fromBase = [];
      /**
       * @param {string[]} into - Where to record what was asked for.
       * @returns {any} A facade that records and reports the tree gone.
       */
      const recorder = (into) => ({
        /**
         * @param {any} request - What the provider wants run.
         * @returns {Promise<any>} A shell result saying nothing is left.
         */
        shell: async (request) => {
          into.push(String(request.command));
          return { success: true, stdout: 'REMOVED', stderr: '', exitCode: 0 };
        }
      });
      const finished = await provider.finish(
        {
          meta: {
            repoDir: 'C:\\src\\app',
            dir: 'C:\\src\\app-feat-tunnels',
            treeRel: '../app-feat-tunnels',
            branch: BRANCH,
            branchCreatedByUs: true
          }
        },
        'discard',
        {
          session: { workspaceRoot: (/** @type {string} */ id) => (id ? 'C:\\src\\elsewhere' : 'C:\\src') },
          baseWorkspaceId: '',
          ops: recorder(fromTree),
          baseOps: recorder(fromBase),
          signal: new AbortController().signal
        }
      );

      assert(finished.done === true,
        `the discard reports the workspace finished with, got ${JSON.stringify(finished)}`);
      assert(fromTree.length === 0,
        `and nothing was run from inside the tree being removed, got ${JSON.stringify(fromTree)}`);
      assert(fromBase.length === 1,
        `while the base ran it, in one shell, got ${JSON.stringify(fromBase)}`);
      const removal = fromBase[0] ?? '';
      assert(/^cd "app" \|\| exit 1;/.test(removal),
        `starting by stepping INTO the repository rather than out of the tree, got ${JSON.stringify(removal)}`);
      assert(removal.includes('git worktree remove --force "../app-feat-tunnels"'),
        `and naming the tree relative to that repository, got ${JSON.stringify(removal)}`);
      assert(!/[A-Za-z]:[/\\]/.test(removal),
        `while no command carries an absolute Windows path, got ${JSON.stringify(removal)}`);
    });

    await run('a removal that fails says what the shell said about it', async () => {
      // The message is the only thing anyone gets when a discard does not take:
      // there is no second command to ask, and the tree is on a machine the
      // reader may not have. The shell operation answers with both streams
      // merged into `stdout` and an empty `stderr`, so a message built from
      // `stderr` alone reports the bare fallback and loses git's reason every
      // time — which is precisely how a CI failure spent three runs saying only
      // that the directory was still there.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      const finished = await provider.finish(
        {
          meta: {
            repoDir: 'C:\\src\\app',
            dir: 'C:\\src\\app-feat-tunnels',
            treeRel: '../app-feat-tunnels',
            branch: BRANCH,
            branchCreatedByUs: false
          }
        },
        'discard',
        {
          session: { workspaceRoot: () => 'C:\\src' },
          baseWorkspaceId: '',
          ops: { shell: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }) },
          baseOps: {
            shell: async () => ({
              success: false,
              stdout: 'fatal: validation failed, cannot remove working tree: it is locked\nSTILL-THERE',
              stderr: '',
              exitCode: 1
            })
          },
          signal: new AbortController().signal
        }
      );

      assert(finished.done === false,
        `a tree that is still there is not reported as finished with, got ${JSON.stringify(finished)}`);
      assert(/cannot remove working tree: it is locked/.test(String(finished.message)),
        `and the message carries what the shell said, got ${JSON.stringify(finished.message)}`);
    });

    await run('unbinding leaves the tree and the branch exactly where they are', async () => {
      // The common ending, and the one the field feedback insisted on: closing a
      // conversation must never be a reason to destroy a tree. All it ends is
      // Juggler's interest in it — and step seven's adopt is the way back.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        const after = await snapshot(ops, repo);

        const finished = await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'unbind'
        });
        assert(finished.done === true,
          `unbind finishes with the workspace, got ${JSON.stringify(finished)}`);
        assert(await snapshot(ops, repo) === after,
          'while the worktree and its branch are both still registered with git');
        assert((await ops.shell({ command: `ls ${tree}/greeting.txt` })).success === true,
          'and the files are still on disk');
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('a tree you stopped using is offered again, which is what stopping was for', async () => {
      // The whole point of keeping the tree over deleting it: the
      // files and the branch stay, so you can come back. Two things had to
      // agree for that to be true and did not. The sweep was given only live
      // rows, so a parked tree's REPOSITORY was no longer looked in at all —
      // and the offer that did survive was then dropped for sharing a root with
      // the tombstone that parked it.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      const saved = session.workspaces;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });

        const finished = await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'unbind'
        });
        assert(finished.done === true,
          `precondition: the workspace is parked rather than deleted, got ${JSON.stringify(finished)}`);

        // The table as a window holds it: the row is a tombstone now, and it is
        // the tombstone's presence that used to suppress the offer.
        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === outcome.workspace.id);
        assert(row?.state === 'closed',
          `precondition: with the row tombstoned, got ${JSON.stringify(row?.state)}`);
        session.workspaces = [...saved.filter((/** @type {any} */ w) => w.id !== row.id), row];

        await probeSetupAdoptions(session);
        const offered = setupRows(session).filter((/** @type {any} */ candidate) =>
          candidate.kind === 'adopt' && String(candidate.detail ?? '').includes(tree));
        assert(offered.length === 1,
          `the parked tree is offered for adoption again, got ${JSON.stringify(setupRows(session).map((/** @type {any} */ r) => `${r.kind}:${r.detail ?? r.label}`))}`);
        assert(/stopped using/i.test(String(offered[0]?.meaning ?? '')),
          `and says it is one you parked rather than a stray, got ${JSON.stringify(offered[0]?.meaning)}`);
      } finally {
        session.workspaces = saved;
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('committing puts what is in the tree onto its branch', async () => {
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      /** @type {any} */
      let conversation = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);

        conversation = await makeConversation(session, 'commits-its-work');
        release(conversation);

        // No message: the conversation is the one thing here that has read the
        // work, so it is asked to write one. Nothing is finished by that — the
        // commit happens in its next turn.
        const asked = await finishWorkspace({
          session,
          workspace: outcome.workspace,
          conversation,
          actionId: 'commit'
        });
        assert(asked.done === false,
          `a commit nobody has written a message for does not finish anything, got ${JSON.stringify(asked)}`);
        await waitFor(() => conversation.rootMessageThread.items.some(
          (/** @type {any} */ item) => item?.get?.('type') === 'user'
            && /commit/i.test(String(item?.get?.('content') ?? ''))),
        { description: 'the conversation to be asked to write the commit' });
        assert((await ops.shell({ command: `git -C ${tree} status --porcelain` })).stdout.includes('done.txt'),
          'with the work still uncommitted, waiting for that turn');

        const written = await finishWorkspace({
          session,
          workspace: outcome.workspace,
          conversation,
          actionId: 'commit',
          input: { message: 'Did the thing' }
        });
        // Committing is not a way of being finished with the place the commit
        // was made in, and it does not report itself as one: the workspace is
        // still in use, the conversation is still working here, and being done
        // is a separate row in a separate group of the menu. It once returned
        // `done` here and not on the path above — one field in one dialog,
        // deciding whether the workspace closed, and saying so nowhere.
        assert(written.done === false,
          `a commit leaves the workspace in use, got ${JSON.stringify(written)}`);
        assert(/committed/i.test(String(written.message ?? '')),
          `while still saying it happened, got ${JSON.stringify(written.message)}`);
        const still = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === outcome.workspace.id);
        assert(still?.state === 'ready',
          `with the workspace still there to go on working in, got ${JSON.stringify(still?.state)}`);
        const subject = await mustRun(ops, `git -C ${tree} log -1 --pretty=%s`);
        assert(subject.stdout.trim() === 'Did the thing',
          `under the message that was typed, got ${JSON.stringify(subject.stdout)}`);
        const left = await mustRun(ops, `git -C ${tree} status --porcelain`);
        assert(left.stdout.trim() === '',
          `and the tree is clean afterwards, got ${JSON.stringify(left.stdout)}`);
        const branchOf = await mustRun(ops, `git -C ${tree} rev-parse --abbrev-ref HEAD`);
        assert(branchOf.stdout.trim() === BRANCH,
          `on its own branch, not the one the repository is standing on, got ${JSON.stringify(branchOf.stdout)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('landing moves the repository’s own branch onto the work', async () => {
      // What "push it back to the repository" really is for a worktree. The
      // commit is already IN the repository the moment it exists — a worktree
      // shares the object store and the refs — so nothing is pushed anywhere.
      // What is missing is the branch the main checkout has out, and moving it
      // is a fast-forward: the one way of landing work that cannot conflict and
      // therefore needs no flow around it.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);

        // Uncommitted work stays where it is: landing moves commits, and a tree
        // that quietly left its changes behind would be the worst kind of
        // success.
        const early = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(early.done === false && /commit/i.test(String(early.message)),
          `a tree still holding work is told to commit it first, got ${JSON.stringify(early.message)}`);
        const untouched = await mustRun(ops, `git -C ${repo} log -1 --pretty=%s`);
        assert(!untouched.stdout.includes('the-work'),
          'and nothing was landed while it said so');

        await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'commit',
          input: { message: 'Did the thing' }
        });

        const landed = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(landed.done === false,
          `landing is something you do while working here, not a way of being finished with it, got ${JSON.stringify(landed)}`);
        assert(/main/.test(String(landed.message)) && /fast-forward/i.test(String(landed.message)),
          `and it says which branch moved, and how, got ${JSON.stringify(landed.message)}`);

        const onMain = await mustRun(ops, `git -C ${repo} log -1 --pretty=%s`);
        assert(onMain.stdout.trim() === 'Did the thing',
          `the repository's own branch now has the work, which is the whole point, got ${JSON.stringify(onMain.stdout)}`);
        const here = await mustRun(ops, `git -C ${repo} rev-parse main`);
        const there = await mustRun(ops, `git -C ${tree} rev-parse HEAD`);
        assert(here.stdout.trim() === there.stdout.trim(),
          'with the two exactly level, because a fast-forward is all this does');

        // Nothing left to move, and that is not a failure either.
        const again = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(/already/i.test(String(again.message)),
          `landing what is already landed says so plainly, got ${JSON.stringify(again.message)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('landing refuses what a fast-forward cannot do, and says what git said', async () => {
      // The two refusals worth having. A main checkout that has moved on cannot
      // be fast-forwarded at all — that is a merge, with conflicts in it, which
      // is a flow rather than a button — and a main checkout on no branch has
      // nothing to move.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);
        await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'commit',
          input: { message: 'Did the thing' }
        });

        // The repository carries on while the worktree works, which is what
        // having a worktree is for — and it is what makes a fast-forward
        // impossible.
        await mustRun(ops, `echo meanwhile > ${repo}/other.txt`);
        await mustRun(ops, `git -C ${repo} add -A`);
        await mustRun(ops, `git -C ${repo} commit -q -m "Meanwhile, on main"`);

        const diverged = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(diverged.done === false,
          `a land that could not happen is not reported as one that did, got ${JSON.stringify(diverged)}`);
        assert(/moved on/i.test(String(diverged.message)),
          `it says why in words before git's own, got ${JSON.stringify(diverged.message)}`);
        assert(/fast-forward/i.test(String(diverged.message)),
          `and keeps git's text under them, got ${JSON.stringify(diverged.message)}`);
        const stillThere = await mustRun(ops, `git -C ${repo} log -1 --pretty=%s`);
        assert(stillThere.stdout.trim() === 'Meanwhile, on main',
          `with the repository exactly as it was, got ${JSON.stringify(stillThere.stdout)}`);

        // On no branch at all: there is nothing to land onto, and a merge here
        // would move a detached HEAD, which is nobody's idea of landing work.
        await mustRun(ops, `git -C ${repo} checkout -q --detach`);
        const detached = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(/branch/i.test(String(detached.message)) && detached.done === false,
          `a repository on no branch is told as that, got ${JSON.stringify(detached.message)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('a commit that will not go through says which half refused, in git’s own words', async () => {
      // Every one of these is ordinary — a lock left by a crashed git, a
      // pre-commit hook that fails the lint, a tree somebody already committed
      // from a terminal — and the only thing the user gets is the sentence this
      // returns. Two things it must do: keep git's own text, which is the half
      // that says what to do about it, and put a plain lead above it saying
      // which of the two commands refused, because `git add` failing and `git
      // commit` failing want opposite reactions.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      /** @type {any[]} */
      const asked = [];
      /**
       * @param {(command: string) => any} answer - What git says to each command.
       * @returns {any} Operations that record what they were asked and answer for git.
       */
      const recorder = (answer) => ({
        /**
         * @param {any} request - What the provider wants run.
         * @returns {Promise<any>} What git said about it.
         */
        shell: async (request) => {
          asked.push(request);
          // Both streams merged into `stdout` with an empty `stderr`, which is
          // what the shell operation really answers with.
          return { stderr: '', exitCode: 1, ...answer(String(request.command)) };
        }
      });
      /**
       * @param {(command: string) => any} answer - What git says.
       * @returns {Promise<any>} What the commit reported.
       */
      const commit = (answer) => provider.finish(
        { meta: { branch: BRANCH, dir: 'the-tree' } },
        'commit',
        {
          session,
          ops: recorder(answer),
          baseOps: recorder(answer),
          input: { message: 'Did the thing' },
          signal: new AbortController().signal
        });

      const locked = await commit((command) => (command.startsWith('git add')
        ? { success: false, stdout: 'fatal: Unable to create \'.git/index.lock\': File exists.', exitCode: 128 }
        : { success: true, stdout: '', exitCode: 0 }));
      assert(locked.done === false && /Couldn’t stage/.test(String(locked.message)),
        `staging refused is said as staging refused, got ${JSON.stringify(locked.message)}`);
      assert(/index\.lock/.test(String(locked.message)),
        `with git's own reason under it rather than in place of it, got ${JSON.stringify(locked.message)}`);

      const hooked = await commit((command) => (command.startsWith('git commit')
        ? { success: false, stdout: '.husky/pre-commit: 3 problems (3 errors)', exitCode: 1 }
        : { success: true, stdout: '', exitCode: 0 }));
      assert(/Couldn’t make the commit/.test(String(hooked.message)),
        `and a commit refused is said as the commit refusing, which is a different thing to go and fix, got ${JSON.stringify(hooked.message)}`);
      assert(/pre-commit/.test(String(hooked.message)),
        `carrying what the hook printed, got ${JSON.stringify(hooked.message)}`);

      // Not a failure at all, and reported as the fact it is. It is what a
      // second press lands on, and what a tree somebody committed from a
      // terminal answers — neither of them is anything gone wrong.
      const idle = await commit((command) => (command.startsWith('git commit')
        ? { success: false, stdout: 'nothing to commit, working tree clean', exitCode: 1 }
        : { success: true, stdout: '', exitCode: 0 }));
      assert(/nothing/i.test(String(idle.message)) && !/Couldn’t/.test(String(idle.message)),
        `a tree with nothing in it to commit is told plainly, not reported as a failure, got ${JSON.stringify(idle.message)}`);

      // The deadline. A repository whose pre-commit hook runs the linter takes
      // longer than the operations' 30s default, and what that default does is
      // kill git's process group with everything already staged and nothing on
      // screen to say so.
      assert(asked.length > 0 && asked.every((request) => Number(request.timeout) > 30000),
        `every command a commit runs outlives the default deadline, got ${JSON.stringify(asked.map((r) => r.timeout))}`);
    });

    await run('a new tree reports itself clean, and says so again once it is not', async () => {
      // What the chip and the panel both read. The tree is asked through the
      // host's own `workspaceStatus`, which is how a surface asks — so a provider
      // that threw, or that answered nothing, comes back with no `dirty` at all
      // and fails these assertions rather than passing them.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });

        const fresh = await workspaceStatus(session, outcome.workspace);
        assert(fresh.dirty === false,
          `a tree nobody has touched holds no work of the user's, got ${JSON.stringify(fresh)}`);
        assert(outcome.workspace.label === BRANCH,
          `and is named by its branch, got ${JSON.stringify(outcome.workspace.label)}`);
        assert(fresh.detail?.includes('clean') && fresh.detail?.includes(BRANCH),
          `which is what it says, along with the branch it says it of, got ${JSON.stringify(fresh.detail)}`);

        // Ours, not theirs. Nothing of Juggler's is written into a workspace
        // root any more, but a tree made by an older build may still hold one,
        // and reading it as the user's work would offer to commit a directory
        // they never made.
        await mustRun(ops, `mkdir -p ${tree}/.juggler`);
        await mustRun(ops, `echo leftovers > ${tree}/.juggler/spill.json`);
        const ours = await workspaceStatus(session, outcome.workspace);
        assert(ours.dirty === false,
          `a stray .juggler/ is not the user's work, got ${JSON.stringify(ours)}`);

        await mustRun(ops, `echo scribble > ${tree}/notes.txt`);
        const theirs = await workspaceStatus(session, outcome.workspace);
        assert(theirs.dirty === true,
          `a file they wrote is, got ${JSON.stringify(theirs)}`);
        assert(theirs.detail?.includes('1 changed'),
          `and it is counted once, not twice, got ${JSON.stringify(theirs.detail)}`);
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

  });
}

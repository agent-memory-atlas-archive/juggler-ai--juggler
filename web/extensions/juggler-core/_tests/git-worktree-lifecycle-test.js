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
import { setupRows, probeSetupAdoptions } from '../../../js/services/conversation-setup.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
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
      // The whole point of "Stop using this workspace" over "Delete it": the
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

    await run('a new tree reports itself clean, and says so again once it is not', async () => {
      // What the chip and the panel both read. The tree is asked through the
      // host's own `workspaceStatus`, which is how a surface asks — so a provider
      // that threw, or that answered nothing, comes back as a label with no
      // `dirty` at all and fails these assertions rather than passing them.
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
        assert(fresh.label === BRANCH,
          `and is named by its branch, got ${JSON.stringify(fresh.label)}`);
        assert(fresh.detail?.includes('clean'),
          `which is what it says, got ${JSON.stringify(fresh.detail)}`);

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

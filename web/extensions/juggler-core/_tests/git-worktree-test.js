//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The git worktree provider, and the two facts everything about it rests on.
 *
 * A worktree lives BESIDE the repository it came from — `../repo-branch` — and
 * in ordinary use the repository is the project, so the tree the provider makes
 * is outside the root the command that makes it is confined to. Both halves of
 * that are assumed everywhere in the design and neither had ever been run:
 * whether a command pinned to the project may write outside it, and whether a
 * workspace registered out there resolves a conversation's operations to it.
 *
 * So this suite builds a real repository inside the fixture and a real worktree
 * outside it, because the questions are about git and about the path clamp, and
 * a mock of either would answer whatever it was written to answer.
 *
 * What the provider's own cases are about is what is left behind. A provision
 * that stops half way — cancelled during the setup hook, or killed with the tab
 * it was running in — must leave the repository exactly as it was found, and
 * `git worktree list` and `git branch` are asked before and after to say so.
 * @module _tests/git-worktree-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { registerWorkspace, patchWorkspace, unregisterWorkspace, listWorkspaces } from '../../../js/services/workspaces.js';
import { provisionWorkspace } from '../../../js/services/workspace-provisioning.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import GitWorktreeWorkspaceProvider, { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  registerProvider,
  BRANCH,
  uniqueTag,
  makeConversation,
  readIn,
  mustRun,
  buildRepo,
  snapshot,
  pathTurnsUp,
  giveRepoASlowHook
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
 * Run the git-worktree tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-test', async ({ run, ops, session, projectPath, parent, separator, release }) => {
    await run('a worktree can be made beside the repository, outside the tree the command runs in', async () => {
      // The placement the whole feature assumes. The command runs pinned to the
      // project, and the tree it makes is a sibling of the project — so if the
      // path clamp measured what a command writes rather than where it starts,
      // every worktree this provider will ever make would be refused, and the
      // first anyone would know of it is the day the provider shipped.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `juggler-wt-${tag}`;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');

        // Before, so that the assertion after it cannot pass against something
        // that was already there — the tree is named for this run alone, but a
        // probe that can only succeed proves nothing whichever way it answers.
        const before = await ops.shell({ command: `ls ../${tree}` });
        assert(before.success === false,
          `nothing is beside the project under that name yet, got ${JSON.stringify(before.stdout)}`);

        await mustRun(ops, `git -C ${repo} worktree add -q -b feat/tunnels ../../${tree} main`);

        const after = await ops.shell({ command: `ls ../${tree}/greeting.txt` });
        assert(after.success === true,
          `a command confined to the project made a tree beside it, got ${JSON.stringify(after.stderr)}`);

        // Beside, not inside — which is the half of "outside the tree the
        // command runs in" that the probe above would still pass without, since
        // a relative `..` only means the parent if the command really did start
        // where we think it did.
        const inside = await ops.shell({ command: `ls ${tree}` });
        assert(inside.success === false,
          `and beside it rather than within it, got ${JSON.stringify(inside.stdout)}`);

        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes(tree),
          `and git knows it as a worktree of the repository, got ${JSON.stringify(listed.stdout)}`);
        assert(listed.stdout.includes('branch refs/heads/feat/tunnels'),
          `on the branch it was asked for, got ${JSON.stringify(listed.stdout)}`);
      } finally {
        // Ordered, and each tolerant of the step before it having failed: the
        // tree is outside the project, where no fixture reset will ever reach it.
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${repo}` }).catch(() => {});
      }
    });

    await run('a conversation bound to a worktree reads the worktree', async () => {
      // The other half: a workspace registered outside the project resolves a
      // conversation's operations to it. The discriminator is the repository's
      // one committed file, which exists in the worktree because `worktree add`
      // checked it out there and exists nowhere the project can see — so a read
      // that quietly resolved against the project comes back missing rather than
      // coming back with something plausible.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `juggler-wt-${tag}`;
      const root = `${parent}${separator}${tree}`;
      /** @type {any} */
      let made = null;
      const saved = session.workspaces;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, `git -C ${repo} worktree add -q -b feat/reads ../../${tree} main`);

        made = await registerWorkspace({
          kind: 'local',
          root,
          label: 'feat/reads (worktree)',
          state: 'ready'
        });
        assert(made.available !== false,
          `the server found the tree where it was told it was, got ${JSON.stringify(made)}`);
        // The unit session's websocket is a mock, so the broadcast that would
        // carry this row never arrives; the table is set by hand instead.
        session.workspaces = [...saved, made];

        const bound = await makeConversation(session, 'works-in-the-worktree', { workspaceId: made.id });
        release(bound);
        const inTree = await readIn(session, bound, 'greeting.txt');
        assert(inTree.exists !== false,
          `the bound conversation read the worktree's file, got ${JSON.stringify(inTree)}`);
        assert(String(inTree.content ?? '').includes('hello-from-the-worktree'),
          `and got its contents, got ${JSON.stringify(inTree.content)}`);

        const unbound = await makeConversation(session, 'works-in-the-project');
        release(unbound);
        const inProject = await readIn(session, unbound, 'greeting.txt');
        assert(inProject.exists === false,
          `while the project holds no such file, which is what makes the case above mean anything, got ${JSON.stringify(inProject)}`);
      } finally {
        session.workspaces = saved;
        if (made) await unregisterWorkspace(made.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${repo}` }).catch(() => {});
      }
    });

    await run('the provider registers, and names itself for the setup panel', async () => {
      const refusal = registerProvider();
      assert(refusal === '', `the registry refused the provider: ${refusal}`);
      assert(registerProvider() === '',
        'and asking a second time, as the next run of this suite in this lane does, finds it there');

      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      assert(provider !== undefined, 'the provider is not in the registry under its own id');
      assert(provider.getSetupLabel() === 'New git worktree',
        `the "New…" row would read ${JSON.stringify(provider.getSetupLabel())}`);
    });

    await run('a worktree of a subrepo is seeded with the project\'s own instructions', async () => {
      // A tree of a repository the project merely holds has never had a copy of
      // the project's AGENTS.md, and nothing below that tree will ever mention
      // it — so a conversation working there loses the house rules entirely. A
      // worktree of the project itself is the opposite case: it carries its own
      // copy on its own branch, and a second one read out of the main checkout
      // would be a second answer to the same question.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      const ctx = { session };

      const ofSubrepo = provider.instructionRoots(
        { meta: { repoDir: `${projectPath}${separator}sub${separator}repo` } }, ctx);
      assert(ofSubrepo.length === 1 && ofSubrepo[0] === projectPath,
        `a tree of a repository inside the project is seeded from the project, got ${JSON.stringify(ofSubrepo)}`);

      const ofProject = provider.instructionRoots({ meta: { repoDir: projectPath } }, ctx);
      assert(ofProject.length === 0,
        `while a tree of the project itself names nowhere else, got ${JSON.stringify(ofProject)}`);

      const unknown = provider.instructionRoots({ meta: {} }, ctx);
      assert(unknown.length === 0,
        `and a row that records no repository says nothing rather than guessing, got ${JSON.stringify(unknown)}`);
    });

    await run('a provision makes the tree, on the branch it was asked for', async () => {
      // From here on the trees land BESIDE the repository but still inside the
      // fixture, because the repository is a directory of the fixture rather
      // than the fixture itself. That is the provider's own default placement
      // exercised honestly — and the case above is what proves the same code
      // works when the repository is the project and the tree is outside it.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        const before = await snapshot(ops, repo);

        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });

        assert(outcome.workspace.state === 'ready',
          `the row is ready once the provider returns, got ${JSON.stringify(outcome.workspace.state)}`);
        assert(outcome.workspace.root === location,
          `and says where the tree is, got ${JSON.stringify(outcome.workspace.root)}`);
        assert(outcome.workspace.meta?.branchCreatedByUs === true,
          `and records that the branch is ours to delete, got ${JSON.stringify(outcome.workspace.meta)}`);

        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes(`branch refs/heads/${BRANCH}`),
          `git has it on the branch it was asked for, got ${JSON.stringify(listed.stdout)}`);
        const checkedOut = await ops.shell({ command: `ls ${tree}/greeting.txt` });
        assert(checkedOut.success === true,
          'and the tree holds the commit rather than being an empty directory');

        // Undo after success is the same stack a cancel runs, which is why "I
        // picked the wrong thing" costs nothing: the repository has to come back
        // to what it was, not merely lose the directory.
        await outcome.undo();
        outcome = null;
        assert(await snapshot(ops, repo) === before,
          'undoing left the repository as it was found');
        const gone = await ops.shell({ command: `ls ${tree}` });
        assert(gone.success === false, 'and took the tree with it');
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('a cancel during the setup hook leaves the repository as it was', async () => {
      // The cancel a user actually reaches: the tree is made in a second and the
      // hook after it takes a quarter of an hour, so the middle of the hook is
      // where Cancel gets pressed. What must survive it is the repository —
      // an abandoned worktree registration or a stray branch would both make the
      // next attempt at the same name fail for a reason the user did not cause.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await giveRepoASlowHook(ops, repo, 30);
        const before = await snapshot(ops, repo);

        const controller = new AbortController();
        const running = provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location },
          signal: controller.signal
        });
        /** @type {any[]} */
        const rejections = [];
        const settled = running.then(() => {}, (error) => { rejections.push(error); });

        // Aborting before the hook is really running would prove nothing: the
        // tree would be gone because it had barely been made, not because the
        // compensation took it away.
        assert(await pathTurnsUp(ops, `${tree}/hook-ran.txt`, 10000),
          'the setup hook never started, so there was nothing for the cancel to interrupt');
        controller.abort();
        await settled;

        assert(rejections.length === 1,
          `cancelling rejects the provision rather than completing it, got ${rejections.length} rejections`);
        assert(await snapshot(ops, repo) === before,
          'and the repository is exactly as it was found — no worktree registered, no branch left behind');
        const gone = await ops.shell({ command: `ls ${tree}` });
        assert(gone.success === false,
          'and the half-built tree is gone, hook output and all');
      } finally {
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('an interrupted provision is undone from its checkpoints alone', async () => {
      // The restart path, reproduced without restarting anything: drop the
      // closures the way a dead tab drops them, then hand `cleanupPartial` the
      // row the server kept. It must remove exactly what the compensation would
      // have — which is the whole reason the two are written separately, since a
      // provider whose undo paths agree only by sharing code cannot be caught
      // when they stop agreeing.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let row = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await giveRepoASlowHook(ops, repo, 30);
        const before = await snapshot(ops, repo);

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        row = await registerWorkspace({
          kind: 'local',
          root: location,
          providerId: PROVIDER_ID,
          state: 'provisioning'
        });
        const controller = new AbortController();
        const dying = provider.provision(
          { repo, branch: BRANCH, base: 'main', location },
          {
            session,
            ops,
            baseWorkspaceId: '',
            signal: controller.signal,
            // The tab is about to die. Everything it was holding in memory goes
            // with it, which is what makes the checkpoints the only record.
            rollback: { push: () => {} },
            checkpoint: async (/** @type {any} */ patch) => { await patchWorkspace(row.id, { meta: patch }); },
            progress: () => {}
          }
        ).catch(() => {});

        assert(await pathTurnsUp(ops, `${tree}/hook-ran.txt`, 10000),
          'the setup hook never started, so nothing was half-built to recover from');
        controller.abort();
        await dying;

        const abandoned = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === row.id);
        assert(abandoned?.meta?.treeRel,
          `the row carries what was checkpointed, got ${JSON.stringify(abandoned?.meta)}`);

        const outcome = await provider.cleanupPartial(abandoned, {
          session,
          ops,
          baseWorkspaceId: '',
          signal: new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });
        assert(outcome.removed === true,
          `cleanup says it removed the provision, got ${JSON.stringify(outcome)}`);
        assert(await snapshot(ops, repo) === before,
          'and the repository is as it was found, reconstructed from meta alone');
      } finally {
        if (row) await unregisterWorkspace(row.id).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('a location that is already occupied is refused, and left untouched', async () => {
      // The guard that makes the compensation safe to run unconditionally.
      // Without it the sequence is: `worktree add` fails because the path is
      // taken, the host unwinds, and the compensation removes the tree that was
      // already there — someone else's work, deleted by a failed provision.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, `mkdir -p ${tree}`);
        await mustRun(ops, `echo someone-elses-work > ${tree}/precious.txt`);
        const before = await snapshot(ops, repo);

        /** @type {any} */
        let refusal = null;
        await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        }).catch((error) => { refusal = error; });

        assert(refusal !== null, 'provisioning onto an occupied path was allowed');
        // This assertion first, and deliberately: git refuses the `worktree add`
        // by itself, so a provider without the guard still fails — it just fails
        // AFTER registering a compensation, which then `rm -rf`s the directory
        // on the way out. The refusal is not what saves the files; refusing
        // before anything is recorded is.
        const survived = await ops.shell({ command: `cat ${tree}/precious.txt` });
        assert(survived.success === true && survived.stdout.includes('someone-elses-work'),
          `what was already there is still there, got ${JSON.stringify(survived.stdout)}`);
        assert(/already something there/.test(String(refusal?.message)),
          `and the refusal names the reason rather than quoting git at the user, got ${JSON.stringify(String(refusal?.message))}`);
        assert(await snapshot(ops, repo) === before,
          'and the repository is untouched');
      } finally {
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

    await run('a branch that already exists is checked out, and outlives the undo', async () => {
      // Deleting a branch we did not create is the other way this loses work,
      // and it is one `git branch -D` away in the compensation. So the branch is
      // made first, by someone else, and has to be there afterwards.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, 'keep/me');
      const tree = `${repo}-keep-me`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, `git -C ${repo} branch keep/me main`);
        const before = await snapshot(ops, repo);

        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: 'keep/me', base: 'main', location }
        });
        assert(outcome.workspace.meta?.branchCreatedByUs === false,
          `the provider knows the branch was not its to make, got ${JSON.stringify(outcome.workspace.meta)}`);
        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes('branch refs/heads/keep/me'),
          `and checked it out rather than making another, got ${JSON.stringify(listed.stdout)}`);

        await outcome.undo();
        outcome = null;
        assert(await snapshot(ops, repo) === before,
          'and undoing removed the tree while leaving the branch someone else made');
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await ops.shell({ command: `rm -rf ${tree} ${repo}` }).catch(() => {});
      }
    });

  });
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The setup form the panel renders for the worktree provider.
 *
 * A form is where a provision is described before anything is built, so every
 * case here is about what the form works out on the user's behalf and what it
 * refuses outright: where the tree goes, which repository it comes from, which
 * tree of a submodule is meant, and a branch name git will not take. Refusing
 * before anything is built is the whole point of asking.
 * @module _tests/git-worktree-form-test
 */

import { waitFor, assert } from '../../../js-tests/utilities/test-helpers.js';
import { registerWorkspace, unregisterWorkspace, listWorkspaces } from '../../../js/services/workspaces.js';
import { provisionWorkspace } from '../../../js/services/workspace-provisioning.js';
import { rebindConversation } from '../../../js/services/workspace-rebinding.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  makeConversation,
  readIn,
  mustRun,
  buildRepo,
  typeInto,
  pick,
  waitForRepoField,
  waitForScopeField,
  buildSuperproject,
  offered,
  openForm
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
 * Run the git-worktree-form tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-form-test', async ({ run, ops, session, projectPath, parent, separator, release }) => {
    await run('the form derives where the tree goes, and stops when the user says otherwise', async () => {
      // Placement is a convention rather than a constant, which is why the form
      // shows it rather than deciding it quietly. So it has to do both things:
      // follow the branch while nobody minds where the tree lands, and get out
      // of the way for good the moment somebody does.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const repoRoot = `${projectPath}${separator}${repo}`;
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        // The repository as the base workspace, which is what the form assumes:
        // its commands run where the provision's will, and the location it
        // derives is relative to the same place.
        base = await registerWorkspace({
          kind: 'local', root: repoRoot, label: repo, state: 'ready'
        });
        session.workspaces = [...saved, base];

        const form = openForm(session, base.id);
        assert(form.base && form.branch && form.location,
          'the form asks for a base, a branch and somewhere to put the tree');

        const empty = form.provider.getSetupValue();
        assert(empty.valid === false,
          `a form with no branch in it may not be submitted, got ${JSON.stringify(empty)}`);
        assert(empty.invalidFieldId === form.branch.id && Boolean(form.branch.id),
          `and names the field to go back to, got ${JSON.stringify(empty.invalidFieldId)}`);

        typeInto(form.branch, BRANCH);
        assert(form.location.value === defaultLocation(repoRoot, BRANCH),
          `the location follows the branch, got ${JSON.stringify(form.location.value)}`);
        typeInto(form.branch, 'other/thing');
        assert(form.location.value === defaultLocation(repoRoot, 'other/thing'),
          `and keeps following it, got ${JSON.stringify(form.location.value)}`);

        const elsewhere = `${repoRoot}-somewhere-else`;
        typeInto(form.location, elsewhere);
        typeInto(form.branch, BRANCH);
        assert(form.location.value === elsewhere,
          `once the user has said where it goes, the branch stops moving it, got ${JSON.stringify(form.location.value)}`);

        const filled = form.provider.getSetupValue();
        assert(filled.valid === true,
          `a named branch and a place to put it is a form that may be submitted, got ${JSON.stringify(filled)}`);
        assert(filled.values.branch === BRANCH && filled.values.location === elsewhere,
          `and it hands on what is on screen, got ${JSON.stringify(filled.values)}`);

        // The base is the one field nobody normally touches, so it fills itself
        // in from where the repository is standing — `main` here, which no
        // default in the provider mentions.
        await waitFor(() => form.base.value === 'main',
          { description: 'the form to fill the base in from the repository\'s HEAD' });
        assert(form.provider.getSetupValue().values.base === 'main',
          `and hands that on too, got ${JSON.stringify(form.provider.getSetupValue().values)}`);
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${repo}` }).catch(() => {});
      }
    });

    await run('the repository is asked about only when there is more than one answer', async () => {
      // The base workspace is usually the repository, and a field with one
      // possible answer is a field in the way. So the question is asked only
      // where it can be answered two ways — and the form has to still be the
      // three-field form everywhere else, which is the half of this that every
      // ordinary project depends on.
      const tag = uniqueTag();
      const [first, second] = [`wt-one-${tag}`, `wt-two-${tag}`];
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildRepo(ops, first, `hello-${tag}`);
        await buildRepo(ops, second, `goodbye-${tag}`);

        // The repository as the base workspace: one repository under it, which
        // is itself, so there is nothing to ask.
        base = await registerWorkspace({
          kind: 'local', root: `${projectPath}${separator}${first}`, label: first, state: 'ready'
        });
        session.workspaces = [...saved, base];
        const alone = openForm(session, base.id);
        await waitFor(() => alone.base.value === 'main',
          { description: 'the form to settle against the repository it was opened on' });
        assert(!alone.container.querySelector('[data-field="repo"]'),
          'a base workspace that is the only repository under it is not worth asking about');
        assert(alone.provider.getSetupValue().values.repo === '',
          `and the form still names no repository, got ${JSON.stringify(alone.provider.getSetupValue().values.repo)}`);

        // The project as the base workspace: two repositories under it, neither
        // of them it, so both are offered.
        const choosing = openForm(session, '');
        const select = await waitForRepoField(choosing);
        const options = offered(select);
        assert(options.includes(first) && options.includes(second),
          `both repositories under the project are offered, got ${JSON.stringify(options)}`);

        // And it is dressed as the field below it rather than as the operating
        // system. A native select left alone keeps its own chrome and ignores
        // the border, the radius and the font it is given — which looks like
        // nothing else in the app, and is invisible to every assertion above.
        // This is the one case here that needs the form on the page, since none
        // of it is computed for a container that will never be laid out.
        document.body.appendChild(choosing.container);
        try {
          const dressed = getComputedStyle(select);
          const neighbour = getComputedStyle(choosing.base);
          assert(dressed.appearance === 'none',
            `the platform's own control is turned off, got ${JSON.stringify(dressed.appearance)}`);
          for (const property of ['fontFamily', 'fontSize', 'borderRadius', 'borderTopWidth', 'backgroundColor', 'color']) {
            assert(dressed[property] === neighbour[property],
              `its ${property} is the Base field's, got ${JSON.stringify(dressed[property])} rather than ${JSON.stringify(neighbour[property])}`);
          }
          assert(dressed.backgroundImage.includes('svg'),
            `and it draws a chevron of its own, got ${JSON.stringify(dressed.backgroundImage)}`);
          // Same height, or the rows are different heights and the labels beside
          // them stop lining up — `.setup-field` aligns on the baseline, which
          // is the sort of thing a control with its own chrome moves.
          assert(select.offsetHeight === choosing.base.offsetHeight,
            `and stands the same height as it, got ${select.offsetHeight} against ${choosing.base.offsetHeight}`);
        } finally {
          choosing.container.remove();
        }
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${first} ${second}` }).catch(() => {});
      }
    });

    await run('choosing a repository takes the base and the location with it', async () => {
      // The three fields below the choice are all about one repository, and two
      // of them were filled in for whichever one was chosen before. The base is
      // the one that matters: it names a commit, and a commit in the repository
      // that was chosen a moment ago is not a commit in this one — `git worktree
      // add` would refuse with `invalid reference` over a field nobody touched.
      const tag = uniqueTag();
      const [first, second] = [`wt-one-${tag}`, `wt-two-${tag}`];
      try {
        await buildRepo(ops, first, `hello-${tag}`);
        await buildRepo(ops, second, `goodbye-${tag}`);
        // A different HEAD in the second, so that the base filling itself in
        // again is visible rather than a coincidence: both start on `main`, and
        // a base that never moved would read `main` either way.
        await mustRun(ops, `git -C ${second} checkout -q -b trunk`);

        const form = openForm(session, '');
        const select = await waitForRepoField(form);

        pick(select, first);
        typeInto(form.branch, BRANCH);
        await waitFor(() => form.base.value === 'main',
          { description: "the base to fill in from the first repository's HEAD" });

        pick(select, second);
        await waitFor(() => form.base.value === 'trunk',
          { description: 'the base to be asked again, of the repository now chosen' });

        const chosen = form.provider.getSetupValue();
        assert(chosen.values.repo === second,
          `the form hands on the repository that was chosen, got ${JSON.stringify(chosen.values.repo)}`);

        // Beside the project, not beside the repository. `wt-two-<tag>` is
        // nested in the project, so a tree beside IT would land inside the
        // project — untracked in whatever repository the project is, and found
        // as a third repository by everything that goes looking for them.
        const beside = defaultLocation(`${projectPath}${separator}${second}`, BRANCH, projectPath);
        assert(form.location.value === beside,
          `a nested repository's tree is placed beside the project, got ${JSON.stringify(form.location.value)} rather than ${JSON.stringify(beside)}`);
        assert(!form.location.value.startsWith(`${projectPath}${separator}`),
          `which is to say outside the project altogether, got ${JSON.stringify(form.location.value)}`);
      } finally {
        await ops.shell({ command: `rm -rf ${first} ${second}` }).catch(() => {});
      }
    });

    await run('a submodule can be made a tree of from either end', async () => {
      // A tree of a submodule holds the submodule and nothing else — not the
      // Makefile that builds it, not the scripts around it, none of which are in
      // that repository. A tree of the project holds all of it with the
      // submodule inside. Both are reasonable and they are different trees, so
      // the form asks rather than picking one.
      const tag = uniqueTag();
      const [outer, inner] = [`wt-super-${tag}`, `wt-inner-${tag}`];
      const outerRoot = `${projectPath}${separator}${outer}`;
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildSuperproject(ops, outer, inner, 'held');
        // A branch of its own in the superproject, so that the base following
        // the subject from one repository to the other is visible rather than
        // the same word twice.
        await mustRun(ops, `git -C ${outer} checkout -q -b trunk`);

        base = await registerWorkspace({
          kind: 'local', root: outerRoot, label: outer, state: 'ready'
        });
        session.workspaces = [...saved, base];

        const form = openForm(session, base.id);
        const select = await waitForRepoField(form);
        pick(select, 'held');
        const scope = await waitForScopeField(form);

        // Nothing in this project says a whole-project tree is usable, so the
        // form stays where it has always been and offers the other way.
        assert(scope.value === 'repo',
          `a project with no setup hook starts on the submodule alone, got ${JSON.stringify(scope.value)}`);
        typeInto(form.branch, BRANCH);
        const alone = defaultLocation(`${outerRoot}${separator}held`, BRANCH, outerRoot);
        assert(form.location.value === alone,
          `which is placed beside the project as it always was, got ${JSON.stringify(form.location.value)} rather than ${JSON.stringify(alone)}`);
        await waitFor(() => form.base.value === 'main',
          { description: "the base to fill in from the submodule's HEAD" });

        // The other end: the tree becomes a tree of the project, named after the
        // project, based on the project's HEAD rather than the submodule's.
        pick(scope, 'project');
        const whole = defaultLocation(outerRoot, BRANCH, outerRoot);
        assert(form.location.value === whole,
          `the whole project is a tree named for the project, got ${JSON.stringify(form.location.value)} rather than ${JSON.stringify(whole)}`);
        await waitFor(() => form.base.value === 'trunk',
          { description: "the base to be asked again, of the project it is now a tree of" });

        const chosen = form.provider.getSetupValue().values;
        assert(chosen.scope === 'project' && chosen.repo === 'held',
          `and the form hands on both the scope and the repository it is about, got ${JSON.stringify(chosen)}`);

        // The question only arises for a submodule. Choosing the project itself
        // in the field above is not a submodule, so there is nothing to ask and
        // the form says nothing.
        pick(select, '');
        assert(/** @type {any} */ (scope).parentElement.hidden === true,
          'a repository that is not a submodule is not asked which end to make a tree of');
        assert(form.provider.getSetupValue().values.scope === '',
          `and no scope is handed on, got ${JSON.stringify(form.provider.getSetupValue().values.scope)}`);
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${outer} ${inner}` }).catch(() => {});
      }
    });

    await run('a project that carries a setup hook starts on the whole project', async () => {
      // `git worktree add` does not populate submodules, so a whole-project tree
      // arrives with an empty directory where the submodule is. The hook is
      // where a project says what a new tree of it needs — so a project that has
      // written one has said that a tree of the whole thing is the usable kind,
      // and that is the only evidence worth defaulting on.
      const tag = uniqueTag();
      const [outer, inner] = [`wt-hooked-${tag}`, `wt-held-${tag}`];
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildSuperproject(ops, outer, inner, 'held');
        await mustRun(ops, `mkdir -p ${outer}/.juggler`);
        await mustRun(ops, `echo exit 0 > ${outer}/.juggler/worktree-setup`);

        base = await registerWorkspace({
          kind: 'local', root: `${projectPath}${separator}${outer}`, label: outer, state: 'ready'
        });
        session.workspaces = [...saved, base];

        const form = openForm(session, base.id);
        pick(await waitForRepoField(form), 'held');
        const scope = await waitForScopeField(form);
        assert(scope.value === 'project',
          `the hook is what turns the default round, got ${JSON.stringify(scope.value)}`);
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${outer} ${inner}` }).catch(() => {});
      }
    });

    await run('a form that is put back comes back filled in', async () => {
      // A provision that was cancelled, or that failed, returns the panel to the
      // choice state — which rebuilds this form from nothing. What the section
      // last reported comes back with it, so a cancel over a typo in one field
      // costs one edit rather than a re-fill.
      const mine = '/somewhere/of/my/own';
      const chosen = openForm(session, '', { base: 'develop', branch: BRANCH, location: mine });
      assert(chosen.base.value === 'develop' && chosen.branch.value === BRANCH && chosen.location.value === mine,
        `every field is as it was left, got ${JSON.stringify([chosen.base.value, chosen.branch.value, chosen.location.value])}`);
      assert(chosen.provider.getSetupValue().valid === true,
        'and it may be submitted again without being touched');

      typeInto(chosen.branch, 'second/thoughts');
      assert(chosen.location.value === mine,
        `a location the user chose is still theirs after the rebuild, got ${JSON.stringify(chosen.location.value)}`);

      // Whereas one that was merely derived goes on being derived: the rule is
      // about who chose it, and being handed it back does not make it a choice.
      const derived = openForm(session, '', {
        branch: BRANCH,
        location: defaultLocation(session.projectPath, BRANCH)
      });
      typeInto(derived.branch, 'second/thoughts');
      assert(derived.location.value === defaultLocation(session.projectPath, 'second/thoughts'),
        `a location nobody chose keeps following the branch, got ${JSON.stringify(derived.location.value)}`);
    });

    await run('a branch name git will not take is refused before anything is built', async () => {
      // `feat..tunnels` is a perfectly good-looking string and git will not have
      // it. Nothing short of asking git knows that, which is the point: the
      // rules for a ref name are git's, and a regexp of our own would be a
      // second set that drifts.
      const form = openForm(session, '');
      const branch = form.branch;

      typeInto(branch, 'feat..tunnels');
      await waitFor(() => form.provider.getSetupValue().valid === false,
        { description: 'git to be asked what it makes of the name' });
      const refused = form.provider.getSetupValue();
      assert(refused.invalidFieldId === branch.id,
        `the refusal names the branch field, got ${JSON.stringify(refused.invalidFieldId)}`);
      const note = form.container.querySelector('[data-field-note="branch"]');
      assert(Boolean(note?.textContent?.trim()),
        `and the field says so where it is, got ${JSON.stringify(note?.textContent)}`);

      typeInto(branch, BRANCH);
      await waitFor(() => form.provider.getSetupValue().valid === true,
        { description: 'a name git will take to be accepted' });
      assert(!form.container.querySelector('[data-field-note="branch"]')?.textContent?.trim(),
        'and the complaint goes away with the name that caused it');
    });

    await run('the form fills in, Create builds, and the conversation works in the tree', async () => {
      // End to end from the form: what it reports is what the provision is
      // given, and the tools of a conversation moved into the result then
      // resolve in the tree the form named.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let conversation = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);

        // The project as the base workspace, with the repository inside it —
        // which is the case the Repository field exists for, and the case the
        // provision could not be reached in at all until the form could name
        // one. Nothing here tells the provision where the repository is: the
        // form is the only thing that knows, and what it hands on is what
        // `git worktree add` ends up running in.
        const form = openForm(session, '');
        pick(await waitForRepoField(form), repo);
        typeInto(form.branch, BRANCH);
        await waitFor(() => form.base.value === 'main',
          { description: "the base to fill in from the chosen repository's HEAD" });
        const value = form.provider.getSetupValue();
        assert(value.values.repo === repo,
          `the form names the repository it was pointed at, got ${JSON.stringify(value.values.repo)}`);

        conversation = await makeConversation(session, 'form-to-tree');
        release(conversation);

        // The place is built first, with no conversation in the question, and
        // something is moved into it afterwards — the two acts the dialog and
        // the strip now perform separately.
        const built = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: value.values
        });
        session.workspaces = [...(session.workspaces ?? []), built.workspace];
        assert(built.workspace.state === 'ready',
          `Create built the tree, got ${JSON.stringify(built.workspace.state)}`);

        await rebindConversation(conversation, built.workspace.id);
        assert(conversation.workspaceId === built.workspace.id,
          `and the conversation works in it, got ${JSON.stringify(conversation.workspaceId)}`);

        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === conversation.workspaceId);
        assert(row?.root === value.values.location,
          `the tree is where the form said it would be, got ${JSON.stringify(row?.root)} rather than ${JSON.stringify(value.values.location)}`);
        // Of THAT repository, which is the whole of what the field is for: the
        // project is the tree the command ran in, and a `repo` that went astray
        // anywhere between the form and `git worktree add` leaves this listing
        // empty rather than wrong.
        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes(`branch refs/heads/${BRANCH}`),
          `on the branch that was typed into the form, got ${JSON.stringify(listed.stdout)}`);
        assert(row?.root === `${parent}${separator}${tree}`,
          `and beside the project rather than inside it, got ${JSON.stringify(row?.root)}`);

        const read = await readIn(session, conversation, 'greeting.txt');
        assert(read.exists !== false && String(read.content ?? '').includes(`hello-${tag}`),
          `and the conversation's own tools read that tree, got ${JSON.stringify(read)}`);
      } finally {
        if (conversation?.workspaceId) await unregisterWorkspace(conversation.workspaceId).catch(() => {});
        await ops.shell({ command: `git -C ${repo} worktree remove --force ../../${tree}` }).catch(() => {});
        await ops.shell({ command: `rm -rf ../${tree} ${repo}` }).catch(() => {});
      }
    });
  });
}

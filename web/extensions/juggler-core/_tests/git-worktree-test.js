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

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady,
  waitFor,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { budgetFor } from '../../../js-tests/utilities/test-deadline.js';
import { fetchJson } from '../../../js/services/http.js';
import { createBoundOps } from '../../../sdk/ops.js';
import {
  registerWorkspace,
  patchWorkspace,
  unregisterWorkspace,
  listWorkspaces
} from '../../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceStatus,
  finishWorkspace
} from '../../../js/services/workspace-provisioning.js';
import {
  NEW_ROW_PREFIX,
  selectSetupRow,
  setSetupValues,
  createSelectedWorkspace,
  setupRows,
  probeSetupAdoptions
} from '../../../js/services/conversation-setup.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import GitWorktreeWorkspaceProvider, { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';

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

/** @type {string} The provider under test, as the registry knows it. */
const PROVIDER_ID = GitWorktreeWorkspaceProvider.MANIFEST.id;

/**
 * Put the provider in the registry under its own id, unless it is already there.
 *
 * A lane is one JS realm running suite after suite, and nothing resets this
 * registry between them, so a registration outlives the run of the suite that
 * made it. `registerClass` skips an id that is taken rather than replacing it —
 * so a second pass over this suite in the same lane would be told the provider
 * is already registered, which is the outcome it was asking for, not a refusal.
 * The id cannot be made unique instead: it is the shipped provider's own, and
 * both the panel label below and every provision in this suite resolve through
 * it.
 * @returns {string} What the registry said when it refused, or '' when the
 *   provider is in place.
 */
function registerProvider() {
  if (workspaceProviderRegistry.get(PROVIDER_ID)) return '';
  const registration = workspaceProviderRegistry.registerClass(GitWorktreeWorkspaceProvider, {
    extensionId: '@juggler/core',
    modulePath: '(test)'
  });
  return registration.registered ? '' : String(registration.reason);
}

/**
 * The branch most cases ask for. It carries a slash deliberately: a branch name
 * is not a directory name, and the provider has to turn one into the other.
 * @type {string}
 */
const BRANCH = 'feat/tunnels';

/**
 * A name nothing else in this run will choose.
 *
 * The lanes of a pool share one project, and this suite writes a directory
 * beside that project — which no fixture reset ever clears, since the reset only
 * wipes inside it. Every artifact is therefore stamped and removed by the case
 * that made it.
 * @returns {string} A short unique tag.
 */
function uniqueTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The directory holding a path, in the separator the path itself uses.
 *
 * Registration wants an absolute root in the server's own terms, so this keeps
 * whatever `projectPath` came back as rather than imposing POSIX on Windows.
 * @param {string} path - An absolute path.
 * @returns {{parent: string, separator: string}} Its parent, and the separator in use.
 */
function parentOf(path) {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  return { parent: path.replace(/[/\\][^/\\]*$/, ''), separator };
}

/**
 * A conversation, ready to be sent to: model configured and its worker up.
 * @param {any} session - The test session.
 * @param {string} name - Conversation name.
 * @param {object} [options] - Passed through to createConversation.
 * @returns {Promise<any>} The conversation.
 */
async function makeConversation(session, name, options = {}) {
  const id = await session.createConversation(name, options);
  const conversation = session.conversations.get(id);
  if (!conversation) throw new Error(`conversation ${id} was created but is not in the session`);
  await conversation.setModelConfig({ provider: 'test-provider', model: 'test-model' });
  await waitForWorkerReady(id);
  return conversation;
}

/**
 * Read a file through the real `read` tool, as a turn in this conversation would.
 *
 * The path is relative on purpose: which tree it lands in is the whole question,
 * and only a relative path asks it.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose tools these are.
 * @param {string} path - Path relative to wherever the conversation works.
 * @returns {Promise<any>} The read result.
 */
async function readIn(session, conversation, path) {
  const ReadFile = /** @type {any} */ (contextItemRegistry.getByToolName('read'));
  if (!ReadFile) throw new Error('the read tool is not registered');
  const item = new ReadFile({
    id: 'read-file',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.execute({ path });
}

/**
 * Run a command in the project and insist it worked.
 *
 * Failures carry the command and git's own words: a worktree that could not be
 * made for a reason this suite never sees is a much longer afternoon than one
 * that says `fatal: invalid reference`.
 * @param {any} ops - Project-pinned operations.
 * @param {string} command - What to run.
 * @returns {Promise<any>} The result, once it has succeeded.
 */
async function mustRun(ops, command) {
  const result = await ops.shell({ command });
  if (!result.success) {
    throw new Error(`\`${command}\` failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

/**
 * Build a real repository with one commit in it, inside the project.
 *
 * Every path is relative to the project root, which is where a project-pinned
 * command starts, so nothing here depends on the platform's separator. The
 * identity and the signing flag are stated per command rather than configured,
 * because the machine running this has a global git config of its own and a
 * developer who signs their commits must not be the reason the suite fails.
 * @param {any} ops - Project-pinned operations.
 * @param {string} dir - Directory name for the repository, relative to the project.
 * @param {string} greeting - Contents of the committed discriminator file.
 * @returns {Promise<void>} When there is a repository with a commit on `main`.
 */
async function buildRepo(ops, dir, greeting) {
  const git = `git -C ${dir} -c user.name=Juggler -c user.email=tests@juggler.invalid -c commit.gpgsign=false`;
  await mustRun(ops, `mkdir -p ${dir}`);
  await mustRun(ops, `git -C ${dir} init -q`);
  // Not `init -b main`, which wants git 2.28, and not the default branch name,
  // which depends on the machine: checking out an unborn branch names it here.
  await mustRun(ops, `git -C ${dir} checkout -q -b main`);
  // The same identity, written into the repository rather than passed per
  // command, because the provider's own commit is the user's commit and carries
  // no identity of ours. A repository with one is what every real one has, and
  // it is what lets this run on a machine that has none.
  await mustRun(ops, `git -C ${dir} config user.name Juggler`);
  await mustRun(ops, `git -C ${dir} config user.email tests@juggler.invalid`);
  await mustRun(ops, `git -C ${dir} config commit.gpgsign false`);
  await mustRun(ops, `echo ${greeting} > ${dir}/greeting.txt`);
  await mustRun(ops, `${git} add -A`);
  await mustRun(ops, `${git} commit -q -m first`);
}

/**
 * What the repository looks like from the outside: its worktrees and its
 * branches, as two blocks of text.
 *
 * Taken before a provision and after the undo of one, because "left the
 * repository exactly as it was found" is a claim about both lists and about
 * nothing else — a tree still registered, a branch still lying around, and the
 * next `git worktree add` at that path fails for a reason the user did nothing
 * to cause.
 * @param {any} ops - Project-pinned operations.
 * @param {string} repo - The repository, relative to the project.
 * @returns {Promise<string>} The two lists, for comparing against each other.
 */
async function snapshot(ops, repo) {
  const worktrees = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
  const branches = await mustRun(ops, `git -C ${repo} branch --format='%(refname:short)'`);
  return `worktrees:\n${worktrees.stdout}\nbranches:\n${branches.stdout}`;
}

/**
 * Wait for a path to appear, and say whether it did.
 *
 * It answers rather than throws because both answers are used: once to know a
 * hook has really started before cancelling it, and once to prove the tree it
 * was running in is gone. Absence is a result here, not a failure. The path is
 * a shell one and may be outside the project, which is why this looks through a
 * command rather than through `stat`.
 * @param {any} ops - Project-pinned operations.
 * @param {string} path - Path relative to the project root.
 * @param {number} nominalMs - How long to keep looking on an idle machine.
 * @returns {Promise<boolean>} Whether it turned up inside the budget.
 */
async function pathTurnsUp(ops, path, nominalMs) {
  // The budget rather than the nominal: nine lanes share this machine, and a
  // number chosen for an idle one measures the pool instead of the code.
  const deadline = Date.now() + budgetFor(nominalMs);
  do {
    if ((await ops.shell({ command: `test -e ${path}` })).success) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

/**
 * A repository carrying a setup hook that announces itself and then waits.
 *
 * The waiting is what gives a cancel somewhere to land: a real hook's slow part
 * is an `npm ci`, and the interesting moment is the one in the middle of it.
 * The marker is how the test knows the hook is genuinely running rather than
 * aborting something that had not started, which would be a pass this case must
 * not be able to score.
 * @param {any} ops - Project-pinned operations.
 * @param {string} repo - The repository, relative to the project.
 * @param {number} seconds - How long the hook lingers.
 * @returns {Promise<void>} When the hook is in place.
 */
async function giveRepoASlowHook(ops, repo, seconds) {
  await mustRun(ops, `mkdir -p ${repo}/.juggler`);
  await mustRun(ops, `printf 'touch hook-ran.txt\\nsleep ${seconds}\\n' > ${repo}/.juggler/worktree-setup`);
}

/**
 * Put a value in a field the way a user does, so that everything listening to
 * the field hears about it. Assigning `value` on its own tells nobody, which is
 * also what lets the form set a field itself without being mistaken for the
 * user having typed in it.
 * @param {HTMLInputElement} input - The field.
 * @param {string} value - What to type into it.
 */
function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Choose in a field that is chosen from rather than typed into. A select tells
 * its listeners with `change`, and only when a person is the one moving it, so
 * an assignment alone reaches nobody.
 * @param {HTMLSelectElement} select - The field.
 * @param {string} value - Which option to land on.
 */
function pick(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Wait for the Repository field to turn up, and hand it back.
 *
 * It is the one field that is not there when the form is rendered: whether it
 * is worth having is a question for the server, and the form opens without
 * waiting for the answer.
 * @param {any} form - As `openForm` returned it.
 * @returns {Promise<HTMLSelectElement>} The field, once it is there.
 */
async function waitForRepoField(form) {
  await waitFor(() => Boolean(form.container.querySelector('[data-field="repo"]')),
    { description: 'the form to offer a repository to choose' });
  form.repo = form.container.querySelector('[data-field="repo"]');
  return form.repo;
}

/**
 * Wait for the Worktree field to be asked, and hand it back.
 *
 * It arrives later than the Repository field above it and only for a submodule:
 * the form has to know which of the repositories on offer are submodules before
 * it can know whether there is anything to ask. It is built hidden and shown,
 * so being in the container is not the same as being asked.
 * @param {any} form - As `openForm` returned it.
 * @returns {Promise<HTMLSelectElement>} The field, once it is being asked.
 */
async function waitForScopeField(form) {
  await waitFor(() => {
    const select = /** @type {any} */ (form.container.querySelector('[data-field="scope"]'));
    return Boolean(select) && select.parentElement?.hidden === false;
  }, { description: 'the form to ask which tree a submodule should be made of' });
  return form.container.querySelector('[data-field="scope"]');
}

/**
 * A repository with another one inside it as a submodule.
 *
 * Both are built in the project and the inner one is added by a relative path,
 * so nothing here depends on where the project is. `protocol.file.allow` is
 * stated because git refuses a submodule from a local path without it, and
 * stating it costs nothing on the versions that never minded.
 * @param {any} ops - Project-pinned operations.
 * @param {string} outer - Directory for the superproject, relative to the project.
 * @param {string} inner - Directory for the repository it will hold, relative to the project.
 * @param {string} at - Where the submodule sits inside the superproject.
 * @returns {Promise<void>} When the superproject has it committed.
 */
async function buildSuperproject(ops, outer, inner, at) {
  await buildRepo(ops, outer, `outer-${at}`);
  await buildRepo(ops, inner, `inner-${at}`);
  await mustRun(ops, `git -C ${outer} -c protocol.file.allow=always submodule add -q ../${inner} ${at}`);
  await mustRun(ops, `git -C ${outer} commit -q -m submodule`);
}

/**
 * What a Repository field is offering, in the order it offers it.
 * @param {HTMLSelectElement} select - The field.
 * @returns {string[]} The values, which are paths relative to the base workspace.
 */
function offered(select) {
  return [...select.options].map(option => option.value);
}

/**
 * Open the provider's setup form the way the panel opens it.
 *
 * The container is deliberately left out of the document: nothing here needs
 * layout or focus, and a form attached to the page outlives the case that made
 * it. What the panel really does beyond this is listen for `input` on the
 * container and ask `getSetupValue()`, which is what each case does by hand.
 * @param {any} session - The test session.
 * @param {string} baseWorkspaceId - What the provision would be relative to; '' is the project.
 * @param {object} [values] - What the section last reported, for a form being rebuilt.
 * @returns {any} The provider, its container, and its fields — `repo` being null until the form decides to ask for one.
 */
function openForm(session, baseWorkspaceId, values) {
  const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
  if (!provider) throw new Error('the provider is not registered, so it has no form to render');
  const container = document.createElement('div');
  provider.renderSetup(container, {
    session,
    ops: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseWorkspaceId,
    values,
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  });
  /**
   * @param {string} name - Which field.
   * @returns {any} The input, or null when the form does not have one.
   */
  const field = (name) => container.querySelector(`[data-field="${name}"]`);
  return {
    provider,
    container,
    repo: field('repo'),
    base: field('base'),
    branch: field('branch'),
    location: field('location')
  };
}

/**
 * The context the host hands a reconcile: operations rooted at the project,
 * because what it is looking for is not in any one workspace.
 * @param {any} session - The test session.
 * @param {any} ops - Project-pinned operations.
 * @returns {any} A provider context.
 */
function reconcileCtx(session, ops) {
  return {
    session,
    ops,
    baseWorkspaceId: '',
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  };
}

/**
 * Run the git-worktree tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const projectPath = (await fetchJson('/api/session')).projectPath;
  const { parent, separator } = parentOf(projectPath);
  const ops = createBoundOps(() => ({}));

  /** @type {any} */
  let session = null;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  try {
    session = await createTestSession();

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
      // End to end through the panel's own state: what the form reports is what
      // the conversation is set up with, and the tools of that conversation then
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

        conversation = await makeConversation(session, 'form-to-tree', { initialise: false });
        release(conversation);
        selectSetupRow(conversation, `${NEW_ROW_PREFIX}${PROVIDER_ID}`);
        setSetupValues(conversation, value);

        const result = await createSelectedWorkspace(conversation);
        assert(result.ok, `Create built the tree, got ${JSON.stringify(result)}`);
        assert(conversation.initialised === true && Boolean(conversation.workspaceId),
          `and the conversation is bound to it, unsent and already seeded, got ${JSON.stringify(conversation.workspaceId)}`);

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
  } finally {
    if (session) {
      for (const id of created) {
        await releaseTestConversation(session, id, 'git-worktree-test');
      }
    }
  }

  return { passed, failed, errors };
}

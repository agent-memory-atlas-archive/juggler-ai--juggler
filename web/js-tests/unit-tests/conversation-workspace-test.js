//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation's workspace binding, and the moment it is decided.
 *
 * A conversation's assistant files are relative to a root: they are whichever
 * tree it works in. A blank one has not been told where that is yet, so it is
 * seeded for the tree it would work in if nobody said otherwise — the project —
 * and reseeded out of another the moment its user names one. It is showing what
 * its first turn would carry, and stays uninitialised, unbound and free to be
 * told something else until that turn arrives.
 *
 * The cases below pin the halves of that: what an uninitialised conversation
 * has (the project's seeds, no binding), what picking a row does to them (the
 * whole set rebuilt out of the named tree, and nothing of the user's touched),
 * what initialising does (binds, and confirms rather than repeats — a seed the
 * user deleted stays deleted), and what a conversation born from another
 * inherits (its workspace, already initialised — including the duplicate path,
 * which inherits it through the cloned document without a line of code).
 * @module unit-tests/conversation-workspace-test
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import {
  DEFAULT_FILE_EDITING_META_KEY,
  isFileEditingAllowed,
  setFileEditingAllowed
} from '../../js/services/file-editing-permission.js';
import { getDefaultStrategyId, setDefaultStrategyId } from '../../js/services/default-strategy.js';
import { getDefaultPresetId, setDefaultPreset } from '../../js/services/system-prompt-presets.js';
import { INITIALISED_KEY } from '../../js/model/conversation.js';
import { fetchJson } from '../../js/services/http.js';
import api from '../../js/services/api.js';
import workerManager from '../../js/services/worker-manager.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { shellExecuteStreaming } from '../../js/services/shell-streaming.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import {
  registerWorkspace,
  patchWorkspace,
  unregisterWorkspace,
  listWorkspaces,
  isWorkspaceUsable
} from '../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceStatus,
  workspaceFinishOptions,
  workspaceFinishWarning,
  finishWorkspace,
  provisionLeftBehind,
  PROVIDER_UNAVAILABLE
} from '../../js/services/workspace-provisioning.js';
import { reconcileWorkspaces } from '../../js/services/workspace-reconcile.js';
import {
  rebindConversation,
  workspaceHeldWork,
  workspaceWorkList,
  carryWorkspaceWork
} from '../../js/services/workspace-rebinding.js';
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
  subscribeSetup,
  probeSetupStatuses,
  cachedSetupStatus,
  probeSetupAdoptions,
  adoptSetupRow,
  isSetupProvisioning
} from '../../js/services/conversation-setup.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import {
  ensureWorkspaceBanner,
  ensureConversationChrome,
  ensurePendingMessages,
  removeAllElements
} from '../../js/components/conversation-area-rendering.js';
import { openWorkspaceMove } from '../../js/components/workspace-move-dialog.js';
import { buildPlaceRows } from '../../js/components/workspace-setup-form.js';
import { followSession, setGitWorkspace } from '../../js/services/git-workspace.js';
import { WORKSPACE_ELSEWHERE_HINT } from '../../js/components/model-selector.js';
import gitStatusCache from '../../js/services/git-status-cache.js';

/**
 * A workspace row as the client-side table holds it, for the cases that seed
 * one directly rather than registering it with the server.
 * @param {string} id - Workspace id.
 * @param {string} root - Where it is.
 * @param {object} [extra] - State, availability, label — whatever the case is about.
 * @returns {any} The row.
 */
function workspaceRow(id, root, extra = {}) {
  return { id, kind: 'local', root, state: 'ready', available: true, ...extra };
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
 * The path is deliberately relative: which tree it lands in is the whole
 * question, and only a relative path asks it.
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
 * Run a script through the real `query_code` tool, as a turn in this
 * conversation would.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose tools these are.
 * @param {string} code - The script body.
 * @returns {Promise<any>} The tool result.
 */
async function queryIn(session, conversation, code) {
  const QueryCode = /** @type {any} */ (contextItemRegistry.getByToolName('query_code'));
  if (!QueryCode) throw new Error('the query_code tool is not registered');
  const item = new QueryCode({
    id: 'query-code',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.execute({ code });
}

/**
 * Wait for a file to turn up in a workspace, and say whether it did.
 *
 * It answers rather than throws because the cases below ask it in both
 * directions — once to know a command has really started, and once to prove a
 * cancelled one never finished. An absence is a result there, not a failure.
 * @param {any} ops - Operations already scoped to the workspace to look in.
 * @param {string} path - Path relative to that workspace's root.
 * @param {number} timeoutMs - How long to keep looking.
 * @returns {Promise<boolean>} Whether it turned up inside the window.
 */
async function fileTurnsUp(ops, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await ops.stat({ path })).exists) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

/**
 * A workspace provider that makes a real directory, in real steps.
 *
 * It is deliberately not the smallest thing that would satisfy the registry.
 * The interesting properties of the class are all about a provision that stops
 * half way — so this one takes two irreversible steps, checkpoints before each,
 * and pushes a compensation after each. Its two undo paths are written
 * separately, from the closures and from `meta`, precisely so a test can catch
 * them disagreeing; a fixture that shared one implementation between them could
 * not fail the test it exists for.
 */
class FixtureProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'fixture-workspace-provider',
    name: 'Somewhere else',
    version: '1.0.0',
    description: 'Makes a directory, in steps, so a test can interrupt it',
    recommendations: {
      bestFor: 'a test that wants to read its own advice back',
      avoidFor: 'anything anybody is relying on',
      notes: ['The directory is the whole of it; nothing else is made.']
    }
  };

  /**
   * @param {any} values - dir, and optionally a stallMs to be interrupted during
   * @returns {string} Where it is going
   */
  plannedRoot(values) {
    return values.dir;
  }

  /**
   * Two fields, which is enough to ask the two questions a host has of a form —
   * what does it say, and may it be submitted — and to ask for a provision slow
   * enough to be interrupted from a view that has only the form to drive it.
   * @param {HTMLElement} container - The panel section's body
   */
  renderSetup(container) {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'fixture-dir';
    field.value = '';
    container.appendChild(field);
    this._field = field;

    const stall = document.createElement('input');
    stall.type = 'text';
    stall.id = 'fixture-stall';
    stall.value = '';
    container.appendChild(stall);
    this._stall = stall;
  }

  /**
   * @returns {any} What the form says, and whether Create may be pressed
   */
  getSetupValue() {
    const dir = this._field?.value ?? '';
    const stallMs = Number(this._stall?.value ?? '') || 0;
    if (!dir) return { valid: false, values: {}, invalidFieldId: 'fixture-dir' };
    return { valid: true, values: stallMs ? { dir, stallMs } : { dir } };
  }

  /**
   * Make a directory, then put a file in it, checkpointing before each and
   * pushing the inverse after each.
   * @param {any} values - dir, stallMs, and whether to forget a compensation
   * @param {any} ctx - The host's provisioning context
   * @returns {Promise<any>} The workspace it built
   */
  async provision(values, ctx) {
    const { dir, stallMs = 0, dirStallMs = 0 } = values;

    // Both records of how to undo this step go in BEFORE the step, so there is
    // no instant at which the directory exists and nothing knows how to remove
    // it. `rm -rf` rather than `rm -r` for the same reason from the other side:
    // the compensation will sometimes run for a step that never happened.
    ctx.progress('Making the directory', dir);
    await ctx.checkpoint({ dir });
    ctx.rollback.push(async () => {
      // A step that cannot be taken back: a tree something else has open, a
      // permission that has gone, a disk that is full. The stack must go on
      // down past it, and somebody has to be told what survived.
      if (values.rollbackFailsWith) throw new Error(values.rollbackFailsWith);
      await ctx.ops.shell({ command: `rm -rf ${dir}` }, ctx.signal);
    });
    // `dirStallMs` keeps the command running after it has made the directory,
    // so a cancel can land INSIDE this step rather than between steps. That is
    // the only way to reach the window an inverse pushed after its step falls
    // through — the abort rejects the operation, and the line that would have
    // recorded the undo is never reached.
    const linger = dirStallMs ? `; sleep ${dirStallMs / 1000}` : '';
    await ctx.ops.shell({ command: `mkdir -p ${dir}${linger}` }, ctx.signal);

    if (stallMs) {
      // The slow step every real provider has — a dependency install, a clone —
      // and the one a cancel usually has to land in the middle of.
      ctx.progress('Waiting about', `${stallMs}ms`);
      await ctx.ops.shell({ command: `sleep ${stallMs / 1000}` }, ctx.signal);
    }

    // The other way a provision ends without a workspace: the branch already
    // exists, the host is down, the disk is full. It throws here rather than at
    // the top so that there is something built for the failure to unwind.
    if (values.failWith) throw new Error(values.failWith);

    ctx.progress('Writing the marker');
    await ctx.checkpoint({ marked: true });
    ctx.rollback.push(async () => {
      await ctx.ops.shell({ command: `rm -f ${dir}/made-here.txt` }, ctx.signal);
    });
    await ctx.ops.shell({ command: `echo yes > ${dir}/made-here.txt` }, ctx.signal);

    return { workspace: { root: dir, label: 'made by the fixture', meta: { dir, marked: true } } };
  }

  /**
   * What the case under way wants `status()` to add to the base class's answer.
   *
   * Static and explicit for the same reason `report` is: status is asked of this
   * provider by sweeps belonging to cases about something else, and a fixture
   * that volunteered a dirty tree would put a warning in front of them.
   * @type {any}
   */
  static reported = null;

  /**
   * What the case under way wants this provider to fall over with when asked
   * how its tree is doing. A provider that throws has said nothing about the
   * tree, which is a different answer from "clean" and has to be tested as one.
   * @type {string|null}
   */
  static statusError = null;

  /**
   * @param {any} workspace - The row to report on
   * @param {any} ctx - Operations pinned to it, and a signal
   * @returns {Promise<any>} The base answer, with whatever the case added
   */
  async status(workspace, ctx) {
    if (FixtureProvider.statusError) throw new Error(FixtureProvider.statusError);
    const answer = await super.status(workspace, ctx);
    return FixtureProvider.reported ? { ...answer, ...FixtureProvider.reported } : answer;
  }

  /**
   * What the case under way wants this provider to say it is holding.
   *
   * Static and explicit like the other two, and for a sharper reason: the move
   * dialog asks this of the tree a conversation is leaving, so a fixture that
   * volunteered a list would put an offer to copy files in front of a case that
   * was only moving a conversation. `null` is the base class's answer — no
   * opinion, which sends the host to git.
   * @type {any}
   */
  static holds = null;

  /**
   * @param {any} workspace - The row to account for
   * @param {any} ctx - Operations pinned to it, and a signal
   * @returns {Promise<any>} What the case set, or no opinion at all
   */
  async heldWork(workspace, ctx) {
    void workspace;
    void ctx;
    return FixtureProvider.holds;
  }

  /**
   * Extra directories the case under way wants this provider to name as holding
   * instructions that count where its workspaces are.
   *
   * Static and explicit like the three above, and for the widest reason of any
   * of them: seeding happens on every bind, so a fixture that volunteered a
   * directory of its own accord would put an extra context item into every case
   * that makes a conversation.
   * @type {string[]}
   */
  static extraRoots = [];

  /**
   * @param {any} workspace - The row about to be seeded for
   * @param {any} ctx - Operations pinned to it, and a signal
   * @returns {string[]} What the case set, or nothing to add
   */
  instructionRoots(workspace, ctx) {
    void workspace;
    void ctx;
    return FixtureProvider.extraRoots;
  }

  /**
   * Whatever the case under way wants reconcile to report.
   *
   * Static and deliberately explicit: reconcile is asked about this provider's
   * rows in cases that are about something else entirely, and a fixture that
   * reported an orphan of its own accord would close rows underneath them.
   * @type {any}
   */
  static report = null;

  /**
   * @param {any[]} workspaces - This provider's rows
   * @param {any} ctx - Operations rooted at the project
   * @returns {Promise<any>} What the case set, or a clean bill of health
   */
  async reconcile(workspaces, ctx) {
    void ctx;
    return FixtureProvider.report ?? {
      orphanedWorkspaces: [],
      orphanedArtifacts: [],
      confirmed: workspaces.map(workspace => workspace.id)
    };
  }

  /**
   * Three endings: one that finishes with the workspace, and two that only
   * report, so a case about what the chip ASKS never has to let the fixture
   * tear a directory down to find out. Plus one action that is not an ending at
   * all — `note` keeps the workspace in use, which is what the host groups rows
   * by, so a fixture with none could not show the grouping working.
   * @param {any} workspace - The row being finished with
   * @returns {any[]} The ways to end it
   */
  finishOptions(workspace) {
    void workspace;
    return [
      {
        id: 'done',
        label: 'Done with it',
        danger: true,
        description: 'Removes the directory. This conversation goes back to the project folder.'
      },
      {
        id: 'note',
        label: 'Leave a note',
        keepsWorkspace: true,
        description: 'Writes a line into the workspace and leaves it in use.',
        prompt: { hint: 'Leave it empty and nothing is written.' }
      },
      {
        id: 'leave',
        label: 'Leave it be',
        description: 'Nothing changes on disk. This conversation goes back to the project folder.'
      },
      ...(FixtureProvider.discardDescription
        ? [{
          id: 'discard',
          label: 'Discard it',
          danger: true,
          description: FixtureProvider.discardDescription
        }]
        : [])
    ];
  }

  /**
   * What the case under way wants a discard to say it would cost.
   *
   * Static and inert by default like the rest: the banner's Undo looks for a
   * `discard` ending to borrow a sentence from, and the three endings above
   * deliberately include none — a provider that offers no discard is its own
   * case, and the fixture has to be able to be both.
   * @type {string|null}
   */
  static discardDescription = null;

  /**
   * What the host last asked this provider to do, and what it collected for it.
   * @type {any}
   */
  static lastFinish = null;

  /**
   * @param {any} workspace - The row being finished with
   * @param {string} actionId - Which ending
   * @param {any} ctx - Operations pinned to the workspace, and a signal
   * @returns {Promise<any>} Whether it is finished with
   */
  async finish(workspace, actionId, ctx) {
    FixtureProvider.lastFinish = { actionId, input: ctx?.input };
    if (actionId === 'note') return { done: false, message: `noted: ${ctx?.input?.message ?? ''}` };
    if (actionId === 'leave') return { done: false, message: 'left it be' };
    if (actionId !== 'done') return { done: false, message: `no such ending: ${actionId}` };
    const dir = workspace.meta?.dir;
    // One command, because these operations are pinned to the very directory
    // being removed: a second would start by trying to stand somewhere that is
    // no longer there.
    await ctx.ops.shell({ command: `rm -rf ${dir}` }, ctx.signal);
    return { done: true, message: `removed ${dir}` };
  }

  /**
   * The same undo, reconstructed from `meta` alone — no closure survived.
   *
   * Written out separately from the compensations above rather than sharing an
   * implementation with them, because a provider whose two paths quietly drift
   * apart is the fault these tests exist to catch, and a fixture that cannot
   * drift cannot catch it.
   * @param {any} workspace - The half-built row
   * @param {any} ctx - Operations rooted at the project
   * @returns {Promise<any>} Whether anything is left
   */
  async cleanupPartial(workspace, ctx) {
    const dir = workspace.meta?.dir;
    if (!dir) return { removed: false, message: 'nothing was checkpointed' };
    // `-f` and `-rf` throughout: a checkpoint is written BEFORE the step it
    // describes, so `meta` routinely names a file that was never created.
    await ctx.ops.shell({ command: `rm -f ${dir}/made-here.txt` }, ctx.signal);
    await ctx.ops.shell({ command: `rm -rf ${dir}` }, ctx.signal);
    return { removed: true, message: `removed ${dir}` };
  }
}

/**
 * Provision until something interrupts it, the way a restart interrupts one:
 * the row survives, whatever reached disk survives, and the closures do not.
 *
 * It drives the provider directly rather than through the host, because the
 * host's whole job is to unwind — and the state this exists to produce is the
 * one nothing got to unwind. `rollback.push` therefore drops what it is given,
 * which is precisely what a dead tab does with it.
 * @param {any} session - The test session.
 * @param {any} values - Passed to the provider's provision().
 * @param {(() => Promise<void>)} [interruptAfter] - Awaited, then the signal is aborted.
 * @returns {Promise<any>} The row as the server holds it, mid-provision.
 */
async function abandonProvision(session, values, interruptAfter) {
  const provider = workspaceProviderRegistry.createProvider(FixtureProvider.MANIFEST.id, session);
  if (!provider) throw new Error('the fixture provider is not registered');
  const row = await registerWorkspace({
    kind: 'local',
    root: values.dir,
    providerId: FixtureProvider.MANIFEST.id,
    state: 'provisioning'
  });
  const controller = new AbortController();
  const settled = provider.provision(values, {
    session,
    ops: createBoundOps(() => ({})),
    baseWorkspaceId: '',
    signal: controller.signal,
    rollback: { push: () => {} },
    checkpoint: async (metaPatch) => { await patchWorkspace(row.id, { meta: metaPatch }); },
    progress: () => {}
  }).then(() => {}, () => {});
  if (interruptAfter) {
    await interruptAfter();
    controller.abort();
  }
  await settled;
  return (await listWorkspaces()).find(ws => ws.id === row.id);
}

/**
 * Build the system prompt a turn in this conversation would send.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose turn it would be.
 * @returns {string} The identity and environment block.
 */
function promptFor(session, conversation) {
  const SystemPrompt = /** @type {any} */ (contextItemRegistry.get('system-prompt'));
  if (!SystemPrompt) throw new Error('the system-prompt item is not registered');
  const item = new SystemPrompt({
    id: 'SYSTEM_1',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.buildPrompt();
}

/**
 * The top of a column's item list, as `conversation-area` builds it: the
 * normal-order inner container with the footer the item diff anchors on.
 * @param {any} conversation - The conversation the column shows.
 * @param {object} [state] - Column state the banner asks about (`_threadYMap`).
 * @returns {{area: any, list: HTMLElement}} A stub column and its list.
 */
function columnFor(conversation, state = {}) {
  const list = document.createElement('div');
  list.appendChild(document.createElement('conversation-footer'));
  const area = {
    _conversation: conversation,
    _messageThread: conversation?.rootMessageThread,
    _threadYMap: null,
    _isGroupColumn: false,
    ...state
  };
  return { area, list };
}

/**
 * Render a column's workspace banner and hand back what it put there.
 * @param {any} conversation - The conversation the column shows.
 * @param {object} [state] - Column state, as for {@link columnFor}.
 * @returns {HTMLElement|null} The banner, or null when the column shows none.
 */
function bannerFor(conversation, state = {}) {
  const { area, list } = columnFor(conversation, state);
  ensureWorkspaceBanner(area, list);
  return /** @type {HTMLElement|null} */ (list.querySelector('.conversation-workspace-banner'));
}

/**
 * Wait for the worker's last word on the undo stack to reach the document.
 *
 * One ping makes the worker close its undo-capture window and flush its Yjs
 * batcher — the undo state is emitted before the ack — and flushing pending
 * inbound updates applies that frame synchronously, so `canUndo()` reads
 * current state on the next line rather than measuring a sleep.
 * @param {any} conversation - The conversation whose stack is in question.
 * @returns {Promise<void>} When the document is current.
 */
async function syncUndoState(conversation) {
  await workerManager.ping(conversation.id);
  conversation._doc.flushPendingUpdates();
}

/**
 * A conversation's seeded file item for a path, as the document holds it now.
 *
 * Item instances are transient wrappers around CRDT data — fresh objects on
 * every read — so a case that wants to know what the next turn would see has to
 * ask again rather than hold one from before.
 * @param {any} conversation - The conversation to look in.
 * @param {string} path - The path it was seeded for.
 * @returns {any} The item, or undefined.
 */
function seededFile(conversation, path) {
  return conversation.rootMessageThread.contextItems.find(
    (/** @type {any} */ item) => item.type === 'file-content' && item.data.path === path);
}

/**
 * Count the calls the seeding pass makes, for the "exactly once" cases.
 * @param {any} session - The test session.
 * @returns {{calls: () => number, restore: () => void}} The counter and its undo.
 */
function countSeeds(session) {
  const original = session.seedConversationAutoItems.bind(session);
  let calls = 0;
  session.seedConversationAutoItems = async (/** @type {any[]} */ ...args) => {
    calls++;
    return original(...args);
  };
  return {
    calls: () => calls,
    restore: () => { session.seedConversationAutoItems = original; }
  };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
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

  // A workspace put on the server's table BEFORE this suite's session loads, so
  // that the load has a table to bring back and the payload it is read from can
  // be wrong in a way a test notices. Rooted at the project because that is the
  // one directory certain to exist: the server rechecks every root at load, and
  // a row pointing at nothing comes back unavailable.
  const projectPath = (await fetchJson('/api/session')).projectPath;
  const registered = await fetchJson('/api/session/workspaces', {
    method: 'POST',
    body: { root: projectPath, label: 'a tree of this suite\'s own', state: 'ready' }
  });
  const registeredId = registered.workspace.id;

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let fileEditingWas;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  try {
    session = await createTestSession();

    // The seeds are mostly silent by design (they write nothing when the session
    // default is the built-in one), so this suite watches the one that leaves a
    // visible mark: the file-editing preference, whose seed adds a conversation
    // rule. It is switched on here and put back at the end.
    fileEditingWas = session.getMetadata(DEFAULT_FILE_EDITING_META_KEY);
    session.applySessionMetadataPatch({ [DEFAULT_FILE_EDITING_META_KEY]: true });

    await run('a blank conversation is born unbound, holding the seeds the project would give it', async () => {
      // Born uninitialised and bound to nothing, but not empty. The tree it
      // would work in if nobody says otherwise is the project — which is what
      // the setup panel offers pre-selected — so its seeds are built for that
      // one straight away, where the user can see what the first turn would
      // carry while there is still time to change it.
      const seeds = countSeeds(session);
      /** @type {any} */
      let conversation = null;
      try {
        conversation = await makeConversation(session, 'unseeded', { initialise: false });
        release(conversation);
        assert(seeds.calls() === 1,
          `its seeds are built once, at creation, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }

      assert(conversation.initialised === false,
        `a deferred conversation reports itself uninitialised, got ${JSON.stringify(conversation.initialised)}`);
      assert(conversation.workspaceId === '',
        `and bound to nothing, got ${JSON.stringify(conversation.workspaceId)}`);
      assert(conversation.seededFor === '',
        `while recording which tree those seeds are for, got ${JSON.stringify(conversation.seededFor)}`);
    });

    await run('initialising it against the tree it was seeded for adds nothing back', async () => {
      const conversation = await makeConversation(session, 'initialised-by-hand', { initialise: false });
      release(conversation);

      const seeds = countSeeds(session);
      try {
        await session.initialiseConversation(conversation);
        assert(seeds.calls() === 0,
          `the pass for that tree has already run, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }
      assert(conversation.initialised === true, 'and the conversation reports itself initialised');
    });

    await run('initialising it against another tree seeds that one', async () => {
      const conversation = await makeConversation(session, 'initialised-elsewhere', { initialise: false });
      release(conversation);

      const seeds = countSeeds(session);
      try {
        await session.initialiseConversation(conversation, { workspaceId: registeredId });
        assert(seeds.calls() === 1,
          `a tree it was not seeded for is read now, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }
      assert(conversation.seededFor === registeredId,
        `and becomes the tree its seeds are for, got ${JSON.stringify(conversation.seededFor)}`);
    });

    await run('a conversation created the ordinary way is born initialised', async () => {
      const conversation = await makeConversation(session, 'born-initialised');
      release(conversation);

      assert(conversation.initialised === true,
        'the default is unchanged: everything that is not the blank tab is seeded at birth');
      assert(isFileEditingAllowed(conversation.rootMessageThread) === true,
        'with the same seeds as before workspaces existed');
    });

    await run('racing triggers initialise it exactly once', async () => {
      const conversation = await makeConversation(session, 'raced', { initialise: false });
      release(conversation);

      // Put back into the state of a conversation whose seeds have never been
      // built — which is what an undone setup leaves behind, and what every
      // conversation written before any of this looks like — so that the racing
      // triggers have a pass between them to duplicate.
      conversation.seededFor = null;

      const seeds = countSeeds(session);
      try {
        await Promise.all([
          conversation.ensureInitialised(),
          conversation.ensureInitialised(),
          conversation.ensureInitialised()
        ]);
        assert(seeds.calls() === 1,
          `three triggers at once seed once, got ${seeds.calls()}`);
        await conversation.ensureInitialised();
        assert(seeds.calls() === 1,
          `and an already-initialised conversation is never seeded again, got ${seeds.calls()}`);
      } finally {
        seeds.restore();
      }
      assert(conversation.initialised === true, 'and it ends up initialised');
    });

    await run('sending is a commit: the first message initialises the conversation', async () => {
      const conversation = await makeConversation(session, 'committed-by-send', { initialise: false });
      release(conversation);

      const seeds = countSeeds(session);
      try {
        const refused = await conversation.sendMessage('Hello there', null, conversation.rootMessageThread, {
          consumeComposer: false
        });
        assert(refused === null, `expected the send to be accepted, got ${JSON.stringify(refused)}`);
        assert(conversation.initialised === true,
          'a conversation with content in it has made its choice');
        assert(seeds.calls() === 0,
          `and the send does not seed over the items it was already showing, got ${seeds.calls()}`);
      } finally {
        seeds.restore();
      }
    });

    await run('a conversation that predates the flag is never seeded a second time', async () => {
      // Every conversation on disk today has no `initialised` in its metadata,
      // so each one reaches its next send looking exactly like a conversation
      // that has never been seeded. Seeding it again would resurrect the items
      // its user had deleted and clear the undo history behind their work.
      const conversation = await makeConversation(session, 'from-before-the-flag');
      release(conversation);
      const refused = await conversation.sendMessage('a turn from before all this', null, conversation.rootMessageThread, {
        consumeComposer: false
      });
      assert(refused === null, `expected the send to be accepted, got ${JSON.stringify(refused)}`);
      // The worker writes the user item and it syncs back, so the history this
      // case is about arrives a moment after the send is accepted.
      await waitFor(() => conversation.rootMessageThread.items.some(
        (/** @type {any} */ item) => item?.get?.('type') === 'user'),
      { description: 'the sent message to reach the document' });

      // What an upgrade looks like: history in the document, and no flag.
      conversation.setMetadata(INITIALISED_KEY, false);
      assert(conversation.initialised === false, 'the conversation now looks uninitialised, as an upgraded one does');

      const seeds = countSeeds(session);
      try {
        await conversation.ensureInitialised();
        assert(seeds.calls() === 0,
          `a conversation with history behind it is left alone, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }
      assert(conversation.initialised === true,
        'and is recorded as initialised, so it is only ever asked this once');
    });

    await run('a permission the user changed in the blank tab survives its first send', async () => {
      // The window this suite created: a blank tab exists for as long as the
      // user takes to set it up, and only then does its first content arrive.
      // Everything seeded at that moment is written over something of theirs,
      // so only the seeds that genuinely depend on where the conversation works
      // may wait that long. A permission rule does not: it carries no root at
      // all — the tree it implicitly allows is resolved per authorisation from
      // the live binding — so it belongs at creation, where there is nothing
      // to overwrite.
      const conversation = await makeConversation(session, 'chose-before-sending', { initialise: false });
      release(conversation);

      assert(isFileEditingAllowed(conversation.rootMessageThread) === true,
        'a blank tab starts from the session default like every other conversation');

      setFileEditingAllowed(conversation.rootMessageThread, false);
      await conversation.ensureInitialised();

      assert(isFileEditingAllowed(conversation.rootMessageThread) === false,
        'and committing it does not hand back a permission the user turned off');
    });

    await run('a strategy the user picked in the blank tab survives its first send', async () => {
      // Non-stock on both sides deliberately: the seed writes nothing when the
      // session default is the built-in one, so a case run stock would pass
      // without the fix it is about.
      const strategyWas = getDefaultStrategyId(session);
      await setDefaultStrategyId(session, 'yolo');
      try {
        const conversation = await makeConversation(session, 'picked-a-strategy', { initialise: false });
        release(conversation);
        const mt = conversation.rootMessageThread;

        assert(mt.currentStrategyId === 'yolo',
          `a blank tab starts on the session's default strategy, got ${JSON.stringify(mt.currentStrategyId)}`);

        mt.setStrategy('read-only');
        await conversation.ensureInitialised();

        assert(mt.currentStrategyId === 'read-only',
          `and the strategy the user picked is still the strategy, got ${JSON.stringify(mt.currentStrategyId)}`);
      } finally {
        await setDefaultStrategyId(session, strategyWas || '');
      }
    });

    await run('a system prompt the user typed in the blank tab survives its first send', async () => {
      const presetWas = getDefaultPresetId();
      await setDefaultPreset('minimal');
      try {
        const conversation = await makeConversation(session, 'typed-a-prompt', { initialise: false });
        release(conversation);
        const mt = conversation.rootMessageThread;
        /**
         * @param {any} thread - The thread holding it.
         * @returns {any} The system-prompt item.
         */
        const promptItem = (thread) => thread.contextItems.find((/** @type {any} */ i) => i.type === 'system-prompt');

        const seeded = promptItem(mt);
        assert(seeded?.data?.selectedPresetId === 'minimal',
          `a blank tab starts from the session's default preset, got ${JSON.stringify(seeded?.data)}`);

        mt.updateContextItem(seeded.id, {
          data: { ...seeded.data, text: 'what the user typed instead', isModified: true }
        });
        await conversation.ensureInitialised();

        const after = promptItem(mt);
        assert(after?.data?.text === 'what the user typed instead',
          `and the prompt they typed is still there afterwards, got ${JSON.stringify(after?.data?.text)}`);
        assert(after?.data?.isModified === true,
          'still marked as theirs rather than reset to the preset it no longer is');
      } finally {
        await setDefaultPreset(presetWas);
      }
    });

    await run('undo history the user made in the blank tab survives its first send', async () => {
      // The one that needs no unusual configuration and so reaches every user:
      // the undo clear runs unconditionally. Adding a context item outside a
      // send is the reachable way to have history here — the pinboard's "add to
      // context" — and is deliberately not a commit trigger, so the history is
      // still there when the first send arrives.
      const conversation = await makeConversation(session, 'has-undo-history', { initialise: false });
      release(conversation);

      await conversation.rootMessageThread.executeContextItem('file-content', { path: 'README.md' });
      await syncUndoState(conversation);
      assert(conversation.canUndo() === true,
        'precondition: the user did something undoable in the blank tab');

      await conversation.ensureInitialised();
      await syncUndoState(conversation);

      assert(conversation.canUndo() === true,
        'committing the conversation does not wipe the undo history behind their work');
    });

    await run('picking another tree rebuilds the seeds out of it', async () => {
      // A conversation shows what its first turn would carry from the moment it
      // exists, which means it is showing one particular tree's assistant files.
      // Answering the question with a different tree has to replace them, or the
      // list is describing somewhere the conversation is not going to work.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-swap-${stamp}`;
      const marker = `# instructions only this tree has ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      // `.cursorrules` is an assistant file the project root does not have, so
      // its arrival and departure are the tree being read, not a cache.
      await writeFileOp({ path: `${elsewhere}/.cursorrules`, content: marker });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'a tree with rules of its own', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'seeds-follow-the-row', { initialise: false });
        release(conversation);

        assert(!seededFile(conversation, '.cursorrules'),
          'precondition: the tree it starts on has no rules file');

        // `seededFor` is written last, so it is the pass having finished rather
        // than an item having arrived part-way through one.
        selectSetupRow(conversation, made.workspace.id);
        await waitFor(() => conversation.seededFor === made.workspace.id,
          { description: 'the seeds to be rebuilt out of the selected tree' });
        assert(seededFile(conversation, '.cursorrules'),
          'the assistant file only that tree has is now in the conversation');
        const text = await seededFile(conversation, '.cursorrules').createContextText({});
        assert(text.includes(marker),
          `read from that tree rather than named after it, got ${JSON.stringify(text)}`);

        selectSetupRow(conversation, PROJECT_ROW_ID);
        await waitFor(() => conversation.seededFor === PROJECT_ROW_ID,
          { description: 'changing the answer to rebuild them again' });
        assert(!seededFile(conversation, '.cursorrules'),
          'and answering with the project again takes it away');
        assert(conversation.initialised === false,
          'while none of it has bound the conversation to anything');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('a rebuild replaces the seeds and nothing else', async () => {
      // The seeded assistant files are an answer to where the conversation
      // works. A file the user pinned themselves is not — nor is the prompt they
      // are editing — so changing the answer may not touch either.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-keep-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${elsewhere}/.cursorrules`, content: `# ${stamp}` });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'somewhere else entirely', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'keeps-what-is-theirs', { initialise: false });
        release(conversation);
        const mt = conversation.rootMessageThread;

        await mt.executeContextItem('file-content', { path: 'README.md' });
        const pinned = seededFile(conversation, 'README.md');
        assert(pinned && pinned.data.seeded !== true,
          'precondition: the user pinned a file of their own, which is not a seed');

        selectSetupRow(conversation, made.workspace.id);
        await waitFor(() => conversation.seededFor === made.workspace.id,
          { description: 'the seeds to be rebuilt' });

        const after = seededFile(conversation, 'README.md');
        assert(after, 'the file the user pinned is still in the conversation');
        assert(after.id === pinned.id,
          `and is the same item rather than one seeded over it, got ${JSON.stringify(after.id)}`);
        assert(mt.contextItems.some((/** @type {any} */ item) => item.type === 'system-prompt'),
          'and the prompt it starts from is untouched');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('a seed the user deleted before sending does not come back', async () => {
      // The point of building the seeds early is that the user can see what the
      // first turn would carry while there is still time to change it. Seeding
      // again at the send would take that back.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-deleted-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${elsewhere}/.cursorrules`, content: `# ${stamp}` });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'a tree with one instruction', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'deleted-a-seed', { initialise: false });
        release(conversation);

        selectSetupRow(conversation, made.workspace.id);
        await waitFor(() => conversation.seededFor === made.workspace.id,
          { description: 'the seeds of the selected tree' });

        conversation.rootMessageThread.removeContextItem(seededFile(conversation, '.cursorrules').id);
        assert(!seededFile(conversation, '.cursorrules'), 'precondition: the user threw it away');

        const refused = await conversation.sendMessage('now send it', null, conversation.rootMessageThread, {
          consumeComposer: false
        });
        assert(refused === null, `expected the send to be accepted, got ${JSON.stringify(refused)}`);
        assert(conversation.workspaceId === made.workspace.id,
          `the send binds it to the row that was picked, got ${JSON.stringify(conversation.workspaceId)}`);
        assert(!seededFile(conversation, '.cursorrules'),
          'and does not put back the seed they had already looked at and removed');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('the same bytes under two names are seeded once, whoever pinned them', async () => {
      // A common setup keeps CLAUDE.md and AGENTS.md as one file under two
      // names. The insert-time dedup matches on path, so the hashes are what
      // collapse them — including the hash of a copy the user pinned before the
      // seeds went looking, which is otherwise the one way to get the same bytes
      // into one conversation twice.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-twins-${stamp}`;
      const shared = `# one file, two names ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${elsewhere}/AGENTS.md`, content: shared });
      await writeFileOp({ path: `${elsewhere}/CLAUDE.md`, content: shared });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'a tree that keeps both', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'pinned-one-of-a-pair', { initialise: false });
        release(conversation);

        await conversation.rootMessageThread.executeContextItem('file-content', { path: 'AGENTS.md' });

        selectSetupRow(conversation, made.workspace.id);
        await waitFor(() => conversation.seededFor === made.workspace.id,
          { description: 'the seeds of the tree that keeps both' });

        assert(!seededFile(conversation, 'CLAUDE.md'),
          'the bytes the user already pinned are not seeded again under the other name');
        const theirs = conversation.rootMessageThread.contextItems
          .filter((/** @type {any} */ item) => item.type === 'file-content' && item.data.path === 'AGENTS.md');
        assert(theirs.length === 1,
          `and their own pin is left as the one copy of them, got ${theirs.length}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('a conversation born from another inherits its workspace, already initialised', async () => {
      const source = await makeConversation(session, 'binding-source', { workspaceId: 'ws_inherited' });
      release(source);
      assert(source.workspaceId === 'ws_inherited',
        `a create can carry a binding, got ${JSON.stringify(source.workspaceId)}`);
      assert(source.initialised === true, 'and is seeded at birth, since nobody is being asked anything');

      const root = source.rootMessageThread;
      root.addUserMessage('something worth taking to its own tab');
      const newId = await source.copyItemsToNewTab(root, [root.items.length - 1], { name: 'inheritor' });
      assert(newId, 'the copy produced a conversation');
      const inheritor = session.conversations.get(newId);
      release(inheritor);

      assert(inheritor.workspaceId === 'ws_inherited',
        `the spawned conversation works in the same tree as the one that spawned it, got ${JSON.stringify(inheritor.workspaceId)}`);
      assert(inheritor.initialised === true,
        'and never waits to be asked — the question was answered by where it came from');
    });

    await run('a duplicate carries the binding in the cloned document', async () => {
      const source = await makeConversation(session, 'duplicate-source', { workspaceId: 'ws_cloned' });
      release(source);

      const cloneId = await session.duplicateConversation(source.id);
      assert(cloneId, 'the duplicate produced a conversation');
      const clone = session.conversations.get(cloneId);
      release(clone);

      assert(clone.workspaceId === 'ws_cloned',
        `a clone works where its original did, got ${JSON.stringify(clone.workspaceId)}`);
      assert(clone.initialised === true,
        'and is as initialised as its original — the document was copied whole, seeds and all');
    });

    await run('the load brings the session the workspace table', async () => {
      const row = session.workspaces.find((/** @type {any} */ w) => w.id === registeredId);
      assert(row,
        `the loaded session holds the workspace the server was told about, got ${JSON.stringify(session.workspaces)}`);
      assert(row.root === projectPath,
        `carrying where it is, got ${JSON.stringify(row.root)}`);
      assert(row.state === 'ready' && row.available === true,
        `and whether it can be worked in, got ${JSON.stringify(row)}`);
    });

    await run('a workspaces-changed broadcast replaces the table', async () => {
      // The table is session state like the pinboard: the server republishes the
      // whole thing after every edit, which is what carries a provisioning →
      // ready flip to a window that is only watching.
      const ws = /** @type {any} */ (session._services.wsService);
      const saved = session.workspaces;
      try {
        ws.emit('workspaces-changed', { workspaces: [workspaceRow('ws_broadcast', '/tmp/broadcast')] });
        assert(session.workspaces.length === 1 && session.workspaces[0].id === 'ws_broadcast',
          `the broadcast's table is the table, got ${JSON.stringify(session.workspaces)}`);

        ws.emit('workspaces-changed', { workspaces: [] });
        assert(session.workspaces.length === 0,
          `including when it is empty — the last workspace being unregistered is an edit like any other, got ${JSON.stringify(session.workspaces)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('an unusable binding refuses rather than falling back to the project', async () => {
      // The four refusals the server makes in WorkspaceLookup.Usable. They have
      // to agree: a stale binding that quietly resolved to the project root
      // would edit the wrong tree and look exactly like working.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_ready', '/tmp/ready'),
        workspaceRow('ws_building', '/tmp/building', { state: 'provisioning', available: false }),
        workspaceRow('ws_done', '/tmp/done', { state: 'closed' }),
        workspaceRow('ws_gone', '/tmp/gone', { available: false })
      ];
      try {
        assert(session.workspaceRoot('') === session.projectPath,
          `naming no workspace is the project, as it was before workspaces existed, got ${JSON.stringify(session.workspaceRoot(''))}`);
        assert(session.workspaceRoot('ws_ready') === '/tmp/ready',
          `a ready workspace is its root, got ${JSON.stringify(session.workspaceRoot('ws_ready'))}`);
        assert(session.workspaceRoot('ws_building') === null,
          `one still being built is nowhere to work yet, got ${JSON.stringify(session.workspaceRoot('ws_building'))}`);
        assert(session.workspaceRoot('ws_done') === null,
          `nor is one somebody finished with, got ${JSON.stringify(session.workspaceRoot('ws_done'))}`);
        assert(session.workspaceRoot('ws_gone') === null,
          `nor one whose root has gone, got ${JSON.stringify(session.workspaceRoot('ws_gone'))}`);
        assert(session.workspaceRoot('ws_never_registered') === null,
          `and an id the session never heard of is an error, not the project, got ${JSON.stringify(session.workspaceRoot('ws_never_registered'))}`);
        assert(session.getWorkspace('') === null,
          'the default workspace has no row to find — a caller that wants its root already has the project path');

        // And the three surfaces that ask this question agree, row for row.
        // They used to decide it separately and one of them had drifted: the
        // picker read the state and not the root, so a workspace whose tree
        // had been deleted went on being offered as somewhere to start work.
        const offered = new Set(setupRows(session)
          .filter((/** @type {any} */ row) => row.kind === 'workspace')
          .map((/** @type {any} */ row) => row.id));
        for (const row of session.workspaces) {
          const usable = isWorkspaceUsable(row);
          assert(usable === (session.workspaceRoot(row.id) !== null),
            `${row.id}: the binding resolver disagrees with the predicate (usable=${usable})`);
          assert(usable === offered.has(row.id),
            `${row.id}: the picker disagrees with the predicate (usable=${usable}, offered=${offered.has(row.id)})`);
        }
        assert(offered.size === 1 && offered.has('ws_ready'),
          `exactly the one usable row is offered, got ${JSON.stringify([...offered])}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a conversation works in the tree its binding names', async () => {
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_tree', '/tmp/tree')];
      try {
        const bound = await makeConversation(session, 'bound-to-a-tree', { workspaceId: 'ws_tree' });
        release(bound);
        assert(bound.workspaceRoot === '/tmp/tree',
          `a bound conversation resolves its own root, got ${JSON.stringify(bound.workspaceRoot)}`);

        bound.workspaceId = '';
        assert(bound.workspaceRoot === session.projectPath,
          `and one bound to nothing works in the project, got ${JSON.stringify(bound.workspaceRoot)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a tool runs in the tree its conversation is bound to', async () => {
      // A real second tree, registered with the real server: `src/` is in the
      // fixture and `greeter.js` exists only inside it, so a read of
      // `greeter.js` that resolves anywhere else finds nothing. That is the
      // point of the case — an op that quietly ran in the project would be
      // indistinguishable from a working one if the file existed in both.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'src, as a tree of its own', state: 'ready'
      });
      const id = made.id;
      // The row the server just made, put on the client's table by hand: a unit
      // test's wsService is a mock, so no `workspaces-changed` broadcast arrives
      // here. What that transport does is pinned by the two cases above; this
      // one is about where the operation lands.
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        const bound = await makeConversation(session, 'reads-in-its-tree', { workspaceId: id });
        release(bound);
        const inTree = await readIn(session, bound, 'greeter.js');
        assert(inTree.exists !== false,
          `a bound conversation's read resolves against its workspace, got ${JSON.stringify(inTree)}`);
        assert(typeof inTree.content === 'string' && inTree.content.length > 0,
          `and comes back with the file's bytes, got ${JSON.stringify(inTree.content)}`);

        const unbound = await makeConversation(session, 'reads-in-the-project');
        release(unbound);
        const inProject = await readIn(session, unbound, 'greeter.js');
        assert(inProject.exists === false,
          `while the project holds no such file, which is what makes the case above mean anything, got ${JSON.stringify(inProject)}`);
      } finally {
        session.workspaces = saved;
        // Swallowed rather than thrown from a finally, where it would replace
        // whichever assertion actually failed with a tidying-up error.
        await unregisterWorkspace(id).catch(() => {});
      }
    });

    await run('a streaming command runs in the tree too, and refuses a binding it cannot honour', async () => {
      // The bash tool's output streams, so it rides the WebSocket rather than
      // /api/ops/call — a second transport, which has to confine a command the
      // same way the first one does or the most destructive tool is the one
      // running in the wrong place.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, for a command', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const bound = await makeConversation(session, 'runs-in-its-tree', { workspaceId: id });
        release(bound);

        const marker = `ws-shell-${Math.random().toString(36).slice(2, 8)}.txt`;
        const ran = await shellExecuteStreaming(
          { command: `echo made-here > ${marker}` }, () => {}, undefined, id);
        assert(ran.success, `the command ran, got ${JSON.stringify(ran)}`);

        const landed = await readIn(session, bound, marker);
        assert(landed.exists !== false,
          `and what it wrote is in the conversation's tree, got ${JSON.stringify(landed)}`);

        const unbound = await makeConversation(session, 'looks-in-the-project');
        release(unbound);
        const elsewhere = await readIn(session, unbound, marker);
        assert(elsewhere.exists === false,
          `and nowhere else, got ${JSON.stringify(elsewhere)}`);

        const refused = await shellExecuteStreaming(
          { command: 'echo this must not run' }, () => {}, undefined, 'ws_never_registered');
        assert(refused.success === false && refused.error,
          `an id the session never heard of is refused rather than run in the project, got ${JSON.stringify(refused)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a command cancelled mid-flight is killed, not merely abandoned', async () => {
      // Everything a provider does while a workspace is being built runs through
      // this facade, and Cancel is only honest if the command actually dies: a
      // fifteen-minute `npm ci` that keeps going after the panel says it stopped
      // is the one outcome the cancel story cannot survive. Both ends of that
      // were already in place — the server kills the process group when a
      // request context is cancelled, and `callOp` has always taken a signal.
      // The facade in between had no way to pass one.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'src, for a cancelled command', state: 'ready'
      });
      const id = made.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      const ops = createBoundOps(() => ({ workspaceId: id }));
      const tag = Math.random().toString(36).slice(2, 8);
      const started = `ws-cancel-started-${tag}.txt`;
      const finished = `ws-cancel-finished-${tag}.txt`;
      try {
        const controller = new AbortController();
        const running = ops.shell(
          { command: `echo yes > ${started}; sleep 1; echo yes > ${finished}` },
          controller.signal
        );
        // Collected rather than assigned to a local: an assignment made inside
        // the rejection handler is invisible to the type checker, which then
        // reads every test of it as comparing null against null.
        /** @type {any[]} */
        const rejections = [];
        const settled = running.then(() => {}, (error) => { rejections.push(error); });

        // Abort only once the command has demonstrably begun. Aborting before
        // there is a process to kill leaves the second marker missing for a
        // reason that has nothing to do with cancelling anything, which is a
        // pass this case must not be able to score.
        assert(await fileTurnsUp(ops, started, 5000),
          'the command never started, so there was nothing for the abort to prove');
        controller.abort();
        await settled;

        assert(rejections.length === 1,
          `aborting rejects the operation rather than resolving it, got ${rejections.length} rejections`);
        assert(/abort/i.test(String(rejections[0]?.name ?? rejections[0])),
          `and rejects with the caller's abort rather than some later failure, got ${String(rejections[0])}`);
        assert(!(await fileTurnsUp(ops, finished, 2500)),
          'and the command died with it — the second marker means it ran to completion in a tree nobody was watching any more');
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(id).catch(() => {});
      }
    });

    await run('a checkpoint writes one key of a workspace without disturbing the rest', async () => {
      // How a provider records what it has built as it builds it. Each step
      // writes only its own key, because the alternative — restating the whole
      // of `meta` every time — is a read-modify-write across the wire that two
      // windows, or two steps, can lose each other's progress through.
      const made = await registerWorkspace({
        root: `${projectPath}/src`,
        label: 'src, being checkpointed',
        state: 'provisioning',
        meta: { dir: '/tmp/half-built' }
      });
      try {
        const afterFirst = await patchWorkspace(made.id, { meta: { treeAdded: true } });
        assert(afterFirst.meta?.dir === '/tmp/half-built' && afterFirst.meta?.treeAdded === true,
          `a checkpoint merges into meta rather than replacing it, got ${JSON.stringify(afterFirst.meta)}`);

        const afterSecond = await patchWorkspace(made.id, { meta: { dir: null }, state: 'ready' });
        assert(!('dir' in (afterSecond.meta ?? {})),
          `and a null value deletes its key, got ${JSON.stringify(afterSecond.meta)}`);
        assert(afterSecond.meta?.treeAdded === true,
          `while leaving the keys it said nothing about, got ${JSON.stringify(afterSecond.meta)}`);
        assert(afterSecond.state === 'ready' && afterSecond.label === 'src, being checkpointed',
          `and the fields outside meta patch the same way, got ${JSON.stringify(afterSecond)}`);
      } finally {
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });


    await run('the seeds find and read the assistant files of the bound tree', async () => {
      // The whole reason a conversation is seeded late is that its AGENTS.md is
      // whichever tree it works in — so this is the case the deferral was for.
      // The probe and the read are asserted together because threading one
      // without the other is worse than threading neither: a conversation would
      // be seeded with the name of the workspace's file and the contents of the
      // project's.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, with instructions of its own', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        // `.cursorrules` is an assistant file the project root does not have, so
        // a probe that resolves anywhere but the workspace finds nothing to seed,
        // and a read that does comes back missing.
        const marker = `# only in the workspace ${Math.random().toString(36).slice(2, 8)}`;
        await writeFileOp({ path: '.cursorrules', content: marker }, undefined, undefined, id);

        const bound = await makeConversation(session, 'seeded-from-its-tree', { workspaceId: id });
        release(bound);
        const seeded = bound.rootMessageThread.contextItems
          .filter((/** @type {any} */ item) => item.type === 'file-content');
        const rules = seeded.find((/** @type {any} */ item) => item.data.path === '.cursorrules');
        assert(rules,
          `the conversation is seeded with its own tree's assistant files, got ${JSON.stringify(seeded.map((/** @type {any} */ i) => i.data.path))}`);

        const text = await rules.createContextText({});
        assert(text.includes(marker),
          `and the item it seeded reads them from that tree, got ${JSON.stringify(text)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a conversation moved to another tree reads that tree\'s instructions', async () => {
      // Deferring initialisation exists so that a conversation is never seeded
      // out of a tree it does not work in. A rebind puts it straight back into
      // that state: the binding moves, everything that travels by id follows it,
      // and the assistant file the model actually reads stays a frozen snapshot
      // of the tree it has left. The stranded-conversation banner performs this
      // move today, so this is not a hypothetical.
      const stamp = Math.random().toString(36).slice(2, 8);
      const from = `rebind-from-${stamp}`;
      const to = `rebind-to-${stamp}`;
      const fromMarker = `# instructions of the tree it started in ${stamp}`;
      const toMarker = `# instructions of the tree it moved to ${stamp}`;
      const onlyThere = `# a file the tree it left never had ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${from}/AGENTS.md`, content: fromMarker });
      await writeFileOp({ path: `${to}/AGENTS.md`, content: toMarker });
      await writeFileOp({ path: `${to}/.cursorrules`, content: onlyThere });
      const madeFrom = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${from}`, label: 'where it started', state: 'ready' }
      });
      const madeTo = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${to}`, label: 'where it moved to', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom.workspace, madeTo.workspace];
      try {
        const moved = await makeConversation(session, 'moved-to-another-tree',
          { workspaceId: madeFrom.workspace.id });
        release(moved);
        const agents = seededFile(moved, 'AGENTS.md');
        assert(agents, 'the conversation is seeded with the assistant file of the tree it was made in');

        // A seeded item snapshots itself on its first request render, and that
        // snapshot reaches the document. Taking it here is what makes this a
        // case about a conversation carrying another tree's bytes rather than
        // one about a wrapper held too long.
        const before = await agents.createContextText({ forRequest: true });
        assert(before.includes(fromMarker),
          `and reads it while it works there, got ${JSON.stringify(before)}`);
        await waitFor(() => typeof seededFile(moved, 'AGENTS.md')?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const result = await rebindConversation(moved, madeTo.workspace.id);
        assert(result.done, `the move is allowed, got ${JSON.stringify(result.message)}`);

        await waitFor(() => (seededFile(moved, 'AGENTS.md')?.data.content || '') !== before,
          { description: 'the move to take the snapshot again' });
        const after = await seededFile(moved, 'AGENTS.md').createContextText({});
        assert(after.includes(toMarker),
          `a conversation that moved reads the instructions of the tree it moved to, got ${JSON.stringify(after)}`);

        // The other half of the same question: instructions the new tree has and
        // the old one never did apply to this conversation now, and it has no
        // item for them at all until the move goes looking.
        const arrived = seededFile(moved, '.cursorrules');
        assert(arrived, 'and is seeded with the assistant files only the new tree has');
        assert((await arrived.createContextText({})).includes(onlyThere),
          'which it reads from that tree');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${madeFrom.workspace.id}`, { method: 'DELETE', fallback: null });
        await fetchJson(`/api/session/workspaces/${madeTo.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [from, to] });
      }
    });

    await run('a file the new tree does not have keeps the bytes it was seeded with', async () => {
      // A file that is not there reads as "File does not exist", which is an
      // answer and not a snapshot. Freezing that over the real one would destroy
      // the only copy the conversation had of instructions its user may well
      // still want — so a snapshot is only ever replaced by another snapshot.
      const stamp = Math.random().toString(36).slice(2, 8);
      const had = `rebind-had-${stamp}`;
      const lacks = `rebind-lacks-${stamp}`;
      const marker = `# instructions only the tree it left ever had ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${had}/AGENTS.md`, content: marker });
      // The destination has instructions of its own under a different name, and
      // none at all under this one. Its arrival is also the barrier this case
      // needs: an item can only be seeded after the move has finished refreshing
      // the items that were already there.
      await writeFileOp({ path: `${lacks}/.cursorrules`, content: `# different instructions ${stamp}` });
      const madeHad = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${had}`, label: 'a tree with instructions', state: 'ready' }
      });
      const madeLacks = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${lacks}`, label: 'a tree with none', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeHad.workspace, madeLacks.workspace];
      try {
        const moved = await makeConversation(session, 'moved-somewhere-barer',
          { workspaceId: madeHad.workspace.id });
        release(moved);
        const agents = seededFile(moved, 'AGENTS.md');
        assert(agents, 'the conversation is seeded with the assistant file of the tree it was made in');
        await agents.createContextText({ forRequest: true });
        await waitFor(() => typeof seededFile(moved, 'AGENTS.md')?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const result = await rebindConversation(moved, madeLacks.workspace.id);
        assert(result.done, `the move is allowed, got ${JSON.stringify(result.message)}`);
        await waitFor(() => seededFile(moved, '.cursorrules'),
          { description: 'the move to finish, which the new tree\'s own instructions arriving proves' });

        const after = await seededFile(moved, 'AGENTS.md').createContextText({});
        assert(after.includes(marker),
          `the snapshot survives a move to a tree without the file, got ${JSON.stringify(after)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${madeHad.workspace.id}`, { method: 'DELETE', fallback: null });
        await fetchJson(`/api/session/workspaces/${madeLacks.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [had, lacks] });
      }
    });

    await run('a conversation is not moved out from under a turn in flight', async () => {
      // Finishing with a workspace is refused mid-turn because removing a tree
      // under a running agent loses work. A move is the same hazard in different
      // clothes: the turn carries on, and its next operation lands in a tree it
      // never agreed to work in.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'somewhere else entirely', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const busy = await makeConversation(session, 'busy-where-it-is');
        release(busy);
        Object.defineProperty(busy, 'isProcessing', { get: () => true, configurable: true });

        const refused = await rebindConversation(busy, id);
        assert(!refused.done, `a move is refused while a turn is running, got ${JSON.stringify(refused)}`);
        assert((busy.workspaceId || '') === '',
          `and the conversation is left where it was, got ${JSON.stringify(busy.workspaceId)}`);

        Object.defineProperty(busy, 'isProcessing', { get: () => false, configurable: true });
        const allowed = await rebindConversation(busy, id);
        assert(allowed.done && busy.workspaceId === id,
          `and goes once the turn is over, got ${JSON.stringify(allowed)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a sandboxed script is told the tree its conversation works in', async () => {
      // query_code's `projectRoot` is the one root the model is handed rather
      // than confined by: nothing downstream checks the paths a script builds
      // from it. Left at the session's project while the same script's `fs` had
      // followed the conversation, every path it computed would name a tree its
      // own reads could not reach.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, for a script', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const bound = await makeConversation(session, 'queries-in-its-tree', { workspaceId: id });
        release(bound);
        // The binding is contracted POSIX-style, so compare it that way — on
        // Windows the session's own path is native and would never match.
        const posix = (/** @type {string} */ p) => p.replace(/\\/g, '/');
        const inTree = await queryIn(session, bound, 'return projectRoot;');
        assert(inTree.result === `${posix(projectPath)}/src`,
          `the script's root is the conversation's workspace, got ${JSON.stringify(inTree.result)}`);

        const unbound = await makeConversation(session, 'queries-in-the-project');
        release(unbound);
        const inProject = await queryIn(session, unbound, 'return projectRoot;');
        assert(inProject.result === posix(session.projectPath),
          `while a conversation bound to nothing still gets the project, as it always did, got ${JSON.stringify(inProject.result)}`);

        // A root is believed, so a binding that cannot be resolved refuses the
        // run outright. Falling back to the project would hand the model a tree
        // its own ops are refusing, which reads as the tool working.
        bound.workspaceId = 'ws_never_registered';
        let refusal = null;
        try {
          await queryIn(session, bound, 'return projectRoot;');
        } catch (e) {
          refusal = e instanceof Error ? e.message : String(e);
        }
        assert(refusal !== null,
          'a binding the session cannot honour refuses the run rather than substituting the project');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a bound conversation is implicitly allowed its own tree, not the project', async () => {
      // The implicit allowed root is what decides whether a write needs asking
      // about. Left as the project, a worktree conversation would have to
      // approve every edit to the tree it was made to work in, while edits to
      // the main tree went through silently — exactly backwards.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_perm', '/tmp/perm-tree')];
      try {
        const bound = await makeConversation(session, 'allowed-its-own-tree', { workspaceId: 'ws_perm' });
        release(bound);
        const allowed = bound.rootMessageThread.getAllowedPaths();
        assert(allowed[0] === '/tmp/perm-tree',
          `the conversation's own tree is the implicit root, got ${JSON.stringify(allowed)}`);
        assert(!allowed.includes(session.projectPath),
          `and the project is not implicitly writable from inside a worktree, got ${JSON.stringify(allowed)}`);

        bound.workspaceId = '';
        assert(bound.rootMessageThread.getAllowedPaths()[0] === session.projectPath,
          `while a conversation bound to nothing is allowed the project, as it always was, got ${JSON.stringify(bound.rootMessageThread.getAllowedPaths())}`);

        bound.workspaceId = 'ws_never_registered';
        assert(!bound.rootMessageThread.getAllowedPaths().includes(session.projectPath),
          `and a binding that cannot be honoured grants nothing, rather than quietly granting the project, got ${JSON.stringify(bound.rootMessageThread.getAllowedPaths())}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a bound transcript opens by saying which tree it is', async () => {
      // Everything below the banner happened somewhere other than the project,
      // and nothing else on screen says so — the window title, the project chip
      // and the file pins all still show the project, deliberately.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_shown', '/tmp/shown-tree', { label: 'feat/tunnels' })];
      try {
        const bound = await makeConversation(session, 'says-where-it-works', { workspaceId: 'ws_shown' });
        release(bound);

        const banner = bannerFor(bound);
        assert(banner, 'a bound conversation says where it is working');
        assert(banner?.querySelector('.workspace-banner-label')?.textContent === 'feat/tunnels',
          `by the name the user gave the workspace, got ${JSON.stringify(banner?.textContent)}`);
        assert(banner?.querySelector('.workspace-banner-root')?.textContent === '/tmp/shown-tree',
          `and the tree it actually resolves to, got ${JSON.stringify(banner?.textContent)}`);
        assert(banner === banner?.parentElement?.firstElementChild,
          'at the top of the transcript, above the items it scopes');

        // A sub-thread column is a lens on part of the same conversation, so it
        // works in the same tree; saying so again in every thread would be noise.
        assert(bannerFor(bound, { _threadYMap: {} }) === null,
          'and only once — a sub-thread column shares the conversation it hangs off');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a conversation in the project says nothing, and one bound to nowhere says that', async () => {
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_quiet', '/tmp/quiet-tree', { label: 'quiet' })];
      try {
        const project = await makeConversation(session, 'works-in-the-project');
        release(project);
        assert(bannerFor(project) === null,
          'the project is where a conversation has always worked, and needs no announcing');

        // What a binding that cannot be honoured must never do is NAME a tree
        // the conversation cannot reach — which is what this said nothing at all
        // to avoid, back when saying nothing was the only other option. The
        // banner for an unresolvable binding names no tree, because there is no
        // row left to name one from; it reports the state, which silence leaves
        // the user to discover through a turn that fails.
        const bound = await makeConversation(session, 'bound-to-a-ghost', { workspaceId: 'ws_quiet' });
        release(bound);
        assert(bannerFor(bound), 'a workspace it can work in is announced');

        bound.workspaceId = 'ws_never_registered';
        const stranded = bannerFor(bound);
        assert(stranded?.classList.contains('workspace-banner-stranded'),
          'while a binding the session cannot resolve is reported as the loss it is');
        assert(!/quiet-tree|ws_never_registered/.test(stranded?.textContent ?? ''),
          `naming neither a tree it cannot reach nor an id that means nothing to anyone, got ${JSON.stringify(stranded?.textContent)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('the environment block names the tree the turn will run in', async () => {
      // The model plans against this block. Left at the project, every absolute
      // path it wrote would name a tree its own tools were not working in —
      // and, unlike a bad op, nothing downstream would refuse it.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_env', '/tmp/env-tree', { label: 'env' })];
      try {
        const bound = await makeConversation(session, 'says-so-in-its-prompt', { workspaceId: 'ws_env' });
        release(bound);
        const prompt = promptFor(session, bound);
        assert(prompt.includes('Working directory: /tmp/env-tree'),
          `a bound conversation works in its workspace, got ${JSON.stringify(prompt)}`);
        assert(prompt.includes(`Project directory: ${session.projectPath}`),
          `and is told the project too, which it may still read, got ${JSON.stringify(prompt)}`);

        const project = await makeConversation(session, 'says-nothing-extra');
        release(project);
        const plain = promptFor(session, project);
        assert(plain.includes(`Working directory: ${session.projectPath}`),
          `while an unbound conversation reads exactly as it did before workspaces existed, got ${JSON.stringify(plain)}`);
        assert(!plain.includes('Project directory:'),
          `with no second line to say the same thing twice — the block's bytes are a cache key, got ${JSON.stringify(plain)}`);

        // A binding the session cannot resolve has no root to state. The turn is
        // refused server-side either way; naming the project here would be the
        // one answer that reads as working.
        bound.workspaceId = 'ws_never_registered';
        const stale = promptFor(session, bound);
        assert(!stale.includes('Working directory: /tmp/env-tree')
          && !stale.includes(`Working directory: ${session.projectPath}`),
        `an unresolvable binding names no working directory at all, got ${JSON.stringify(stale)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('the git surfaces follow the visible conversation into its tree', async () => {
      // The card counts, the review lists and the diff reads — one on top of
      // another in the pin. They follow the conversation together or the pin
      // shows the name of one tree and the bytes of another, which is why they
      // share one answer to "which tree" rather than each deciding.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, as git sees it', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      const wasVisible = session.visibleConversationId;
      session.workspaces = [...saved, made.workspace];
      /** @type {(() => void)|null} */
      let unfollow = null;
      try {
        const bound = await makeConversation(session, 'git-in-its-tree', { workspaceId: id });
        release(bound);
        const project = await makeConversation(session, 'git-in-the-project');
        release(project);

        unfollow = followSession(session);

        session.switchConversation(bound.id);
        gitStatusCache.reset();
        const inTree = await gitStatusCache.refresh();
        assert(inTree?.root === `${projectPath}/src`,
          `the status is read in the visible conversation's tree, got ${JSON.stringify(inTree?.root)}`);

        session.switchConversation(project.id);
        gitStatusCache.reset();
        const inProject = await gitStatusCache.refresh();
        assert(inProject?.root === projectPath,
          `and follows a switch back to a conversation working in the project, got ${JSON.stringify(inProject?.root)}`);
      } finally {
        if (unfollow) unfollow();
        setGitWorkspace('');
        gitStatusCache.reset();
        if (wasVisible) session.switchConversation(wasVisible);
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('the item diff leaves the banner where it is', async () => {
      // The banner is a managed non-item: it carries no message-id, so an
      // id-keyed diff that did not know about it would delete it on the first
      // render and it would never be seen again.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_kept', '/tmp/kept-tree', { label: 'kept' })];
      try {
        const bound = await makeConversation(session, 'keeps-its-banner', { workspaceId: 'ws_kept' });
        release(bound);

        const { area, list } = columnFor(bound);
        ensureWorkspaceBanner(area, list);
        const stray = document.createElement('div');
        stray.setAttribute('message-id', 'item-1');
        list.insertBefore(stray, list.querySelector('conversation-footer'));

        removeAllElements(list);
        assert(list.querySelector('.conversation-workspace-banner'),
          'clearing the transcript to empty leaves the banner standing');
        assert(!list.querySelector('[message-id="item-1"]'),
          'while the items it stands above are gone, which is what makes that mean anything');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a workspace provider is built from the registry, and a missing one is simply missing', async () => {
      // The registry is asked for providers by id, and the id comes off a
      // workspace row that outlives whatever made it. So the miss is not an
      // error case — it is what a user gets for disabling an extension after
      // making a worktree with it, and it must cost them the provider rather
      // than the workspace.
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
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
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
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
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
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
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

    await run('a conversation from before workspaces is not asked where it works', async () => {
      // What every conversation on disk looks like after the upgrade: history in
      // the document, and no flag in its metadata. It has been working in the
      // project the whole time and its binding still says so, so there is
      // nothing to ask — and asking would bolt the question onto the end of a
      // transcript its user had finished with.
      const conversation = await makeConversation(session, 'from-before-workspaces');
      release(conversation);
      const refused = await conversation.sendMessage('a turn from before all this', null, conversation.rootMessageThread, {
        consumeComposer: false
      });
      assert(refused === null, `expected the send to be accepted, got ${JSON.stringify(refused)}`);
      await waitFor(() => conversation.rootMessageThread.items.some(
        (/** @type {any} */ item) => item?.get?.('type') === 'user'),
      { description: 'the sent message to reach the document' });
      conversation.setMetadata(INITIALISED_KEY, false);

      assert(conversation.awaitingSetup === false,
        'a conversation with history behind it made this choice long ago, flag or no flag');
      assert(conversation.workspaceId === '',
        'and it works in the project, which is where every conversation worked before workspaces');

      const { area, list } = columnFor(conversation);
      ensureConversationChrome(area, list);
      assert(!list.querySelector('conversation-setup-panel'),
        'so nothing is added to the foot of a transcript that is already finished');
      assert(!list.querySelector('.conversation-workspace-banner'),
        'and nothing announces the project either, as it never did');
    });

    await run('the panel is reached by Tab and walked with the arrow keys', async () => {
      // Three things want the focus on a new conversation and the composer wins
      // all three: typing is the dominant action and must never be stolen. So
      // the panel is a single tab stop the user chooses to enter, and moves
      // under the arrow keys from there.
      const conversation = await makeConversation(session, 'walks-the-rows', { initialise: false });
      release(conversation);
      const { area, list } = columnFor(conversation);
      document.body.appendChild(list);
      try {
        ensureConversationChrome(area, list);
        const panel = /** @type {any} */ (list.querySelector('conversation-setup-panel'));
        const stops = Array.from(panel.querySelectorAll('.setup-row'))
          .filter((/** @type {any} */ row) => row.tabIndex === 0);
        assert(stops.length === 1,
          `the rows are one tab stop between them, not one each, got ${stops.length}`);

        /** @type {any} */ (stops[0]).focus();
        /** @type {any} */ (panel.querySelector('.setup-rows')).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

        const selected = panel.querySelector('.setup-row[aria-checked="true"]');
        // The next row as the panel itself has it. Asking the service again
        // asks a list that is rebuilt on every call and holds whatever the
        // providers can find under the shared project root at that instant —
        // so a place that turned up between the draw and this line would move
        // the answer without anything on screen having moved at all.
        const second = /** @type {any} */ (
          Array.from(panel.querySelectorAll('.setup-row'))[1])?.dataset.rowId;
        assert(selected?.dataset.rowId === second,
          `an arrow moves to the next row and takes the selection with it, got ${JSON.stringify(selected?.dataset.rowId)} rather than ${JSON.stringify(second)}`);
        assert(document.activeElement === selected,
          'and the focus follows it onto the row that was rebuilt in its place');
      } finally {
        list.remove();
      }
    });

    await run('the panel builds a workspace, hands it the undo, and takes it back', async () => {
      // The whole flow through the DOM the user actually touches: pick the row,
      // fill the provider's own field, press Create, watch it, then change your
      // mind. Everything underneath is the same code the headless cases drive.
      const name = `panel-create-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'panel-drives-it', { initialise: false });
      release(conversation);

      const { area, list } = columnFor(conversation);
      // Attached, because the panel watches the setup state for as long as it is
      // on screen — which is how a click on one row redraws the rest.
      document.body.appendChild(list);
      const savedTable = session.workspaces;
      try {
        ensureConversationChrome(area, list);
        const panel = /** @type {any} */ (list.querySelector('conversation-setup-panel'));

        /** @returns {any} The row that makes a new workspace. */
        const newRow = () => panel.querySelector(`.setup-row[data-row-id="${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}"]`);
        assert(!panel.querySelector('.setup-row-body'),
          'an unselected provider row shows no form');

        newRow().click();
        const field = /** @type {HTMLInputElement} */ (panel.querySelector('#fixture-dir'));
        assert(field, 'selecting it expands the provider\'s own fields in place');
        assert(/** @type {HTMLButtonElement} */ (panel.querySelector('.setup-create')).disabled,
          'and Create waits until the form says it may be pressed');
        assert(!(await projectOps.stat({ path: name })).exists,
          'while selecting the row has built nothing — only Create does that');

        field.value = dir;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        /** @type {HTMLButtonElement} */ (panel.querySelector('.setup-create')).click();

        await waitFor(() => conversation.initialised === true,
          { description: 'the provision to finish and the conversation to be bound' });
        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'Create built the place the form named');

        // The row the server now holds, put on the client's table by hand: this
        // suite's wsService is a mock, so the `workspaces-changed` broadcast
        // that does it in a real window never arrives here.
        const rows = await listWorkspaces();
        session.workspaces = rows.filter((/** @type {any} */ row) => row.id === conversation.workspaceId);

        ensureConversationChrome(area, list);
        assert(!list.querySelector('conversation-setup-panel'),
          'the question is answered, so the panel gives the slot back');
        const banner = /** @type {any} */ (list.querySelector('.conversation-workspace-banner'));
        assert(banner?.querySelector('.workspace-banner-label')?.textContent === 'made by the fixture',
          `and the banner names the tree it made, got ${JSON.stringify(banner?.textContent)}`);
        const undo = /** @type {any} */ (banner?.querySelector('.workspace-banner-undo'));
        assert(undo, 'carrying the undo, rather than a second line saying the same thing');

        undo.click();
        await waitFor(() => conversation.initialised === false,
          { description: 'the undo to unwind the provision' });
        assert(!(await projectOps.stat({ path: name })).exists,
          'which removes what was built');
        ensureConversationChrome(area, list);
        assert(list.querySelector('conversation-setup-panel'),
          'and puts the question back');
      } finally {
        session.workspaces = savedTable;
        list.remove();
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
      }
    });

    await run('a form being filled in survives what the panel learns behind it', async () => {
      // The panel asks about every row it lists the moment it opens, and those
      // answers arrive while somebody is typing into the form of a row they
      // picked. Redrawing for them would rebuild that form — taking the focus,
      // and the half-typed path, with it. The rows behind it wait.
      const conversation = await makeConversation(session, 'types-while-it-learns', { initialise: false });
      release(conversation);
      const { area, list } = columnFor(conversation);
      document.body.appendChild(list);
      const saved = session.workspaces;
      try {
        ensureConversationChrome(area, list);
        const panel = /** @type {any} */ (list.querySelector('conversation-setup-panel'));
        panel.querySelector(`.setup-row[data-row-id="${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}"]`).click();

        const field = /** @type {HTMLInputElement} */ (panel.querySelector('#fixture-dir'));
        field.focus();
        field.value = `${projectPath}/half-typed`;
        field.dispatchEvent(new Event('input', { bubbles: true }));

        // Everything the panel can learn while that is on screen: a status for a
        // row nobody selected, and a place that has no workspace at all.
        session.workspaces = [...saved, workspaceRow('ws_late', `${projectPath}/src`, { label: 'arrived late' })];
        await probeSetupStatuses(session);
        await probeSetupAdoptions(session);

        assert(panel.querySelector('#fixture-dir') === field,
          'the form is the same form it was, not a rebuilt one');
        assert(field.value === `${projectPath}/half-typed`,
          `with what was typed into it still there, got ${JSON.stringify(field.value)}`);
        assert(document.activeElement === field,
          'and the cursor still in it');
      } finally {
        session.workspaces = saved;
        list.remove();
      }
    });

    await run('a send with the workspace half-chosen is refused, and nothing is lost', async () => {
      const conversation = await makeConversation(session, 'sends-too-early', { initialise: false });
      release(conversation);
      const { area, list } = columnFor(conversation);
      document.body.appendChild(list);
      try {
        ensureConversationChrome(area, list);
        const panel = /** @type {any} */ (list.querySelector('conversation-setup-panel'));
        panel.querySelector(`.setup-row[data-row-id="${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}"]`).click();

        const refused = await conversation.sendMessage('off we go', null, conversation.rootMessageThread, {
          consumeComposer: false
        });
        assert(refused === 'workspace not ready',
          `a send against a workspace nobody has made yet is turned away, got ${JSON.stringify(refused)}`);
        assert(conversation.initialised === false && conversation.workspaceId === '',
          'without quietly binding the project instead, which is the fallback this whole indirection exists to prevent');
        assert(conversation.rootMessageThread.items.every(
          (/** @type {any} */ item) => item?.get?.('type') !== 'user'),
        'and the message is not in the conversation — it is still in the box');
        assert(document.activeElement === panel.querySelector('#fixture-dir'),
          'while the panel points at the field that is missing');

        // Filled in but never created: still refused, and now what is missing
        // is the button rather than the field.
        const field = /** @type {HTMLInputElement} */ (panel.querySelector('#fixture-dir'));
        field.value = `${projectPath}/never-made`;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const stillRefused = await conversation.sendMessage('off we go', null, conversation.rootMessageThread, {
          consumeComposer: false
        });
        assert(stillRefused === 'workspace not ready',
          `a filled-in form is not a workspace, got ${JSON.stringify(stillRefused)}`);
        assert(document.activeElement === panel.querySelector('.setup-create'),
          'and the thing to do next is the one with the focus');

        // Nothing picked at all is not blocked: that conversation binds the
        // project, exactly as every conversation did before workspaces existed.
        selectSetupRow(conversation, PROJECT_ROW_ID);
        const accepted = await conversation.sendMessage('off we go', null, conversation.rootMessageThread, {
          consumeComposer: false
        });
        assert(accepted === null, `a conversation that picked the project sends, got ${JSON.stringify(accepted)}`);
        assert(conversation.initialised === true && conversation.workspaceId === '',
          'binding the project on the way through');
      } finally {
        list.remove();
      }
    });

    await run('a send made while the workspace is building waits in the queue and then goes', async () => {
      const name = `parked-send-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'sends-while-building', { initialise: false });
      release(conversation);
      const mt = conversation.rootMessageThread;
      const { area, list } = columnFor(conversation);
      const savedTable = session.workspaces;
      try {
        selectSetupRow(conversation, `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
        setSetupValues(conversation, { valid: true, values: { dir, stallMs: 1500 } });
        const creating = createSelectedWorkspace(conversation);

        await waitFor(() => getSetupState(conversation).phase === 'provisioning',
          { description: 'the provision to start' });
        const parked = await conversation.sendMessage('what shall we do first', null, mt, {
          consumeComposer: false
        });
        assert(parked === null,
          `the send is accepted rather than refused — the composer is live the whole time, got ${JSON.stringify(parked)}`);
        await waitFor(() => mt.pendingItems.length === 1,
          { description: 'the message to reach the queue' });

        ensurePendingMessages(area, list);
        const zone = list.querySelector('.pending-messages');
        assert(zone?.querySelector('.pending-messages-label')?.textContent === 'Waiting for the workspace',
          `and it waits under the reason it is waiting for, got ${JSON.stringify(zone?.textContent)}`);

        const result = await creating;
        assert(result.ok, `the provision finished, got ${JSON.stringify(result)}`);
        await waitFor(() => mt.items.some((/** @type {any} */ item) => item?.get?.('type') === 'user'),
          { description: 'the parked message to be sent once there was somewhere to run it' });
        assert(mt.pendingItems.length === 0,
          `and it leaves the queue rather than being sent twice, got ${mt.pendingItems.length} still waiting`);

        ensurePendingMessages(area, list);
        assert(!list.querySelector('.pending-messages'),
          'with the zone gone, since nothing is waiting any more');
      } finally {
        session.workspaces = savedTable;
        if (conversation.workspaceId) await unregisterWorkspace(conversation.workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
      }
    });

    await run('a workspace that cannot run a CLI provider is not offered one', async () => {
      // Provider spawn is inherently local: Juggler runs the CLI as a
      // subprocess of its own, in the conversation's directory. A workspace
      // this machine only reaches over a wire therefore cannot host one — the
      // CLI would run here while every file operation of the turn ran there,
      // which fails by quietly making no sense rather than by erroring.
      // What the server actually published, before anything here stubs it: the
      // kinds ride the session load, so a key named wrongly at either end is
      // caught here rather than by a constraint that silently never fires.
      assert(session.workspaceKinds?.local?.hostsLocalProviders === true,
        `the load carries what each kind can do, got ${JSON.stringify(session.workspaceKinds)}`);

      const saved = session.workspaces;
      const savedKinds = session.workspaceKinds;
      session.workspaces = [
        workspaceRow('ws_here', `${projectPath}/src`),
        workspaceRow('ws_elsewhere', '/srv/build', { kind: 'test-elsewhere' })
      ];
      session.workspaceKinds = {
        local: { hostsLocalProviders: true },
        'test-elsewhere': { hostsLocalProviders: false }
      };
      try {
        const here = await makeConversation(session, 'works-on-this-machine', { workspaceId: 'ws_here' });
        release(here);
        const away = await makeConversation(session, 'works-over-a-wire', { workspaceId: 'ws_elsewhere' });
        release(away);

        assert(here.workspaceHostsLocalProviders === true,
          'a workspace on this machine can host a provider we spawn');
        assert(away.workspaceHostsLocalProviders === false,
          'and one of a kind that says it cannot, cannot');

        const providers = [
          { name: 'test-provider', displayName: 'Over the network', available: true, modelsWithContext: [{ id: 'test-model' }] },
          { name: 'claudecode', displayName: 'A CLI', available: true, spawnsLocalProcess: true, modelsWithContext: [{ id: 'sonnet' }] }
        ];
        const selector = /** @type {any} */ (document.createElement('model-selector'));
        selector.providers = providers;

        selector.setConversation(here);
        assert(selector._offerableProviders()[1].available === true,
          'the CLI is offered to a conversation it can actually serve');

        selector.setConversation(away);
        const offered = selector._offerableProviders();
        assert(offered[1].available === false,
          `while the conversation working elsewhere is not offered it, got ${JSON.stringify(offered[1])}`);
        assert(offered[1].authHint === WORKSPACE_ELSEWHERE_HINT,
          `with the reason it is not, got ${JSON.stringify(offered[1].authHint)}`);
        assert(offered[0].available === true,
          'and everything reached over the network is untouched, which is what makes that mean anything');
      } finally {
        session.workspaces = saved;
        session.workspaceKinds = savedKinds;
      }
    });

    await run('the panel asks every listed workspace how it is doing', async () => {
      // Speculative, for rows nobody has selected: a branch and a dirty flag are
      // what make picking one an informed choice rather than a guess.
      const made = await registerWorkspace({
        root: `${projectPath}/src`,
        label: 'src, reporting for duty',
        state: 'ready',
        providerId: FixtureProvider.MANIFEST.id
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        assert(cachedSetupStatus(made.id) === undefined,
          'precondition: nothing has been asked about this workspace yet');
        await probeSetupStatuses(session);
        const status = cachedSetupStatus(made.id);
        assert(status?.label === 'src, reporting for duty',
          `each listed workspace is asked about before it is picked, got ${JSON.stringify(status)}`);

        // And the sweep is abandonable, so closing the panel stops a probe that
        // would otherwise still be running against a host that is down.
        const controller = new AbortController();
        controller.abort();
        await probeSetupStatuses(session, controller.signal);
        assert(true, 'an aborted sweep settles rather than hanging or throwing');
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('a conversation whose workspace was finished with says so once, and offers the way out', async () => {
      // The alternative is what this exists to prevent: every operation of the
      // next turn failing on its own, each with a true and useless message,
      // while nothing anywhere says what happened or what to do about it.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_tomb', '/tmp/tomb-tree', {
          label: 'feat/gone',
          state: 'closed',
          meta: { closedBy: 'the-other-one' }
        }),
        workspaceRow('ws_building', '/tmp/building-tree', {
          label: 'half-made',
          state: 'provisioning'
        })
      ];
      try {
        const stranded = await makeConversation(session, 'left-behind', { workspaceId: 'ws_tomb' });
        release(stranded);

        const banner = bannerFor(stranded);
        assert(banner, 'a conversation whose workspace was finished with is told so');
        assert(/the-other-one/.test(banner?.textContent ?? ''),
          `and by whom, which is the whole of the coordination story, got ${JSON.stringify(banner?.textContent)}`);
        assert(/feat\/gone/.test(banner?.textContent ?? ''),
          `naming the workspace it has lost, got ${JSON.stringify(banner?.textContent)}`);

        const rebind = /** @type {any} */ (banner?.querySelector('.workspace-banner-rebind'));
        assert(rebind, 'with a way out of it rather than only the news');

        // And the send is refused here rather than in the engine. The composer
        // knows nothing about workspaces, so this message used to clear the box,
        // start a turn, and come back dead with "workspace … was closed" — the
        // same refusal, arriving after the damage and in the engine's words.
        const refused = await stranded.sendMessage('does this go anywhere');
        assert(refused === 'workspace cannot be worked in',
          `a send from a stranded conversation is refused, got ${JSON.stringify(refused)}`);
        assert(!stranded.isProcessing,
          'with no turn started to die in the server');

        // Two ways out, because there are two answers: back to the project,
        // which is one press and usually right, or anywhere else, which is the
        // same dialog the chip opens.
        const elsewhere = /** @type {any} */ (banner?.querySelector('.workspace-banner-elsewhere'));
        assert(elsewhere, 'and the other answer, for a conversation whose work belongs in another tree');
        elsewhere.click();
        const offered = document.querySelector('.workspace-move-overlay');
        assert(offered, 'which opens the picker rather than deciding for them');
        /** @type {any} */ (offered.querySelector('.workspace-move-cancel')).click();
        assert(!document.querySelector('.workspace-move-overlay'),
          'and closing it changes nothing');
        assert(stranded.workspaceId === 'ws_tomb',
          `leaving the conversation stranded where it was, got ${JSON.stringify(stranded.workspaceId)}`);

        rebind.click();
        await waitFor(() => stranded.workspaceId === '',
          { description: 'the rebind to move the conversation to the project' });
        assert(bannerFor(stranded) === null,
          'which clears the banner, there being nothing left to report');
        // `src/greeter.js` is in the project and nowhere else, so this is the
        // project answering rather than a tree that no longer exists.
        const read = await readIn(session, stranded, 'src/greeter.js');
        assert(read.exists !== false,
          `and the next operation runs in the project, got ${JSON.stringify(read)}`);

        // Being built is not being lost. A conversation can be bound to a
        // workspace that is still provisioning — an inherited binding, a second
        // window — and the answer to that is to wait, not to announce a
        // disaster.
        const early = await makeConversation(session, 'too-early', { workspaceId: 'ws_building' });
        release(early);
        assert(bannerFor(early) === null,
          'a workspace that is merely still being built says nothing at all');
        // Nor is it refused: that send parks and goes the moment there is
        // somewhere to run it, which is the point of building in the background.
        assert(early._unusableWorkspace() === '',
          `and a send into one is not refused either, got ${JSON.stringify(early._unusableWorkspace())}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a binding the table has no row for is said out loud, not left silent', async () => {
      // The degraded state nothing was telling anybody about. `session.json` is
      // deliberately disposable here — conversation folders are the truth, and a
      // load rebuilds what it can — but the workspace table lives in it, and a
      // conversation's binding lives in its own document, which survives. So a
      // lost table leaves conversations bound to ids nothing can resolve.
      //
      // Every other unusable binding already says something. This one said
      // nothing at all: no row meant no banner, and the chip stands down for any
      // binding it cannot honour, so the conversation looked exactly like one
      // working in the project right up until its next turn failed.
      const saved = session.workspaces;
      session.workspaces = [];
      try {
        const stranded = await makeConversation(session, 'bound-to-nothing', { workspaceId: 'ws_forgotten' });
        release(stranded);
        assert(stranded.workspaceRoot === null,
          `the binding resolves to nowhere, which is the state under test, got ${JSON.stringify(stranded.workspaceRoot)}`);

        const banner = bannerFor(stranded);
        assert(banner, 'a conversation bound to a workspace the table has lost is told so');
        assert(!/undefined|null/.test(banner?.textContent ?? ''),
          `in words, there being no row to name, got ${JSON.stringify(banner?.textContent)}`);
        assert(banner?.querySelector('.workspace-banner-rebind'),
          'with the way back to the project it has for every other kind of loss');
        assert(banner?.querySelector('.workspace-banner-elsewhere'),
          'and the way to anywhere else');

        // A workspace being built has no root either, and is the one unusable
        // binding that must stay silent: that conversation is waiting, not
        // stranded, and the parked send already covers it. A half-built tree has
        // no root on disk yet, so it arrives here unavailable as well.
        session.workspaces = [workspaceRow('ws_half', '/tmp/half-made', {
          label: 'half-made', state: 'provisioning', available: false
        })];
        const waiting = await makeConversation(session, 'still-waiting', { workspaceId: 'ws_half' });
        release(waiting);
        assert(bannerFor(waiting) === null,
          'while a workspace still being built says nothing, however unfinished it looks');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a workspace the table has lost is put back under the id that lost it', async () => {
      // The last mile of the recovery contract. A binding is an opaque id and
      // nothing on disk says which tree it meant, so no sweep can work it out —
      // but the trees are still there, the providers can enumerate them, and the
      // user knows which was which. Answering registers that place UNDER THE
      // STRANDED ID, which is the whole difference between this and adopting:
      // every conversation bound to that id resolves again, including the ones
      // nobody has opened, and not one of them is moved to do it.
      const tag = Math.random().toString(36).slice(2, 8);
      const name = `lost-tree-${tag}`;
      const dir = `${projectPath}/${name}`;
      const strandedId = `ws_lost${tag}`;
      const projectOps = createBoundOps(() => ({}));
      const saved = session.workspaces;
      // Nothing in this flow asks anything in a modal, and the stub is what
      // asserts that rather than what survives it: an unanswered real confirm
      // does not fail, it hangs the suite to its cap.
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => {
        throw new Error('putting a workspace back asked something in a modal');
      };
      /** @type {any} What the refusal half adopts the ordinary way, to be forgotten again. */
      let spare = null;
      try {
        await projectOps.shell({ command: `mkdir -p ${dir}` });
        // The table, lost — which is what a missing session.json leaves, while
        // the bindings in the conversation documents survive it.
        session.workspaces = [];

        const one = await makeConversation(session, 'stranded-one', { workspaceId: strandedId });
        release(one);
        const two = await makeConversation(session, 'stranded-two', { workspaceId: strandedId });
        release(two);
        assert(one.workspaceRoot === null && two.workspaceRoot === null,
          'both conversations are bound to a workspace nothing can resolve');

        const banner = bannerFor(one);
        const putBack = /** @type {any} */ (banner?.querySelector('.workspace-banner-reconnect'));
        assert(putBack,
          'the loss whose record is what went missing is offered a way to undo it, not only a way out of it');

        FixtureProvider.report = {
          orphanedWorkspaces: [],
          orphanedArtifacts: [{
            id: `fixture\u0000${name}`,
            label: name,
            detail: 'a tree with no workspace',
            workspace: { root: dir, label: name, meta: { dir } }
          }],
          confirmed: []
        };

        putBack.click();
        await waitFor(() => !!document.querySelector('.workspace-reconnect-overlay'),
          { description: 'the dialog asking where it was' });
        const dialog = /** @type {HTMLElement} */ (document.querySelector('.workspace-reconnect-overlay'));
        // This tree's offer, by the id the row carries, rather than the first
        // offer in the dialog: every provider lists what it can find under the
        // one shared project root, so the first row is whichever place happened
        // to be lying about — and answering the question with somebody else's
        // tree puts the workspace back somewhere this case never lost.
        const offerOfTheTree = () => /** @type {any} */ (
          Array.from(dialog.querySelectorAll('.setup-row-adopt')).find(
            (/** @type {any} */ row) => String(row.dataset.rowId ?? '').endsWith(`\u0000${name}`)));
        await waitFor(() => !!offerOfTheTree(),
          { description: 'the place this conversation lost, among those a provider can find' });
        assert(/2 conversations/.test(dialog.textContent ?? ''),
          `it says how many conversations come back with it, which is the reason to answer, got ${JSON.stringify(dialog.textContent)}`);

        offerOfTheTree().click();
        await waitFor(() => one.workspaceRoot === dir,
          { description: 'the workspace to come back under the id that lost it' });
        assert(two.workspaceRoot === dir,
          `and every other conversation bound to it comes back unasked, got ${JSON.stringify(two.workspaceRoot)}`);
        assert(one.workspaceId === strandedId && two.workspaceId === strandedId,
          `with neither of them moved — the id is what was put back, not the conversation`);
        assert(!document.querySelector('.workspace-reconnect-overlay'),
          'and the dialog closes, having done the one thing it was for');
        const restored = bannerFor(one);
        assert(restored && !restored.classList.contains('workspace-banner-stranded'),
          `and the transcript goes back to saying where it works, got ${JSON.stringify(restored?.className)}`);
        assert(restored?.querySelector('.workspace-banner-root')?.textContent === dir,
          `naming the tree that was put back, got ${JSON.stringify(restored?.textContent)}`);

        // An id already on the table is not free. Registering over it would
        // give the session two rows answering to one binding, so the refusal is
        // the server's and it is left to reach the caller.
        FixtureProvider.report = {
          orphanedWorkspaces: [],
          orphanedArtifacts: [{
            id: `fixture\u0000${name}-again`,
            label: `${name}-again`,
            detail: 'a second tree with no workspace',
            workspace: { root: `${dir}-again`, label: `${name}-again`, meta: { dir: `${dir}-again` } }
          }],
          confirmed: []
        };
        // A second tree, because a place that is already somebody's workspace is
        // not offered at all — which is the first half of the same rule.
        await projectOps.shell({ command: `mkdir -p ${dir}-again` });
        await probeSetupAdoptions(session);
        const second = setupRows(session).find((/** @type {any} */ row) =>
          row.kind === 'adopt' && row.label === `${name}-again`);
        assert(second, 'the second tree is on offer, which is what the refusal is asked about');

        let refused = '';
        try {
          await adoptSetupRow(session, String(second?.id), { id: strandedId });
        } catch (error) {
          refused = error instanceof Error ? error.message : String(error);
        }
        assert(/already registered/i.test(refused),
          `putting something back under an id the table already holds is refused, got ${JSON.stringify(refused)}`);

        // Then taken up the ordinary way, which proves the refusal cost the
        // offer nothing — and leaves the suite's shared list of offers as this
        // case found it, since a refused one is not taken off it.
        spare = await adoptSetupRow(session, String(second?.id));
        assert(spare?.id && spare.id !== strandedId,
          `while the same offer still adopts under an id of its own, got ${JSON.stringify(spare)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        FixtureProvider.report = null;
        document.querySelector('.workspace-reconnect-overlay')?.remove();
        session.workspaces = saved;
        await unregisterWorkspace(strandedId).catch(() => {});
        if (spare?.id) await unregisterWorkspace(spare.id).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${dir} ${dir}-again` }).catch(() => {});
      }
    });

    await run('finishing names the others in the workspace, and is refused while one is mid-turn', async () => {
      // The entire coordination story: nobody owns a workspace, so the only
      // thing standing between one conversation and the tree another is working
      // in is this warning — and the one case that actually loses work, a turn
      // in flight, is refused outright rather than warned about.
      const name = `finish-peers-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const owner = await makeConversation(session, 'finishes-with-it', { initialise: false });
      release(owner);
      const saved = session.workspaces;
      /** @type {any} */
      let peer = null;
      let workspaceId = '';
      try {
        selectSetupRow(owner, `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
        setSetupValues(owner, { valid: true, values: { dir } });
        const made = await createSelectedWorkspace(owner);
        assert(made.ok, `precondition: there is a workspace to finish with, got ${JSON.stringify(made)}`);

        const workspace = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === owner.workspaceId);
        // Held separately: finishing moves the owner back to the project, so its
        // binding is no longer the way to find the row this case has to clean up.
        workspaceId = workspace.id;
        session.workspaces = [...saved, workspace];
        peer = await makeConversation(session, 'also-working-here', { workspaceId: workspace.id });
        release(peer);

        const quiet = workspaceFinishWarning(session, workspace, { conversation: owner });
        assert(quiet.peers.includes('also-working-here'),
          `the warning names every other conversation bound to it, got ${JSON.stringify(quiet.peers)}`);
        assert(!quiet.peers.includes('finishes-with-it'),
          `and not the one doing the finishing, got ${JSON.stringify(quiet.peers)}`);
        assert(quiet.refusal === '',
          `with nothing to refuse while nobody is working, got ${JSON.stringify(quiet.refusal)}`);

        // Mid-turn: removing a tree under a running agent is the one case that
        // loses work rather than merely surprising someone.
        Object.defineProperty(peer, 'isProcessing', { get: () => true, configurable: true });
        const busy = workspaceFinishWarning(session, workspace, { conversation: owner });
        assert(/also-working-here/.test(busy.refusal),
          `a peer mid-turn is a refusal, and it says whose, got ${JSON.stringify(busy.refusal)}`);

        const refused = await finishWorkspace({ session, workspace, conversation: owner, actionId: 'done' });
        assert(refused.done === false,
          `and the refusal is the service's, not the dialog's, got ${JSON.stringify(refused)}`);
        assert((await projectOps.stat({ path: name })).exists,
          'with the tree still there, which is the point of refusing');

        Object.defineProperty(peer, 'isProcessing', { get: () => false, configurable: true });
        const finished = await finishWorkspace({ session, workspace, conversation: owner, actionId: 'done' });
        assert(finished.done === true,
          `once the turn is over it goes through, got ${JSON.stringify(finished)}`);
        assert(!(await projectOps.stat({ path: name })).exists,
          'the provider removed what it made');

        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === workspace.id);
        assert(row?.state === 'closed',
          `and the row is tombstoned rather than deleted, so the id still resolves to a reason, got ${JSON.stringify(row?.state)}`);
        assert(row?.meta?.closedBy === 'finishes-with-it',
          `naming who closed it, for the banner the peer will show, got ${JSON.stringify(row?.meta)}`);

        // The conversation that finished with it is put back in the project. It
        // used to be left bound to the tombstone with a composer that still
        // looked ready: nothing refused the next message, and the turn died in
        // the server with "workspace … was closed".
        assert((owner.workspaceId || '') === '',
          `the conversation that finished with it is back in the project, got ${JSON.stringify(owner.workspaceId)}`);
        assert(peer.workspaceId === workspace.id,
          `and the peers are not moved by somebody else's decision, got ${JSON.stringify(peer.workspaceId)}`);
      } finally {
        session.workspaces = saved;
        if (workspaceId) await unregisterWorkspace(workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
      }
    });

    await run('a dirty tree is said to be dirty before anything destroys it', async () => {
      // Discarding uncommitted work is the one mistake this feature can make
      // that nothing can undo, so the confirmation says it in the sentence the
      // user is about to agree to.
      const workspace = workspaceRow('ws_dirty', '/tmp/dirty-tree', {
        label: 'feat/unsaved',
        providerId: FixtureProvider.MANIFEST.id
      });
      const warning = workspaceFinishWarning(session, workspace, {
        action: { id: 'done', label: 'Done with it', danger: true },
        status: { dirty: true }
      });
      assert(/uncommitted/i.test(warning.warning),
        `a destructive ending against a dirty tree says so, got ${JSON.stringify(warning.warning)}`);

      const clean = workspaceFinishWarning(session, workspace, {
        action: { id: 'done', label: 'Done with it', danger: true },
        status: { dirty: false }
      });
      assert(!/uncommitted/i.test(clean.warning),
        `while a clean one does not invent a reason to hesitate, got ${JSON.stringify(clean.warning)}`);
    });

    await run('a move says what the tree it leaves holds, and whether it can be listed', async () => {
      // Two questions, and they are asked of two different places. Whether there
      // is work here at all comes from the provider, because what counts as work
      // held is the provider's to decide — a sandbox's unapplied edits are no
      // business of git's at all. Whether that work can be listed file by file,
      // and so carried, is git's, because git is the only thing here that can
      // enumerate it. A tree may hold work that cannot be carried, and the move
      // then says exactly what it said before carrying existed.
      const made = await registerWorkspace({
        root: `${projectPath}/src`,
        label: 'holding work',
        state: 'ready',
        providerId: FixtureProvider.MANIFEST.id
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        FixtureProvider.reported = { dirty: true, detail: '3 changes' };
        const holding = await workspaceHeldWork(session, made.id);
        assert(holding.dirty === true,
          `a tree its provider reports as holding work is reported as holding it, got ${JSON.stringify(holding)}`);
        assert(/uncommitted/i.test(holding.warning) && /holding work/.test(holding.warning),
          `and the sentence names the work and the tree it is in, got ${JSON.stringify(holding.warning)}`);
        assert(!/carr|bring|take it with/i.test(holding.warning),
          `without promising the move will bring it, which is not the sentence's to promise, got ${JSON.stringify(holding.warning)}`);

        FixtureProvider.reported = { dirty: false };
        const clean = await workspaceHeldWork(session, made.id);
        assert(clean.dirty === false && clean.warning === '',
          `while leaving a clean tree is nothing to stop anyone over, got ${JSON.stringify(clean)}`);

        // The two trees no provider answers for: the project, and a row whose
        // extension is gone. Both are places a conversation moves out of, so
        // both get an answer rather than an exception.
        FixtureProvider.reported = null;
        const orphaned = await registerWorkspace({
          root: `${projectPath}/src`,
          label: 'made by something gone',
          state: 'ready',
          providerId: '@someone/uninstalled'
        });
        session.workspaces = [...saved, made, orphaned];
        try {
          const unanswered = await workspaceHeldWork(session, orphaned.id);
          assert(typeof unanswered.dirty === 'boolean',
            `a workspace whose provider is gone is asked git instead, got ${JSON.stringify(unanswered)}`);
          const project = await workspaceHeldWork(session, '');
          assert(typeof project.dirty === 'boolean',
            `and so is the project, which has no provider by design, got ${JSON.stringify(project)}`);
        } finally {
          await unregisterWorkspace(orphaned.id).catch(() => {});
        }

        // Listability is a fact about the tree, not about the provider: a real
        // repository with a file in it can be enumerated, and a directory that
        // is not one cannot. Repositories are looked for DOWNWARDS from the
        // root, which is what keeps a tree that is merely buried inside one from
        // being handed its status.
        const stamp = Math.random().toString(36).slice(2, 8);
        const plain = `held-plain-${stamp}`;
        const repo = `held-repo-${stamp}`;
        const ops = createBoundOps(() => ({ workspaceId: '' }));
        await writeFileOp({ path: `${plain}/notes.md`, content: 'no repository here' });
        await writeFileOp({ path: `${repo}/notes.md`, content: 'work nobody has committed' });
        await ops.shell({ command: `git -C ${repo} init -q` });
        const noRepo = await registerWorkspace({
          root: `${projectPath}/${plain}`, label: 'not a repository', state: 'ready'
        });
        const aRepo = await registerWorkspace({
          root: `${projectPath}/${repo}`, label: 'a repository', state: 'ready'
        });
        session.workspaces = [...saved, made, noRepo, aRepo];
        try {
          const unlistable = await workspaceHeldWork(session, noRepo.id);
          assert(unlistable.listable === false && unlistable.files === 0,
            `a tree with no repository under it cannot have its work listed, got ${JSON.stringify(unlistable)}`);
          const listable = await workspaceHeldWork(session, aRepo.id);
          assert(listable.listable === true && listable.dirty === true && listable.files >= 1,
            `while one that is a repository holding work can, and says how much, got ${JSON.stringify(listable)}`);
        } finally {
          await unregisterWorkspace(noRepo.id).catch(() => {});
          await unregisterWorkspace(aRepo.id).catch(() => {});
          await ops.copyTree({ to: '.', delete: [plain, repo] });
        }
      } finally {
        FixtureProvider.reported = null;
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('the work a tree holds is listed per repository, and an incomplete answer lists none', async () => {
      // The manifest is stubbed rather than built out of a repository, because
      // what is being tested is the reading of it: which of git's answers become
      // a file to carry, which become a file to remove, and what happens when
      // the manifest says it is not the whole story. Building trees proves the
      // copying, next door; this proves the arithmetic.
      const real = api.getGitReview;
      /** @type {any} */
      let manifest = null;
      /** @type {any} */
      (api).getGitReview = async () => manifest;
      try {
        manifest = {
          complete: true,
          repos: [
            {
              path: '',
              complete: true,
              files: [
                { path: 'src/new.js', index: '.', worktree: '?' },
                { path: 'gone.js', index: '.', worktree: 'D' },
                { path: 'renamed.js', oldPath: 'before.js', index: 'R', worktree: '.' },
                { path: '.juggler/session.json', index: '.', worktree: 'M' }
              ]
            },
            {
              path: 'vendor/lib',
              complete: true,
              files: [{ path: 'patch.c', index: '.', worktree: 'M' }]
            }
          ]
        };
        const listed = await workspaceWorkList(session, 'ws_anything');
        assert(listed.complete === true, `a complete manifest lists, got ${JSON.stringify(listed)}`);
        assert(listed.paths.includes('src/new.js') && listed.paths.includes('vendor/lib/patch.c'),
          `every repository's files are named from the root, not from the repository, got ${JSON.stringify(listed.paths)}`);
        assert(listed.removed.includes('gone.js'),
          `a file deleted here is deleted there, got ${JSON.stringify(listed.removed)}`);
        assert(listed.paths.includes('renamed.js') && listed.removed.includes('before.js'),
          `and a rename is the new name arriving and the old one going, got ${JSON.stringify(listed)}`);
        assert(!listed.paths.some((/** @type {string} */ path) => path.startsWith('.juggler')),
          `what is ours is not the user's work and is not carried, got ${JSON.stringify(listed.paths)}`);

        // Short is a wrong answer here, not a small one: a carry that left the
        // rest behind would still report that it had brought the work.
        manifest = { complete: false, repos: [{ path: '', complete: true, files: [{ path: 'src/new.js', index: '.', worktree: 'M' }] }] };
        const partial = await workspaceWorkList(session, 'ws_anything');
        assert(partial.complete === false && partial.paths.length === 0,
          `a manifest that cannot account for the tree carries nothing, got ${JSON.stringify(partial)}`);

        manifest = { complete: true, repos: [{ path: '', complete: false, error: 'not readable', files: [] }] };
        const broken = await workspaceWorkList(session, 'ws_anything');
        assert(broken.complete === false,
          `nor can one whose repository could not be read, got ${JSON.stringify(broken)}`);
      } finally {
        /** @type {any} */ (api).getGitReview = real;
      }
    });

    await run('a provider that can account for its own work is asked instead of git', async () => {
      // The tree here is a plain directory with no repository under it, which is
      // the discriminator: git can enumerate nothing in it, so an answer that
      // lists files at all can only have come from the provider. That is the
      // whole of what this hook is for — a sandbox's unapplied edits are not
      // git's to find, and before it the move out of one could only say that the
      // work stayed behind.
      const stamp = Math.random().toString(36).slice(2, 8);
      const plain = `provider-lists-${stamp}`;
      const ops = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${plain}/notes.md`, content: 'work no repository can see' });

      const made = await registerWorkspace({
        root: `${projectPath}/${plain}`,
        label: 'accounted for by its provider',
        state: 'ready',
        providerId: FixtureProvider.MANIFEST.id
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];

      // Git is not merely expected to answer unhelpfully here; it is expected
      // not to be asked at all, which is the difference between a provider that
      // is consulted and one that is a fallback nobody reaches.
      const real = api.getGitReview;
      let askedGit = false;
      /** @type {any} */
      let manifest = { complete: false, repos: [] };
      /** @type {any} */
      (api).getGitReview = async () => { askedGit = true; return manifest; };

      try {
        FixtureProvider.reported = { dirty: true };
        FixtureProvider.holds = {
          complete: true,
          paths: ['notes.md', 'src/new.js', '.juggler/ours.json'],
          removed: ['gone.md']
        };

        const held = await workspaceHeldWork(session, made.id);
        assert(held.listable === true,
          `a tree its provider can list is listable, whatever git can see of it, got ${JSON.stringify(held)}`);
        assert(held.files === 3,
          `and the count is what the provider listed, less what is ours, got ${JSON.stringify(held)}`);

        const listed = await workspaceWorkList(session, made.id);
        assert(listed.complete === true && listed.paths.includes('notes.md')
          && listed.paths.includes('src/new.js') && listed.removed.includes('gone.md'),
        `the list carried is the provider's own, got ${JSON.stringify(listed)}`);
        assert(!listed.paths.some((/** @type {string} */ path) => path.startsWith('.juggler')),
          `with what is ours dropped from it, wherever the list came from, got ${JSON.stringify(listed.paths)}`);
        assert(askedGit === false,
          'and git was never asked about a tree its provider had already accounted for');

        // The distinction the whole hook turns on: a provider that holds work it
        // cannot list must not be read as one holding nothing. Inventing a
        // warning is the worse error everywhere else in here; inventing a clean
        // tree destroys work.
        FixtureProvider.holds = { complete: false, paths: [], removed: [] };
        const unlistable = await workspaceHeldWork(session, made.id);
        assert(unlistable.dirty === true && unlistable.listable === false,
          `work that cannot be listed is still work, got ${JSON.stringify(unlistable)}`);
        const nothing = await workspaceWorkList(session, made.id);
        assert(nothing.complete === false && nothing.paths.length === 0,
          `and nothing is carried on the strength of it, got ${JSON.stringify(nothing)}`);

        // No opinion is the default, and it is not an empty list: the host goes
        // back to git, which is what answered for every tree before any provider
        // had a view.
        FixtureProvider.holds = null;
        manifest = {
          complete: true,
          repos: [{ path: '', complete: true, files: [{ path: 'notes.md', index: '.', worktree: 'M' }] }]
        };
        const fromGit = await workspaceWorkList(session, made.id);
        assert(askedGit === true && fromGit.complete === true && fromGit.paths.includes('notes.md'),
          `a provider with no opinion leaves git the arbiter, got ${JSON.stringify(fromGit)}`);
      } finally {
        FixtureProvider.holds = null;
        FixtureProvider.reported = null;
        /** @type {any} */ (api).getGitReview = real;
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
        await ops.copyTree({ to: '.', delete: [plain] }).catch(() => {});
      }
    });

    await run('a move brings the work across, all of it or none of it', async () => {
      // Two real repositories, because the rule being tested is what happens
      // when both of them have been worked in: the copy is refused whole and by
      // name where they genuinely disagree, and goes through where they agree —
      // two people who made the same edit are not arguing about it.
      //
      // Neither tree can see the other: an operations scope is rooted at its own
      // workspace and widened only by the project, so the work goes out through
      // the project and back in. That the staging it leaves is gone afterwards
      // is asserted below, on every path.
      const stamp = Math.random().toString(36).slice(2, 8);
      const fromDir = `carry-from-${stamp}`;
      const toDir = `carry-to-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      const committed = 'the commit both trees start from\n';
      const sameEdit = 'the edit they both made\n';

      for (const dir of [fromDir, toDir]) {
        await writeFileOp({ path: `${dir}/shared.txt`, content: committed });
        await writeFileOp({ path: `${dir}/agreed.txt`, content: committed });
        await writeFileOp({ path: `${dir}/doomed.txt`, content: committed });
        const git = `git -C ${dir} -c user.name=Juggler -c user.email=tests@juggler.invalid -c commit.gpgsign=false`;
        await project.shell({ command: `git -C ${dir} init -q` });
        await project.shell({ command: `${git} add -A` });
        await project.shell({ command: `${git} commit -q -m baseline` });
      }

      // What the conversation has done since, in the tree it is leaving: a file
      // made, a file edited, a file deleted — and one edit the other tree has
      // already made for itself.
      await writeFileOp({ path: `${fromDir}/new.txt`, content: 'made in the tree it is leaving\n' });
      await writeFileOp({ path: `${fromDir}/shared.txt`, content: 'the source went its own way\n' });
      await writeFileOp({ path: `${fromDir}/agreed.txt`, content: sameEdit });
      await writeFileOp({ path: `${toDir}/agreed.txt`, content: sameEdit });
      await project.copyTree({ to: '.', delete: [`${fromDir}/doomed.txt`] });

      const madeFrom = await registerWorkspace({
        root: `${projectPath}/${fromDir}`, label: 'the tree with the work in it', state: 'ready'
      });
      const madeTo = await registerWorkspace({
        root: `${projectPath}/${toDir}`, label: 'the tree it is moving to', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom, madeTo];
      const destination = createBoundOps(() => ({ workspaceId: madeTo.id }));
      // The staging directories are named by a stamp of their own, so what this
      // case's carries leave behind is what appeared under here while it ran,
      // not what is under here — another case mid-carry has a directory there
      // and is entitled to it.
      const staging = async () => /** @type {any[]} */ (
        await project.readOnlyFileSystem().readdir('.juggler/carry').catch(() => []));
      const stagingBefore = await staging();
      try {
        const listed = await workspaceWorkList(session, madeFrom.id);
        const everything = listed.paths.includes('new.txt') && listed.paths.includes('shared.txt')
          && listed.removed.includes('doomed.txt');
        assert(listed.complete === true && everything,
          `the tree's own work is what git says it is, got ${JSON.stringify(listed)}`);

        const landed = await carryWorkspaceWork(session, {
          fromId: madeFrom.id, toId: madeTo.id, paths: listed.paths, removed: listed.removed
        });
        assert(landed.done === true,
          `a file both trees changed the same way is not a disagreement and stops nothing, got ${JSON.stringify(landed)}`);
        const arrived = await destination.readFile({ path: 'new.txt' });
        assert(String(arrived?.content ?? '').includes('made in the tree it is leaving'),
          `a file made in the tree being left arrives in the one being moved to, got ${JSON.stringify(arrived?.content)}`);
        assert((await destination.stat({ path: 'doomed.txt' })).exists === false,
          'and a file deleted there is deleted here: what arrives is the tree as it stood');
        assert((await project.stat({ path: `${fromDir}/new.txt` })).exists === true,
          'while the work itself stays where it was made, because carrying it away is the one thing nothing can undo');

        // Now they really do disagree. The refusal is the whole of it: it names
        // what it will not overwrite, and the file that had nothing to do with
        // the argument does not arrive either.
        await writeFileOp({ path: `${toDir}/shared.txt`, content: 'the destination went its own way\n' });
        await writeFileOp({ path: `${fromDir}/second.txt`, content: 'innocent bystander\n' });
        const refused = await carryWorkspaceWork(session, {
          fromId: madeFrom.id, toId: madeTo.id, paths: ['shared.txt', 'second.txt']
        });
        assert(refused.done === false && (refused.conflicts ?? []).includes('shared.txt'),
          `a file changed in both trees refuses the carry, got ${JSON.stringify(refused)}`);
        assert(/shared\.txt/.test(String(refused.message ?? '')),
          `and the sentence names it, got ${JSON.stringify(refused.message)}`);
        assert((await destination.stat({ path: 'second.txt' })).exists === false,
          'with nothing copied at all: half a carry is what the refusal exists to prevent');

        const forced = await carryWorkspaceWork(session, {
          fromId: madeFrom.id, toId: madeTo.id, paths: ['shared.txt', 'second.txt'], overwrite: true
        });
        assert(forced.done === true,
          `while someone who read that sentence and meant it can have it anyway, got ${JSON.stringify(forced)}`);
        const overwritten = await destination.readFile({ path: 'shared.txt' });
        assert(String(overwritten?.content ?? '').includes('the source went its own way'),
          `and then the tree it came from is what is there, got ${JSON.stringify(overwritten?.content)}`);

        const left = (await staging()).filter(
          (/** @type {any} */ entry) => !stagingBefore.includes(entry));
        assert(left.length === 0,
          `every path through a carry takes its staging with it, got ${JSON.stringify(left)}`);
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(madeFrom.id).catch(() => {});
        await unregisterWorkspace(madeTo.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [fromDir, toDir] });
      }
    });

    await run('a form that expands says what the place it makes is good and bad for', async () => {
      // A provider writes down what it suits, what it does not, and what is
      // surprising about it — and the answer to "which of these two do I want"
      // was reaching nobody: nothing rendered it. The moment to read it is the
      // moment the form opens, which is the moment the question is being asked.
      const conversation = await makeConversation(session, 'reads-the-advice', { initialise: false });
      release(conversation);
      const { area, list } = columnFor(conversation);
      document.body.appendChild(list);
      try {
        ensureConversationChrome(area, list);
        const panel = /** @type {any} */ (list.querySelector('conversation-setup-panel'));
        const recommendations = () => panel.querySelector('.setup-recommend');
        assert(!recommendations(),
          'an unexpanded panel says nothing: this belongs to the form, not to the list');

        panel.querySelector(`.setup-row[data-row-id="${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}"]`).click();
        const said = recommendations()?.textContent ?? '';
        const { bestFor, avoidFor, notes } = FixtureProvider.MANIFEST.recommendations;
        assert(said.includes(bestFor),
          `the expanded form says what it is for, got ${JSON.stringify(said)}`);
        assert(said.includes(avoidFor),
          `and what it is not for, got ${JSON.stringify(said)}`);
        assert(said.includes(notes[0]),
          `and what is worth knowing before pressing Create, got ${JSON.stringify(said)}`);
      } finally {
        list.remove();
      }
    });

    await run('what a sub-thread read moves with the conversation too', async () => {
      // A conversation is bound as a whole, and most of what one reads is read
      // inside a sub-thread: a delegated task opens the files and its items are
      // the ones holding that tree's bytes. Refreshing only the root thread
      // leaves those snapshots behind, still showing the model a file from a
      // tree this conversation no longer works in — and saying nothing.
      const stamp = Math.random().toString(36).slice(2, 8);
      const from = `sub-from-${stamp}`;
      const to = `sub-to-${stamp}`;
      const fromMarker = `# the tree it started in ${stamp}`;
      const toMarker = `# the tree it moved to ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${from}/NOTES.md`, content: fromMarker });
      await writeFileOp({ path: `${to}/NOTES.md`, content: toMarker });
      const madeFrom = await registerWorkspace({
        root: `${projectPath}/${from}`, label: 'where it started', state: 'ready'
      });
      const madeTo = await registerWorkspace({
        root: `${projectPath}/${to}`, label: 'where it moved to', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom, madeTo];
      try {
        const moved = await makeConversation(session, `sub-thread-move-${stamp}`,
          { workspaceId: madeFrom.id });
        release(moved);

        const { threadId } = moved.rootMessageThread.createSubThread({ goal: 'read the notes' });
        const subThread = moved.getAllMessageThreads()
          .find((/** @type {any} */ thread) => thread.threadItemId === threadId);
        assert(subThread, 'the sub-thread is there to put an item in');
        const itemId = `ctx_sub_notes_${stamp}`;
        subThread.addContextItem(contextItemRegistry.createItem({
          id: itemId,
          type: 'file-content',
          data: { path: 'NOTES.md', isDirectory: false, seeded: true }
        }, session, moved, subThread));

        const inSub = () => moved.getAllMessageThreads()
          .flatMap((/** @type {any} */ thread) => thread.contextItems)
          .find((/** @type {any} */ item) => item.id === itemId);
        const before = await inSub().createContextText({ forRequest: true });
        assert(before.includes(fromMarker),
          `the sub-thread's item reads the tree the conversation works in, got ${JSON.stringify(before)}`);
        await waitFor(() => typeof inSub()?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const result = await rebindConversation(moved, madeTo.id);
        assert(result.done, `the move is allowed, got ${JSON.stringify(result.message)}`);

        await waitFor(() => (inSub()?.data.content || '').includes(toMarker),
          { description: 'the sub-thread item to take its snapshot again' });
        const after = await inSub().createContextText({});
        assert(after.includes(toMarker) && !after.includes(fromMarker),
          `and after the move it reads the new tree, got ${JSON.stringify(after)}`);
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(madeFrom.id).catch(() => {});
        await unregisterWorkspace(madeTo.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [from, to] }).catch(() => {});
      }
    });

    await run('a provision that cannot take itself back says what it left behind', async () => {
      // The compensation stack is the reason a failed provision leaves nothing
      // on disk. When a compensation fails too, something IS left on disk — and
      // the only account of it went into a discarded array, so the user was
      // shown the error that started it and nothing about what survived it.
      const stamp = Math.random().toString(36).slice(2, 8);
      const name = `fixture-stuck-${stamp}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      /** @type {any} */
      let thrown = null;
      try {
        await provisionWorkspace({
          session,
          providerId: FixtureProvider.MANIFEST.id,
          values: { dir, failWith: 'the branch already exists', rollbackFailsWith: 'the tree is in use' },
          baseWorkspaceId: ''
        });
      } catch (error) {
        thrown = error;
      }
      try {
        assert(thrown, 'the provision failed, as the case asked it to');
        assert(/the branch already exists/.test(String(thrown?.message ?? '')),
          `the error that started it is what is thrown, got ${JSON.stringify(thrown?.message)}`);
        const leftBehind = provisionLeftBehind(thrown);
        assert(/the tree is in use/.test(leftBehind),
          `and what could not be undone is carried with it, got ${JSON.stringify(leftBehind)}`);
        assert((await projectOps.stat({ path: name })).exists === true,
          'which is worth saying precisely because the directory really is still there');
      } finally {
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
      }
    });

    await run('a tree whose provider could not be asked is not taken for an empty one', async () => {
      // The one question in here an unanswerable answer must not settle. A
      // provider that throws while reporting has said nothing about its tree,
      // and taking that for "clean" turns the guard off entirely: the carry then
      // writes over uncommitted work that was never listed and cannot be got
      // back. Unknown is a reason to refuse, never a reason to go ahead.
      const stamp = Math.random().toString(36).slice(2, 8);
      const fromDir = `unanswered-from-${stamp}`;
      const toDir = `unanswered-to-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));

      for (const dir of [fromDir, toDir]) {
        await writeFileOp({ path: `${dir}/shared.txt`, content: 'the commit both trees start from\n' });
        const git = `git -C ${dir} -c user.name=Juggler -c user.email=tests@juggler.invalid -c commit.gpgsign=false`;
        await project.shell({ command: `git -C ${dir} init -q` });
        await project.shell({ command: `${git} add -A` });
        await project.shell({ command: `${git} commit -q -m baseline` });
      }
      await writeFileOp({ path: `${fromDir}/shared.txt`, content: 'the source went its own way\n' });
      await writeFileOp({ path: `${toDir}/shared.txt`, content: 'work the destination has not committed\n' });

      const madeFrom = await registerWorkspace({
        root: `${projectPath}/${fromDir}`, label: 'the tree with the work in it', state: 'ready'
      });
      const madeTo = await registerWorkspace({
        root: `${projectPath}/${toDir}`,
        label: 'the tree that cannot answer',
        state: 'ready',
        providerId: FixtureProvider.MANIFEST.id
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom, madeTo];
      try {
        FixtureProvider.statusError = 'the provider fell over';
        const held = await workspaceHeldWork(session, madeTo.id);
        assert(held.dirty === true,
          `a tree nobody could ask holds work until something says otherwise, got ${JSON.stringify(held)}`);

        const refused = await carryWorkspaceWork(session, {
          fromId: madeFrom.id, toId: madeTo.id, paths: ['shared.txt']
        });
        assert(refused.done === false && (refused.conflicts ?? []).includes('shared.txt'),
          `so the carry into it is refused by name, got ${JSON.stringify(refused)}`);
        const kept = await project.readFile({ path: `${toDir}/shared.txt` });
        assert(String(kept?.content ?? '').includes('work the destination has not committed'),
          `and what that tree had not committed is still there, got ${JSON.stringify(kept?.content)}`);
      } finally {
        FixtureProvider.statusError = null;
        session.workspaces = saved;
        await unregisterWorkspace(madeFrom.id).catch(() => {});
        await unregisterWorkspace(madeTo.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [fromDir, toDir] });
      }
    });

    await run('a carry that cannot be made says so, rather than going quiet', async () => {
      // Every other way a carry stops is a sentence the move dialog puts on the
      // screen and leaves the choice up to be made again. A rejection is not a
      // sentence: it left the dialog exactly as it was, with nothing moved and
      // nothing said, which reads as a button that does not work.
      const stamp = Math.random().toString(36).slice(2, 8);
      const dir = `carry-refused-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${dir}/kept.txt`, content: 'the tree being left\n' });
      const made = await registerWorkspace({
        root: `${projectPath}/${dir}`, label: 'the tree being left', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      // What this carry leaves, rather than what is under there: the staging
      // directory carries a stamp of its own, and a case carrying something in
      // parallel owns the one it made.
      const staging = async () => /** @type {any[]} */ (
        await project.readOnlyFileSystem().readdir('.juggler/carry').catch(() => []));
      const stagingBefore = await staging();
      try {
        const answer = await carryWorkspaceWork(session, {
          fromId: made.id, toId: '', paths: ['../outside.txt']
        });
        assert(answer?.done === false && /couldn't bring the work/i.test(String(answer?.message ?? '')),
          `a copy the scope refuses comes back as a refusal, got ${JSON.stringify(answer)}`);
        const left = (await staging()).filter(
          (/** @type {any} */ entry) => !stagingBefore.includes(entry));
        assert(left.length === 0,
          `and that path takes its staging with it like every other, got ${JSON.stringify(left)}`);
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [dir] });
      }
    });

    await run('the chip says where a bound conversation works, and nothing where it does not', async () => {
      // Where the conversation works is the outermost of the three scopes in the
      // control row — it decides which files the strategy and the model operate
      // on — so it sits to the left of both. What it shows is the workspace's
      // STATE; its identity (the label and the tree) is the banner's job at the
      // top of the transcript, which is why both earn their place.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_chip', '/tmp/chip-tree', {
          label: 'feat/chips',
          providerId: FixtureProvider.MANIFEST.id
        }),
        workspaceRow('ws_orphan', '/tmp/orphan-tree', {
          label: 'made by something gone',
          providerId: '@someone/uninstalled'
        }),
        workspaceRow('ws_gone', '/tmp/gone-tree', { label: 'finished with', state: 'closed' })
      ];
      const chip = /** @type {any} */ (document.createElement('workspace-chip'));
      document.body.appendChild(chip);
      try {
        const bound = await makeConversation(session, 'chip-bound', { workspaceId: 'ws_chip' });
        release(bound);
        chip.setConversation(bound);

        assert(chip.hidden === false, 'a bound conversation gets a chip');
        const button = chip.querySelector('.workspace-chip-button');
        assert(button?.textContent?.includes('feat/chips'),
          `naming the place it works in, got ${JSON.stringify(button?.textContent)}`);

        button.click();
        const menu = chip.querySelector('.workspace-menu');
        assert(menu?.textContent?.includes('/tmp/chip-tree'),
          `and opening it says which tree that is, got ${JSON.stringify(menu?.textContent)}`);
        assert(menu?.querySelector('.workspace-menu-action[data-action="done"]'),
          `with the ways to be done with it, from the provider that made it, got ${JSON.stringify(menu?.textContent)}`);
        assert(menu?.querySelector('.workspace-menu-move'),
          `and the way to work somewhere else instead, got ${JSON.stringify(menu?.textContent)}`);
        button.click();
        assert(!chip.querySelector('.workspace-menu'),
          'which closes again');

        // An extension can be uninstalled while its workspaces stay on the
        // table. The conversation keeps working; only what the provider
        // supplied goes, and it goes for a stated reason.
        const orphaned = await makeConversation(session, 'chip-orphaned', { workspaceId: 'ws_orphan' });
        release(orphaned);
        chip.setConversation(orphaned);
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();
        const empty = chip.querySelector('.workspace-menu');
        assert(!empty?.querySelector('.workspace-menu-action'),
          'a workspace whose provider is gone offers no endings');
        assert(empty?.textContent?.includes(PROVIDER_UNAVAILABLE),
          `and says why rather than looking like a workspace with nothing to do, got ${JSON.stringify(empty?.textContent)}`);
        assert(empty?.textContent?.includes('made by something gone'),
          `keeping the row's own name, which nothing else here is left to say, got ${JSON.stringify(empty?.textContent)}`);
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();

        // The project is where every conversation worked before any of this
        // existed. Saying so earns its place exactly when there is somewhere
        // else to be — which is also when it has something to offer.
        const plain = await makeConversation(session, 'chip-unbound');
        release(plain);
        chip.setConversation(plain);
        assert(chip.hidden === false && chip.textContent?.includes('Project'),
          `a conversation in the project says so while other places exist, got ${JSON.stringify(chip.textContent)}`);
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();
        const offered = chip.querySelector('.workspace-menu');
        assert(offered?.querySelector('.workspace-menu-move'),
          `and offers the move that is the only thing to do about it, got ${JSON.stringify(offered?.textContent)}`);
        assert(!offered?.querySelector('.workspace-menu-action'),
          'with no endings, because nobody provisioned the project and nobody may finish with it');
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();

        // And with nowhere else to go it is back to saying nothing at all: the
        // composer of a user who has never made a workspace is untouched.
        const table = session.workspaces;
        session.workspaces = [];
        chip.setConversation(null);
        chip.setConversation(plain);
        assert(chip.hidden === true && !chip.querySelector('.workspace-chip-button'),
          'a conversation with only one place to work shows nothing at all');
        session.workspaces = table;

        // A binding that cannot be honoured is the tombstone banner's to
        // explain, with the rebind that fixes it — not the chip's to half-report.
        const stale = await makeConversation(session, 'chip-closed', { workspaceId: 'ws_gone' });
        release(stale);
        chip.setConversation(stale);
        assert(chip.hidden === true,
          'and neither does one whose workspace has been finished with');
      } finally {
        chip.remove();
        session.workspaces = saved;
      }
    });

    await run('an ending that asks for something is asked; one that does not is confirmed', async () => {
      // The host used to know one provider's action id by name — it collected a
      // commit message for anything called `commit` — which is a promise it
      // could only keep for the provider that was written first. An ending now
      // says for itself whether it needs a line of text, and the chip asks for
      // one exactly when it is wanted.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_asked', '/tmp/asked-tree', {
          label: 'feat/asked',
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const chip = /** @type {any} */ (document.createElement('workspace-chip'));
      document.body.appendChild(chip);
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return request.type === 'prompt' ? 'a note' : true;
      };
      try {
        const bound = await makeConversation(session, 'chip-asked', { workspaceId: 'ws_asked' });
        release(bound);
        chip.setConversation(bound);
        FixtureProvider.lastFinish = null;

        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();
        /** @type {any} */ (chip.querySelector('.workspace-menu-action[data-action="note"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'note',
          'the ending that asks for a line of text to run');

        assert(asked[0]?.type === 'prompt',
          `an ending declaring a prompt is prompted for, got ${JSON.stringify(asked[0]?.type)}`);
        assert(String(asked[0]?.message ?? '').includes('Leave it empty'),
          `with the hint the ending wrote, got ${JSON.stringify(asked[0]?.message)}`);
        assert(FixtureProvider.lastFinish?.input?.message === 'a note',
          `and what was typed reaches finish, got ${JSON.stringify(FixtureProvider.lastFinish?.input)}`);

        asked.length = 0;
        FixtureProvider.lastFinish = null;
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();
        /** @type {any} */ (chip.querySelector('.workspace-menu-action[data-action="leave"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'leave',
          'the ending that asks for nothing to run');
        assert(asked[0]?.type === 'confirm',
          `an ending declaring none is confirmed instead, got ${JSON.stringify(asked[0]?.type)}`);
        assert(!FixtureProvider.lastFinish?.input?.message,
          `and carries nothing it never collected, got ${JSON.stringify(FixtureProvider.lastFinish?.input)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        chip.remove();
        session.workspaces = saved;
        FixtureProvider.lastFinish = null;
      }
    });

    await run('the menu says each thing once, and can be driven from the keyboard', async () => {
      // A small menu found four ways to say "feat/menu", and every ending
      // printed the sentence the dialog was about to print again. What a row is
      // FOR decides where its words go: the header names the place, the status
      // line names the state, and the sentence somebody agrees to belongs where
      // they agree to it. What is left is short enough to read in one look.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_menu', '/tmp/menu-tree', {
          label: 'feat/menu (worktree)',
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const chip = /** @type {any} */ (document.createElement('workspace-chip'));
      document.body.appendChild(chip);
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return request.type === 'prompt' ? '' : true;
      };
      FixtureProvider.reported = { detail: 'feat/menu · clean' };
      FixtureProvider.discardDescription = 'Removes the tree and deletes feat/menu.';
      // The menu is relocated to <body> a frame after it opens, so it is found
      // wherever it currently is rather than where it was built.
      const surface = () => /** @type {any} */ (
        chip.querySelector('.workspace-menu') ?? document.querySelector('.workspace-menu'));
      const press = (/** @type {string} */ key) => document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      try {
        const bound = await makeConversation(session, 'chip-menu', { workspaceId: 'ws_menu' });
        release(bound);
        chip.setConversation(bound);
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();
        await waitFor(() => surface()?.textContent?.includes('feat/menu · clean'),
          'the status the provider reported to reach the open menu');

        const menu = surface();
        const text = String(menu?.textContent ?? '');
        const says = (/** @type {string} */ selector) =>
          menu.querySelector(`${selector} .menu-item-name`)?.textContent ?? '';
        assert(menu.querySelector('.workspace-menu-lead')?.textContent === 'Workspace',
          `the menu names the thing it is about, got ${JSON.stringify(text)}`);
        assert(menu.querySelector('.workspace-menu-kind')?.textContent === FixtureProvider.MANIFEST.name,
          `then what kind of place that is, got ${JSON.stringify(text)}`);
        assert(text.includes('/tmp/menu-tree') && text.includes('feat/menu · clean'),
          `then where it is and how it is doing, got ${JSON.stringify(text)}`);
        assert(!text.includes('(worktree)'),
          `and not the row's label as well, which the kind line has just answered, got ${JSON.stringify(text)}`);
        assert(menu.querySelector('.workspace-menu-root-name')?.textContent === 'menu-tree',
          `carrying the last segment of the path apart, because that is the name, got ${JSON.stringify(text)}`);
        assert(says('.workspace-menu-move') === 'Use a different workspace…',
          `the way out is named in the same noun, got ${JSON.stringify(says('.workspace-menu-move'))}`);
        assert(menu.querySelector('.category-header')?.textContent === 'When you’re done with this workspace',
          `and the endings are grouped under what they are for, got ${JSON.stringify(menu.querySelector('.category-header')?.textContent)}`);

        // Reporting rows are not `.menu-item`s: that class is the whole of what
        // makes the shared hover highlight offer a row as something to press,
        // and a menu whose title lights up under the pointer is lying.
        assert(!menu.querySelector('.workspace-menu-header.menu-item')
          && !menu.querySelector('.workspace-menu-detail.menu-item'),
        'the lines that only report are not menu items');
        assert(menu.querySelector('menu')?.getAttribute('role') === 'menu'
          && menu.querySelector('.workspace-menu-move')?.getAttribute('role') === 'menuitem',
        'and the ones that do something say so to anything reading the menu aloud');

        // Left edges, because the fault this catches — `align-items: center`
        // inherited into a column, which centres every stacked row — changes no
        // class name and nothing else would see it.
        const edge = (/** @type {string} */ selector) =>
          menu.querySelector(selector)?.getBoundingClientRect().left ?? -1;
        const gutter = edge('.workspace-menu-move .menu-item-name');
        assert(gutter > 0 && Math.abs(edge('.workspace-menu-root-parent') - gutter) < 1,
          `the path starts at the same edge as the rows below it, got ${edge('.workspace-menu-root-parent')} against ${gutter}`);
        assert(Math.abs(edge('.workspace-menu-action[data-action="leave"] .menu-item-name') - gutter) < 1,
          'and so does an ending');

        // What pressing a row will do is in the menu, where it is read BEFORE
        // the decision. A label cannot carry it: "Leave it be" does not say that
        // the conversation ends up back in the project, and a sentence somebody
        // has to hover to find is a sentence nobody reads.
        const note = (/** @type {string} */ selector) =>
          menu.querySelector(`${selector} .menu-item-note`)?.textContent ?? '';
        assert(note('.workspace-menu-move').includes('keeps its history'),
          `the move says what becomes of the conversation, got ${JSON.stringify(note('.workspace-menu-move'))}`);
        assert(note('.workspace-menu-action[data-action="leave"]').includes('back to the project folder'),
          `and so does every ending, got ${JSON.stringify(note('.workspace-menu-action[data-action="leave"]'))}`);

        assert(says('.workspace-menu-action[data-action="note"]') === 'Leave a note…',
          `one that will ask for something says so with an ellipsis, got ${JSON.stringify(says('.workspace-menu-action[data-action="note"]'))}`);
        assert(says('.workspace-menu-action[data-action="leave"]') === 'Leave it be',
          'and one that only needs agreeing to does not');

        // An action that leaves the workspace in use is not an ending and is not
        // filed under one: committing is the case this exists for, and it sat
        // under "when you're done" for as long as it closed the workspace half
        // the time.
        const heading = menu.querySelector('.category-header');
        const before = [...menu.querySelectorAll('[role="menuitem"]')].filter(row =>
          heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING);
        assert(before.map((/** @type {any} */ row) => row.dataset.action ?? 'move').join(',') === 'move,note',
          `what keeps the workspace sits above the endings, got ${JSON.stringify(before.map((/** @type {any} */ row) => row.textContent))}`);

        const discard = menu.querySelector('.workspace-menu-action[data-action="discard"]');
        assert(discard?.previousElementSibling?.classList.contains('menu-divider'),
          'a destructive ending is kept off the row above it');

        // Driven from the keyboard: the rows are move, note, done, leave,
        // discard, so the fourth press lands on the one that reports and
        // changes nothing.
        FixtureProvider.lastFinish = null;
        press('ArrowDown'); press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
        const rows = [...surface().querySelectorAll('[role="menuitem"]')];
        assert(rows[3]?.dataset?.action === 'leave' && rows[3]?.classList.contains('nav-active'),
          `four presses down highlight the fourth row, got ${JSON.stringify(rows.map(row => row.textContent))}`);
        press('Enter');
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'leave',
          'and Enter runs the row it is on');

        // And again at the point of no return, where it is agreed to.
        asked.length = 0;
        FixtureProvider.lastFinish = null;
        /** @type {any} */ (chip.querySelector('.workspace-chip-button')).click();
        /** @type {any} */ (surface().querySelector('.workspace-menu-action[data-action="discard"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'discard',
          'the destructive ending to run once it is agreed to');
        assert(String(asked[0]?.message ?? '').includes('Removes the tree and deletes feat/menu.'),
          `with what it costs said in the dialog, got ${JSON.stringify(asked[0]?.message)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        chip.remove();
        session.workspaces = saved;
        FixtureProvider.reported = null;
        FixtureProvider.discardDescription = null;
        FixtureProvider.lastFinish = null;
      }
    });

    await run('the composer carries the chip and tells it which conversation', async () => {
      // The chip could be right about everything and never be mounted.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_mounted', '/tmp/mounted-tree', { label: 'feat/mounted' })];
      const box = /** @type {any} */ (document.createElement('composer-box'));
      document.body.appendChild(box);
      try {
        const bound = await makeConversation(session, 'chip-in-the-composer', { workspaceId: 'ws_mounted' });
        release(bound);
        box.setConversation(bound);

        const chip = box.querySelector('input-controls-config workspace-chip');
        assert(chip, 'the chip is in the control row, with the strategy and the model');
        assert(chip?.previousElementSibling === null,
          'and first among them, being the scope the other two work inside');
        assert(chip?.textContent?.includes('feat/mounted'),
          `bound to the composer's own conversation, got ${JSON.stringify(chip?.textContent)}`);
      } finally {
        box.remove();
        session.workspaces = saved;
      }
    });

    await run('the dialog moves a conversation, and its instructions move with it', async () => {
      // The chip reports and finishes; this is where it changes its mind. The
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

        assert(isSetupProvisioning(moving) === false,
          'a move builds on its own state: nothing here parks the sends of a conversation that is already under way');

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
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
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
        await projectOps.shell({ command: `rm -rf ${dir}` }).catch(() => {});
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
        await projectOps.shell({ command: `mkdir -p ${dir} ${decoyDir}` });
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
        await projectOps.shell({ command: `rm -rf ${dir} ${decoyDir}` }).catch(() => {});
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
        assert(status.label === 'made by something no longer installed',
          `while still naming the workspace, got ${JSON.stringify(status.label)}`);

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
  } finally {
    if (session) {
      session.applySessionMetadataPatch({ [DEFAULT_FILE_EDITING_META_KEY]: fileEditingWas ?? null });
      for (const id of created) {
        await releaseTestConversation(session, id, 'conversation-workspace-test');
      }
    }
    await fetchJson(`/api/session/workspaces/${registeredId}`, { method: 'DELETE', fallback: null });
  }

  return { passed, failed, errors };
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What an uninitialised conversation has been told so far, and what happens when
 * it is told the rest.
 *
 * A conversation created blank is asked one question before it starts: where it
 * works. This module holds the answer while it is being given — which row is
 * selected, what a provider's form currently says, how far a provision has got,
 * and how to take it all back — and performs the three acts that end the
 * question: creating a workspace, committing the choice, and undoing it.
 *
 * It is deliberately view-free. Cancel, failure part-way through and Undo are
 * one mechanism in {@link module:services/workspace-provisioning}, and the panel
 * is a view onto this state rather than a second copy of it: everything below
 * can be driven, and is tested, without a single click.
 * @module services/conversation-setup
 */

import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import workerManager from './worker-manager.js';
import {
  provisionWorkspace,
  workspaceStatus,
  workspaceFinishOptions,
  provisionLeftBehind
} from './workspace-provisioning.js';
import { registerWorkspace, isWorkspaceUsable } from './workspaces.js';
import { createBoundOps } from '../../sdk/ops.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/** The row id of the project itself: the workspace every conversation has already. */
export const PROJECT_ROW_ID = '';

/** What a "New…" row's id starts with; the rest of it is the provider's id. */
export const NEW_ROW_PREFIX = 'new:';

/** What a row offering something that already exists starts with. */
export const ADOPT_ROW_PREFIX = 'adopt:';

/**
 * One line of a provision, as the provider announced it.
 * @typedef {object} SetupProgress
 * @property {string} step - What is being done, emitted before it starts
 * @property {string} [detail] - The command, the path, the host — whatever names it
 */

/**
 * @typedef {object} SetupState
 * @property {'choosing'|'provisioning'|'settled'} phase - Where in the flow it is
 * @property {string} selection - {@link PROJECT_ROW_ID}, a workspace id, or `new:<providerId>`
 * @property {object} values - What the selected provider's form last reported
 * @property {boolean} valid - Whether that form may be submitted
 * @property {string} invalidFieldId - Which field to focus when it may not be
 * @property {SetupProgress[]} progress - One line per step of the running provision
 * @property {string} error - Why the last attempt did not finish, for the panel to show
 * @property {boolean} undoable - Whether the workspace just made can still be taken back
 * @property {number} attentionSeq - Bumped when a send was turned away and the panel should say which field
 */

/**
 * One row of the workspace section.
 * @typedef {object} SetupRow
 * @property {'project'|'workspace'|'adopt'|'new'} kind - Which band it belongs to
 * @property {string} id - What {@link selectSetupRow} is given
 * @property {string} label - What the row says
 * @property {string} [meaning] - What choosing it does, in plain words
 * @property {string} [detail] - Where it is: a path, or what a probe last said
 * @property {string} [providerId] - For a `new` row, whose form it expands into
 */

/**
 * Everything being held for one conversation mid-setup: the state above, plus
 * the parts a view must never see — the controller that cancels the running
 * provision, the compensation stack's handle, and what committing added to the
 * document.
 * @typedef {SetupState & {
 *   controller: AbortController|null,
 *   undo: (() => Promise<string>)|null,
 *   workspaceId: string,
 *   seededItemIds: string[],
 *   parked: {itemId: string, send: () => Promise<any>}|null,
 *   seedGeneration: number,
 *   seedTimer: any,
 *   seeding: Promise<void>|null
 * }} SetupRecord
 */

/**
 * How long a selection has to hold still before its seeds are rebuilt.
 *
 * The rows are a radio group, so the arrow keys walk through every row between
 * the one that had the selection and the one the user wants — and each of those
 * would otherwise be a tree read. Long enough that walking the list costs one
 * rebuild, short enough that a click feels like it did it immediately.
 */
const RESEED_SETTLE_MS = 150;

/** @type {Map<string, SetupRecord>} Conversation id → what it has been told. */
const records = new Map();

/** @type {Map<string, any>} Workspace id → its last speculative status. */
const statusCache = new Map();

/** @type {Map<string, {providerId: string, artifact: any}>} Row id → something that exists and has no workspace. */
const adoptable = new Map();

/** @type {Set<(conversationId: string) => void>} Who to tell when any of it moves. */
const listeners = new Set();

/**
 * @param {string} conversationId - Whose setup moved.
 */
function notify(conversationId) {
  for (const listener of listeners) {
    try {
      listener(conversationId);
    } catch (error) {
      // A view that throws while redrawing must not stop the next one redrawing,
      // and must certainly not reject the provision that prompted it.
      console.warn('[Setup] a listener threw:', error);
    }
  }
}

/**
 * Watch every conversation's setup state.
 * @param {(conversationId: string) => void} listener - Called with whose state moved.
 * @returns {() => void} Stop watching.
 */
export function subscribeSetup(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The record for a conversation, created blank on first ask.
 * @param {any} conversation - The conversation being set up.
 * @returns {SetupRecord} Its record.
 */
function recordFor(conversation) {
  const id = conversation?.id ?? '';
  let record = records.get(id);
  if (!record) {
    record = {
      phase: 'choosing',
      selection: PROJECT_ROW_ID,
      values: {},
      valid: true,
      invalidFieldId: '',
      progress: [],
      error: '',
      undoable: false,
      attentionSeq: 0,
      controller: null,
      undo: null,
      workspaceId: '',
      seededItemIds: [],
      parked: null,
      seedGeneration: 0,
      seedTimer: null,
      seeding: null
    };
    records.set(id, record);
  }
  return record;
}

/**
 * What a conversation has been told so far.
 *
 * The project is preselected, so a conversation nobody has touched answers
 * exactly what it would have answered before any of this existed.
 * @param {any} conversation - The conversation being set up.
 * @returns {SetupState} Its state.
 */
export function getSetupState(conversation) {
  return recordFor(conversation);
}

/**
 * Forget a conversation's setup. Called when it is closed or released: the
 * record holds an abort controller and a compensation stack, neither of which
 * means anything once the conversation is gone.
 * @param {string} conversationId - The conversation being forgotten.
 */
export function forgetSetup(conversationId) {
  const record = records.get(conversationId);
  record?.controller?.abort();
  if (record) {
    clearTimeout(record.seedTimer);
    record.seedTimer = null;
    // A pass already running is abandoned at its next await rather than at its
    // last one, so nothing it has read is written into a conversation that has
    // gone.
    record.seedGeneration++;
  }
  records.delete(conversationId);
}

/**
 * The rows of the workspace section, in the order they are offered.
 *
 * Three bands: the project, then every workspace that already exists and can be
 * worked in, then one row per provider that could make another. The middle band
 * is first-class rather than a pooling detail — binding to a worktree that is
 * already built, or a host already known, is the common path, and making a new
 * one is the rare one.
 *
 * A workspace still being built, already finished with, or whose root is not
 * there is not offered: all three refuse every operation, so binding to one
 * would be choosing somewhere that cannot be worked in. The third is not a
 * state but a fact that can reverse — the row stays on the table and comes
 * back here when its tree does.
 * @param {any} session - The session whose table and providers these are.
 * @returns {SetupRow[]} The rows, project first.
 */
export function setupRows(session) {
  /** @type {SetupRow[]} */
  const rows = [{
    kind: 'project',
    id: PROJECT_ROW_ID,
    label: 'The project folder',
    // Where every conversation worked before workspaces existed, said plainly:
    // the reader deciding this has met the word "workspace" for the first time a
    // moment ago, and what they need is what happens to their files. It is named
    // after the place rather than after its place in the list — "Default" told
    // somebody choosing where their work would happen only that we had chosen
    // for them.
    meaning: 'No separate workspace: this conversation works in the project folder itself.',
    detail: session?.projectPath ?? ''
  }];

  for (const workspace of session?.workspaces ?? []) {
    if (!isWorkspaceUsable(workspace)) continue;
    rows.push({
      kind: 'workspace',
      id: workspace.id,
      label: workspace.label || workspace.root,
      detail: workspace.root
    });
  }

  // Places that exist and have no row: the pool, and anything a hand-run
  // command left behind. Between what is registered and what could be made,
  // because that is what it is — something that exists, one click from being
  // usable.
  for (const [id, offer] of adoptable) {
    const root = offer.artifact.workspace?.root;
    const rowFor = (/** @type {any} */ candidate) => candidate.root === root;
    // A live row already offers this place in the band above, so the same place
    // must not also be offered as something to adopt. A tombstone does not: it
    // is a place somebody stopped using, and picking it up again is the whole
    // reason stopping is not deleting.
    if (session?.workspaces?.some?.((/** @type {any} */ row) => rowFor(row) && row.state !== 'closed')) {
      continue;
    }
    const parked = session?.workspaces?.find?.((/** @type {any} */ row) => rowFor(row) && row.state === 'closed');
    rows.push({
      kind: 'adopt',
      id,
      label: offer.artifact.label || offer.artifact.workspace?.root || '',
      detail: offer.artifact.detail || '',
      // Which of the two kinds of found thing this is. A stray tree somebody
      // made by hand and one this project parked last week are both one click
      // from usable and read identically otherwise, and only one of them is
      // somewhere the reader has already been.
      meaning: parked
        ? 'You stopped using this workspace. Adopting it picks up where you left off.'
        : undefined,
      providerId: offer.providerId
    });
  }

  for (const providerId of workspaceProviderRegistry.getIds()) {
    const provider = workspaceProviderRegistry.createProvider(providerId, session);
    if (!provider) continue;
    rows.push({
      kind: 'new',
      id: `${NEW_ROW_PREFIX}${providerId}`,
      label: provider.getSetupLabel(),
      // What the provider says one of its places is. It is what this row means
      // rather than where it is — nothing is anywhere yet — so it reads on the
      // meaning line, which is the line a reader needs here.
      meaning: provider.getManifest().description,
      providerId
    });
  }

  return rows;
}

/**
 * Ask every listed workspace how it is doing, at once.
 *
 * Speculative by design: the panel shows a branch and a dirty flag for rows the
 * user has not selected, which is what makes picking one an informed choice
 * rather than a guess — and why `status()` is documented as having to be cheap.
 * The answers are cached, and the whole sweep rides one signal so that closing
 * the panel stops all of it.
 * @param {any} session - The session the workspaces belong to.
 * @param {AbortSignal} [signal] - Abort when the panel closes.
 * @returns {Promise<void>} When every row has answered or been abandoned.
 */
export async function probeSetupStatuses(session, signal) {
  const rows = setupRows(session).filter(row => row.kind === 'workspace');
  await Promise.all(rows.map(async (row) => {
    const workspace = session.getWorkspace(row.id);
    if (!workspace) return;
    const status = await workspaceStatus(session, workspace, signal);
    if (signal?.aborted) return;
    statusCache.set(row.id, status);
    notify('');
  }));
}

/**
 * Everything a row reads out of an adoptable artifact, as one string.
 *
 * The comparison is against what the row would say, not against the artifact
 * object: a sweep builds a fresh one each time, so two findings that are the
 * same finding are never the same object.
 * @param {any} artifact - What a provider says exists, or nothing.
 * @returns {string} Its signature, or '' for nothing.
 */
function offerSignature(artifact) {
  if (!artifact) return '';
  return [
    artifact.label ?? '',
    artifact.detail ?? '',
    artifact.workspace?.root ?? ''
  ].join('\u0001');
}

/**
 * Ask every provider what exists that the table does not know about.
 *
 * This is `reconcile()` used for the half of its job that is an offer rather
 * than a cleanup, and it runs per window rather than under the startup claim:
 * enumerating is read-only by contract — the claim exists so that three windows
 * do not run `git worktree prune` at each other — and a panel opened an hour
 * after startup must show what is there now.
 *
 * It is what makes a pool worth having. A tree that exists and is already built
 * is one click from being somewhere a conversation works, with no pool-release
 * machinery anywhere and no fresh-tree recompile.
 * @param {any} session - The session whose table and providers these are.
 * @param {AbortSignal} [signal] - Abort when the panel closes.
 * @returns {Promise<void>} When every provider has answered or been abandoned.
 */
export async function probeSetupAdoptions(session, signal) {
  const rows = session?.workspaces ?? [];
  await Promise.all(workspaceProviderRegistry.getIds().map(async (providerId) => {
    const provider = workspaceProviderRegistry.createProvider(providerId, session);
    if (!provider) return;
    try {
      // Tombstones go too. A row that has been finished with lays no claim to
      // its artifact — that is what finishing with it meant — but it is the only
      // record of WHERE that artifact is, and a provider that is not told about
      // it cannot even look in the right place: a parked worktree of a
      // repository other than the project went unlisted entirely, because the
      // repository was only ever reached through the rows. Whether a closed row
      // still means anything is the provider's judgement, and both of ours skip
      // them when matching, so their artifacts are offered again.
      const report = await provider.reconcile(
        rows.filter((/** @type {any} */ row) => row.providerId === providerId),
        {
          session,
          ops: createBoundOps(() => ({})),
          baseWorkspaceId: '',
          signal: signal ?? new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });
      if (signal?.aborted) return;
      let moved = false;
      for (const found of report?.orphanedArtifacts ?? []) {
        const artifact = /** @type {any} */ (found);
        if (!artifact?.workspace?.root) continue;
        const rowId = `${ADOPT_ROW_PREFIX}${providerId}\u0000${artifact.id ?? artifact.workspace.root}`;
        if (offerSignature(adoptable.get(rowId)?.artifact) !== offerSignature(artifact)) moved = true;
        adoptable.set(rowId, { providerId, artifact });
      }
      // A sweep that found exactly what the last one found has nothing to say,
      // and saying it anyway is not merely wasted work: the panel sweeps as it
      // opens, and a listener redrawing on the announcement draws a panel that
      // sweeps. Announcing only what moved is what stops that being a circle.
      if (moved) notify('');
    } catch (error) {
      // A provider that cannot enumerate is not a reason to say anything at
      // all: the panel simply offers what it always offered.
      console.warn(`[Setup] ${providerId} could not say what exists:`, error);
    }
  }));
}

/**
 * Register something a provider found, so a conversation can be bound to it.
 *
 * Adopting builds nothing and changes nothing on disk — it is the table
 * catching up with a tree that was already there — which is why it is the one
 * row in the panel that acts on a single click.
 *
 * It is also how a lost table is recovered, which is the same act under a
 * different name: `id` registers the place under an id of the caller's choosing
 * rather than a fresh one, so that conversations still bound to that id resolve
 * again instead of being moved one by one to a tree they never left. An id the
 * table already holds is refused by the server, and the refusal is left to
 * reach the caller: quietly registering it as something else would be the one
 * answer nobody could act on.
 * @param {any} session - The session to register it with.
 * @param {string} rowId - The `adopt:` row that was clicked.
 * @param {{id?: string}} [options] - The id to register it under, where the caller has one that matters.
 * @returns {Promise<any>} The registered workspace, or null when the offer has gone.
 */
export async function adoptSetupRow(session, rowId, options = {}) {
  const offer = adoptable.get(rowId);
  if (!offer) return null;

  const registered = await registerWorkspace({
    ...(options?.id ? { id: options.id } : {}),
    kind: offer.artifact.workspace.kind || 'local',
    root: offer.artifact.workspace.root,
    label: offer.artifact.workspace.label || offer.artifact.label || '',
    providerId: offer.providerId,
    state: 'ready',
    meta: offer.artifact.workspace.meta ?? {}
  });

  // Taken, so no longer on offer. The row the panel shows from here is the
  // ordinary workspace row, in the band where every other workspace is.
  adoptable.delete(rowId);
  if (session && !session.workspaces?.some?.((/** @type {any} */ row) => row.id === registered.id)) {
    // The broadcast will bring it too, but the panel is on screen now and the
    // click that adopted it has to do something visible.
    session.workspaces = [...(session.workspaces ?? []), registered];
  }
  notify('');
  return registered;
}

/**
 * The last thing a workspace said about itself, if it has been asked.
 * @param {string} workspaceId - The workspace in question.
 * @returns {any} Its status, or undefined while the answer is still coming.
 */
export function cachedSetupStatus(workspaceId) {
  return statusCache.get(workspaceId);
}

/**
 * Select a row. This never builds anything on disk: a stray click on "New git
 * worktree" must cost nothing, so only Create does. What it does rebuild is the
 * conversation's own seeds — see {@link scheduleSeedRebuild}.
 * @param {any} conversation - The conversation being set up.
 * @param {string} rowId - From {@link SetupRow}.
 */
export function selectSetupRow(conversation, rowId) {
  const record = recordFor(conversation);
  if (record.phase === 'provisioning') return;
  if (record.selection !== rowId) {
    record.selection = rowId;
    record.values = {};
    record.valid = true;
    record.invalidFieldId = '';
    scheduleSeedRebuild(conversation, record);
  }
  record.error = '';
  notify(conversation.id);
}

/**
 * Which tree a row's seeds should be read out of.
 *
 * A row naming a workspace that exists and can be worked in reads that one.
 * Everything else reads the project, and for the other three kinds that is not a
 * fallback but the answer: the project is what a "New…" row would be built from
 * (the panel opens every provider form against it), what an adoptable artifact
 * was made from, and what the project row is.
 * @param {any} conversation - The conversation being set up.
 * @param {string} rowId - The selected row.
 * @returns {string} A workspace id, or '' for the project.
 */
function seedRootFor(conversation, rowId) {
  if (!rowId || rowId.startsWith(NEW_ROW_PREFIX) || rowId.startsWith(ADOPT_ROW_PREFIX)) return PROJECT_ROW_ID;
  const workspace = conversation?.session?.getWorkspace?.(rowId);
  return workspace?.state === 'ready' ? rowId : PROJECT_ROW_ID;
}

/**
 * Rebuild the conversation's seeds for the tree the selection now names.
 *
 * A conversation shows what its first turn would carry from the moment it is
 * created, which means it is showing the seeds of one particular tree — so
 * answering the question with a different tree has to replace them. Nothing is
 * bound and nothing is committed by this: it is the same question, answered
 * again, and the answer is always the whole set rather than a diff.
 *
 * It costs nothing to be wrong about. A seeded file item persists a path and no
 * bytes until its snapshot at the first transaction, so a set rebuilt three
 * times before the first message has read three trees and thrown away nothing of
 * anyone's. What is deliberately NOT rebuilt is everything else on the thread:
 * memory and skills do not vary by tree — one is the project's by design, the
 * other comes from a catalog with no tree in it — and a file the user pinned
 * themselves is theirs, not an answer to this question.
 * @param {any} conversation - The conversation being set up.
 * @param {SetupRecord} record - Its record.
 */
function scheduleSeedRebuild(conversation, record) {
  if (!conversation || conversation.initialised) return;

  const generation = ++record.seedGeneration;
  clearTimeout(record.seedTimer);
  record.seedTimer = setTimeout(() => {
    record.seedTimer = null;
    record.seeding = rebuildSeeds(conversation, record, generation)
      .catch((error) => {
        // Seeding is best-effort everywhere else it happens, and a tree that
        // cannot be read is a row the user is about to find out about anyway.
        console.warn('[Setup] the seeds could not be rebuilt:', error);
      })
      .finally(() => { record.seeding = null; });
  }, RESEED_SETTLE_MS);
}

/**
 * The rebuild itself: out with the tree that was selected, in with the one that
 * is. Abandoned at every await if the selection has moved on again, so the last
 * row picked is the one whose seeds survive.
 * @param {any} conversation - The conversation being set up.
 * @param {SetupRecord} record - Its record.
 * @param {number} generation - Which selection this pass is for.
 * @returns {Promise<void>} When the seeds are the new tree's.
 */
async function rebuildSeeds(conversation, record, generation) {
  const thread = conversation?.rootMessageThread;
  const session = conversation?.session;
  if (!thread || !session || conversation.initialised) return;

  const root = seedRootFor(conversation, record.selection);
  if (conversation.seededFor === root) return;

  // Asked before anything is touched, for the reason the initialising pass asks
  // it: the rebuild puts its own groups on the undo stack, and would otherwise
  // be the answer.
  const usersOwnHistory = conversation.canUndo?.() === true;

  // Every seeded assistant file, whoever put it there and whichever pass — the
  // flag is what makes an item ours rather than the user's, so it needs no
  // bookkeeping to survive a reload.
  for (const item of thread.contextItems) {
    if (item.type !== 'file-content' || item.data?.seeded !== true) continue;
    try {
      thread.removeContextItem(item.id);
    } catch {
      // An item already gone is an item that does not need removing.
    }
  }
  if (record.seedGeneration !== generation) return;

  await session.seedConversationAutoItems(conversation, null, { workspaceId: root });
  if (record.seedGeneration !== generation) return;
  conversation.seededFor = root;

  // Ours rather than the user's, exactly as at creation — but never at the cost
  // of undo history they made in the window this rebuild happens in.
  if (!usersOwnHistory) await workerManager.clearUndoStacks(conversation.id);
  notify(conversation.id);
}

/**
 * Wait for the seeds to have caught up with the selection.
 *
 * The commit hop takes this before it reads the patch, so that a conversation
 * sent to a moment after the row was clicked binds to that row with that row's
 * seeds already in it — rather than binding first and seeding on top of the
 * previous row's.
 * @param {any} conversation - The conversation about to be initialised.
 * @returns {Promise<void>} When nothing is pending.
 */
export async function settleSetupSeeding(conversation) {
  const record = records.get(conversation?.id ?? '');
  if (!record) return;
  if (record.seedTimer) {
    clearTimeout(record.seedTimer);
    record.seedTimer = null;
    record.seeding = rebuildSeeds(conversation, record, record.seedGeneration)
      .catch(() => { /* best-effort, as above */ })
      .finally(() => { record.seeding = null; });
  }
  await record.seeding;
}

/**
 * Record what a provider's form currently says.
 * @param {any} conversation - The conversation being set up.
 * @param {import('../../sdk/workspace-provider.js').SetupValue} value - From `getSetupValue()`.
 */
export function setSetupValues(conversation, value) {
  const record = recordFor(conversation);
  const values = value?.values ?? {};
  const valid = value?.valid !== false;
  const invalidFieldId = value?.invalidFieldId ?? '';

  // A form reports itself on every edit, and once more on the build that
  // precedes the first edit. What it says is worth passing on; that it has said
  // the same thing again is not — and passing that on is what lets a view which
  // redraws on it rebuild the form, which reports itself, without end.
  const moved = record.valid !== valid
    || record.invalidFieldId !== invalidFieldId
    || !sameValues(record.values, values);

  record.values = values;
  record.valid = valid;
  record.invalidFieldId = invalidFieldId;
  if (moved) notify(conversation.id);
}

/**
 * Whether two readings of a form say the same thing.
 *
 * Shallow, because a reading is flat: providers return a bag of strings a
 * `provision` is handed literally.
 * @param {any} before - The last reading.
 * @param {any} after - The one just taken.
 * @returns {boolean} Whether they agree.
 */
function sameValues(before, after) {
  const keys = Object.keys(after ?? {});
  if (keys.length !== Object.keys(before ?? {}).length) return false;
  return keys.every(key => before?.[key] === after?.[key]);
}

/**
 * The provider a `new:` selection names, or nothing for the other two bands.
 * @param {SetupState} record - The conversation's state.
 * @returns {string} A provider id, or ''.
 */
function selectedProviderId(record) {
  return record.selection.startsWith(NEW_ROW_PREFIX)
    ? record.selection.slice(NEW_ROW_PREFIX.length)
    : '';
}

/**
 * What to bind when this conversation commits, for a choice that needs nothing
 * built.
 *
 * A selected row does not bind on its own — the conversation commits at its
 * first content, exactly as it did before there was anything to select — so
 * this is what {@link Conversation#ensureInitialised} asks for on the way
 * through. A `new:` row has nothing to offer yet: nothing exists until Create
 * has run, and a send made before that is the setup panel's to refuse.
 * @param {any} conversation - The conversation about to be initialised.
 * @returns {{workspaceId?: string}} The patch to initialise with.
 */
export function pendingSetupPatch(conversation) {
  const record = records.get(conversation?.id ?? '');
  if (!record || record.phase === 'provisioning') return {};
  if (selectedProviderId(record)) return {};
  return { workspaceId: record.selection };
}

/**
 * Why this conversation cannot be sent to yet, if it cannot.
 *
 * The sharpest edge in the feature: the user typed a message, pressed Enter, and
 * we refused. So it exists for exactly one situation — a "New…" row is selected
 * and the place it describes has not been made — and it reads as *finish this
 * first* rather than as an error. Everything else sends: a conversation with
 * nothing picked binds the project, exactly as it always did.
 * @param {any} conversation - The conversation being sent to.
 * @returns {{reason: string, fieldId: string}|null} What to say, and what to point at.
 */
export function setupSendBlock(conversation) {
  const record = records.get(conversation?.id ?? '');
  if (!record || conversation?.initialised) return null;
  // Provisioning parks the send instead, and a settled one has its workspace.
  if (record.phase !== 'choosing') return null;
  if (!selectedProviderId(record)) return null;
  return record.valid
    ? { reason: 'Create the workspace first, or pick one that already exists.', fieldId: '' }
    : { reason: 'Finish setting up the workspace first.', fieldId: record.invalidFieldId };
}

/**
 * Ask the panel to point at whatever turned a send away: the field that is not
 * filled in, or the button that has not been pressed.
 * @param {any} conversation - The conversation whose send was refused.
 */
export function flagSetupAttention(conversation) {
  const record = recordFor(conversation);
  record.attentionSeq += 1;
  notify(conversation.id);
}

/**
 * Whether this conversation is waiting on a workspace that is still being built.
 * @param {any} conversation - The conversation being sent to.
 * @returns {boolean} True while a provision is running.
 */
export function isSetupProvisioning(conversation) {
  return records.get(conversation?.id ?? '')?.phase === 'provisioning';
}

/**
 * Hold a send until the workspace it needs exists.
 *
 * The message is already in the conversation's queue by the time this is called,
 * so what is held here is only how to let it go again. One at a time: a second
 * send while one is parked replaces it, because the queue it is rendered from
 * shows them both and sending the older one twice is worse than either.
 * @param {any} conversation - The conversation whose send is waiting.
 * @param {{itemId: string, send: () => Promise<any>}} parked - The queued item, and how to send it.
 */
export function parkSetupSend(conversation, parked) {
  recordFor(conversation).parked = parked;
  notify(conversation.id);
}

/**
 * Let a parked send go, now that there is somewhere for it to run.
 * @param {any} conversation - The conversation that has just been bound.
 * @param {SetupRecord} record - Its record.
 * @returns {Promise<void>} When the message has been sent.
 */
async function releaseParked(conversation, record) {
  const parked = record.parked;
  if (!parked) return;
  record.parked = null;
  // Out of the queue first: the send about to run writes the message properly,
  // and two copies of it is the one outcome worse than a delay.
  conversation.rootMessageThread?.removeItemById(parked.itemId);
  await parked.send();
}

/**
 * Bind the conversation to a workspace and run the seeds against it, recording
 * exactly what that added so that Undo can take it away again.
 * @param {any} conversation - The conversation being committed.
 * @param {SetupRecord} record - Its record.
 * @param {string} workspaceId - What to bind it to.
 * @param {object[]} [seedItems] - Context items the provider wants it to start with.
 * @returns {Promise<void>} When it is bound, seeded and settled.
 */
async function commit(conversation, record, workspaceId, seedItems = []) {
  const thread = conversation.rootMessageThread;
  const before = new Set((thread?.contextItems ?? []).map((/** @type {any} */ item) => item.id));

  await conversation.session?.initialiseConversation?.(conversation, { workspaceId });

  for (const item of seedItems) {
    try {
      thread?.addContextItem(item);
    } catch (error) {
      // A seed item is the provider telling the model what it has just built —
      // worth having, never worth failing a finished provision over.
      console.warn('[Setup] a provider\'s seed item could not be added:', error);
    }
  }

  record.workspaceId = workspaceId;
  record.seededItemIds = (thread?.contextItems ?? [])
    .map((/** @type {any} */ item) => item.id)
    .filter((/** @type {string} */ id) => !before.has(id));
}

/**
 * Build the workspace the selected `new:` row describes, then bind to it.
 *
 * Everything difficult about this lives in `provisionWorkspace`: the row is
 * registered before the first command runs, each step's inverse is recorded
 * before the step, and a rejection — including a cancel that lands after the
 * provider has finished — unwinds the lot. What is added here is the part the
 * panel shows: the progress lines, and the undo that outlives success.
 *
 * Binding happens on success even though nothing has been sent yet. The
 * conversation is then a bound, initialised, empty conversation, which is what
 * lets the user keep typing into the composer while the tree is being built.
 * @param {any} conversation - The conversation being set up.
 * @returns {Promise<{ok: boolean, error?: string}>} Whether it now has a workspace.
 */
export async function createSelectedWorkspace(conversation) {
  const record = recordFor(conversation);
  const providerId = selectedProviderId(record);
  if (!providerId) return { ok: false, error: 'Nothing to create: this row is a workspace that already exists.' };
  if (record.phase === 'provisioning') return { ok: false, error: 'Already building one.' };

  const controller = new AbortController();
  record.phase = 'provisioning';
  record.controller = controller;
  record.progress = [];
  record.error = '';
  notify(conversation.id);

  try {
    const outcome = await provisionWorkspace({
      session: conversation.session,
      conversation,
      providerId,
      values: record.values,
      signal: controller.signal,
      onProgress: (step, detail) => {
        record.progress.push({ step, detail });
        notify(conversation.id);
      }
    });

    await commit(conversation, record, outcome.workspace.id, outcome.seedItems);

    record.phase = 'settled';
    record.controller = null;
    record.undo = outcome.undo;
    record.undoable = true;
    notify(conversation.id);

    // A message sent while this was building has been sitting in the queue
    // waiting for somewhere to run. This is that moment.
    await releaseParked(conversation, record);
    return { ok: true };
  } catch (error) {
    // Cancelled and failed are the same unwinding and different things to say.
    // A cancel was the user's own instruction and needs no explanation on
    // screen; a failure is the only account they will get of why there is no
    // workspace, so it is kept and shown against the form they can correct.
    record.phase = 'choosing';
    record.controller = null;
    record.progress = [];
    // A cancel says nothing — except when the unwinding left something on disk,
    // which is the one thing a silent cancel must not swallow.
    const leftBehind = provisionLeftBehind(error);
    const failure = controller.signal.aborted ? '' : extractErrorMessage(error);
    record.error = [failure, leftBehind].filter(Boolean).join(' ');
    notify(conversation.id);
    return { ok: false, error: record.error };
  }
}

/**
 * Stop the provision that is running. The command actually dies — the signal
 * reaches every operation the provider made — and the compensation stack runs
 * on the way out, leaving the form exactly as it was so that a cancel caused by
 * a typo costs one edit rather than a refill.
 * @param {any} conversation - The conversation being set up.
 */
export function cancelSetupProvision(conversation) {
  const record = recordFor(conversation);
  record.controller?.abort();
}

/**
 * What taking it back will take away, in the words of whoever built it.
 *
 * Undo runs the provision's compensation stack, which for every provider so far
 * means removing what it made — so the sentence to show is the one that provider
 * has already written for its `discard` ending, rather than a second account of
 * the same act maintained here and free to drift from it. "Undo" on its own
 * reads as unbinding the conversation, and what it does is `rm -rf` a directory:
 * the gap between those two is what this closes.
 *
 * A provider offering no discard gets no sentence rather than a guessed one.
 * @param {any} conversation - The conversation whose setup can still be undone.
 * @returns {string} The sentence, or '' when there is nobody to ask.
 */
export function setupUndoDetail(conversation) {
  const session = conversation?.session;
  const workspace = session?.getWorkspace?.(conversation?.workspaceId || '');
  if (!workspace) return '';
  const { options } = workspaceFinishOptions(session, workspace);
  return options.find(option => option.id === 'discard')?.description ?? '';
}

/**
 * Take back a workspace that was made a moment ago.
 *
 * The same compensation stack the cancel would have run, plus the binding and
 * everything committing added to the document. What it deliberately does not
 * touch is anything the user put there themselves: only the items this commit
 * added are removed.
 *
 * In-memory closures, so this dies with the tab. After a reload the durable
 * equivalent is the workspace's own finish menu.
 * @param {any} conversation - The conversation being set up.
 * @returns {Promise<void>} When it is as it was.
 */
export async function undoSetup(conversation) {
  const record = recordFor(conversation);
  if (!record.undoable || !record.undo) return;

  const undo = record.undo;
  record.undo = null;
  record.undoable = false;
  try {
    // An undo that could not take everything back leaves the panel saying so,
    // in the same place a failed Create says why: pressing Undo and being shown
    // nothing reads as a tree that is gone when it is still there.
    record.error = await undo();
  } finally {
    const thread = conversation.rootMessageThread;
    for (const id of record.seededItemIds) {
      try {
        thread?.removeContextItem(id);
      } catch {
        // An item already gone is an item that does not need removing.
      }
    }
    record.seededItemIds = [];
    record.workspaceId = '';
    conversation.workspaceId = '';
    conversation.initialised = false;
    record.phase = 'choosing';
    // The seeds still describe the tree that has just been taken back, and the
    // row the panel returns to is the row that would have built it — so they are
    // rebuilt from what that row is made from, which is where they came from
    // before Create was pressed.
    scheduleSeedRebuild(conversation, record);
    notify(conversation.id);
  }
}

/**
 * Close the undo window.
 *
 * It has exactly the lifetime the panel would have had — from the bind until
 * the conversation has content — so that one rule covers both: *you can change
 * your mind until you have said something*.
 * @param {any} conversation - The conversation that now has content.
 */
export function endSetupUndoWindow(conversation) {
  const record = records.get(conversation?.id ?? '');
  if (!record || !record.undoable) return;
  record.undo = null;
  record.undoable = false;
  record.seededItemIds = [];
  notify(conversation.id);
}

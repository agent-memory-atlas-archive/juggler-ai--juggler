//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Moving a conversation that has already started to another workspace.
 *
 * The binding itself is one write to the conversation's metadata, and almost
 * everything follows it for free: an operation travels by workspace id and the
 * server resolves it per call, so the tools, the allowed roots, the prompt's
 * environment block and the git surfaces are all looking at the new tree the
 * moment the write lands.
 *
 * What does not follow is whatever was read out of a tree and written into the
 * conversation at the time — the assistant files it was seeded with are frozen
 * snapshots, and a conversation moved to another tree would go on showing the
 * model the instructions of the tree it left. Deferring initialisation exists to
 * stop a conversation being seeded from the wrong tree; a move is the one thing
 * that can put it back into that state.
 *
 * So the write and the catch-up live in one function, and callers move a
 * conversation by calling it rather than by assigning the id. Doing half of this
 * is not a mistake a caller should be able to make.
 * @module services/workspace-rebinding
 */

import api from './api.js';
import { createBoundOps } from '../../sdk/ops.js';
import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { workspaceStatus } from './workspace-provisioning.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/**
 * Where work waits while it crosses from one tree to another, under the project
 * because the project is the one place every workspace's operations can reach.
 */
const CARRY_REL = '.juggler/carry';

/**
 * A path under a root, written the way the root is written.
 *
 * Absolute, because the two ends of a carry are in different trees and one of
 * them has to be named from outside its own. In the root's own separator,
 * because on Windows a root is `C:\src\app` and a path built with the other
 * separator is a second spelling of a directory this has to be certain about.
 * @param {string} root - An absolute path.
 * @param {string} relative - Something below it, forward-slashed.
 * @returns {string} The absolute result.
 */
function under(root, relative) {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[/\\]+$/, '')}${separator}${relative.split('/').join(separator)}`;
}

/**
 * A few paths, named, with the rest counted.
 *
 * Every name would be a paragraph, and after the fifth none of them would be
 * the one being looked for.
 * @param {string[]} paths - What to name.
 * @returns {string} A readable list.
 */
function namedFiles(paths) {
  const shown = paths.slice(0, 3);
  const rest = paths.length - shown.length;
  if (!rest) return `${shown.join(', ')} ${paths.length === 1 ? 'was' : 'were'}`;
  return `${shown.join(', ')} and ${rest} more were`;
}

/**
 * Whether a path is ours rather than the user's.
 *
 * Asked of every list of work, whoever enumerated it: what is under `.juggler`
 * is the app's, the tree being moved to has its own, and neither is anybody's
 * work to carry.
 * @param {string} path - A path relative to a workspace root.
 * @returns {boolean} Whether to leave it out.
 */
function isOurs(path) {
  return path === '.juggler' || path.startsWith('.juggler/');
}

/**
 * What a workspace's own provider says it is holding, where it has a view.
 *
 * `null` means no view, which is the base class's answer and sends the caller
 * to git: no row, no provider, a provider with no opinion, or one that threw
 * while forming it. Every one of those is a question this cannot answer rather
 * than an answer of "nothing", which is the distinction the whole hook turns on
 * — a tree read as clean because nobody could say otherwise is how uncommitted
 * work gets written over.
 *
 * The context is the one {@link workspaceStatus} builds, for the same reason:
 * this is the same question asked in more detail, and a provider answering both
 * must not have to ask which hook it is in.
 * @param {any} session - The session the workspace belongs to.
 * @param {string} workspaceId - The tree to ask about; '' is the project, which has no provider.
 * @param {AbortSignal} [signal] - Abandons the question.
 * @returns {Promise<{complete: boolean, paths: string[], removed: string[]}|null>} What it holds, or null for no view.
 */
async function providerHeldWork(session, workspaceId, signal) {
  const workspace = workspaceId ? session?.getWorkspace?.(workspaceId) : null;
  if (!workspace) return null;
  const provider = workspaceProviderRegistry.createProvider(workspace.providerId ?? '', session);
  if (!provider) return null;

  /** @type {any} */
  let held = null;
  try {
    held = await provider.heldWork(workspace, {
      session,
      ops: createBoundOps(() => ({ workspaceId: workspace.id })),
      // A provider's own record of what a workspace holds may live beside the
      // workspace rather than inside it — a sandbox's snapshot is a sibling of
      // the copy, outside what the copy's own operations may reach.
      baseOps: createBoundOps(() => ({ workspaceId: workspace.baseWorkspaceId ?? '' })),
      baseWorkspaceId: workspace.baseWorkspaceId ?? '',
      signal: signal ?? new AbortController().signal,
      rollback: { push: () => {} },
      checkpoint: async () => {},
      progress: () => {}
    });
  } catch {
    return null;
  }
  if (!held) return null;

  const named = (/** @type {any[]} */ list) => list
    .map((/** @type {any} */ path) => String(path ?? ''))
    .filter((/** @type {string} */ path) => path && !isOurs(path));
  return {
    complete: held.complete === true,
    paths: named(held.paths ?? []),
    removed: named(held.removed ?? [])
  };
}

/**
 * What git makes of a tree: whether it holds work, and whether it can say which
 * files.
 *
 * Everything it cannot answer reads as clean and unlistable: a root that is not
 * a repository, a project with no git, a tree that has gone. A warning is a
 * thing to say before a move, and one invented out of an error is worse than
 * silence.
 *
 * Repositories are discovered by walking DOWN for a `.git` entry, so a tree
 * holding none — a scratch copy, say — answers `listable: false` rather than
 * being handed the status of some repository above it.
 * @param {string} workspaceId - The tree to ask about; '' is the project.
 * @param {AbortSignal} [signal] - Abandons the question.
 * @returns {Promise<{dirty: boolean, listable: boolean, files: number}>} What git can see.
 */
async function gitHoldsWork(workspaceId, signal) {
  try {
    const answer = await api.getGitStatus(workspaceId, { signal });
    const repos = answer?.repos ?? [];
    const files = repos.reduce((/** @type {number} */ total, /** @type {any} */ repo) => {
      const ours = (repo?.files ?? [])
        .filter((/** @type {any} */ file) => isOurs(String(file?.path ?? ''))).length;
      return total + Math.max(0, (repo?.total ?? 0) - ours);
    }, 0);
    return { dirty: files > 0, listable: repos.length > 0, files };
  } catch {
    return { dirty: false, listable: false, files: 0 };
  }
}

/**
 * What the tree a conversation is leaving still holds, and what can be done
 * about it.
 *
 * Two different questions, and the PROVIDER is asked both of them first.
 * Whether there is work here at all is its to answer, because what counts as
 * work held is its to decide: a scratch-copy sandbox's unapplied edits are no
 * business of git's, and git would call that tree clean. Whether that work can
 * be listed file by file — and so carried — is its too, wherever it can
 * enumerate what it holds.
 *
 * Git answers for everywhere else, which is most places: a worktree, the
 * project, a row whose extension is gone. It is the fallback rather than the
 * authority because it can only see what is in a repository, and a workspace is
 * not obliged to be one.
 *
 * So a tree may still hold work that cannot be listed by either — and that is
 * not a gap to be papered over: the move says what it is leaving and offers
 * nothing. The sentence never promises the move will bring anything.
 * @param {any} session - The session the workspace belongs to.
 * @param {string} workspaceId - Where the conversation works now; '' is the project.
 * @param {AbortSignal} [signal] - Abandons the question.
 * @returns {Promise<{dirty: boolean, listable: boolean, files: number, where: string, warning: string}>} What is held there, and what to say.
 */
export async function workspaceHeldWork(session, workspaceId, signal) {
  const workspace = workspaceId ? session?.getWorkspace?.(workspaceId) : null;
  const mine = await providerHeldWork(session, workspaceId, signal);
  const git = mine ? null : await gitHoldsWork(workspaceId || '', signal);

  let dirty = git?.dirty === true;
  let unknown = false;
  if (workspace) {
    const status = await workspaceStatus(session, workspace, signal);
    // A provider that fell over has said nothing about the tree, and nothing is
    // not "empty". It is the one answer here that must read as work held: what
    // that tree holds is unlisted, and writing over unlisted work is the one
    // thing in a move that nothing can undo.
    if (status?.statusFailed) {
      dirty = true;
      unknown = true;
    } else if (!status?.providerMissing) {
      dirty = status?.dirty === true;
    }
  }

  const where = workspace?.label || workspace?.root || 'The project';
  let warning = '';
  if (dirty) {
    warning = unknown
      ? `${where} could not be asked what it holds. Whatever is there stays there.`
      : `${where} holds uncommitted work, which stays there.`;
  }
  return {
    dirty,
    listable: mine ? mine.complete : git?.listable === true,
    files: mine ? mine.paths.length + mine.removed.length : git?.files ?? 0,
    where,
    warning
  };
}

/**
 * Every file of uncommitted work in a tree, named relative to its root.
 *
 * The workspace's own provider first, where it has a view of what it holds;
 * git for everywhere else. An incomplete answer from either carries nothing at
 * all — `complete: false` is a tree whose work could not be accounted for, and
 * copying part of it would leave the rest behind and report that it had brought
 * everything.
 *
 * Git is asked through the review manifest rather than the status card, because
 * those two endpoints answer different questions: the card is a summary that
 * stops counting when it gets expensive, and this is the one asked in earnest.
 * Paths are joined onto their repository's, since a root may hold several and
 * each names its files relative to itself.
 * @param {any} session - The session the workspace belongs to.
 * @param {string} workspaceId - The tree to list; '' is the project.
 * @param {AbortSignal} [signal] - Abandons the question.
 * @returns {Promise<{complete: boolean, paths: string[], removed: string[]}>} What is there to carry.
 */
export async function workspaceWorkList(session, workspaceId, signal) {
  const nothing = { complete: false, paths: [], removed: [] };

  const mine = await providerHeldWork(session, workspaceId, signal);
  if (mine) return mine.complete ? mine : nothing;

  /** @type {any} */
  let manifest;
  try {
    manifest = await api.getGitReview({ workspaceId: workspaceId || '', signal });
  } catch {
    return nothing;
  }
  const repos = manifest?.repos ?? [];
  if (manifest?.complete !== true || repos.some((/** @type {any} */ repo) => repo?.complete !== true)) {
    return nothing;
  }

  /** @type {string[]} */
  const paths = [];
  /** @type {string[]} */
  const removed = [];
  for (const repo of repos) {
    const base = String(repo?.path ?? '');
    const within = (/** @type {string} */ path) => (base ? `${base}/${path}` : path);
    for (const file of repo?.files ?? []) {
      const path = String(file?.path ?? '');
      if (!path || isOurs(path)) continue;
      // What the tree looks like now is what gets carried: a file deleted here
      // is deleted there, and a rename is the new name arriving and the old one
      // going, which is what git says it is.
      if (String(file?.worktree ?? '') === 'D') removed.push(within(path));
      else paths.push(within(path));
      const old = String(file?.oldPath ?? '');
      if (old) removed.push(within(old));
    }
  }
  return { complete: true, paths, removed };
}

/**
 * Copy the uncommitted work of one tree into another.
 *
 * Everything goes through a staging directory in the project, and that is the
 * whole shape of it. A tree copy has to have both of its ends inside one
 * operations scope, and two workspaces never are: a scope is rooted at its own
 * workspace and widened only by the project, so a worktree and its sibling
 * cannot see each other in either direction. The project is the one place every
 * scope can reach, so the work goes out through it and back in, and there is one
 * path through here rather than one per pair of places.
 *
 * It copies and never moves. The work stays in the tree that holds it: taking
 * uncommitted work away from where it was made is the one mistake here that
 * nothing can undo, and leaving a second copy behind costs a tidy-up the user
 * can do deliberately.
 *
 * There is no signal. The whole of it is one copy of the files someone has
 * changed since their last commit, and the only thing an abort could achieve is
 * the half-applied tree the all-or-nothing rule below exists to prevent.
 * @param {any} session - The session both trees belong to.
 * @param {{fromId: string, toId: string, paths?: string[], removed?: string[], overwrite?: boolean}} request - Where from, where to, and what.
 * @returns {Promise<{done: boolean, carried?: number, conflicts?: string[], message?: string}>} Whether it landed, and what stopped it.
 */
export async function carryWorkspaceWork(session, request) {
  const paths = request?.paths ?? [];
  const removed = request?.removed ?? [];
  if (!paths.length && !removed.length) return { done: true, carried: 0 };

  const project = String(session?.projectPath ?? '');
  if (!project) {
    return { done: false, message: `Couldn't bring the work: there is no project to bring it through.` };
  }

  const fromOps = createBoundOps(() => ({ workspaceId: request.fromId || '' }));
  const toOps = createBoundOps(() => ({ workspaceId: request.toId || '' }));
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const stagingRel = `${CARRY_REL}/${stamp}`;
  const staging = under(project, stagingRel);

  try {
    await fromOps.copyTree({ from: '.', to: staging, paths });

    if (request.overwrite !== true) {
      const refusal = await carryRefusal(session, toOps, staging, request.toId || '', [...paths, ...removed]);
      if (refusal) return refusal;
    }

    await toOps.copyTree({ from: staging, to: '.', paths, delete: removed });
    return { done: true, carried: paths.length + removed.length };
  } catch (error) {
    // Every other way a carry stops is a sentence, returned for the dialog to
    // put on the screen and leave the choice up to be made again. A rejection is
    // not a sentence — it leaves that dialog exactly as it was, with nothing
    // moved and nothing said — so a copy that threw becomes a sentence too, and
    // keeps what threw it.
    return { done: false, message: `Couldn't bring the work: ${extractErrorMessage(error)}` };
  } finally {
    // Wherever this came out — landed, refused, or thrown through — the staging
    // goes with it. It is named per carry, so two windows carrying at once are
    // not clearing up after one another.
    await toOps.copyTree({ to: project, delete: [stagingRel] }).catch(() => {});
  }
}

/**
 * Whether the tree being moved into has work of its own that this would destroy.
 *
 * The rule is the sandbox's apply, for the same reason: three comparisons, and
 * a refusal of the WHOLE carry where they genuinely disagree. What the carry
 * would write, what the destination has done for itself, and — only where those
 * two overlap — whether the two trees still differ at all, because two people
 * who made the same edit are not arguing and a refusal that says they are
 * teaches the user that refusals mean nothing.
 *
 * What is worth refusing over is the destination's UNCOMMITTED work: everything
 * it has committed is git's to give back, and what it has not is nobody's. So a
 * destination whose work cannot be listed but is known to hold some is refused
 * rather than assumed clean — the one place in here where an unanswerable
 * question is not allowed to read as "nothing".
 * @param {any} session - The session both trees belong to.
 * @param {any} toOps - Operations pinned to the tree being moved into.
 * @param {string} staging - Where the work is waiting, absolute.
 * @param {string} toId - The destination workspace's id; '' is the project.
 * @param {string[]} touched - Everything this carry would write or remove.
 * @returns {Promise<{done: boolean, conflicts: string[], message: string}|null>} A refusal, or null to go ahead.
 */
async function carryRefusal(session, toOps, staging, toId, touched) {
  const held = await workspaceHeldWork(session, toId);
  if (!held.dirty) return null;

  const theirs = await workspaceWorkList(session, toId);
  if (!theirs.complete) {
    return {
      done: false,
      conflicts: [],
      message: `Couldn't bring the work: what ${held.where} already holds could not be listed, so nothing was copied.`
    };
  }

  const moved = new Set([...theirs.paths, ...theirs.removed]);
  const contested = touched.filter(path => moved.has(path));
  if (!contested.length) return null;

  // Only now, and only over the files in question: the common ending is the one
  // where the two trees have been working on different things.
  const difference = await toOps.compareTrees(
    { left: staging, right: '.', paths: contested, exact: true });
  const differ = new Set([
    ...(difference?.changed ?? []), ...(difference?.added ?? []), ...(difference?.removed ?? [])
  ]);
  const conflicts = contested.filter(path => differ.has(path));
  if (!conflicts.length) return null;

  return {
    done: false,
    conflicts,
    message: `Couldn't bring the work: ${namedFiles(conflicts)} changed in both trees. Nothing was copied.`
  };
}

/**
 * Move a conversation to another workspace.
 *
 * Refused while the conversation has a turn in flight, for the reason finishing
 * with a workspace is: the running turn's next operation would land in a tree it
 * never agreed to work in. Refused, too, for a target that cannot be worked in —
 * moving a conversation from one unusable place to another is not a way out.
 *
 * Bringing the tree's uncommitted work along is part of the move rather than
 * something a caller does around it, and it happens AFTER those refusals and
 * BEFORE the binding is written. Both halves matter: a caller that could copy
 * files and then be told the move is refused would have written into a tree
 * nobody moved to, and a move that landed before its work was refused would be
 * a conversation somewhere new without the thing it asked to bring.
 * @param {any} conversation - The conversation to move.
 * @param {string} workspaceId - Where it works now; '' is the project.
 * @param {{carry?: {paths?: string[], removed?: string[], overwrite?: boolean}}} [options] - What to bring with it.
 * @returns {Promise<{done: boolean, message?: string, conflicts?: string[]}>} What happened, and why not.
 */
export async function rebindConversation(conversation, workspaceId, options = {}) {
  const session = conversation?.session;
  if (!session) {
    return { done: false, message: `Couldn't move the conversation: it has no session.` };
  }

  const target = workspaceId || '';
  if ((conversation.workspaceId || '') === target) return { done: true };

  if (conversation.isProcessing === true) {
    return { done: false, message: 'This conversation is in the middle of a turn.' };
  }

  if (target && !session.workspaceRoot(target)) {
    return { done: false, message: `Couldn't move the conversation: that workspace can't be worked in.` };
  }

  const carry = options?.carry;
  if (carry && ((carry.paths ?? []).length || (carry.removed ?? []).length)) {
    const brought = await carryWorkspaceWork(session, {
      fromId: conversation.workspaceId || '',
      toId: target,
      paths: carry.paths ?? [],
      removed: carry.removed ?? [],
      overwrite: carry.overwrite === true
    });
    if (!brought.done) {
      return { done: false, message: brought.message, conflicts: brought.conflicts };
    }
  }

  conversation.workspaceId = target;
  await refreshWorkspaceDerived(conversation);
  return { done: true };
}

/**
 * Bring what the conversation read out of its old tree up to date with the new
 * one.
 *
 * Two halves, in this order. First the items already here are told, and each
 * decides for itself what that means — a seeded file re-takes its snapshot from
 * the new tree. Then seeding adds the assistant files the new tree has and the
 * old one did not: it is idempotent and *reuses* an item that is already there,
 * data and snapshot intact, so it can only ever add. Refreshing first is what
 * keeps the two from overlapping, since an item seeded a moment ago has nothing
 * to catch up on.
 *
 * Both halves are best-effort. A move that reported failure because one file
 * could not be re-read would leave the conversation bound to the new tree
 * anyway — worse than a snapshot that is one file out of date and says so in
 * the panel.
 * @param {any} conversation - The conversation that has just moved.
 * @returns {Promise<void>} When everything that could catch up has.
 */
async function refreshWorkspaceDerived(conversation) {
  // Every thread, not just the root one. A conversation is bound as a whole and
  // most of what one reads is read inside a sub-thread, where a delegated task
  // opened the files — those items hold the old tree's bytes exactly as the
  // root's do. A compaction fold is skipped: its transcript is frozen and read
  // as inert data, so re-taking a snapshot inside one would edit history.
  for (const thread of conversation.getAllMessageThreads?.() ?? []) {
    if (thread?.container?.get?.('boundedCompaction') === true) continue;
    for (const item of thread.contextItems ?? []) {
      try {
        await item.onWorkspaceChanged?.();
      } catch (error) {
        // One item that cannot catch up must not stop the rest from trying —
        // but it is a snapshot of the wrong tree, so it is worth a line.
        console.warn('[Workspaces] a context item could not follow the move:', error);
      }
    }
  }

  try {
    await conversation.session.seedConversationAutoItems(conversation);
  } catch {
    // Best-effort, as it is at creation: the tree may be unreadable, and a
    // conversation with one assistant file missing still works.
  }
}

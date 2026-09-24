//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The host side of the workspace-provider contract: running a provider's
 * `provision()`, unwinding it when it does not finish, and answering for a
 * provider that is not there at all.
 *
 * This is the host half of the workspace-provider contract. A provider says what
 * to build and how to undo each step of it; everything else — registering the
 * row before the first command, holding the compensation stack, running it in
 * reverse, flipping the row to ready — belongs here, so that every provider
 * inherits one cancellation story instead of writing its own.
 *
 * It is deliberately headless. Cancel, failure part-way through, and Undo are
 * one mechanism and they are all testable without a single click; the setup
 * panel is a view onto this module rather than a second copy of it.
 * @module services/workspace-provisioning
 */

import { createBoundOps } from '../../sdk/ops.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { registerWorkspace, patchWorkspace, unregisterWorkspace, isWorkspaceUsable } from './workspaces.js';
import { rebindConversation } from './workspace-rebinding.js';

/**
 * @typedef {object} ProvisionRequest
 * @property {any} session - The session the workspace belongs to
 * @property {any} [conversation] - The conversation it is being made for
 * @property {string} providerId - Which registered provider builds it
 * @property {object} [values] - What its setup section collected
 * @property {string} [baseWorkspaceId] - What to build it relative to; '' is the project
 * @property {string} [label] - What to call the row before the provider names it
 * @property {AbortSignal} [signal] - Cancels the provision, for real
 * @property {(step: string, detail?: string) => void} [onProgress] - One line per step
 */

/**
 * @typedef {object} ProvisionOutcome
 * @property {import('../model/session.js').Workspace} workspace - The ready row
 * @property {() => Promise<string>} undo - Unwind it again, answering what it could not take back; see {@link provisionWorkspace}
 */

/**
 * What to say about a workspace whose provider is not loaded.
 *
 * Extensions get disabled, uninstalled, and broken, while the workspaces they
 * made stay on the table with conversations bound to them. Those conversations
 * keep working — `kind` and `root` are the session's, not the provider's — so
 * the absence must read as a missing *feature*, never as a missing place.
 * @type {string}
 */
export const PROVIDER_UNAVAILABLE = 'Provider unavailable';

/**
 * How a workspace is doing, asked of its provider when there is one.
 *
 * Without one it answers flagged rather than throwing or returning nothing: a
 * caller rendering a list of workspaces must be able to render this one too.
 * Naming it is not at stake either way — every surface takes the name off the
 * row — so what is missing here is a description and a state, never a title.
 * @param {any} session - The session the workspace belongs to.
 * @param {import('../model/session.js').Workspace} workspace - The row to report on.
 * @param {AbortSignal} [signal] - Cancels a speculative probe when the view closes.
 * @returns {Promise<import('../../sdk/workspace-provider.js').WorkspaceStatus & {providerMissing?: boolean, statusFailed?: boolean}>} What to show. A
 *   failure arrives as `problem`, never as `detail`.
 */
export async function workspaceStatus(session, workspace, signal) {
  const provider = workspaceProviderRegistry.createProvider(workspace.providerId ?? '', session);
  const fallback = { available: workspace.available !== false };
  if (!provider) {
    // Also a problem rather than a detail: with nobody to ask, there is nothing
    // to say about the place itself, and the row keeps its own description.
    return { ...fallback, problem: PROVIDER_UNAVAILABLE, providerMissing: true };
  }
  try {
    return await provider.status(workspace, {
      session,
      ops: createBoundOps(() => ({ workspaceId: workspace.id })),
      baseOps: createBoundOps(() => ({ workspaceId: workspace.baseWorkspaceId ?? '' })),
      baseWorkspaceId: workspace.baseWorkspaceId ?? '',
      signal: signal ?? new AbortController().signal,
      rollback: { push: () => {} },
      checkpoint: async () => {},
      progress: () => {}
    });
  } catch (error) {
    // A provider that throws while merely reporting must not take the row's
    // description off the screen with it. The reason goes in `problem`, which
    // is the field for it: "nothing in this tree" and "nobody could say" are
    // different answers, and a surface that printed the second where it prints
    // the first would be describing our failure to somebody choosing where to
    // work.
    return { ...fallback, problem: extractErrorMessage(error), statusFailed: true };
  }
}

/**
 * The ways this workspace can be finished with, and why there are none.
 *
 * The reason is returned rather than the list simply being empty, because
 * "this provider offers no endings" and "the extension that knew how to end
 * this is gone" are different things to tell someone.
 * @param {any} session - The session the workspace belongs to.
 * @param {import('../model/session.js').Workspace} workspace - The row being finished with.
 * @returns {{options: import('../../sdk/workspace-provider.js').FinishOption[], unavailableReason?: string}} What can be done.
 */
export function workspaceFinishOptions(session, workspace) {
  const provider = workspaceProviderRegistry.createProvider(workspace.providerId ?? '', session);
  if (!provider) {
    return { options: [], unavailableReason: PROVIDER_UNAVAILABLE };
  }
  return { options: provider.finishOptions(workspace) };
}

/**
 * Which other directories hold instructions that apply in a workspace.
 *
 * Asked of the provider because only it knows what the place was made from: the
 * project sits above a folder of it and above a worktree of one of its
 * subrepos, but it sits nowhere near a worktree of the project itself, and no
 * amount of walking up a path tells the three apart. Widest first, so the
 * workspace's own files are seeded last and read closest.
 *
 * A missing or throwing provider answers with none. Losing an extension must
 * cost a conversation some of its instructions, never its ability to be seeded
 * at all — the same degradation contract the rest of this file keeps.
 * @param {any} session - The session the workspace belongs to.
 * @param {import('../model/session.js').Workspace|null} [workspace] - The row about to be seeded for.
 * @returns {string[]} Absolute directories, widest first.
 */
export function workspaceInstructionRoots(session, workspace) {
  if (!workspace) return [];
  const provider = workspaceProviderRegistry.createProvider(workspace.providerId ?? '', session);
  if (!provider) return [];
  try {
    return provider.instructionRoots(workspace, {
      session,
      ops: createBoundOps(() => ({ workspaceId: workspace.id })),
      baseOps: createBoundOps(() => ({ workspaceId: workspace.baseWorkspaceId ?? '' })),
      baseWorkspaceId: workspace.baseWorkspaceId ?? '',
      signal: new AbortController().signal,
      rollback: { push: () => {} },
      checkpoint: async () => {},
      progress: () => {}
    }).filter(root => typeof root === 'string' && root !== '');
  } catch {
    return [];
  }
}

/**
 * What kind of place a workspace is, in the words of whatever made it.
 *
 * The path says where the work happens and the status says how it is going;
 * neither says what the place *is*, and a directory beside your project with a
 * branch checked out in it is not self-explanatory. The provider's own name is
 * the answer — it is the name the user picked the thing by in the first place.
 * @param {any} session - The session the workspace belongs to.
 * @param {any} workspace - The row to describe.
 * @returns {string} The provider's name, or '' when it is not loaded.
 */
export function workspaceKind(session, workspace) {
  const provider = workspaceProviderRegistry.createProvider(workspace?.providerId ?? '', session);
  return provider?.getManifest?.()?.name ?? '';
}

/**
 * What that kind of place is for, in the words of whatever made it.
 *
 * A name is what the user picked the thing by, which makes it the right name
 * and a poor explanation: "Scratch Copy" over a directory path tells someone who
 * has already learnt the vocabulary what they are looking at, and tells everyone
 * else nothing. The sentence under it is the provider's own description — the
 * one it offered when the workspace was chosen — so the answer to "what is this
 * thing I have just clicked" is the same answer they were given when they made
 * it.
 * @param {any} session - The session the workspace belongs to.
 * @param {any} workspace - The row to describe.
 * @returns {string} The provider's description, or '' when it has none or is not loaded.
 */
export function workspaceKindNote(session, workspace) {
  const provider = workspaceProviderRegistry.createProvider(workspace?.providerId ?? '', session);
  return provider?.getManifest?.()?.description ?? '';
}

/**
 * The workspace whose panel is showing, if one is.
 *
 * Selection is held as an id and read back as a row, so it can go stale without
 * anyone having to tidy it: a workspace finished with while its own panel was
 * open leaves an id naming nothing, and this answers null for it. The strip
 * draws a box only for a workspace that can be worked in, and a selection has
 * to mean the box that is drawn — so the same test decides both, and a
 * workspace that closes under its panel simply stops being selected.
 * @param {any} session - The session holding the selection and the table.
 * @returns {any} The row, or null when nothing usable is selected.
 */
export function selectedWorkspace(session) {
  const selection = session?.selection;
  if (selection?.kind !== 'workspace') return null;
  const workspace = session?.getWorkspace?.(selection.id) ?? null;
  return workspace && isWorkspaceUsable(workspace) ? workspace : null;
}

/**
 * One workspace and the conversations working in it. A `null` workspace is a
 * run of conversations the tab bar draws flat, outside any box — and there can
 * be several, since a box has tabs above it and tabs below it.
 * @typedef {object} WorkspaceGroup
 * @property {import('../model/session.js').Workspace|null} workspace - The row they work in, or null for a run of unboxed conversations
 * @property {any[]} conversations - Its conversations, in tab-bar order
 */

/**
 * Where one box is drawn, as an index into the flat conversation order.
 *
 * The stored place is `'head'`, or the conversation the box sits behind. A
 * neighbour rather than a number, so it survives conversations being created and
 * binned elsewhere in the bar, and the server re-anchors it when that neighbour
 * itself goes (see `reanchorBoxesAt`).
 *
 * Empty is not a position. It is a row with no place recorded — one written
 * before boxes kept one, or one whose place stopped meaning anything — and it
 * falls back to the older reading of the bar, as does a place naming a
 * conversation this client does not hold (the server lists conversations a
 * viewer has not loaded, and a load can fail). The fallback is the box's first
 * member, and past everything when it has none.
 *
 * Reading an empty field as the head of the bar is the one thing this must not
 * do: every box would climb to the top of the sidebar the first time anything
 * about it was unknown.
 * @param {{workspace: any, conversations: any[]}} box - The box and the members it has been given.
 * @param {any[]} conversations - The flat order, for the length.
 * @param {Map<string, number>} indexOf - Each conversation's place in that order.
 * @returns {number} The index it is drawn at.
 */
function boxPlace(box, conversations, indexOf) {
  const place = box.workspace?.place;
  if (place === 'head') return 0;
  if (place && indexOf.has(place)) return /** @type {number} */ (indexOf.get(place)) + 1;
  if (box.conversations.length) return /** @type {number} */ (indexOf.get(box.conversations[0].id));
  return conversations.length;
}

/**
 * A session's conversations, grouped by the workspace they work in.
 *
 * There are two kinds of thing in the tab bar and each keeps its own place. A
 * conversation's is the flat order — Map insertion order, see
 * `Session#_setConversationOrder`. A box's is its workspace's `after` field, the
 * conversation it sits behind. Neither is derived from the other, which is the
 * whole point: a box placed by whichever conversation happened to be in it moved
 * whenever work started or finished there, and an empty box had nothing to be
 * placed by at all. A workspace is a place, not an event.
 *
 * So the tabs above a box stay above it and the tabs below stay below, and
 * starting or binning a conversation moves nothing but that conversation.
 * Grouping the unboxed ones together as a single run would make the bar a block
 * of boxes and a block of tabs, and which block came first would flip on
 * whichever was started last.
 *
 * A flat order holding two conversations of one workspace either side of a third
 * is grouped anyway: contiguity is a property of the layout, not a precondition
 * for it, and a box is drawn where its row says regardless of where its members
 * sit.
 *
 * Only a usable workspace gets a box. A conversation bound to one that is
 * closed, still being built, or gone is drawn flat with the project's own
 * conversations — its binding is the stranded banner's to explain, and a box
 * drawn for a place nobody can work in would be offering it.
 *
 * A usable workspace with nothing bound to it still gets its box, empty, and
 * holds the place its row names. That is the point of drawing workspaces at all:
 * a tree outlives the conversations that were started in it, and while it has no
 * conversation it has no other way of being seen or acted on.
 * @param {any} session - The session holding the conversations and the table.
 * @returns {WorkspaceGroup[]} Every usable workspace, and the runs of unboxed
 *   conversations between them, in the order they are drawn.
 */
export function workspaceGroups(session) {
  const conversations = [...(session?.conversations?.values?.() ?? [])];
  const usable = [...(session?.workspaces ?? [])].filter(workspace => isWorkspaceUsable(workspace));

  // Where each conversation sits in the flat order.
  /** @type {Map<string, number>} */
  const indexOf = new Map(conversations.map((conversation, index) => [conversation.id, index]));

  /**
   * Every entry to be placed: one per box, one per unboxed conversation.
   * `rank` breaks a tie between a box and the conversation it sits in front of,
   * which the two agree on: a box anchored to the conversation at index 2 wants
   * place 3, and so does the conversation at index 3.
   * @type {{workspace: any, conversations: any[], place: number, rank: number}[]}
   */
  const boxes = usable.map(workspace =>
    ({ workspace, conversations: /** @type {any[]} */ ([]), place: 0, rank: 0 }));
  /** @type {Map<string, {workspace: any, conversations: any[], place: number, rank: number}>} */
  const byId = new Map(boxes.map(box => [box.workspace.id, box]));

  /** @type {{workspace: any, conversations: any[], place: number, rank: number}[]} */
  const entries = [];
  conversations.forEach((conversation, index) => {
    const box = byId.get(conversation.workspaceId || '');
    if (!box) {
      entries.push({ workspace: null, conversations: [conversation], place: index, rank: 1 });
      return;
    }
    box.conversations.push(conversation);
  });

  // Placed once every box knows its members, so that the fallback below has
  // something to fall back to.
  for (const box of boxes) box.place = boxPlace(box, conversations, indexOf);
  entries.push(...boxes);

  // The only remaining ties are boxes sharing an anchor. The sort being stable,
  // and the boxes having been built in the table's order, that is the order
  // they keep.
  entries.sort((a, b) => a.place - b.place || a.rank - b.rank);

  // Unboxed conversations are placed one at a time and drawn in runs: the bar
  // lays a group of them flat, and two runs with nothing between them are one
  // run. The conversations of a box are its own and are never merged into.
  /** @type {WorkspaceGroup[]} */
  const groups = [];
  for (const { workspace, conversations: members } of entries) {
    const last = groups[groups.length - 1];
    if (!workspace && last && !last.workspace) {
      last.conversations.push(...members);
      continue;
    }
    groups.push({ workspace, conversations: members });
  }
  return groups;
}

/**
 * Where a conversation about to be created belongs in the flat order.
 *
 * A new conversation goes to the top of its *box*: in at the index its box's
 * first member already holds, so that it is the first tab in the box. Nothing
 * about this moves the box, which holds the place its own row names (see
 * {@link boxPlace}) whatever its members do.
 *
 * A box with nothing in it yet has no member to go in above, so its first
 * conversation goes where the box itself is drawn — which puts the tab under
 * the header it belongs to rather than at whichever end of the bar the flat
 * order happens to start or finish.
 *
 * A workspace nobody can work in has no box to go to the top of — its
 * conversations are drawn flat — so a conversation born into one goes where
 * every other unboxed conversation goes, which is the top.
 * @param {any} session - The session holding the conversations and the table.
 * @param {string} [workspaceId] - The workspace it will work in, if it is one.
 * @param {{ignore?: string}} [options] - `ignore` leaves a conversation out of the
 *   reckoning: the one being placed is in the map already on the path that
 *   adopts it before its worker has spawned, and it cannot be its own anchor.
 * @returns {number} The index to insert at.
 */
export function placeForNewConversation(session, workspaceId, { ignore = '' } = {}) {
  if (!workspaceId) return 0;
  const workspace = session?.getWorkspace?.(workspaceId)
    ?? [...(session?.workspaces ?? [])].find(row => row.id === workspaceId);
  if (!workspace || !isWorkspaceUsable(workspace)) return 0;

  const conversations = [...(session?.conversations?.values?.() ?? [])]
    .filter(conv => conv.id !== ignore);
  const first = conversations.findIndex(conv => (conv.workspaceId || '') === workspaceId);
  if (first !== -1) return first;

  const indexOf = new Map(conversations.map((conversation, index) => [conversation.id, index]));
  return boxPlace({ workspace, conversations: [] }, conversations, indexOf);
}

/**
 * The conversation a new one is to be created after, for the server to store.
 *
 * {@link placeForNewConversation}'s answer, said in terms the server can act on.
 * Placing the tab locally settles nothing on its own: the server keeps the
 * conversation order, broadcasts it on every create, and `refreshFromServer`
 * re-slots the map into what it sent — so an order the server decided for itself
 * is the one that survives the create, and the one the next launch reads back.
 *
 * An index would not survive the trip: the server's order counts conversations
 * this client has never loaded, and the client's counts none of them. So each
 * answer is named rather than counted. `head` and `end` are the two ends of the
 * bar, which need no id and mean the same thing to both sides. `after` names a
 * real neighbour — the tab above the box's first member, or the conversation the
 * box's own row is anchored to — which is an adjacency both sides agree on.
 *
 * The distinction matters most for a box with nothing in it. Saying "behind
 * whichever tab I happen to hold last" is not saying "the end": the server's
 * order runs past this client's, so the two answers are different positions, and
 * which one you get would depend on what this window had loaded.
 * @param {any} session - The session holding the conversations and the table.
 * @param {string} [workspaceId] - The workspace it will work in, if it is one.
 * @returns {{where: string, after: string}} `where` is 'head', 'after' or 'end';
 *   `after` names the conversation to sit behind, and is '' for the other two.
 */
export function placementForNewConversation(session, workspaceId) {
  const head = { where: 'head', after: '' };
  if (!workspaceId) return head;
  const workspace = session?.getWorkspace?.(workspaceId)
    ?? [...(session?.workspaces ?? [])].find(row => row.id === workspaceId);
  if (!workspace || !isWorkspaceUsable(workspace)) return head;

  // Into a box that has conversations in it: above the first of them, which is
  // to say behind whatever that one sits behind.
  const conversations = [...(session?.conversations?.values?.() ?? [])];
  const first = conversations.findIndex(conv => (conv.workspaceId || '') === workspaceId);
  if (first === 0) return head;
  if (first > 0) return { where: 'after', after: conversations[first - 1].id };

  // Into an empty box: where the box itself is. A row that records a place says
  // it outright; one that does not is drawn past everything, and that is where
  // its first conversation goes too.
  const place = workspace.place;
  if (place === 'head') return head;
  if (place && conversations.some(conv => conv.id === place)) return { where: 'after', after: place };
  return { where: 'end', after: '' };
}

/**
 * What to put in front of someone before a workspace is finished with.
 *
 * Nobody owns a workspace — any bound conversation may end it — so this warning
 * is the entire coordination story, and it has two halves. The peers are told
 * about: several conversations working in one tree is a legitimate thing to be
 * doing, and the only wrong thing about it is not knowing. A turn in flight is
 * refused outright, because removing a tree under a running agent is the one
 * case here that loses work rather than merely surprising someone.
 * @typedef {object} FinishWarning
 * @property {string[]} peers - The other conversations bound to it, by name
 * @property {string[]} busy - Bound conversations with a turn in flight, by name
 * @property {string} refusal - Why this cannot be done at all right now, or ''
 * @property {string} warning - What to know before agreeing to it, or ''
 */

/**
 * The names of every conversation bound to a workspace, and which of them are
 * in the middle of a turn.
 * @param {any} session - The session holding the conversations.
 * @param {string} workspaceId - The workspace they would be bound to.
 * @returns {{name: string, busy: boolean, isSelf: boolean}[]} One entry per bound conversation.
 * @param {any} [self] - The conversation doing the finishing, which is not a peer of itself.
 */
function boundConversations(session, workspaceId, self) {
  /** @type {{name: string, busy: boolean, isSelf: boolean}[]} */
  const bound = [];
  for (const conversation of session?.conversations?.values?.() ?? []) {
    if (conversation.workspaceId !== workspaceId) continue;
    bound.push({
      name: conversation.name || conversation.id,
      busy: conversation.isProcessing === true,
      isSelf: conversation === self
    });
  }
  return bound;
}

/**
 * Names, written the way a sentence says them rather than the way an array
 * prints: "A", "A and B", "A, B and C".
 * @param {string[]} names - The names, in the order they were found.
 * @returns {string} The list, for reading aloud.
 */
function nameList(names) {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * See {@link FinishWarning}.
 * @param {any} session - The session the workspace belongs to.
 * @param {any} workspace - The row being finished with.
 * @param {{conversation?: any, action?: any, status?: any}} [options] - Who is
 *   asking, which ending they picked, and what the workspace last said about
 *   itself — the dirty flag is what makes a destructive ending worth a sentence.
 * @returns {FinishWarning} What to say, and whether to say no.
 */
export function workspaceFinishWarning(session, workspace, options = {}) {
  const { conversation, action, status } = options;
  const bound = boundConversations(session, workspace?.id ?? '', conversation);
  const peers = bound.filter(entry => !entry.isSelf).map(entry => entry.name);
  const busy = bound.filter(entry => entry.busy).map(entry => entry.name);

  const parts = [];
  if (peers.length) {
    // A sentence about the people, not a tail on a sentence about the tree: this
    // is read at the moment someone is about to take the tree away from them, so
    // it leads with who they are.
    //
    // "Too" needs somebody to be additional to. Asked by a conversation, that is
    // the reader; asked of the workspace itself — from its own box, where nobody
    // is finishing with it on their own behalf — there is no self to leave out,
    // and the sentence names everyone working here instead of implying the
    // reader is one of them.
    const being = peers.length === 1 ? 'is' : 'are';
    parts.push(conversation
      ? `${nameList(peers)} ${being} working here too.`
      : `${nameList(peers)} ${being} working here.`);
  }
  if (action?.danger && status?.dirty) {
    parts.push('This workspace holds uncommitted work, which goes with it.');
  }

  return {
    peers,
    busy,
    refusal: busy.length
      ? `${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} in the middle of a turn.`
      : '',
    // A line each: these are separate facts about the tree, and two of them in
    // one paragraph read as one muddled sentence.
    warning: parts.join('\n')
  };
}

/**
 * Which conversation an ending is being carried out for, when it was asked for
 * of the workspace itself rather than by one of them.
 *
 * A provider is handed this as `ctx.conversation`, and what it is for is the
 * ending that hands work back to the agent: git-worktree's commit offers "Let
 * this conversation write it", which sends a message to whoever is named here.
 * Asked from a box there may be three candidates or none, so the rule has to be
 * one a user can predict without being told it:
 *
 * > the conversation you are looking at, if it works here; otherwise the only
 * > one working here, if there is only one; otherwise nobody.
 *
 * Nobody is a legitimate answer, not a failure — the field is optional in the
 * contract (see `sdk/workspace-provider.js`) and every provider degrades to
 * doing the thing itself. What it must never do is pick one of three arbitrarily
 * and send that conversation a message its user did not ask for.
 * @param {any} session - The session the workspace belongs to.
 * @param {any} workspace - The row being finished with.
 * @returns {any} The conversation to carry it out for, or null.
 */
export function workspaceFinishActor(session, workspace) {
  const id = workspace?.id ?? '';
  if (!id) return null;

  // The conversation behind the panel, not the one on screen: finishing with a
  // workspace is nearly always done from its own panel, and by then there is no
  // visible conversation to be the actor.
  const current = session?.conversations?.get?.(session?.loadedConversationId ?? '');
  if (current && (current.workspaceId || '') === id) return current;

  const bound = [];
  for (const conversation of session?.conversations?.values?.() ?? []) {
    if ((conversation.workspaceId || '') === id) bound.push(conversation);
  }
  return bound.length === 1 ? bound[0] : null;
}

/**
 * Carry out one of a workspace's endings, and tombstone it if that ended it.
 *
 * The refusal is checked here rather than only in the dialog that asked: a
 * service whose safety lives in its caller has no safety. What the provider does
 * is its own — unbind touches nothing, discard removes the tree — and what
 * happens to the row afterwards is the host's: `done` tombstones it, which keeps
 * the id resolving to an attributable reason instead of turning every bound
 * conversation's next operation into an unknown-workspace error, and sends the
 * conversation that asked back to the project.
 *
 * `closedBy` rides in `meta` beside the provider's own keys (the patch merges
 * key by key) so the peers' banner can name who closed it.
 * @param {{session: any, workspace: any, conversation?: any, actionId: string,
 *   input?: object, signal?: AbortSignal}} request - What to do, and for whom.
 * @returns {Promise<{done: boolean, message?: string, workspace?: any}>} What happened.
 */
export async function finishWorkspace(request) {
  const { session, workspace, conversation, actionId, input, signal } = request;

  const provider = workspaceProviderRegistry.createProvider(workspace?.providerId ?? '', session);
  if (!provider) return { done: false, message: PROVIDER_UNAVAILABLE };

  const { refusal } = workspaceFinishWarning(session, workspace, { conversation });
  if (refusal) return { done: false, message: refusal };

  const result = await provider.finish(workspace, actionId, {
    session,
    conversation,
    ops: createBoundOps(() => ({ workspaceId: workspace.id })),
    // An ending that lands work writes into the tree the workspace came from,
    // which its own operations cannot reach: they are rooted at the workspace,
    // and a path outside that root is refused rather than sanitised.
    baseOps: createBoundOps(() => ({ workspaceId: workspace.baseWorkspaceId ?? '' })),
    baseWorkspaceId: workspace.baseWorkspaceId ?? '',
    input: input ?? {},
    signal: signal ?? new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  });

  if (!result?.done) return { done: false, message: result?.message };

  // Everyone who was working here goes back to the project, before the row is
  // tombstoned so that nobody watches their own workspace close under them.
  // Left bound, a conversation points at a workspace that no longer exists
  // while its composer still looks ready — nothing refuses the send, and the
  // turn dies in the server with "workspace X was closed".
  //
  // All of them, not just whoever pressed the button: the tree is gone for
  // everyone working in it, and which of them asked is not a difference the
  // tree has. It is not always even a question with an answer — an ending taken
  // on the workspace's own box, where several conversations share it, is
  // pressed by nobody in particular (see {@link workspaceFinishActor}).
  /** @type {string[]} */
  const stuck = [];
  let sent = 0;
  for (const bound of [...(session?.conversations?.values?.() ?? [])]) {
    if ((bound.workspaceId || '') !== workspace.id) continue;
    const moved = await rebindConversation(bound, '');
    if (moved.done) sent++;
    else stuck.push(`${bound.name || bound.id}: ${moved.message}`);
  }
  // Said by the host because it is the host that does it, and because how many
  // there were is not something a provider is in a position to know. The
  // provider's own message says what became of the tree, which is its half.
  const rehomed = sent === 0
    ? ''
    : `${sent === 1 ? 'Its conversation is' : `Its ${sent} conversations are`} back in the project folder.`;

  const closed = await patchWorkspace(workspace.id, {
    state: 'closed',
    // Who closed it, for the banner a conversation that was not here to be
    // moved — binned, or in a window that had not loaded it — will meet when it
    // comes back. Empty when it was the box that was acted on rather than a
    // conversation, which `strandedLead` reads as the sentence without a name.
    meta: { closedBy: conversation?.name || conversation?.id || '' }
  });
  // A move that could not be made is said rather than swallowed: the workspace
  // is finished with either way, and the difference is whether a conversation
  // still has somewhere to work.
  return {
    done: true,
    message: [result.message, rehomed, ...stuck].filter(Boolean).join(' '),
    workspace: closed
  };
}

/**
 * Run every compensation, latest first.
 *
 * Each is attempted even when an earlier one throws. A compensation that fails
 * is a step that could not be undone, which is worth knowing about, but it must
 * not strand the steps beneath it — those are the ones that made the mess the
 * user can see.
 * @param {Array<() => Promise<void>|void>} compensations - The stack, oldest first
 * @returns {Promise<Error[]>} Whatever went wrong on the way back down
 */
async function unwind(compensations) {
  /** @type {Error[]} */
  const failures = [];
  for (const compensation of [...compensations].reverse()) {
    try {
      await compensation();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(extractErrorMessage(error)));
    }
  }
  compensations.length = 0;
  return failures;
}

/**
 * What a compensation stack could not take back, as one sentence.
 *
 * Empty when it took everything back, which is the ordinary case and says
 * nothing. The underlying reasons are kept verbatim: they name the tree, the
 * branch or the permission, and nothing here can say it better.
 * @param {Error[]} failures - Compensations that themselves failed
 * @returns {string} What to add to whatever is already being said
 */
function leftBehindSentence(failures) {
  if (!failures.length) return '';
  return `Couldn't undo all of it: ${failures.map(failure => extractErrorMessage(failure)).join('; ')}`;
}

/**
 * What a failed provision could not take back, from the error it threw.
 *
 * Carried on the error rather than folded into its message so that a cancel can
 * use it too: a cancel is told apart by its signal and says nothing on screen,
 * and "nothing on screen" must still not swallow a tree that is still there.
 * @param {any} error - What `provisionWorkspace` threw
 * @returns {string} The sentence, or '' when it undid everything
 */
export function provisionLeftBehind(error) {
  return typeof error?.leftBehind === 'string' ? error.leftBehind : '';
}

/**
 * Write what a provider has just said into the list a view is reading.
 *
 * One line per step, and a step that goes on talking keeps the line it already
 * has: a provision's slow step is slow enough to have something new to say every
 * second — a percentage, a file, a submodule — and appending each would bury the
 * step itself under its own commentary. So the latest thing said about a step
 * replaces the last, and only a step that has actually changed starts a line.
 *
 * Same name, but later: that is a second visit, not the first continuing, and it
 * gets a line of its own. The list is what happened, in order.
 * @param {{step: string, detail?: string}[]} lines - The progress so far; appended to in place.
 * @param {string} step - What is being waited on.
 * @param {string} [detail] - The latest thing known about it.
 * @returns {{step: string, detail?: string}[]} The same list, for chaining.
 */
export function recordProgress(lines, step, detail = '') {
  const last = lines[lines.length - 1];
  if (last && last.step === step) {
    last.detail = detail;
    return lines;
  }
  lines.push({ step, detail });
  return lines;
}

/**
 * Build a workspace with a provider, and leave nothing behind if it does not
 * finish.
 *
 * The order is the whole point. The row is registered in `provisioning` state
 * **before** any command runs, so an interrupted provision leaves something the
 * app knows about rather than unrecorded debris on disk. The provider then
 * builds, checkpointing what it has done as it goes and pushing each step's
 * inverse onto a stack this function holds. Only when it returns does the row
 * take the real root and flip to `ready`.
 *
 * Anything other than that — a rejection, a failure, an abort, even an abort
 * that lands after `provision()` has returned but before the row is ready —
 * runs the stack in reverse and unregisters the row. The error is then
 * re-thrown: a caller must never be able to mistake a provision that was undone
 * for one that worked.
 *
 * The returned `undo` runs that same stack, for the window after success in
 * which a user may still say they picked the wrong thing. It is in-memory
 * closures and so dies with the tab; the durable equivalent is the provider's
 * `cleanupPartial`, driven from the checkpointed `meta`.
 * @param {ProvisionRequest} request - What to build, and where
 * @returns {Promise<ProvisionOutcome>} The ready workspace, and how to take it back
 */
export async function provisionWorkspace(request) {
  const {
    session,
    conversation,
    providerId,
    values = {},
    baseWorkspaceId = '',
    label,
    signal,
    onProgress
  } = request;

  const provider = workspaceProviderRegistry.createProvider(providerId, session);
  if (!provider) {
    throw new Error(`Couldn't provision a workspace: no provider "${providerId}" is loaded.`);
  }

  const effectiveSignal = signal ?? new AbortController().signal;
  effectiveSignal.throwIfAborted();

  // The base workspace decides two things: where the provider's commands run,
  // and what transport the new workspace inherits. Both come from the row rather
  // than from the provider, which is what lets a provider that knows nothing
  // about ssh build a worktree on another machine.
  const base = baseWorkspaceId ? session.getWorkspace(baseWorkspaceId) : null;
  const baseRoot = session.workspaceRoot(baseWorkspaceId);
  if (!baseRoot) {
    throw new Error(`Couldn't provision a workspace: its base workspace is not usable.`);
  }

  const row = await registerWorkspace({
    kind: base?.kind || 'local',
    root: provider.plannedRoot(values) || baseRoot,
    label: label || provider.getSetupLabel(),
    providerId,
    baseWorkspaceId,
    state: 'provisioning'
  });

  /** @type {Array<() => Promise<void>|void>} */
  const compensations = [];

  // Undoing is not cancelled by the thing it is undoing. A compensation is a
  // closure written during the provision, so the obvious line inside it —
  // `ctx.ops.shell(…, ctx.signal)` — would carry the signal that has just been
  // aborted, and every compensation would refuse to run at the exact moment it
  // was needed, silently, leaving on disk the mess it was written to clear up.
  // So `ctx.signal` answers differently once unwinding starts, and the obvious
  // line is the correct one in both phases.
  let unwinding = false;
  const unwindSignal = new AbortController().signal;

  /** @type {import('../../sdk/workspace-provider.js').ProviderContext} */
  const ctx = {
    session,
    conversation,
    // Pinned to the BASE workspace: `git worktree add` runs in the repository,
    // not in the tree it is about to create — which does not exist yet. This is
    // the one hook where `ops` and `baseOps` are the same operations, and they
    // are both offered so that a provider never has to ask which hook it is in.
    ops: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseOps: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseWorkspaceId,
    get signal() { return unwinding ? unwindSignal : effectiveSignal; },
    rollback: { push: (compensation) => { compensations.push(compensation); } },
    checkpoint: async (metaPatch) => { await patchWorkspace(row.id, { meta: metaPatch }); },
    progress: (step, detail) => { onProgress?.(step, detail); }
  };

  /**
   * Run the stack back down, with the signal switched over first.
   * @returns {Promise<Error[]>} Compensations that themselves failed
   */
  const unwindAll = async () => {
    unwinding = true;
    return unwind(compensations);
  };

  try {
    const result = await provider.provision(values, ctx);
    // A provision that completed while the user was cancelling is still
    // cancelled. Without this the abort would be silently outrun by a fast
    // provider, and the user would be left bound to a thing they stopped.
    effectiveSignal.throwIfAborted();

    const descriptor = result?.workspace ?? {};
    const workspace = await patchWorkspace(row.id, {
      root: descriptor.root || row.root,
      label: descriptor.label || row.label,
      state: 'ready',
      ...(descriptor.meta ? { meta: descriptor.meta } : {})
    });

    // Onto this window's table by hand, before the caller is told it can bind
    // to this. The row is the server's the moment it is registered, but a client
    // learns of it through the `workspaces-changed` broadcast — and everything a
    // conversation bound here goes on to do is refused for a workspace this
    // session cannot resolve, so the first act in a tree we just built would be
    // turned away for it being too new. The broadcast will bring it again,
    // harmlessly.
    if (session && !session.workspaces?.some?.((/** @type {any} */ known) => known.id === workspace.id)) {
      session.workspaces = [...(session.workspaces ?? []), workspace];
    }

    return {
      workspace,
      undo: async () => {
        const failures = await unwindAll();
        await unregisterWorkspace(workspace.id);
        return leftBehindSentence(failures);
      }
    };
  } catch (error) {
    const failures = await unwindAll();
    // Unregistering is tolerant: the row may already be gone (a compensation
    // that unregistered it, a second window), and a failure to tidy up must not
    // replace the error that explains why we are here at all.
    await unregisterWorkspace(row.id).catch(() => {});
    // What the unwinding could not take back rides along with the error rather
    // than replacing it. Both matter and they are different sentences: one says
    // why there is no workspace, the other says what is on the disk anyway.
    const leftBehind = leftBehindSentence(failures);
    if (leftBehind && error instanceof Error) {
      /** @type {any} */ (error).leftBehind = leftBehind;
    }
    throw error;
  }
}

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

/**
 * Move a conversation to another workspace.
 *
 * Refused while the conversation has a turn in flight, for the reason finishing
 * with a workspace is: the running turn's next operation would land in a tree it
 * never agreed to work in. Refused, too, for a target that cannot be worked in —
 * moving a conversation from one unusable place to another is not a way out.
 *
 * What the tree being left holds stays in it. A move is a change of where the
 * conversation works, not a copy: the files are still on the disk, under the
 * path they were always under.
 * @param {any} conversation - The conversation to move.
 * @param {string} workspaceId - Where it works now; '' is the project.
 * @returns {Promise<{done: boolean, message?: string}>} What happened, and why not.
 */
export async function rebindConversation(conversation, workspaceId) {
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

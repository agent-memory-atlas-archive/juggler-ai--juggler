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
 * These cases pin that: what an uninitialised conversation has (the project's
 * seeds, no binding), what picking a row does to them (the whole set rebuilt
 * out of the named tree, and nothing of the user's touched), what initialising
 * does (binds, and confirms rather than repeats — a seed the user deleted stays
 * deleted), and what a conversation born from another inherits.
 * @module unit-tests/conversation-workspace-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { isFileEditingAllowed, setFileEditingAllowed } from '../../js/services/file-editing-permission.js';
import { getDefaultStrategyId, setDefaultStrategyId } from '../../js/services/default-strategy.js';
import { getDefaultPresetId, setDefaultPreset } from '../../js/services/system-prompt-presets.js';
import { INITIALISED_KEY } from '../../js/model/conversation.js';
import { fetchJson } from '../../js/services/http.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { PROJECT_ROW_ID, selectSetupRow } from '../../js/services/conversation-setup.js';
import {
  runWorkspaceSuite,
  countSeeds,
  makeConversation,
  seededFile,
  syncUndoState
} from '../utilities/conversation-workspace-helpers.js';

/**
 * This suite makes and removes directories directly in the shared fixture root,
 * which a sibling lane walking the project reads as they come and go, so no
 * other lane may be in flight while it runs.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * Run the conversation-workspace tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-test', async ({ run, session, projectPath, registeredId, release }) => {
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

  });
}

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a conversation works, and being finished with a tree.
 *
 * A bound conversation says where it works at the top of its transcript, and
 * has to keep saying something true while the answer changes underneath it: a
 * workspace somebody else finished with, a binding the table has lost, a tree
 * put back under the id that lost it. Finishing and moving are the other half —
 * what a tree holds must be listed before anything destroys it, and carried
 * across all of it or none of it.
 * @module unit-tests/conversation-workspace-panel-test
 */

import { waitFor, neutralizeStrayOverlays, assert } from '../utilities/test-helpers.js';
import { INITIALISED_KEY } from '../../js/model/conversation.js';
import api from '../../js/services/api.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { registerWorkspace, unregisterWorkspace, listWorkspaces } from '../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceFinishWarning,
  finishWorkspace,
  provisionLeftBehind
} from '../../js/services/workspace-provisioning.js';
import {
  rebindConversation,
  workspaceHeldWork,
  workspaceWorkList,
  carryWorkspaceWork
} from '../../js/services/workspace-rebinding.js';
import {
  setupRows,
  probeSetupStatuses,
  cachedSetupStatus,
  probeSetupAdoptions,
  adoptSetupRow
} from '../../js/services/workspace-places.js';
import { ensureConversationChrome } from '../../js/components/conversation-area-rendering.js';
import { buildProviderFields } from '../../js/components/workspace-setup-form.js';
import '../../js/components/conversation-bar.js';
import { WORKSPACE_ELSEWHERE_HINT } from '../../js/components/model-selector.js';
import {
  runWorkspaceSuite,
  FixtureProvider,
  bannerFor,
  buildWorkspaceFor,
  columnFor,
  makeConversation,
  readIn,
  workspaceRow
} from '../utilities/conversation-workspace-helpers.js';

/**
 * This suite makes and removes directories directly in the shared fixture root,
 * which a sibling lane walking the project reads as they come and go, so no
 * other lane may be in flight while it runs.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * Run the conversation-workspace-panel tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-panel-test', async ({ run, session, projectPath, release }) => {
    await run('a conversation from before workspaces works in the project, and says nothing about it', async () => {
      // What every conversation on disk looks like after the upgrade: history in
      // the document, and no flag in its metadata. It has been working in the
      // project the whole time and its binding still says so, so there is
      // nothing to announce — and a line at the top of a transcript its user had
      // finished with would be announcing that nothing has changed.
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
      assert(!list.querySelector('.conversation-workspace-banner'),
        'and nothing announces the project, which is where it has been working all along');
    });

    await run('a workspace built for a conversation is named at the top of its transcript', async () => {
      // The two acts, in the order the app performs them: the place is built
      // with no conversation in the question, and something is moved into it
      // afterwards. What the transcript then says about it is the whole of what
      // a bound conversation shows — the name of the tree and where it is.
      const name = `built-for-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'works-in-what-was-built');
      release(conversation);

      const { area, list } = columnFor(conversation);
      const savedTable = session.workspaces;
      try {
        const workspace = await buildWorkspaceFor(
          session, conversation, FixtureProvider.MANIFEST.id, { dir });
        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'the provider built the place its form was filled in for');
        assert(conversation.workspaceId === workspace.id,
          `and the conversation was moved into it, got ${JSON.stringify(conversation.workspaceId)}`);

        ensureConversationChrome(area, list);
        const banner = /** @type {any} */ (list.querySelector('.conversation-workspace-banner'));
        assert(banner?.querySelector('.workspace-banner-label')?.textContent === 'made by the fixture',
          `the banner names the tree it works in, got ${JSON.stringify(banner?.textContent)}`);
        assert(banner?.querySelector('.workspace-banner-root')?.textContent === dir,
          `and says where that tree is, got ${JSON.stringify(banner?.textContent)}`);
      } finally {
        session.workspaces = savedTable;
        if (conversation.workspaceId) await unregisterWorkspace(conversation.workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
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

    await run('every listed workspace is asked how it is doing before it is picked', async () => {
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
        assert(status !== undefined && status.available === true,
          `each listed workspace is asked about before it is picked, got ${JSON.stringify(status)}`);

        // And the sweep is abandonable, so dismissing the view that asked stops
        // a probe that would otherwise still be running against a host that is
        // down.
        const controller = new AbortController();
        controller.abort();
        await probeSetupStatuses(session, controller.signal);
        assert(true, 'an aborted sweep settles rather than hanging or throwing');
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('asking how a place is doing does not rename it', async () => {
      // Both surfaces draw twice: once from the row, and again when the
      // provider's status arrives — for a scratch copy, once a walk of two
      // trees has finished, which is seconds later and well after the user has
      // read the name. While both the row and the status named the place, the
      // second draw quietly renamed it: a copy opened as "thing (copy)" and
      // became "thing" the moment the changed-files count landed. The row is
      // what names a workspace. Status says how it is doing, and nothing else.
      const saved = session.workspaces;
      const registered = 'the name it was registered under';
      session.workspaces = [
        workspaceRow('ws_named', '/tmp/named-tree', {
          label: registered,
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      const header = /** @type {any} */ (document.createElement('workspace-box-header'));
      document.body.appendChild(header);
      // A provider that insists on a different name is the point: the surfaces
      // must ignore it, so a fixture that agreed with the row could not fail.
      FixtureProvider.reported = {
        label: 'a name the probe made up',
        detail: 'the probe has answered'
      };
      try {
        const bound = await makeConversation(session, 'named-place', { workspaceId: 'ws_named' });
        release(bound);
        session.selectWorkspace('ws_named');
        panel._refresh();
        header.setContext({ session, workspace: session.getWorkspace('ws_named') });

        const panelTitle = () => panel.querySelector('.workspace-panel-title')?.textContent ?? '';
        const headerTitle = () => header.querySelector('.conversation-box-label')?.textContent ?? '';
        assert(panelTitle() === registered,
          `the first draw names the place from the row, got ${JSON.stringify(panelTitle())}`);
        assert(headerTitle() === registered,
          `and so does the box above the conversations in it, got ${JSON.stringify(headerTitle())}`);

        await waitFor(() => panel.textContent?.includes('the probe has answered'),
          'the provider status to reach the panel');
        await waitFor(() => header.classList.contains('is-dirty') || header._status,
          'and to reach the box header');

        assert(panelTitle() === registered,
          `the answer arriving does not rename the place, got ${JSON.stringify(panelTitle())}`);
        assert(headerTitle() === registered,
          `in either surface, got ${JSON.stringify(headerTitle())}`);
      } finally {
        panel.remove();
        header.remove();
        session.selection = null;
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
        FixtureProvider.reported = null;
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
        // Nor is it this refusal's to make: a conversation whose workspace is
        // being built is stopped at the composer, which says what it is waiting
        // for, rather than here, which would say it is lost.
        assert(early._unusableWorkspace() === '',
          `and a binding still being built is not called unusable, got ${JSON.stringify(early._unusableWorkspace())}`);
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
        // stranded. A half-built tree has no root on disk yet, so it arrives
        // here unavailable as well.
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
        await projectOps.shell({ command: `mkdir -p ${name}` });
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
        await projectOps.shell({ command: `mkdir -p ${name}-again` });
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
        // Through the sweep, not by removing the element: the overlay holds a
        // popup-manager token that only its own close releases, and a token
        // left registered suppresses every shortcut for the rest of the lane.
        neutralizeStrayOverlays();
        session.workspaces = saved;
        await unregisterWorkspace(strandedId).catch(() => {});
        if (spare?.id) await unregisterWorkspace(spare.id).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name} ${name}-again` }).catch(() => {});
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
      const owner = await makeConversation(session, 'finishes-with-it');
      release(owner);
      const saved = session.workspaces;
      /** @type {any} */
      let peer = null;
      let workspaceId = '';
      try {
        // The place is built first and the conversation moved into it, which is
        // the state every conversation working in a workspace reaches.
        const built = await buildWorkspaceFor(session, owner, FixtureProvider.MANIFEST.id, { dir });
        assert(owner.workspaceId === built.id,
          `precondition: there is a workspace to finish with, got ${JSON.stringify(owner.workspaceId)}`);

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
        // And so is every other conversation that was working here. The tree is
        // gone for all of them, so leaving one bound to a tombstone is leaving
        // it somewhere that no longer exists — and which of them pressed the
        // button is not a difference the workspace has, least of all when it
        // was pressed on the workspace's own box and nobody pressed it as
        // themselves.
        assert((peer.workspaceId || '') === '',
          `everyone working here goes back to the project, not just whoever finished with it, got ${JSON.stringify(peer.workspaceId)}`);
      } finally {
        session.workspaces = saved;
        if (workspaceId) await unregisterWorkspace(workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('binning the last conversation in a workspace takes nothing else with it', async () => {
      // Binning a conversation is one act, and as immediate for one working in
      // a tree as for one working in the project. The workspace is not asked
      // about, even when this is the last thing working in it: the tree is
      // drawn in its own right — its box stays in the strip, says it is empty,
      // and holds every ending its provider offers — so binning is nobody's
      // last chance to be offered one, and has no reason to ask.
      //
      // Driven through the bar's own action site, because that is where every
      // affordance that bins — the tab button, the context menu, the shortcut —
      // converges.
      const name = `bin-sole-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      await writeFileOp({ path: `${name}/made-here.txt`, content: 'yes' });
      const made = await registerWorkspace({
        root: dir,
        label: 'left behind',
        state: 'ready',
        providerId: FixtureProvider.MANIFEST.id,
        meta: { dir }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];

      const container = document.createElement('div');
      container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
      container.appendChild(document.createElement('conversation-tabs-container'));
      const bar = /** @type {any} */ (document.createElement('conversation-bar'));
      container.appendChild(bar);
      document.body.appendChild(container);
      neutralizeStrayOverlays();

      try {
        const conversation = await makeConversation(session, 'last-one-in-the-tree', { workspaceId: made.id });
        release(conversation);

        /** @type {string[]} Conversations the bar asked to bin. */
        const binned = [];
        // The bar's own session surface, stubbed down to what it reads: the real
        // one would put every conversation this suite has made into the bar, and
        // the bin under test would be a real one this suite then has to undo.
        bar._session = {
          conversations: new Map([[conversation.id, conversation]]),
          binnedCount: 0,
          binSizeBytes: 0,
          visibleConversationId: conversation.id,
          workspaces: [made],
          /**
           * @param {string} id - Workspace to resolve.
           * @returns {any} The row, or null.
           */
          getWorkspace: (id) => (id === made.id ? made : null),
          /**
           * @param {string} id - Workspace to locate.
           * @returns {string} Where it is.
           */
          workspaceRoot: (id) => (id === made.id ? dir : projectPath),
          /**
           * @param {string} id - Conversation to bin.
           * @returns {Promise<boolean>} Always taken.
           */
          binConversation: async (id) => { binned.push(id); return true; }
        };
        bar.render();

        await bar._binConversation(conversation.id);

        assert(binned.length === 1 && binned[0] === conversation.id,
          `the conversation goes, in one act and with nothing asked, got ${JSON.stringify(binned)}`);
        assert(!document.querySelector('modal-dialog.show'),
          'and nothing was put in front of the user on the way');
        assert((await projectOps.stat({ path: name })).exists,
          'the tree is where it was: a conversation going away is not a claim on one');
        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === made.id);
        assert(row?.state === 'ready',
          `and its row is still usable, which is what the empty box in the strip is offering, got ${JSON.stringify(row?.state)}`);
      } finally {
        container.remove();
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
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

    await run('a form says what the place it makes is good and bad for', async () => {
      // A provider writes down what it suits, what it does not, and what is
      // surprising about it, and the answer to "which of these do I want" is
      // read while the form is being filled in — so the advice is built with the
      // fields, by whoever renders them, rather than beside the row that names
      // the kind. Driven at the form itself because both views that ask a
      // provider for one get it from here.
      const fields = buildProviderFields({ session, providerId: FixtureProvider.MANIFEST.id });
      const said = fields.element.querySelector('.setup-recommend')?.textContent ?? '';
      const { bestFor, avoidFor, notes } = FixtureProvider.MANIFEST.recommendations;
      assert(said.includes(bestFor),
        `the form says what it is for, got ${JSON.stringify(said)}`);
      assert(said.includes(avoidFor),
        `and what it is not for, got ${JSON.stringify(said)}`);
      assert(said.includes(notes[0]),
        `and what is worth knowing before pressing Create, got ${JSON.stringify(said)}`);
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
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
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

  });
}

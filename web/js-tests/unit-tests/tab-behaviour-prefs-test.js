//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tab-behaviour preference unit tests: the two opt-outs for what a
 * conversation's tab may do to get noticed.
 *
 *  - `tabHighlight` off must silence the tab's APPEARANCE ONLY. The conversation
 *    is still flagged as needing the user, because everything else keys off that
 *    flag: the chime, the out-of-app signal, and the jump-to-attention command
 *    (which reads `getFlaggedConversationIds`). A gate that dropped the flag
 *    would silently break "jump to whatever is waiting" — the failure mode this
 *    file exists to catch.
 *  - `tabReorder` off must stop `Session.bumpConversation` moving anything, for
 *    both bump paths (an attention edge and the local send's forceTop), and must
 *    not POST a reorder either — an order write is what other windows would
 *    follow.
 *  - With it on, a bump must follow the two attention EDGES and nothing else. A
 *    turn writes to its conversation several times a second; reordering on that
 *    churn takes the list out of the user's hands for as long as a turn runs,
 *    which is what these cases exist to catch. The tab still floats for the
 *    conversation on screen — only the alert is suppressed there.
 *
 * `tabHighlight` spans two modules, and the SECOND one is the louder: the
 * attention manager's standing tint waits quietly until the conversation is
 * viewed, while `conversation-bar`'s `.is-awaiting` pulse runs, yellow and
 * moving, for as long as an approval is parked. Gating only the former looks,
 * from the outside, like the setting does nothing — so the bar's half is pinned
 * here too, including the repaint of tabs ALREADY pulsing when the preference
 * changes (the pulse must stop then and there, not whenever the approval
 * resolves).
 *
 * The bump half runs `Session.prototype.bumpConversation` against a minimal
 * stand-in `this` (a conversations Map plus the real order-rebuild methods),
 * so it pins the gate without a live session, worker, or server round-trip.
 * @module unit-tests/tab-behaviour-prefs-test
 */

import { assert } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import Conversation from '../../js/model/conversation.js';
import {
  getAttentionPrefs,
  initAttention,
  setNotifyEnabled,
  setSoundEnabled,
  setTabHighlightEnabled,
  setTabReorderEnabled,
  __attention,
} from '../../js/utils/attention-manager.js';
import '../../js/components/conversation-bar.js';

/**
 * Mount a sidebar tab element for a conversation id, as the conversation bar
 * renders it — `flashConversation` finds it by that data attribute.
 * @param {string} convId
 * @returns {HTMLElement} The mounted tab element.
 */
function mountTab(convId) {
  const tab = document.createElement('div');
  tab.className = 'conversation-tab';
  tab.dataset.conversationId = convId;
  tab.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  document.body.appendChild(tab);
  return tab;
}

/**
 * A detached conversation bar wired to one stubbed conversation that is parked
 * on an approval, plus that conversation's tab element. Detached means no
 * connectedCallback — so no session lookup or mount path runs, and the bar is
 * exercised purely as the painter of tab status classes.
 * @param {string} convId
 * @param {boolean} awaiting - Whether the stub reports a pending approval.
 * @returns {{bar: any, tab: HTMLElement}} The bar and its tab element.
 */
function fakeBar(convId, awaiting) {
  const tab = document.createElement('li');
  // hasPendingApprovalInTree walks Y.Map-shaped items; a lone tool-action whose
  // state is `pending` is the smallest tree it reports true for.
  const items = awaiting
    ? [{ get: (/** @type {string} */ k) => ({ type: 'tool-action', state: 'pending' }[k]) }]
    : [];
  const conv = {
    llmState: { isConversationProcessing: () => false },
    rootMessageThread: { items },
    isAwaitingApproval: Conversation.prototype.isAwaitingApproval,
  };
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar._session = { conversations: new Map([[convId, conv]]) };
  bar._cachedElements = new Map([[convId, tab]]);
  return { bar, tab };
}

/**
 * A minimal `this` for {@link Session.prototype.bumpConversation}: the ordered
 * conversations map plus the collaborators that method touches. Conversations
 * are idle stand-ins, so the busy barrier resolves to "nothing busy" and a bump
 * targets index 0.
 * @param {string[]} ids - Conversation ids in tab order.
 * @returns {any} The stand-in session, with `persists`/`notifies` call counters.
 */
function fakeSession(ids) {
  const idle = { getMetadata: () => ({ status: 'idle' }) };
  return {
    conversations: new Map(ids.map((id) => [id, idle])),
    persists: 0,
    notifies: 0,
    _isConvBusy: Session.prototype._isConvBusy,
    _setConversationOrder: Session.prototype._setConversationOrder,
    _replaceConversations: Session.prototype._replaceConversations,
    // A bump moves a conversation, so a box anchored to it hands its place on
    // rather than being dragged up the bar by a turn coming to rest. No
    // workspaces here, so it is the real method answering that there is nothing
    // to re-anchor.
    _reanchorBoxesBeforeMove: Session.prototype._reanchorBoxesBeforeMove,
    _notify() { this.notifies++; },
    _persistOrder() { this.persists++; },
  };
}

/**
 * A stand-in session wired to the real attention manager, with a spying
 * `bumpConversation` in place of the session's. `tick()` publishes one
 * `conversation:changed` — the feed a live conversation fires on every write its
 * turn makes, streaming content included.
 * @param {string} convId
 * @returns {{conv: any, sess: any, tick: () => void}} The conversation stub, the
 *   stand-in session (with a `bumps` log), and the activity pump.
 */
function attentionHarness(convId) {
  /** @type {((e: any) => void)[]} */
  const listeners = [];
  const conv = {
    id: convId,
    processing: false,
    completedTurns: 0,
    llmState: { isConversationProcessing: () => conv.processing },
    rootMessageThread: { items: /** @type {any[]} */ ([]) },
    isAwaitingApproval: Conversation.prototype.isAwaitingApproval,
  };
  const sess = {
    conversations: new Map([[convId, conv]]),
    /** @type {string|null} */
    visibleConversationId: null,
    /** @type {string[]} */
    bumps: [],
    onLLMStatusChange() { /* the doc feed alone is enough to drive both edges */ },
    subscribe(/** @type {(e: any) => void} */ fn) { listeners.push(fn); },
    bumpConversation(/** @type {string} */ id) { sess.bumps.push(id); },
  };
  initAttention(/** @type {any} */ (sess));
  const tick = () => {
    for (const fn of listeners) fn({ type: 'conversation:changed', data: { conversationId: convId } });
  };
  return { conv, sess, tick };
}

// A thread whose single tool-action is parked on an approval.
/** @type {any[]} */
const awaitingItems = [{ get: (/** @type {string} */ k) => ({ type: 'tool-action', state: 'pending' }[k]) }];

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
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

  const prefs = getAttentionPrefs();
  /** @type {HTMLElement[]} */
  const tabs = [];
  // Ids the edge cases raise a real alert on, cleared in the finally.
  /** @type {string[]} */
  const flags = [];

  // Flagging a conversation re-syncs the browser-tab title badge; switch the
  // out-of-app signal off so this suite leaves the page title alone while it
  // raises flags on conversations that don't exist. An alert lasts until its
  // conversation is viewed, so the flags themselves are dropped in the finally.
  setNotifyEnabled(false);
  // The edge cases run the real alert path rather than flashForTest, so silence
  // the chime for the duration too.
  setSoundEnabled(false);

  try {
    await run('highlight on: the tab gets both the standing mark and the one-shot animation', () => {
      setTabHighlightEnabled(true);
      const convId = 'conv_flashon01';
      const tab = mountTab(convId);
      tabs.push(tab);
      __attention.flashForTest(convId);
      assert(tab.classList.contains('needs-attention'), 'expected the standing needs-attention mark');
      assert(tab.classList.contains('attention-flash'), 'expected the one-shot attention-flash class');
      assert(__attention.isFlagged(convId), 'the conversation must be flagged');
    });

    await run('highlight off: the tab stays plain but the conversation is still flagged', () => {
      setTabHighlightEnabled(false);
      const convId = 'conv_flashoff1';
      const tab = mountTab(convId);
      tabs.push(tab);
      __attention.flashForTest(convId);
      assert(!tab.classList.contains('needs-attention'), 'needs-attention must not be applied with highlighting off');
      assert(!tab.classList.contains('attention-flash'), 'attention-flash must not be applied with highlighting off');
      // The flag is what jump-to-attention, the chime and the dock/title signal
      // all read — silencing the tab must not cost the user those.
      assert(__attention.isFlagged(convId), 'the conversation must still be flagged with highlighting off');
    });

    await run('turning highlighting off clears marks already on a flagged tab, keeping the flag', () => {
      setTabHighlightEnabled(true);
      const convId = 'conv_flashmid1';
      const tab = mountTab(convId);
      tabs.push(tab);
      __attention.flashForTest(convId);
      assert(tab.classList.contains('needs-attention'), 'precondition: the tab is marked');

      setTabHighlightEnabled(false);
      assert(!tab.classList.contains('needs-attention'), 'the standing mark must go when highlighting is turned off');
      assert(!tab.classList.contains('attention-flash'), 'the animation class must go when highlighting is turned off');
      assert(__attention.isFlagged(convId), 'the conversation still needs the user — the flag stays');
    });

    // ── The awaiting pulse: the long-lived yellow, painted by the bar ──────
    await run('highlight on: a tab parked on an approval pulses (.is-awaiting)', () => {
      setTabHighlightEnabled(true);
      const { bar, tab } = fakeBar('conv_await_on1', true);
      bar._refreshTabStatus('conv_await_on1');
      assert(tab.classList.contains('is-awaiting'), 'an awaiting tab must pulse while highlighting is on');
    });

    await run('highlight off: a tab parked on an approval looks exactly like an idle one', () => {
      setTabHighlightEnabled(false);
      const convId = 'conv_await_off1';
      const { bar, tab } = fakeBar(convId, true);
      bar._refreshTabStatus(convId);
      assert(!tab.classList.contains('is-awaiting'), 'the awaiting pulse must be withheld with highlighting off');
      // The state itself must be untouched — the bin guard and the rest read it.
      assert(bar._conversationActivity(convId).awaiting === true,
        'only the paint is gated: the conversation must still report awaiting');
    });

    await run('turning highlighting off stops a tab that is ALREADY pulsing', () => {
      setTabHighlightEnabled(true);
      const convId = 'conv_await_live';
      const { bar, tab } = fakeBar(convId, true);
      // Wire the bar's listeners without mounting it (connectedCallback would
      // pull in the session/tabs-container mount path).
      bar._setupKeyboardNavigation();
      try {
        bar._refreshTabStatus(convId);
        assert(tab.classList.contains('is-awaiting'), 'precondition: the tab is pulsing');

        // The user opens settings and flips the toggle. The pulse must stop now,
        // not when the approval resolves — the whole complaint this pins.
        setTabHighlightEnabled(false);
        assert(!tab.classList.contains('is-awaiting'),
          'a live pulse must stop the moment highlighting is turned off');

        setTabHighlightEnabled(true);
        assert(tab.classList.contains('is-awaiting'),
          'turning highlighting back on must restore the pulse on a still-awaiting tab');
      } finally {
        bar.disconnectedCallback();
      }
    });

    // ── The reorder gate ──────────────────────────────────────────────────
    await run('reorder on: an activity bump floats the conversation to the top and persists it', () => {
      setTabReorderEnabled(true);
      const self = fakeSession(['a', 'b', 'c']);
      Session.prototype.bumpConversation.call(self, 'c');
      assert([...self.conversations.keys()].join() === 'c,a,b', `expected c,a,b — got ${[...self.conversations.keys()].join()}`);
      assert(self.persists === 1, `expected the new order persisted once, got ${self.persists}`);
    });

    await run('reorder off: an activity bump moves nothing and writes no order', () => {
      setTabReorderEnabled(false);
      const self = fakeSession(['a', 'b', 'c']);
      Session.prototype.bumpConversation.call(self, 'c');
      assert([...self.conversations.keys()].join() === 'a,b,c', `order must be untouched — got ${[...self.conversations.keys()].join()}`);
      assert(self.persists === 0, 'a gated bump must not POST a reorder for other windows to follow');
      assert(self.notifies === 0, 'a gated bump must not announce a reorder');
    });

    await run('reorder off: the local send’s forceTop bump is gated too', () => {
      setTabReorderEnabled(false);
      const self = fakeSession(['a', 'b', 'c']);
      Session.prototype.bumpConversation.call(self, 'c', { forceTop: true });
      assert([...self.conversations.keys()].join() === 'a,b,c', `forceTop must be gated too — got ${[...self.conversations.keys()].join()}`);
      assert(self.persists === 0, 'a gated forceTop bump must not POST a reorder');
    });

    // ── What a bump is FOR: the edges, not the churn ──────────────────────
    await run('a running turn’s own writes move nothing; coming to rest floats the tab once', () => {
      const convId = 'conv_bump_stream';
      flags.push(convId);
      const { conv, sess, tick } = attentionHarness(convId);

      tick(); // first observation seeds the baselines — never an edge
      conv.processing = true;
      // The firehose: a streaming message rewrites its content several times a
      // second, and every write reaches this feed. The list must not move.
      for (let i = 0; i < 8; i++) tick();
      assert(sess.bumps.length === 0, `mid-turn writes must not reorder tabs — got ${sess.bumps.length} bumps`);

      conv.completedTurns = 1;
      conv.processing = false;
      tick();
      assert(sess.bumps.join() === convId, `the finished turn must float its tab — got [${sess.bumps.join()}]`);

      tick();
      tick();
      assert(sess.bumps.length === 1, 'a conversation at rest must not keep bumping');
    });

    await run('parking on an approval floats the tab mid-turn', () => {
      const convId = 'conv_bump_await';
      flags.push(convId);
      const { conv, sess, tick } = attentionHarness(convId);

      conv.processing = true;
      tick(); // seeded while busy, with nothing awaiting
      assert(sess.bumps.length === 0, 'precondition: a busy conversation has not bumped');

      conv.rootMessageThread.items = awaitingItems;
      tick();
      assert(sess.bumps.join() === convId, `an approval parking must float its tab — got [${sess.bumps.join()}]`);
    });

    await run('the conversation on screen floats too, without alerting', () => {
      const convId = 'conv_bump_watched';
      const { conv, sess, tick } = attentionHarness(convId);
      sess.visibleConversationId = convId;
      __attention.setFocusedForTest(true);
      try {
        tick();
        // This conversation's own tally, not the window-wide count: the manager
        // alerts for every conversation in a session, and lanes share one.
        const alerts = __attention.alertsFor(convId);
        conv.completedTurns = 1;
        tick();
        assert(sess.bumps.join() === convId, `the watched conversation’s tab must float too — got [${sess.bumps.join()}]`);
        assert(__attention.alertsFor(convId) === alerts, 'the conversation being watched must not raise an alert');
      } finally {
        __attention.setFocusedForTest(null);
      }
    });
  } finally {
    // Restore every pref touched and drop the mounted tabs. The prefs live in
    // localStorage, shared by every lane on this origin — hence the suite's
    // needsExclusiveRun.
    setTabHighlightEnabled(prefs.tabHighlight);
    setTabReorderEnabled(prefs.tabReorder);
    setSoundEnabled(prefs.sound);
    for (const tab of tabs) {
      const id = tab.dataset.conversationId;
      if (id) __attention.clearForTest(id);
      tab.remove();
    }
    for (const id of flags) __attention.clearForTest(id);
    // Last, so restoring the out-of-app signal re-syncs a title badge against an
    // empty flag set rather than the invented conversations above.
    setNotifyEnabled(prefs.notify);
  }

  return { passed, failed, errors };
}

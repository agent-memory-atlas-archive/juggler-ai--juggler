//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Attention manager — alerts the user (chime + visual flash) when a conversation
 * needs them while they're not looking at it.
 *
 * Triggers (false→true edges, per conversation):
 *  - a tool-action enters **awaiting-approval** anywhere in the thread tree
 *    (this also covers AskUserQuestion, which is an approval under the hood), or
 *  - a worker **turn completes** and the conversation comes to rest (idle).
 *
 * The approval edge waits for the automation to have its say first: a call a
 * strategy's `onToolPending` reviewer is still weighing may never reach the user
 * at all, so it counts only once the review ends and leaves it parked.
 *
 * Every alert is gated on the user *not already looking* at that conversation:
 * we suppress it only when this window is focused/visible AND the conversation
 * is the one on screen. So the thread you're actively watching never beeps; a
 * backgrounded window, or an off-screen tab, does.
 *
 * Two layers of visual signal, each with its own toggle:
 *  - The conversation's **tab highlight** (the `tabHighlight` pref): a one-shot
 *    blink plus a standing tint on its sidebar tab. Turning it off silences the
 *    tab's appearance only — the conversation is still tracked as flagged, so
 *    the chime, the out-of-app signal, and the jump-to-attention command all
 *    still find it.
 *  - An **out-of-app signal** (the `notify` pref) on top: a dock-icon bounce in
 *    the desktop app, or a leading ● on this browser tab's title in a browser.
 *
 * `tabHighlight` reaches one surface this module does not own: the sidebar tab's
 * standing **awaiting pulse**, which the conversation bar paints from live
 * approval state (not from an alert, and regardless of focus). It is the loudest
 * and longest-lived yellow on a tab, so a user turning tab highlighting off means
 * that one above all — `conversation-bar._refreshTabStatus` reads
 * {@link isTabHighlightEnabled} for exactly that reason.
 *
 * A standing alert clears when you view the conversation, and only then. Being
 * away is exactly the case it exists for, so a turn that finished while you were
 * gone is still marked when you come back, however long that took; the alert is
 * dropped when its conversation is binned or deleted, which is the one way a
 * flag can outlive the thing it points at.
 *
 * Preference model mirrors {@link module:utils/theme-manager}: a per-window
 * choice in localStorage, so different windows can have different needs (one
 * babysitting a long autonomous run wants alerts; one you're typing in doesn't).
 * Every toggle is independent. The header bell is the on/off for notification
 * sounds — the same `sound` pref the settings checkbox drives.
 *
 * One pref here isn't an alert surface at all: `tabReorder` governs whether this
 * window floats a conversation's tab up the list. It lives with the alert prefs
 * because it's the same kind of per-window "how much may a tab demand of me"
 * choice, shares their settings section, and — since the bump fires on the same
 * two edges above — is decided in the same place; the gate itself is read by
 * {@link module:model/session~Session#bumpConversation}.
 *
 * The bump differs from an alert in one respect: it is not suppressed for the
 * conversation the user is watching. Reordering a tab costs nothing to ignore,
 * where a chime for the thread already on screen is an interruption.
 * @module utils/attention-manager
 */

import { hasUnattendedPendingApprovalInTree } from '../model/thread-navigation.js';
import { playChime, unlockAudio, rearmAudio, CHIME_DEFAULTS, chimePatterns, chimeSounds } from './chime-synth.js';
import { isDesktopWindow, postWindowControl } from '../../sdk/lib/window-control.js';

const PREFS_KEY = 'juggler-attention';
/** Fired on window whenever prefs change, so the bell + settings stay in sync. */
export const ATTENTION_PREFS_EVENT = 'juggler:attention-prefs-changed';

/** @typedef {import('./chime-synth.js').ChimeParams} ChimeParams */
/**
 * @typedef {object} AttentionPrefs
 * @property {boolean} sound - Play the chime on alert (the header bell's toggle).
 * @property {boolean} notify - Raise an out-of-app attention signal on alert: a
 *   dock-icon bounce in the desktop app, or a ● on this browser tab's title in a
 *   browser. Independent of the in-app conversation-tab highlight.
 * @property {boolean} tabHighlight - Let a conversation's sidebar tab change
 *   appearance to get noticed: the alert blink and standing tint here, plus the
 *   conversation bar's awaiting pulse. Off leaves tabs looking untouched; the
 *   conversation is still flagged, so the other surfaces and jump-to-attention
 *   are unaffected.
 * @property {boolean} tabReorder - Let a conversation's tab float up the list in
 *   this window when it comes to rest, parks on an approval, or the user sends
 *   to it (read by `Session.bumpConversation`). Off pins the order to whatever
 *   the user last dragged it to.
 * @property {ChimeParams} chime - Abstract chime voice parameters.
 */

/**
 * Defaults: notify on (unobtrusive, no permission), sound off (enabling it is
 * the gesture that unlocks audio), and both tab behaviours on — the highlight
 * and the recency bump are how a tab has always announced itself, so opting out
 * is the deliberate choice.
 * @type {AttentionPrefs}
 */
const DEFAULT_PREFS = {
  sound: false,
  notify: true,
  tabHighlight: true,
  tabReorder: true,
  chime: { ...CHIME_DEFAULTS },
};

/**
 * Read the current per-window prefs, merged over defaults so a partial or older
 * stored blob still yields a complete object.
 * @returns {AttentionPrefs} The merged, complete prefs object.
 */
export function getAttentionPrefs() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  // Validate each chime field against its live schema, so a stale value from an
  // older build (the pre-menu `pitch`/`length`/numeric-`pattern` knobs, or a
  // removed pattern/sound id) is dropped for the default rather than riding
  // through into prefs and desyncing the settings popups.
  const storedChime = /** @type {Record<string, unknown>} */ (/** @type {any} */ (stored).chime || {});
  const validPatterns = new Set(chimePatterns().map((p) => p.id));
  const validSounds = new Set(chimeSounds().map((s) => s.id));
  const vol = storedChime.volume;
  const chime = /** @type {ChimeParams} */ ({
    pattern: validPatterns.has(/** @type {any} */ (storedChime.pattern)) ? storedChime.pattern : DEFAULT_PREFS.chime.pattern,
    sound: validSounds.has(/** @type {any} */ (storedChime.sound)) ? storedChime.sound : DEFAULT_PREFS.chime.sound,
    volume: typeof vol === 'number' ? Math.max(0, Math.min(1, vol)) : DEFAULT_PREFS.chime.volume,
  });
  return { ...DEFAULT_PREFS, ...stored, chime };
}

/**
 * Persist a partial update and notify listeners.
 * @param {Partial<AttentionPrefs>} patch
 * @returns {AttentionPrefs} The merged, saved prefs.
 * @private
 */
function savePrefs(patch) {
  const next = { ...getAttentionPrefs(), ...patch };
  if (patch.chime) next.chime = { ...getAttentionPrefs().chime, ...patch.chime };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(ATTENTION_PREFS_EVENT, { detail: next }));
  return next;
}

/** @returns {boolean} Whether notification sounds are enabled. */
export function isSoundEnabled() {
  return getAttentionPrefs().sound;
}

/**
 * Toggle notification sounds — the single on/off for audible alerts, shared by
 * the header bell and the settings checkbox. The click that calls this is a user
 * gesture, so we use it to unlock audio for the session.
 * @returns {boolean} The new sound-enabled state.
 */
export function toggleSound() {
  const next = !isSoundEnabled();
  // Turning on: unlock audio within this gesture — autoplay policy requires a user
  // gesture to start playback for the session.
  if (next) unlockAudio();
  savePrefs({ sound: next });
  return next;
}

/**
 * Set notification sounds absolutely (the settings checkbox; the header bell uses
 * {@link toggleSound}).
 * @param {boolean} on
 * @returns {void}
 */
export function setSoundEnabled(on) {
  if (on) unlockAudio();
  savePrefs({ sound: !!on });
}

/** @returns {boolean} Whether the out-of-app attention signal is enabled. */
export function isNotifyEnabled() {
  return getAttentionPrefs().notify;
}

/**
 * Toggle the out-of-app attention signal (dock-icon bounce / browser-tab title
 * badge). Does NOT touch the in-app conversation-tab flash, which always fires;
 * it only re-syncs the browser-tab title badge to the new setting.
 * @param {boolean} on
 * @returns {void}
 */
export function setNotifyEnabled(on) {
  savePrefs({ notify: !!on });
  syncBrowserTitleBadge();
}

/**
 * Whether a conversation's sidebar tab may change appearance to get noticed.
 * Read here for the alert marks, and by `conversation-bar._refreshTabStatus` for
 * the awaiting pulse.
 * @returns {boolean} True when tab highlighting is enabled.
 */
export function isTabHighlightEnabled() {
  return getAttentionPrefs().tabHighlight;
}

/**
 * Turn conversation-tab highlighting on or off. Both directions are applied to
 * tabs flagged before the change, so the tab bar answers the switch immediately:
 * off strips their alert marks, on restores the standing tint (not the one-shot
 * blink — that announced an edge that has passed). The flags themselves are
 * untouched either way — those conversations still need the user, and
 * jump-to-attention still finds them. The awaiting pulse is repainted by the
 * conversation bar, which listens for the {@link ATTENTION_PREFS_EVENT} this
 * fires.
 * @param {boolean} on
 * @returns {void}
 */
export function setTabHighlightEnabled(on) {
  savePrefs({ tabHighlight: !!on });
  for (const convId of flagged) {
    if (on) tabElement(convId)?.classList.add('needs-attention');
    else clearTabMarks(convId);
  }
}

/** @returns {boolean} Whether this window may float tabs up the list. */
export function isTabReorderEnabled() {
  return getAttentionPrefs().tabReorder;
}

/**
 * Set whether a conversation's tab may float up the tab list in this window.
 * Read by `Session.bumpConversation`; existing order is left as it is.
 * @param {boolean} on
 * @returns {void}
 */
export function setTabReorderEnabled(on) {
  savePrefs({ tabReorder: !!on });
}

/**
 * Update one chime parameter: `pattern`/`sound` (a menu id, string) or `volume`
 * (0..1, number).
 * @param {keyof ChimeParams} name
 * @param {string|number} value
 * @returns {void}
 */
export function setChimeParam(name, value) {
  savePrefs({ chime: { ...getAttentionPrefs().chime, [name]: value } });
}

/**
 * Reset every chime parameter back to {@link CHIME_DEFAULTS} in one save. The
 * resulting {@link ATTENTION_PREFS_EVENT} re-syncs the settings rotaries.
 * @returns {void}
 */
export function resetChimeParams() {
  savePrefs({ chime: { ...CHIME_DEFAULTS } });
}

/**
 * Play the current chime once, regardless of mute/sound prefs — for the settings
 * "preview" button. Doubles as the audio-unlock gesture.
 * @returns {void}
 */
export function previewChime() {
  unlockAudio();
  const chime = getAttentionPrefs().chime;
  playChime(chime);
}

// ── Alert surfaces ──────────────────────────────────────────────────────────

/**
 * Conversations currently showing an unviewed visual alert.
 * @type {Set<string>}
 */
const flagged = new Set();
/**
 * The document title before we started flashing it.
 * @type {string|null}
 */
let savedTitle = null;

/**
 * Whether this page is a plain browser tab rather than a native desktop-app
 * window. Only a browser tab surfaces `document.title` (in the tab strip); a
 * desktop window's title bar is the native OS title, set via the title endpoint,
 * so there's nothing here to badge.
 * @returns {boolean} True when running as a plain browser tab.
 * @private
 */
function isBrowserTab() {
  return !isDesktopWindow();
}

/**
 * The browser-tab title badge (a leading ● on the title) — the browser's flavour
 * of the out-of-app attention signal. Shown only when the `notify` pref is on AND
 * some conversation is flagged. No-op outside a browser tab (a desktop window
 * shows no document title — there the signal is the dock bounce instead).
 * @private
 */
function syncBrowserTitleBadge() {
  if (!isBrowserTab()) return;
  const show = getAttentionPrefs().notify && flagged.size > 0;
  if (show) {
    if (savedTitle === null) savedTitle = document.title;
    document.title = `\u25CF ${savedTitle}`; // ● prefix
  } else if (savedTitle !== null) {
    document.title = savedTitle;
    savedTitle = null;
  }
}

/**
 * Raise the out-of-app attention signal for a desktop window: bounce the app's
 * dock/taskbar icon via the native host's loopback `attention` endpoint. No-op in
 * a browser (no native host — windowControlURL returns null), where the standing
 * tab-title badge from {@link syncBrowserTitleBadge} carries the signal instead.
 * Best-effort and one-way.
 * @private
 */
function requestDockBounce() {
  postWindowControl('attention');
}

/**
 * The sidebar tab element for a conversation, if it's currently in the DOM.
 * @param {string} convId
 * @returns {Element|null} The tab element, or null when it isn't rendered.
 * @private
 */
function tabElement(convId) {
  return document.querySelector(`.conversation-tab[data-conversation-id="${CSS.escape(convId)}"]`);
}

/**
 * Remove both flash marks from a conversation's tab. Leaves the `flagged` entry
 * and its dismiss timer alone — this is only the visual half.
 * @param {string} convId
 * @private
 */
function clearTabMarks(convId) {
  const tab = tabElement(convId);
  if (tab) tab.classList.remove('needs-attention', 'attention-flash');
}

/**
 * Flag a conversation as needing the user and, when the `tabHighlight` pref
 * allows, mark its sidebar tab: a brief one-shot animation plus a standing tint
 * that lasts until the conversation is viewed. With the pref off the tab is
 * left untouched but the conversation is still flagged, so the chime, the
 * out-of-app signal and jump-to-attention behave identically. Also re-syncs the
 * browser-tab title badge, which honours the `notify` pref.
 * @param {string} convId
 * @private
 */
function flashConversation(convId) {
  flagged.add(convId);
  const tab = getAttentionPrefs().tabHighlight ? tabElement(convId) : null;
  if (tab) {
    tab.classList.add('needs-attention');
    // Restart the one-shot flash animation if it's already present.
    tab.classList.remove('attention-flash');
    void (/** @type {HTMLElement} */ (tab)).offsetWidth; // reflow
    tab.classList.add('attention-flash');
    // Drop the flash class once the blinks finish so the tab falls back to its
    // underlying state (the awaiting pulse, or idle) — the standing
    // `needs-attention` marker persists until the alert is viewed.
    tab.addEventListener('animationend', () => tab.classList.remove('attention-flash'), { once: true });
  }
  syncBrowserTitleBadge();
}

/**
 * Clear the visual alert for one conversation — it's been viewed, or it has gone
 * away.
 * @param {string} convId
 * @private
 */
function clearFlash(convId) {
  if (!flagged.delete(convId)) return;
  clearTabMarks(convId);
  syncBrowserTitleBadge();
}

/**
 * Clear every standing tab flash (e.g. on re-init).
 * @private
 */
function clearAllFlash() {
  for (const id of [...flagged]) clearFlash(id);
}

/**
 * The conversation ids currently showing an unviewed visual alert. Read seam for
 * the "jump to conversation needing attention" command.
 * @returns {string[]} Flagged conversation ids.
 */
export function getFlaggedConversationIds() {
  return [...flagged];
}

// ── Edge detection + gating ─────────────────────────────────────────────────

/** @type {import('../model/session.js').default|null} */
let session = null;
/**
 * Per-conversation previous awaiting state.
 * @type {Map<string, boolean>}
 */
const prevAwaiting = new Map();
/**
 * Per-conversation previous completed-turn count.
 * @type {Map<string, number>}
 */
const prevTurns = new Map();
/**
 * Alerts raised, counted per conversation.
 *
 * A window observes every conversation in its session, so the window-wide
 * `alertCount` below is a total over all of them. That is the right number for
 * "has this window alerted at all", and the wrong one for anything that has to
 * be true of one conversation — hence this tally, read through
 * `__attention.alertsFor`.
 * @type {Map<string, number>}
 */
const alertsByConversation = new Map();
/**
 * Test seam: overrides the focus check when set.
 * @type {boolean|null}
 */
let focusOverride = null;

/**
 * Whether the user is currently looking at `convId` in this window: the window
 * is focused and visible AND that conversation is the one on screen. When true,
 * an alert for that conversation is suppressed (and any standing flash cleared).
 * @param {string} convId
 * @returns {boolean} True when the user is actively viewing this conversation.
 * @private
 */
function isLookingAt(convId) {
  const focused = focusOverride !== null
    ? focusOverride
    : (!document.hidden && document.hasFocus());
  return focused && session?.visibleConversationId === convId;
}

/**
 * Fire the configured alert surfaces for a conversation that just needed
 * attention while unwatched.
 * @param {string} convId
 * @private
 */
function raiseAttention(convId) {
  const prefs = getAttentionPrefs();
  if (prefs.sound) playChime(prefs.chime);
  // Flag the conversation; whether its tab shows the flash is the `tabHighlight`
  // pref, applied inside.
  flashConversation(convId);
  // Out-of-app signal (dock bounce on desktop; the browser-tab title badge is
  // handled reactively in syncBrowserTitleBadge): only when the user opted in.
  if (prefs.notify) requestDockBounce();
  __attention.alertCount++;
  alertsByConversation.set(convId, (alertsByConversation.get(convId) || 0) + 1);
  __attention.lastAlert = { convId, t: __attention.alertCount };
}

/**
 * React to activity in one conversation — a status tick or a doc change: detect
 * the awaiting / turn-done edges, float the conversation's tab, and either alert
 * or (if the user is looking) clear any standing flash. Idempotent, so it is
 * safe to run from both feeds (see {@link initAttention}): the first observation
 * of an edge moves the baseline, and every later one sees no edge.
 * @param {string} convId
 * @private
 */
function onActivity(convId) {
  const conv = session?.conversations.get(convId);
  if (!conv) return;

  const llm = conv.llmState;
  const root = /** @type {any} */ (conv).rootMessageThread;
  // A parked call a strategy reviewer still has in hand doesn't count: it may be
  // approved without the user ever needing to look, and a chime for one that is
  // then auto-approved is a false alarm. Such a call parks already marked as
  // under review, and the write that ends the review is itself a doc change — so
  // one left parked reaches this edge a moment later, on that write.
  const awaiting = !!root && hasUnattendedPendingApprovalInTree(root.items);
  const turns = conv.completedTurns;
  const processing = !!llm && llm.isConversationProcessing(convId);

  const hadAwaiting = prevAwaiting.get(convId);
  const hadTurns = prevTurns.get(convId);

  // Seed baselines on first sight without alerting (avoids a beep on load).
  const seeded = hadTurns !== undefined;
  prevAwaiting.set(convId, awaiting);
  // The turn baseline only moves once the conversation is at rest. The counter
  // bump and the idle status reach us as separate observations, in either
  // order, so consuming the edge on the first of them would swallow the alert
  // the second one is for.
  if (!seeded || !processing) prevTurns.set(convId, turns);

  const awaitingEdge = seeded && awaiting && !hadAwaiting;
  // "Came to rest": a turn completed and the conversation is now idle.
  const turnEdge = seeded && turns > /** @type {number} */ (hadTurns) && !processing;
  const wantsUser = awaitingEdge || turnEdge;

  // Float the tab on these two edges and on nothing else. The tab list is not a
  // progress bar: a running turn writes to its conversation several times a
  // second, and reordering on that churn moves tabs under the hand of anyone
  // arranging them. Unlike the alert, the bump is not suppressed for the
  // conversation being watched — the tab moves for the same reason either way,
  // and a bump is cheap where a chime would be an interruption.
  if (wantsUser) session?.bumpConversation?.(convId);

  // If the user is looking at this conversation, it's not "needing attention" —
  // keep baselines current and clear any leftover flash.
  if (isLookingAt(convId)) {
    clearFlash(convId);
    return;
  }

  if (wantsUser) raiseAttention(convId);
}

/**
 * Clear flags for whichever conversation the user is now looking at. Wired to
 * focus/visibility/switch so viewing a flagged conversation dismisses its alert.
 * @private
 */
function reconcileVisible() {
  const id = session?.visibleConversationId;
  if (id && isLookingAt(id)) clearFlash(id);
}

/**
 * Passive audio re-arm on a return-to-app edge (window focus, tab becoming
 * visible). A long-idle session's AudioContext can be parked by the OS while
 * backgrounded, and the resume() attempted at park time is rejected on a hidden
 * tab — so this edge is the moment it can finally succeed. Only when sound is
 * enabled (with it off there's no warmed device to keep), and only on becoming
 * visible (visibilitychange also fires on hide). See
 * {@link module:utils/chime-synth.rearmAudio}.
 * @private
 */
function rearmAudioOnReturn() {
  if (document.hidden) return;
  if (isSoundEnabled()) rearmAudio();
}

/**
 * Wire the attention manager to a session. Idempotent per session: subscribes to
 * the two feeds the alert edges live on, and to focus/visibility so viewing a
 * flagged conversation dismisses it.
 *
 * Two feeds, because the two edges are published in different places. "Came to
 * rest" is the worker's processing state, which arrives as an LLM status
 * change. Awaiting-approval is a tool-action's `state` in the doc, and nothing
 * makes a status change follow the write that parks it — a conversation can sit
 * on an approval with no further status to observe — so doc changes are watched
 * as well, and the same edge detection runs on both.
 *
 * Both feeds belong to the session rather than to any one conversation, so this
 * is wired once and covers conversations that arrive later.
 * @param {import('../model/session.js').default} sess
 * @returns {void}
 */
export function initAttention(sess) {
  session = sess;
  prevAwaiting.clear();
  prevTurns.clear();
  clearAllFlash();

  sess.onLLMStatusChange((id) => onActivity(id));

  sess.subscribe(/** @param {{type: string, data?: any}} e */ (e) => {
    // Emitted per applied Yjs transaction, so this is the streaming firehose
    // during a turn; the edge check is a read-only walk of the thread tree and
    // has to stay synchronous, because the alert must have been raised by the
    // time anything waiting on that same transaction resumes.
    if (e.type === 'conversation:changed' && e.data?.conversationId) onActivity(e.data.conversationId);
    if (e.type === 'conversation:switched') reconcileVisible();
    // An alert outlives everything but a view, so a binned or deleted
    // conversation has to take its own with it — otherwise the title badge
    // stands for a conversation that no longer exists and nothing can clear it.
    if (e.type === 'conversation:deleted' && e.data?.id) clearFlash(e.data.id);
  });

  window.addEventListener('focus', reconcileVisible);
  document.addEventListener('visibilitychange', reconcileVisible);
  // Re-arm audio on the same return-to-app edges, so a long-idle session whose
  // context the OS parked while backgrounded is warm again by the next chime with
  // no user gesture. Kept separate from reconcileVisible, which also runs on
  // conversation switch — not an audio-relevant edge.
  window.addEventListener('focus', rearmAudioOnReturn);
  document.addEventListener('visibilitychange', rearmAudioOnReturn);
}

/**
 * Test/debug seam. Not part of the supported API.
 * @type {{alertCount: number, lastAlert: any, alertsFor: (convId: string) => number, setFocusedForTest: (v: boolean|null) => void, isFlagged: (convId: string) => boolean, flashForTest: (convId: string) => void, clearForTest: (convId: string) => void}}
 */
export const __attention = {
  alertCount: 0,
  lastAlert: null,
  // Alerts raised for ONE conversation. The window-wide alertCount above counts
  // every conversation in the session, so it is only safe to assert on where
  // the test owns every conversation the window can see — which a test sharing
  // a session with other tests does not.
  alertsFor(/** @type {string} */ convId) { return alertsByConversation.get(convId) || 0; },
  setFocusedForTest(v) { focusOverride = v; },
  isFlagged(/** @type {string} */ convId) { return flagged.has(convId); },
  flashForTest(/** @type {string} */ convId) { flashConversation(convId); },
  // A flag lasts until its conversation is viewed or goes away, so a test that
  // raises one on a conversation it invented has to put it back itself.
  clearForTest(/** @type {string} */ convId) { clearFlash(convId); },
};
// @ts-ignore — expose for integration tests to assert alert firing.
if (typeof window !== 'undefined') window.__attention = __attention;

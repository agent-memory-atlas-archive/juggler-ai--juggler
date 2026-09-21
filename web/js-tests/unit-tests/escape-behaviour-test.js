//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Escape-key behaviour — the configurable stop/prompt rungs of the Escape ladder.
 *
 * Drives the real handler (`handleEscapeKey`) against a stubbed `jugglerApp`, so
 * the assertions are about the DECISION each preset makes — hard cancel, polite
 * pause, arm, clear, or nothing — and the vantage it forwards. The rung above
 * (popup dismissal) is the callers' job and is not exercised here.
 *
 * The load-bearing invariant, asserted for every stopping preset: a press that
 * acts on a running turn never touches the prompt. Text typed mid-run is
 * normally a correction being drafted BECAUSE the turn is going wrong, so a stop
 * gesture that eats the draft is destructive exactly where the user is most
 * engaged.
 *
 * Marked needsExclusiveRun for the same reason as the tool-grouping suite: the
 * preference is one localStorage key on an origin every lane shares, so writing
 * it while a sibling handles a key would change that sibling's answer.
 * @module unit-tests/escape-behaviour-test
 */

import { assert } from '../utilities/test-helpers.js';
import { cachedUserPref, setUserPref } from '../../js/services/prefs.js';
import {
  ESCAPE_PRESETS,
  ESCAPE_BEHAVIOUR_EVENT,
  getEscapePreset,
  setEscapePreset,
  describeEscapePreset,
  handleEscapeKey,
  isDoublePressArmed,
  resetEscapeGesture,
  buildEscapeBehaviourRow,
} from '../../js/services/escape-behaviour.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The user preference the module stores the chosen preset under. Seeded through
 * the pref API rather than localStorage, which is only that realm's cache.
 */
const PREF_KEY = 'juggler-escape-behaviour';

/**
 * A recording stand-in for the app singleton the handler acts through, plus the
 * composer it clears. `running` and `pausePending` are set per test to stage the
 * conversation state each preset branches on.
 * @returns {any} The stub, with the calls it recorded.
 */
function stubApp() {
  const calls = { stop: [], pause: [], cleared: 0 };
  const stub = {
    running: false,
    pausePending: false,
    calls,
    shouldHandleEscape() { return stub.running; },
    getVisibleConversation() {
      return { politeStopState: () => (stub.pausePending ? 'pending' : 'none') };
    },
    /**
     * @param {string|null} threadId - Vantage the stop came from.
     * @param {{polite?: boolean}} [opts] - Stop options.
     */
    cancelLLMOperation(threadId, opts = {}) {
      if (opts.polite) calls.pause.push(threadId);
      else calls.stop.push(threadId);
    },
    composer: {
      clearTextUndoable() { calls.cleared++; return true; },
    },
  };
  return stub;
}

/**
 * Press Escape through the real handler.
 * @param {any} stub - The app stub whose composer/vantage to use.
 * @param {{shift?: boolean, repeat?: boolean, threadId?: string|null}} [opts] - Press options.
 * @returns {boolean} Whether the handler acted.
 */
function press(stub, { shift = false, repeat = false, threadId = null } = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', shiftKey: shift, repeat });
  return handleEscapeKey(event, {
    focusedThreadId: threadId,
    getComposer: () => stub.composer,
  });
}

/** @returns {Element|null} The armed-gesture cue, if one is showing. */
function cue() {
  return document.querySelector('.escape-arm-cue');
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // The suite stubs a global and writes a shared pref; restore both whatever happens.
  const priorApp = /** @type {any} */ (window).jugglerApp;
  const priorPref = cachedUserPref(PREF_KEY, null);

  /** @type {any} */
  let app;

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    app = stubApp();
    /** @type {any} */ (window).jugglerApp = app;
    resetEscapeGesture();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      resetEscapeGesture();
    }
  };

  try {
    // ── The preference itself ──────────────────────────────────────────
    await run('defaults to the shipped stop-immediately preset', () => {
      void setUserPref(PREF_KEY, null);
      assert(getEscapePreset().id === 'stop', 'missing pref must default to "stop"');
      // A retired or hand-edited id must not strand the key in a fallback loop.
      void setUserPref(PREF_KEY, 'not-a-preset');
      assert(getEscapePreset().id === 'stop', 'unknown stored id must fall back to "stop"');
      setEscapePreset('not-a-preset');
      assert(getEscapePreset().id === 'stop', 'an unknown id must never be stored');
    });

    await run('every preset describes both Escape chords for this platform', () => {
      for (const preset of ESCAPE_PRESETS) {
        const text = describeEscapePreset(preset);
        assert(!text.includes('{esc}') && !text.includes('{shiftEsc}'),
          `${preset.id}: key placeholders must be substituted`);
        assert(text.length > 40, `${preset.id}: description should explain both chords`);
      }
    });

    await run('setting a preset notifies listeners', () => {
      setEscapePreset('stop');
      let fired = 0;
      const onChange = () => { fired++; };
      window.addEventListener(ESCAPE_BEHAVIOUR_EVENT, onChange);
      try {
        setEscapePreset('pause');
        assert(fired === 1, `expected one change event, got ${fired}`);
        assert(getEscapePreset().id === 'pause', 'the new preset should be active');
      } finally {
        window.removeEventListener(ESCAPE_BEHAVIOUR_EVENT, onChange);
      }
    });

    // ── stop (the default) ─────────────────────────────────────────────
    await run('stop: Escape hard-cancels from its vantage, Shift+Escape pauses', () => {
      setEscapePreset('stop');
      app.running = true;
      press(app, { threadId: 'thr_1' });
      assert(app.calls.stop.length === 1 && app.calls.stop[0] === 'thr_1',
        'plain Escape should hard-cancel from the pressing column\u2019s vantage');
      assert(app.calls.cleared === 0, 'a stopping press must not touch the prompt');
      press(app, { shift: true, threadId: null });
      assert(app.calls.pause.length === 1, 'Shift+Escape should request a polite pause');
    });

    await run('idle: Escape clears the prompt as an undoable edit', () => {
      setEscapePreset('stop');
      app.running = false;
      press(app);
      assert(app.calls.cleared === 1, 'an idle press should clear the composer');
      assert(app.calls.stop.length === 0 && app.calls.pause.length === 0,
        'an idle press must not cancel anything');
    });

    // ── pause ──────────────────────────────────────────────────────────
    await run('pause: the two chords trade places', () => {
      setEscapePreset('pause');
      app.running = true;
      press(app);
      assert(app.calls.pause.length === 1 && app.calls.stop.length === 0,
        'plain Escape should pause');
      press(app, { shift: true });
      assert(app.calls.stop.length === 1, 'Shift+Escape should hard-cancel');
      assert(app.calls.cleared === 0, 'neither chord may touch the prompt');
    });

    // ── two-step ───────────────────────────────────────────────────────
    await run('two-step: pauses first, then escalates while the pause is pending', () => {
      setEscapePreset('two-step');
      app.running = true;
      press(app);
      assert(app.calls.pause.length === 1 && app.calls.stop.length === 0,
        'the first press should pause');
      // The pending Pause IS the armed state — it is what the second press reads.
      app.pausePending = true;
      press(app);
      assert(app.calls.stop.length === 1, 'a second press should escalate to a hard cancel');
      assert(app.calls.cleared === 0, 'neither press may touch the prompt');
    });

    await run('two-step: Shift+Escape is the one-press escape hatch', () => {
      setEscapePreset('two-step');
      app.running = true;
      press(app, { shift: true });
      assert(app.calls.stop.length === 1 && app.calls.pause.length === 0,
        'Shift+Escape should hard-cancel on the first press');
    });

    // ── double-press ───────────────────────────────────────────────────
    await run('double-press: the first press arms and does nothing else', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      assert(app.calls.stop.length === 0 && app.calls.pause.length === 0,
        'the first press must not stop anything');
      // The ambiguity this preset has to answer: a lone press does NOT fall
      // through to the idle behaviour, so a draft typed mid-run survives it.
      assert(app.calls.cleared === 0, 'the first press must not clear the prompt');
      assert(isDoublePressArmed(), 'the first press should arm the gesture');
      assert(cue(), 'an armed gesture should show its "press again" cue');
    });

    await run('double-press: the second press stops and disarms', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      press(app, { threadId: 'thr_2' });
      assert(app.calls.stop.length === 1 && app.calls.stop[0] === 'thr_2',
        'the second press should hard-cancel from its own vantage');
      assert(!isDoublePressArmed(), 'stopping should disarm the gesture');
      assert(!cue(), 'the cue should go with the gesture');
      assert(app.calls.cleared === 0, 'stopping must not touch the prompt');
    });

    await run('double-press: any other input disarms', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      assert(!isDoublePressArmed(), 'typing should disarm the gesture');
      assert(!cue(), 'the cue should be removed on disarm');
      press(app);
      assert(app.calls.stop.length === 0, 'a re-armed first press must not stop');
      assert(isDoublePressArmed(), 'the press after a disarm re-arms');
      document.dispatchEvent(new Event('pointerdown'));
      assert(!isDoublePressArmed(), 'a pointer press should disarm the gesture');
    });

    await run('double-press: a press racing the turn\u2019s end is swallowed, not a clear', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      assert(isDoublePressArmed(), 'armed against the running turn');
      // The turn ends between the two presses: the second must NOT fall through
      // to the idle rung and wipe the draft — the very failure the preset exists
      // to prevent, arriving by the back door.
      app.running = false;
      const acted = press(app);
      assert(acted, 'the stale second press should be swallowed as handled');
      assert(app.calls.cleared === 0, 'a swallowed press must not clear the prompt');
      assert(!isDoublePressArmed(), 'the stale gesture should be dropped');
    });

    await run('switching preset mid-gesture drops the armed state', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      assert(isDoublePressArmed(), 'armed before the switch');
      setEscapePreset('stop');
      assert(!isDoublePressArmed(), 'a preset switch must not strand an armed gesture');
      assert(!cue(), 'the cue should go with it');
    });

    // ── clear-only / inert ─────────────────────────────────────────────
    await run('clear-only: never stops, clears whether running or idle', () => {
      setEscapePreset('clear-only');
      app.running = true;
      press(app);
      assert(app.calls.stop.length === 0, 'this preset must never hard-cancel on the plain key');
      // Stopping isn't bound to the key at all here, so clearing mid-run is
      // unambiguous rather than destructive.
      assert(app.calls.cleared === 1, 'a running press should clear the prompt');
      app.running = false;
      press(app);
      assert(app.calls.cleared === 2, 'an idle press should clear the prompt');
      press(app, { shift: true });
      assert(app.calls.pause.length === 0, 'idle Shift+Escape has nothing to pause');
      app.running = true;
      press(app, { shift: true });
      assert(app.calls.pause.length === 1, 'Shift+Escape keeps a route to a clean stop');
    });

    await run('inert: leaves the turn and the prompt alone', () => {
      setEscapePreset('inert');
      app.running = true;
      press(app);
      app.running = false;
      press(app);
      assert(app.calls.stop.length === 0 && app.calls.cleared === 0,
        'this preset should do nothing on either rung');
      app.running = true;
      press(app, { shift: true });
      assert(app.calls.pause.length === 1, 'Shift+Escape still pauses');
    });

    // ── guard rails shared by every preset ─────────────────────────────
    await run('auto-repeat never fires the gesture', () => {
      for (const id of ['stop', 'two-step', 'double-press']) {
        setEscapePreset(id);
        app = stubApp();
        /** @type {any} */ (window).jugglerApp = app;
        app.running = true;
        press(app, { repeat: true });
        assert(app.calls.stop.length === 0 && app.calls.pause.length === 0,
          `${id}: a held Escape must not stop the turn`);
        assert(!isDoublePressArmed(), `${id}: a held Escape must not arm anything`);
      }
    });

    // ── the settings control ───────────────────────────────────────────
    await run('the settings row reflects and writes the preference', () => {
      setEscapePreset('stop');
      const row = buildEscapeBehaviourRow();
      const select = /** @type {HTMLSelectElement} */ (row.querySelector('select'));
      const desc = /** @type {HTMLElement} */ (row.querySelector('.provider-description'));
      assert(select && select.options.length === ESCAPE_PRESETS.length,
        'every preset should be offered');
      assert(select.value === 'stop', 'the picker should open on the stored preset');
      select.value = 'two-step';
      select.dispatchEvent(new Event('change'));
      assert(getEscapePreset().id === 'two-step', 'choosing a preset should store it');
      assert(desc.textContent === describeEscapePreset(getEscapePreset()),
        'the description should follow the choice');
    });
  } finally {
    resetEscapeGesture();
    void setUserPref(PREF_KEY, priorPref);
    if (priorApp === undefined) delete (/** @type {any} */ (window).jugglerApp);
    else /** @type {any} */ (window).jugglerApp = priorApp;
  }

  return { passed, failed, errors };
}

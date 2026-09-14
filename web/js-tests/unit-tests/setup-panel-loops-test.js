//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The setup panel must not drive itself.
 *
 * The panel is a view of state that drawing it also writes to: a provider's form
 * reports what it says as it is built, and the speculative sweep records what it
 * found. Both raise a setup notification, and what listens to that notification
 * is the pass that draws the panel. None of the three is wrong alone; together
 * they closed a circle that ran until the stack ended.
 *
 * Each case pins one place the circle is broken, so that one of them coming back
 * does not restore it: the panel is seated before it is drawn, a sweep that
 * found what it found last time stays quiet, and a form reporting an unchanged
 * reading is not news.
 * @module unit-tests/setup-panel-loops-test
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  NEW_ROW_PREFIX,
  selectSetupRow,
  setSetupValues,
  subscribeSetup,
  probeSetupAdoptions
} from '../../js/services/conversation-setup.js';
import { ensureConversationChrome } from '../../js/components/conversation-area-rendering.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';

/**
 * How many redraws of one panel is a runaway rather than a redraw.
 *
 * The count is the assertion; the ceiling only stops a regression running away
 * with the lane. Every lane in a window shares one heap and one main thread, so
 * a test that reproduces an unbounded loop to exhaustion takes its siblings with
 * it — this one reports the runaway instead of finishing it.
 */
const REDRAW_LIMIT = 20;

/**
 * A provider that counts what is asked of it.
 *
 * It needs no filesystem and answers instantly: every case here is about how
 * often the host asks, not what the answer is.
 */
class LoopProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'loop-fixture-provider',
    name: 'Somewhere that counts',
    version: '1.0.0',
    description: 'Counts the forms it is asked for and the sweeps it is asked to do'
  };

  /** @type {number} How many forms of this provider have been built. */
  static forms = 0;

  /**
   * What it says exists. Deliberately the same object every sweep: a second
   * answer identical to the first is the case the quiet is for.
   * @type {any}
   */
  static report = {
    orphanedWorkspaces: [],
    orphanedArtifacts: [{
      id: 'loop-artifact',
      label: 'something that exists',
      detail: 'and has no row',
      workspace: { root: '/nowhere/loop-fixture', kind: 'local' }
    }],
    confirmed: []
  };

  /**
   * One field is enough: the host reports the form as it builds it, whether or
   * not anything has been typed into it.
   * @param {HTMLElement} container - The panel section's body.
   */
  renderSetup(container) {
    LoopProvider.forms++;
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'loop-dir';
    field.value = '';
    container.appendChild(field);
    this._field = field;
  }

  /**
   * @returns {any} What the form says, and whether Create may be pressed.
   */
  getSetupValue() {
    const dir = this._field?.value ?? '';
    return dir
      ? { valid: true, values: { dir } }
      : { valid: false, values: {}, invalidFieldId: 'loop-dir' };
  }

  /**
   * @returns {Promise<any>} The same finding as last time.
   */
  async reconcile() {
    return LoopProvider.report;
  }
}

/**
 * A conversation nobody has told where it works.
 * @param {any} session - The test session.
 * @param {string} name - Conversation name.
 * @returns {Promise<any>} The conversation.
 */
async function makeConversation(session, name) {
  const id = await session.createConversation(name, { initialise: false });
  const conversation = session.conversations.get(id);
  if (!conversation) throw new Error(`conversation ${id} was created but is not in the session`);
  return conversation;
}

/**
 * The top of a column's item list, as `conversation-area` builds it.
 * @param {any} conversation - The conversation the column shows.
 * @returns {{area: any, list: HTMLElement}} A stub column and its list.
 */
function columnFor(conversation) {
  const list = document.createElement('div');
  list.appendChild(document.createElement('conversation-footer'));
  const area = {
    _conversation: conversation,
    _messageThread: conversation?.rootMessageThread,
    _threadYMap: null,
    _isGroupColumn: false
  };
  return { area, list };
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

  /** @type {any} */
  let session = null;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  // The only provider in the lane, so that a sweep asks this fixture rather than
  // the real ones — which would put git and the filesystem between the test and
  // the thing it is measuring, and answer differently on different machines.
  workspaceProviderRegistry.reset();
  workspaceProviderRegistry.registerClass(LoopProvider, { extensionId: 'test', modulePath: '(test)' });

  try {
    session = await createTestSession();

    await run('a panel drawn for the first time is drawn once', async () => {
      // The circle in full: the form reports itself as it is built, the report
      // reaches the listener that redraws this block, and the redraw arrives
      // while the panel it would find is still being built. Every guard against
      // redundant work is per-element, so a pass that builds a second element
      // has released all of them at once.
      const conversation = await makeConversation(session, 'draws-once');
      release(conversation);
      const { area, list } = columnFor(conversation);
      document.body.appendChild(list);

      selectSetupRow(conversation, `${NEW_ROW_PREFIX}${LoopProvider.MANIFEST.id}`);
      LoopProvider.forms = 0;

      // What `conversation-area` does with a setup notification, and the other
      // half of the circle.
      let redraws = 0;
      const unsubscribe = subscribeSetup(() => {
        redraws++;
        if (redraws > REDRAW_LIMIT) return;
        ensureConversationChrome(area, list);
      });

      try {
        ensureConversationChrome(area, list);

        const panels = list.querySelectorAll('conversation-setup-panel').length;
        assert(panels === 1, `the column holds one panel, got ${panels}`);
        assert(redraws <= REDRAW_LIMIT,
          `and drawing it does not ask to draw it again without end, got ${redraws} redraws`);
        assert(LoopProvider.forms === 1,
          `so the form is built once rather than rebuilt on its own report, got ${LoopProvider.forms}`);
      } finally {
        unsubscribe();
        list.remove();
      }
    });

    await run('a sweep that found what it found last time says nothing', async () => {
      // The panel sweeps as it opens and the sweep announces itself, which
      // redraws the panel, which sweeps. The break is at the announcement: a
      // second answer identical to the first is not an answer worth repeating.
      await probeSetupAdoptions(session);

      let told = 0;
      const unsubscribe = subscribeSetup(() => { told++; });
      try {
        await probeSetupAdoptions(session);
        assert(told === 0,
          `a second sweep over an unchanged tree tells nobody, got ${told} notification(s)`);
      } finally {
        unsubscribe();
      }
    });

    await run('a form reporting an unchanged reading tells nobody', async () => {
      // The form reports on every edit and on the build before the first one.
      // What it says is worth passing on; that it has said it again is not.
      const conversation = await makeConversation(session, 'says-it-twice');
      release(conversation);
      selectSetupRow(conversation, `${NEW_ROW_PREFIX}${LoopProvider.MANIFEST.id}`);
      setSetupValues(conversation, { valid: true, values: { dir: '/somewhere' } });

      let told = 0;
      const unsubscribe = subscribeSetup(() => { told++; });
      try {
        setSetupValues(conversation, { valid: true, values: { dir: '/somewhere' } });
        assert(told === 0,
          `the same reading a second time is not news, got ${told} notification(s)`);

        setSetupValues(conversation, { valid: true, values: { dir: '/somewhere else' } });
        assert(told === 1,
          `and a reading that moved still is, got ${told} notification(s)`);

        setSetupValues(conversation, { valid: false, values: { dir: '/somewhere else' }, invalidFieldId: 'loop-dir' });
        assert(told === 2,
          `as does the same values turning unusable, got ${told} notification(s)`);
      } finally {
        unsubscribe();
      }
    });
  } finally {
    if (session) {
      for (const id of created) {
        await releaseTestConversation(session, id, 'setup-panel-loops-test');
      }
    }
  }

  return { passed, failed, errors };
}

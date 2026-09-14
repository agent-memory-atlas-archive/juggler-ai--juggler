//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Clicking into a setup field must leave the caret in it.
 *
 * The setup card is drawn in the welcome slot, which is inside the column's
 * message-list wrapper — the same wrapper that treats a click landing on
 * nothing selectable as "the user clicked the background", deselects, and sends
 * focus to the message box so the next keystroke composes. That rule predates
 * the card, and it reads every field on it as background: the press puts the
 * caret in the field, the click that follows takes it straight back out, and
 * the workspace cannot be named at all.
 *
 * Two cases, because the guard that fixes it is worth nothing if it is too
 * broad. A press on a control inside the column keeps what it focused; a press
 * on the actual background still hands the keyboard to the message box.
 * @module unit-tests/setup-field-focus-test
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import {
  NEW_ROW_PREFIX,
  selectSetupRow
} from '../../js/services/conversation-setup.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import '../../js/components/conversation-tab.js';
import '../../js/components/conversation-setup-panel.js';

/**
 * A provider whose form is one text field.
 *
 * The real ones ask git and the filesystem where they could work, which would
 * put both between this test and the one thing it measures — where the caret is
 * after a click.
 */
class FieldProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'field-focus-provider',
    name: 'Somewhere to type',
    version: '1.0.0',
    description: 'Asks for one name and nothing else'
  };

  /**
   * @param {HTMLElement} container - The panel section's body.
   */
  renderSetup(container) {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'field-focus-name';
    field.className = 'setup-field-input';
    container.appendChild(field);
    this._field = field;
  }

  /**
   * @returns {any} What the form says, and whether Create may be pressed.
   */
  getSetupValue() {
    const name = this._field?.value ?? '';
    return name
      ? { valid: true, values: { name } }
      : { valid: false, values: {}, invalidFieldId: 'field-focus-name' };
  }
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

  // The only provider in the lane, so the card offers exactly one row and the
  // sweep asks a fixture rather than the machine this is running on.
  workspaceProviderRegistry.reset();
  workspaceProviderRegistry.registerClass(FieldProvider, { extensionId: 'test', modulePath: '(test)' });

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let session = null;
  /** @type {string} */
  let conversationId = '';

  try {
    session = await createTestSession();
    conversationId = await session.createConversation('setup-field-focus', { initialise: false });
    const conversation = session.conversations.get(conversationId);
    assert(!!conversation, 'the conversation was created but is not in the session');

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    await waitFor(
      () => !!tab.querySelector('composer-box textarea'),
      { description: "the active tab's message box to build" }
    );
    const textarea = /** @type {HTMLTextAreaElement} */ (tab.querySelector('composer-box textarea'));
    const column = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!column, 'the tab should have a conversation-area column');

    await waitFor(
      () => !!column.querySelector('conversation-setup-panel'),
      { description: 'the setup card to arrive in the welcome slot' }
    );

    // Open the provider's form, as clicking its row does.
    selectSetupRow(conversation, `${NEW_ROW_PREFIX}${FieldProvider.MANIFEST.id}`);
    await waitFor(
      () => !!column.querySelector('.setup-row-body input'),
      { description: "the provider's field to be built" }
    );
    const field = /** @type {HTMLInputElement} */ (column.querySelector('.setup-row-body input'));

    // A column that has just been built re-asserts focus into the message box
    // for ~150ms whenever focus falls to <body>. Let that window lapse first,
    // or it answers for the rule under test.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // --- A click into a field leaves the caret in it ---

    // What a real press does, in order: focus lands on the field, then the
    // click bubbles to the wrapper and the wrapper decides what it was.
    field.focus();
    assert(document.activeElement === field,
      'test setup: focusing the field did not take, so nothing below is measuring a theft');
    field.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const landed = /** @type {HTMLElement|null} */ (document.activeElement);
    assert(landed === field,
      'clicking into a setup field must leave the caret in it, but focus went to ' +
      `<${landed?.tagName?.toLowerCase() ?? 'nothing'}${landed?.id ? `#${landed.id}` : ''}> — ` +
      'the column read the card as its own background and sent the keyboard to the message box');

    // --- A click on the actual background still hands over the keyboard ---

    const scroller = /** @type {HTMLElement} */ (column.querySelector('#message-list'));
    assert(!!scroller, 'the column should have a scroller to click the background of');
    scroller.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(document.activeElement === textarea,
      'a click on the column background should still focus the message box, but focus is on ' +
      `<${/** @type {HTMLElement|null} */ (document.activeElement)?.tagName?.toLowerCase() ?? 'nothing'}> — ` +
      'the guard for the card has been drawn too wide');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    container.remove();
    if (session && conversationId) {
      await releaseTestConversation(session, conversationId, 'setup-field-focus-test');
    }
  }

  return { passed, failed, errors };
}

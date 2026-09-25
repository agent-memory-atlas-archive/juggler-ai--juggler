//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the dialog that asks for a commit message has to say for itself.
 *
 * The thing under test is a field with a name on it and two buttons that each
 * state their outcome. It replaced a bare box under a paragraph of policy, where
 * the only clue to what to type was the phrase "the message" in a sentence about
 * what happened if you typed nothing — and where an empty box silently meant a
 * different ending from a full one.
 *
 * So the assertions are about naming, not plumbing: that the field has a real
 * `<label>` bound to it, that each button resolves to the ending written on it,
 * and that a blank field can no longer stand in for a decision.
 * @module unit-tests/workspace-finish-dialog-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { openWorkspaceFinish } from '../../js/components/workspace-finish-dialog.js';

/** The commit row as the git worktree provider declares it. */
const COMMIT_OPTION = {
  id: 'commit',
  label: 'Commit the changes',
  keepsWorkspace: true,
  description: 'Commits everything here onto onboarding. You carry on working in this workspace either way.',
  prompt: {
    label: 'Message',
    placeholder: 'What changed, in a line',
    multiline: true,
    requiresWork: true,
    hint: 'Describe the work, not the files.',
    alternative: {
      label: 'Let this conversation write it',
      hint: 'It has read the work; the commit happens on its next turn.'
    }
  }
};

/** A tree with work in it, and what that work is. */
const DIRTY = {
  label: 'onboarding',
  detail: 'branch onboarding · 3 changed',
  dirty: true,
  files: [
    { path: 'src/auth.js', state: 'Modified' },
    { path: 'src/session.js', state: 'Modified' },
    { path: 'notes.md', state: 'Untracked' }
  ]
};

/**
 * Stands in for the conversation an ending is carried out for. Only its
 * presence is read here: an alternative hands the work to it.
 */
const SOMEBODY = { id: 'conv_actor', name: 'Auth flow' };

/**
 * The dialog, once it is on screen.
 * @param {any} [status] - What the host knows about the tree.
 * @param {any} [option] - The ending being carried out.
 * @param {any} [conversation] - Who it is being done for, or null for nobody.
 * @returns {Promise<{answer: Promise<any>, root: HTMLElement}>} The pending answer and the overlay.
 */
async function open(status = DIRTY, option = COMMIT_OPTION, conversation = SOMEBODY) {
  const answer = openWorkspaceFinish(option, { status, conversation });
  await waitFor(
    () => !!document.querySelector('.workspace-finish-overlay [role="dialog"]'),
    { description: 'the finish dialog to be presented' }
  );
  const root = /** @type {HTMLElement} */ (document.querySelector('.workspace-finish-overlay'));
  return { answer, root };
}

/**
 * @param {HTMLElement} root - The overlay.
 * @param {string} selector - What to press.
 */
function press(root, selector) {
  const button = /** @type {HTMLButtonElement|null} */ (root.querySelector(selector));
  assert(!!button, `the dialog should offer ${selector}`);
  assert(!button.disabled, `${selector} should be pressable`);
  button.click();
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => Promise<void>} body - The check.
   */
  const check = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // A case that threw mid-dialog must not leave it over the next one.
      document.querySelector('.workspace-finish-overlay')?.remove();
    }
  };

  await check('the field is named by a real label', async () => {
    const { answer, root } = await open();

    const field = /** @type {HTMLElement|null} */ (root.querySelector('.setup-field-input'));
    assert(!!field, 'the dialog should have a field to type the message into');
    assert(!!field.id, 'the field needs an id for a label to be bound to');

    const label = /** @type {HTMLLabelElement|null} */ (root.querySelector('label.setup-field-label'));
    assert(!!label, 'the field must have a real <label> — the old dialog had none, which is the whole bug');
    assert(label.htmlFor === field.id,
      `the label must be bound to the field, but htmlFor is "${label.htmlFor}" and the field is "${field.id}"`);
    assert(label.textContent?.trim() === 'Message',
      `the label should say what the box holds, but it says "${label.textContent?.trim()}"`);

    assert(field.tagName === 'TEXTAREA', 'a multiline prompt should take more than one line');
    assert(/** @type {HTMLTextAreaElement} */ (field).placeholder === COMMIT_OPTION.prompt.placeholder,
      'the empty field should show the declared placeholder');

    const note = /** @type {HTMLElement|null} */ (root.querySelector('.setup-field-note'));
    assert(note?.textContent?.includes('Describe the work'),
      'the hint belongs under the field, where it is read while typing');

    press(root, '.workspace-finish-cancel');
    assert(await answer === null, 'cancelling should answer with nothing');
  });

  await check('typing a message and committing answers with it', async () => {
    const { answer, root } = await open();
    const field = /** @type {HTMLTextAreaElement} */ (root.querySelector('.setup-field-input'));

    field.value = 'Tightened the worktree finish dialog';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    press(root, '.workspace-finish-commit');
    const result = await answer;
    assert(result?.message === 'Tightened the worktree finish dialog',
      `the typed message should come back verbatim, but got ${JSON.stringify(result)}`);
  });

  await check('the alternative answers empty, which is the ending it names', async () => {
    const { answer, root } = await open();

    const alternative = /** @type {HTMLButtonElement|null} */ (
      root.querySelector('.workspace-finish-alternative'));
    assert(!!alternative, 'a prompt declaring an alternative must offer it as its own button');
    assert(alternative.textContent?.includes('Let this conversation write it'),
      'the alternative button must say what it does, not "OK"');

    press(root, '.workspace-finish-alternative');
    const result = await answer;
    assert(result?.message === '',
      `the alternative runs the ending with nothing typed, but got ${JSON.stringify(result)}`);
  });

  await check('an empty field cannot be committed by the primary button', async () => {
    const { answer, root } = await open();

    const commit = /** @type {HTMLButtonElement} */ (root.querySelector('.workspace-finish-commit'));
    assert(commit.disabled,
      'with nothing typed the primary must be disabled — a blank field standing for a second, '
      + 'unrelated ending is the ambiguity this dialog exists to remove');

    const field = /** @type {HTMLTextAreaElement} */ (root.querySelector('.setup-field-input'));
    field.value = '   ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    assert(commit.disabled, 'whitespace is not a commit message');

    field.value = 'Real message';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    assert(!commit.disabled, 'a typed message should enable the primary');

    press(root, '.workspace-finish-cancel');
    await answer;
  });

  await check('a clean tree says so instead of letting git say it', async () => {
    const clean = { label: 'onboarding', detail: 'branch onboarding · clean', dirty: false };
    const { answer, root } = await open(clean);

    const commit = /** @type {HTMLButtonElement} */ (root.querySelector('.workspace-finish-commit'));
    const field = /** @type {HTMLTextAreaElement} */ (root.querySelector('.setup-field-input'));
    field.value = 'Nothing to say';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    assert(commit.disabled,
      'with nothing changed there is nothing to commit, and the dialog should refuse rather than '
      + 'run git and relay its complaint afterwards');
    assert(root.textContent?.includes('Nothing has changed'),
      'the dialog should say why it will not commit');

    press(root, '.workspace-finish-cancel');
    assert(await answer === null, 'cancelling a clean tree should answer with nothing');
  });

  await check('what is about to be committed is on screen', async () => {
    const { answer, root } = await open();
    assert(root.textContent?.includes('branch onboarding · 3 changed'),
      "the tree's own status belongs in the dialog — it names which of several checkouts this is");
    assert(root.textContent?.includes(COMMIT_OPTION.description),
      'the ending should still say what it does');
    press(root, '.workspace-finish-cancel');
    await answer;
  });

  await check('every file the commit will take is listed', async () => {
    // The commit is `git add -A`: it takes the whole tree, including whatever
    // the agent left lying about while nobody was reading. A message box over a
    // count is not consent to that — the reader is agreeing to a number.
    const { answer, root } = await open();

    const rows = Array.from(root.querySelectorAll('.workspace-finish-work-row'));
    assert(rows.length === 3,
      `one row per file that is about to be committed, got ${rows.length}`);
    const said = rows.map((row) => row.textContent ?? '').join('|');
    assert(said.includes('src/auth.js') && said.includes('notes.md'),
      `naming them, got ${JSON.stringify(said)}`);
    assert(said.includes('Untracked'),
      `and saying what is happening to each — a file git has never seen is the one most worth `
      + `spotting in this list, got ${JSON.stringify(said)}`);

    const count = root.querySelector('.workspace-finish-work-count')?.textContent ?? '';
    assert(count.includes('3 files'),
      `with the total said in words above them, got ${JSON.stringify(count)}`);

    press(root, '.workspace-finish-cancel');
    await answer;
  });

  await check('a list that is only the beginning of it says so', async () => {
    // The server caps how many files it will name, and a list that quietly
    // stopped would be read as the whole of what is about to be committed.
    const many = {
      ...DIRTY,
      detail: 'branch onboarding · 312 changed',
      fileCount: 312
    };
    const { answer, root } = await open(many);

    const count = root.querySelector('.workspace-finish-work-count')?.textContent ?? '';
    assert(count.includes('312'),
      `the count is what is really being committed, not the length of the list, got ${JSON.stringify(count)}`);
    assert((root.textContent ?? '').includes('309 more'),
      'and the list says how much of it is not on screen');

    press(root, '.workspace-finish-cancel');
    await answer;
  });

  await check('the primary button says the act, not the sentence', async () => {
    const { answer, root } = await open(DIRTY, {
      ...COMMIT_OPTION,
      prompt: { ...COMMIT_OPTION.prompt, confirmLabel: 'Commit' }
    });

    const commit = /** @type {HTMLButtonElement} */ (root.querySelector('.workspace-finish-commit'));
    assert(commit.textContent?.trim() === 'Commit',
      `three buttons in a row are read as a row, and "Commit the changes" beside "Let this `
      + `conversation write it" is a wall, got ${JSON.stringify(commit.textContent)}`);

    const alternative = /** @type {HTMLElement} */ (root.querySelector('.workspace-finish-alternative'));
    assert(alternative.textContent?.includes(COMMIT_OPTION.prompt.alternative.hint),
      'and what the alternative does is on the alternative, not stranded under the row of buttons');

    press(root, '.workspace-finish-cancel');
    await answer;
  });

  await check('with nobody to hand the work to, the alternative is not offered', async () => {
    // The same ending, asked for of the workspace itself: a box three
    // conversations share names none of them, so "Let this conversation write
    // it" has no conversation to mean. Offering it anyway would be a button
    // whose outcome is that nothing happens — and the field is the whole
    // answer without it, which is the shape this dialog was written for.
    const { answer, root } = await open(DIRTY, COMMIT_OPTION, null);

    assert(!root.querySelector('.workspace-finish-alternative'),
      'an alternative that hands work to a conversation must not be offered when there is none');
    assert(!root.textContent?.includes(COMMIT_OPTION.prompt.alternative.hint),
      'nor its hint, which explains a button that is not there');

    const field = /** @type {HTMLTextAreaElement} */ (root.querySelector('.setup-field-input'));
    field.value = 'Committed from the box';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    press(root, '.workspace-finish-commit');
    assert((await answer)?.message === 'Committed from the box',
      'typing a message must still be a way through');
  });

  await check('a prompt with no alternative offers no second button', async () => {
    const bare = {
      id: 'name-it',
      label: 'Name it',
      prompt: { label: 'Name', hint: 'Whatever you like.' }
    };
    const { answer, root } = await open(DIRTY, bare);

    assert(!root.querySelector('.workspace-finish-alternative'),
      'an undeclared alternative must not be invented by the host');
    const field = /** @type {HTMLElement} */ (root.querySelector('.setup-field-input'));
    assert(field.tagName === 'INPUT', 'a prompt that is not multiline takes a single line');

    press(root, '.workspace-finish-cancel');
    assert(await answer === null, 'cancelling should answer with nothing');
  });

  return { passed, failed, errors };
}

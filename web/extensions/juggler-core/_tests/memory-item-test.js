//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory context-item tests.
 *
 * Exercises the `memory` context item against the REAL backend filesystem: the
 * `memory` tool's remember/forget actions mutate an on-disk MEMORY.md, that file
 * is the single source of truth for the STORE, and the block a conversation
 * injects is the snapshot frozen into the doc at seed time — so a write made
 * anywhere else can never move an existing conversation's cached system prefix.
 * Each sub-test points the item at its own isolated path under the fixture so
 * sibling pool lanes never collide (the production path is the fixed
 * `.juggler/MEMORY.md`).
 * @module unit-tests/memory-item-test
 */

import MemoryContextItem from '../context-items/memory-context-item.js';
import { readFileLoad } from '../../../js/services/ops-api.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const TODAY = new Date().toISOString().split('T')[0];

/**
 * Run memory context-item tests.
 * @param {{fixtureDir: string}} ctx - Test context with fixtureDir
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const base = `${ctx.fixtureDir}/_memory_test`;
  let pathCounter = 0;

  /**
   * Build a memory item pointed at a fresh isolated file path.
   * @returns {{item: MemoryContextItem, path: string}} The constructed memory item and its file path.
   */
  function makeItem() {
    const path = `${base}/m${++pathCounter}/MEMORY.md`;
    const item = new MemoryContextItem({
      id: `MEM_test_${pathCounter}`,
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });
    item.data.path = path;
    return { item, path };
  }

  /**
   * @param {string} path
   * @returns {Promise<string>} File content, or '' if absent
   */
  async function readBack(path) {
    try {
      const r = await readFileLoad({ path });
      return r && typeof r.content === 'string' ? r.content : '';
    } catch {
      return '';
    }
  }

  // ---- remember ----

  await test('remember writes a dated bullet under the heading', async () => {
    const { item, path } = makeItem();
    await item.execute({ action: 'remember', fact: 'Build is `make build`' });
    const content = await readBack(path);
    assert(content.includes('# Memory'), `missing heading:\n${content}`);
    assert(content.includes(`- [${TODAY}] Build is \`make build\``), `missing dated entry:\n${content}`);
  });

  await test('remember appends, preserving earlier entries in order', async () => {
    const { item, path } = makeItem();
    await item.execute({ action: 'remember', fact: 'first fact' });
    await item.execute({ action: 'remember', fact: 'second fact' });
    const content = await readBack(path);
    const iFirst = content.indexOf('first fact');
    const iSecond = content.indexOf('second fact');
    assert(iFirst !== -1 && iSecond !== -1, `both entries should persist:\n${content}`);
    assert(iFirst < iSecond, `order should be preserved (first before second):\n${content}`);
  });

  // ---- forget ----

  await test('forget removes the matching entry, leaves others', async () => {
    const { item, path } = makeItem();
    await item.execute({ action: 'remember', fact: 'Build is `make build`' });
    await item.execute({ action: 'remember', fact: 'Username is jules' });
    const outcome = await item.execute({ action: 'forget', match: 'jules' });
    const content = await readBack(path);
    assert(!content.includes('jules'), `forgotten entry should be gone:\n${content}`);
    assert(content.includes('make build'), `other entry should remain:\n${content}`);
    assert(Array.isArray(outcome.removed) && outcome.removed.length === 1, `removed should report 1, got ${JSON.stringify(outcome.removed)}`);
  });

  await test('forget with no match is a no-op (removes nothing)', async () => {
    const { item, path } = makeItem();
    await item.execute({ action: 'remember', fact: 'only fact' });
    const outcome = await item.execute({ action: 'forget', match: 'nonexistent' });
    const content = await readBack(path);
    assert(content.includes('only fact'), `nothing should be removed:\n${content}`);
    assert(Array.isArray(outcome.removed) && outcome.removed.length === 0, `removed should be empty, got ${JSON.stringify(outcome.removed)}`);
  });

  // ---- createContextText ----

  await test('createContextText contributes nothing when memory is empty/absent', async () => {
    const { item } = makeItem();
    const text = await item.createContextText({ helpers: {} });
    assert(text === '', `absent memory should contribute empty string, got: ${JSON.stringify(text)}`);
  });

  await test('createContextText renders a labeled block with entries', async () => {
    const { item } = makeItem();
    await item.execute({ action: 'remember', fact: 'Build is `make build`' });
    await item.onToolCall('memory', {});
    const text = await item.createContextText({ helpers: {} });
    assert(text.includes('=== Project Memory ==='), `should carry the labeled header, got:\n${text}`);
    assert(text.includes('Build is `make build`'), `should include the entry, got:\n${text}`);
  });

  await test('createContextText falls back to a live read when never seeded', async () => {
    const { item } = makeItem();
    await item.execute({ action: 'remember', fact: 'unseeded fallback' });
    assert(!Array.isArray(item.data.entries), 'this item must be unseeded for the fallback to be under test');
    const text = await item.createContextText({ helpers: {} });
    assert(text.includes('unseeded fallback'), `unseeded item should read the file live, got:\n${text}`);
  });

  // ---- the freeze (cache contract) ----

  await test('onToolCall freezes the current entries into the doc data', async () => {
    const { item } = makeItem();
    await item.execute({ action: 'remember', fact: 'frozen fact' });
    await item.onToolCall('memory', {});
    assert(Array.isArray(item.data.entries), `seeding should record a snapshot array, got: ${JSON.stringify(item.data.entries)}`);
    assert(item.data.entries.length === 1, `snapshot should hold 1 entry, got ${item.data.entries.length}`);
    assert(item.data.entries[0].text === 'frozen fact', `snapshot text: ${JSON.stringify(item.data.entries[0])}`);
    assert(item.data.entries[0].date === TODAY, `snapshot date should be stamped: ${JSON.stringify(item.data.entries[0])}`);
  });

  await test('onToolCall is write-once — re-seeding keeps the original snapshot', async () => {
    const { item } = makeItem();
    await item.execute({ action: 'remember', fact: 'original' });
    await item.onToolCall('memory', {});
    await item.execute({ action: 'remember', fact: 'added later' });
    await item.onToolCall('memory', {});
    assert(item.data.entries.length === 1, `re-seeding must not re-snapshot, got ${item.data.entries.length} entries`);
    assert(item.data.entries[0].text === 'original', `snapshot should still be the original: ${JSON.stringify(item.data.entries)}`);
  });

  await test('a write made elsewhere leaves the injected block byte-identical', async () => {
    const { item, path } = makeItem();
    await item.execute({ action: 'remember', fact: 'known at start' });
    await item.onToolCall('memory', {});
    const before = await item.createContextText({ helpers: {} });

    // Another conversation (or a hand edit) rewrites the store underneath us.
    await item._write(path, `# Memory\n\n- [${TODAY}] known at start\n- [${TODAY}] added by someone else\n`);

    const after = await item.createContextText({ helpers: {} });
    assert(after === before, `an external write must not move this conversation's block:\n--- before ---\n${before}\n--- after ---\n${after}`);
    assert(!after.includes('added by someone else'), `the later fact must not leak into this conversation:\n${after}`);
  });

  await test('a forget elsewhere does not retract the block mid-conversation', async () => {
    const { item, path } = makeItem();
    await item.execute({ action: 'remember', fact: 'fact one' });
    await item.execute({ action: 'remember', fact: 'fact two' });
    await item.onToolCall('memory', {});
    const before = await item.createContextText({ helpers: {} });

    await item._write(path, `# Memory\n\n- [${TODAY}] fact one\n`);

    const after = await item.createContextText({ helpers: {} });
    assert(after === before, `an external forget must not move this conversation's block:\n--- before ---\n${before}\n--- after ---\n${after}`);
  });

  // ---- transient-read resilience (last-known-good) ----

  await test('_read returns "" for a genuinely absent file (stat confirms exists:false)', async () => {
    const { item, path } = makeItem();
    const content = await item._read(path);
    assert(content === '', `absent file should read as empty string, got: ${JSON.stringify(content)}`);
  });

  await test('_read serves last-known-good on a transient read failure of an existing file', async () => {
    const { item, path } = makeItem();
    await item._write(path, 'FACT');
    const first = await item._read(path);
    assert(first === 'FACT', `seed read should return the file content, got: ${JSON.stringify(first)}`);

    // Simulate a transient read blip: an already-aborted signal makes
    // readFile throw, while the unsignalled stat in _fileAbsent still
    // confirms the file exists — so _read must serve the cached last-good.
    const ac = new AbortController();
    ac.abort();
    item.signal = ac.signal;
    const second = await item._read(path);
    assert(second === 'FACT', `transient read failure on an existing file must serve last-known-good, got: ${JSON.stringify(second)}`);
  });

  await test('last-known-good never crosses a project switch for the relative default path', async () => {
    // The production path is relative, and the engine — with this module's
    // cache — outlives a project switch while the server re-resolves the path
    // against the new project. So the same path string names a different file
    // after a switch, and the previous project's facts must not be served for it.
    const root = session.projectPath;
    assert(root && (ctx.fixtureDir === root || ctx.fixtureDir.startsWith(`${root}/`)),
      `precondition: the fixture (${ctx.fixtureDir}) must be, or sit under, the session's project (${root})`);
    const fixtureRel = ctx.fixtureDir === root ? '' : `${ctx.fixtureDir.slice(root.length + 1)}/`;
    const rel = `${fixtureRel}_memory_test/rel${++pathCounter}-${Date.now()}/MEMORY.md`;

    /**
     * An item whose session reports `projectPath`, reading the relative file.
     * @param {string} projectPath - The project the item's session believes is open
     * @returns {MemoryContextItem} The item
     */
    const itemIn = (projectPath) => new MemoryContextItem({
      id: `MEM_test_switch_${++pathCounter}`,
      session: Object.assign(Object.create(session), { projectPath }),
      conversation,
      messageThread: conversation.rootMessageThread
    });
    const blip = () => { const ac = new AbortController(); ac.abort(); return ac.signal; };

    const before = itemIn(root);
    await before._write(rel, 'PREVIOUS PROJECT FACT');
    before.signal = blip();
    const same = await before._read(rel);
    assert(same === 'PREVIOUS PROJECT FACT',
      `a blip within one project must still serve its last-known-good, got ${JSON.stringify(same)}`);

    // After the switch the server resolves `rel` in the new project, where the
    // file exists (here, the same file on disk stands in for it) and the read blips.
    const after = itemIn(`${root}-another-project`);
    after.signal = blip();
    const crossed = await after._read(rel);
    assert(crossed !== 'PREVIOUS PROJECT FACT',
      'the previous project\'s memory was served as the new project\'s last-known-good — the next remember would write it into the new project');
  });

  await test('unseeded memory block survives a transient read blip via createContextText', async () => {
    // A seeded item never reads during assembly, so this covers the unseeded
    // fallback path — the one place a read blip could still drop the block.
    const { item } = makeItem();
    await item.execute({ action: 'remember', fact: 'Build is `make build`' });
    const before = await item.createContextText({ helpers: {} });
    assert(before.includes('=== Project Memory ===') && before.includes('Build is `make build`'), `seed assembly should contain the memory block, got:\n${before}`);

    // A transient read blip during assembly must not drop the memory block.
    const ac = new AbortController();
    ac.abort();
    item.signal = ac.signal;
    const during = await item.createContextText({ helpers: {} });
    assert(during === before, `memory block must be byte-identical across a transient read blip:\n--- before ---\n${before}\n--- during ---\n${during}`);
  });

  // ---- validate ----

  await test('validate rejects missing/incomplete params', async () => {
    const { item } = makeItem();
    assert(!(await item.validate({})).valid, 'missing action should be invalid');
    assert(!(await item.validate({ action: 'remember' })).valid, 'remember without fact should be invalid');
    assert(!(await item.validate({ action: 'forget' })).valid, 'forget without match should be invalid');
    assert(!(await item.validate({ action: 'bogus', fact: 'x' })).valid, 'unknown action should be invalid');
    assert((await item.validate({ action: 'remember', fact: 'x' })).valid, 'remember with fact should be valid');
    assert((await item.validate({ action: 'forget', match: 'x' })).valid, 'forget with match should be valid');
  });

  // ---- getSummary ----

  await test('getSummary renders terse remember/forget summaries', () => {
    const { item } = makeItem();
    const remembered = item.getSummary({ success: true, result: { action: 'remember', fact: 'Build is make build' } });
    assert(remembered.success && /remember/i.test(remembered.summary), `remember summary: ${JSON.stringify(remembered)}`);
    assert(remembered.summary.includes('Build is make build'), `remember summary should name the fact: ${remembered.summary}`);

    const forgot = item.getSummary({ success: true, result: { action: 'forget', match: 'jules', removed: ['Username is jules'] } });
    assert(forgot.success && /forg|forgot|removed/i.test(forgot.summary), `forget summary: ${JSON.stringify(forgot)}`);

    const noMatch = item.getSummary({ success: true, result: { action: 'forget', match: 'zzz', removed: [] } });
    assert(noMatch.success, `no-match forget is still a success: ${JSON.stringify(noMatch)}`);
  });

  // ---- the file watcher's one way in ----

  // The memory file lives at .juggler/MEMORY.md, inside the directory the
  // project watcher skips wholesale — so no `file-change` ever reached this
  // handler and a hand edit went unnoticed until something else forced a
  // re-read. The watcher now allowlists that one path (watchedHiddenFiles in
  // cmd/juggler/core/filewatcher.go), which is what makes this handler live.
  // These cases pin what it does with what it is finally being sent.

  await test('a change to the memory file asks the UI to re-read it', () => {
    const { item } = makeItem();
    let hits = 0;
    item.onContentChange = () => { hits++; };

    item.onFileChange('.juggler/MEMORY.md', 'write');
    assert(hits === 1, `a hand edit must re-read the file, got ${hits} re-reads`);

    item.onFileChange('.juggler\\MEMORY.md', 'write');
    assert(hits === 2, `and the same path spelled the way Windows spells it, got ${hits}`);
  });

  await test('the rest of Juggler\u2019s own directory is not the memory file', () => {
    const { item } = makeItem();
    let hits = 0;
    item.onContentChange = () => { hits++; };

    for (const path of ['.juggler/session.json', '.juggler/config.json', 'src/main.go', '']) {
      item.onFileChange(path, 'write');
    }
    assert(hits === 0, `nothing else should force a re-read, got ${hits}`);
  });

  await test('the item asks for file changes at all', () => {
    assert(MemoryContextItem.MANIFEST.watchesFileChanges === true,
      'without this the session never offers it a change, whatever the watcher emits');
  });

  // ---- singleton ----

  await test('mergeOrReplace makes memory a singleton (reuse existing)', () => {
    const { item } = makeItem();
    const merge = MemoryContextItem.mergeOrReplace({}, [item]);
    assert(merge && merge.action === 'reuse' && merge.item === item, `should reuse existing singleton: ${JSON.stringify(merge)}`);
    assert(MemoryContextItem.mergeOrReplace({}, []) === null, 'no existing → create new');
  });

  return { passed, failed, errors };
}

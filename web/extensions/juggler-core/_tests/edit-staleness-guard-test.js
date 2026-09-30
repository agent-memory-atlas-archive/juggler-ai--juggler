//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests the read-before-mutate freshness guard (Claude Code-style).
 *
 * The edit tool refuses to modify a file the model hasn't looked at this
 * session, or whose bytes changed on disk since the model last saw them. The
 * write tool is exempt — a whole-file overwrite shows the user a full
 * before/after diff at approval, so the loss is visible without a prior read.
 * Freshness is derived entirely from the durable conversation transcript
 * (context-items/read-history.js): successful read/write/edit/batch_read
 * tool-actions (whose recorded results carry the backend's contentHash) and
 * pinned/at-mentioned file-content items.
 *
 * These tests seed that transcript state directly rather than executing reads
 * in-process — which is also the point: freshness is doc-derived, so a read
 * persisted by a PRIOR app session or ANOTHER client is honored identically,
 * with no per-process record to lose on relaunch. The full real-pipeline path
 * (write-then-edit across turns) is covered by integration-tests/edit-tests.js.
 * @module unit-tests/edit-staleness-guard
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import { writeFileOp, readFileLoad } from '../../../js/services/ops-api.js';
import {
  recordWrittenHash,
  pathMatchKey,
  __resetWrittenHashesForTest
} from '../context-items/read-history.js';

/** A syntactically valid SHA-256 that matches no real file. */
const BOGUS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** Monotonic counter so every seeded tool-action gets a unique toolUseId. */
let seedCounter = 0;

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run read-before-mutate freshness guard tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
  assert(EditClass, 'edit action should be registered');
  const WriteClass = /** @type {any} */ (contextItemRegistry.getByToolName('write'));
  assert(WriteClass, 'write action should be registered');

  /**
   * Build an item of the given class bound to a conversation.
   * @param {any} Cls - Context-item class
   * @param {any} conversation - Conversation instance
   * @returns {any} Item instance
   */
  const mkItem = (Cls, conversation) => new Cls({
    id: Cls.MANIFEST.id,
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });

  /**
   * Seed a COMPLETED, successful tool-action into the conversation transcript
   * — the durable "the model has seen this file" record a real tool call (or a
   * prior session / another client) would leave behind. `payload` is stored
   * nested at `fullResult.result`, matching how the action pipeline persists
   * the backend's ops result.
   * @param {any} conversation - Conversation instance
   * @param {string} toolName - 'read' | 'write' | 'edit' | 'batch_read'
   * @param {object} toolInput - Tool input to record
   * @param {object} [payload] - Backend ops result to record (carries contentHash)
   * @returns {void}
   */
  const seedAction = (conversation, toolName, toolInput, payload) => {
    conversation.rootMessageThread.appendToolAction({
      toolUseId: `seed_${toolName}_${++seedCounter}`,
      toolName,
      toolInput,
      state: 'completed',
      result: {
        content: `${toolName} ok`,
        isError: false,
        ...(payload ? { fullResult: { state: 'completed', success: true, result: payload } } : {})
      }
    });
  };

  /**
   * Seed a seen-record for `path` (hash-less unless given).
   * @param {any} conversation - Conversation instance
   * @param {string} toolName - Seen-tool name
   * @param {string} path - File path the action targeted
   * @param {string} [contentHash] - Hash to record with the result
   * @returns {void}
   */
  const seedSeen = (conversation, toolName, path, contentHash) =>
    seedAction(conversation, toolName, { file_path: path },
      contentHash ? { contentHash } : undefined);

  /**
   * @param {unknown} e - Caught error
   * @returns {string} Human-readable message
   */
  const msg = (e) => (e instanceof Error ? e.message : String(e));

  /**
   * Run one test case.
   * @param {string} name - Test label for error reporting
   * @param {() => Promise<void>} fn - Test body (throws on failure)
   * @returns {Promise<void>}
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${msg(e)}`);
    }
  };

  // =========================================================================
  // Never-seen: an edit to a file with no transcript record is REFUSED. The
  // file exists on disk (seeded via the ops layer, which leaves NO
  // tool-action), so only the read-before-edit guard can reject it.
  // =========================================================================
  await test('never-seen edit refused', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-never.txt', content: 'hello world\n' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-never.txt', old_string: 'world', new_string: 'there' });

    assert(res.valid === false, `never-seen edit must be refused, got ${JSON.stringify(res)}`);
    assert(/has not been read/i.test(res.error || ''),
      `error should tell the model to read first: ${res.error}`);
  });

  // =========================================================================
  // Seen without a hash: a read/write/edit record that carries no contentHash
  // (transcripts written before hashes were recorded) counts as
  // seen-but-unverifiable and ALLOWS the edit rather than forcing a re-read.
  // =========================================================================
  await test('hash-less read allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-read.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-read.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-read.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `read-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('hash-less write allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-write.txt', content: 'hello world\n' });
    seedSeen(conversation, 'write', 'guard-write.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-write.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `write-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('hash-less edit allows re-edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-reedit.txt', content: 'hello world\n' });
    seedSeen(conversation, 'edit', 'guard-reedit.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-reedit.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `re-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Pinned file-content items ALLOW the edit — pins are re-rendered into
  // context at send time, so they always count as fresh.
  // =========================================================================
  await test('pinned file allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-pin.txt', content: 'hello world\n' });
    await conversation.rootMessageThread.executeContextItem('file-content', { path: 'guard-pin.txt' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-pin.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `pinned-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // An @-mention is a frozen snapshot with no recorded hash: it proves the file
  // was seen, so the edit is allowed as seen-but-unverifiable.
  await test('mentioned file allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-mention.txt', content: 'hello world\n' });
    await conversation.rootMessageThread.executeContextItem('file-content', { path: 'guard-mention.txt', frozen: true });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-mention.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `mentioned-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Staleness on EDIT is relaxed: a targeted replace applies whenever the file
  // was seen this session AND old_str is present verbatim in the file's CURRENT
  // bytes — even if the recorded hash is stale — because replacing present text
  // is lossless (any surrounding out-of-band change is preserved). This stops
  // needless re-read churn after the agent's own formatter/codegen edits a file.
  // It is refused ONLY when old_str is no longer in the current bytes (the model
  // is working from content that moved under it), with a re-read message.
  // =========================================================================
  await test('stale hash still allows a matching targeted edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-stale.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-stale.txt', BOGUS_HASH);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-stale.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `stale-but-matching edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale file with a non-matching old_str is refused (re-read)', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-stale-miss.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-stale-miss.txt', BOGUS_HASH);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-stale-miss.txt', old_string: 'GOODBYE', new_string: 'x' });
    assert(res.valid === false, `stale + non-matching edit must be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('matching hash allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-fresh.txt', content: 'hello world\n' });
    assert(typeof writeRes.contentHash === 'string' && writeRes.contentHash,
      'writeFileOp should report the written contentHash');
    seedSeen(conversation, 'read', 'guard-fresh.txt', writeRes.contentHash);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-fresh.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `fresh-hash edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // batch_read: a file read through the batch tool counts as seen via its
  // per-file result entry; an entry whose read FAILED proves nothing.
  // =========================================================================
  await test('batch_read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-batch.txt', content: 'hello world\n' });
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-other.txt' }, { file_path: 'guard-batch.txt' }] },
      {
        _batchType: 'read',
        results: [
          { file: 'guard-other.txt', success: false, error: 'nope' },
          { file: 'guard-batch.txt', success: true, result: { exists: true, contentHash: writeRes.contentHash } }
        ]
      });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batch.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `batch_read-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('failed batch_read entry does not count', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-batchfail.txt', content: 'hello world\n' });
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-batchfail.txt' }] },
      { _batchType: 'read', results: [{ file: 'guard-batchfail.txt', success: false, error: 'denied' }] });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batchfail.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === false, `failed batch entry must not count as seen, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // query_code: files the sandbox script fs.readFile-ed are recorded in the
  // result's filesRead map and earn full hash credit. As with any edit, a stale
  // recorded hash no longer blocks a targeted replace whose old_str matches the
  // current bytes.
  // =========================================================================
  await test('query_code read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-explore.txt', content: 'hello world\n' });
    seedAction(conversation, 'query_code',
      { code: 'return (await fs.readFile("guard-explore.txt")).length' },
      { result: 12, filesRead: { 'guard-explore.txt': writeRes.contentHash } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `query_code-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale query_code read still allows a matching edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-explore-stale.txt', content: 'hello world\n' });
    seedAction(conversation, 'query_code',
      { code: 'return null' },
      { result: null, filesRead: { 'guard-explore-stale.txt': BOGUS_HASH } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore-stale.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `query_code-seen + matching edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // A tool-action persists the name it ran under, so a conversation recorded
  // before the script tool was advertised as `query_code` still holds
  // `explore_code`. The freshness scan reads that stored name straight off the
  // document, so it must credit both — otherwise reopening an old conversation
  // silently loses every read its scripts made.
  await test('read stored under the legacy script tool name still credits an edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-explore-legacy.txt', content: 'hello world\n' });
    seedAction(conversation, 'explore_code',
      { code: 'return (await fs.readFile("guard-explore-legacy.txt")).length' },
      { result: 12, filesRead: { 'guard-explore-legacy.txt': writeRes.contentHash } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore-legacy.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `a legacy-named script read must still count as seen, got ${JSON.stringify(res)}`);
  });

  await test('stripped batch_read results fall back to input list', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-batchbig.txt', content: 'hello world\n' });
    // Large batches have their per-file results replaced by a count in
    // storage; the input list still proves the read covered this file.
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-batchbig.txt' }] },
      { _batchType: 'read', resultsCount: 8 });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batchbig.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `stripped batch results must still count as seen, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Path forms: `./x`, `x`, and the absolute form all canonicalise to one key
  // (path-approval.js absolutePathKey), so a file seen by one form is editable
  // by another.
  // =========================================================================
  await test('path form variance still matches', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-relform.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', './guard-relform.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-relform.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `./-prefixed read must cover the plain path, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Write tool: a whole-file overwrite has no freshness precondition, so
  // neither a never-read file nor one whose bytes moved since the last read is
  // refused. The approval diff renders the file's CURRENT contents against the
  // proposed ones, so the user sees every byte the write destroys — the human
  // is the guard here. The edit tool keeps the guard because its approval UI
  // shows only the changed hunk.
  // =========================================================================
  await test('never-read overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-clobber.txt', content: 'precious\n' });

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber.txt', content: 'gone\n' });
    assert(res.valid === true, `never-read overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-clobber-stale.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-clobber-stale.txt', BOGUS_HASH);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-stale.txt', content: 'gone\n' });
    assert(res.valid === true, `stale overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('never-read overwrite still diffs against current bytes', async () => {
    const conversation = await createTestConversation(session);
    await writeFileOp({ path: 'guard-clobber-diff.txt', content: 'precious\n' });

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-diff.txt', content: 'gone\n' });
    assert(res.valid === true, `never-read overwrite must be allowed, got ${JSON.stringify(res)}`);
    const approval = await write.getApprovalConfig(res.params || {});
    const diff = /** @type {any} */ (approval)?.display?.diffData;
    assert(diff?.oldContent === 'precious\n',
      `approval diff must show the bytes being destroyed, got ${JSON.stringify(diff?.oldContent)}`);
    assert(diff?.newContent === 'gone\n',
      `approval diff must show the replacement, got ${JSON.stringify(diff?.newContent)}`);
  });

  await test('new-file write allowed', async () => {
    const conversation = await createTestConversation(session);
    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-brand-new.txt', content: 'fresh\n' });
    assert(res.valid === true, `creating a new file must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('read-then-overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFileOp({ path: 'guard-clobber-ok.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-clobber-ok.txt', writeRes.contentHash);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-ok.txt', content: 'replaced\n' });
    assert(res.valid === true, `read-then-overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // In-flight sibling edits: when several edits to the same file execute within
  // one assistant turn, an earlier edit's completed tool-action (carrying its
  // post-edit hash) may not yet be visible in the durable transcript when the
  // next edit validates. recordWrittenHash captures that hash synchronously at
  // execute time, so the follow-up edit is NOT spuriously refused as stale —
  // while a genuine out-of-band change the edit cannot apply to (old_str no
  // longer present) still is.
  // =========================================================================
  await test('same-turn sibling edit passes via written-hash record', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    // The transcript only knows the v0 the model read.
    const v0 = await writeFileOp({ path: 'guard-sibling.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-sibling.txt', v0.contentHash);

    // An earlier edit this turn rewrote the file to v1, but its tool-action has
    // not surfaced in the transcript yet — only the in-memory record knows v1.
    const v1 = await writeFileOp({ path: 'guard-sibling.txt', content: 'hello there\n' });
    recordWrittenHash(conversation, session, 'guard-sibling.txt', v1.contentHash);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-sibling.txt', old_string: 'there', new_string: 'everyone' });
    assert(res.valid === true, `sibling edit should pass once its hash is recorded, got ${JSON.stringify(res)}`);
  });

  await test('out-of-band change with a non-matching edit is still refused', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFileOp({ path: 'guard-oob.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-oob.txt', v0.contentHash);

    // The file changed on disk to bytes we never wrote and never recorded, and
    // the text the model wants to replace ('world') no longer exists in it.
    await writeFileOp({ path: 'guard-oob.txt', content: 'hello there\n' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-oob.txt', old_string: 'world', new_string: 'everyone' });
    assert(res.valid === false, `out-of-band change the edit can't apply to must be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('written hash is isolated by conversation', async () => {
    __resetWrittenHashesForTest();
    const writerConversation = await createTestConversation(session);
    const otherConversation = await createTestConversation(session);
    const written = await writeFileOp({ path: 'guard-conversation-isolation.txt', content: 'private\n' });
    recordWrittenHash(
      writerConversation,
      session,
      'guard-conversation-isolation.txt',
      written.contentHash
    );

    const edit = mkItem(EditClass, otherConversation);
    const res = await edit.validate({
      file_path: 'guard-conversation-isolation.txt',
      old_string: 'private',
      new_string: 'clobbered'
    });
    assert(res.valid === false,
      `another conversation must not inherit write authorization, got ${JSON.stringify(res)}`);
    assert(/not been read this session/i.test(res.error || ''),
      `error should require a read in this conversation: ${res.error}`);
  });

  // =========================================================================
  // Parallel same-file batch: a single turn can dispatch several edits to ONE
  // file that all validate — freezing their expectedHash baseline against the
  // original bytes — before any executes. execute() serializes them per path
  // and re-bases each onto the prior sibling's committed bytes, so every edit
  // applies. Without that serialization the backend's expectedHash guard
  // rejects every sibling after the first ("changed on disk since the edit was
  // prepared"). This drives execute() end to end (not just validate()), which
  // is where the concurrency fix lives.
  // =========================================================================
  await test('parallel same-file edit batch all apply', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFileOp({ path: 'guard-parallel.txt', content: 'AAA\nBBB\nCCC\n' });
    seedSeen(conversation, 'read', 'guard-parallel.txt', v0.contentHash);

    // Three edits to distinct, non-overlapping regions.
    const specs = [
      { old_string: 'AAA', new_string: 'XXX' },
      { old_string: 'BBB', new_string: 'YYY' },
      { old_string: 'CCC', new_string: 'ZZZ' }
    ];
    const items = specs.map(() => mkItem(EditClass, conversation));

    // All validate first (against the original bytes) — the real batch shape.
    const validated = await Promise.all(items.map((it, i) =>
      it.validate({ file_path: 'guard-parallel.txt', ...specs[i] })));
    validated.forEach((res, i) =>
      assert(res.valid === true, `edit ${i} should validate, got ${JSON.stringify(res)}`));

    // Then execute concurrently — the failure mode this guards against.
    const results = await Promise.all(items.map((it, i) => it.execute(validated[i].params)));
    results.forEach((r, i) =>
      assert(r && /** @type {any} */ (r).success !== false,
        `edit ${i} should apply, got ${JSON.stringify(r)}`));

    const final = await readFileLoad({ path: 'guard-parallel.txt' });
    assert(final.content === 'XXX\nYYY\nZZZ\n',
      `all three edits should be present, got ${JSON.stringify(final.content)}`);
  });

  await test('parallel same-file overwrite batch all apply', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFileOp({ path: 'guard-parallel-w.txt', content: 'v0\n' });
    seedSeen(conversation, 'read', 'guard-parallel-w.txt', v0.contentHash);

    const contents = ['one\n', 'two\n', 'three\n'];
    const items = contents.map(() => mkItem(WriteClass, conversation));

    const validated = await Promise.all(items.map((it, i) =>
      it.validate({ file_path: 'guard-parallel-w.txt', content: contents[i] })));
    validated.forEach((res, i) =>
      assert(res.valid === true, `overwrite ${i} should validate, got ${JSON.stringify(res)}`));

    const results = await Promise.all(items.map((it, i) => it.execute(validated[i].params)));
    results.forEach((r, i) =>
      assert(r && /** @type {any} */ (r).success !== false,
        `overwrite ${i} should apply, got ${JSON.stringify(r)}`));

    // Serialized in dispatch order, so the last overwrite wins.
    const final = await readFileLoad({ path: 'guard-parallel-w.txt' });
    assert(final.content === 'three\n',
      `last overwrite should win, got ${JSON.stringify(final.content)}`);
  });

  // =========================================================================
  // Case-insensitive filesystems (macOS APFS/HFS+, Windows) resolve differently
  // cased spellings to ONE file, so the freshness guard's comparison key folds
  // case on those platforms and stays exact on case-sensitive ones (Linux). A
  // file read as `README.md` must then be editable as `readme.md` on macOS, but
  // remain a distinct file on Linux. Tested on pathMatchKey directly so the
  // assertion is deterministic regardless of the host the suite runs on.
  // =========================================================================
  await test('pathMatchKey folds case on macOS/Windows, not Linux', async () => {
    const mac = { projectPath: '/proj', platform: 'darwin' };
    const win = { projectPath: 'C:/proj', platform: 'windows' };
    const lin = { projectPath: '/proj', platform: 'linux' };

    assert(pathMatchKey(mac, 'README.md') === pathMatchKey(mac, 'readme.md'),
      'macOS should treat README.md and readme.md as one file');
    assert(pathMatchKey(win, 'SRC/App.JS') === pathMatchKey(win, 'src/app.js'),
      'Windows should fold case');
    assert(pathMatchKey(lin, 'README.md') !== pathMatchKey(lin, 'readme.md'),
      'Linux is case-sensitive: the two are distinct files');

    // Path-form variance still collapses regardless of platform.
    assert(pathMatchKey(lin, './src/a.js') === pathMatchKey(lin, 'src/a.js'),
      './-prefixed and plain forms must match on Linux too');
    // No path yields no key (never accidentally matches).
    assert(pathMatchKey(mac, '') === '' && pathMatchKey(mac, undefined) === '',
      'empty/undefined path yields empty key');
  });

  return { passed, failed, errors };
}

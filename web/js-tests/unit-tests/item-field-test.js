//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Item field reads and column render keys.
 *
 * `itemField` is the one reader for a field of an item that may be a Y.Map or a
 * plain object, shared by the app, the SDK's message predicates and the
 * extensions (through `juggler/model`). Its callers rely on it reading the one
 * field without materialising the item, because a tool action's input and
 * result can hold whole files.
 *
 * `MessageThread#renderSnapshot`, `MessageThread#goal` and `groupRenderKey` are
 * what the column builder in `conversation-tab.js` reads instead of walking the
 * thread's Yjs arrays itself. The key's format is what decides when a column
 * re-renders, so it is pinned here.
 * @module unit-tests/item-field-test
 */

import * as Y from '../../js/vendor/yjs.mjs';
import { itemField, isUserMessage } from '../../sdk/lib/message.js';
import * as sdkModel from '../../sdk/model.js';
import MessageThread from '../../js/model/message-thread.js';
import { groupRenderKey } from '../../js/utils/item-grouping.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Build a Y.Map item attached to a document, so `get` behaves as it does live.
 * @param {Y.Array<any>} arr - The array to append to.
 * @param {Record<string, any>} fields - The item's fields.
 * @returns {Y.Map<any>} The integrated item.
 */
function pushItem(arr, fields) {
  const map = new Y.Map();
  for (const [k, v] of Object.entries(fields)) map.set(k, v);
  arr.push([map]);
  return map;
}

/**
 * Run the item-field tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => void} fn
   */
  function test(name, fn) {
    try {
      fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  test('itemField reads a Y.Map and a plain object alike', () => {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    const live = pushItem(arr, { type: 'user', content: 'hi' });
    const plainItem = { type: 'user', content: 'hi' };
    assert(itemField(live, 'content') === 'hi', `Y.Map read: ${itemField(live, 'content')}`);
    assert(itemField(plainItem, 'content') === 'hi', `plain read: ${itemField(plainItem, 'content')}`);
    assert(itemField(live, 'absent') === undefined, 'an absent Y.Map field must be undefined');
    assert(isUserMessage(/** @type {any} */ (live)) && isUserMessage(/** @type {any} */ (plainItem)),
      'the message predicates read through the same reader');
  });

  test('itemField never materialises the item or the field', () => {
    let toJSONCalls = 0;
    const nested = { toJSON: () => { toJSONCalls++; return {}; }, get: () => 'x' };
    const item = { get: (/** @type {string} */ k) => (k === 'result' ? nested : undefined), toJSON: () => { toJSONCalls++; return {}; } };
    const result = itemField(item, 'result');
    assert(result === nested, 'a nested value must come back as stored');
    assert(itemField(result, 'anything') === 'x', 'and be readable through itemField in turn');
    assert(toJSONCalls === 0, `toJSON was called ${toJSONCalls} times`);
  });

  test('itemField yields undefined for anything that is not an object', () => {
    for (const value of [null, undefined, '', 'type', 0, 7, true]) {
      assert(itemField(value, 'type') === undefined, `${JSON.stringify(value)} gave ${itemField(value, 'type')}`);
    }
  });

  test('juggler/model exports the same itemField', () => {
    assert(/** @type {any} */ (sdkModel).itemField === itemField,
      'extensions must read fields through the one reader, not a copy');
  });

  test('renderSnapshot keys the rows and the queue, in order', () => {
    const doc = new Y.Doc();
    const container = doc.getMap('thread');
    const items = new Y.Array();
    const pending = new Y.Array();
    container.set('items', items);
    container.set('pendingItems', pending);
    pushItem(items, { itemId: 'a' });
    pushItem(items, { itemId: 'b' });
    pushItem(pending, { itemId: 'q' });

    const fake = Object.create(MessageThread.prototype, {
      container: { value: container },
      threadItemId: { value: 'T1' },
    });
    const snap = /** @type {MessageThread} */ (fake).renderSnapshot();
    assert(snap.key === 'a,b|pending:q', `key: ${snap.key}`);
    assert(snap.items.length === 2 && snap.items[1].get('itemId') === 'b', 'items in document order');
    assert(snap.items !== /** @type {MessageThread} */ (fake).renderSnapshot().items,
      'each snapshot hands out a fresh array the column may keep');

    pushItem(pending, { itemId: 'r' });
    assert(/** @type {MessageThread} */ (fake).renderSnapshot().key === 'a,b|pending:q,r',
      'queuing a message must change the key');

    const empty = Object.create(MessageThread.prototype, {
      container: { value: new Y.Doc().getMap('root') },
      threadItemId: { value: null },
    });
    assert(/** @type {MessageThread} */ (empty).renderSnapshot().key === '|pending:',
      'a thread with no arrays yet keys as empty');
  });

  test('goal is the thread container\'s goal, and empty for the root', () => {
    const doc = new Y.Doc();
    const container = doc.getMap('thread');
    container.set('goal', 'Trace auth');
    const thread = Object.create(MessageThread.prototype, {
      container: { value: container },
      threadItemId: { value: 'T1' },
    });
    assert(/** @type {MessageThread} */ (thread).goal === 'Trace auth', 'thread goal');
    const root = Object.create(MessageThread.prototype, {
      container: { value: container },
      threadItemId: { value: null },
    });
    assert(/** @type {MessageThread} */ (root).goal === '', 'root has no goal');
  });

  test('groupRenderKey changes with a member\'s state', () => {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    const a = pushItem(arr, { itemId: 'a', state: 'pending' });
    const b = pushItem(arr, { itemId: 'b', state: 'completed' });
    const before = groupRenderKey('group:a', [a, b]);
    assert(before === 'group:a|a:pending,b:completed', `key: ${before}`);
    a.set('state', 'completed');
    assert(groupRenderKey('group:a', [a, b]) !== before, 'a state change must change the key');
  });

  return { passed, failed, errors };
}

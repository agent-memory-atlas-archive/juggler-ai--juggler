//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Item Accessor - Y.Map conversion helpers for conversation items
 * Converts plain JS objects to Y.Map CRDT types at insertion boundaries, and
 * back to plain values at read boundaries.
 * @module model/item-accessor
 */

import * as Y from '../vendor/yjs.mjs';

/**
 * Read a CRDT value as plain JS. A field's stored shape is not stable: the
 * same key holds a Y.Map/Y.Array when it arrived through the CRDT and a plain
 * object when it was set locally before conversion, so every reader has to cope
 * with both. Non-CRDT values (objects, primitives, null, undefined) pass through
 * untouched, which makes this safe to wrap around any field read.
 *
 * Callers wanting a default for an absent field spell it `plain(v) || {}` —
 * that stays at the call site rather than being baked in here, so this helper
 * has exactly one behaviour.
 * @param {*} value - Value read from a Y.Map/Y.Array, or an already-plain value
 * @returns {*} The plain-JS equivalent
 */
export function plain(value) {
  return value?.toJSON ? value.toJSON() : value;
}

/**
 * Read one key off a thread item (or any Y.Map) as plain JS — `plain(item.get(key))`,
 * without spelling the `get` twice. This materialises the value; to read a field
 * as stored, from a Y.Map or a plain object alike, use `itemField`
 * (`sdk/lib/message.js`).
 * @param {any} item - Y.Map to read from
 * @param {string} key - Key to read
 * @returns {*} The plain-JS value at `key`
 */
export function yGet(item, key) {
  return plain(item?.get?.(key));
}

/**
 * Convert a plain object to a Y.Map with nested CRDT types.
 * Used at insertion boundaries when creating new items.
 * Nested objects become Y.Map, arrays become Y.Array, primitives pass through.
 * @param {object} obj - Plain object
 * @returns {*} New Y.Map with properties set
 */
export function plainToYMap(obj) {
  const ymap = new Y.Map();
  if (!obj || typeof obj !== 'object') return ymap;

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    ymap.set(key, convertToYType(value));
  }
  return ymap;
}

/**
 * Convert a plain JS value to a Yjs CRDT type.
 * Objects → Y.Map, Arrays → Y.Array, primitives pass through.
 * Already-CRDT values (Y.Map, Y.Array) pass through unchanged.
 * @param {any} value - Value to convert
 * @returns {any} Converted value
 */
export function convertToYType(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Y.Map || value instanceof Y.Array) return value;

  if (Array.isArray(value)) {
    const yarr = new Y.Array();
    yarr.push(value.map(v => convertToYType(v)));
    return yarr;
  }

  if (typeof value === 'object') {
    const ymap = new Y.Map();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      ymap.set(k, convertToYType(v));
    }
    return ymap;
  }

  return value;
}

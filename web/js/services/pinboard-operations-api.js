//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * Apply semantic edits to one pinboard. This transport is realm-neutral: the
 * viewer store uses it for user edits, and an engine tool can use it without
 * importing the viewer-only pin registry or presentation state.
 * @param {string} board - Board id.
 * @param {Array<Record<string, any>>} operations - Edits to apply.
 * @param {{pin: string, from?: string}|null} [reveal] - Optional advisory reveal.
 * @param {AbortSignal} [signal] - Cancels the request with its owning action.
 * @returns {Promise<{board?: string, pins?: any[]}>} The server's resulting board.
 */
export function applyPinboardOperations(board, operations, reveal = null, signal) {
  const body = reveal ? { operations, reveal } : { operations };
  return fetchJson(apiUrl(`/session/pinboard/operations?board=${encodeURIComponent(board)}`), {
    method: 'POST',
    body,
    signal,
    errorPrefix: '[Pinboard] Operation failed',
  });
}

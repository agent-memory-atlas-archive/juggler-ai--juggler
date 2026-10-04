//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The one JSON-over-HTTP transport for the frontend.
 *
 * Every backend call shares the same four decisions — check `ok`, dig a useful
 * message out of the error body, treat 204/empty as "no content", parse JSON —
 * and each caller that hand-rolls them ends up with a slightly different (and
 * usually weaker) policy. {@link fetchJson} makes those decisions once; the
 * caller only chooses what a failure means to it:
 *
 * - **throw** (default): no `fallback` key ⇒ failures raise an {@link HttpError}
 *   (or the transport error), message prefixed with `errorPrefix` when given.
 * - **fall back**: pass `fallback` ⇒ failures resolve to that value instead.
 *   Add `errorPrefix` to also log a warning; omit it to fail silently.
 *
 * A caller's `AbortError` is never a failure to absorb — it is always re-thrown,
 * even with a `fallback`, so callers that race requests can tell "superseded"
 * from "returned nothing" (see services/completions-api.js). A `timeoutMs`
 * expiry is the opposite: it is this module's own abort, not the caller's, and
 * takes the ordinary failure path so a dead link resolves to the `fallback`
 * instead of throwing something no caller asked for.
 * @module services/http
 */

/**
 * A non-OK HTTP response. Carries the status and the decoded error body so a
 * caller can branch on one specific code — e.g. skill install treating 409 as a
 * name collision — without having to read the response itself.
 */
export class HttpError extends Error {
  /**
   * @param {string} message - Human-readable message (already prefixed)
   * @param {number} status - HTTP status code
   * @param {string} detail - The server's own message, without the status prefix
   * @param {any} [body] - Parsed JSON error body, or the raw text when not JSON
   */
  constructor(message, status, detail, body) {
    super(message);
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.detail = detail;
    /** @type {any} */
    this.body = body;
  }
}

/**
 * The message to show a user for a caught request failure: an {@link HttpError}'s
 * server-supplied detail (no status prefix), any other Error's message, or
 * `fallbackMessage` when the thrown value carries nothing readable.
 * @param {unknown} error - The caught value
 * @param {string} [fallbackMessage] - Used when the error says nothing useful
 * @returns {string} A message fit for an alert or status line
 */
export function httpErrorText(error, fallbackMessage = 'Request failed') {
  if (error instanceof HttpError) return error.detail || fallbackMessage;
  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

/**
 * Decode a non-OK response body into a message and its parsed form. Backends
 * commonly return `{"error": "..."}` JSON; fall back to the raw text, then to
 * statusText. `detail` is empty when the response said nothing at all, so the
 * caller can avoid formatting a message that only repeats the status.
 * @param {Response} response - The non-OK response
 * @returns {Promise<{detail: string, body: any}>} Human-readable detail (possibly empty) and the decoded body
 */
async function decodeErrorBody(response) {
  let body = null;
  let detail = '';
  try {
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (text) {
      detail = text;
      try {
        body = JSON.parse(text);
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* not JSON — the raw text is the best detail we have */
      }
    }
  } catch {
    /* body already consumed or unreadable — fall through to statusText */
  }
  return { detail: detail || response.statusText || '', body };
}

/**
 * Read the most useful error message a non-OK response offers.
 * @param {Response} response - The non-OK response
 * @returns {Promise<string>} The server's error string, the raw body, statusText, or the bare status
 */
export async function extractHttpErrorDetail(response) {
  const { detail } = await decodeErrorBody(response);
  return detail || `HTTP ${response.status}`;
}

/**
 * Add this instance's API token to a set of request headers, for a caller that
 * builds its own `fetch` rather than going through {@link fetchJson}. Every realm
 * that talks to /api also installs a fetch shim that adds it (index.html,
 * engine-worker-runtime.js, engine-host-node.mjs); naming it here as well keeps
 * the request authorised in a realm that one day lacks the shim. No token (test
 * mode, where the gate is off) leaves the headers as they are.
 * @param {Record<string, string>} headers - Headers to extend; mutated and returned
 * @returns {Record<string, string>} The same object
 */
export function withApiToken(headers) {
  const token = /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken;
  if (token) headers['X-Juggler-Token'] = token;
  return headers;
}

/**
 * Fetch a URL and return its JSON body under one shared failure policy.
 *
 * `body` is JSON-encoded (with the matching Content-Type) unless it is already
 * a string, Blob/File, or typed array, which is sent as-is. A 204, an empty body,
 * or a non-JSON body all resolve to `null` — a call whose response carries
 * nothing still counts as success.
 * @template T
 * @param {string} url - Absolute path or full URL
 * @param {object} [options] - Request and failure-policy options
 * @param {string} [options.method] - HTTP method (default GET)
 * @param {any} [options.body] - Request body; plain objects are JSON-encoded
 * @param {Record<string, string>} [options.headers] - Extra request headers
 * @param {AbortSignal} [options.signal] - Abort signal; an abort always re-throws
 * @param {number} [options.timeoutMs] - Give up after this long; treated as a failure, not an abort
 * @param {string} [options.errorPrefix] - Prefix for the error message / warning
 * @param {T} [options.fallback] - Value to resolve with instead of throwing
 * @returns {Promise<any>} Parsed JSON, `null` for an empty body, or `fallback`
 * @throws {HttpError} On a non-OK response when no `fallback` was given
 */
export async function fetchJson(url, options = {}) {
  const { method, body, headers, signal, timeoutMs, errorPrefix, fallback } = options;
  const usesFallback = Object.prototype.hasOwnProperty.call(options, 'fallback');

  // A timeout is delivered as an abort, so track whether WE were the one who
  // fired it: the catch below has to tell our expiry (ordinary failure —
  // warn and fall back) from the caller's cancellation (always re-thrown).
  // The caller's signal is chained onto ours so both still cancel the request.
  let timedOut = false;
  /** @type {AbortController|null} */
  const timeoutController = timeoutMs ? new AbortController() : null;
  /** @type {any} */
  let timeoutId = null;
  if (timeoutController) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
    }
  }
  const effectiveSignal = timeoutController ? timeoutController.signal : signal;

  try {
    const isRawBody = body === undefined || typeof body === 'string'
      || (typeof Blob !== 'undefined' && body instanceof Blob)
      || ArrayBuffer.isView(body);
    /** @type {RequestInit} */
    const init = {
      ...(method ? { method } : {}),
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
      headers: {
        ...(body !== undefined && !isRawBody ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
    };
    if (body !== undefined) init.body = isRawBody ? body : JSON.stringify(body);

    const response = await fetch(url, init);
    if (!response.ok) {
      const { detail, body: errorBody } = await decodeErrorBody(response);
      const status = `HTTP ${response.status}`;
      let message;
      if (errorPrefix) message = detail ? `${errorPrefix}: ${detail}` : `${errorPrefix} (${status})`;
      else message = detail ? `${status}: ${detail}` : status;
      throw new HttpError(message, response.status, detail, errorBody);
    }
    if (response.status === 204 || typeof response.json !== 'function') return null;
    try {
      return await response.json();
    } catch {
      return null; // empty or non-JSON body — nothing to hand back
    }
  } catch (error) {
    // Our own expiry: report it as a plain timeout rather than an abort, so it
    // reads as the request failing (which it did) and honours the fallback.
    if (timedOut) {
      const timeout = new Error(
        errorPrefix ? `${errorPrefix}: timed out after ${timeoutMs}ms` : `Request timed out after ${timeoutMs}ms`
      );
      if (!usesFallback) throw timeout;
      if (errorPrefix) console.warn(`${errorPrefix}:`, timeout.message);
      return fallback;
    }
    // A superseded request is not a failure the fallback should mask: callers
    // race completions and need to distinguish it from an empty result.
    if (/** @type {any} */ (error)?.name === 'AbortError') throw error;
    if (!usesFallback) throw error;
    if (errorPrefix) {
      console.warn(`${errorPrefix}:`, error instanceof Error ? error.message : error);
    }
    return fallback;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

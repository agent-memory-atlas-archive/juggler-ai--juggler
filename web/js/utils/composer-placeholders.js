//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The empty composer's placeholder copy.
 *
 * An empty box shows this on every turn, which makes it the most-read string in
 * the app — so what varies here is the situation, not the wording. Each bucket
 * is a state the conversation is genuinely in, so a different line means
 * something different happened, and `ready` (the state almost every reading
 * lands in) stays plain and informational.
 *
 * A line is re-picked only when the state CHANGES, so the text holds still
 * while the user is looking at it rather than reshuffling on every doc update.
 * @module utils/composer-placeholders
 */

/**
 * How quiet a thread must have been for its composer to read as returning to an
 * old conversation rather than carrying on a live one (milliseconds).
 */
export const COMPOSER_IDLE_MS = 6 * 60 * 60 * 1000;

/**
 * How many HISTORY items a thread must hold before the composer remarks on its
 * length — messages and tool calls, not the standing context items every
 * conversation is seeded with. Set well past the point where a conversation is
 * merely long, so the line describes a genuine outlier rather than becoming a
 * running commentary.
 */
export const COMPOSER_LONG_THREAD_ITEMS = 250;

/**
 * Placeholder lines by conversation state — one bucket per state
 * `Composer._derivePlaceholderState()` can return, and one line picked at
 * random from it each time the state changes. A bucket holding a single line
 * therefore never varies.
 *
 * `ready` is read on almost every turn, so it stays information. The others are
 * the tail — states most sessions reach rarely, where a line can carry some
 * voice — but every one of them still has to survive the ten-thousandth read.
 *
 * Every line is the app speaking TO the user — addressed to them, never in the
 * first person. A placeholder sits exactly where the user's own words go, so a
 * line they could plausibly send ("OK, let's carry on…") reads as a suggested
 * message rather than a prompt.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const COMPOSER_PLACEHOLDERS = Object.freeze({
  /** A conversation with no history yet — seeded context items don't count. */
  fresh: Object.freeze([
    'Type your message…',
    'What would you like to build?',
    'Describe your task…',
  ]),

  /** Mid-flow, with nothing in particular to report. The common case. */
  ready: Object.freeze([
    'Type your message…',
    'Enter your command…',
    'Your turn…',
  ]),

  /** The last turn was cancelled — by the user, or by an action that preempted it. */
  cancelled: Object.freeze([
    'Stopped. What would you like instead?',
    'Stopped. Your move…',
  ]),

  /** The last turn ended in an error. */
  error: Object.freeze([
    'That failed. What would you like to try?',
    'Not that way, then. Your call…',
  ]),

  /** Coming back to a conversation that has been quiet for a long time. */
  idle: Object.freeze([
    'Welcome back. Type your message…',
    'Welcome back. Where would you like to pick up?',
  ]),

  /** A thread long past the point of comfort. */
  long: Object.freeze([
    "This one's getting long. What's your next step?",
    "Quite an epic, this. What's your next move?",
  ]),
});

/**
 * Pick a placeholder line for a conversation state. An unknown state, or a
 * bucket emptied by editing, falls back to `ready` — the placeholder is never
 * blank, whatever the lists say.
 * @param {string} state - A key of {@link COMPOSER_PLACEHOLDERS}
 * @returns {string} The line to show
 */
export function pickComposerPlaceholder(state) {
  const bucket = COMPOSER_PLACEHOLDERS[state];
  const lines = bucket && bucket.length ? bucket : (COMPOSER_PLACEHOLDERS.ready ?? []);
  if (!lines.length) return '';
  return lines[Math.floor(Math.random() * lines.length)] ?? '';
}

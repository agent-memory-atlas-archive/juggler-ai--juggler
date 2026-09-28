//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The three things offered in a conversation nobody has said anything in yet.
 *
 * An empty composer is a blank page, and the hardest part of a first session is
 * not running out of things to ask but thinking of the first one. These ride
 * the suggested-replies row, so they are drafted into the composer and never
 * sent — the user reads the words back before anything happens.
 *
 * They are chosen to still make sense on the ten-thousandth reading, which
 * rules out anything conversational: each is a question with a useful answer in
 * an empty folder and in a large codebase alike, and none of them is a joke.
 * @module utils/starter-prompts
 */

/**
 * @type {readonly string[]}
 */
export const STARTER_PROMPTS = Object.freeze([
  'What can you do?',
  'Give me a tour of this project',
  'What should I work on first?',
]);

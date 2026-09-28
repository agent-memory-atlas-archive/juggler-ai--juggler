//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Chime voice-table unit tests — the curated pattern/sound tables and the pure
 * mapping over them, none of which needs an AudioContext.
 *
 * The tables are hand-tuned data, and the two properties that make them usable
 * are invariants a typo silently breaks: every pattern has to land inside the
 * tasteful register (a stray root puts a note somewhere piercing or inaudible),
 * and every voice's `gain` trim has to hold its peak level near the others (an
 * untrimmed partial stack clips, or arrives so quiet the voice reads as broken).
 * Both are checked here across the whole table, so adding an entry is checked by
 * running the suite rather than by ear alone.
 *
 * {@link randomChimeVoice} — the settings Random button — is pure with an
 * injected RNG, so its one real promise is testable directly: it never rolls the
 * voice already selected, at any RNG value including the edges.
 * @module unit-tests/chime-voice-test
 */

import { assert } from '../utilities/test-helpers.js';
import { mapChimeParams, chimePatterns, chimeSounds, randomChimeVoice, CHIME_DEFAULTS } from '../../js/utils/chime-synth.js';
import { DEFAULT_ATTENTION_PREFS } from '../../js/utils/attention-manager.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of assertions that passed.
 * @property {number} failed Number of assertions that failed.
 * @property {string[]} errors Collected failure messages.
 */

/**
 * The register the pattern table promises to stay inside, in Hz. Below this a
 * note is a thud on a laptop speaker; above it the chime is piercing.
 */
const REGISTER_LO_HZ = 220;
const REGISTER_HI_HZ = 1320;

/**
 * Peak-level band every voice's `gain` trim has to land in, measured at
 * `volume: 1` as the summed partial levels through the master gain. The ceiling
 * is headroom — notes of a motif overlap, so a single note has to sit well under
 * full scale. The floor catches a voice trimmed so far down it reads as broken.
 */
const PEAK_CEILING = 0.6;
const PEAK_FLOOR = 0.15;

/**
 * Run the chime voice-table tests.
 * @returns {Promise<TestResult>} Counts and failure messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── The pattern table ───────────────────────────────────────────────────────

  await run('every pattern keeps all of its notes inside the tasteful register', () => {
    for (const { id } of chimePatterns()) {
      const { notes } = mapChimeParams({ ...CHIME_DEFAULTS, pattern: id });
      for (const note of notes) {
        assert(
          note.freq >= REGISTER_LO_HZ && note.freq <= REGISTER_HI_HZ,
          `pattern "${id}" has a note at ${note.freq.toFixed(1)}Hz, outside ${REGISTER_LO_HZ}–${REGISTER_HI_HZ}Hz`,
        );
      }
    }
  });

  await run('every pattern is one to four notes long, as the menu promises', () => {
    for (const { id } of chimePatterns()) {
      const { notes } = mapChimeParams({ ...CHIME_DEFAULTS, pattern: id });
      assert(notes.length >= 1 && notes.length <= 4, `pattern "${id}" has ${notes.length} notes, expected 1–4`);
    }
  });

  await run('every pattern rings out in well under a second', () => {
    for (const { id } of chimePatterns()) {
      const { duration } = mapChimeParams({ ...CHIME_DEFAULTS, pattern: id });
      assert(duration > 0 && duration < 1, `pattern "${id}" lasts ${duration.toFixed(2)}s, expected 0–1s`);
    }
  });

  // ── The sound table ────────────────────────────────────────────────────────

  await run('every voice’s gain trim holds its peak level near the others', () => {
    for (const { id } of chimeSounds()) {
      const { gain, sound } = mapChimeParams({ ...CHIME_DEFAULTS, sound: id, volume: 1 });
      const peak = gain * sound.partials.reduce((sum, [, level]) => sum + level, 0);
      assert(peak <= PEAK_CEILING, `voice "${id}" peaks at ${peak.toFixed(3)}, above the ${PEAK_CEILING} ceiling — needs a lower gain trim`);
      assert(peak >= PEAK_FLOOR, `voice "${id}" peaks at ${peak.toFixed(3)}, below the ${PEAK_FLOOR} floor — too quiet to hear next to the others`);
    }
  });

  await run('menu ids are unique, so no entry shadows another in the lookup tables', () => {
    for (const [what, entries] of [['pattern', chimePatterns()], ['sound', chimeSounds()]]) {
      const ids = /** @type {Array<{id: string}>} */ (entries).map((e) => e.id);
      assert(new Set(ids).size === ids.length, `duplicate ${what} id in the table: ${ids.join(', ')}`);
    }
  });

  // ── randomChimeVoice: the settings Random button ────────────────────────────

  await run('randomChimeVoice never rolls the pattern or sound already selected', () => {
    const current = { pattern: CHIME_DEFAULTS.pattern, sound: CHIME_DEFAULTS.sound, volume: 0.6 };
    for (let i = 0; i < 200; i++) {
      const rolled = randomChimeVoice(current);
      assert(rolled.pattern !== current.pattern, `rolled the current pattern "${rolled.pattern}"`);
      assert(rolled.sound !== current.sound, `rolled the current sound "${rolled.sound}"`);
    }
  });

  await run('randomChimeVoice only ever returns ids that are in the menus', () => {
    const patterns = new Set(chimePatterns().map((p) => p.id));
    const sounds = new Set(chimeSounds().map((s) => s.id));
    for (let i = 0; i < 200; i++) {
      const rolled = randomChimeVoice({});
      assert(patterns.has(rolled.pattern), `rolled unknown pattern "${rolled.pattern}"`);
      assert(sounds.has(rolled.sound), `rolled unknown sound "${rolled.sound}"`);
    }
  });

  await run('randomChimeVoice stays in bounds at both ends of the RNG range', () => {
    // Math.random() is [0, 1), but a 1 (or a hair over) must not index past the
    // end of the table and return undefined.
    for (const value of [0, 0.999999, 1]) {
      const rolled = randomChimeVoice({}, () => value);
      assert(typeof rolled.pattern === 'string' && rolled.pattern.length > 0, `rand()=${value} gave pattern ${String(rolled.pattern)}`);
      assert(typeof rolled.sound === 'string' && rolled.sound.length > 0, `rand()=${value} gave sound ${String(rolled.sound)}`);
    }
  });

  await run('randomChimeVoice reaches every entry in both tables', () => {
    // A roll that can only ever produce a handful of the entries would pass every
    // test above; sweeping the RNG across its range proves the whole table is
    // reachable. Each roll excludes the current voice, so sweep against a voice
    // that isn't in either table to keep all entries in the pool.
    const patterns = new Set();
    const sounds = new Set();
    for (let i = 0; i < 1000; i++) {
      const rolled = randomChimeVoice({ pattern: 'none', sound: 'none' }, () => i / 1000);
      patterns.add(rolled.pattern);
      sounds.add(rolled.sound);
    }
    assert(patterns.size === chimePatterns().length, `swept ${patterns.size} patterns of ${chimePatterns().length}`);
    assert(sounds.size === chimeSounds().length, `swept ${sounds.size} sounds of ${chimeSounds().length}`);
  });

  // ── The sound-on-by-default decision ───────────────────────────────────────

  await run('notification sounds are on for a fresh profile', () => {
    // A deliberate tripwire, not a restatement of the constant: a chime nobody
    // hears until they find the setting is the same as no chime, so this default
    // is a product decision. Audio unlock is handled on the first gesture of the
    // session (attention-manager's arming), not by making the user switch it on.
    assert(DEFAULT_ATTENTION_PREFS.sound === true, 'expected sound on by default');
  });

  return { passed, failed, errors };
}

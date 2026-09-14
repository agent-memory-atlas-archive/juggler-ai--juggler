//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Registries-ready gate — an awaitable signal that the capability registries
 * have completed their initial hydration at least once.
 *
 * All of them, whichever they are: this gate is one latch flipped by
 * `initAllRegistries`, and it has never named them individually in code. The
 * list it used to name here had drifted to twice its length.
 *
 * System-prompt assembly gates extension contributions on the set of enabled
 * plugin ids, which is only knowable once the registries have loaded. Awaiting
 * this signal before reading the registries guarantees the prompt is rendered
 * against a fully-hydrated set, so a turn that assembles the prompt during the
 * post-resume hydration window produces the same bytes as a steady-state turn.
 *
 * This module deliberately has NO imports: it sits below both the registries
 * layer (which marks it ready) and the services layer (which awaits it), so a
 * static import here would create a cycle.
 * @module registries/registry-ready
 */

/** @type {() => void} */
let resolveReady;

/** @type {Promise<void>} */
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});

/**
 * Mark the registries as hydrated, resolving the readiness promise. Idempotent:
 * the first call resolves the promise and every later call is a no-op. The
 * signal stays resolved across registry reloads — reloadRegistries defers its
 * reset until local turns are quiescent, so no turn assembles a prompt against a
 * half-reset registry set and there is nothing to un-resolve.
 */
export function markRegistriesReady() {
  resolveReady();
}

/**
 * @returns {Promise<void>} Resolves once the registries have hydrated at least once
 */
export function whenRegistriesReady() {
  return readyPromise;
}

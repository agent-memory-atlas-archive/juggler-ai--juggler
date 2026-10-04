//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The controller shared by the pins that show one path read from disk — the
 * File and Memory pins. What each reads, how it watches for changes and how it
 * draws is its own; when it reads again and what it offers is one behaviour,
 * and it lives here so the two cannot drift.
 * @module lib/path-pin
 */

/**
 * How one path pin plugs into the shared controller.
 * @typedef {object} PathPinSpec
 * @property {() => import('juggler/pinboard-item-type').PinContext} getContext - The context the pin is drawing for now
 * @property {(next: import('juggler/pinboard-item-type').PinContext) => void} setContext - Adopt a new context
 * @property {(context: import('juggler/pinboard-item-type').PinContext) => string} targetOf - The absolute path a context makes the pin show
 * @property {() => Promise<void>} render - Read the path and draw it
 * @property {() => void} teardown - Stop the pin's own watcher and timers
 */

/**
 * Build a path pin's controller.
 *
 * An update re-reads when the path moves, and also when the conversation does
 * even though the path has not: another conversation may have written the file
 * since this one was last looked at. Moving between threads of one conversation
 * is not a reason to read again.
 *
 * The one action is Refresh, for the changes a watcher cannot see. Open, copy
 * and reveal are the host's, offered for any pin that names a path.
 * @param {PathPinSpec} spec - The pin's half of the controller.
 * @returns {import('juggler/pinboard-item-type').PinController} The controller.
 */
export function pathPinController({ getContext, setContext, targetOf, render, teardown }) {
  let target = targetOf(getContext());
  return {
    update: (next) => {
      const nextTarget = targetOf(next);
      const conversationChanged = next.active?.conversation?.id !== getContext().active?.conversation?.id;
      setContext(next);
      if (nextTarget === target && !conversationChanged) return;
      target = nextTarget;
      void render();
    },
    teardown,
    getActions: () => [
      { id: 'refresh', label: 'Refresh', icon: 'refresh', primary: true, run: () => render() },
    ],
  };
}

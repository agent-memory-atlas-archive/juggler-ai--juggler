//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The header's "…" overflow menu.
 *
 * When the header is too narrow for every control, CSS folds the rarely-used
 * ones out of the row (see `.header-overflow-button` in app-header.css) and
 * shows the "…" button instead. This menu offers them back — each row runs the
 * same action as the button it stands in for, and names that action's
 * keyboard shortcut, since a shortcut is the other way to reach it.
 * @module utils/header-overflow-menu
 */

import { presentPopup } from './popup-surface.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';

/** Popup-manager id: at most one overflow menu is ever open. */
const OVERFLOW_MENU_POPUP_ID = 'header-overflow-menu';

/**
 * @typedef {object} HeaderOverflowItem
 * @property {string} label - What the row does.
 * @property {string} shortcutId - KeyShortcutManager id whose binding the row shows.
 * @property {() => void} run - The action, shared with the button the row stands in for.
 * @property {() => boolean} [omit] - Leaves the row out of a menu opened while it returns true.
 */

/**
 * Make `button` open and close the overflow menu.
 * @param {HTMLElement} button - The header's "…" button.
 * @param {HeaderOverflowItem[]} items - The rows, in order.
 * @returns {{dispose: () => void}} Closes any open menu and unwires the button.
 */
export function setupHeaderOverflowMenu(button, items) {
  /** @type {(() => void)|null} */
  let release = null;

  const close = () => {
    const r = release;
    release = null;
    r?.();
    button.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu header-overflow-menu show';
    surface.setAttribute('role', 'menu');
    const list = document.createElement('menu');
    for (const item of items) {
      if (item.omit?.()) continue;
      const row = document.createElement('li');
      row.className = 'menu-item';
      row.setAttribute('role', 'menuitem');
      const name = document.createElement('span');
      name.className = 'menu-item-name';
      name.textContent = item.label;
      row.append(name);
      const keys = keyShortcutManager.formatBinding(item.shortcutId);
      if (keys) {
        const hint = document.createElement('span');
        hint.className = 'menu-item-shortcut';
        hint.textContent = keys;
        row.append(hint);
      }
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        item.run();
      });
      list.append(row);
    }
    surface.append(list);
    button.setAttribute('aria-expanded', 'true');
    release = presentPopup({
      surface,
      anchor: button,
      id: OVERFLOW_MENU_POPUP_ID,
      onClose: close,
      // The button sits at the right end of the header, so pin the right edges.
      align: 'right',
      gap: 6,
      insideSelectors: ['.header-overflow-menu', '#header-overflow-button'],
    });
  };

  const onClick = () => { if (release) close(); else open(); };
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', onClick);

  return {
    dispose: () => {
      close();
      button.removeEventListener('click', onClick);
    },
  };
}

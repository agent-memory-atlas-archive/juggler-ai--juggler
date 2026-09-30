//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Header controls: undo/redo buttons + project-path-display.
 * The buttons live once in .app-header and operate on the currently visible
 * conversation.
 * @module utils/header-controls
 */

import keyShortcutManager from '../services/key-shortcut-manager.js';
import wsService from '../services/websocket.js';
import { hasNativeHost } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';
import { showAlert } from '../components/modal-dialog.js';
import { openSettings } from '../services/settings-launcher.js';
import { apiUrl } from './api-url.js';

/**
 * @typedef {import('../model/session.js').default} Session
 * @typedef {import('../model/conversation.js').default} Conversation
 */

/**
 * Wire up header controls (undo/redo + project path).
 * @param {Session} session
 */
export function setupHeaderControls(session) {
  const undoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('control-undo-button'));
  const redoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('control-redo-button'));
  const pathDisplay = /** @type {HTMLElement|null} */ (document.getElementById('project-path-display'));
  const pathChip = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-path-chip'));
  const pathLabel = /** @type {HTMLElement|null} */ (pathDisplay?.querySelector('.ppd-path') ?? null);
  const newWindowBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-new-window-button'));
  const clientsIndicator = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-clients-indicator'));
  const clientsCountLabel = /** @type {HTMLElement|null} */ (clientsIndicator?.querySelector('.ppd-clients-count') ?? null);

  /** @type {Conversation|null} */
  let currentConversation = null;
  /** @type {((event: any) => void) | null} */
  let metadataObserver = null;

  // The conversation is running whenever the worker's authoritative
  // processingState.status is anything other than 'idle' — the top-level
  // projection reports a running status while ANY of its threads holds a claim,
  // for the whole busy span (LLM call, tool execution, approval waits). That is
  // the right scope here: undo/redo roll the WHOLE document back, so one live
  // run anywhere in it is reason enough to lock them out. Reading the doc
  // metadata (not the local llmState projection) means viewers that didn't
  // initiate the turn lock out too.
  const isBusy = () => {
    const status = currentConversation?.processingState?.status;
    return !!status && status !== 'idle';
  };

  const updateButtons = () => {
    const busy = isBusy();
    const canUndo = !busy && !!currentConversation?.canUndo();
    const canRedo = !busy && !!currentConversation?.canRedo();
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  };

  const bindToVisible = () => {
    const visible = session.getVisibleConversation();
    if (visible === currentConversation) {
      updateButtons();
      return;
    }
    // Detach old observer
    if (metadataObserver && currentConversation) {
      currentConversation.unobserveMetadata(metadataObserver);
      metadataObserver = null;
    }
    currentConversation = visible;
    if (currentConversation) {
      metadataObserver = (event) => {
        if (event.keysChanged?.has?.('undoState') || event.keysChanged?.has?.('processingState')) {
          updateButtons();
        }
      };
      currentConversation.observeMetadata(metadataObserver);
    }
    updateButtons();
  };

  // Both the header path chip and the native Session ▸ Open… menu event open the
  // same project picker; the module is imported lazily so the picker (and its
  // deps) stay off the initial header render path.
  const openPicker = async () => {
    const { openProjectPicker } = await import('../components/project-picker.js');
    openProjectPicker(session.projectPath || '', session);
  };

  const updateProjectPath = (/** @type {string} */ projectPath) => {
    if (!pathDisplay || !pathLabel) return;
    if (!projectPath) {
      pathLabel.textContent = 'Set project folder';
      if (pathChip) pathChip.title = 'Click to set the project folder';
      pathDisplay.classList.add('is-empty');
    } else {
      pathLabel.textContent = projectPath;
      if (pathChip) {
        // On the desktop app, opening another project spawns a new window and
        // leaves this one untouched; in a browser/PWA it switches in place
        // (each folder carries its own tabs).
        const inWindowMode = document.documentElement.dataset.windowMode === '1';
        pathChip.title = inWindowMode
          ? `Current project folder: ${projectPath}\n`
            + 'Click to open another project in a new window — this one stays put.'
          : `Current project folder: ${projectPath}\n`
            + 'Click to switch to a different project folder';
      }
      pathDisplay.classList.remove('is-empty');
    }
  };

  if (undoBtn) {
    undoBtn.addEventListener('click', async () => {
      if (currentConversation) {
        await currentConversation.undo();
        updateButtons();
      }
    });
  }
  if (redoBtn) {
    redoBtn.addEventListener('click', async () => {
      if (currentConversation) {
        await currentConversation.redo();
        updateButtons();
      }
    });
  }
  // The chip is a real button opted out of the header drag region (CSS
  // --wails-draggable: no-drag), so a plain click reliably opens the picker —
  // no pointer-drag disambiguation needed.
  if (pathChip) {
    pathChip.addEventListener('click', openPicker);
  }

  // Inline "open new window" button. Spawns a fresh juggler window in
  // no-project mode (the user then picks a folder). Only a native desktop
  // window has a host able to do this; in a remote browser tab apiService
  // .newWindow() is a no-op and the button is hidden by CSS anyway.
  const openNewWindow = async () => {
    try {
      const { default: apiService } = await import('../services/api.js');
      await apiService.newWindow();
    } catch (err) {
      const { extractUserMessage } = await import('../../sdk/lib/error-utils.js');
      await showAlert(extractUserMessage(err), 'New window');
    }
  };
  if (newWindowBtn) {
    newWindowBtn.addEventListener('click', openNewWindow);
  }
  // ⇧⌘N / Ctrl+Shift+N — same action as the button. Desktop only: a plain browser
  // tab has no native host to open a window, so we return false and leave ⇧⌘N to
  // the browser (its own new-window/incognito) rather than swallowing it as a
  // no-op. On the desktop this is the sole handler for the chord — the native File
  // ▸ New Window menu item shares the accelerator for display and click.
  keyShortcutManager.register('new-window', () => {
    if (!hasNativeHost()) return false;
    void openNewWindow();
    return true;
  });

  // The native Session ▸ New Window menu item and its ⇧⌘N accelerator dispatch this
  // event on the focused window. The native accelerator preempts the webview
  // keydown in the desktop app, so the keyShortcutManager binding above only runs
  // in browser tabs; routing the menu/keyboard case back through openNewWindow()
  // means such a window carries THIS window's live theme and font size to the
  // child — the same single path as the header button, never a global last-used
  // seed.
  window.addEventListener('juggler:new-window', () => { void openNewWindow(); });

  // Connected-clients indicator. Shows how many OTHER clients share this
  // session (the server's count includes this one, so subtract it), and hides
  // itself when this is the only client. Clicking opens Connectivity settings.
  const updateClientsIndicator = (/** @type {number} */ total) => {
    if (!clientsIndicator) return;
    const others = Math.max(0, (total || 1) - 1);
    if (others > 0) {
      if (clientsCountLabel) clientsCountLabel.textContent = `+${others}`;
      clientsIndicator.title = others === 1
        ? '1 other client is connected'
        : `${others} other clients are connected`;
      clientsIndicator.hidden = false;
    } else {
      clientsIndicator.hidden = true;
    }
  };
  if (clientsIndicator) {
    clientsIndicator.addEventListener('click', () => {
      openSettings('connectivity');
    });
    // Live updates as viewers join/leave.
    wsService.on('clients-changed', (/** @type {any} */ data) => updateClientsIndicator(data?.count));
    // Seed the initial count: the join broadcast may have fired before this
    // listener was attached, so fetch the authoritative count once at startup.
    // An offline seed failure is corrected by a later clients-changed.
    fetchJson(apiUrl('/connectivity'), { fallback: null })
      .then((c) => { if (c) updateClientsIndicator(c.clientCount); });
  }

  // Native menu (Session ▸ Open…) bridges to the picker via this event, since the
  // Go side can't import the JS module directly. Same entry point as the
  // header path-display click above.
  window.addEventListener('juggler:open-project', openPicker);

  // Keyboard shortcuts (undo / redo) — bindings and platform handling live in the
  // KeyShortcutManager; here we only supply the behaviour. Each returns truthy
  // only when it actually acts, so the manager preventDefaults exactly then (and
  // a no-op — busy, or nothing to undo — falls through untouched). The manager's
  // own input-field guard keeps ⌘Z out of the composer, which has native undo.
  keyShortcutManager.register('undo', () => {
    if (!currentConversation || isBusy() || !currentConversation.canUndo()) return false;
    void currentConversation.undo().then(updateButtons);
    return true;
  });
  keyShortcutManager.register('redo', () => {
    if (!currentConversation || isBusy() || !currentConversation.canRedo()) return false;
    void currentConversation.redo().then(updateButtons);
    return true;
  });

  // Subscribe to session events to keep buttons + path display fresh
  session.subscribe(/** @param {{type: string}} event */ (event) => {
    switch (event.type) {
      case 'session:loaded':
        updateProjectPath(session.projectPath || '');
        bindToVisible();
        break;
      case 'conversation:changed':
      case 'conversation:switched':
      case 'conversation:created':
      case 'conversation:deleted':
      case 'contextItems:changed':
        bindToVisible();
        break;
    }
  });

  // Initial state
  updateProjectPath(session.projectPath || '');
  bindToVisible();
}

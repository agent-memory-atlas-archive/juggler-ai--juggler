//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import {
  getAttentionPrefs,
  setSoundEnabled,
  setNotifyEnabled,
  setTabHighlightEnabled,
  setTabReorderEnabled,
  setChimeParam,
  resetChimeParams,
  randomizeChimeParams,
  previewChime,
  ATTENTION_PREFS_EVENT,
} from '../../utils/attention-manager.js';
import { chimePatterns, chimeSounds } from '../../utils/chime-synth.js';

/**
 * Build a labelled on/off toggle row matching the keyless-provider toggle markup
 * (`.provider-toggle-wrapper` > checkbox + `.toggle-switch` label). Shared by the
 * Notifications and Info cards tabs, so it lives at module scope rather than on
 * either tab.
 * @param {string} name - Control label.
 * @param {string} description - Sub-label hint.
 * @param {boolean} checked - Initial state.
 * @param {(on: boolean) => void} onChange - Called with the new state.
 * @returns {{row: HTMLElement, input: HTMLInputElement}} The row and its checkbox input.
 */
export function buildToggleRow(name, description, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'settings-group provider-field';

  const info = document.createElement('div');
  info.className = 'provider-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'provider-name';
  nameEl.textContent = name;
  const desc = document.createElement('div');
  desc.className = 'provider-description';
  desc.textContent = description;
  info.appendChild(nameEl);
  info.appendChild(desc);

  const ctrl = document.createElement('div');
  ctrl.className = 'provider-control';
  const wrapper = document.createElement('div');
  wrapper.className = 'provider-toggle-wrapper';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'provider-toggle';
  input.id = `attention-${name.toLowerCase().replace(/[^a-z]+/g, '-')}-toggle`;
  input.checked = checked;
  const label = document.createElement('label');
  label.setAttribute('for', input.id);
  label.className = 'toggle-switch';
  input.addEventListener('change', () => onChange(input.checked));
  wrapper.appendChild(input);
  wrapper.appendChild(label);
  ctrl.appendChild(wrapper);

  row.appendChild(info);
  row.appendChild(ctrl);
  return { row, input };
}

/**
 * Notifications tab: per-window attention prefs (sound, notify) with abstract
 * rotary controls for the chime voice, plus a Tabs section for what a
 * conversation's tab may do to get noticed (flash, move to the top). All values
 * come from localStorage (the attention-manager), so it renders eagerly with no
 * server fetch, and keeps its controls in sync with the header bell via
 * ATTENTION_PREFS_EVENT.
 */
export class NotificationsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {((e: Event) => void)|null} @private - Re-syncs the Notifications controls when prefs change elsewhere (e.g. the header bell). */
    this._onAttentionPrefs = null;
  }

  /** Eager render into the tab's section (called from the shell's render()). */
  render() {
    this.renderNotificationsForm();
  }

  /**
   * Element disconnected: drop the prefs listener.
   */
  dispose() {
    if (this._onAttentionPrefs) {
      window.removeEventListener(ATTENTION_PREFS_EVENT, this._onAttentionPrefs);
      this._onAttentionPrefs = null;
    }
  }

  /**
   * Render the Notifications tab: per-window attention prefs (sound, notify),
   * abstract rotary controls for the chime voice, and the Tabs section below
   * them. Reads initial values from {@link getAttentionPrefs} (localStorage, no
   * server fetch) and keeps every control in sync with prefs changed elsewhere
   * via {@link ATTENTION_PREFS_EVENT} — so the sound toggle and the header bell
   * always reflect the same `sound` pref.
   * @private
   */
  renderNotificationsForm() {
    const container = this.host.querySelector('#notifications-form');
    if (!container) return;
    const prefs = getAttentionPrefs();

    container.innerHTML = '';

    // The conversation's tab in the bar ALWAYS flashes when it needs you — that's
    // not a setting. This toggle governs only the extra out-of-app signal, which
    // differs by mode: a Dock-icon bounce in the desktop app, or a marker on this
    // browser tab's title in a browser. The copy names whichever one applies.
    const desktopApp = document.documentElement.dataset.windowMode === '1';

    // ── On/off toggles ────────────────────────────────────────────────
    // The sound toggle is the same `sound` pref the header bell drives; flipping
    // either updates the other live via ATTENTION_PREFS_EVENT.
    const soundRow = buildToggleRow(
      'Play notification sounds',
      'Chime when a conversation you’re not viewing needs you. Also toggled by the header bell.',
      prefs.sound,
      (on) => setSoundEnabled(on),
    );
    const notifyRow = buildToggleRow(
      desktopApp ? 'Bounce the Dock icon' : 'Flash the browser tab',
      desktopApp
        ? 'When a conversation needs attention, bounce the app’s Dock icon.'
        : 'When a conversation needs attention, mark this browser tab’s title so you can spot it',
      prefs.notify,
      (on) => setNotifyEnabled(on),
    );
    container.appendChild(soundRow.row);
    container.appendChild(notifyRow.row);

    // ── Chime voice controls (abstract, 0..1) ──────────────────────────
    const chimeRow = this._buildChimeControlsRow(prefs.chime);
    container.appendChild(chimeRow.row);

    // ── Tab behaviour (its own section below the alert surfaces) ───────
    const tabRows = this._renderTabBehaviourForm(prefs);

    // Keep this tab's controls in sync when prefs change elsewhere (the header
    // bell, or another open settings panel). Registered once; removed in
    // dispose().
    if (!this._onAttentionPrefs) {
      this._onAttentionPrefs = () => {
        const p = getAttentionPrefs();
        soundRow.input.checked = p.sound;
        notifyRow.input.checked = p.notify;
        if (tabRows) {
          tabRows.highlight.input.checked = p.tabHighlight;
          tabRows.reorder.input.checked = p.tabReorder;
        }
        chimeRow.controls.pattern.setValue(p.chime.pattern);
        chimeRow.controls.sound.setValue(p.chime.sound);
        chimeRow.controls.volume.setValue(p.chime.volume);
      };
      window.addEventListener(ATTENTION_PREFS_EVENT, this._onAttentionPrefs);
    }
  }

  /**
   * Render the Tabs section: what a conversation's tab in the sidebar is allowed
   * to do to get noticed. Both toggles are per-window, like the alert prefs above
   * them, and both are on by default — a tab announcing itself is the norm, and
   * these opt out of it.
   * @param {import('../../utils/attention-manager.js').AttentionPrefs} prefs
   * @returns {{highlight: {row: HTMLElement, input: HTMLInputElement}, reorder: {row: HTMLElement, input: HTMLInputElement}}|null} The
   *   built rows, or null when the section's container isn't present.
   * @private
   */
  _renderTabBehaviourForm(prefs) {
    const container = this.host.querySelector('#tab-behaviour-form');
    if (!container) return null;

    container.innerHTML = '';

    const highlightRow = buildToggleRow(
      'Highlight conversations that need attention',
      'Pulse a conversation’s tab while it’s waiting for you. With this off the tab stays plain, but the “Jump to conversation needing attention” shortcut still finds it.',
      prefs.tabHighlight,
      (on) => setTabHighlightEnabled(on),
    );
    const reorderRow = buildToggleRow(
      'Updated conversations move to the top',
      'Float a conversation’s tab up the list when you send to it, when it finishes, and when it needs your approval. Output arriving mid-turn leaves the order alone. With this off, tabs only move when you drag them.',
      prefs.tabReorder,
      (on) => setTabReorderEnabled(on),
    );
    container.appendChild(highlightRow.row);
    container.appendChild(reorderRow.row);

    return { highlight: highlightRow, reorder: reorderRow };
  }

  /**
   * Build the chime customisation section: a Pattern popup and a Sound popup (the
   * curated menus), a Volume rotary, and the preview/random/reset buttons.
   * @param {import('../../utils/chime-synth.js').ChimeParams} chime
   * @returns {{row: HTMLElement, controls: {pattern: {setValue: (v: string) => void}, sound: {setValue: (v: string) => void}, volume: {setValue: (v: number) => void}}}} The row and named controls.
   * @private
   */
  _buildChimeControlsRow(chime) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field chime-controls-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Chime';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Pick a pattern and sound, set the volume, and preview it.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control chime-controls';

    // The two curated popup menus (tune + timbre).
    const menus = document.createElement('div');
    menus.className = 'chime-menus';
    const pattern = this._buildChimeSelect('Pattern', chimePatterns(), chime.pattern, (v) => {
      setChimeParam('pattern', v);
      previewChime();
    });
    const sound = this._buildChimeSelect('Sound', chimeSounds(), chime.sound, (v) => {
      setChimeParam('sound', v);
      previewChime();
    });
    menus.appendChild(pattern.el);
    menus.appendChild(sound.el);
    ctrl.appendChild(menus);

    // The volume rotary sits with the preview/reset buttons on the action row.
    const actions = document.createElement('div');
    actions.className = 'chime-actions';
    const volume = this._buildChimeRotary('Volume', chime.volume, (v) => setChimeParam('volume', v), () => previewChime());
    actions.appendChild(volume.el);

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'settings-btn primary small chime-preview-btn';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => previewChime());
    actions.appendChild(previewBtn);

    // Roll a new pattern + sound. Both menus re-sync from the prefs event, same
    // as Reset; previewing is the point of the button, so there's no silent roll.
    const randomBtn = document.createElement('button');
    randomBtn.type = 'button';
    randomBtn.className = 'settings-btn small chime-random-btn';
    randomBtn.textContent = 'Random';
    randomBtn.addEventListener('click', () => {
      randomizeChimeParams();
      previewChime();
    });
    actions.appendChild(randomBtn);

    // Reset every control to the default voice. The resulting prefs event
    // re-syncs the menus/rotary via _onAttentionPrefs, then we preview it.
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'settings-btn small chime-reset-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
      resetChimeParams();
      previewChime();
    });
    actions.appendChild(resetBtn);

    ctrl.appendChild(actions);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, controls: { pattern, sound, volume } };
  }

  /**
   * Build one labelled popup menu (a native `<select>`) for a curated chime list.
   * @param {string} name - Control label ('Pattern' | 'Sound').
   * @param {Array<{id: string, name: string}>} options - The menu entries.
   * @param {string} value - The currently selected id.
   * @param {(v: string) => void} onChange - Called with the new id on selection.
   * @returns {{el: HTMLElement, select: HTMLSelectElement, setValue: (v: string) => void}} The wrapper, select, and setter.
   * @private
   */
  _buildChimeSelect(name, options, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'chime-select-field';

    const label = document.createElement('span');
    label.className = 'chime-select-label';
    label.textContent = name;

    const select = document.createElement('select');
    select.className = 'chime-select';
    select.setAttribute('aria-label', name);
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.id;
      el.textContent = opt.name;
      select.appendChild(el);
    }
    const setValue = (/** @type {string} */ v) => {
      select.value = v;
      // A stored id no longer in the list (a removed entry) leaves value unset;
      // fall back to the first option so the menu always shows a real choice.
      if (!select.value && select.options.length) select.selectedIndex = 0;
    };
    setValue(value);
    select.addEventListener('change', () => onChange(select.value));

    wrap.appendChild(label);
    wrap.appendChild(select);
    return { el: wrap, select, setValue };
  }

  /**
   * Build one drag-up/down rotary chime control.
   * @param {string} name
   * @param {number} value
   * @param {(v: number) => void} onInput
   * @param {() => void} onRelease
   * @returns {{el: HTMLElement, input: HTMLInputElement, setValue: (v: number) => void}} The wrapper, hidden range input, and setter.
   * @private
   */
  _buildChimeRotary(name, value, onInput, onRelease) {
    const wrap = document.createElement('label');
    wrap.className = 'chime-rotary';

    const knob = document.createElement('span');
    knob.className = 'chime-rotary-knob';
    const outer = document.createElement('span');
    outer.className = 'chime-rotary-outer';
    const inner = document.createElement('span');
    inner.className = 'chime-rotary-inner';
    const tick = document.createElement('span');
    tick.className = 'chime-rotary-tick';
    knob.appendChild(outer);
    knob.appendChild(inner);
    knob.appendChild(tick);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'chime-rotary-input';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(value);
    input.setAttribute('aria-label', name);
    input.setAttribute('orient', 'vertical');

    const label = document.createElement('span');
    label.className = 'chime-rotary-label';
    label.textContent = name;

    const setValue = (/** @type {number} */ v) => {
      const clamped = Math.max(0, Math.min(1, v));
      input.value = String(clamped);
      knob.style.setProperty('--angle', `${120 + (clamped * 300)}deg`);
    };

    let dragStartY = 0;
    let dragStartValue = 0;
    let dragging = false;
    /** @type {number | null} */
    let activePointerId = null;

    input.addEventListener('input', () => {
      setValue(Number(input.value));
      onInput(Number(input.value));
    });

    input.addEventListener('change', () => onRelease());

    // The move/end listeners live on window, not the knob, so a drag keeps
    // tracking the finger after it leaves the small dial — pointer capture is
    // unreliable in the mobile WebView, so we don't depend on it to hold.
    const onMove = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== activePointerId) return;
      const dy = dragStartY - e.clientY;
      if (Math.abs(dy) > 2) dragging = true;
      const next = dragStartValue + (dy / 140);
      setValue(next);
      onInput(Number(input.value));
    };
    const endDrag = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== activePointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      if (knob.hasPointerCapture(activePointerId)) knob.releasePointerCapture(activePointerId);
      activePointerId = null;
      if (e.type === 'pointercancel') return;
      if (!dragging) input.focus();
      onRelease();
    };

    knob.addEventListener('pointerdown', (e) => {
      if (activePointerId !== null) return;
      activePointerId = e.pointerId;
      dragging = false;
      dragStartY = e.clientY;
      dragStartValue = Number(input.value);
      try { knob.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      e.preventDefault();
    });

    setValue(value);
    wrap.appendChild(knob);
    wrap.appendChild(input);
    wrap.appendChild(label);
    return { el: wrap, input, setValue };
  }
}

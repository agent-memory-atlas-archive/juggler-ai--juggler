//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Custom tooltip controller.
 *
 * Replaces the browser's native `title=` tooltip — which is slow (~1s delay),
 * unstyleable, and OS-dependent — with a single styled surface that matches the
 * app's popup chrome. It is a *drop-in*: it consumes the `title` attributes
 * already present across the markup, so no element needs to change. On hover the
 * native `title` is stashed away (suppressing the OS tooltip) and restored on
 * leave, keeping the attribute the source of truth for accessibility tools.
 *
 * One delegated listener at the document root handles every current and future
 * titled element (dynamically-rendered nodes included). A single reused surface
 * is appended to <body>.
 * @module services/tooltip-manager
 */

import keyShortcutManager from './key-shortcut-manager.js';

/** ms a pointer must rest on an element before the tooltip appears. */
const SHOW_DELAY = 900;
/** After a tooltip hides, re-show within this window is instant (toolbar feel). */
const WARM_WINDOW = 400;
/**
 * Screen-edge keepout (CSS px) for the viewport-clamp math. This operates purely
 * in the px coordinate space of getBoundingClientRect/clientWidth — it is window
 * geometry, not an authored component size (the surface's own gap, padding, and
 * caret inset are all rem, in components.css).
 */
const VIEWPORT_KEEPOUT = 8;

class TooltipManager {
  constructor() {
    /**
     * The single reused surface.
     * @type {HTMLElement|null}
     * @private
     */
    this._el = null;
    /**
     * Element the visible/pending tooltip belongs to.
     * @type {HTMLElement|null}
     * @private
     */
    this._anchor = null;
    /**
     * setTimeout handle for the show delay.
     * @type {number}
     * @private
     */
    this._showTimer = 0;
    /**
     * Timestamp of the last hide, for the warm window.
     * @type {number}
     * @private
     */
    this._lastHide = 0;
    /**
     * Stashed native title text per element.
     * @type {WeakMap<Element,string>}
     * @private
     */
    this._stash = new WeakMap();
    /** @private */
    this._installed = false;
  }

  /**
   * Show the tooltip for an element right now, bypassing the hover delay. For
   * controls whose explanation must also surface on click/tap — touch has no
   * hover, so a native `title` alone would never appear there. Adopts the anchor
   * (stashing its `title`) and shows immediately; it then dismisses on the next
   * pointerdown / scroll / keypress like any other tooltip.
   * @param {HTMLElement|null} anchor - The titled element to describe.
   */
  showFor(anchor) {
    if (!anchor) return;
    if (this._anchor !== anchor) this._begin(anchor);
    clearTimeout(this._showTimer);
    this._showTimer = 0;
    this._show(anchor);
  }

  /** Wire the global listeners. Idempotent. */
  install() {
    if (this._installed || typeof document === 'undefined') return;
    this._installed = true;

    // Pointer path. pointerover/out bubble, so one pair covers everything.
    document.addEventListener('pointerover', this._onPointerOver, true);
    document.addEventListener('pointerout', this._onPointerOut, true);

    // Keyboard path — show on keyboard focus only (not programmatic/mouse focus,
    // which would pop tooltips the user never asked for).
    document.addEventListener('focusin', this._onFocusIn, true);
    document.addEventListener('focusout', this._onDismiss, true);

    // Anything that moves the anchor or shifts intent kills the tooltip at once.
    document.addEventListener('pointerdown', this._onDismiss, true);
    document.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('scroll', this._onDismiss, true);
    window.addEventListener('blur', this._onDismiss, true);
    document.addEventListener('visibilitychange', this._onDismiss, true);
  }

  /**
   * The nearest ancestor (incl. self) that carries a tooltip, or null.
   * Matches a live `title` or our stashed marker (the element currently hovered
   * has had its `title` removed and replaced by `data-has-tooltip`).
   * @param {EventTarget|null} target - Event target to resolve from.
   * @returns {HTMLElement|null} The titled anchor element, or null.
   * @private
   */
  _resolveAnchor(target) {
    const node = /** @type {any} */ (target);
    if (!node || typeof node.closest !== 'function') return null;
    const el = /** @type {HTMLElement|null} */ (node.closest('[title], [data-has-tooltip]'));
    if (!el) return null;
    const text = el.getAttribute('title') ?? this._stash.get(el);
    return text && text.trim() ? el : null;
  }

  /**
   * @param {PointerEvent} e - The pointerover event.
   * @private
   */
  _onPointerOver = (e) => {
    // Touch has no hover — tapping shouldn't summon a tooltip.
    if (e.pointerType === 'touch') return;
    const anchor = this._resolveAnchor(e.target);
    if (!anchor || anchor === this._anchor) return;
    this._begin(anchor);
  };

  /**
   * @param {PointerEvent} e - The pointerout event.
   * @private
   */
  _onPointerOut = (e) => {
    if (!this._anchor) return;
    // Ignore moves that stay inside the current anchor (child → child).
    const to = /** @type {Node|null} */ (e.relatedTarget);
    if (to && this._anchor.contains(to)) return;
    this._end();
  };

  /**
   * @param {FocusEvent} e - The focusin event.
   * @private
   */
  _onFocusIn = (e) => {
    const anchor = this._resolveAnchor(e.target);
    if (!anchor || anchor === this._anchor) return;
    // Only for keyboard focus; mouse/programmatic focus shouldn't pop a tooltip.
    if (anchor.matches && !anchor.matches(':focus-visible')) return;
    this._begin(anchor);
  };

  /**
   * @param {KeyboardEvent} e - The keydown event.
   * @private
   */
  _onKeyDown = (e) => {
    if (e.key === 'Escape') this._end();
    else this._onDismiss();
  };

  /** @private */
  _onDismiss = () => { if (this._anchor) this._end(); };

  /**
   * Adopt an anchor: stash its native title and schedule (or warm-show) the tip.
   * @param {HTMLElement} anchor - The element to attach the tooltip to.
   * @private
   */
  _begin(anchor) {
    if (this._anchor) this._restore(this._anchor);
    clearTimeout(this._showTimer);

    this._anchor = anchor;
    const text = anchor.getAttribute('title');
    if (text !== null) {
      // Strip the native title so the OS tooltip never fires; mark for selector
      // matching while stripped. Restored verbatim on leave.
      this._stash.set(anchor, text);
      anchor.removeAttribute('title');
      anchor.setAttribute('data-has-tooltip', '');
    }

    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (now - this._lastHide < WARM_WINDOW) {
      this._show(anchor);
    } else {
      this._showTimer = window.setTimeout(() => this._show(anchor), SHOW_DELAY);
    }
  }

  /**
   * Tear down the current anchor: cancel any pending show, hide, restore title.
   * @private
   */
  _end() {
    clearTimeout(this._showTimer);
    this._showTimer = 0;
    const anchor = this._anchor;
    this._anchor = null;
    if (anchor) this._restore(anchor);
    if (this._el && this._el.classList.contains('is-visible')) {
      this._el.classList.remove('is-visible');
      this._lastHide = typeof performance !== 'undefined' ? performance.now() : 0;
    }
  }

  /**
   * Put a stashed native title back on its element — unless the element was
   * given a new title while the tooltip held the old one (a control whose
   * state changed under the pointer), in which case the new one stands.
   * @param {Element} anchor - The element to restore.
   * @private
   */
  _restore(anchor) {
    const text = this._stash.get(anchor);
    if (text !== undefined) {
      if (!anchor.hasAttribute('title')) anchor.setAttribute('title', text);
      this._stash.delete(anchor);
    }
    anchor.removeAttribute('data-has-tooltip');
  }

  /**
   * The lazily-created surface.
   * @returns {HTMLElement} The reused tooltip element.
   * @private
   */
  _surface() {
    if (this._el) return this._el;
    const el = document.createElement('div');
    el.className = 'app-tooltip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this._el = el;
    return el;
  }

  /**
   * Append the platform-correct keystroke to a tooltip when its anchor declares
   * a `data-shortcut-id`, so buttons advertise their shortcut without any
   * hard-coded key text in the markup. The manager is the source of the combo.
   * @param {HTMLElement} anchor - The titled anchor.
   * @param {string} text - The base tooltip text.
   * @returns {string} The text, with " (⌘K)"-style suffix when a shortcut applies.
   * @private
   */
  _withShortcut(anchor, text) {
    const id = anchor.getAttribute('data-shortcut-id');
    if (!id) return text;
    const combo = keyShortcutManager.formatBinding(id);
    return combo ? `${text} (${combo})` : text;
  }

  /**
   * Render and position the surface against an anchor, then animate it in.
   * @param {HTMLElement} anchor - The element the tooltip describes.
   * @private
   */
  _show(anchor) {
    // Guard against a hide that landed during the delay.
    if (this._anchor !== anchor || !anchor.isConnected) return;
    const text = this._stash.get(anchor) ?? anchor.getAttribute('title');
    if (!text) return;

    const el = this._surface();
    el.textContent = this._withShortcut(anchor, text);

    // Measure with the surface laid out but not yet animating.
    const a = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;

    // Position the surface so it just touches the anchor edge; the visible gap
    // is applied in CSS (margin-top, in rem) so it scales with font-size zoom.
    // Prefer above; flip below when there's no room above the anchor.
    let below = false;
    let top = a.top - th;
    if (top < VIEWPORT_KEEPOUT) {
      const belowTop = a.bottom;
      if (belowTop + th <= vh - VIEWPORT_KEEPOUT || belowTop < a.top) {
        top = belowTop;
        below = true;
      }
    }

    // Centre horizontally on the anchor, clamped to the viewport.
    let left = a.left + a.width / 2 - tw / 2;
    left = Math.max(VIEWPORT_KEEPOUT, Math.min(left, vw - tw - VIEWPORT_KEEPOUT));

    // Caret offset within the surface (px coordinate); CSS clamps it clear of
    // the rounded corners via clamp() with a rem inset.
    const arrowX = a.left + a.width / 2 - left;

    el.classList.toggle('app-tooltip--below', below);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.setProperty('--tt-arrow-x', `${Math.round(arrowX)}px`);
    el.setAttribute('aria-hidden', 'false');
    // Next frame so the transition runs from the hidden state.
    requestAnimationFrame(() => {
      if (this._anchor === anchor) el.classList.add('is-visible');
    });
  }
}

const tooltipManager = new TooltipManager();
tooltipManager.install();

export default tooltipManager;

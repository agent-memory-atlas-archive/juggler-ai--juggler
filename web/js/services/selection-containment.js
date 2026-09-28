//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Selection containment — keeps a mouse drag's selection where it started.
 *
 * Two rules, both about a drag the user never meant to make. A first-time user
 * swipes at the app the way they would swipe at a scrollable page, and without
 * these the result is most of the window turning blue.
 *
 *   - **A drag that begins on chrome selects nothing.** `user-select: none` is
 *     meant to say this by itself, and in Chromium and Firefox it does: the spec
 *     has the engine refuse to start a selection inside such an element.
 *     WebKit has never implemented that half (webkit.org/b/208682), so on macOS
 *     a drag begun on the header, the sidebar or a panel's empty state picks up
 *     at the nearest text instead and runs away across the page. Cancelling
 *     `selectstart`, which WebKit does honour, closes the gap — so the policy in
 *     `css/base/text-selection.css` means the same thing on every engine.
 *     Cancelling `selectstart` rather than `mousedown` is deliberate: a cancelled
 *     `mousedown` also cancels moving the focus.
 *
 *   - **A drag that begins inside a column stays inside that column.** Selecting
 *     a passage of one transcript is worth having; a selection spanning the
 *     transcript and the properties panel beside it is not a passage, it is a
 *     mis-aimed sweep. CSS cannot express this — `user-select: contain` is
 *     specified but implemented by no engine — so the focus end is clamped back
 *     to the surface the drag started in as the selection changes.
 *
 * Only pointer drags are contained. A keyboard selection (shift+arrows, or
 * select-all) is deliberate and reaches exactly as far as it was asked to, so
 * the clamp is armed on `pointerdown` and disarmed once the gesture is over.
 * @module services/selection-containment
 */

/**
 * The surfaces a selection may not escape: each is a column or panel the user
 * reads on its own, and text from two of them is never one passage worth
 * copying. A selectable surface absent from this list is simply uncontained,
 * which is the browser default.
 */
export const SELECTION_ROOTS = [
  'conversation-area',
  'properties-panel',
  'workspace-panel',
  'pinboard-panel',
  'settings-panel',
  'modal-panel',
].join(', ');

/**
 * Whether a selection may begin on an element — the question
 * `css/base/text-selection.css` already answers, asked of the engine rather than
 * read off the stylesheet, so that a carve-out inside chrome (a text field, a
 * pin's content) answers for itself and no selector list has to be kept in step.
 * @param {Element} el - The element the gesture began on.
 * @returns {boolean} True when the policy makes this element unselectable.
 */
function forbidsSelectionStart(el) {
  const style = getComputedStyle(el);
  // Safari ships `user-select` prefixed only, so there the prefixed property
  // carries the answer and the unprefixed one is empty.
  return (style.webkitUserSelect || style.userSelect) === 'none';
}

/**
 * The surface a selection boundary point belongs to.
 * @param {Node|null} node - A boundary point's node.
 * @returns {Element|null} Its containment root, or null if it has none.
 */
function selectionRootOf(node) {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest(SELECTION_ROOTS) ?? null;
}

/**
 * Install containment on a document.
 * @param {Document} [doc] - Document to contain selections in.
 * @returns {() => void} Removes the containment again.
 */
export function installSelectionContainment(doc = document) {
  /** True while a primary-button pointer gesture is in flight. */
  let dragging = false;
  /** True when that gesture began somewhere a selection may not start. */
  let blockedOrigin = false;
  /** Set while the clamp writes, so the selectionchange it fires is ignored. */
  let clamping = false;

  /** @param {Event} e */
  const onPointerDown = (e) => {
    const pe = /** @type {PointerEvent} */ (e);
    if (pe.button !== 0) return;
    const target = /** @type {Element|null} */ (pe.target);
    dragging = true;
    blockedOrigin = !!target && forbidsSelectionStart(target);
  };

  /** @param {Event} e */
  const onSelectStart = (e) => {
    if (blockedOrigin) e.preventDefault();
  };

  const onSelectionChange = () => {
    if (!dragging || clamping) return;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed) return;
    const { anchorNode, anchorOffset, focusNode } = selection;
    // The anchor is where the drag began, so it — not where the pointer has got
    // to — decides which surface this selection belongs to.
    const root = selectionRootOf(anchorNode);
    if (!root || !focusNode || root.contains(focusNode)) return;

    // Clamp to the edge the selection left by, so it still runs to the end of
    // the surface the user is sweeping towards rather than snapping back to
    // where it started.
    const bounds = doc.createRange();
    bounds.selectNodeContents(root);
    const leftPastEnd =
      (root.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    clamping = true;
    try {
      selection.setBaseAndExtent(
        /** @type {Node} */ (anchorNode), anchorOffset,
        leftPastEnd ? bounds.endContainer : bounds.startContainer,
        leftPastEnd ? bounds.endOffset : bounds.startOffset,
      );
    } catch {
      // A boundary node that moved out from under the drag; leave it alone.
    } finally {
      clamping = false;
    }
  };

  // The gesture is over, but not necessarily before the selection it made is
  // reported: on a macOS trackpad `selectionchange` can arrive after the pointer
  // is already up, so disarming waits for the task after the release.
  const onPointerEnd = () => {
    if (!dragging) return;
    setTimeout(() => {
      dragging = false;
      blockedOrigin = false;
    }, 0);
  };

  // Capture, so a component that stops the gesture's propagation cannot leave
  // the clamp unarmed for the drag that follows.
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPointerEnd, true);
  doc.addEventListener('pointercancel', onPointerEnd, true);
  doc.addEventListener('selectstart', onSelectStart);
  doc.addEventListener('selectionchange', onSelectionChange);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointerup', onPointerEnd, true);
    doc.removeEventListener('pointercancel', onPointerEnd, true);
    doc.removeEventListener('selectstart', onSelectStart);
    doc.removeEventListener('selectionchange', onSelectionChange);
  };
}

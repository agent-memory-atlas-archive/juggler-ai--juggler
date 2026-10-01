//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The fade a modal's scrim makes on its way out.
 *
 * A `<modal-backdrop>` fades in by CSS alone (overlay-chrome.css), because
 * every modal arrives the same way: the element is inserted, or its host goes
 * from `display: none` to shown, and either restarts the animation. Leaving is
 * the opposite. Each modal goes in its own way — removed, emptied, or hidden by
 * a class — and all of them do it at once, so the scrim is gone before a frame
 * of any fade could be drawn.
 *
 * Rather than teach a dozen close paths to wait, the scrim is left behind: a
 * stand-in with the same paint is put on `<body>` where it was, fades, and
 * removes itself. The modal itself still closes the instant it is asked to, so
 * nothing that reads its state afterwards — focus, the popup manager, a test —
 * sees a modal half-gone. The stand-in takes no pointer events, so the page is
 * live again under it from the first frame.
 * @module utils/modal-scrim
 */

/**
 * A duration token from the stylesheet, in milliseconds.
 * @param {string} name - The custom property, e.g. `--modal-scrim-fade`.
 * @param {number} fallback - Used when the property is missing or unreadable.
 * @returns {number} The duration in ms.
 */
export function durationToken(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value : value * 1000;
}

/**
 * Leave a fading copy of every scrim showing inside `root`. Call it just before
 * the modal hides, removes or empties itself. A scrim that is not showing —
 * the modal was already closed, or it draws a transparent one, as a notice does
 * — leaves nothing behind, so calling it from a close that may run twice is
 * harmless.
 * @param {ParentNode} root - The modal's host or root element.
 */
export function fadeOutScrims(root) {
  const scrims = Array.from(root.querySelectorAll('modal-backdrop')).filter((el) => el.getClientRects().length > 0);
  if (scrims.length === 0) return;

  const duration = durationToken('--modal-scrim-fade', 200);
  for (const scrim of scrims) {
    const paint = getComputedStyle(scrim);
    if (paint.backgroundColor === 'transparent' || paint.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
    const rect = scrim.getBoundingClientRect();
    const ghost = document.createElement('modal-backdrop');
    ghost.className = 'is-leaving';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.background = paint.backgroundColor;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    // Starts from the scrim's opacity at this moment, so a modal closed while
    // its scrim was still fading in fades out from there rather than jumping.
    ghost.style.setProperty('--scrim-from', paint.opacity);
    document.body.appendChild(ghost);
    // Removed on a timer rather than on `animationend`: a window that is not
    // painting does not run the animation, and the stand-in must still go.
    setTimeout(() => ghost.remove(), duration + 50);
  }
}

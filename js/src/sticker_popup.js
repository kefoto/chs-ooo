/**
 * Silhouette-then-reveal popup for a sticker earned mid-trial. Browser
 * counterpart to GameLayer.animate_sticker_reveal in
 * experiments/game_layer.py.
 *
 * Appended to document.body, not the per-trial jsPsych `display` element --
 * the popup outlives a single trial's 800ms feedback window (~2.6s total),
 * and jsPsych wipes display.innerHTML the moment a trial finishes.
 *
 * The silhouette is the SAME art as the reveal, not a second asset: a CSS
 * filter (brightness(0), the shape with the colour thrown away) removed at
 * the reveal beat is the same "shape only, no colour" idea
 * GameLayer.silhouette_pixmap uses, just done with a filter instead of a
 * paint mask.
 */

let reducedMotion = false;

export function initStickerPopup({ reducedMotion: rm } = {}) {
  reducedMotion = Boolean(rm);
}

/**
 * @param {object} opts
 * @param {string} [opts.artUrl]   sticker image; falls back to `emoji` text
 * @param {string} [opts.emoji]
 * @param {function} [opts.onReveal]  called at the reveal beat (for the sfx)
 *
 * Skipped entirely under reduced-stimulation mode, not merely shortened:
 * this is a new element appearing and moving on screen, which is exactly
 * what that mode exists to prevent.
 */
export function showStickerReveal({ artUrl, emoji, onReveal } = {}) {
  if (reducedMotion || (!artUrl && !emoji)) return;

  const card = document.createElement("div");
  card.className = "sticker-popup";
  card.innerHTML = artUrl
    ? `<img class="sticker-popup-art silhouette" src="${artUrl}" alt="">
       <p class="sticker-popup-text">New sticker!</p>`
    : `<div class="sticker-popup-art sticker-popup-emoji silhouette">${emoji}</div>
       <p class="sticker-popup-text">New sticker!</p>`;
  document.body.appendChild(card);
  // Two frames so the browser paints the pre-transition state before the
  // class flips -- adding `visible` in the same frame the element is
  // inserted sometimes skips the CSS transition entirely.
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("visible")));

  setTimeout(() => {
    if (!card.isConnected) return;
    if (onReveal) onReveal();
    const art = card.querySelector(".silhouette");
    if (art) art.classList.remove("silhouette");
  }, 650);

  setTimeout(() => {
    if (!card.isConnected) return;
    card.classList.remove("visible");
    setTimeout(() => card.remove(), 420);
  }, 650 + 1400);
}

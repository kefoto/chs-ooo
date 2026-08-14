/**
 * Bounce-in card announcing a shop purchase, without navigating to a new
 * screen. Browser counterpart to GameLayer.animate_item_popup in
 * experiments/game_layer.py -- the shop-purchase sibling of
 * sticker_popup.js's mid-trial reveal, same bounce/settle beat, just
 * skipping that one's silhouette-then-reveal suspense: there is nothing to
 * build suspense about here, the child already knows they just bought
 * something, this is confirming what.
 *
 * Staying an OVERLAY on the current screen rather than navigating to a
 * dedicated reveal screen (an earlier design here, same one the desktop
 * build moved away from) is deliberate: the caller has already updated the
 * shop grid underneath -- new ownership/found-count, balance -- before
 * calling this, so nothing here is the record of what was won; the grid
 * already is.
 *
 * Anchored to the top right in a small vertical stack, so a second
 * purchase made while the first popup is still visible gets its own slot
 * below it instead of landing on top of it. Slots are assigned once, at
 * spawn time, and are not reflowed when an earlier popup finishes and
 * frees its slot -- with the rise-and-fade every popup already does, a gap
 * left behind closes itself within a couple of seconds without needing a
 * second, separate reflow animation to chase it.
 */

let reducedMotion = false;

export function initItemPopup({ reducedMotion: rm } = {}) {
  reducedMotion = Boolean(rm);
}

// Purchase popups this many or more deep re-use the last slot rather than
// continuing to stack downward off the bottom of the window -- only
// reachable by clicking "buy" faster than a ~2s popup lifetime repeatedly,
// not a session a real child produces, but an impatient adult testing the
// shop (or a headless script) can.
const MAX_SLOTS = 6;
const SLOT_HEIGHT = 84;
const slots = new Array(MAX_SLOTS).fill(false);

function claimSlot() {
  let i = slots.findIndex((s) => !s);
  if (i === -1) i = MAX_SLOTS - 1;
  slots[i] = true;
  return i;
}
function freeSlot(i) { slots[i] = false; }

/**
 * @param {object} opts
 * @param {string} [opts.artUrl]
 * @param {string} [opts.emoji]
 * @param {string} [opts.label]     the item's own name
 * @param {string} [opts.title]     "You got:" by default
 *
 * Skipped entirely under reduced-stimulation mode, like every other popup
 * here -- the shop grid is already the persistent record of what was
 * bought, so skipping the animation loses no information, only the
 * flourish.
 */
export function showItemPopup({ artUrl, emoji, label, title = "You got:" } = {}) {
  if (reducedMotion) return;

  const slot = claimSlot();
  const card = document.createElement("div");
  card.className = "item-popup";
  card.style.top = `${14 + slot * SLOT_HEIGHT}px`;
  card.innerHTML = artUrl
    ? `<img class="item-popup-art" src="${artUrl}" alt="">`
    : `<div class="item-popup-art item-popup-emoji">${emoji || "\u{1F381}"}</div>`;
  card.innerHTML += `<p class="item-popup-title">${title}</p>`
    + (label ? `<p class="item-popup-label">${label}</p>` : "");
  document.body.appendChild(card);
  // Two frames so the browser paints the pre-transition state before the
  // class flips -- adding `visible` in the same frame the element is
  // inserted sometimes skips the CSS transition entirely.
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("visible")));

  setTimeout(() => {
    if (!card.isConnected) return;
    card.classList.add("leaving");
    freeSlot(slot);
    setTimeout(() => card.remove(), 420);
  }, 2000);
}

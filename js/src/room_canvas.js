/**
 * One decoratable room: place stickers and furniture anywhere in it.
 * Port of experiments/playground.py (RoomCanvas).
 *
 * Free placement, no grid. Deciding WHERE is the only real autonomy the game
 * layer offers, and a snap target quietly makes that decision instead of the
 * child. Positions are recorded RELATIVE (0..1) so a room renders the same on
 * any screen.
 *
 *   The gesture, and why it is a real drag
 *   --------------------------------------
 *   Press picks something up, moving carries it, releasing puts it down. The
 *   sticker follows the pointer the whole way, drawn at the position it would
 *   actually LAND -- clamped -- so the clamping is never a surprise on
 *   release. Press-and-release without moving is the same code path, so
 *   tap-to-place still works for a child who does not drag.
 *
 *   Pressing a PLACED sticker picks it back up and MOVES it. It does not
 *   return to the tray on its own: a placement that cannot be adjusted is a
 *   trap, but a sticker that jumps back to the tray when brushed is worse --
 *   the child loses the position they had already chosen. Dragging it back
 *   down INTO the tray, deliberately, DOES return it -- to the shared
 *   pocket, not just this room's tray -- so it can be placed in a different
 *   mansion room. Port of the Python RoomCanvas's pocket-drop path (the
 *   ``retrieved`` signal); only a lifted PLACED item can trigger this, never
 *   one picked up from the tray itself.
 *
 * Dragging is a motor-planning task whose difficulty varies sharply across the
 * 4-6 and 7-10 age bins this study compares, which is why tap-to-place
 * remains a first-class path.
 *
 * This module is the VIEW alone, so both callers can share it: PlaygroundPlugin
 * (one room at a room boundary, the pre-mansion flow) and MansionPlugin (any of
 * the mansion's unlocked rooms, drawing from the shared pocket). They differ
 * only in what the footer says and where it goes next.
 */

export const EDGE = 0.05;   // EDGE_MARGIN_REL: keep a sticker fully on screen
// The top edge has no fixed floor of its own -- see clamp()'s per-kind margin
// below, which is what actually keeps an item on screen there. Mirrors
// experiments/playground.py's TOP_EDGE_MARGIN_REL.
export const TOP_EDGE = 0;
// Radius as a fraction of the smaller side. 0.11, matching
// playground.py's STICKER_REL: this build had drifted to 0.13, which drew
// stickers noticeably larger than the desktop's and crowded a room that only
// holds a handful of them.
export const STICKER_REL = 0.11;
// Furniture and animals are larger placeable decorations than a sticker --
// "larger" is the whole distinction between the categories.
export const FURNITURE_REL = 0.22;
// A guest animal's size. Bigger than furniture: a creature living in the room
// should read as an inhabitant, not as another ornament on the shelf. Port of
// playground.py's GUEST_REL.
export const GUEST_REL = 0.30;

export const relFor = (kind) =>
  (kind === "furniture" || kind === "animal" ? FURNITURE_REL : STICKER_REL);

/**
 * A sticker (or furniture item) as markup: its picture where there is one,
 * else the emoji.
 *
 * Drawn as text the glyph comes from whatever emoji font the machine has,
 * which is a tofu box on a Linux box with none installed -- the same reason
 * the desktop build renders stickers from PNGs. The emoji rides along as the
 * img's alt text, so a missing or unreachable file degrades to the character
 * rather than to an empty box, with no error handler needed.
 */
export function stickerHtml(s) {
  if (!s) return "";
  // draggable="false" because the browser's OWN drag-and-drop would otherwise
  // start on any press that lands on an <img>: the native drag takes over the
  // pointer, paints its own translucent copy of the picture under the cursor,
  // and the room never sees the pointermove/pointerup that would place the
  // item. Every gesture here is a pointer-event drag of our own, so the
  // built-in one is never wanted -- see also .sticker-art's user-drag rule.
  if (s.img) {
    return `<img class="sticker-art" src="${s.img}" alt="${s.emoji || ""}" draggable="false">`;
  }
  return s.emoji || "";
}

/**
 * Mount the room into `host`.
 *
 * @param {HTMLElement} host      where the markup goes
 * @param {object}   opts
 * @param {string}   opts.backdrop   room art url ("" for flat colour)
 * @param {Array}    opts.pending    the tray, in order
 * @param {Array}    opts.placed     what is already in the room
 * @param {Array}    opts.guests     animals living here: {id, emoji, img, x, y}
 * @param {boolean}  opts.reducedMotion  no idle squish on the guests
 * @param {string}   opts.prompt     the one line above the room
 * @param {number}   opts.roomIndex  recorded on every placement
 * @param {Function} opts.onPickUp   (item) -> void, when something is lifted
 * @param {Array}    opts.buttons    [{id, label, cls}] for the footer
 * @param {Function} opts.onButton   (id, events) -> void
 * @param {string}   opts.footerHtml extra markup in the footer (a coin chip)
 * @returns {{events: Array, destroy: Function}}
 */
export function mountRoomCanvas(host, opts) {
  const pending = [...(opts.pending || [])];
  const placed = [...(opts.placed || [])];
  const guests = [...(opts.guests || [])];
  const events = [];

  const buttons = (opts.buttons || []).map((b) =>
    `<button class="${b.cls || "big"}" id="${b.id}">${b.label}</button>`).join("");

  host.innerHTML = `
    <div class="screen playground">
      <p class="speech">${opts.prompt || ""}</p>
      <div class="room-wrap">
        <div class="room" id="room"
             style="${opts.backdrop ? `background-image:url('${opts.backdrop}')` : ""}">
          <div class="ghost" id="ghost" hidden></div>
        </div>
        <div class="tray" id="tray">
          <p class="tray-header" id="trayHeader"></p>
          <div class="tray-pager">
            <button class="tray-arrow" id="trayPrev" type="button"
                    aria-label="Previous row">&lsaquo;</button>
            <div class="tray-row" id="trayRow"></div>
            <button class="tray-arrow" id="trayNext" type="button"
                    aria-label="Next row">&rsaquo;</button>
          </div>
        </div>
      </div>
      <p class="hint" id="hint"></p>
      <div class="btn-row">${opts.footerHtml || ""}${buttons}</div>
    </div>`;

  const room = host.querySelector("#room");
  const tray = host.querySelector("#tray");
  const trayHeader = host.querySelector("#trayHeader");
  const trayRow = host.querySelector("#trayRow");
  const trayPrev = host.querySelector("#trayPrev");
  const trayNext = host.querySelector("#trayNext");
  const hint = host.querySelector("#hint");
  const ghost = host.querySelector("#ghost");
  // The drawer keeps a stable minimum width even with little or nothing
  // pending -- port of _drawer_layout's "n_slots is at least 1 even with
  // nothing pending, purely so the panel has a sensible width to sit at."
  // It is also the PAGE SIZE: the pocket is exactly one row of this many
  // slots, and a longer pending list is reached with the arrows rather than
  // by wrapping onto a second row. One row means the drawer's height never
  // changes, so the room above it never resizes mid-decoration -- a room that
  // shrank because a sticker was earned used to move every placement a child
  // had already made, relative to the walls they placed it against.
  const MIN_SLOTS = 6;
  //: Which page of the pocket is showing. Clamped in render(), never by the
  //: caller: placing an item shortens `pending`, and a page index that was
  //: valid before the placement can point past the end after it.
  let page = 0;
  const pageCount = () => Math.max(1, Math.ceil(pending.length / MIN_SLOTS));
  const trayHeaderText = () => {
    const base = `Your pocket · ${pending.length}`;
    // The page counter appears only when there IS more than one page. On the
    // common short pocket it would be a permanent "1/1" explaining nothing.
    return pageCount() > 1 ? `${base} · ${page + 1}/${pageCount()}` : base;
  };
  /** Bring `i`'s page into view. Port of playground.py's _ensure_slot_visible:
   *  after placing something, the newly-highlighted slot must not be sitting
   *  on a page nobody is looking at -- a child should not have to know to page
   *  across before they can see what a press in the room will lift. */
  const showPageOf = (i) => { page = Math.floor(Math.max(0, i) / MIN_SLOTS); };

  // held: the sticker in the hand -- either lifted from the room or taken from
  // the tray. Null when nothing is being dragged.
  let held = null;
  let fromTray = false;
  // Which pocket item a press in the room picks up. The child chooses it by
  // pressing that slot in the pocket (see the tray's own pointerdown), so a
  // pocket of ten things is ten choices rather than a queue that must be
  // emptied in order. Port of playground.py's `_selected`, including its
  // default: with nothing chosen yet the front of the tray is what a press
  // in the room lifts.
  let selected = 0;
  // The `placed` entry from the most recent drop() -- render() gives only
  // this one the landing animation. See the .sticker.landed rule.
  let justPlaced = null;

  const radius = (kind = "sticker") => {
    const r = room.getBoundingClientRect();
    return Math.min(r.width, r.height) * relFor(kind);
  };

  const hintText = () => {
    const retrieveNote = placed.length
      ? " Drag something back down to your pocket to save it for later."
      : "";
    return pending.length === 0
      ? `Looks great! Tap 'All done' when you're ready.${retrieveNote}`
      : pending.length === 1 ? `One more to put somewhere.${retrieveNote}`
      : `${pending.length} more to put somewhere.${retrieveNote}`;
  };

  /** Nearest valid drop point, keeping the item fully inside the room.
      The pocket is its own element below the room now (see .room-wrap),
      not an overlay eating the room's own bottom edge, so the room's full
      height is placeable -- only EDGE/TOP_EDGE's margins apply, symmetric
      top and bottom, the same as left and right.

      The margin widens to at least the DRAGGED ITEM'S OWN radius: EDGE and
      TOP_EDGE alone were sized for a sticker, and furniture is big enough that
      clamping its centre to a sticker-sized margin let a real chunk of the
      item hang off the room's edge. This is the DATA bound (where the centre
      may sit) and it has to stay at least as large as the DISPLAY bound (how
      far the drawn item reaches) or the two drift apart at the edge. */
  const clamp = (xRel, yRel, kind = "sticker") => {
    const r = room.getBoundingClientRect();
    const rad = radius(kind);
    const mx = Math.max(EDGE, rad / r.width);
    const my = Math.max(TOP_EDGE, rad / r.height);
    return [
      Math.min(Math.max(xRel, mx), 1 - mx),
      Math.min(Math.max(yRel, my), 1 - my),
    ];
  };

  const relFrom = (clientX, clientY, kind = "sticker") => {
    const r = room.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, (clientY - r.top) / r.height, kind);
  };

  /** Topmost placed sticker under a point, or -1. Reverse order so the one
      drawn on top is the one picked up. */
  const hitPlaced = (clientX, clientY) => {
    const rect = room.getBoundingClientRect();
    for (let i = placed.length - 1; i >= 0; i--) {
      const r = radius(placed[i].kind);
      const px = rect.left + placed[i].x * rect.width;
      const py = rect.top + placed[i].y * rect.height;
      if (Math.abs(px - clientX) <= r && Math.abs(py - clientY) <= r) return i;
    }
    return -1;
  };

  function render() {
    room.querySelectorAll(".sticker, .guest").forEach((n) => n.remove());
    // Guests FIRST, so they sit behind the child's own stickers and
    // furniture: a creature is part of the room being decorated, not a thing
    // on top of the decoration. Port of paintEvent's guest pass, which draws
    // in the same order and for the same reason.
    //
    // Not in `placed`, and with no id the hit-test can find: a guest cannot
    // be picked up, dragged, or sent to the pocket, which is what keeps every
    // interaction path below free of "unless it's a guest".
    const roomBox = room.getBoundingClientRect();
    const guestSize = Math.min(roomBox.width, roomBox.height) * GUEST_REL;
    for (const g of guests) {
      const size = guestSize;
      const el = document.createElement("div");
      el.className = opts.reducedMotion ? "guest" : "guest breathing";
      el.innerHTML = stickerHtml(g);
      el.style.left = `${g.x * 100}%`;
      el.style.top = `${g.y * 100}%`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.fontSize = `${size * 0.9}px`;
      room.appendChild(el);
    }
    for (const p of placed) {
      const size = radius(p.kind) * 2;
      const el = document.createElement("div");
      // Landing juice (see the .sticker.landed keyframes) plays only for
      // the item just dropped -- object identity against `justPlaced`,
      // not id, since re-placing a moved sticker keeps the same id but IS
      // a new landing.
      el.className = p === justPlaced ? "sticker landed" : "sticker";
      el.innerHTML = stickerHtml(p);
      el.style.left = `${p.x * 100}%`;
      el.style.top = `${p.y * 100}%`;
      el.style.fontSize = `${size * 0.78}px`;
      el.dataset.id = p.id;
      room.appendChild(el);
    }
    // Consumed: only the render() call immediately after drop() (the one
    // that just used it above) should show the animation. Without this, a
    // LATER render() from pickUp() -- which does not touch justPlaced --
    // would recreate the same element (render() always rebuilds from
    // scratch) and replay the landing pop on an unrelated action.
    justPlaced = null;
    if (selected >= pending.length) {
      selected = Math.max(0, pending.length - 1);
      // The selection just moved because the list shrank (something was
      // placed), so follow it -- otherwise placing the last item on page 2
      // leaves the pocket showing an empty page 2 while the highlighted slot
      // sits back on page 1.
      showPageOf(selected);
    }
    // Clamped after `pending` may have shrunk, and BEFORE the header is drawn
    // from it -- the header reports the page number.
    page = Math.max(0, Math.min(page, pageCount() - 1));
    trayHeader.textContent = trayHeaderText();

    const start = page * MIN_SLOTS;
    const shown = pending.slice(start, start + MIN_SLOTS);
    const slotsHtml = shown.map((s, j) => {
      // data-slot stays the index into `pending`, NOT into this page -- every
      // reader (pickUpFromTray, the drop paths, `selected`) indexes the real
      // list, so paging stays purely a matter of which slots are drawn.
      const i = start + j;
      // The one in the hand is out of the tray, not still sitting in it.
      const dragging = fromTray && held && held.id === s.id;
      // `next` marks the CHOSEN slot, not always the first: it is what a
      // press in the room will lift, and the child moves it by pressing a
      // different slot.
      return `<span class="tray-item${i === selected && !dragging ? " next" : ""}"
                    data-slot="${i}"
                    ${dragging ? 'style="visibility:hidden"' : ""}>${stickerHtml(s)}</span>`;
    }).join("");
    // The row always holds exactly MIN_SLOTS boxes, on every page including a
    // short last one, so the drawer is the same size whatever is in it and the
    // arrows never move under a finger that is reaching for them.
    const emptySlots = Math.max(0, MIN_SLOTS - shown.length);
    trayRow.innerHTML = slotsHtml
      + `<span class="tray-item empty"></span>`.repeat(emptySlots);

    // Disabled rather than hidden at the ends: a control that vanishes takes
    // the row's width with it and shifts every slot sideways mid-reach.
    trayPrev.disabled = page === 0;
    trayNext.disabled = page >= pageCount() - 1;
    // Nothing to page through at all -- keep the arrows out of the tab order
    // and off a screen reader's list, but still occupying their space.
    const onePage = pageCount() <= 1;
    trayPrev.classList.toggle("idle", onePage);
    trayNext.classList.toggle("idle", onePage);
    hint.textContent = hintText();
  }

  // Paging is not a placement and raises no event: it changes what is drawn,
  // nothing about the room or the pocket's contents.
  const turnPage = (d) => {
    page = Math.max(0, Math.min(page + d, pageCount() - 1));
    render();
  };
  trayPrev.addEventListener("click", () => turnPage(-1));
  trayNext.addEventListener("click", () => turnPage(1));

  const showGhost = (xRel, yRel) => {
    const size = radius(held?.kind) * 2;
    ghost.hidden = false;
    ghost.innerHTML = stickerHtml(held);
    ghost.style.left = `${xRel * 100}%`;
    ghost.style.top = `${yRel * 100}%`;
    ghost.style.width = `${size}px`;
    ghost.style.height = `${size}px`;
    ghost.style.fontSize = `${size * 0.78}px`;
  };

  const pickUp = (e) => {
    if (held) return;
    const i = hitPlaced(e.clientX, e.clientY);
    if (i >= 0) {
      // Picking a placed sticker back up takes priority over placing a new
      // one: a child who wants to move something should not have to empty the
      // tray first.
      [held] = placed.splice(i, 1);
      fromTray = false;
    } else if (pending.length) {
      // Whichever slot the child chose in the pocket, not always the front
      // of the queue.
      selected = Math.max(0, Math.min(selected, pending.length - 1));
      held = pending[selected];
      fromTray = true;
    } else {
      return;
    }
    room.setPointerCapture?.(e.pointerId);
    room.classList.add("dragging");
    opts.onPickUp?.(held);
    const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
    render();
    showGhost(x, y);
  };

  /**
   * A press ON a pocket slot picks THAT item up and starts carrying it, so
   * the pocket is a set of choices rather than a queue. Port of
   * mousePressEvent's `_hit_tray_slot` branch -- with the one difference that
   * the drawer is a separate element here rather than part of the room's own
   * canvas, so the press has to be caught on the drawer itself.
   *
   * The pointer is captured by the TRAY, which is what keeps the rest of the
   * gesture working: every later pointermove/pointerup for this pointer is
   * retargeted to the capturing element, so the tray needs the same
   * dragTo/drop listeners the room has (see the bottom of this function) and
   * the drag then behaves identically wherever it started.
   */
  const pickUpFromTray = (e) => {
    if (held) return;
    const slot = e.target.closest?.(".tray-item[data-slot]");
    if (!slot) return;
    const i = Number(slot.dataset.slot);
    if (!(i >= 0 && i < pending.length)) return;
    // Chosen even if the gesture turns out to be a tap that goes nowhere:
    // tapping a slot and then tapping the room is the tap-to-place path, and
    // it must place the item that was tapped.
    selected = i;
    held = pending[i];
    fromTray = true;
    tray.setPointerCapture?.(e.pointerId);
    room.classList.add("dragging");
    opts.onPickUp?.(held);
    const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
    render();
    showGhost(x, y);
  };

  /** Whether releasing at this point would retrieve the held item to the
      pocket rather than place it here -- over the drawer's own box (it is
      a separate element below the room now, not an overlay eating the
      room's bottom edge -- see .room-wrap), and only for an item lifted
      off the room (a tray item dropped low just clamps back onto the room
      floor, same as ever). Pointer capture keeps room's own pointermove/up
      listeners firing even once the cursor is over the drawer, so this
      still works despite the two being separate DOM elements now. */
  /** Pure geometry: is this point over the drawer's own box? */
  const overTrayBox = (clientX, clientY) => {
    const r = tray.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right
      && clientY >= r.top && clientY <= r.bottom;
  };

  const overTray = (clientX, clientY) =>
    Boolean(held) && !fromTray && overTrayBox(clientX, clientY);

  const dragTo = (e) => {
    if (!held) return;
    const hovering = overTray(e.clientX, e.clientY);
    tray.classList.toggle("receiving", hovering);
    trayHeader.textContent = hovering ? "Drop here to save it!" : trayHeaderText();
    // An item lifted OUT of the pocket and still held over it has not gone
    // anywhere yet -- releasing here just chooses it (see drop()), so showing
    // it hovering over the room floor would promise a placement that is not
    // about to happen.
    if (fromTray && overTrayBox(e.clientX, e.clientY)) {
      ghost.hidden = true;
      return;
    }
    const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
    showGhost(x, y);
  };

  const drop = (e) => {
    if (!held) return;
    tray.classList.remove("receiving");
    // Pressed a pocket slot and let go without leaving the pocket: that is a
    // TAP on a slot, and a tap chooses. Nothing is placed, nothing leaves the
    // pending list -- the child has simply said which item they want, and the
    // next press in the room puts that one down.
    if (fromTray && overTrayBox(e.clientX, e.clientY)) {
      held = null;
      fromTray = false;
      ghost.hidden = true;
      room.classList.remove("dragging");
      render();
      return;
    }
    if (overTray(e.clientX, e.clientY)) {
      // Retrieved: back to the shared pocket, not placed here. No entry in
      // `placed`/`justPlaced` -- there is nothing left in this room to
      // animate.
      pending.unshift(held);
      events.push({ retrieved_id: held.id, room_index: opts.roomIndex,
                    kind: held.kind || "sticker" });
      held = null;
      ghost.hidden = true;
      room.classList.remove("dragging");
      render();
      return;
    }
    const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
    // The CHOSEN slot leaves the pocket, not the front of the queue.
    if (fromTray) pending.splice(pending.indexOf(held), 1);
    const kind = held.kind || "sticker";
    const entry = { id: held.id, emoji: held.emoji, img: held.img, x, y, kind };
    placed.push(entry);
    justPlaced = entry;
    // CastleState.place() MOVES an already-placed sticker rather than
    // duplicating it, so re-recording a moved sticker is the move.
    events.push({ sticker_id: held.id, room_index: opts.roomIndex, x, y, kind });
    held = null;
    fromTray = false;
    ghost.hidden = true;
    room.classList.remove("dragging");
    render();
  };

  /**
   * Every item is sized from a measurement of the room taken at render time
   * (see radius()), so anything that changes the room's box leaves what is
   * already drawn at the OLD size until the next render -- and the next
   * render is usually the first pick-up, which is why picking something up
   * appeared to shrink it. The room's height is flex-derived, so it moves
   * whenever the surrounding text does: the webfont finishing loading is
   * enough to do it a beat after the room first paints.
   *
   * Re-rendering on the room's own resize keeps drawn size and measured size
   * in step, and covers window resizes and orientation changes for free.
   * render() only writes absolutely-positioned children, so it cannot change
   * the box it is reacting to -- no feedback loop.
   */
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      // Not mid-gesture: render() rebuilds the tray and would fight the drag
      // in progress. The ghost is already re-sized on every pointermove.
      if (held) return;
      render();
    })
    : null;
  resizeObserver?.observe(room);

  room.addEventListener("pointerdown", pickUp);
  room.addEventListener("pointermove", dragTo);
  room.addEventListener("pointerup", drop);
  // A pointer that leaves the window mid-drag must still put the sticker
  // down, or it is lost with the child holding nothing.
  room.addEventListener("pointercancel", drop);
  // The same three, on the drawer: a drag that STARTS on a pocket slot is
  // captured by the tray, so every later event for that pointer arrives here
  // instead of on the room. Same handlers, so a drag behaves identically
  // whichever of the two it began on.
  tray.addEventListener("pointerdown", pickUpFromTray);
  tray.addEventListener("pointermove", dragTo);
  tray.addEventListener("pointerup", drop);
  tray.addEventListener("pointercancel", drop);

  for (const b of opts.buttons || []) {
    const el = host.querySelector(`#${b.id}`);
    if (!el) continue;
    el.addEventListener("click", () => opts.onButton?.(b.id, events));
  }

  render();

  return {
    events,
    destroy() {
      resizeObserver?.disconnect();
      room.removeEventListener("pointerdown", pickUp);
      room.removeEventListener("pointermove", dragTo);
      room.removeEventListener("pointerup", drop);
      room.removeEventListener("pointercancel", drop);
      tray.removeEventListener("pointerdown", pickUpFromTray);
      tray.removeEventListener("pointermove", dragTo);
      tray.removeEventListener("pointerup", drop);
      tray.removeEventListener("pointercancel", drop);
    },
  };
}

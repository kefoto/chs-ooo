/**
 * The playground: place this room's stickers anywhere in the room.
 * Port of experiments/playground.py (RoomCanvas).
 *
 * Free placement, no grid. Deciding WHERE is the only real autonomy the game
 * layer offers, and a snap target quietly makes that decision instead of the
 * child. Positions are recorded RELATIVE (0..1) so a castle renders the same
 * on any screen.
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
 *   return to the tray: a placement that cannot be adjusted is a trap, but a
 *   sticker that jumps back to the tray when brushed is worse -- the child
 *   loses the position they had already chosen.
 *
 * Dragging is a motor-planning task whose difficulty varies sharply across the
 * 4-6 and 7-10 age bins this study compares, which is why tap-to-place remains
 * a first-class path and "Pip can do it" is always visible.
 */

const EDGE = 0.05;        // EDGE_MARGIN_REL: keep a sticker fully on screen
// The top edge has no fixed floor of its own -- see clamp()'s per-kind
// margin below, which is what actually keeps an item on screen there.
// Mirrors experiments/playground.py's TOP_EDGE_MARGIN_REL.
const TOP_EDGE = 0;
const TRAY_TOP = 0.80;    // below this the tray lives
const STICKER_REL = 0.13;   // radius as a fraction of the room's smaller side
// Furniture (shop addition) and animals (bought pets) are larger placeable
// decorations than a sticker -- "larger" is the whole distinction between
// the categories. Mirrors experiments/playground.py's RoomCanvas._sticker_radius.
const FURNITURE_REL = 0.22;

const relFor = (kind) => (kind === "furniture" || kind === "animal" ? FURNITURE_REL : STICKER_REL);

/** A sticker (or furniture item) as markup: its picture where there is one,
 * else the emoji.
 *
 * Drawn as text the glyph comes from whatever emoji font the machine has,
 * which is a tofu box on a Linux box with none installed -- the same reason
 * the desktop build renders stickers from PNGs. The emoji rides along as the
 * img's alt text, so a missing or unreachable file degrades to the character
 * rather than to an empty box, with no error handler needed.
 */
function stickerHtml(s) {
  if (!s) return "";
  if (s.img) return `<img class="sticker-art" src="${s.img}" alt="${s.emoji || ""}">`;
  return s.emoji || "";
}

export class PlaygroundPlugin {
  static info = {
    name: "castle-playground",
    version: "1.0.0",
    parameters: {
      backdrop: { type: "STRING", default: "" },
      pending: { type: "OBJECT", array: true, default: [] },
      placed: { type: "OBJECT", array: true, default: [] },
      prompt: { type: "STRING", default: "Put them anywhere you like!" },
      room_index: { type: "INT", default: 0 },
    },
    data: {
      placements: { type: "OBJECT", array: true },
      playground_ms: { type: "FLOAT" },
      room_index: { type: "INT" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial) {
    const pending = [...trial.pending];
    const placed = [...trial.placed];
    const events = [];
    const t0 = performance.now();

    display.innerHTML = `
      <div class="screen playground">
        <p class="speech">${trial.prompt}</p>
        <div class="room" id="room"
             style="${trial.backdrop ? `background-image:url('${trial.backdrop}')` : ""}">
          <div class="ghost" id="ghost" hidden></div>
          <div class="tray" id="tray"></div>
        </div>
        <p class="hint" id="hint"></p>
        <div class="btn-row">
          <button class="quiet" id="auto">Pip can do it</button>
          <button class="big" id="done">All done!</button>
        </div>
      </div>`;

    const room = display.querySelector("#room");
    const tray = display.querySelector("#tray");
    const hint = display.querySelector("#hint");
    const ghost = display.querySelector("#ghost");

    // held: the sticker in the hand -- either lifted from the room or taken
    // from the front of the tray. Null when nothing is being dragged.
    let held = null;
    let fromTray = false;

    const radius = (kind = "sticker") => {
      const r = room.getBoundingClientRect();
      return Math.min(r.width, r.height) * relFor(kind);
    };

    const hintText = () =>
      pending.length === 0 ? "Looks great! Tap 'All done' when you're ready."
      : pending.length === 1 ? "One more to put somewhere."
      : `${pending.length} more to put somewhere.`;

    /** Nearest valid drop point. A drop on the tray is nudged just above it
        rather than rejected -- a child aiming low should not have their
        gesture silently discarded.

        The margin widens to at least the DRAGGED ITEM'S OWN radius
        (`radius(kind)`, converted to a fraction of the room's width/height)
        -- EDGE/TOP_EDGE alone were sized for a sticker, and furniture/
        animals (relFor's larger FURNITURE_REL) are big enough that clamping
        their centre to a sticker-sized margin let a real chunk of the item
        hang off the room's edge: this is the DATA bound (where the centre
        may sit), and it has to stay at least as large as the DISPLAY bound
        (how far the drawn item actually reaches) or the two drift apart at
        the edge. Mirrors experiments/playground.py's RoomCanvas.clamp.
     */
    const clamp = (xRel, yRel, kind = "sticker") => {
      const r = room.getBoundingClientRect();
      const rad = radius(kind);
      const mx = Math.max(EDGE, rad / r.width);
      const top = Math.max(TOP_EDGE, rad / r.height);
      return [
        Math.min(Math.max(xRel, mx), 1 - mx),
        Math.min(Math.max(yRel, top), TRAY_TOP - 0.06),
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
      room.querySelectorAll(".sticker").forEach((n) => n.remove());
      for (const p of placed) {
        const size = radius(p.kind) * 2;
        const el = document.createElement("div");
        el.className = "sticker";
        el.innerHTML = stickerHtml(p);
        el.style.left = `${p.x * 100}%`;
        el.style.top = `${p.y * 100}%`;
        el.style.fontSize = `${size * 0.78}px`;
        el.dataset.id = p.id;
        room.appendChild(el);
      }
      tray.innerHTML = pending.map((s, i) => {
        // The one in the hand is out of the tray, not still sitting in it.
        const dragging = fromTray && held && held.id === s.id;
        return `<span class="tray-item${i === 0 && !dragging ? " next" : ""}"
                      ${dragging ? 'style="visibility:hidden"' : ""}>${stickerHtml(s)}</span>`;
      }).join("");
      hint.textContent = hintText();
    }

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
        // one: a child who wants to move something should not have to empty
        // the tray first.
        [held] = placed.splice(i, 1);
        fromTray = false;
      } else if (pending.length) {
        held = pending[0];
        fromTray = true;
      } else {
        return;
      }
      room.setPointerCapture?.(e.pointerId);
      room.classList.add("dragging");
      const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
      render();
      showGhost(x, y);
    };

    const dragTo = (e) => {
      if (!held) return;
      const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
      showGhost(x, y);
    };

    const drop = (e) => {
      if (!held) return;
      const [x, y] = relFrom(e.clientX, e.clientY, held.kind || "sticker");
      if (fromTray) pending.shift();
      const kind = held.kind || "sticker";
      placed.push({ id: held.id, emoji: held.emoji, img: held.img, x, y, kind });
      // castle_state.place() MOVES an already-placed sticker rather than
      // duplicating it, so re-recording a moved sticker is the move.
      events.push({ sticker_id: held.id, room_index: trial.room_index, x, y, kind });
      held = null;
      fromTray = false;
      ghost.hidden = true;
      room.classList.remove("dragging");
      render();
    };

    room.addEventListener("pointerdown", pickUp);
    room.addEventListener("pointermove", dragTo);
    room.addEventListener("pointerup", drop);
    // A pointer that leaves the window mid-drag must still put the sticker
    // down, or it is lost with the child holding nothing.
    room.addEventListener("pointercancel", drop);

    display.querySelector("#auto").addEventListener("click", () => {
      // Deterministic tidy row: Pip arranging them, not throwing them.
      while (pending.length) {
        const n = placed.length;
        const x = Math.min(Math.max(0.22 + (n % 4) * 0.19, EDGE), 1 - EDGE);
        const y = Math.min(0.28 + Math.floor(n / 4) * 0.2, 0.66);
        const s = pending.shift();
        const kind = s.kind || "sticker";
        placed.push({ id: s.id, emoji: s.emoji, img: s.img, x, y, kind });
        events.push({ sticker_id: s.id, room_index: trial.room_index, x, y, kind });
      }
      render();
    });

    display.querySelector("#done").addEventListener("click", () => {
      display.innerHTML = "";
      this.jsPsych.finishTrial({
        placements: events,
        playground_ms: performance.now() - t0,
        room_index: trial.room_index,
      });
    });

    render();
  }
}

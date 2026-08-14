/**
 * The mansion: nine rooms a child decorates between blocks, four of them
 * holding a mini-game. Port of the mansion screens in
 * experiments/two_tier_experiment.py (_show_mansion_screen,
 * _show_playground_screen, _show_arcade_screen).
 *
 *   Why one jsPsych trial and not several
 *   -------------------------------------
 *   A visit is a little state machine -- grid to a room, back, into a game
 *   room, out to the shop, back to the same room -- and a child can walk it in
 *   any order, any number of times. A timeline is linear, so expressing that
 *   as separate nodes means conditional loops around every hop and a "where
 *   did I come from" flag threaded through all of them. One trial that routes
 *   between its own screens is what the desktop build does, and it keeps the
 *   timeline reading as: trials, break, mansion, trials.
 *
 *   What it reports
 *   ---------------
 *   Everything the visit did, applied by the caller when it ends: placements,
 *   purchases, finished mini-game rounds, and the dwell time. Nothing here
 *   touches CastleState directly -- the same split the other plugins keep, so
 *   the response-blindness audit stays inside castle.js.
 *
 *   No trial can be reached from here. The mansion is only ever entered at a
 *   block boundary, and nothing in it can see or change a response.
 */

import { mountRoomCanvas, stickerHtml } from "./room_canvas.js";
import { mountShopView } from "./shop_view.js";
import { buildGame, hintFor, titleFor } from "./minigames/index.js";
import { assetUrl, loadImage } from "./assets.js";
import { ARCADE_ROOMS } from "./castle.js";
import { playMusic, stopMusic } from "./music.js";

/** The tile for one mansion room. Locked rooms are shown, not hidden: the
 * castle filling up over a session is the point, and an empty space says
 * nothing about what is coming. */
function tileHtml(room, opts) {
  const { thumb, placed, guests, game, roomsToUnlock } = opts;
  if (!room.unlocked) {
    // How many more rooms to finish before this one opens. A padlock alone
    // says "not yet" and nothing else, which for a child reads as "never":
    // the count turns it into a distance, and a distance is something the
    // next room finished visibly shortens.
    const left = roomsToUnlock > 0
      ? `<span class="mansion-countdown">${roomsToUnlock} more
           ${roomsToUnlock === 1 ? "room" : "rooms"}</span>`
      : "";
    return `<div class="mansion-tile locked" aria-disabled="true">
        <span class="mansion-lock">🔒</span>${left}
      </div>`;
  }
  const art = thumb ? `style="background-image:url('${thumb}')"` : "";
  if (game) {
    return `<button class="mansion-tile arcade" data-room="${room.index}" ${art}>
        <span class="mansion-badge">🎮</span>
        <span class="mansion-title">${titleFor(game)}</span>
      </button>`;
  }
  // A true miniature of the room: every item drawn at the RELATIVE position
  // it actually sits at, over the room's own backdrop, so the tile is a
  // picture of that room rather than a list of what is in it. Same technique
  // as the desktop's _render_room_thumbnail, which renders a display-only
  // RoomCanvas at tile size for exactly this reason. Positions are already
  // 0..1 (see room_canvas.js), so they need no conversion -- percentages of
  // the tile ARE the miniature.
  const mini = (items, cls) => items.map((p) =>
    `<span class="${cls}" style="left:${p.x * 100}%;top:${p.y * 100}%">
       ${stickerHtml(p)}</span>`).join("");
  return `<button class="mansion-tile" data-room="${room.index}" ${art}>
      <span class="mansion-mini">${mini(guests, "mansion-guest")}${mini(placed, "mansion-item")}</span>
    </button>`;
}

export class MansionPlugin {
  static info = {
    name: "castle-mansion",
    version: "1.0.0",
    parameters: {
      // Live views of the state, called on every screen change rather than
      // read once: a visit changes all of them as it goes.
      mansion: { type: "OBJECT", array: true, default: [] },
      pocket: { type: "FUNCTION", default: null },      // () -> unplaced items
      placed_in: { type: "FUNCTION", default: null },   // (roomIndex) -> items
      backdrop_for: { type: "FUNCTION", default: null },// (roomIndex) -> rel path
      balance: { type: "FUNCTION", default: null },     // () -> coins
      // Mini-games. api.spectators (not a declared param here) is where the
      // live function actually travels -- see api.pocket/placedIn/etc's own
      // comment below for why: jsPsych evaluates a function-valued trial
      // PARAMETER once, before the trial starts (it treats it as a dynamic
      // parameter, not a callback), so a live, called-per-round function
      // has to ride inside the api OBJECT param instead, which jsPsych
      // does not auto-invoke.
      theme: { type: "OBJECT", default: {} },
      reduced_motion: { type: "BOOL", default: false },
      font_family: { type: "STRING", default: "" },
      game_rng: { type: "OBJECT", default: null },
      on_score: { type: "FUNCTION", default: null },    // (points, game) -> void
      // Shop
      catalog: { type: "OBJECT", array: true, default: [] },
      animal_pool: { type: "OBJECT", array: true, default: [] },
      owned_furniture: { type: "FUNCTION", default: null },
      owned_backgrounds: { type: "FUNCTION", default: null },
      shop_rng: { type: "OBJECT", default: null },
      // Applied as they happen, so a later screen in the same visit sees them
      on_place: { type: "FUNCTION", default: null },      // (placement) -> void
      on_purchase: { type: "FUNCTION", default: null },   // (purchase) -> void
      on_round: { type: "FUNCTION", default: null },      // (play) -> coins
      prompt: { type: "STRING", default: "Which room shall we visit?" },
      mascot: { type: "STRING", default: "" },
      currency_icon: { type: "STRING", default: "🪙" },
    },
    data: {
      placements: { type: "OBJECT", array: true },
      purchases: { type: "OBJECT", array: true },
      plays: { type: "OBJECT", array: true },
      mansion_ms: { type: "FLOAT" },
      minigame_ms: { type: "FLOAT" },
      rooms_visited: { type: "INT" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial) {
    const api = trial.api || {};
    const t0 = performance.now();
    const placements = [];
    const purchases = [];
    const plays = [];
    const visited = new Set();
    let minigameMs = 0;
    let live = null;            // the mounted room canvas or game, to tear down

    const coins = () => (api.balance ? api.balance() : 0);
    const coinChip = () =>
      `<span class="coin-chip">${trial.currency_icon} ${coins()}</span>`;

    const teardown = () => {
      if (live && live.destroy) live.destroy();
      if (live && live.detach) live.detach();
      live = null;
    };

    // -- the grid ---------------------------------------------------------

    const showGrid = async () => {
      teardown();
      // The whole mansion is one "place" musically: the grid, the rooms and
      // the game rooms all run manifest.music.playground, so the track plays
      // unbroken from the moment the visit opens until the child leaves.
      // playMusic() ignores a request for the loop already playing, so this
      // does not restart it on the way back from a room; coming back from the
      // SHOP does switch it back from the shop's own track, which is the one
      // case where a restart is correct -- the shop is a different place.
      playMusic("playground", { loop: true });
      const rooms = trial.mansion || [];
      const thumbs = await Promise.all(rooms.map(async (room) => {
        if (!room.unlocked) return "";
        const rel = api.backdropFor ? api.backdropFor(room.index) : "";
        // Decoded before it is drawn, so the grid never paints half-built.
        await loadImage(rel, "thumb");
        return rel ? assetUrl(rel, "thumb") : "";
      }));

      const tiles = rooms.map((room, i) => tileHtml(room, {
        thumb: thumbs[i],
        placed: api.placedIn ? api.placedIn(room.index) : [],
        guests: api.guestsIn ? api.guestsIn(room.index) : [],
        game: room.kind === "arcade" ? gameOf(room.index) : "",
        roomsToUnlock: api.roomsToUnlock ? api.roomsToUnlock(room.index) : 0,
      })).join("");

      const pocket = api.pocket ? api.pocket() : [];
      const hint = pocket.length
        ? `${pocket.length} thing${pocket.length === 1 ? "" : "s"} to put somewhere`
        : "Have a look around!";

      display.innerHTML = `
        <div class="screen mansion">
          <p class="speech">${trial.prompt}</p>
          <p class="hint">${hint}</p>
          <div class="mansion-grid">${tiles}</div>
          <div class="btn-row">
            <button class="quiet" id="shop">🛒 Visit the shop</button>
            ${coinChip()}
            <button class="big" id="leave">✅ Done decorating</button>
          </div>
        </div>`;

      display.querySelectorAll(".mansion-tile[data-room]").forEach((el) => {
        el.addEventListener("click", () => enter(Number(el.dataset.room)));
      });
      display.querySelector("#shop").addEventListener("click", () => showShop(null));
      display.querySelector("#leave").addEventListener("click", finish);
    };

    // Which game a room holds. Read from ARCADE_ROOMS rather than stored on
    // the tile, so the screens and the saved state cannot disagree about
    // which room was which.
    const gameOf = (index) => {
      const room = (trial.mansion || []).find((r) => r.index === index);
      return room && room.kind === "arcade" ? (ARCADE_ROOMS[index] || "") : "";
    };

    const enter = (index) => {
      visited.add(index);
      const room = (trial.mansion || []).find((r) => r.index === index);
      if (room && room.kind === "arcade") showArcade(index);
      else showRoom(index);
    };

    // -- one decoration room ----------------------------------------------

    const showRoom = (index) => {
      teardown();
      // Loops for as long as the room is open; playMusic()'s own hardStop()
      // cuts the grid's silence (a no-op) or the shop's track cleanly if
      // reached via showShop's "Back to the room".
      playMusic("playground", { loop: true });
      const rel = api.backdropFor ? api.backdropFor(index) : "";
      live = mountRoomCanvas(display, {
        backdrop: rel ? assetUrl(rel) : "",
        // The SHARED pocket: any earned item can go in any unlocked room, so
        // the tray is the same wherever the child is standing.
        pending: api.pocket ? api.pocket() : [],
        placed: api.placedIn ? api.placedIn(index) : [],
        // The animals living in THIS room. Not part of `placed`: a guest
        // cannot be picked up or moved -- see castle.js's `guests`.
        guests: api.guestsIn ? api.guestsIn(index) : [],
        reducedMotion: Boolean(trial.reduced_motion),
        prompt: "Put them anywhere you like!",
        roomIndex: index,
        // Lifting something makes a sound, the same way putting it down does
        // -- port of the desktop's `canvas.picked_up.connect(... play("pickup"))`.
        onPickUp: () => api.onPickUp?.(),
        footerHtml: coinChip(),
        // The shop is reached from the mansion GRID only -- one place to go
        // shopping from, not one per room. See showGrid's own #shop button.
        buttons: [
          { id: "back", label: "🏰 Back to the mansion", cls: "big" },
        ],
        onButton: (id, events) => {
          drain(events);
          if (id === "back") showGrid();
        },
      });
    };

    /** Move whatever the room canvas has recorded into the visit's own list,
     * applying each one so the next screen sees it. The canvas keeps its
     * events for its own lifetime, so this takes them by count. A retrieved
     * item (dragged back into the tray, see room_canvas.js's overTray) is
     * not a placement -- it only leaves the shared pocket via api.onRetrieve,
     * never joins `placements`. */
    const drain = (events) => {
      while (events.length) {
        const p = events.shift();
        if (p.retrieved_id) api.onRetrieve?.(p.retrieved_id, p.kind);
        else { placements.push(p); api.onPlace?.(p); }
      }
    };

    // -- one game room ----------------------------------------------------

    const showArcade = async (index) => {
      teardown();
      // Keeps the mansion's own ambient loop rather than stopping it or
      // playing something of its own -- an arcade room has no track of its
      // own in manifest.music, and the desktop build deliberately reuses
      // "playground" here too: a game room is still the same "place" as a
      // decoration room (_show_arcade_screen's own docstring). playMusic()'s
      // hardStop() still cuts a shop track cleanly if reached from there.
      playMusic("playground", { loop: true });
      const key = gameOf(index);
      const rel = api.backdropFor ? api.backdropFor(index) : "";
      // Called fresh for every round, not read once at timeline-build time --
      // an invitation bought mid-session (or one drawn from a mystery box)
      // must be able to show up on the bench the very next round.
      const spectatorRels = api.spectators ? api.spectators() : [];
      const [backdrop, ...spectators] = await Promise.all([
        loadImage(rel),
        ...spectatorRels.map((r) => loadImage(r)),
      ]);

      display.innerHTML = `
        <div class="screen arcade">
          <p class="hint">${hintFor(key)}</p>
          <canvas class="arcade-canvas" id="game"></canvas>
          <div class="btn-row">
            ${coinChip()}
            <button class="big" id="back">🏰 Back to the mansion</button>
          </div>
        </div>`;

      const game = buildGame(key, {
        theme: trial.theme,
        reducedMotion: trial.reduced_motion,
        rng: trial.game_rng,
        backdrop,
        spectators: spectators.filter(Boolean),
        fontFamily: trial.font_family,
        onScore: (n) => api.onScore?.(n, key),
        onFinish: (gameKey, score, durationMs) => {
          const coinsPaid = api.onRound?.({ game: gameKey, room_index: index,
                                               score, duration_ms: durationMs }) ?? 0;
          minigameMs += durationMs;
          plays.push({ game: gameKey, room_index: index, score,
                       duration_ms: durationMs, coins: coinsPaid });
          showResult(index, key, score, coinsPaid);
        },
      });
      if (!game) { showGrid(); return; }        // a key this build lacks
      live = game;
      const canvas = display.querySelector("#game");
      // The running game, reachable from its canvas. js/test/browser.mjs
      // drives a whole round through it (tick() is time-agnostic on purpose)
      // rather than waiting 20 seconds of wall clock in jsdom.
      canvas.__game = game;
      game.attach(canvas);
      game.start();

      // The shop is reached from the mansion GRID only -- one place to go
      // shopping from, not one per room.
      display.querySelector("#back").addEventListener("click", () => {
        game.stop();
        showGrid();
      });
    };

    const showResult = (index, key, score, coinsPaid) => {
      teardown();
      // Still inside the mansion, so still the mansion's track (a no-op
      // while it is already looping -- see playMusic).
      playMusic("playground", { loop: true });
      // What the round was worth, said as a quantity and never as a verdict:
      // the games have no failure state, and "well done" would be one.
      const paid = coinsPaid
        ? `<p class="speech">${trial.currency_icon} +${coinsPaid} for the piggy bank!</p>`
        : "";
      display.innerHTML = `
        <div class="screen arcade-result">
          ${trial.mascot ? `<img class="pip" src="${trial.mascot}" alt="">` : ""}
          <p class="speech">You caught ${score}!</p>
          ${paid}
          <div class="btn-row">
            <button class="quiet" id="back">🏰 Back to the mansion</button>
            ${coinChip()}
            <button class="big" id="again">🔄 Play again</button>
          </div>
        </div>`;
      display.querySelector("#again").addEventListener("click", () => showArcade(index));
      display.querySelector("#back").addEventListener("click", showGrid);
    };

    // -- the shop ---------------------------------------------------------

    const showShop = (fromRoom) => {
      teardown();
      // Loops for as long as the shop is open; playMusic()'s own hardStop()
      // cuts the room's playground track cleanly when reached from inside one.
      playMusic("shop", { loop: true });
      mountShopView(display, {
        catalog: trial.catalog,
        balance: coins(),
        ownedFurniture: api.ownedFurniture ? api.ownedFurniture() : [],
        ownedBackgrounds: api.ownedBackgrounds ? api.ownedBackgrounds() : [],
        ownedAnimals: api.ownedAnimals ? api.ownedAnimals() : [],
        animalPool: trial.animal_pool,
        furnitureVariants: api.furnitureVariants,
        // Where a bought background can be hung. Only unlocked DECORATION
        // rooms -- an arcade room's backdrop is drawn for the game that
        // plays on it (see mansionBackdrop), so re-skinning one would break
        // the thing it was drawn for. Mirrors _show_background_picker.
        mansionRooms: (trial.mansion || []).filter((r) => r.unlocked && r.kind !== "arcade"),
        roomThumb: (roomIndex) => (api.backdropFor ? api.backdropFor(roomIndex) : ""),
        backgroundRoom: api.backgroundRoom ? api.backgroundRoom : () => undefined,
        onEquip: (roomIndex, itemId) => api.onEquip?.(roomIndex, itemId),
        mascot: trial.mascot,
        currencyIcon: trial.currency_icon,
        rng: trial.shop_rng,
        roomIndex: fromRoom == null ? 0 : fromRoom,
        doneLabel: fromRoom == null ? "🏰 Back to the mansion" : "🚪 Back to the room",
        onPurchase: (p) => { purchases.push(p); api.onPurchase?.(p); },
        // Back to WHERE THE CHILD CAME FROM, not always the grid: leaving the
        // shop into a different screen than the one they left is disorienting,
        // and for a game room it would also silently end their round.
        onDone: () => (fromRoom == null ? showGrid() : enter(fromRoom)),
      });
    };

    // -- leaving ----------------------------------------------------------

    const finish = () => {
      teardown();
      // The visit is over and trials come next. Nothing may still be playing
      // when one starts -- a looping track under a Tier 2 stimulus clip is
      // exactly the overlap the whole audio layer is built to prevent. The
      // grid used to stop the music on the way in here; now that it keeps it
      // running, stopping is this function's job.
      stopMusic();
      display.innerHTML = "";
      this.jsPsych.finishTrial({
        placements,
        purchases,
        plays,
        mansion_ms: performance.now() - t0,
        minigame_ms: minigameMs,
        rooms_visited: visited.size,
      });
    };

    showGrid();
  }
}

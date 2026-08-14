/**
 * Castle / sticker-book state. Port of experiments/castle_state.py.
 *
 *   The one property that matters
 *   -----------------------------
 *   How many stickers a room awards, and which, is drawn ONCE at session
 *   start -- before the first response exists. That is the mechanical
 *   guarantee that a reward cannot be contingent on what a child picked. The
 *   odd-one-out task has no correct answer; a reward that varied with the
 *   choice would teach a similarity structure and corrupt the embedding.
 *
 *   completeRoom() therefore takes a room INDEX and nothing else. Do not add
 *   a parameter that can see a response.
 *
 *   Coins (shop/economy addition) follow the exact same rule. create() draws
 *   the coin schedule from the SAME rng, right after the sticker order is
 *   fixed, so the whole reward schedule is one continuous draw off one seed.
 *   Spending those coins is a separate, player-choice-driven concern that
 *   lives in shop.js instead, so this module's response-blindness stays easy
 *   to audit in isolation.
 *
 *   Coins pay out per TRIAL, not per room (a later revision -- rooms still
 *   pay stickers, only coins moved). coin_allocation has one entry per trial
 *   in the session, not one per room, and awardTrialCoins() takes a trial
 *   index the same way completeRoom() takes a room index -- structurally
 *   incapable of seeing what was picked. 1 coin is the most common outcome
 *   (see COIN_WEIGHTS) so a trial almost always pays something small, with 2
 *   or 3 as an occasional bonus.
 *
 *   Stickers stay a per-ROOM budget (still 2-4, still allocate()) but REVEAL
 *   at a random trial within that room rather than all at once at room end
 *   (a later revision again). allocateRevealPositions draws, for each room,
 *   which of that room's OWN trials shows each of its stickers -- still one
 *   continuous rng draw with everything else, still before the first
 *   response. awardTrialStickers() takes a room index and a position within
 *   it (never a response) and walks that room's stickers off in the
 *   pre-drawn order, one per matching position; completeRoom() sweeps up any
 *   that never reached a matching trial (a room shorter than its own sticker
 *   count) so nothing is lost, only delayed to room end in that one case.
 */

// 10: companion animals become GUESTS (`guests`) rather than placeable items.
// An invitation buys an animal, not a spot for one: the animal turns up in a
// random unlocked DECORATION room by itself, and moves house at every block
// boundary. Matches experiments/castle_state.py's own schema 10 -- see the
// Guest docstring there for why a guest is deliberately not a Placement.
//
// 9: the mansion -- nine progressively unlocked rooms sharing one sticker
// pocket, four of them holding a mini-game (`mansion`, ARCADE_ROOMS,
// minigame_*). Numbered to match experiments/castle_state.py, which the
// desktop build carried through 6-8 (background overrides, sticker stacking
// order) -- neither of which this build has yet, so those numbers pass by
// unused rather than being renumbered and losing the correspondence.
//
// 5: stickers moved from an all-at-once reveal at room end to a per-trial
// reveal within the room (see the module docstring) -- rooms gained
// reveal_positions/revealed. 4 moved coins from a per-room allocation to a
// per-trial one -- coin_allocation has one entry per trial, not one per
// room, and rooms no longer carry a coins_planned field.
export const SCHEMA_VERSION = 10;
export const MIN_PER_ROOM = 2;
export const MAX_PER_ROOM = 4;

// -- the mansion ----------------------------------------------------------
//
// The persistent, progressively-unlocked space a child decorates between
// blocks, replacing the one-canvas-per-room-boundary playground. Nine rooms,
// one shared pocket: any earned sticker can go in any unlocked room.
export const MANSION_ROOM_COUNT = 9;
export const UNLOCK_STEP_PCT = 90 / 8;

// Which mansion rooms hold a mini-game instead of a decoration canvas, and
// which game each one holds. Four of the nine, at indices that unlock at
// ~22%, ~34%, ~56% and ~68% of block completion -- early enough that a short
// or abandoned session still reaches all four, which rooms 7 and 8 (~79% and
// ~90%) would not. Room 0 stays a decoration room: it is the only one open at
// the very start. Kept HERE rather than in the screens so a saved session
// records which game sat in which room; the games live in src/minigames/.
export const ARCADE_ROOMS = {
  2: "star_catcher",
  3: "firefly_catch",
  5: "bubble_pop",
  6: "kite_flyer",
};

// Mini-game payout. Score-based, but deliberately marginal: the fixed
// schedule pays 1-3 coins per TRIAL, so a 40-trial session pays ~80 coins and
// MINIGAME_COIN_CAP is ~13% of that. A child can feel the arcade contributing
// without it ever being the efficient way to earn -- which matters because it
// is the one coin source a child can farm, and time spent farming is time not
// spent on trials. 15 points per coin is calibrated against the 20-second
// round: simulated play at three motor-skill profiles scores roughly 18-41,
// so a real attempt pays 1 and a strong one pays 2.
//
// These four numbers are asserted against experiments/castle_state.py by
// js/test/run.mjs: two builds paying differently for the same round would be
// two different economies.
export const MINIGAME_POINTS_PER_COIN = 15;
export const MINIGAME_COINS_PER_ROUND_MAX = 2;
export const MINIGAME_COIN_CAP = 12;

// 1-3 coins per trial, weighted toward 1 -- COIN_WEIGHTS[i] is the relative
// weight of COIN_VALUES[i], so 1 coin is 3x as likely as 3 and 1.5x as
// likely as 2. Mirrors experiments/castle_state.py's COIN_VALUES/WEIGHTS.
export const COIN_VALUES = [1, 2, 3];
export const COIN_WEIGHTS = [3, 2, 1];
export const MIN_COINS_PER_TRIAL = Math.min(...COIN_VALUES);
export const MAX_COINS_PER_TRIAL = Math.max(...COIN_VALUES);

export function allocate(nRooms, rng, minPer = MIN_PER_ROOM, maxPer = MAX_PER_ROOM) {
  return Array.from({ length: Math.max(0, nRooms) }, () => rng.int(minPer, maxPer));
}

/** One weighted draw from `values`, using `rng.random()` (uniform [0,1)). */
function weightedChoice(rng, values, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.random() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r < 0) return values[i];
  }
  return values[values.length - 1];
}

/**
 * Coins per TRIAL, drawn up front. Sibling of allocate(); same contract --
 * an rng and a trial count and nothing else. One entry per trial, not per
 * room, so a longer room pays out more total coins without changing the
 * odds any single trial pays.
 */
export function allocateCoins(nTrials, rng, values = COIN_VALUES, weights = COIN_WEIGHTS) {
  return Array.from({ length: Math.max(0, nTrials) }, () => weightedChoice(rng, values, weights));
}

/**
 * Which trial, WITHIN each room, reveals each of that room's stickers.
 *
 * `stickerCounts[i]`/`roomTrialCounts[i]` are room i's sticker total (from
 * allocate()) and its actual trial count. Returns one array per room, each
 * entry a position 0..roomLen-1, SORTED ascending -- the sort is what lets
 * awardTrialStickers walk a room's stickers with a single counter instead of
 * a set of claimed positions, since calls arrive in increasing position
 * order. Same contract as allocate()/allocateCoins(): an rng and counts,
 * nothing that could see a response.
 *
 * A room with more stickers than trials (short Tier 2 rooms can have as few
 * as 2) gives every trial a distinct slot first, then doubles up the rest
 * onto the room's LAST trial -- nobody is dropped, some just arrive together.
 */
export function allocateRevealPositions(stickerCounts, roomTrialCounts, rng) {
  const out = [];
  for (let i = 0; i < stickerCounts.length; i++) {
    const k = stickerCounts[i];
    const roomLen = Math.max(1, Number(roomTrialCounts[i]) || 0);
    if (k <= 0) { out.push([]); continue; }
    let positions;
    if (k <= roomLen) {
      positions = rng.shuffle(Array.from({ length: roomLen }, (_, p) => p)).slice(0, k);
    } else {
      positions = Array.from({ length: roomLen }, (_, p) => p)
        .concat(Array(k - roomLen).fill(roomLen - 1));
      rng.shuffle(positions);
    }
    positions.sort((a, b) => a - b);
    out.push(positions);
  }
  return out;
}

/** The nine mansion rooms, as they look at session start: room 0 open, the
 * rest waiting on block progress, four of them flagged as game rooms. */
export function newMansion() {
  return Array.from({ length: MANSION_ROOM_COUNT }, (_, i) => ({
    index: i,
    unlocked: i === 0,
    kind: ARCADE_ROOMS[i] ? "arcade" : "decorate",
  }));
}

/** The game a mansion room holds, or "" for a decoration room. */
export function gameFor(room) {
  return room && room.kind === "arcade" ? (ARCADE_ROOMS[room.index] || "") : "";
}

/**
 * Where in a room a guest stands: kept off the very edges, and low in the
 * frame -- a creature standing on the floor rather than floating in the
 * middle of the wall. Port of castle_state._guest_spot's
 * uniform(0.15, 0.85) x uniform(0.55, 0.80).
 */
function guestSpot(rng) {
  return [0.15 + rng.random() * 0.70, 0.55 + rng.random() * 0.25];
}

export class CastleState {
  constructor({ participantId = "", rooms = [], allocation = [], poolIds = [] } = {}) {
    this.schema_version = SCHEMA_VERSION;
    this.participant_id = participantId;
    this.rooms = rooms;
    this.allocation = allocation;
    this.pool_ids = poolIds;
    this.awarded = [];
    this.placements = [];
    // The playground is untimed and sits at every room boundary, so it is the
    // one part of the game that can lengthen a session without bound. Recorded
    // so the cost is measurable rather than assumed. Never touches RT: the
    // playground runs BETWEEN trials.
    this.playground_ms = 0;
    // Coin schedule -- one entry per TRIAL, not per room. coins_awarded is a
    // running total rather than a per-trial list like `awarded` -- coins
    // have no per-item identity to track individually. trials_paid is how
    // many entries of coin_allocation have been paid out so far, which is
    // what makes awardTrialCoins() idempotent without a set of paid indices.
    this.coin_allocation = [];
    this.coins_awarded = 0;
    this.trials_paid = 0;
    // Where the child put a PURCHASED furniture item (shop addition). A
    // separate list from `placements` on purpose -- furniture is bought,
    // not earned, and keeping it separate means place()/placedInRoom()/
    // unplacedForRoom() (all sticker-typed, predating the shop) are never
    // touched by this. Reuses the placement shape (item id in sticker_id).
    this.furniture_placements = [];

    // The mansion (schema 9). `rooms` above are TASK rooms -- one per block,
    // carrying that block's stickers and condition. These are PLACES, nine of
    // them, unlocked by progress and decorated from the shared pocket. The
    // two are indexed independently and must not be confused: a placement's
    // room_index addresses a mansion room.
    this.mansion = newMansion();
    // Finished mini-game rounds: {game, room_index, score, duration_ms, coins}.
    this.minigame_plays = [];
    // Time inside a game room. A SUBSET of playground_ms, which keeps running
    // -- the arcade sits inside a mansion visit -- not a sibling of it.
    this.minigame_ms = 0;
    // Coins the arcade paid. Deliberately NOT folded into coins_awarded:
    // that field means "what the pre-drawn, response-blind schedule paid" and
    // is reproducible from the participant id alone, which is what makes it
    // auditable. Arcade coins depend on how the child PLAYED, so they are
    // counted separately and added in only at the balance -- see
    // coinBalance() in main.js.
    this.minigame_coins = 0;

    // Companion animals living in the mansion (schema 10), as
    // {animal_id, room_index, x, y}. Deliberately NOT placements: a
    // placement is something the child put somewhere and can move or take
    // back, while a guest arrives on its own (an invitation buys the
    // invitation, not a chosen animal), picks its own room and spot, and
    // moves house at every block boundary. Keeping the two in separate
    // lists is what stops every drag/pocket/retrieve path in
    // room_canvas.js from having to special-case "but not this one".
    this.guests = [];
  }

  /**
   * `nTrials` is the total trial count for the whole session (every room,
   * attention checks included) -- the coin schedule has one entry per
   * trial, not per room, so it needs the session total rather than nRooms.
   * `roomTrialCounts` is each room's OWN trial count, same order as the
   * rooms -- what the sticker reveal schedule needs to pick a valid
   * position inside each room.
   */
  static create(nRooms, pool, rng, participantId = "", conditions = [],
                nTrials = 0, roomTrialCounts = []) {
    const alloc = allocate(nRooms, rng);
    // Drawn right after the sticker allocation, from the SAME rng: the coin
    // schedule is part of the one continuous session-start draw, not a
    // second independent trigger. See the module docstring.
    const coinAlloc = allocateCoins(nTrials, rng);
    // Drawn right after the coin schedule, same rng, still before the
    // sticker IDENTITY shuffle below -- see allocateRevealPositions.
    const revealPositions = allocateRevealPositions(
      alloc, roomTrialCounts.length ? roomTrialCounts : Array(nRooms).fill(0), rng);
    const rooms = Array.from({ length: nRooms }, (_, i) => ({
      index: i,
      condition: conditions[i] || "",
      name: "",
      stickers_planned: alloc[i],
      completed: false,
      sticker_ids: [],
      backdrop: "",
      reveal_positions: revealPositions[i] || [],
      revealed: 0,
    }));

    // Fix the sticker ORDER up front too, so the whole reward schedule is a
    // property of the participant id and reproducible from the saved file.
    const ids = pool.map((s) => s.id).filter(Boolean);
    const order = rng.shuffle([...ids]);
    const need = alloc.reduce((a, b) => a + b, 0);
    while (order.length < need) order.push(...rng.shuffle([...ids]));

    let cursor = 0;
    for (const r of rooms) {
      r.sticker_ids = order.slice(cursor, cursor + r.stickers_planned);
      cursor += r.stickers_planned;
    }

    const st = new CastleState({ participantId, rooms, allocation: alloc, poolIds: ids });
    st.coin_allocation = coinAlloc;
    return st;
  }

  /**
   * Mark a room finished and return any stickers still unrevealed. Takes
   * only an index. Most of a room's stickers have already reached the
   * child individually via awardTrialStickers during the room's own
   * trials -- this is the catch-up, awarding whatever never matched a
   * trial position (a room shorter than its own sticker count, or the
   * session ending mid-room) rather than losing it. The common case
   * returns [] -- there is nothing left to catch up.
   */
  completeRoom(index) {
    const r = this.rooms.find((x) => x.index === index);
    if (!r) return [];
    if (r.completed) return [];
    r.completed = true;
    const leftover = r.sticker_ids.slice(r.revealed);
    this.awarded.push(...leftover);
    r.revealed = r.sticker_ids.length;
    return leftover;
  }

  /**
   * Stickers scheduled to reveal at this position within this room. Same
   * contract as completeRoom/awardTrialCoins: a room index and a position
   * within it, never anything that could see a response. Delivers a
   * room's stickers in the pre-drawn order fixed by
   * allocateRevealPositions, walking them off one at a time via
   * ROOM.revealed -- an out-of-order or repeated position simply matches
   * nothing and returns [].
   */
  awardTrialStickers(roomIndex, posInRoom) {
    const r = this.rooms.find((x) => x.index === roomIndex);
    if (!r) return [];
    const due = [];
    while (r.revealed < r.reveal_positions.length
           && r.reveal_positions[r.revealed] === posInRoom) {
      due.push(r.sticker_ids[r.revealed]);
      r.revealed += 1;
    }
    if (due.length) this.awarded.push(...due);
    return due;
  }

  /**
   * Coins for one trial, from the pre-drawn per-trial schedule. Same
   * contract as completeRoom: takes only an index, so it is structurally
   * incapable of depending on what was chosen. Trials pay out strictly in
   * order via trials_paid -- an out-of-order or repeated index is a no-op,
   * the same double-tap guard completeRoom applies per room. Returns the
   * amount paid (0 if nothing was).
   */
  awardTrialCoins(trialIndex) {
    if (trialIndex !== this.trials_paid) return 0;
    if (!(trialIndex >= 0 && trialIndex < this.coin_allocation.length)) return 0;
    const amount = this.coin_allocation[trialIndex];
    this.coins_awarded += amount;
    this.trials_paid += 1;
    return amount;
  }

  get totalPlanned() {
    return this.allocation.reduce((a, b) => a + b, 0);
  }

  get unearnedCount() {
    return Math.max(0, this.totalPlanned - this.awarded.length);
  }

  roomsCompleted() {
    return this.rooms.filter((r) => r.completed).length;
  }

  /**
   * Where the child put a sticker. Free placement: any point is valid,
   * overlapping allowed. Re-placing MOVES rather than duplicating -- a child
   * dragging the same sticker twice must not end up with two.
   * x/y are RELATIVE (0..1) so a castle renders the same at any window size.
   */
  place(stickerId, roomIndex, x, y) {
    this.placements = this.placements.filter(
      (p) => !(p.sticker_id === stickerId && p.room_index === roomIndex));
    this.placements.push({
      sticker_id: stickerId, room_index: roomIndex, x: Number(x), y: Number(y),
    });
    return true;
  }

  placedInRoom(roomIndex) {
    return this.placements.filter((p) => p.room_index === roomIndex);
  }

  unplacedForRoom(roomIndex) {
    const done = new Set(this.placedInRoom(roomIndex).map((p) => p.sticker_id));
    const r = this.rooms.find((x) => x.index === roomIndex);
    return r ? r.sticker_ids.filter((s) => !done.has(s)) : [];
  }

  /**
   * Every earned sticker not currently placed in any mansion room -- the
   * shared pocket every unlocked room draws its tray from.
   *
   * `awarded` is the flat, room-agnostic record of every sticker ever given
   * to the child, so this needs no room argument: unlike the pre-mansion
   * per-room budget (unplacedForRoom, still here for the plain playground
   * path), ANY unlocked room can hold ANY earned item. Filters by sticker
   * VALUE, so in the rare pool-exhaustion case where the same id was awarded
   * twice, placing one instance hides both -- an accepted approximation, not
   * a promise the ids are unique.
   */
  unplacedStickers() {
    const placed = new Set(this.placements.map((p) => p.sticker_id));
    return this.awarded.filter((s) => !placed.has(s));
  }

  /**
   * Take a placed sticker back off the wall, wherever it is. The "pick it
   * up" half of a cross-room move; place() is the "put it down" half. A safe
   * no-op if it was never placed.
   */
  unplace(stickerId) {
    this.placements = this.placements.filter((p) => p.sticker_id !== stickerId);
  }

  addPlaygroundTime(ms) {
    this.playground_ms += Math.max(0, Math.round(ms));
  }

  // -- the mansion --------------------------------------------------------

  /** Block-completion PERCENT required to unlock each mansion room,
   * index-paired with `mansion` (room 0's threshold is always 0). */
  unlockThresholds() {
    return Array.from({ length: MANSION_ROOM_COUNT }, (_, i) => i * UNLOCK_STEP_PCT);
  }

  /**
   * Unlock every mansion room whose threshold the current block-completion
   * fraction has reached. Idempotent, and -- like completeRoom -- structurally
   * incapable of depending on what was chosen: it only ever sees a
   * completed-block COUNT. Returns the indices newly opened by this call.
   */
  unlockForProgress(blocksCompleted, numBlocks) {
    if (!(numBlocks > 0)) return [];
    const pct = 100 * Math.max(0, blocksCompleted) / numBlocks;
    const thresholds = this.unlockThresholds();
    const newly = [];
    this.mansion.forEach((room, i) => {
      if (!room.unlocked && pct >= thresholds[i]) {
        room.unlocked = true;
        newly.push(room.index);
      }
    });
    return newly;
  }

  unlockedRooms() {
    return this.mansion.filter((r) => r.unlocked);
  }

  // -- guests (companion animals) -----------------------------------------

  /**
   * The rooms a guest may live in: unlocked DECORATION rooms.
   *
   * Game rooms are excluded because they have no room canvas to stand in --
   * an arcade screen is a game, not a picture of a room -- so a guest sent
   * to one would simply vanish until it moved again. Port of
   * castle_state.guest_rooms.
   */
  guestRooms() {
    return this.mansion.filter((r) => r.unlocked && r.kind === "decorate")
      .map((r) => r.index);
  }

  /**
   * An invited animal turns up in a random unlocked room. Returns the guest,
   * or null if this animal already lives here (an invitation buys an animal
   * that is not here yet -- see ShopState.buyInvitation) or there is nowhere
   * to put it.
   *
   * `rng` MUST be the caller's purchase-time stream, never the trial stream:
   * drawing from that would shift which triplets the child sees, the property
   * js/test/run.mjs's determinism checks exist to protect.
   */
  inviteGuest(animalId, rng) {
    if (!animalId) return null;
    if (this.guests.some((g) => g.animal_id === animalId)) return null;
    const rooms = this.guestRooms();
    if (!rooms.length) return null;
    const [x, y] = guestSpot(rng);
    const guest = { animal_id: animalId, room_index: rng.choice(rooms), x, y };
    this.guests.push(guest);
    return guest;
  }

  /**
   * Every guest moves house. Called once per completed block.
   *
   * A guest prefers a room it is not already in, so the move is visible; with
   * only one room available it stays put and simply picks a new spot. Returns
   * the guests that changed rooms, for a caller that wants to mention it.
   *
   * Response-blind by the same argument as unlockForProgress: it takes an rng
   * and nothing else, and the caller fires it on a block BOUNDARY -- never
   * inside one, and never with a choice in hand.
   */
  moveGuests(rng) {
    const rooms = this.guestRooms();
    if (!rooms.length) return [];
    const moved = [];
    for (const guest of this.guests) {
      const options = rooms.filter((i) => i !== guest.room_index);
      const pool = options.length ? options : rooms;
      const newRoom = rng.choice(pool);
      if (newRoom !== guest.room_index) moved.push(guest);
      guest.room_index = newRoom;
      [guest.x, guest.y] = guestSpot(rng);
    }
    return moved;
  }

  guestsInRoom(roomIndex) {
    return this.guests.filter((g) => g.room_index === roomIndex);
  }

  /** The mansion's game rooms, in index order. */
  arcadeRooms() {
    return this.mansion.filter((r) => r.kind === "arcade");
  }

  // -- mini-games (arcade rooms) ------------------------------------------

  /** Time inside a game room. A subset of playground_ms -- see the field. */
  addMinigameTime(ms) {
    this.minigame_ms += Math.max(0, Math.round(ms));
  }

  /**
   * Coins a round scoring `score` would pay, after both caps. Split out from
   * recordMinigame so the arithmetic can be read and tested without
   * recording anything.
   */
  minigamePayout(score) {
    const earned = Math.min(MINIGAME_COINS_PER_ROUND_MAX,
                            Math.floor(Math.max(0, score) / MINIGAME_POINTS_PER_COIN));
    const remaining = Math.max(0, MINIGAME_COIN_CAP - this.minigame_coins);
    return Math.min(earned, remaining);
  }

  /**
   * Record one finished round and pay for it. Returns the coins awarded.
   *
   * Response-blind by the same structural argument as awardTrialCoins: the
   * parameters are a game key, a room index, a score and a duration, so there
   * is no way to pass a response in -- and a score comes from catching
   * falling stars, which is hand-eye timing, nothing to do with any
   * odd-one-out judgment. What it is NOT is *schedule*-blind: unlike every
   * other payout here it depends on how the child played, which is exactly
   * why it lands in minigame_coins rather than coins_awarded.
   */
  recordMinigame(game, roomIndex, score, durationMs) {
    const coins = this.minigamePayout(score);
    this.minigame_coins += coins;
    this.minigame_plays.push({
      game,
      room_index: roomIndex,
      score: Math.max(0, Math.round(score)),
      duration_ms: Math.max(0, Math.round(durationMs)),
      coins,
    });
    return coins;
  }

  // -- furniture placement (shop addition) --------------------------------

  /** Where the child put a purchased furniture item. Mirrors place() for
   * stickers, in its own list -- see furniture_placements above. */
  placeFurniture(itemId, roomIndex, x, y) {
    this.furniture_placements = this.furniture_placements.filter(
      (p) => p.sticker_id !== itemId);
    this.furniture_placements.push({
      sticker_id: itemId, room_index: roomIndex, x: Number(x), y: Number(y),
    });
    return true;
  }

  furniturePlacedInRoom(roomIndex) {
    return this.furniture_placements.filter((p) => p.room_index === roomIndex);
  }

  /** Take a placed furniture item back off the wall, wherever it is --
   * furniture's own unplace(), for the same retrieve-to-pocket gesture. A
   * safe no-op if it was never placed. */
  unplaceFurniture(itemId) {
    this.furniture_placements = this.furniture_placements.filter(
      (p) => p.sticker_id !== itemId);
  }

  /**
   * Owned furniture ids not yet placed in ANY room. Unlike stickers,
   * furniture has no per-room plan -- it is bought once and placed once,
   * wherever the child is decorating when they place it.
   */
  unplacedFurniture(ownedIds) {
    const done = new Set(this.furniture_placements.map((p) => p.sticker_id));
    return ownedIds.filter((i) => !done.has(i));
  }

  toJSON() {
    return {
      schema_version: this.schema_version,
      participant_id: this.participant_id,
      rooms: this.rooms,
      allocation: this.allocation,
      pool_ids: this.pool_ids,
      awarded: this.awarded,
      placements: this.placements,
      playground_ms: this.playground_ms,
      coin_allocation: this.coin_allocation,
      coins_awarded: this.coins_awarded,
      trials_paid: this.trials_paid,
      furniture_placements: this.furniture_placements,
      mansion: this.mansion,
      minigame_plays: this.minigame_plays,
      minigame_ms: this.minigame_ms,
      minigame_coins: this.minigame_coins,
      guests: this.guests,
    };
  }
}

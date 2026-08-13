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

// 5: stickers moved from an all-at-once reveal at room end to a per-trial
// reveal within the room (see the module docstring) -- rooms gained
// reveal_positions/revealed. 4 moved coins from a per-room allocation to a
// per-trial one -- coin_allocation has one entry per trial, not one per
// room, and rooms no longer carry a coins_planned field.
export const SCHEMA_VERSION = 5;
export const MIN_PER_ROOM = 2;
export const MAX_PER_ROOM = 4;

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

  addPlaygroundTime(ms) {
    this.playground_ms += Math.max(0, Math.round(ms));
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
    };
  }
}

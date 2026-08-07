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
 */

export const SCHEMA_VERSION = 2;
export const MIN_PER_ROOM = 2;
export const MAX_PER_ROOM = 4;

export function allocate(nRooms, rng, minPer = MIN_PER_ROOM, maxPer = MAX_PER_ROOM) {
  return Array.from({ length: Math.max(0, nRooms) }, () => rng.int(minPer, maxPer));
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
  }

  static create(nRooms, pool, rng, participantId = "", conditions = []) {
    const alloc = allocate(nRooms, rng);
    const rooms = Array.from({ length: nRooms }, (_, i) => ({
      index: i,
      condition: conditions[i] || "",
      name: "",
      stickers_planned: alloc[i],
      completed: false,
      sticker_ids: [],
      backdrop: "",
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
    return st;
  }

  /** Stickers for finishing a room. Takes an index and nothing else. */
  completeRoom(index) {
    const r = this.rooms.find((x) => x.index === index);
    if (!r) return [];
    if (!r.completed) {
      r.completed = true;
      this.awarded.push(...r.sticker_ids);
    }
    return [...r.sticker_ids];
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
    };
  }
}

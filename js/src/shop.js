/**
 * Shop / economy state. Port of experiments/shop_state.py.
 *
 *   Earn vs. spend: two different contracts, kept in two different modules
 *   -------------------------------------------------------------------
 *   CastleState owns everything a child EARNS: fixed once, at session start,
 *   before the first response exists. This module owns everything a child
 *   SPENDS: which item to buy, and whether to open a mystery box, are real
 *   choices made with currency already earned. That is a different contract
 *   on purpose, kept in a separate file so a reviewer auditing
 *   response-blindness only has to read castle.js.
 *
 *   Spending is still gated purely by currency balance (earned response-
 *   blindly) and player choice of timing -- never by trial correctness.
 *   buyMysteryBox() takes its own rng explicitly, from a stream the caller
 *   must keep separate from the trial rng and the castle/backdrop streams.
 */

// 2: adds owned_animals, for the invitation-letter purchase (and the mystery
// box's "animal" pool entries) -- previously silently dropped. Independent
// of the Python side's own schema numbering, since the two were never meant
// to compare equal. owned_furniture's own entries switched from base ids to
// drawn variant ids (buyFurniture now ports Python's random-variant-per-
// -purchase model) without a version bump: the field's shape did not
// change, only what a saved id happens to mean.
export const SCHEMA_VERSION = 2;

export class ShopState {
  constructor({ ownedFurniture = [], ownedBackgrounds = [], ownedAnimals = [],
                backgroundOverrides = {}, purchases = [] } = {}) {
    this.schema_version = SCHEMA_VERSION;
    this.owned_furniture = ownedFurniture;
    this.owned_backgrounds = ownedBackgrounds;
    this.owned_animals = ownedAnimals;
    // room_index -> background id. Separate from owned_backgrounds because
    // owning a background and having it equipped in a particular room are
    // different things -- see equipBackground().
    this.background_overrides = backgroundOverrides;
    this.purchases = purchases;
    // Cumulative time spent in the shop, in ms -- sibling of
    // CastleState.playground_ms, same untimed-screen-at-a-room-boundary risk.
    this.shop_ms = 0;
  }

  static canAfford(balance, cost) {
    return balance >= cost;
  }

  /**
   * Buy a furniture item -- draws a random palette VARIANT of `baseId` that
   * is not yet owned (e.g. buying "tapestry" a second time draws whichever
   * of tapestry_c/_f/_m/_j is still missing) rather than adding a fixed
   * item. Port of ShopState.buy_furniture (Python). Returns the purchase
   * record (with the drawn variant in `won_item_id`) so the caller can
   * drive the same reveal screen buyMysteryBox uses, or null if the
   * purchase could not be made -- insufficient balance, or every variant in
   * `variantIds` already owned ("sold out"), mirroring buyMysteryBox's
   * empty-pool case exactly.
   *
   * `rng` MUST be the dedicated shop stream, same requirement as
   * buyMysteryBox/buyInvitation.
   */
  buyFurniture(baseId, variantIds, cost, balance, roomIndex, rng) {
    if (!ShopState.canAfford(balance, cost)) return null;
    const unowned = (variantIds ?? []).filter((v) => !this.owned_furniture.includes(v));
    if (!unowned.length) return null;
    const won = rng.choice(unowned);
    this.owned_furniture.push(won);
    const purchase = { item_type: "furniture", item_id: baseId, cost,
                       room_index: roomIndex, won_item_id: won, won_item_type: "furniture" };
    this.purchases.push(purchase);
    return purchase;
  }

  /**
   * Buy a background. Does NOT equip it -- call equipBackground() so a
   * background bought earlier can be re-applied without re-purchasing.
   */
  buyBackground(itemId, cost, balance, roomIndex) {
    if (!ShopState.canAfford(balance, cost)) return false;
    if (this.owned_backgrounds.includes(itemId)) return false;
    this.owned_backgrounds.push(itemId);
    this.purchases.push({ item_type: "background", item_id: itemId, cost,
                          room_index: roomIndex, won_item_id: "", won_item_type: "" });
    return true;
  }

  /** Which room (index, or undefined) an owned background currently hangs
   * in, if any. */
  backgroundRoom(itemId) {
    const entry = Object.entries(this.background_overrides)
      .find(([, id]) => id === itemId);
    return entry ? Number(entry[0]) : undefined;
  }

  /**
   * Apply an OWNED background as the override for one room, MOVING it
   * there. Free -- it only chooses among what is already owned, spends
   * nothing. Port of ShopState.equip_background (Python).
   *
   * An owned background hangs in AT MOST ONE room: setting it on a second
   * room without this would leave copies in both, which is not what owning
   * one of something means. So the move displaces rather than duplicates --
   * if the target room already wore a different background, the two rooms
   * SWAP; if the target had no override, the room this background left
   * simply reverts to its session-start art.
   */
  equipBackground(roomIndex, itemId) {
    if (!this.owned_backgrounds.includes(itemId)) return false;
    const previousRoom = this.backgroundRoom(itemId);
    if (previousRoom === roomIndex) return true;   // already there
    const displaced = this.background_overrides[roomIndex];
    if (previousRoom !== undefined) {
      if (displaced) this.background_overrides[previousRoom] = displaced;   // swap
      else delete this.background_overrides[previousRoom];                 // reverts to session art
    }
    this.background_overrides[roomIndex] = itemId;
    return true;
  }

  /**
   * Spend on a mystery box: draws one random item from `pool`, a list of
   * {ref, type} entries from the manifest catalog. `rng` MUST be a
   * dedicated purchase-time stream, never the trial rng or castle/backdrop
   * streams. Returns the purchase record (with the won item filled in) or
   * null if the purchase could not be made.
   */
  buyMysteryBox(boxId, cost, balance, roomIndex, rng, pool) {
    if (!ShopState.canAfford(balance, cost)) return null;
    if (!pool || pool.length === 0) return null;
    const won = rng.choice(pool);
    const ref = won.ref;
    const kind = won.type;
    if (kind === "furniture" && ref && !this.owned_furniture.includes(ref)) {
      this.owned_furniture.push(ref);
    } else if (kind === "background" && ref && !this.owned_backgrounds.includes(ref)) {
      this.owned_backgrounds.push(ref);
    } else if (kind === "animal" && ref && !this.owned_animals.includes(ref)) {
      this.owned_animals.push(ref);
    }
    const purchase = { item_type: "mystery_box", item_id: boxId, cost,
                       room_index: roomIndex, won_item_id: ref || "",
                       won_item_type: kind || "" };
    this.purchases.push(purchase);
    return purchase;
  }

  /**
   * Spend on an invitation letter: draws one random not-yet-invited animal
   * from `pool` (a list of animal ids). Same live-draw contract as
   * buyMysteryBox -- `rng` MUST be the dedicated shop stream. Returns the
   * purchase record or null if it could not be made (can't afford, or
   * every animal in the pool is already invited).
   */
  buyInvitation(entryId, cost, balance, roomIndex, rng, pool) {
    if (!ShopState.canAfford(balance, cost)) return null;
    const available = (pool ?? []).filter((id) => !this.owned_animals.includes(id));
    if (!available.length) return null;
    const won = rng.choice(available);
    this.owned_animals.push(won);
    const purchase = { item_type: "invitation", item_id: entryId, cost,
                       room_index: roomIndex, won_item_id: won, won_item_type: "animal" };
    this.purchases.push(purchase);
    return purchase;
  }

  get totalSpent() {
    return this.purchases.reduce((a, p) => a + p.cost, 0);
  }

  /**
   * Commit an ALREADY-DECIDED purchase -- item_type/item_id/cost/room_index
   * and, for a mystery box, won_item_id/won_item_type already resolved --
   * without drawing or re-checking affordability.
   *
   * jsPsych trial functions run exactly once: ShopPlugin's trial() already
   * made the real decision live (including any mystery-box rng draw, from
   * the dedicated shop stream) and reported it in finishTrial's data. This
   * only replays that decision into the real ShopState from on_finish --
   * calling buyMysteryBox() again here would draw a SECOND time from the
   * same stream and could disagree with what the child was already shown.
   */
  applyPurchase(purchase) {
    const { item_type, item_id, won_item_id, won_item_type } = purchase;
    if (item_type === "furniture" && won_item_id &&
        !this.owned_furniture.includes(won_item_id)) {
      this.owned_furniture.push(won_item_id);
    } else if (item_type === "background" && !this.owned_backgrounds.includes(item_id)) {
      this.owned_backgrounds.push(item_id);
    } else if (item_type === "invitation" && won_item_id &&
               !this.owned_animals.includes(won_item_id)) {
      this.owned_animals.push(won_item_id);
    } else if (item_type === "mystery_box") {
      if (won_item_type === "furniture" && won_item_id &&
          !this.owned_furniture.includes(won_item_id)) {
        this.owned_furniture.push(won_item_id);
      } else if (won_item_type === "background" && won_item_id &&
                 !this.owned_backgrounds.includes(won_item_id)) {
        this.owned_backgrounds.push(won_item_id);
      } else if (won_item_type === "animal" && won_item_id &&
                 !this.owned_animals.includes(won_item_id)) {
        this.owned_animals.push(won_item_id);
      }
    }
    this.purchases.push(purchase);
  }

  addShopTime(ms) {
    this.shop_ms += Math.max(0, Math.round(ms));
  }

  toJSON() {
    return {
      schema_version: this.schema_version,
      owned_furniture: this.owned_furniture,
      owned_backgrounds: this.owned_backgrounds,
      owned_animals: this.owned_animals,
      background_overrides: this.background_overrides,
      purchases: this.purchases,
      shop_ms: this.shop_ms,
    };
  }
}

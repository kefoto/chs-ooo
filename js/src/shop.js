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

export const SCHEMA_VERSION = 1;

export class ShopState {
  constructor({ ownedFurniture = [], ownedBackgrounds = [], backgroundOverrides = {},
                purchases = [] } = {}) {
    this.schema_version = SCHEMA_VERSION;
    this.owned_furniture = ownedFurniture;
    this.owned_backgrounds = ownedBackgrounds;
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

  /** Buy a furniture item. Already-owned is rejected, not double-charged. */
  buyFurniture(itemId, cost, balance, roomIndex) {
    if (!ShopState.canAfford(balance, cost)) return false;
    if (this.owned_furniture.includes(itemId)) return false;
    this.owned_furniture.push(itemId);
    this.purchases.push({ item_type: "furniture", item_id: itemId, cost,
                          room_index: roomIndex, won_item_id: "", won_item_type: "" });
    return true;
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

  /** Apply an OWNED background as the override for one room. Free -- it
   * only chooses among what is already owned, spends nothing. */
  equipBackground(roomIndex, itemId) {
    if (!this.owned_backgrounds.includes(itemId)) return false;
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
    }
    const purchase = { item_type: "mystery_box", item_id: boxId, cost,
                       room_index: roomIndex, won_item_id: ref || "",
                       won_item_type: kind || "" };
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
    if (item_type === "furniture" && !this.owned_furniture.includes(item_id)) {
      this.owned_furniture.push(item_id);
    } else if (item_type === "background" && !this.owned_backgrounds.includes(item_id)) {
      this.owned_backgrounds.push(item_id);
    } else if (item_type === "mystery_box") {
      if (won_item_type === "furniture" && won_item_id &&
          !this.owned_furniture.includes(won_item_id)) {
        this.owned_furniture.push(won_item_id);
      } else if (won_item_type === "background" && won_item_id &&
                 !this.owned_backgrounds.includes(won_item_id)) {
        this.owned_backgrounds.push(won_item_id);
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
      background_overrides: this.background_overrides,
      purchases: this.purchases,
      shop_ms: this.shop_ms,
    };
  }
}

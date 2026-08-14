/**
 * A shop visit as its own timeline node (the pre-mansion flow). The counter
 * itself lives in shop_view.js, which the mansion shares.
 *
 * Optional and one tap from the exit: it is reached from the quiet button on
 * the room-complete screen and never inserted into the mandatory line of play.
 */

import { mountShopView } from "./shop_view.js";

export class ShopPlugin {
  static info = {
    name: "castle-shop",
    version: "1.0.0",
    parameters: {
      catalog: { type: "OBJECT", array: true, default: [] },
      animal_pool: { type: "OBJECT", array: true, default: [] },
      furniture_variants: { type: "FUNCTION", default: null },  // (baseId) -> items
      balance: { type: "INT", default: 0 },
      owned_furniture: { type: "STRING", array: true, default: [] },
      owned_backgrounds: { type: "STRING", array: true, default: [] },
      owned_animals: { type: "STRING", array: true, default: [] },
      room_index: { type: "INT", default: 0 },
      mascot: { type: "STRING", default: "" },
      currency_icon: { type: "STRING", default: "\u{1FA99}" },
      rng: { type: "OBJECT", default: null },
    },
    data: {
      purchases: { type: "OBJECT", array: true },
      shop_ms: { type: "FLOAT" },
      room_index: { type: "INT" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial) {
    const t0 = performance.now();
    mountShopView(display, {
      catalog: trial.catalog,
      balance: trial.balance,
      ownedFurniture: trial.owned_furniture,
      ownedBackgrounds: trial.owned_backgrounds,
      ownedAnimals: trial.owned_animals,
      animalPool: trial.animal_pool,
      furnitureVariants: trial.furniture_variants,
      mascot: trial.mascot,
      currencyIcon: trial.currency_icon,
      rng: trial.rng,
      roomIndex: trial.room_index,
      onDone: (purchases) => {
        display.innerHTML = "";
        this.jsPsych.finishTrial({
          purchases,
          shop_ms: performance.now() - t0,
          room_index: trial.room_index,
        });
      },
    });
  }
}

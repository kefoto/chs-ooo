/**
 * The shop: spend coins on furniture, backgrounds, and a mystery box.
 * Port of the desktop's _show_shop_screen / _shop_cell / _show_mystery_reveal
 * (experiments/two_tier_experiment.py).
 *
 * One jsPsych "trial" is one whole shop VISIT -- possibly several purchases
 * -- ending when the child taps "Done shopping", same shape as
 * PlaygroundPlugin covering a whole room's worth of placements. Purchases
 * are recorded here as intent (like PlaygroundPlugin's `placements`) and
 * committed to the real ShopState in main.js's on_finish via
 * ShopState.applyPurchase(), which just records an already-decided purchase
 * rather than re-deciding it -- see that method's docstring for why a
 * mystery-box draw must never happen twice.
 *
 * Reachable only when the preceding room-complete screen's quiet button was
 * chosen (see ScreenPlugin's quiet_button / conditional_function wiring in
 * main.js), and always exits through one "Done shopping" button -- the same
 * bounding the desktop build gives this screen, since it is untimed and
 * could otherwise lengthen a session without limit.
 */

function itemHtml(item, size) {
  if (!item) return "";
  if (item.img) return `<img class="sticker-art" src="${item.img}" alt="${item.emoji || ""}" style="width:${size}px;height:${size}px;">`;
  return `<span style="font-size:${size}px;">${item.emoji || "?"}</span>`;
}

export class ShopPlugin {
  static info = {
    name: "castle-shop",
    version: "1.0.0",
    parameters: {
      catalog: { type: "OBJECT", array: true, default: [] },
      balance: { type: "INT", default: 0 },
      owned_furniture: { type: "STRING", array: true, default: [] },
      owned_backgrounds: { type: "STRING", array: true, default: [] },
      room_index: { type: "INT", default: 0 },
      mascot: { type: "STRING", default: "" },
      currency_icon: { type: "STRING", default: "🪙" },
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
    let balance = trial.balance;
    const ownedFurniture = [...trial.owned_furniture];
    const ownedBackgrounds = [...trial.owned_backgrounds];
    const purchases = [];
    const t0 = performance.now();
    const icon = trial.currency_icon;

    const isOwned = (entry) => entry.type === "furniture"
      ? ownedFurniture.includes(entry.ref)
      : entry.type === "background"
        ? ownedBackgrounds.includes(entry.ref)
        : false;

    const cellHtml = (entry) => {
      const owned = isOwned(entry);
      const iconSize = 56;
      let art;
      let label;
      if (entry.type === "mystery_box") {
        art = `<span style="font-size:${iconSize}px;">\u{1F381}</span>`;
        label = "Mystery box";
      } else {
        art = itemHtml(entry.item, iconSize);
        label = entry.item ? entry.item.label : entry.ref;
      }
      const affordable = balance >= entry.price;
      const btnLabel = owned ? "Owned" : `${icon} ${entry.price}`;
      const disabled = owned || !affordable ? "disabled" : "";
      return `
        <div class="shop-cell">
          <div class="shop-art">${art}</div>
          <p class="shop-label">${label}</p>
          <button class="shop-buy ${owned ? "owned" : ""}" data-id="${entry.id}" ${disabled}>${btnLabel}</button>
        </div>`;
    };

    const renderShop = () => {
      display.innerHTML = `
        <div class="screen shop">
          ${trial.mascot ? `<img class="pip" src="${trial.mascot}" alt="">` : ""}
          <p class="speech">${icon} ${balance}</p>
          <p class="speech">The shop!</p>
          <div class="shop-grid" id="grid">
            ${trial.catalog.map(cellHtml).join("")}
          </div>
          <div class="btn-row"><button class="big" id="done">Done shopping</button></div>
        </div>`;

      display.querySelectorAll(".shop-buy:not([disabled])").forEach((btn) => {
        btn.addEventListener("click", () => {
          const entry = trial.catalog.find((e) => e.id === btn.dataset.id);
          buy(entry);
        });
      });
      display.querySelector("#done").addEventListener("click", finish);
    };

    const buy = (entry) => {
      if (!entry || balance < entry.price || isOwned(entry)) return;
      if (entry.type === "furniture") {
        balance -= entry.price;
        ownedFurniture.push(entry.ref);
        purchases.push({ item_type: "furniture", item_id: entry.ref,
                         cost: entry.price, room_index: trial.room_index,
                         won_item_id: "", won_item_type: "" });
        renderShop();
      } else if (entry.type === "background") {
        balance -= entry.price;
        ownedBackgrounds.push(entry.ref);
        purchases.push({ item_type: "background", item_id: entry.ref,
                         cost: entry.price, room_index: trial.room_index,
                         won_item_id: "", won_item_type: "" });
        renderShop();
      } else if (entry.type === "mystery_box") {
        // The draw happens exactly once, live, from the dedicated shop rng
        // stream passed in as trial.rng -- never trial_rng. See the module
        // docstring: on_finish replays this result, it never re-draws.
        const won = trial.rng.choice(entry.pool);
        balance -= entry.price;
        if (won.type === "furniture" && !ownedFurniture.includes(won.ref)) {
          ownedFurniture.push(won.ref);
        } else if (won.type === "background" && !ownedBackgrounds.includes(won.ref)) {
          ownedBackgrounds.push(won.ref);
        }
        purchases.push({ item_type: "mystery_box", item_id: entry.id,
                         cost: entry.price, room_index: trial.room_index,
                         won_item_id: won.ref, won_item_type: won.type });
        renderReveal(won);
      }
    };

    const renderReveal = (won) => {
      display.innerHTML = `
        <div class="screen shop">
          ${trial.mascot ? `<img class="pip" src="${trial.mascot}" alt="">` : ""}
          <p class="speech">You got:</p>
          <div class="shop-art">${itemHtml(won.item, 96)}</div>
          <p class="speech">${won.item ? won.item.label : ""}</p>
          <div class="btn-row"><button class="big" id="back">Back to the shop</button></div>
        </div>`;
      display.querySelector("#back").addEventListener("click", renderShop);
    };

    const finish = () => {
      display.innerHTML = "";
      this.jsPsych.finishTrial({
        purchases,
        shop_ms: performance.now() - t0,
        room_index: trial.room_index,
      });
    };

    renderShop();
  }
}

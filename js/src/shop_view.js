/**
 * The shop counter: the catalogue, and Pip standing beside the till.
 *
 * The VIEW alone, so both callers share it -- ShopPlugin (a shop visit as its
 * own timeline node, the pre-mansion flow) and MansionPlugin (the shop reached
 * from inside the mansion, returning to whichever room the child came from).
 *
 *   Where Pip and the money sit
 *   ---------------------------
 *   Bottom-right corner, Pip large with the coin count directly beneath him,
 *   matching the desktop build. The balance is the number a child checks
 *   against a price, so it belongs beside the shopkeeper rather than in a
 *   header they have to look away from the goods to read.
 *
 * Spending is gated purely by the balance (earned response-blindly, see
 * castle.js) and by the child's own choice of timing. No purchase can be
 * contingent on a trial, which is why every draw here comes from the shop's
 * own rng stream.
 *
 *   A live draw (furniture variant, mystery box, invitation letter)
 *   announces itself with item_popup.js's bounce-in card OVER the
 *   refreshed grid, not by navigating to a separate reveal screen -- see
 *   that module's docstring for why. render() runs FIRST so the grid
 *   already shows the new ownership/found-count/balance underneath the
 *   popup, matching GameLayer.animate_item_popup's own contract.
 */

import { assetUrl } from "./assets.js";
import { showItemPopup } from "./item_popup.js";

/** An item's picture where it has one, else its emoji, at `px`. */
export function itemHtml(item, px = 56) {
  if (!item) return "";
  if (item.img) {
    return `<img src="${item.img}" alt="${item.emoji || ""}" `
      + `style="width:${px}px;height:${px}px;object-fit:contain;">`;
  }
  return `<span style="font-size:${px}px;">${item.emoji || ""}</span>`;
}

/**
 * One column per item type, entries stacked as compact rows inside it --
 * port of the desktop's SHOP_COLUMNS. Replaces an earlier catalog-order
 * card grid: the twelve entries never fit a grid without scrolling, and
 * where any given item landed depended on the window size, so furniture,
 * wallpaper and the mystery box were interleaved in whatever order the
 * manifest happened to list them. Sorting by type puts a fixed, findable
 * place on screen behind each kind of thing. An entry whose type matches no
 * column here falls into the LAST one, mirroring SHOP_COLUMNS's own
 * fallback.
 */
const SHOP_COLUMNS = [
  { icon: "\u{1FA91}", title: "Furniture", kinds: ["furniture"] },
  { icon: "\u{1F5BC}\u{FE0F}", title: "Wallpaper", kinds: ["background"] },
  { icon: "\u{1F381}", title: "Surprises", kinds: ["invitation", "mystery_box", "animal"] },
];

/**
 * Mount the shop into `host`.
 *
 * @param {HTMLElement} host
 * @param {object}   opts
 * @param {Array}    opts.catalog        resolved entries (art + label + price)
 * @param {number}   opts.balance        coins available now
 * @param {Array}    opts.ownedFurniture ids already bought
 * @param {Array}    opts.ownedBackgrounds
 * @param {Array}    opts.ownedAnimals   animal ids already invited
 * @param {Array}    opts.animalPool     resolved {id,label,emoji,img} items,
 *                                       the pool an invitation letter draws from
 * @param {Function} [opts.furnitureVariants] (baseId) -> resolved
 *                                       {id,label,emoji,img} palette variants a
 *                                       furniture purchase draws from
 * @param {Array}    [opts.mansionRooms] unlocked, non-arcade mansion rooms a
 *                                       bought background can be hung in --
 *                                       omit to skip the room-picker entirely
 *                                       (the pre-mansion ShopPlugin has no
 *                                       rooms to offer)
 * @param {Function} [opts.roomThumb]    (roomIndex) -> backdrop rel path
 * @param {Function} [opts.backgroundRoom] (itemId) -> room index or undefined
 * @param {Function} [opts.onEquip]      (roomIndex, itemId) -> void
 * @param {string}   opts.mascot         Pip's picture url
 * @param {string}   opts.currencyIcon
 * @param {object}   opts.rng            the SHOP stream, never the trial rng
 * @param {number}   opts.roomIndex      recorded on each purchase
 * @param {string}   opts.doneLabel
 * @param {Function} opts.onPurchase     (purchase) -> void, as it happens
 * @param {Function} opts.onDone         (purchases) -> void
 */
export function mountShopView(host, opts) {
  const icon = opts.currencyIcon || "🪙";
  const ownedFurniture = [...(opts.ownedFurniture || [])];
  const ownedBackgrounds = [...(opts.ownedBackgrounds || [])];
  const ownedAnimals = [...(opts.ownedAnimals || [])];
  const animalPool = opts.animalPool || [];
  const purchases = [];
  let balance = opts.balance || 0;

  // A furniture entry's own found/total, over its variant pool -- "owned"
  // once every variant has been drawn (buy() keeps drawing a random unowned
  // one each purchase, "sold out" once none are left). Mirrors _shop_cell's
  // `found`/`variants` split (Python).
  const furnitureVariants = (baseId) => (opts.furnitureVariants ? opts.furnitureVariants(baseId) : []);
  const furnitureFound = (baseId) =>
    furnitureVariants(baseId).filter((v) => ownedFurniture.includes(v.id));

  const isOwned = (entry) => (
    entry.type === "furniture"
      ? (() => { const vs = furnitureVariants(entry.ref);
                 return vs.length > 0 && furnitureFound(entry.ref).length >= vs.length; })()
    : entry.type === "background" ? ownedBackgrounds.includes(entry.ref)
    // An invitation letter is "owned" (sold out) once every animal in the
    // pool has already been invited -- mirrors _shop_cell's
    // `all(a in owned_animals for a in pool)`.
    : entry.type === "invitation"
      ? animalPool.length > 0 && animalPool.every((a) => ownedAnimals.includes(a.id))
    : false);

  /** Which column (index into SHOP_COLUMNS) an entry sorts into, entries
   * whose type matches no column's `kinds` landing in the last one. */
  const columnOf = (entry) => {
    const i = SHOP_COLUMNS.findIndex((c) => c.kinds.includes(entry.type));
    return i === -1 ? SHOP_COLUMNS.length - 1 : i;
  };

  const rowHtml = (entry) => {
    const owned = isOwned(entry);
    // Furniture shows the most recently drawn variant's real art once at
    // least one is owned, else a preview of the first variant (still no
    // image -- that only comes with owning one) -- mirrors _shop_cell's
    // `show = found[-1] if found else variants[0]` (Python).
    const variants = entry.type === "furniture" ? furnitureVariants(entry.ref) : [];
    const found = entry.type === "furniture" ? furnitureFound(entry.ref) : [];
    const previewItem = entry.type === "furniture"
      ? (found.length ? found[found.length - 1] : (variants[0] || entry.item))
      : entry.item;
    const art = entry.type === "mystery_box"
      ? `<span style="font-size:40px;">\u{1F381}</span>`
      : itemHtml(previewItem, 40);
    const label = entry.type === "mystery_box" ? "Mystery box"
      : (entry.item ? entry.item.label : entry.ref);
    const foundLabel = entry.type === "furniture" && variants.length
      ? `<p class="shop-row-found">${found.length}/${variants.length} found</p>` : "";
    const affordable = balance >= entry.price;
    // An owned BACKGROUND stays actionable: the button becomes the way to
    // (re-)choose which room wears it -- "Owned" was a dead end, since a
    // background bought from the break screen had never been put anywhere,
    // and one in the wrong room could never move. Mirrors _shop_cell's
    // `reusable` case. Only offered when a room list was given at all (the
    // pre-mansion ShopPlugin has none).
    const reusable = entry.type === "background" && owned && (opts.mansionRooms?.length ?? 0) > 0;
    const disabled = (owned && !reusable) || (!owned && !affordable);
    const btnLabel = reusable ? "Hang it up" : owned ? "Owned" : `${icon} ${entry.price}`;
    return `
      <div class="shop-row">
        <div class="shop-row-art">${art}</div>
        <div class="shop-row-text">
          <p class="shop-row-label">${label}</p>
          ${foundLabel}
        </div>
        <button class="shop-buy ${owned && !reusable ? "owned" : ""}" data-id="${entry.id}"
                ${disabled ? "disabled" : ""}>
          ${btnLabel}
        </button>
      </div>`;
  };

  const columnHtml = (col, entries) => (entries.length ? `
    <div class="shop-column">
      <div class="shop-column-head">
        <span class="shop-column-icon">${col.icon}</span>
        <span class="shop-column-title">${col.title}</span>
      </div>
      ${entries.map(rowHtml).join("")}
    </div>` : "");

  const render = () => {
    const buckets = SHOP_COLUMNS.map(() => []);
    for (const entry of opts.catalog) buckets[columnOf(entry)].push(entry);
    host.innerHTML = `
      <div class="screen shop">
        <p class="speech">The shop!</p>
        <div class="shop-columns" id="grid">${SHOP_COLUMNS
          .map((col, i) => columnHtml(col, buckets[i])).join("")}</div>
        <div class="btn-row">
          <button class="big" id="done">${opts.doneLabel || "✅ Done shopping"}</button>
        </div>
        <div class="shop-corner">
          ${opts.mascot ? `<img class="shop-pip" src="${opts.mascot}" alt="">` : ""}
          <p class="shop-balance" id="balance">${icon} ${balance}</p>
        </div>
      </div>`;

    host.querySelectorAll(".shop-buy:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = opts.catalog.find((e) => e.id === btn.dataset.id);
        // Owned-and-reusable (a background already bought) reopens the
        // picker directly -- nothing to spend, isOwned() already gates buy().
        if (entry.type === "background" && isOwned(entry)) renderRoomPicker(entry);
        else buy(entry);
      });
    });
    host.querySelector("#done").addEventListener("click", () => opts.onDone?.(purchases));
  };

  const record = (purchase) => {
    purchases.push(purchase);
    opts.onPurchase?.(purchase);
  };

  const buy = (entry) => {
    if (!entry || balance < entry.price || isOwned(entry)) return;
    balance -= entry.price;
    if (entry.type === "furniture") {
      // Same live-draw contract as a mystery box / invitation letter, over
      // this base's own variant pool -- see buyFurniture (shop.js) for why
      // a repeat purchase of the same base draws a DIFFERENT variant rather
      // than being rejected as already-owned.
      const available = furnitureVariants(entry.ref).filter((v) => !ownedFurniture.includes(v.id));
      if (!available.length) { balance += entry.price; return; }
      const won = opts.rng.choice(available);
      ownedFurniture.push(won.id);
      record({ item_type: "furniture", item_id: entry.ref, cost: entry.price,
               room_index: opts.roomIndex, won_item_id: won.id, won_item_type: "furniture" });
      render();
      showItemPopup({ artUrl: won.img, emoji: won.emoji, label: won.label });
    } else if (entry.type === "background") {
      ownedBackgrounds.push(entry.ref);
      record({ item_type: "background", item_id: entry.ref, cost: entry.price,
               room_index: opts.roomIndex, won_item_id: "", won_item_type: "" });
      // Buying is only half of it -- go straight to picking the room it
      // goes on, or the child owns a background they can never see (unless
      // this shop has no room list to offer at all -- the pre-mansion
      // ShopPlugin -- in which case there's nowhere to send them).
      if (opts.mansionRooms?.length) renderRoomPicker(entry);
      else render();
    } else if (entry.type === "invitation") {
      // Same live-draw contract as a mystery box, over the animal pool
      // instead of the mixed furniture/background one -- see the desktop's
      // buy_invitation. Sold out (isOwned already disables the button, but
      // guard here too) is a no-op rather than a crash on an empty pool.
      const available = animalPool.filter((a) => !ownedAnimals.includes(a.id));
      if (!available.length) { balance += entry.price; return; }
      const won = opts.rng.choice(available);
      ownedAnimals.push(won.id);
      record({ item_type: "invitation", item_id: entry.id, cost: entry.price,
               room_index: opts.roomIndex, won_item_id: won.id, won_item_type: "animal" });
      render();
      showItemPopup({ artUrl: won.img, emoji: won.emoji, label: won.label });
    } else if (entry.type === "mystery_box") {
      // The draw happens exactly once, live, from the dedicated shop stream --
      // never the trial rng. Whoever commits this purchase replays the result
      // rather than drawing again, or the child would be shown one item and
      // given another.
      const won = opts.rng.choice(entry.pool);
      if (won.type === "furniture" && !ownedFurniture.includes(won.ref)) {
        ownedFurniture.push(won.ref);
      } else if (won.type === "background" && !ownedBackgrounds.includes(won.ref)) {
        ownedBackgrounds.push(won.ref);
      } else if (won.type === "animal" && !ownedAnimals.includes(won.ref)) {
        ownedAnimals.push(won.ref);
      }
      record({ item_type: "mystery_box", item_id: entry.id, cost: entry.price,
               room_index: opts.roomIndex, won_item_id: won.ref,
               won_item_type: won.type });
      render();
      showItemPopup({ artUrl: won.item?.img, emoji: won.item?.emoji, label: won.item?.label });
    }
  };

  /**
   * Choose which room a background goes on. Reuses .mansion-tile styling so
   * it reads as "the mansion, in miniature" rather than a new UI language.
   * Game rooms are never offered -- opts.mansionRooms is pre-filtered to
   * unlocked, non-arcade rooms by the caller (their backdrop is drawn for
   * the game that plays on it; re-skinning one would break the thing it was
   * drawn for). Mirrors _show_background_picker.
   */
  const renderRoomPicker = (entry) => {
    const rooms = opts.mansionRooms || [];
    const here = opts.backgroundRoom ? opts.backgroundRoom(entry.ref) : undefined;
    // Says plainly that this MOVES rather than copies -- one background
    // hangs in one room, and a child expecting a second copy would
    // otherwise be surprised when the first room changes back.
    const hint = here === undefined
      ? "Pick a room. You can move it again later."
      : "Pick a room to move it to — the two rooms will swap.";
    const tiles = rooms.map((room) => {
      const thumb = opts.roomThumb ? opts.roomThumb(room.index) : "";
      const styles = [];
      if (thumb) styles.push(`background-image:url('${assetUrl(thumb, "thumb")}')`);
      if (room.index === here) styles.push("border-color:var(--select)");
      const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
      return `<button class="mansion-tile" data-room="${room.index}" aria-label="room ${room.index + 1}"${styleAttr}></button>`;
    }).join("");
    // "room-picker" distinguishes this from the mansion's own grid screen --
    // both use .mansion-grid for the tile layout, and js/test/browser.mjs's
    // driving loop (and anything else routing on screen shape) needs to
    // tell them apart rather than treating a room CHOICE here as if it were
    // re-entering the mansion.
    host.innerHTML = `
      <div class="screen shop room-picker">
        <p class="speech">Where should ${entry.item?.label || "it"} go?</p>
        <p class="hint">${hint}</p>
        <div class="mansion-grid">${tiles}</div>
        <div class="btn-row"><button class="quiet" id="not-now">Not now</button></div>
      </div>`;
    host.querySelectorAll(".mansion-tile[data-room]").forEach((el) => {
      el.addEventListener("click", () => {
        opts.onEquip?.(Number(el.dataset.room), entry.ref);
        render();
      });
    });
    host.querySelector("#not-now").addEventListener("click", render);
  };

  render();
  return { purchases };
}

export { assetUrl };

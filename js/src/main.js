/** Timeline assembly. Loads the manifests, builds the session, saves it. */

// jsPsych comes from the standalone build loaded by index.html, not an
// import. The CDN's ESM dist has bare imports a browser cannot resolve, and
// jsDelivr's /+esm output still fetches dependencies from the CDN at runtime;
// the standalone build is the only one that works offline.
const { initJsPsych } = globalThis.jsPsychModule ?? {};
import { CONFIG, applyUrlOverrides } from "./config.js";
import { stream } from "./rng.js";
import { buildTrialList, generateBalancedTriplets } from "./triplets.js";
import { blockConditions, latinSquareIndex, buildTrialListTier2,
         CONDITION_INSTRUCTIONS, CONDITION_DIALOGUE } from "./tier2.js";
import { CastleState } from "./castle.js";
import { ShopState } from "./shop.js";
import { TripletPlugin, ScreenPlugin } from "./plugins.js";
import { AudioTripletPlugin, armPriming, stimulusAudioActive } from "./audio.js";
import { initSfx, playSfx } from "./sfx.js";
import { initVoice, speak, speakAll } from "./voice.js";
import { initMusic, playMusic, stopMusic } from "./music.js";
import { initStickerPopup, showStickerReveal } from "./sticker_popup.js";
import { CutscenePlugin, resolvePanels, probeImages } from "./cutscene.js";
import { PlaygroundPlugin } from "./playground.js";
import { ShopPlugin } from "./shop_plugin.js";
import { buildPayload, makeResponse, downloadPayload, postPayload } from "./save.js";
import { sessionPlan } from "./session.js";
import { setupNeeded, showSetup } from "./setup.js";

let cfg = applyUrlOverrides({ ...CONFIG });
let TIER2 = cfg.Tier === 2;

// Chrome will not start playback on a page nobody has touched, and a blocked
// A-only trial is a silent one. Every session opens with screens the child
// taps, so clicks always precede the first sound; armPriming retries on each
// until one of them unlocks the tab.
armPriming();

const jget = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not load ${url} (${r.status})`);
  return r.json();
};

(async function run() {
  const target = document.getElementById("jspsych-target");

  // The experimenter's form, when the link did not already configure the
  // session. A URL carrying ?pid= is one someone has already set up -- a
  // facility link, or the test harness -- so it starts straight away.
  if (setupNeeded()) cfg = await showSetup(cfg, target);

  // Length comes from the age-bin table unless the URL pinned it, so opening
  // the page bare gives the same session the desktop build would. `Num
  // Trials` is trials PER BLOCK; handing it the session total is what made
  // the desktop build run an adult's "80 trial" session as 704.
  const q = new URLSearchParams(window.location.search);
  if (!q.get("rooms") && !q.get("trials")) {
    const plan = sessionPlan(cfg.Age || 25, cfg.Session_Duration, cfg.Tier);
    cfg["Num Blocks"] = plan.blocks;
    cfg["Num Trials"] = plan.perBlock;
  }
  TIER2 = cfg.Tier === 2;
  target.innerHTML = "";

  const datasetRoot = TIER2 ? cfg.tier2_dataset_root : cfg.dataset_root;
  const [manifest, dialogue, stimuli] = await Promise.all([
    jget(`${cfg.asset_root}/manifest.json`),
    jget(`${cfg.asset_root}/dialogue/dialogue_en.json`),
    jget(`${datasetRoot}/manifest.json`),
  ]);

  let entries = Array.isArray(stimuli) ? stimuli : stimuli.concepts;
  if (TIER2) {
    // Only fully matched items. A concept missing either modality cannot be
    // presented in all three conditions, so it cannot enter the within-item
    // AV vs (V + A) contrast at all.
    entries = entries.filter((e) => e.has_audio && e.has_image);
  }
  const concepts = entries.map((e) => e.concept_id);
  const imageFor = Object.fromEntries(
    entries.map((e) => [e.concept_id, `${datasetRoot}/${e.image_file}`]));
  const audioFor = TIER2 ? Object.fromEntries(
    entries.map((e) => [e.concept_id, `${datasetRoot}/${e.audio_file}`])) : {};

  const rooms = cfg["Num Blocks"];
  const perRoom = cfg["Num Trials"];
  const totalRegular = rooms * perRoom;

  // Separate streams, exactly as the PyQt build does: drawing the reward
  // schedule or the room art from the trial stream would shift which triplets
  // the participant sees.
  const pid = cfg.participant_id;

  // One room = one block. In Tier 2 a block is also a CONDITION, assigned by
  // Latin square so modality is not confounded with time-on-task.
  const conditions = TIER2
    ? blockConditions(rooms, latinSquareIndex(stream(pid, "tier2_latin")))
    : Array.from({ length: rooms }, () => "V");

  let trials;
  if (TIER2) {
    const mode = cfg.Tier2_Triplet_Mode || "shared";
    // "shared" needs one block's worth per PASS over the three conditions:
    // the same list is re-presented within a pass, which is what yokes the
    // contrast to the item, and the next pass needs its own triplets so a
    // triplet is judged once per condition rather than once per block.
    const passes = Math.max(1, Math.ceil(rooms / 3));
    const nTriplets = mode === "shared" ? perRoom * passes : totalRegular;
    trials = buildTrialListTier2({
      concepts,
      conditions,
      perBlock: perRoom,
      regularTriplets: generateBalancedTriplets(
        concepts, nTriplets, stream(pid, "tier2_triplets")),
      mode,
      orderRng: stream(pid, "tier2_order"),
    });
  } else {
    trials = buildTrialList(concepts, totalRegular,
                            stream(pid, "tier1_triplets"),
                            stream(pid, "tier1_order"),
                            rooms, perRoom);
  }
  const feedbackRng = stream(pid, "feedback");

  // The game's own sound effects, named in the manifest. Gated on stimulus
  // playback so a chime can never land over a Tier 2 clip.
  initSfx({
    assetRoot: cfg.asset_root,
    sounds: cfg.Gamify ? (manifest.sounds ?? {}) : {},
    muted: cfg.Gamify_Mute_SFX,
    isStimulusActive: stimulusAudioActive,
  });

  // Narrated dialogue -- see js/src/voice.js. Fetches voice_manifest.json to
  // learn which lines have a recording; every speak() call below is a no-op
  // for the rest, so nothing here needs a Gamify guard the way sfx does.
  await initVoice({ assetRoot: cfg.asset_root });

  // Cutscene background music, gated the same way -- see js/src/music.js.
  // Fade duration obeys the same reduced-motion cap the cutscene's own
  // visual cross-fade does below (`fadeMs`), computed here since initMusic
  // runs first.
  const musicFadeMs = cfg.Gamify_Reduced_Motion
    ? Math.min(Number(manifest.music?.fade_ms ?? 1200),
               Number(manifest.accessibility?.reduced_motion?.max_animation_ms ?? 200))
    : Number(manifest.music?.fade_ms ?? 1200);
  initMusic({
    assetRoot: cfg.asset_root,
    music: cfg.Gamify ? (manifest.music ?? {}) : {},
    muted: cfg.Gamify_Mute_SFX,
    fadeMs: musicFadeMs,
  });

  // Mid-trial sticker-reveal popup -- see js/src/sticker_popup.js.
  initStickerPopup({ reducedMotion: Boolean(cfg.Gamify_Reduced_Motion) });

  if (TIER2) {
    // Warm the cache for exactly the clips this session uses, so the first
    // play of a trial is not a download. Only the ones actually scheduled --
    // the full bank is ~17 MB and most of it is never heard.
    const needed = [...new Set(trials.flatMap((t) => t.concepts))];
    for (const c of needed) {
      const a = new Audio(audioFor[c]);
      a.preload = "auto";
      a.load();
    }
  }

  const mascot = cfg.Gamify
    ? `${cfg.asset_root}/${manifest.mascot_variants.neutral.idle}` : "";
  const mascotHappy = cfg.Gamify
    ? `${cfg.asset_root}/${manifest.mascot_variants.neutral.happy}` : "";

  // Each room's OWN trial count, in room order -- what the sticker reveal
  // schedule needs to pick a valid trial-within-room to reveal each of that
  // room's stickers at. Room length is not always uniform (Tier 2 blocks can
  // differ slightly), so this is a real count per room, computed the same
  // way roomOf() below does (defined later; inlined here since this runs
  // first).
  const roomTrialCounts = Array(rooms).fill(0);
  for (const t of trials) {
    const r = TIER2 ? t.block : t.room;
    if (r >= 0 && r < rooms) roomTrialCounts[r] += 1;
  }

  // `conditions` is recorded per room, so the Latin square a session actually
  // ran is reconstructable from the saved file rather than re-derived from
  // the id (which would need this build's hash to be known).
  const castle = cfg.Gamify
    ? CastleState.create(rooms, manifest.stickers.pool,
                         stream(pid, "castle"), pid, conditions, trials.length,
                         roomTrialCounts)
    : null;

  if (castle) {
    const files = manifest.rooms.progression || [];
    const repeatFrom = manifest.rooms.repeat_from || 1;
    const bg = stream(pid, "backdrop");
    for (const r of castle.rooms) {
      r.backdrop = r.index < files.length
        ? files[r.index]
        : bg.choice(files.slice(repeatFrom - 1));
    }
  }

  // Shop / economy. A fourth isolated rng stream, sibling of "castle" and
  // "backdrop" above: every mystery-box draw comes from THIS stream and
  // nothing else, so a purchase can never be traced back to, or influence,
  // a trial -- see shop.js's module docstring.
  const shop = cfg.Gamify ? new ShopState() : null;
  const shopRng = stream(pid, "shop");

  // Which cutscene panels actually exist. game_layer.cutscene_panels checks
  // the filesystem; a browser can only ask by loading, so ask once up front
  // and let the timeline builder decide art-vs-text from the answer. Loading
  // now also means the opening does not stutter on its first fade.
  const artUrls = ["open", "close"].flatMap((w) =>
    (manifest.cutscene?.[w] ?? []).map((p) => p?.image && `${cfg.asset_root}/${p.image}`));
  const usableArt = cfg.Gamify ? await probeImages(artUrls) : new Set();

  // Reduced-stimulation mode obeys the same cap the selection animation does:
  // unexpected movement is the thing the mode exists to limit.
  const fadeMs = cfg.Gamify_Reduced_Motion
    ? Math.min(Number(manifest.cutscene?.fade_ms ?? 450),
               Number(manifest.accessibility?.reduced_motion?.max_animation_ms ?? 200))
    : Number(manifest.cutscene?.fade_ms ?? 450);

  const stickerById = Object.fromEntries(
    manifest.stickers.pool.map((s) => [s.id, s]));

  /** A sticker plus the URL of its picture, which is what gets drawn.
   *
   * Stickers used to render as emoji text, leaving the glyph to whatever
   * emoji font the machine had -- a tofu box on a Linux box with none
   * installed, and missing the Unicode 14/15 entries in the pool even where
   * one is. The manifest's `image` is written by
   * utilities/build_emoji_assets.py; the emoji stays as the fallback.
   */
  const sticker = (id) => {
    const s = stickerById[id] || {};
    return { id, emoji: s.emoji, img: s.image ? `${cfg.asset_root}/${s.image}` : null };
  };
  const stickerHtml = (s) => (s && s.img
    ? `<img class="sticker-art" src="${s.img}" alt="${s.emoji || ""}">`
    : (s && s.emoji) || "");

  // Furniture and backgrounds (shop addition) -- same id/emoji/img shape as
  // sticker(), so stickerHtml/PlaygroundPlugin never have to know the
  // difference between the three.
  const furnitureById = Object.fromEntries(
    (manifest.furniture?.pool ?? []).map((f) => [f.id, f]));
  const backgroundsById = Object.fromEntries(
    (manifest.backgrounds?.pool ?? []).map((b) => [b.id, b]));
  const itemOf = (byId) => (id) => {
    const s = byId[id] || {};
    return { id, label: s.label, emoji: s.emoji,
             img: s.image ? `${cfg.asset_root}/${s.image}` : null };
  };
  const furnitureItem = itemOf(furnitureById);
  const backgroundItem = itemOf(backgroundsById);

  // Shop catalog, resolved once: each entry carries its own art/label so
  // ShopPlugin never has to look anything up in the manifest itself.
  const shopCatalog = (manifest.shop?.catalog ?? []).map((entry) => (
    entry.type === "mystery_box"
      ? { ...entry, pool: (entry.pool ?? []).map((p) => ({
            ...p,
            item: p.type === "furniture" ? furnitureItem(p.ref) : backgroundItem(p.ref),
          })) }
      : { ...entry,
          item: entry.type === "furniture" ? furnitureItem(entry.ref) : backgroundItem(entry.ref) }
  ));
  const currencyIcon = manifest.shop?.currency?.icon ?? "\u{1FA99}";

  // Coins earned so far (response-blind, see castle.js) minus everything
  // spent (player-choice-gated, see shop.js) -- just arithmetic over the
  // two, computed here so neither state object needs a reference to the
  // other. Mirrors _coin_balance() in the desktop build.
  const coinBalance = () => (castle && shop ? castle.coins_awarded - shop.totalSpent : 0);

  const startTime = new Date().toISOString().slice(0, 19).replace("T", " ");
  const responses = [];

  const jsPsych = initJsPsych({
    display_element: "jspsych-target",
    on_finish: () => save(true),
  });

  let saved = false;
  async function save(completed) {
    if (saved) return;
    saved = true;
    const payload = buildPayload({ config: cfg, responses, castle, shop, startTime, completed });
    // Under CHS the parent gets no file: upload_url is the only route out, so
    // a failure there loses the session rather than falling back to a copy on
    // disk. Kept loud for that reason.
    if (cfg.offer_download !== false) downloadPayload(payload);
    if (cfg.upload_url) {
      try { await postPayload(cfg.upload_url, payload); }
      catch (e) {
        console.error(cfg.offer_download === false
          ? "upload failed and no download was offered -- this session is lost"
          : "upload failed; the download still holds the data", e);
      }
    } else if (cfg.offer_download === false) {
      console.error("CHS session with no upload_url: nowhere to put the data");
    }
  }
  // A child who stops partway still yields data: "trials completed before
  // disengagement" is one of the measures the pilot is built around.
  window.addEventListener("beforeunload", () => { if (responses.length) save(false); });

  const line = (key, fallback = "") => {
    const arr = dialogue[key];
    return arr && arr.length ? arr[Math.floor(feedbackRng.random() * arr.length)] : fallback;
  };

  // Like line(), but also returns the index picked -- needed wherever the
  // matching recording has to be spoken via speak(key, index). Kept separate
  // from line() rather than changing its return shape: several of line()'s
  // callers (e.g. trial_prompt, playground_prompt below) run at timeline-
  // build time, long before that screen is actually shown, so speaking
  // there would fire the recording at the wrong moment -- exactly the
  // overlap hazard GameLayer.line()'s speak=False guards against on the
  // desktop build. Callers that DO want audio call speak()/pick() together
  // from inside an on_start hook or a dynamic html() function, which jsPsych
  // evaluates when the screen is actually reached.
  const pick = (key) => {
    const arr = dialogue[key];
    if (!arr || !arr.length) return [null, null];
    const idx = Math.floor(feedbackRng.random() * arr.length);
    return [arr[idx], idx];
  };

  const timeline = [];

  /**
   * A story scene: cross-fading panels when the art is there, and the
   * text-only screens otherwise. Art is made after the code, so a
   * half-populated cutscene/ folder must degrade rather than show a child
   * blank frames.
   */
  function pushCutscene(which, lastButton) {
    const panels = resolvePanels(manifest, dialogue, which, cfg.asset_root, usableArt);
    if (panels.length) {
      timeline.push({
        type: CutscenePlugin,
        panels,
        fade_ms: fadeMs,
        box_rel: Number(manifest.cutscene?.dialogue_box_rel_height ?? 0.18),
        // jsPsych core hooks, not plugin params -- music brackets the scene
        // whether it is skipped by a fast tapper or watched in full.
        on_start: () => playMusic(which),
        on_finish: () => stopMusic(),
      });
      return;
    }
    const cutsceneKey = `cutscene_${which}`;
    const lines = dialogue[cutsceneKey] || [];
    for (const [i, text] of lines.entries()) {
      const first = i === 0;
      const last = i === lines.length - 1;
      timeline.push({
        type: ScreenPlugin,
        html: `<img class="pip big-pip" src="${mascot}" alt=""><p class="speech">${text}</p>`,
        button: last ? lastButton : "Next",
        // Each panel is its own timeline node here (unlike the desktop's
        // stacked text-only fallback), so speaking on_start is naturally
        // one line at a time -- no queueing needed.
        on_start: () => { if (first) playMusic(which); speak(cutsceneKey, i); },
        on_finish: last ? () => stopMusic() : undefined,
      });
    }
  }

  if (cfg.Gamify) {
    pushCutscene("open", "Let's play!");
    const instructionsKey = TIER2 ? "instructions_tier2" : "instructions_tier1";
    timeline.push({
      type: ScreenPlugin,
      html: `<img class="pip big-pip" src="${mascot}" alt="">` +
            (dialogue[instructionsKey] || [])
              .map((t) => `<p class="speech">${t}</p>`).join(""),
      button: "Start",
      // Every instruction line shows at once here (unlike the cutscene
      // panels above), so this queues them instead of firing together.
      on_start: () => speakAll(dialogue, instructionsKey),
    });
  }

  // ONE prompt per condition, drawn once. The desktop build uses stable_line
  // for the same reason: a prompt that reworded itself between trials reads
  // to a child as the instruction having changed.
  const promptFor = {};
  for (const cond of new Set(conditions)) {
    promptFor[cond] = cfg.Gamify
      ? line(CONDITION_DIALOGUE[cond].prompt,
             "Which one is the most different from the other two?")
      : CONDITION_INSTRUCTIONS[cond][1];
  }

  // Both tiers now carry their room on the trial, so a room is a contiguous
  // stretch of the list. Position WITHIN that stretch drives the progress bar,
  // counting attention checks like any other trial: they are trials the child
  // does, and skipping them left the bar frozen for a trial and then full
  // while a trial was still to come.
  const roomOf = (t) => (TIER2 ? t.block : t.room);
  const roomSize = {};
  const posInRoom = trials.map((t) => {
    const r = roomOf(t);
    roomSize[r] = (roomSize[r] ?? 0) + 1;
    return roomSize[r] - 1;
  });

  trials.forEach((t, idx) => {
    const roomIndex = roomOf(t);
    const condition = TIER2 ? t.condition : "V";

    // Tier 2: announce the modality before the first trial of each block.
    if (TIER2 && (idx === 0 || trials[idx - 1].block !== t.block)) {
      const introKey = CONDITION_DIALOGUE[condition].intro;
      // Picked here (build time) so the same text speak() plays below
      // matches what's on screen, but the actual speak() call happens in
      // on_start -- the timeline for every room is built upfront, long
      // before most of it is shown.
      const [introText, introIdx] = cfg.Gamify ? pick(introKey) : [null, null];
      timeline.push({
        type: ScreenPlugin,
        html: cfg.Gamify
          ? `<img class="pip big-pip" src="${mascot}" alt="">` +
            `<p class="speech">${introText ?? "Here's the next room!"}</p>`
          : `<p class="speech">${CONDITION_INSTRUCTIONS[condition][0]}</p>` +
            `<p class="hint">${CONDITION_INSTRUCTIONS[condition][1]}</p>`,
        button: cfg.Gamify ? "Let's go!" : "Continue",
        on_start: cfg.Gamify ? () => speak(introKey, introIdx) : undefined,
      });
    }

    const progress = cfg.Gamify
      ? { current: posInRoom[idx], total: roomSize[roomIndex],
          level: roomIndex + 1, n_levels: rooms }
      : null;
    const common = {
      concepts: t.concepts,
      is_attention: t.is_attention,
      // Index into the TRIAL list, matching the desktop build. Not jsPsych's
      // own `trial_index`, which counts every timeline node including story
      // screens -- see the note in plugins.js.
      task_trial_index: idx,
      prompt: promptFor[condition],
      gamified: cfg.Gamify,
      mascot, mascot_happy: mascotHappy,
      dialogue, rng: feedbackRng,
      progress,
      // Live balance for the header (read at render time, before this
      // trial's own coins land) and a per-trial closure that pays THIS
      // trial's coins and hands back the new total -- see
      // CastleState.awardTrialCoins. Every trial pays, attention checks
      // included, same as the desktop build.
      coin_balance: cfg.Gamify && castle ? coinBalance : null,
      award_coins: cfg.Gamify && castle
        ? () => { castle.awardTrialCoins(idx); return coinBalance(); }
        : null,
      currency_icon: currencyIcon,
      // Stickers: which trial WITHIN its room reveals which sticker was
      // also pre-drawn at session start (see CastleState.awardTrialStickers
      // / allocateRevealPositions), never contingent on WHAT was picked.
      // Unlike coins this is rare -- a room only has 2-4 stickers total --
      // so most trials call this and get nothing back. The popup and its
      // sfx live entirely in this closure so plugins.js/audio.js never need
      // to know about sticker art or CastleState -- they just call it.
      award_stickers: cfg.Gamify && castle
        ? () => {
            const ids = castle.awardTrialStickers(roomIndex, posInRoom[idx]);
            if (ids.length) {
              const s = sticker(ids[0]);
              showStickerReveal({ artUrl: s.img, emoji: s.emoji, onReveal: () => playSfx("sticker") });
            }
            return ids;
          }
        : null,
      on_finish: (d) => {
        const row = makeResponse({
          trialIndex: d.task_trial_index, concepts: d.concepts,
          selected: d.selected_concept, position: d.selected_position,
          isAttention: d.is_attention, rtMs: d.rt, tier: cfg.Tier,
          condition, blockNumber: roomIndex,
        });
        if (condition !== "V") {
          // Additive, A/AV only, ignored by the Python analysis. Kept because
          // response_time_ms on these trials is dominated by ~10s of forced
          // playback -- decision time is response_time_ms - playback_ms --
          // and because a row whose sounds never played is not usable data.
          row.playback_ms = d.playback_ms === null ? null : Math.round(d.playback_ms);
          row.stimulus_autoplay_blocked = Boolean(d.autoplay_blocked);
        }
        responses.push(row);
      },
    };

    timeline.push(condition === "V"
      ? { type: TripletPlugin, images: t.concepts.map((c) => imageFor[c]), ...common }
      : { type: AudioTripletPlugin,
          condition,
          audio: t.concepts.map((c) => audioFor[c]),
          images: condition === "AV" ? t.concepts.map((c) => imageFor[c]) : [],
          lead_in_ms: cfg.Audio_Lead_In_Ms,
          per_sound_ms: cfg.Audio_Gap_Ms,
          ...common });

    // Room boundary: award, then let the child arrange.
    //
    // Keyed off the END OF THE ROOM, never off a count of regular trials.
    // Attention checks are shuffled in among them, so a room's last trial is
    // often an attention one; rewarding at the regular-trial count dropped the
    // reward screen mid-room, and could put the playground BEFORE a trial that
    // still belonged to the room the child had just been congratulated for.
    const atRoomEnd =
      idx === trials.length - 1 || roomOf(trials[idx + 1]) !== roomOf(t);

    if (cfg.Gamify && atRoomEnd && castle && !castle.rooms[roomIndex].completed) {
      const thisRoom = roomIndex;
      timeline.push({
        type: ScreenPlugin,
        html: () => {
          const got = castle.completeRoom(thisRoom).map(sticker);
          // Room finished, then the stickers land. Two sounds because they
          // are two events, and the desktop plays both.
          playSfx("level_up");
          setTimeout(() => playSfx("sticker"), 450);
          const [levelCompleteText, levelCompleteIdx] = pick("level_complete");
          speak("level_complete", levelCompleteIdx);
          return `<img class="pip" src="${mascot}" alt="">` +
                 `<p class="speech">${levelCompleteText ?? "Room finished!"}</p>` +
                 `<p class="awarded">${got.map(stickerHtml).join(" ")}</p>` +
                 `<div class="book">${bookHtml()}</div>`;
        },
        button: "Put them in the castle!",
        // Quiet, not big: the shop must never compete with "go place your
        // stickers" as the obvious next tap. Optional, and its own screen
        // has a one-tap exit -- see ShopPlugin.
        quiet_button: shop ? "Visit the shop" : "",
      });

      if (shop) {
        timeline.push({
          type: ShopPlugin,
          catalog: shopCatalog,
          balance: () => coinBalance(),
          owned_furniture: () => shop.owned_furniture,
          owned_backgrounds: () => shop.owned_backgrounds,
          room_index: thisRoom,
          mascot: mascotHappy,
          currency_icon: currencyIcon,
          rng: shopRng,
          // Reachable only if the room-complete screen's quiet button was
          // the one tapped -- never inserted into the mandatory line of play.
          conditional_function: () =>
            jsPsych.data.get().last(1).values()[0].chose_quiet === true,
          on_finish: (d) => {
            for (const p of d.purchases) shop.applyPurchase(p);
            shop.addShopTime(d.shop_ms);
          },
        });
      }

      timeline.push({
        type: PlaygroundPlugin,
        backdrop: () => {
          // A shop-bought override for this room, if the child equipped
          // one, else the session-start assignment -- never overwritten,
          // so a child who never visits the shop still sees the castle
          // visibly fill up exactly as before. Mirrors _room_backdrop_rel.
          const overrideId = shop?.background_overrides?.[thisRoom];
          const bg = overrideId ? backgroundItem(overrideId) : null;
          return bg?.img || `${cfg.asset_root}/${castle.rooms[thisRoom].backdrop}`;
        },
        pending: () => [
          ...castle.unplacedForRoom(thisRoom).map((id) => ({ ...sticker(id), kind: "sticker" })),
          // Purchased furniture is placed once, globally -- it shows up as
          // pending in whichever room's playground the child currently has
          // open, not in a room it was "planned" for (it wasn't).
          ...(shop ? castle.unplacedFurniture(shop.owned_furniture)
                .map((id) => ({ ...furnitureItem(id), kind: "furniture" })) : []),
        ],
        placed: () => [
          ...castle.placedInRoom(thisRoom)
            .map((p) => ({ ...sticker(p.sticker_id), x: p.x, y: p.y, kind: "sticker" })),
          ...(shop ? castle.furniturePlacedInRoom(thisRoom)
                .map((p) => ({ ...furnitureItem(p.sticker_id), x: p.x, y: p.y, kind: "furniture" })) : []),
        ],
        prompt: line("playground_prompt", "Put them anywhere you like!"),
        room_index: thisRoom,
        on_finish: (d) => {
          for (const p of d.placements) {
            if (p.kind === "furniture") castle.placeFurniture(p.sticker_id, p.room_index, p.x, p.y);
            else castle.place(p.sticker_id, p.room_index, p.x, p.y);
          }
          castle.addPlaygroundTime(d.playground_ms);
        },
      });

      // Between-rooms recap: every completed room so far, plus anything
      // bought but not yet placed. Nothing is "past" to browse after the
      // very first room, and the last room's recap is redundant with the
      // "Look at everything you made!" summary right after it -- so this
      // shows only for the rooms in between, mirroring _leave_playground's
      // room_index > 0 check on the desktop build.
      if (thisRoom > 0 && thisRoom < rooms - 1) {
        timeline.push({
          type: ScreenPlugin,
          html: () => collectionHtml(),
          button: "Continue",
        });
      }
    }
  });

  function collectionHtml() {
    if (!castle) return "";
    const roomsHtml = castle.rooms.filter((r) => r.completed).map((r) => {
      const items = [
        ...castle.placedInRoom(r.index).map((p) => stickerHtml(sticker(p.sticker_id))),
        ...(shop ? castle.furniturePlacedInRoom(r.index)
              .map((p) => stickerHtml(furnitureItem(p.sticker_id))) : []),
      ];
      return `<div class="collection-room">
          <p class="collection-room-label">Room ${r.index + 1}</p>
          <div class="collection-room-items">${items.join(" ") || "—"}</div>
        </div>`;
    }).join("");

    let unplacedHtml = "";
    const unplaced = shop ? castle.unplacedFurniture(shop.owned_furniture) : [];
    if (unplaced.length) {
      unplacedHtml = `<p class="speech">Still to place:</p>
        <div class="book">${unplaced.map((id) =>
          `<span class="slot earned">${stickerHtml(furnitureItem(id))}</span>`).join("")}</div>`;
    }

    return `<p class="speech">Look what you've made so far!</p>
      <div class="collection-rooms">${roomsHtml}</div>
      ${unplacedHtml}`;
  }

  function bookHtml() {
    if (!castle) return "";
    const upcoming = castle.rooms.filter((r) => !r.completed)
      .flatMap((r) => r.sticker_ids).slice(0, castle.unearnedCount);
    return castle.awarded.map((id) =>
        `<span class="slot earned">${stickerHtml(sticker(id))}</span>`).join("") +
      upcoming.map((id) =>
        `<span class="slot mystery">${stickerHtml(sticker(id))}</span>`).join("");
  }

  if (cfg.Gamify) {
    timeline.push({
      type: ScreenPlugin,
      html: () => `<p class="speech">Look at everything you made!</p>` +
                  `<div class="book">${bookHtml()}</div>`,
      button: "Show Pip!",
    });
    pushCutscene("close", "Next");
    timeline.push({
      type: ScreenPlugin,
      // A function so the chime fires when the screen is reached, not when
      // the timeline is assembled -- these are built before the session runs.
      html: () => {
        playSfx("finish");
        const [finishText, finishIdx] = pick("finish");
        speak("finish", finishIdx);
        return `<img class="pip big-pip" src="${mascot}" alt="">` +
               `<p class="speech">${finishText ?? "All done! Thank you for playing."}</p>`;
      },
      button: "Finished!",
    });
  }

  jsPsych.run(timeline);
})().catch((e) => {
  document.getElementById("jspsych-target").innerHTML =
    `<div class="screen"><p class="speech">Could not start: ${e.message}</p>
     <p class="hint">Serve the repository over HTTP (see js/README.md); opening
     index.html directly from disk blocks the manifest loads.</p></div>`;
  console.error(e);
});

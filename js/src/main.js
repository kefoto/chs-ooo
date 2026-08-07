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
import { TripletPlugin, ScreenPlugin } from "./plugins.js";
import { AudioTripletPlugin, armPriming, stimulusAudioActive } from "./audio.js";
import { initSfx, playSfx } from "./sfx.js";
import { CutscenePlugin, resolvePanels, probeImages } from "./cutscene.js";
import { PlaygroundPlugin } from "./playground.js";
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

  // `conditions` is recorded per room, so the Latin square a session actually
  // ran is reconstructable from the saved file rather than re-derived from
  // the id (which would need this build's hash to be known).
  const castle = cfg.Gamify
    ? CastleState.create(rooms, manifest.stickers.pool,
                         stream(pid, "castle"), pid, conditions)
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
    const payload = buildPayload({ config: cfg, responses, castle, startTime, completed });
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
      });
      return;
    }
    const lines = dialogue[`cutscene_${which}`] || [];
    for (const [i, text] of lines.entries()) {
      timeline.push({
        type: ScreenPlugin,
        html: `<img class="pip big-pip" src="${mascot}" alt=""><p class="speech">${text}</p>`,
        button: i === lines.length - 1 ? lastButton : "Next",
      });
    }
  }

  if (cfg.Gamify) {
    pushCutscene("open", "Let's play!");
    timeline.push({
      type: ScreenPlugin,
      html: `<img class="pip big-pip" src="${mascot}" alt="">` +
            (dialogue[TIER2 ? "instructions_tier2" : "instructions_tier1"] || [])
              .map((t) => `<p class="speech">${t}</p>`).join(""),
      button: "Start",
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
      timeline.push({
        type: ScreenPlugin,
        html: cfg.Gamify
          ? `<img class="pip big-pip" src="${mascot}" alt="">` +
            `<p class="speech">${line(CONDITION_DIALOGUE[condition].intro,
                                      "Here's the next room!")}</p>`
          : `<p class="speech">${CONDITION_INSTRUCTIONS[condition][0]}</p>` +
            `<p class="hint">${CONDITION_INSTRUCTIONS[condition][1]}</p>`,
        button: cfg.Gamify ? "Let's go!" : "Continue",
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
          return `<img class="pip" src="${mascot}" alt="">` +
                 `<p class="speech">${line("level_complete", "Room finished!")}</p>` +
                 `<p class="awarded">${got.map(stickerHtml).join(" ")}</p>` +
                 `<div class="book">${bookHtml()}</div>`;
        },
        button: "Put them in the castle!",
      });
      timeline.push({
        type: PlaygroundPlugin,
        backdrop: () => `${cfg.asset_root}/${castle.rooms[thisRoom].backdrop}`,
        pending: () => castle.unplacedForRoom(thisRoom).map(sticker),
        placed: () => castle.placedInRoom(thisRoom)
          .map((p) => ({ ...sticker(p.sticker_id), x: p.x, y: p.y })),
        prompt: line("playground_prompt", "Put them anywhere you like!"),
        room_index: thisRoom,
        on_finish: (d) => {
          for (const p of d.placements) castle.place(p.sticker_id, p.room_index, p.x, p.y);
          castle.addPlaygroundTime(d.playground_ms);
        },
      });
    }
  });

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
        return `<img class="pip big-pip" src="${mascot}" alt="">` +
               `<p class="speech">${line("finish", "All done! Thank you for playing.")}</p>`;
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

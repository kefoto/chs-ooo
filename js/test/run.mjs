/**
 * Tests for the parts that can run without a browser: seeding, triplet
 * balance, the castle's reward contract, and the save schema.
 *
 * The UI is not covered here -- it needs a browser. What IS covered is every
 * property that, if broken, would silently corrupt the data rather than throw.
 *
 *   node js/test/run.mjs
 */
import assert from "node:assert/strict";
import { stream, makeRng } from "../src/rng.js";
import { generateBalancedTriplets, buildTrialList } from "../src/triplets.js";
import { resolvePanels } from "../src/cutscene.js";
import { blockConditions, latinSquareIndex, buildTrialListTier2,
         LATIN_SQUARE_ORDERS } from "../src/tier2.js";
import { CastleState, allocate, allocateCoins, allocateRevealPositions,
         MIN_PER_ROOM, MAX_PER_ROOM, MIN_COINS_PER_TRIAL, MAX_COINS_PER_TRIAL,
         COIN_VALUES, COIN_WEIGHTS, MANSION_ROOM_COUNT, ARCADE_ROOMS,
         UNLOCK_STEP_PCT, MINIGAME_POINTS_PER_COIN, MINIGAME_COINS_PER_ROUND_MAX,
         MINIGAME_COIN_CAP,
       } from "../src/castle.js";
import { buildGame, GAMES, ROUND_MS, RAMP_END } from "../src/minigames/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShopState } from "../src/shop.js";
import { buildPayload, makeResponse, postPayload } from "../src/save.js";
import { sessionPlan, ageBin, FIXED_TRIALS_PER_SESSION } from "../src/session.js";
import { CONFIG, applyUrlOverrides } from "../src/config.js";
import { setupNeeded } from "../src/setup.js";
import { initSfx, playSfx } from "../src/sfx.js";
import { initMusic, playMusic, stopMusic } from "../src/music.js";

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};
// Only the timed music-fade test needs to actually wait on a clock; every
// other test in this file is synchronous.
const testAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const CONCEPTS = Array.from({ length: 100 }, (_, i) => `c${i}`);
const POOL = Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, emoji: "*" }));

test("a participant id reproduces its session", () => {
  const a = Array.from({ length: 8 }, () => stream("P1", "x").int(0, 999));
  const b = Array.from({ length: 8 }, () => stream("P1", "x").int(0, 999));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, Array.from({ length: 8 }, () => stream("P2", "x").int(0, 999)));
});

test("triplet pair coverage is near-perfect", () => {
  for (const T of [100, 500, 1000]) {
    const tri = generateBalancedTriplets(CONCEPTS, T, stream("P1", "t"));
    assert.equal(tri.length, T);
    const counts = new Map();
    for (const t of tri) {
      assert.equal(new Set(t).size, 3, "a triplet repeated a concept");
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const k = [t[i], t[j]].sort().join("|");
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    // Every pair used at most once while unused pairs remain: this is what
    // keeps the aggregated embedding well conditioned.
    assert.equal(Math.max(...counts.values()), 1, `pair reused at T=${T}`);
    assert.equal(counts.size, 3 * T);
  }
});

test("attention trials are ~10% and each repeats one concept", () => {
  const list = buildTrialList(CONCEPTS, 500, stream("P1", "t"), stream("P1", "o"));
  const att = list.filter((t) => t.is_attention);
  assert.equal(list.length, 550);
  assert.equal(att.length, 50);
  for (const t of att) assert.equal(new Set(t.concepts).size, 2);
});

// --- Tier 2: the properties the supradditivity contrast rests on ----------

test("every Latin square puts each condition in each position", () => {
  for (let pos = 0; pos < 3; pos++) {
    const at = new Set(LATIN_SQUARE_ORDERS.map((o) => o[pos]));
    assert.deepEqual([...at].sort(), ["A", "AV", "V"], `position ${pos}`);
  }
  // Blocks cycle the participant's order, so conditions stay balanced however
  // many rooms a session runs.
  const c = blockConditions(6, latinSquareIndex(stream("P1", "tier2_latin")));
  assert.equal(c.length, 6);
  assert.deepEqual(c.slice(0, 3), c.slice(3, 6));
  for (const cond of ["V", "A", "AV"]) {
    assert.equal(c.filter((x) => x === cond).length, 2, `${cond} unbalanced`);
  }
});

test("participants spread evenly across all six Latin squares", () => {
  // A derivation that collapsed onto four or five orders, or leaned on one,
  // would leave the design uncounterbalanced with nothing failing. This is
  // not hypothetical: hashSeed(pid) % 6 does exactly that on the sequential
  // ids a facility assigns -- see the note in tier2.js.
  const ids = [];
  for (let i = 0; i < 200; i++) ids.push(`P${i}`);
  for (let i = 1; i <= 64; i++) ids.push(String(i).padStart(4, "0"));

  const counts = new Array(6).fill(0);
  for (const id of ids) counts[latinSquareIndex(stream(id, "tier2_latin"))]++;
  assert.ok(Math.min(...counts) > 0, `unused order: ${counts}`);
  // Even allocation, not merely non-empty: ~44 expected per cell here.
  const expected = ids.length / 6;
  assert.ok(Math.max(...counts) < expected * 1.5 && Math.min(...counts) > expected * 0.5,
            `skewed allocation: ${counts}`);

  const idx = (id) => latinSquareIndex(stream(id, "tier2_latin"));
  assert.equal(idx("P7"), idx("P7"), "not reproducible from the id");
});

test("shared mode yokes the same triplets to every condition", () => {
  const conditions = ["V", "A", "AV"];
  const tri = generateBalancedTriplets(CONCEPTS, 6, stream("P1", "t"));
  const trials = buildTrialListTier2({
    concepts: CONCEPTS, conditions, perBlock: 6, regularTriplets: tri,
    mode: "shared", orderRng: stream("P1", "o"),
  });
  // AV vs (V + A) is an ITEM-level contrast: it is only defined if the very
  // same triplet was judged under all three conditions.
  const byCond = {};
  for (const t of trials.filter((x) => !x.is_attention)) {
    (byCond[t.condition] ??= []).push([...t.concepts].sort().join("|"));
  }
  const key = (c) => byCond[c].slice().sort().join(",");
  assert.equal(key("V"), key("A"));
  assert.equal(key("V"), key("AV"));
  assert.equal(byCond.V.length, 6);
});

test("six blocks yoke within a pass, not across passes", () => {
  // Two blocks per condition means the conditions come round twice. Re-showing
  // the first pass's triplets would make the child judge each one twice per
  // condition -- six exposures instead of three -- folding a practice effect
  // into the very AV-vs-(V+A) contrast the yoking exists to keep clean.
  const conditions = blockConditions(6, 0);
  const perBlock = 4;
  const passes = Math.ceil(conditions.length / 3);
  const tri = generateBalancedTriplets(CONCEPTS, perBlock * passes, stream("P1", "t"));
  const trials = buildTrialListTier2({
    concepts: CONCEPTS, conditions, perBlock, regularTriplets: tri,
    mode: "shared", orderRng: stream("P1", "o"),
  });

  const byCond = {};
  for (const t of trials.filter((x) => !x.is_attention)) {
    (byCond[t.condition] ??= []).push([...t.concepts].sort().join("|"));
  }
  assert.deepEqual(Object.keys(byCond).sort(), ["A", "AV", "V"]);

  // Yoking intact: every condition judges the same set.
  const key = (c) => byCond[c].slice().sort().join(",");
  assert.equal(key("V"), key("A"));
  assert.equal(key("V"), key("AV"));

  // ...and each triplet exactly once per condition, not once per block.
  for (const [c, seen] of Object.entries(byCond)) {
    const counts = new Map();
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
    assert.equal(Math.max(...counts.values()), 1,
      `${c} showed a triplet twice; a triplet must be judged once per condition`);
    assert.equal(seen.length, perBlock * passes);
  }
});

test("every session runs the fixed trial count, per block not in total", () => {
  // `Num Trials` is trials PER BLOCK -- the runner multiplies by Num Blocks.
  // Handing it the session total is what made the desktop build run an
  // adult's "80 trial" session as 704.
  //
  // The count itself is now flat across age and duration, and must MATCH
  // core/flexible_session_manager.FIXED_TRIALS_PER_SESSION. If the two builds
  // disagree, a browser session and a lab session of the "same" length hold
  // different amounts of data.
  for (const age of [4, 5, 8, 14, 17, 25, 60]) {
    for (const dur of ["short", "standard", "extended"]) {
      const p = sessionPlan(age, dur, 1);
      assert.equal(p.recommended, FIXED_TRIALS_PER_SESSION,
        `age ${age} ${dur}: target ${p.recommended}`);
      assert.equal(p.blocks * p.perBlock, p.total);
      // Blocks must divide the total exactly or the session lands short --
      // under-12s were on 4, which gives 137 blocks and 548 trials.
      assert.equal(p.total, FIXED_TRIALS_PER_SESSION,
        `age ${age} ${dur}: ${p.blocks} blocks of ${p.perBlock} runs ` +
        `${p.total}, not ${FIXED_TRIALS_PER_SESSION}`);
      // Must match core/flexible_session_manager.get_session_config: a
      // browser session and a lab session of the same age should hand the
      // child the same number of rooms, not just the same number of trials.
      const wantBlock = age < 18 ? 11 : 25;
      assert.equal(p.perBlock, wantBlock,
        `age ${age}: blocks of ${p.perBlock}, expected ${wantBlock}`);
      // The reward loop is what block size is for: a session with more rooms
      // than the sticker pool holds starts repeating stickers.
      assert.ok(p.blocks <= 55,
        `age ${age}: ${p.blocks} rooms is more sticker ceremonies than a ` +
        `session should hold`);
    }
  }
});

test("a CHS link identifies the child and never shows the setup form", () => {
  // CHS appends the hashed child id and the response id to the Study URL:
  //   ...?child=SG7JLN&response=d5c8f502-6588-46c8-84fa-a9657a44fe47
  // They are the only identity CHS hands over, and without them a session
  // cannot be joined to the family's demographic snapshot afterwards.
  const chs = "?child=SG7JLN&response=d5c8f502-6588-46c8-84fa-a9657a44fe47";
  const cfg = applyUrlOverrides({ ...CONFIG }, chs);

  assert.equal(cfg.chs_child, "SG7JLN");
  assert.equal(cfg.chs_response, "d5c8f502-6588-46c8-84fa-a9657a44fe47");
  assert.equal(cfg.participant_id, "SG7JLN", "the child hash seeds the session");
  assert.equal(cfg.offer_download, false, "no file prompt on a parent's machine");

  // The form asks an experimenter for demographics CHS already holds, and
  // there is no experimenter at home. Not even ?setup=1 may bring it back.
  assert.equal(setupNeeded(chs), false);
  assert.equal(setupNeeded(`${chs}&setup=1`), false);
  // Without CHS parameters the form still gates a session that has no id.
  assert.equal(setupNeeded("?tier=1"), true);
  assert.equal(setupNeeded("?pid=P07"), false);

  // And the ids must survive into the saved payload, or the join is lost.
  const p = buildPayload({ config: cfg, responses: [], castle: null,
    startTime: "2026-01-01 00:00:00", completed: true });
  assert.equal(p.participant_data.chs_child, "SG7JLN");
  assert.equal(p.participant_data.chs_response,
    "d5c8f502-6588-46c8-84fa-a9657a44fe47");
});

test("a lab session is unaffected by the CHS handling", () => {
  const cfg = applyUrlOverrides({ ...CONFIG }, "?pid=LAB01&age=7");
  assert.equal(cfg.participant_id, "LAB01");
  assert.equal(cfg.chs_child, null);
  assert.equal(cfg.offer_download, true, "the lab still gets its download");
  const p = buildPayload({ config: cfg, responses: [], castle: null,
    startTime: "2026-01-01 00:00:00", completed: true });
  assert.equal(p.participant_data.chs_child, null);
  assert.equal(p.participant_data.age, "7");
});

// The query string on a deployment is whatever the visitor typed, so these
// cover the three ways that can go wrong: breaking the session, cheating it,
// and redirecting where its data goes. DEPLOY/LOCAL stand in for
// window.location, which applyUrlOverrides takes as its third argument.
const DEPLOY = { hostname: "chs-ooo.vercel.app", href: "https://chs-ooo.vercel.app/" };
const LOCAL = { hostname: "localhost", href: "http://localhost:8000/js/" };
const onDeploy = (qs) => applyUrlOverrides({ ...CONFIG }, qs, DEPLOY);
const onLocal = (qs) => applyUrlOverrides({ ...CONFIG }, qs, LOCAL);

test("?bonus_coins= works on a dev host and nowhere else", () => {
  // The one parameter whose entire purpose is to skip the game.
  assert.equal(onLocal("?bonus_coins=500").Debug_Bonus_Coins, 500);
  assert.equal(onLocal("?bonus_coins=-50").Debug_Bonus_Coins, 0);
  assert.equal(onLocal("?bonus_coins=nope").Debug_Bonus_Coins, 0);
  assert.equal(onLocal("?bonus_coins=1e12").Debug_Bonus_Coins, 1e6);   // clamped
  assert.equal(onLocal("").Debug_Bonus_Coins, 0);
  assert.equal(onDeploy("?bonus_coins=500").Debug_Bonus_Coins, 0);
});

test("?upload= and ?media= cannot leave this origin", () => {
  // upload_url decides where a child's age, gender, ethnicity, race,
  // handedness and first language are sent. Off-origin is a one-parameter
  // data leak, so only this origin is accepted.
  assert.equal(onDeploy("?upload=https://evil.example/collect").upload_url,
    CONFIG.upload_url, "off-origin destination refused, default left alone");
  assert.equal(onDeploy("?upload=//evil.example/collect").upload_url,
    CONFIG.upload_url,
    "protocol-relative looks relative but resolves to another host");
  assert.equal(onDeploy("?upload=/api/other").upload_url, "/api/other");
  assert.equal(
    onDeploy("?upload=https://chs-ooo.vercel.app/api/other").upload_url,
    "https://chs-ooo.vercel.app/api/other");

  // Same rule for where the page loads its stimuli from.
  assert.equal(onDeploy("?media=https://evil.example").asset_root,
    CONFIG.asset_root, "off-origin media is ignored");
  const same = onDeploy("?media=https://chs-ooo.vercel.app/mirror/");
  assert.equal(same.asset_root, "https://chs-ooo.vercel.app/mirror/assets/game");
  assert.equal(same.dataset_root,
    "https://chs-ooo.vercel.app/mirror/datasets/Tier1_THINGS_560");
  assert.equal(same.tier2_dataset_root,
    "https://chs-ooo.vercel.app/mirror/datasets/Tier2_AV_Matched");
});

test("a CHS session's identity, length and destination are fixed", () => {
  // A family can edit the link before they arrive. None of these may take.
  const c = onDeploy("?child=SG7JLN&pid=IMPOSTOR&rooms=1&trials=1"
    + "&upload=https://evil.example");
  assert.equal(c.participant_id, "SG7JLN",
    "the child hash seeds the session and is the join key to the demographics");
  assert.equal(c.session_length_pinned, false,
    "length falls through to the age-bin plan, not to a two-tap session");
  assert.equal(c.upload_url, CONFIG.upload_url, "off-origin destination refused");
  // A CHS session may still be pointed somewhere else ON THIS ORIGIN -- the
  // rule is same-origin, not "CHS may not upload", which would leave those
  // sessions with nowhere to put their data.
  assert.equal(onDeploy("?child=SG7JLN&upload=/api/other").upload_url, "/api/other");
  assert.equal(c.chs_child, "SG7JLN");
  assert.equal(c.offer_download, false);
});

test("a CHS session's ARM and TASK are fixed too", () => {
  // The other half of the same problem, and the one that corrupts data
  // rather than breaking a session: a family that edits ?plain=1 into their
  // link is in the non-gamified baseline arm, and ?tier=2 is a different
  // experiment. Both look like ordinary rows afterwards.
  const c = onDeploy("?child=SG7JLN&tier=2&plain=1&calm=1&quiet=1"
    + "&age=25&site=NOWHERE&mode=disjoint&duration=extended");
  assert.equal(c.Tier, CONFIG.Tier, "the task is the deploy's, not the URL's");
  assert.equal(c.Gamify, CONFIG.Gamify, "the arm is the deploy's");
  assert.equal(c.Gamify_Reduced_Motion, CONFIG.Gamify_Reduced_Motion);
  assert.equal(c.Gamify_Mute_SFX, CONFIG.Gamify_Mute_SFX);
  assert.equal(c.Age, CONFIG.Age,
    "age is joined from the CHS snapshot on chs_child, never taken from the link");
  assert.equal(c.Tier2_Triplet_Mode, CONFIG.Tier2_Triplet_Mode);
  assert.equal(c.Session_Duration, CONFIG.Session_Duration);
  assert.equal(c["Experiment Site"], CONFIG["Experiment Site"]);

  // A lab/facility link is not a visitor's link: the experimenter sets these.
  const lab = onDeploy("?pid=P07&tier=2&plain=1&age=25");
  assert.equal(lab.Tier, 2);
  assert.equal(lab.Gamify, false);
  assert.equal(lab.Age, "25");

  // ...and a dev host can walk the CHS path in any configuration, or the
  // jsdom harness could only ever test it in whatever tier CONFIG names.
  const dev = onLocal("?child=SG7JLN&tier=2&plain=1");
  assert.equal(dev.Tier, 2);
  assert.equal(dev.Gamify, false);
});

test("a broken number never reaches the session builder", () => {
  // ?rooms=abc used to leave Num Blocks NaN and build zero trials;
  // ?rooms=20000 built 220,000 of them and locked the tab for 19 seconds.
  const bad = onDeploy("?rooms=abc&trials=abc");
  assert.equal(bad.session_length_pinned, false, "falls through to the plan");
  assert.equal(onDeploy("?rooms=20000")["Num Blocks"], 64);
  assert.equal(onDeploy("?rooms=0&trials=-9")["Num Blocks"], 1);
  assert.equal(onDeploy("?rooms=0&trials=-9")["Num Trials"], 1);
  assert.equal(onDeploy("?gap=-5000").Audio_Gap_Ms, 100);
  assert.equal(onDeploy("?lead=99999").Audio_Lead_In_Ms, 10000);
  // An unparseable age used to fall through to the ADULT plan, which is
  // 25-trial blocks in front of a four-year-old.
  assert.equal(onDeploy("?age=abc").Age, CONFIG.Age);
  assert.equal(onDeploy("?age=7").Age, "7");
});

test("a word that means nothing is ignored, not passed through", () => {
  assert.equal(onDeploy("?mode=nonsense").Tier2_Triplet_Mode,
    CONFIG.Tier2_Triplet_Mode);
  assert.equal(onDeploy("?mode=disjoint").Tier2_Triplet_Mode, "disjoint");
  assert.equal(onDeploy("?duration=forever").Session_Duration,
    CONFIG.Session_Duration);
  assert.equal(onDeploy("?duration=short").Session_Duration, "short");
  assert.equal(onDeploy("?tier=9").Tier, 1);
});

test("a lab link still configures a session normally", () => {
  // The hardening must not cost the experimenter their own workflow.
  const c = onDeploy("?pid=P07&rooms=6&trials=8&age=7&tier=2&site=Yale&plain=1");
  assert.equal(c.participant_id, "P07");
  assert.equal(c["Num Blocks"], 6);
  assert.equal(c["Num Trials"], 8);
  assert.equal(c.session_length_pinned, true);
  assert.equal(c.Age, "7");
  assert.equal(c.Tier, 2);
  assert.equal(c["Experiment Site"], "Yale");
  assert.equal(c.Gamify, false);
});



test("tier 2 runs two blocks per condition, same total", () => {
  for (const [age, dur] of [[5, "standard"], [8, "standard"], [25, "standard"]]) {
    const p = sessionPlan(age, dur, 2);
    assert.equal(p.blocks, 6, "tier 2 should run two blocks per condition");
    assert.equal(p.blocks % 3, 0, "block count must stay a multiple of 3");
    // Tier 2 tracks its OWN target, which its pacing may cap below the visual
    // one: A and AV play three clips before a choice is possible.
    assert.ok(Math.abs(p.total - p.target) <= p.blocks / 2,
      `tier 2 total ${p.total} strays from the ${p.target} target`);
    // Whatever the cap, the playback must fit the session it was asked for.
    const minutes = (p.total * 9.2) / 60;
    assert.ok(minutes <= p.minutes,
      `tier 2 schedules ${minutes.toFixed(0)} min of trials in a ${p.minutes} min session`);
  }
});

test("disjoint mode gives each block its own triplets", () => {
  const conditions = ["V", "A", "AV"];
  const tri = generateBalancedTriplets(CONCEPTS, 18, stream("P1", "t"));
  const trials = buildTrialListTier2({
    concepts: CONCEPTS, conditions, perBlock: 6, regularTriplets: tri,
    mode: "disjoint", orderRng: stream("P1", "o"),
  });
  const keys = trials.filter((t) => !t.is_attention)
    .map((t) => [...t.concepts].sort().join("|"));
  assert.equal(keys.length, 18);
  assert.equal(new Set(keys).size, 18, "a triplet was reused across blocks");
});

test("conditions stay blocked, and shuffling never crosses a block", () => {
  const conditions = ["AV", "V", "A", "AV"];
  const trials = buildTrialListTier2({
    concepts: CONCEPTS, conditions, perBlock: 5,
    regularTriplets: generateBalancedTriplets(CONCEPTS, 5, stream("P1", "t")),
    mode: "shared", orderRng: stream("P1", "o"),
  });
  // Block indices must be non-decreasing: interleaving them would confound
  // modality with time-on-task, which is exactly what the Latin square is for.
  const blocks = trials.map((t) => t.block);
  assert.deepEqual(blocks, [...blocks].sort((a, b) => a - b));
  for (const t of trials) {
    assert.equal(t.condition, conditions[t.block], "trial left its block");
  }
  // Each block carries its own attention checks.
  for (let b = 0; b < conditions.length; b++) {
    const inBlock = trials.filter((t) => t.block === b);
    assert.equal(inBlock.filter((t) => !t.is_attention).length, 5);
    assert.ok(inBlock.some((t) => t.is_attention), `block ${b} has no check`);
  }
});

test("a Tier 2 row carries the condition its judgment was made under", () => {
  const rows = ["V", "A", "AV"].map((condition, i) => makeResponse({
    trialIndex: i, concepts: ["a", "b", "c"], selected: "a", position: 0,
    isAttention: false, rtMs: 1200, tier: 2, condition, blockNumber: i,
  }));
  // Without this the three conditions are indistinguishable in the saved file
  // and the supradditivity analysis has nothing to split on.
  assert.deepEqual(rows.map((r) => r.condition), ["V", "A", "AV"]);
  assert.deepEqual(rows.map((r) => r.block_number), [0, 1, 2]);
  assert.ok(rows.every((r) => r.tier === 2));
});

// --- Cutscene: panels resolve, and degrade rather than show blank frames ---

const CUT_MANIFEST = {
  cutscene: {
    open: [{ image: "cutscene/1.png", line: 0 },
           { image: "cutscene/2.png", line: 1 },
           { image: "cutscene/2.png", line: 2 }],
    close: [{ image: "cutscene/3.png", line: 0 }],
  },
};
const CUT_DIALOGUE = { cutscene_open: ["one", "two", "three"], cutscene_close: ["bye"] };

test("cutscene panels pair the right line with the right image", () => {
  const all = new Set(["A/cutscene/1.png", "A/cutscene/2.png"]);
  const p = resolvePanels(CUT_MANIFEST, CUT_DIALOGUE, "open", "A", all);
  assert.deepEqual(p.map((x) => x.text), ["one", "two", "three"]);
  assert.deepEqual(p.map((x) => x.image),
                   ["A/cutscene/1.png", "A/cutscene/2.png", "A/cutscene/2.png"]);
  // Panel 2 and 3 deliberately share art: the scene holds while the text
  // changes, so the player must not fade between them.
  assert.equal(p[1].image, p[2].image);
});

test("a cutscene with no usable art falls back to text, not blank frames", () => {
  // Art is made after the code. A half-populated folder must degrade.
  assert.deepEqual(resolvePanels(CUT_MANIFEST, CUT_DIALOGUE, "open", "A", new Set()), []);
  // But ONE usable panel is enough to run the scene; the rest go imageless
  // rather than dropping their line.
  const some = resolvePanels(CUT_MANIFEST, CUT_DIALOGUE, "open", "A",
                             new Set(["A/cutscene/2.png"]));
  assert.equal(some.length, 3);
  assert.equal(some[0].image, "");
  assert.equal(some[0].text, "one", "a missing image dropped its line too");
});

test("an out-of-range line index yields empty text, not a crash", () => {
  const m = { cutscene: { open: [{ image: "cutscene/1.png", line: 9 }] } };
  const p = resolvePanels(m, CUT_DIALOGUE, "open", "A", new Set(["A/cutscene/1.png"]));
  assert.equal(p[0].text, "");
});

test("the reward schedule cannot see a response", () => {
  // allocate() takes a room count and an rng: there is no parameter a choice
  // could enter through. completeRoom() takes an index and nothing else.
  // (Function.length stops at the first defaulted parameter, so assert on the
  // signature text rather than the arity.)
  const sigOf = (fn) => fn.toString().slice(fn.toString().indexOf("("),
                                            fn.toString().indexOf(")") + 1);
  for (const fn of [allocate, CastleState.prototype.completeRoom,
                    CastleState.prototype.place]) {
    const sig = sigOf(fn).toLowerCase();
    for (const banned of ["response", "choice", "selected", "correct", "answer"]) {
      assert.ok(!sig.includes(banned),
                `${fn.name} can see the response via "${banned}"`);
    }
  }
  assert.equal(CastleState.prototype.completeRoom.length, 1);
  const alloc = allocate(20, stream("P1", "c"));
  assert.ok(alloc.every((n) => n >= MIN_PER_ROOM && n <= MAX_PER_ROOM));
  assert.ok(new Set(alloc).size > 1, "allocation never varies");
});

test("rooms pay out once, and only once", () => {
  // completeRoom returns only the CATCH-UP leftover (see the per-trial
  // reveal schedule), so a second call must return [] rather than
  // replaying the first call's list.
  const st = CastleState.create(3, POOL, stream("P1", "c"), "P1");
  const first = st.completeRoom(0);
  assert.deepEqual(st.completeRoom(0), [], "second call must pay nothing");
  assert.equal(st.awarded.length, first.length, "double award");
});

test("the coin schedule cannot see a response either", () => {
  const sigOf = (fn) => fn.toString().slice(fn.toString().indexOf("("),
                                            fn.toString().indexOf(")") + 1);
  const sig = sigOf(allocateCoins).toLowerCase();
  for (const banned of ["response", "choice", "selected", "correct", "answer"]) {
    assert.ok(!sig.includes(banned), `allocateCoins can see the response via "${banned}"`);
  }
  const alloc = allocateCoins(60, stream("P1", "c"));
  assert.ok(alloc.every((n) => n >= MIN_COINS_PER_TRIAL && n <= MAX_COINS_PER_TRIAL));
  assert.ok(new Set(alloc).size > 1, "coin allocation never varies");
});

test("1 coin is the most likely draw, matching COIN_WEIGHTS", () => {
  assert.equal(COIN_VALUES[0], 1);
  assert.equal(COIN_WEIGHTS[0], Math.max(...COIN_WEIGHTS));
  const alloc = allocateCoins(2000, stream("P1", "weights"));
  const counts = Object.fromEntries(COIN_VALUES.map((v) => [v, alloc.filter((n) => n === v).length]));
  assert.ok(counts[1] > counts[2] && counts[2] > counts[3],
    `draw did not favour 1: ${JSON.stringify(counts)}`);
});

test("the coin schedule is reproducible from the participant id", () => {
  const a = CastleState.create(5, POOL, stream("P1", "c"), "P1", [], 20);
  const b = CastleState.create(5, POOL, stream("P1", "c"), "P1", [], 20);
  assert.deepEqual(a.coin_allocation, b.coin_allocation);
  const c = CastleState.create(5, POOL, stream("P2", "c"), "P2", [], 20);
  assert.notDeepEqual(a.coin_allocation, c.coin_allocation,
    "different participants got an identical coin schedule");
});

test("coins ride the same draw as stickers, one continuous stream", () => {
  // If coins were a second independent trigger, drawing them wouldn't need
  // to happen between the sticker allocation and the sticker shuffle. Here
  // it does -- create()'s sticker identities must match a lone allocate()
  // call at the same seed, proving nothing else was drawn from the rng
  // before the sticker order is fixed except the coin allocation itself,
  // in the documented order.
  const seed = 99;
  const stickersAlone = allocate(4, stream(String(seed), "seedcheck"));
  const st = CastleState.create(4, POOL, stream(String(seed), "seedcheck"), "X", [], 20);
  assert.deepEqual(st.allocation, stickersAlone,
    "CastleState.create must draw stickers first, exactly like allocate() alone");
});

test("a trial pays out coins once, and only once", () => {
  const st = CastleState.create(3, POOL, stream("P1", "c"), "P1", [], 10);
  const planned = st.coin_allocation[0];
  const paid = st.awardTrialCoins(0);
  assert.equal(paid, planned);
  assert.equal(st.coins_awarded, planned);
  assert.equal(st.trials_paid, 1);
  st.awardTrialCoins(0);
  assert.equal(st.coins_awarded, planned, "double award of coins");
  assert.equal(st.trials_paid, 1);
});

test("trial coins must be claimed in order", () => {
  const st = CastleState.create(3, POOL, stream("P1", "c"), "P1", [], 10);
  assert.equal(st.awardTrialCoins(3), 0, "an out-of-order claim must not pay");
  assert.equal(st.coins_awarded, 0);
  assert.equal(st.awardTrialCoins(0), st.coin_allocation[0]);
  assert.equal(st.awardTrialCoins(0), 0, "a repeated claim must not pay twice");
  assert.equal(st.awardTrialCoins(1), st.coin_allocation[1]);
});

test("the sticker reveal schedule cannot see a response", () => {
  const sigOf = (fn) => fn.toString().slice(fn.toString().indexOf("("),
                                            fn.toString().indexOf(")") + 1);
  const sig = sigOf(allocateRevealPositions).toLowerCase();
  for (const banned of ["response", "choice", "selected", "correct", "answer"]) {
    assert.ok(!sig.includes(banned), `allocateRevealPositions can see the response via "${banned}"`);
  }
});

test("reveal positions stay within the room and arrive sorted", () => {
  const positions = allocateRevealPositions([3, 2, 4], [11, 11, 2], stream("P1", "reveal"));
  assert.equal(positions.length, 3);
  assert.deepEqual(positions[0], [...positions[0]].sort((a, b) => a - b));
  assert.ok(positions[0].every((p) => p >= 0 && p < 11));
  assert.equal(new Set(positions[0]).size, 3, "room 0's 3 stickers must land on 3 distinct trials");
  // Room 2 has 4 stickers but only 2 trials: everyone gets a distinct slot
  // first, then the rest double up on the LAST trial rather than being lost.
  assert.deepEqual(positions[2], [0, 1, 1, 1]);
});

test("a room reveals its stickers one at a time, in the pre-drawn order", () => {
  const st = CastleState.create(3, POOL, stream("P1", "c"), "P1", [], 30, [10, 10, 10]);
  const room = st.rooms[0];
  assert.ok(room.reveal_positions.length >= 2, "test needs a room with >=2 stickers");

  // Nothing scheduled at position -1 (never happens in practice, just
  // proving a non-matching position pays nothing).
  assert.deepEqual(st.awardTrialStickers(0, -1), []);

  const [firstPos, secondPos] = room.reveal_positions;
  const got = st.awardTrialStickers(0, firstPos);
  assert.deepEqual(got, [room.sticker_ids[0]]);
  assert.equal(room.revealed, 1);
  // A repeat of the SAME position must not pay twice.
  assert.deepEqual(st.awardTrialStickers(0, firstPos), []);
  assert.equal(room.revealed, 1);

  if (secondPos !== undefined) {
    assert.deepEqual(st.awardTrialStickers(0, secondPos), [room.sticker_ids[1]]);
  }
});

test("completeRoom catches up any stickers a short room never reached", () => {
  // 1 trial, up to 4 stickers planned: every extra sticker doubles up on
  // that one trial's position, so awardTrialStickers(0, 0) should already
  // deliver everything -- but completeRoom must still make the child whole
  // even if it somehow didn't (e.g. the session ended before that trial's
  // feedback ran).
  const st = CastleState.create(1, POOL, stream("P1", "c"), "P1", [], 1, [1]);
  const room = st.rooms[0];
  const leftover = st.completeRoom(0);
  assert.deepEqual(new Set(leftover), new Set(room.sticker_ids));
  assert.equal(st.awarded.length, room.stickers_planned);
  assert.equal(room.revealed, room.sticker_ids.length);
});

test("furniture placement is separate from stickers", () => {
  const st = CastleState.create(2, POOL, stream("P1", "c"), "P1");
  const sid = st.rooms[0].sticker_ids[0];
  st.place(sid, 0, 0.5, 0.5);
  st.placeFurniture("tapestry", 0, 0.2, 0.2);
  assert.equal(st.placements.length, 1, "furniture leaked into the sticker list");
  assert.equal(st.furniture_placements.length, 1);
});

test("furniture is placed once globally, not per room", () => {
  const st = CastleState.create(3, POOL, stream("P1", "c"), "P1");
  assert.deepEqual(st.unplacedFurniture(["tapestry", "cushion"]), ["tapestry", "cushion"]);
  st.placeFurniture("tapestry", 1, 0.4, 0.4);
  assert.deepEqual(st.unplacedFurniture(["tapestry", "cushion"]), ["cushion"]);
  assert.equal(st.furniturePlacedInRoom(1)[0].sticker_id, "tapestry");
  assert.deepEqual(st.furniturePlacedInRoom(0), []);
});

test("replacing furniture moves it rather than duplicating", () => {
  const st = CastleState.create(2, POOL, stream("P1", "c"), "P1");
  st.placeFurniture("tapestry", 0, 0.1, 0.1);
  st.placeFurniture("tapestry", 1, 0.9, 0.9);
  assert.equal(st.furniture_placements.length, 1);
  assert.equal(st.furniture_placements[0].room_index, 1);
});

test("unplaceFurniture returns a placed item to the shared pocket", () => {
  const st = CastleState.create(2, POOL, stream("P1", "c"), "P1");
  st.placeFurniture("tapestry", 0, 0.2, 0.2);
  assert.deepEqual(st.unplacedFurniture(["tapestry"]), []);
  st.unplaceFurniture("tapestry");
  assert.equal(st.furniture_placements.length, 0);
  assert.deepEqual(st.unplacedFurniture(["tapestry"]), ["tapestry"]);
  // Never placed: a safe no-op, not a throw.
  st.unplaceFurniture("cushion");
  assert.equal(st.furniture_placements.length, 0);
});

test("re-placing a sticker moves it rather than duplicating", () => {
  const st = CastleState.create(2, POOL, stream("P1", "c"), "P1");
  const id = st.rooms[0].sticker_ids[0];
  st.place(id, 0, 0.2, 0.2);
  st.place(id, 0, 0.8, 0.6);
  const mine = st.placedInRoom(0).filter((p) => p.sticker_id === id);
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].x, mine[0].y], [0.8, 0.6]);
});

test("a 25-room session never repeats a sticker", () => {
  for (let seed = 0; seed < 10; seed++) {
    const st = CastleState.create(25, POOL, makeRng(seed), "P");
    const ids = st.rooms.flatMap((r) => r.sticker_ids);
    assert.equal(ids.length, new Set(ids).size, `repeat at seed ${seed}`);
  }
});

test("the saved schema is the one the Python analysis reads", () => {
  const castle = CastleState.create(2, POOL, stream("P1", "c"), "P1");
  castle.completeRoom(0);
  const responses = [
    makeResponse({ trialIndex: 0, concepts: ["a", "b", "c"], selected: "b",
                   position: 1, isAttention: false, rtMs: 700 }),
    makeResponse({ trialIndex: 1, concepts: ["d", "d", "e"], selected: "e",
                   position: 2, isAttention: true, rtMs: 900 }),
  ];
  const p = buildPayload({ config: { participant_id: "P1", Tier: 1,
    "Num Blocks": 2, "Num Trials": 4, Age: "6", Gamify: true },
    responses, castle, startTime: "2026-01-01 00:00:00", completed: true });

  assert.deepEqual(Object.keys(p).sort(),
                   ["game_state", "participant_data", "responses"]);
  // vice_utils reads these exact names; an almost-right one yields zero
  // usable triplets instead of an error.
  for (const k of ["concept_triplet", "concept_selected", "concept_similar_pair",
                   "is_attention_trial", "response_time_ms"]) {
    assert.ok(k in responses[0], `missing field ${k}`);
  }
  assert.deepEqual(responses[0].concept_similar_pair, ["a", "c"]);
  assert.equal(responses[1].correct, true);      // picked the unique one
  assert.equal(p.participant_data.completion_status, 1);
});

test("the saved schema carries shop state alongside castle when present", () => {
  const castle = CastleState.create(2, POOL, stream("P1", "c"), "P1");
  castle.completeRoom(0);
  const shop = new ShopState();
  shop.buyFurniture("tapestry", ["tapestry_c"], 0, castle.coins_awarded, 0, stream("P1", "shop"));

  const p = buildPayload({ config: { participant_id: "P1", Tier: 1,
    "Num Blocks": 2, "Num Trials": 4, Age: "6", Gamify: true },
    responses: [], castle, shop, startTime: "2026-01-01 00:00:00", completed: true });

  assert.deepEqual(Object.keys(p.game_state).sort(), ["castle", "shop"]);
  assert.deepEqual(p.game_state.shop.owned_furniture, ["tapestry_c"]);

  // Backward compatible: no shop passed -> game_state still has just castle.
  const pNoShop = buildPayload({ config: { participant_id: "P1", Tier: 1,
    "Num Blocks": 2, "Num Trials": 4, Age: "6", Gamify: true },
    responses: [], castle, startTime: "2026-01-01 00:00:00", completed: true });
  assert.deepEqual(Object.keys(pNoShop.game_state), ["castle"]);
});

test("demographics reach the payload under the names Python writes", () => {
  // Both builds feed the same analysis, so a browser session missing a field
  // the desktop writes -- or spelling it differently -- silently produces a
  // column that is empty for half the sample.
  const cfg = {
    participant_id: "P1", Tier: 1, "Num Blocks": 2, "Num Trials": 4,
    Age: "6", Gender: "Female", Handedness: "Right",
    Ethnicity: "Not Hispanic or Latino",
    Race: "Two or more races", Race_Self_Describe: "",
    First_Language: "English", Other_Languages: "Spanish, Cantonese",
  };
  const pd = buildPayload({ config: cfg, responses: [], castle: null,
    startTime: "2026-01-01 00:00:00", completed: true }).participant_data;

  assert.equal(pd.race, "Two or more races");
  assert.equal(pd.first_language, "English");
  assert.equal(pd.other_languages, "Spanish, Cantonese");
  // Kept, and kept distinct: race is not a finer grain of ethnicity.
  assert.equal(pd.ethnicity, "Not Hispanic or Latino");
  // Every demographic key the desktop build writes must exist here too.
  for (const k of ["age", "gender", "handedness", "ethnicity", "race",
                   "race_self_describe", "first_language", "other_languages",
                   "experiment_site", "setting", "vr_exposure",
                   "screen_time"]) {
    assert.ok(k in pd, `participant_data is missing ${k}`);
  }
});

test("a self-description cannot outlive the option that invited it", () => {
  // The box is cleared when the category changes, but a stale value arriving
  // from a config or a restored form must not be saved against a category
  // that contradicts it.
  const pd = buildPayload({
    config: { participant_id: "P1", Tier: 1, "Num Blocks": 1, "Num Trials": 1,
              Race: "White", Race_Self_Describe: "" },
    responses: [], castle: null,
    startTime: "2026-01-01 00:00:00", completed: true }).participant_data;
  assert.equal(pd.race, "White");
  assert.equal(pd.race_self_describe, "",
    "a description was saved against a category that did not ask for one");
});

test("the game's sound effects are wired to the manifest", () => {
  // The browser build never read manifest.sounds, so every session ran silent
  // apart from Tier 2 stimulus audio. These are the five clips the desktop
  // build has always played.
  const played = [];
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1; this.paused = true; }
    play() { played.push(this.src); this.paused = false; return { catch() {} }; }
    pause() { this.paused = true; }
  }
  globalThis.Audio = FakeAudio;

  const sounds = { select: "sounds/select.wav", level_up: "sounds/level_up.wav",
                   sticker: "sounds/sticker.wav", nudge: "sounds/nudge.wav",
                   finish: "sounds/finish.wav" };
  initSfx({ assetRoot: "../assets/game", sounds, muted: false });

  playSfx("select");
  assert.deepEqual(played, ["../assets/game/sounds/select.wav"]);
  playSfx("finish");
  assert.equal(played.length, 2);
  // An unknown key is silent rather than an exception mid-session.
  playSfx("no_such_sound");
  assert.equal(played.length, 2);
});

test("a game sound never plays over a Tier 2 stimulus clip", () => {
  // The A and AV conditions measure an auditory judgment. A reward chime
  // landing across a stimulus contaminates it, so the gate is in playSfx
  // rather than left to each caller to remember.
  const played = [];
  class FakeAudio {
    constructor(src) { this.src = src; }
    play() { played.push(this.src); return { catch() {} }; }
  }
  globalThis.Audio = FakeAudio;

  let stimulusPlaying = true;
  initSfx({ assetRoot: "a", sounds: { select: "s.wav" }, muted: false,
            isStimulusActive: () => stimulusPlaying });

  playSfx("select");
  assert.equal(played.length, 0, "a chime played over a stimulus clip");
  stimulusPlaying = false;
  playSfx("select");
  assert.equal(played.length, 1, "the chime never played once the clip ended");
});

test("quiet mode silences the game, and reduced motion implies it", () => {
  const played = [];
  globalThis.Audio = class { constructor(s) { this.src = s; }
                             play() { played.push(this.src); return { catch() {} }; } };

  initSfx({ assetRoot: "a", sounds: { select: "s.wav" }, muted: true });
  playSfx("select");
  assert.equal(played.length, 0, "quiet mode still made a sound");

  // ?calm=1 implies quiet; an explicit ?quiet=0 overrides that.
  assert.equal(applyUrlOverrides({ ...CONFIG }, "?calm=1").Gamify_Mute_SFX, true);
  assert.equal(applyUrlOverrides({ ...CONFIG }, "?quiet=1").Gamify_Mute_SFX, true);
  assert.equal(applyUrlOverrides({ ...CONFIG }, "?calm=1&quiet=0").Gamify_Mute_SFX,
               false, "an explicit quiet=0 should survive reduced motion");
  assert.equal(applyUrlOverrides({ ...CONFIG }, "").Gamify_Mute_SFX, false);
});

test("cutscene music starts and stops without overlapping itself", () => {
  const state = [];
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1; this.paused = true; }
    play() { this.paused = false; state.push(["play", this.src]); return { catch() {} }; }
    pause() { this.paused = true; state.push(["pause", this.src]); }
  }
  globalThis.Audio = FakeAudio;

  const music = { open: "music/theme.mp3", close: "music/theme.mp3" };
  // fadeMs: 0 isolates the start/stop/switch logic from the ramp itself,
  // which gets its own timed test below.
  initMusic({ assetRoot: "../assets/game", music, muted: false, fadeMs: 0 });

  playMusic("open");
  assert.deepEqual(state, [["play", "../assets/game/music/theme.mp3"]]);

  // Starting the next cue must stop the first, never layer two tracks.
  playMusic("close");
  assert.deepEqual(state.slice(1), [
    ["pause", "../assets/game/music/theme.mp3"],
    ["play", "../assets/game/music/theme.mp3"],
  ]);

  stopMusic();
  assert.equal(state.at(-1)[0], "pause");
  // Idempotent: nothing playing, nothing to pause a second time.
  stopMusic();
  assert.equal(state.length, 4);

  // An unmapped key is silent rather than an exception mid-session.
  playMusic("no_such_cue");
  assert.equal(state.length, 4);
});

test("quiet mode silences cutscene music too", () => {
  const played = [];
  globalThis.Audio = class { constructor(s) { this.src = s; }
                             play() { played.push(this.src); return { catch() {} }; }
                             pause() {} };

  initMusic({ assetRoot: "a", music: { open: "m.mp3" }, muted: true });
  playMusic("open");
  assert.equal(played.length, 0, "quiet mode still started music");
});

await testAsync("cutscene music fades in and out rather than cutting", async () => {
  const created = [];
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1; this.paused = true; created.push(this); }
    play() { this.paused = false; return { catch() {} }; }
    pause() { this.paused = true; }
  }
  globalThis.Audio = FakeAudio;

  const FADE = 120;
  initMusic({ assetRoot: "a", music: { open: "m.mp3" }, muted: false, fadeMs: FADE });

  playMusic("open");
  const el = created.at(-1);
  assert.equal(el.volume, 0, "must start silent, not snap to full volume");

  await sleep(FADE / 2);
  assert.ok(el.volume > 0 && el.volume < 0.35,
    `expected a mid-fade volume, got ${el.volume}`);
  assert.equal(el.paused, false, "must already be audible while fading in");

  await sleep(FADE);
  assert.ok(Math.abs(el.volume - 0.35) < 0.01, `fade-in must settle at target, got ${el.volume}`);

  stopMusic();
  assert.equal(el.paused, false, "must not cut silent the instant stopMusic is called");
  await sleep(FADE / 2);
  assert.ok(el.volume > 0 && el.volume < 0.35,
    `expected a mid-fade-out volume, got ${el.volume}`);
  assert.equal(el.paused, false, "still fading out -- must not be paused yet");

  await sleep(FADE);
  assert.equal(el.paused, true, "must pause once the fade-out reaches silence");
  assert.ok(el.volume < 0.01, `fade-out must settle at zero, got ${el.volume}`);
});

test("a partial session is flagged, not silently pooled", () => {
  const p = buildPayload({ config: { participant_id: "P1", Tier: 1,
    "Num Blocks": 5, "Num Trials": 4 }, responses: [], castle: null,
    startTime: "2026-01-01 00:00:00", completed: false });
  assert.equal(p.participant_data.completion_status, 0);
  assert.equal(p.participant_data.planned_regular_trials, 20);
});

test("postPayload sends the raw payload, with the block index only as a header", () => {
  // Regression: an earlier version wrapped the body as {payload, block},
  // breaking upload_url's contract that the body IS the same JSON a
  // downloaded file would contain -- any external collection endpoint
  // relies on that, not just this build's own per-block bookkeeping.
  let seen = null;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200 };
  };
  try {
    postPayload("http://example.test/collect", { participant_data: { participant_id: "P1" } },
                { block: 2 });
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.equal(JSON.parse(seen.init.body).participant_data.participant_id, "P1");
  assert.equal(seen.init.headers["X-Session-Block"], "2");
});

test("postPayload omits the block header on the final save", () => {
  let seen = null;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
  try {
    postPayload("http://example.test/collect", { participant_data: { participant_id: "P1" } });
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.ok(!("X-Session-Block" in seen.init.headers));
});

// --- Shop / economy: mirrors tests/test_shop_state.py -------------------

const FURNITURE_POOL = [
  { ref: "birdbath", type: "furniture" },
  { ref: "chandelier", type: "furniture" },
  { ref: "aurora", type: "background" },
];

test("shop: can afford is a plain balance >= cost check", () => {
  assert.equal(ShopState.canAfford(10, 10), true);
  assert.equal(ShopState.canAfford(10, 11), false);
  assert.equal(ShopState.canAfford(0, 0), true);
});

test("shop: buying furniture is rejected on insufficient balance", () => {
  const shop = new ShopState();
  assert.equal(shop.buyFurniture("tapestry", ["tapestry_c"], 8, 5, 0, stream("P1", "shop")), null);
  assert.deepEqual(shop.owned_furniture, []);
  assert.deepEqual(shop.purchases, []);
});

test("shop: a furniture purchase draws a random unowned variant of the base", () => {
  const shop = new ShopState();
  const variants = ["tapestry_c", "tapestry_f"];
  const p = shop.buyFurniture("tapestry", variants, 8, 20, 0, stream("P1", "shop"));
  assert.ok(variants.includes(p.won_item_id));
  assert.equal(p.item_id, "tapestry");
  assert.equal(p.won_item_type, "furniture");
  assert.deepEqual(shop.owned_furniture, [p.won_item_id]);
  assert.equal(shop.purchases.length, 1);
});

test("shop: re-buying the same base draws a DIFFERENT variant, not a rejection", () => {
  const shop = new ShopState();
  const variants = ["tapestry_c", "tapestry_f"];
  const rng = stream("P1", "shop");
  const a = shop.buyFurniture("tapestry", variants, 8, 20, 0, rng);
  const b = shop.buyFurniture("tapestry", variants, 8, 20, 1, rng);
  assert.notEqual(a.won_item_id, b.won_item_id);
  assert.deepEqual(new Set(shop.owned_furniture), new Set(variants));
  assert.equal(shop.purchases.length, 2);
});

test("shop: furniture is sold out once every variant of the base is owned", () => {
  const shop = new ShopState();
  const variants = ["tapestry_c"];
  const rng = stream("P1", "shop");
  const p1 = shop.buyFurniture("tapestry", variants, 8, 20, 0, rng);
  assert.ok(p1);
  const p2 = shop.buyFurniture("tapestry", variants, 8, 20, 1, rng);
  assert.equal(p2, null, "the only variant was already owned, so this should be sold out");
  assert.equal(shop.purchases.length, 1);
});

test("shop: buying a background does not auto-equip it", () => {
  const shop = new ShopState();
  assert.equal(shop.buyBackground("starlit", 12, 20, 0), true);
  assert.ok(shop.owned_backgrounds.includes("starlit"));
  assert.deepEqual(shop.background_overrides, {},
    "buying a background must not equip it automatically");
});

test("shop: equipping a background requires ownership and costs nothing", () => {
  const shop = new ShopState();
  assert.equal(shop.equipBackground(0, "starlit"), false,
    "equipped a background that was never bought");
  shop.buyBackground("starlit", 12, 20, 0);
  const spentBefore = shop.totalSpent;
  assert.equal(shop.equipBackground(2, "starlit"), true);
  assert.equal(shop.background_overrides[2], "starlit");
  assert.equal(shop.totalSpent, spentBefore, "equipBackground must not spend");
});

test("shop: moving a background clears where it used to hang", () => {
  const shop = new ShopState();
  shop.buyBackground("starlit", 12, 20, 0);
  shop.equipBackground(2, "starlit");
  shop.equipBackground(5, "starlit");
  assert.equal(shop.background_overrides[5], "starlit");
  assert.ok(!(2 in shop.background_overrides),
    "the old room still claims a background that moved");
  assert.equal(shop.backgroundRoom("starlit"), 5);
});

test("shop: moving a background onto an occupied room SWAPS them", () => {
  const shop = new ShopState();
  shop.buyBackground("starlit", 12, 20, 0);
  shop.buyBackground("aurora", 12, 20, 0);
  shop.equipBackground(2, "starlit");
  shop.equipBackground(5, "aurora");
  shop.equipBackground(5, "starlit");   // starlit displaces aurora out of room 5
  assert.equal(shop.background_overrides[5], "starlit");
  assert.equal(shop.background_overrides[2], "aurora",
    "the displaced background did not swap back into the room starlit left");
});

test("shop: re-equipping a background to its own room is a no-op", () => {
  const shop = new ShopState();
  shop.buyBackground("starlit", 12, 20, 0);
  shop.equipBackground(2, "starlit");
  assert.equal(shop.equipBackground(2, "starlit"), true);
  assert.deepEqual(shop.background_overrides, { 2: "starlit" });
});

test("shop: moving a background onto an empty room clears the old one, no swap", () => {
  const shop = new ShopState();
  shop.buyBackground("starlit", 12, 20, 0);
  shop.equipBackground(2, "starlit");
  shop.equipBackground(5, "starlit");
  assert.deepEqual(shop.background_overrides, { 5: "starlit" },
    "room 2 should have reverted to unassigned, not kept a stale entry");
});

test("shop: mystery box draws from the supplied pool and rng", () => {
  const shop = new ShopState();
  const p = shop.buyMysteryBox("mystery_box", 15, 20, 0, stream("P1", "shop"), FURNITURE_POOL);
  assert.ok(p);
  assert.ok(["birdbath", "chandelier", "aurora"].includes(p.won_item_id));
  if (p.won_item_type === "furniture") {
    assert.ok(shop.owned_furniture.includes(p.won_item_id));
  } else {
    assert.ok(shop.owned_backgrounds.includes(p.won_item_id));
  }
  assert.deepEqual(shop.purchases, [p]);
});

test("shop: mystery box rejects insufficient balance", () => {
  const shop = new ShopState();
  const p = shop.buyMysteryBox("mystery_box", 15, 5, 0, stream("P1", "shop"), FURNITURE_POOL);
  assert.equal(p, null);
  assert.deepEqual(shop.purchases, []);
});

test("shop: mystery box is reproducible from its rng stream", () => {
  const a = new ShopState().buyMysteryBox("mystery_box", 15, 20, 0, stream("P7", "shop"), FURNITURE_POOL);
  const b = new ShopState().buyMysteryBox("mystery_box", 15, 20, 0, stream("P7", "shop"), FURNITURE_POOL);
  assert.equal(a.won_item_id, b.won_item_id);
});

test("shop: applyPurchase replays an already-decided purchase without redrawing", () => {
  // ShopPlugin's trial() already made the real decision live (including any
  // mystery-box rng draw); applyPurchase only replays it into the real
  // ShopState from on_finish -- it must never draw again itself.
  const shop = new ShopState();
  const purchase = { item_type: "mystery_box", item_id: "mystery_box", cost: 15,
                     room_index: 0, won_item_id: "chandelier", won_item_type: "furniture" };
  shop.applyPurchase(purchase);
  assert.ok(shop.owned_furniture.includes("chandelier"));
  assert.equal(shop.purchases.length, 1);
  assert.equal(shop.totalSpent, 15);
});

test("shop: applyPurchase replays a direct furniture purchase by its drawn variant", () => {
  // A direct furniture buy is also a live draw now (see buyFurniture), so
  // applyPurchase must replay it the same way it replays a mystery box's --
  // by won_item_id, never item_id (the base).
  const shop = new ShopState();
  const purchase = { item_type: "furniture", item_id: "tapestry", cost: 24,
                     room_index: 0, won_item_id: "tapestry_c", won_item_type: "furniture" };
  shop.applyPurchase(purchase);
  assert.deepEqual(shop.owned_furniture, ["tapestry_c"]);
  assert.equal(shop.purchases.length, 1);
});

test("shop: mystery box also handles an animal pool entry", () => {
  // Regression: buyMysteryBox and applyPurchase both only branched on
  // furniture/background; an animal-typed win (e.g. {ref:"mossling",
  // type:"animal"}) was silently dropped -- never added to owned_animals.
  const pool = [{ ref: "mossling", type: "animal" }];
  const shop = new ShopState();
  const p = shop.buyMysteryBox("mystery_box", 15, 20, 0, stream("P1", "shop"), pool);
  assert.ok(p);
  assert.equal(p.won_item_id, "mossling");
  assert.equal(p.won_item_type, "animal");
  assert.deepEqual(shop.owned_animals, ["mossling"]);

  const replay = new ShopState();
  replay.applyPurchase(p);
  assert.deepEqual(replay.owned_animals, ["mossling"]);
});

test("shop: buying an invitation draws one not-yet-invited animal", () => {
  const pool = ["glimmerpup", "puffling"];
  const shop = new ShopState();
  const p = shop.buyInvitation("buy_invitation", 20, 30, 0, stream("P1", "shop"), pool);
  assert.ok(p);
  assert.equal(p.item_type, "invitation");
  assert.equal(p.won_item_type, "animal");
  assert.ok(pool.includes(p.won_item_id));
  assert.deepEqual(shop.owned_animals, [p.won_item_id]);
});

test("shop: invitation rejects insufficient balance", () => {
  const shop = new ShopState();
  const p = shop.buyInvitation("buy_invitation", 20, 5, 0, stream("P1", "shop"), ["glimmerpup"]);
  assert.equal(p, null);
  assert.deepEqual(shop.owned_animals, []);
});

test("shop: invitation is a no-op once every animal is already owned", () => {
  const shop = new ShopState({ ownedAnimals: ["glimmerpup"] });
  const p = shop.buyInvitation("buy_invitation", 20, 30, 0, stream("P1", "shop"), ["glimmerpup"]);
  assert.equal(p, null, "drew from a fully-owned pool instead of refusing");
  assert.deepEqual(shop.owned_animals, ["glimmerpup"]);
});

test("shop: invitation is reproducible from its rng stream", () => {
  const pool = ["glimmerpup", "puffling", "driftling"];
  const a = new ShopState().buyInvitation("buy_invitation", 20, 30, 0, stream("P9", "shop"), pool);
  const b = new ShopState().buyInvitation("buy_invitation", 20, 30, 0, stream("P9", "shop"), pool);
  assert.equal(a.won_item_id, b.won_item_id);
});

test("shop: total spent sums every purchase", () => {
  const shop = new ShopState();
  shop.buyFurniture("tapestry", ["tapestry_c"], 8, 100, 0, stream("P1", "shop"));
  shop.buyBackground("starlit", 12, 100, 0);
  shop.buyMysteryBox("mystery_box", 15, 100, 1, stream("P1", "shop"), FURNITURE_POOL);
  assert.equal(shop.totalSpent, 8 + 12 + 15);
});

test("shop: toJSON matches the field names the Python analysis reads", () => {
  // No fromJSON exists here, same as CastleState -- the browser build never
  // reloads a save mid-session (session-only by design). What must hold is
  // that toJSON's shape survives a JSON round-trip byte-for-byte and uses
  // the same snake_case field names as shop_state.py's to_dict(), since
  // that's the file both builds' saved data actually has to agree on.
  const shop = new ShopState();
  // Only one variant offered, so the draw is deterministic regardless of rng.
  shop.buyFurniture("tapestry", ["tapestry_c"], 8, 100, 0, stream("P1", "shop"));
  shop.buyBackground("starlit", 12, 100, 0);
  shop.equipBackground(2, "starlit");
  shop.buyMysteryBox("mystery_box", 15, 100, 1, stream("P1", "shop"), FURNITURE_POOL);

  const json = JSON.parse(JSON.stringify(shop.toJSON()));
  assert.deepEqual(Object.keys(json).sort(), ["background_overrides",
    "owned_animals", "owned_backgrounds", "owned_furniture", "purchases", "schema_version", "shop_ms"]);
  // "birdbath" is the mystery box's deterministic draw from FURNITURE_POOL
  // under its own stream("P1", "shop") instance -- not a second manual
  // purchase, and unaffected by the furniture purchase's own draw above
  // (a separate stream("P1", "shop") instance, same seed, independent cursor).
  assert.deepEqual(json.owned_furniture, ["tapestry_c", "birdbath"]);
  assert.deepEqual(json.owned_backgrounds, ["starlit"]);
  assert.deepEqual(json.background_overrides, { 2: "starlit" });
  assert.equal(json.purchases.length, 3);
  assert.equal(json.purchases.reduce((a, p) => a + p.cost, 0), shop.totalSpent);
});


// ---------------------------------------------------------------------------
// The mansion, the arcade, and the numbers both builds have to agree on.
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readPy = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/** True where the desktop sources are checked out beside this build.
 *
 * The public deploy repo (kefoto/chs-ooo) is js/ + assets/ + datasets/ + api/
 * and no Python at all, by design -- the lab build and the analysis pipeline
 * live in the private repo. The two parity tests below read
 * experiments/*.py to compare constants across the builds, which is exactly
 * the check that CANNOT run there. Skipping is right; throwing ENOENT and
 * failing the suite, as they used to, only trains people to ignore a red
 * suite on the deploy repo. */
const HAS_DESKTOP_SOURCES = fs.existsSync(path.join(REPO, "experiments"));
const testWithPython = (name, fn) => {
  if (!HAS_DESKTOP_SOURCES) {
    console.log(`  SKIP  ${name} (no experiments/ here -- deploy repo)`);
    return;
  }
  test(name, fn);
};

/** One `NAME = <number>` from a Python module. */
const pyConst = (src, name) => {
  const m = src.match(new RegExp(`^${name}\\s*=\\s*([0-9_.]+)`, "m"));
  assert.ok(m, `${name} not found in the Python source`);
  return Number(m[1].replace(/_/g, ""));
};

/** One `NAME = (a, b)` / `[a, b]` tuple of numbers. */
const pyTuple = (src, name) => {
  const m = src.match(new RegExp(`^\\s*${name}\\s*=\\s*[([]([^)\\]]*)[)\\]]`, "m"));
  assert.ok(m, `${name} not found in the Python source`);
  return m[1].split(",").map((v) => Number(v.trim())).filter((v) => !Number.isNaN(v));
};

testWithPython("mansion: the two builds agree on the room layout and the payout", () => {
  // A difference here is not a bug that throws -- it is two studies. The
  // desktop file is the authority; this asserts the port still matches it.
  const py = readPy("experiments/castle_state.py");
  assert.equal(MANSION_ROOM_COUNT, pyConst(py, "MANSION_ROOM_COUNT"));
  assert.equal(MINIGAME_POINTS_PER_COIN, pyConst(py, "MINIGAME_POINTS_PER_COIN"));
  assert.equal(MINIGAME_COINS_PER_ROUND_MAX, pyConst(py, "MINIGAME_COINS_PER_ROUND_MAX"));
  assert.equal(MINIGAME_COIN_CAP, pyConst(py, "MINIGAME_COIN_CAP"));
  // UNLOCK_STEP_PCT is written as an expression (90.0 / 8.0), so compare the
  // value rather than parsing arithmetic.
  assert.ok(Math.abs(UNLOCK_STEP_PCT - 90 / 8) < 1e-9);

  // Which room holds which game, straight out of the Python dict.
  const block = py.slice(py.indexOf("ARCADE_ROOMS = {"));
  const pyRooms = {};
  for (const [, i, key] of block.slice(0, block.indexOf("}"))
      .matchAll(/(\d+)\s*:\s*"([a-z_]+)"/g)) {
    pyRooms[Number(i)] = key;
  }
  assert.deepEqual(ARCADE_ROOMS, pyRooms);
  // ...and every one of them is a game this build actually has.
  for (const key of Object.values(ARCADE_ROOMS)) {
    assert.ok(GAMES[key], `no browser port of ${key}`);
  }
});

testWithPython("mini-games: the two builds agree on the round and the tuning", () => {
  const py = readPy("experiments/minigames.py");
  assert.equal(ROUND_MS, pyConst(py, "ROUND_MS"));
  assert.equal(RAMP_END, pyConst(py, "RAMP_END"));

  // The numbers that decide how hard each game is. Same difficulty curve is
  // what lets a score -- and the coins it pays -- mean the same thing in both
  // builds; drifting apart here would be invisible in the data.
  const cls = (name) => py.slice(py.indexOf(`class ${name}(`));
  const constOf = (name, field) => {
    const src = cls(name);
    const m = src.match(new RegExp(`^\\s+${field}\\s*=\\s*([0-9_.]+)`, "m"));
    assert.ok(m, `${name}.${field} not found`);
    return Number(m[1].replace(/_/g, ""));
  };
  const tupleOf = (name, field) => pyTuple(cls(name), field);

  assert.equal(GAMES.firefly_catch.CATCH_THRESHOLD, constOf("FireflyCatch", "CATCH_THRESHOLD"));
  assert.equal(GAMES.firefly_catch.PEAK_THRESHOLD, constOf("FireflyCatch", "PEAK_THRESHOLD"));
  assert.equal(GAMES.firefly_catch.PEAK_POINTS, constOf("FireflyCatch", "PEAK_POINTS"));
  assert.equal(GAMES.firefly_catch.LIFESPAN_MS, constOf("FireflyCatch", "LIFESPAN_MS"));
  assert.equal(GAMES.firefly_catch.FADE_MS, constOf("FireflyCatch", "FADE_MS"));
  assert.deepEqual(GAMES.firefly_catch.PULSE_MS, tupleOf("FireflyCatch", "PULSE_MS"));
  assert.equal(GAMES.kite_flyer.RIBBON_BONUS, constOf("KiteFlyer", "RIBBON_BONUS"));
  assert.equal(GAMES.kite_flyer.CATCH_REL, constOf("KiteFlyer", "CATCH_REL"));
  assert.equal(GAMES.kite_flyer.FOLLOW_PER_S, constOf("KiteFlyer", "FOLLOW_PER_S"));
  assert.deepEqual(GAMES.kite_flyer.RIBBON_LENGTH, tupleOf("KiteFlyer", "RIBBON_LENGTH"));
  assert.equal(GAMES.star_catcher.CATCH_BAND_REL, constOf("StarCatcher", "CATCH_BAND_REL"));
  assert.equal(GAMES.star_catcher.BASKET_REL_W, constOf("StarCatcher", "BASKET_REL_W"));
  assert.deepEqual(GAMES.star_catcher.FALL_REL_PER_S, tupleOf("StarCatcher", "FALL_REL_PER_S"));
  assert.deepEqual(GAMES.bubble_pop.BUBBLE_REL, tupleOf("BubblePop", "BUBBLE_REL"));
  assert.equal(GAMES.bubble_pop.MAX_ACTIVE, constOf("BubblePop", "MAX_ACTIVE"));
});

test("mansion: rooms open on block progress and nothing else", () => {
  const st = new CastleState({ participantId: "P1" });
  assert.equal(st.mansion.length, MANSION_ROOM_COUNT);
  // Room 0 is the only one open at the start -- there has to be somewhere to
  // decorate from the very first break.
  assert.deepEqual(st.unlockedRooms().map((r) => r.index), [0]);

  const opened = [];
  for (let b = 1; b <= 4; b++) opened.push(st.unlockForProgress(b, 4));
  assert.deepEqual(opened, [[1, 2], [3, 4], [5, 6], [7, 8]]);
  // Idempotent: asking again opens nothing new.
  assert.deepEqual(st.unlockForProgress(4, 4), []);
  assert.equal(st.unlockedRooms().length, MANSION_ROOM_COUNT);

  // Structurally incapable of seeing a response -- a block COUNT and a total.
  const params = CastleState.prototype.unlockForProgress.toString()
    .match(/unlockForProgress\(([^)]*)\)/)[1];
  assert.deepEqual(params.split(",").map((p) => p.trim()),
                   ["blocksCompleted", "numBlocks"]);
});

test("mansion: the pocket is shared across rooms", () => {
  const st = new CastleState({ participantId: "P1" });
  st.awarded.push("star", "fairy", "boat");
  assert.deepEqual(st.unplacedStickers(), ["star", "fairy", "boat"]);

  // Any earned sticker can go in any room, and placing it anywhere takes it
  // out of the pocket.
  st.place("fairy", 4, 0.5, 0.5);
  assert.deepEqual(st.unplacedStickers(), ["star", "boat"]);
  assert.deepEqual(st.placedInRoom(4).map((p) => p.sticker_id), ["fairy"]);

  // Moving it to another room is a lift and a drop, not a copy.
  st.unplace("fairy");
  st.place("fairy", 7, 0.2, 0.3);
  assert.deepEqual(st.placedInRoom(4), []);
  assert.deepEqual(st.placedInRoom(7).map((p) => p.sticker_id), ["fairy"]);
  assert.deepEqual(st.unplacedStickers(), ["star", "boat"]);
});

test("arcade: a round pays, capped, and never touches coins_awarded", () => {
  const st = new CastleState({ participantId: "P1" });
  st.coin_allocation = [1, 1, 1];

  // 15 points a coin, two a round at most.
  assert.deepEqual([0, 14, 15, 29, 30, 90].map((s) => st.minigamePayout(s)),
                   [0, 0, 1, 1, 2, 2]);

  let paid = 0;
  for (let i = 0; i < 10; i++) paid += st.recordMinigame("star_catcher", 2, 45, 20000);
  assert.equal(paid, MINIGAME_COIN_CAP, "the session cap did not hold");
  assert.equal(st.minigame_coins, MINIGAME_COIN_CAP);
  assert.equal(st.recordMinigame("bubble_pop", 5, 90, 20000), 0, "paid past the cap");
  // The pre-drawn schedule is untouched by any of it: coins_awarded stays
  // reproducible from the participant id alone.
  assert.equal(st.coins_awarded, 0);
  assert.equal(st.minigame_plays.length, 11);
  assert.deepEqual(Object.keys(st.minigame_plays[0]).sort(),
                   ["coins", "duration_ms", "game", "room_index", "score"]);

  // Response-blind by signature, like awardTrialCoins and completeRoom.
  const params = CastleState.prototype.recordMinigame.toString()
    .match(/recordMinigame\(([^)]*)\)/)[1];
  assert.deepEqual(params.split(",").map((p) => p.trim()),
                   ["game", "roomIndex", "score", "durationMs"]);
});

test("mansion: the saved state carries the whole visit", () => {
  const st = new CastleState({ participantId: "P1" });
  st.awarded.push("star");
  st.place("star", 1, 0.4, 0.4);
  st.recordMinigame("kite_flyer", 6, 31, 20000);
  st.addMinigameTime(20000);
  st.addPlaygroundTime(45000);

  const json = JSON.parse(JSON.stringify(st.toJSON()));
  assert.equal(json.schema_version, 10);
  assert.equal(json.mansion.length, MANSION_ROOM_COUNT);
  assert.deepEqual(json.mansion[2], { index: 2, unlocked: false, kind: "arcade" });
  assert.equal(json.minigame_plays.length, 1);
  assert.equal(json.minigame_coins, 2);
  assert.equal(json.minigame_ms, 20000);
  // minigame_ms is a SUBSET of playground_ms (the mansion clock keeps running
  // inside a game room), so it must never exceed it.
  assert.ok(json.minigame_ms <= json.playground_ms);
});

test("the public copy ships a redistributable font", () => {
  // The lab build's display faces are licensed and cannot be redistributed,
  // so the deploy repo omits assets/game/font/ and points @font-face at
  // Nunito (SIL OFL) in js/vendor/font/ instead.
  //
  // Every sync from the private repo overwrites game.css and puts the
  // licensed face back -- it has happened twice. This test is the check that
  // survives the sync, because it lives in the file the sync also copies.
  // In the private repo, where the fonts legitimately exist, it passes
  // trivially; in the deploy repo, where they do not, it fails loudly.
  const css = fs.readFileSync(path.join(REPO, "js/css/game.css"), "utf8");
  const licensedFontsPresent = fs.existsSync(path.join(REPO, "assets/game/font"));
  if (licensedFontsPresent) return;              // the private repo: nothing to police
  assert.ok(!/url\([^)]*assets\/game\/font/.test(css),
    "game.css points at assets/game/font/, which is not in this checkout and "
    + "must never be redistributed -- restore the js/vendor/font Nunito @font-face");
  assert.ok(/vendor\/font\//.test(css),
    "no @font-face pointing at js/vendor/font/ -- the page will fall back to a "
    + "system face with no warning");
});

test("sounds: every clip the manifest names exists on disk", () => {
  // A manifest entry pointing at a file that is not there fails the way a
  // missing sound always fails -- silently. `pickup` named a pickup.wav that
  // was never recorded, and `sticker` listed two variants that were never
  // recorded either, so lifting an item made no sound on either build and
  // placing one was silent whenever the random draw picked a missing variant.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, "assets/game/manifest.json"), "utf8"));
  const missing = [];
  for (const [key, value] of Object.entries(manifest.sounds ?? {})) {
    if (key.startsWith("_")) continue;         // doc keys, not clips
    for (const rel of Array.isArray(value) ? value : [value]) {
      if (!fs.existsSync(path.join(REPO, "assets/game", rel))) {
        missing.push(`${key} -> ${rel}`);
      }
    }
  }
  assert.deepEqual(missing, [], `manifest.sounds names files that do not exist`);
});

test("audio: every music/voice file has a web-sized copy", () => {
  // The counterpart of the image check below. The source audio is authored
  // for the desktop (24-bit 48kHz PCM, because its QSoundEffect fallback
  // decodes nothing else) and one music track is ~23MB of it -- shipping
  // that to a family's tablet is what utilities/build_web_audio.py exists to
  // avoid. A missing derivative is not fatal at runtime (assets.js falls
  // back to the WAV), which is exactly why it needs a test: it would ship.
  const index = JSON.parse(
    fs.readFileSync(path.join(REPO, "assets/game/web/assets.json"), "utf8"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, "assets/game/manifest.json"), "utf8"));

  const wanted = [];
  for (const [key, value] of Object.entries(manifest.music ?? {})) {
    if (key.startsWith("_")) continue;
    for (const rel of Array.isArray(value) ? value : [value]) {
      // `music` also carries scalars like fade_ms -- only actual paths under
      // the music/ tree are things to encode. Same filter build_web_audio.py
      // applies through kind_of().
      if (typeof rel === "string" && rel.startsWith("music/")) wanted.push(rel);
    }
  }
  const voiceDir = path.join(REPO, "assets/game/voice");
  if (fs.existsSync(voiceDir)) {
    for (const name of fs.readdirSync(voiceDir)) {
      if (name.endsWith(".wav")) wanted.push(`voice/${name}`);
    }
  }

  const missing = wanted.filter((rel) => {
    const file = index.entries?.[rel]?.files?.audio;
    return !file || !fs.existsSync(path.join(REPO, "assets/game/web", file.path));
  });
  assert.deepEqual(missing, [],
    "run: python utilities/build_web_audio.py");
});

test("stickers: which picture is drawn fresh each session, but replayable", () => {
  // Tying the identity to the participant id meant a child who played twice
  // collected the same set again, and an experimenter testing under one id
  // never saw anything else. The SHAPE of the schedule -- the part the
  // response-blindness audit rests on -- must not move with it.
  const runs = Array.from({ length: 4 }, () =>
    CastleState.create(5, POOL, makeRng(42), "P1", [], 15, [3, 3, 3, 3, 3]));
  const drawn = new Set(runs.map((st) => st.rooms.flatMap((r) => r.sticker_ids).join(",")));
  assert.ok(drawn.size > 1, "same participant id replayed identical stickers");
  assert.equal(new Set(runs.map((st) => st.allocation.join(","))).size, 1,
    "the room shape moved with the sticker draw; it must stay pid-derived");

  const { sticker_seed: seed } = runs[0];
  assert.ok(Number.isFinite(seed));
  assert.equal(JSON.parse(JSON.stringify(runs[0].toJSON())).sticker_seed, seed,
    "the seed must be saved, or the session stops being reconstructable");
  const replay = CastleState.create(5, POOL, makeRng(42), "P1", [], 15,
                                    [3, 3, 3, 3, 3], seed);
  assert.deepEqual(replay.rooms.map((r) => r.sticker_ids),
                   runs[0].rooms.map((r) => r.sticker_ids));
});

test("guests: an invited animal lands in an unlocked DECORATION room", () => {
  const st = new CastleState({ participantId: "P1" });
  st.unlockForProgress(9, 9);            // open the whole mansion
  const decorate = new Set(st.guestRooms());
  // Every arcade room is excluded: a game room has no canvas to stand in, so
  // a guest sent to one would simply vanish until it moved again.
  for (const idx of Object.keys(ARCADE_ROOMS)) {
    assert.ok(!decorate.has(Number(idx)));
  }
  const guest = st.inviteGuest("cat", makeRng(7));
  assert.ok(guest);
  assert.ok(decorate.has(guest.room_index));
  // Off the edges and low in the frame -- standing on the floor, not
  // floating on the wall. Mirrors castle_state._guest_spot's ranges.
  assert.ok(guest.x >= 0.15 && guest.x <= 0.85);
  assert.ok(guest.y >= 0.55 && guest.y <= 0.80);
  assert.deepEqual(st.guestsInRoom(guest.room_index).map((g) => g.animal_id), ["cat"]);
  // An invitation buys an animal that is NOT here yet.
  assert.equal(st.inviteGuest("cat", makeRng(8)), null);
});

test("guests: nowhere to stand means no guest, not a crash", () => {
  const st = new CastleState({ participantId: "P1" });
  // Room 0 only -- and it is a decoration room, so this is really a check
  // that an unopened mansion cannot take a guest at all.
  const shut = new CastleState({ participantId: "P2" });
  shut.mansion.forEach((r) => { r.unlocked = false; });
  assert.equal(shut.guestRooms().length, 0);
  assert.equal(shut.inviteGuest("cat", makeRng(1)), null);
  assert.deepEqual(shut.moveGuests(makeRng(1)), []);
  assert.equal(st.inviteGuest("", makeRng(1)), null);
});

test("guests: every guest moves house on a block boundary", () => {
  const st = new CastleState({ participantId: "P1" });
  st.unlockForProgress(9, 9);
  st.inviteGuest("cat", makeRng(3));
  st.inviteGuest("owl", makeRng(4));
  const before = st.guests.map((g) => g.room_index);
  st.moveGuests(makeRng(11));
  // With more than one decoration room open, a guest prefers a room it is
  // not already in -- so every one of them actually moves.
  st.guests.forEach((g, i) => assert.notEqual(g.room_index, before[i]));
  // Reproducible from the stream alone, like every other schedule here.
  const other = new CastleState({ participantId: "P1" });
  other.unlockForProgress(9, 9);
  other.inviteGuest("cat", makeRng(3));
  other.inviteGuest("owl", makeRng(4));
  other.moveGuests(makeRng(11));
  assert.deepEqual(other.guests, st.guests);
});

test("guests: a single open room keeps the guest but re-spots it", () => {
  const st = new CastleState({ participantId: "P1" });
  // Room 0 alone is open at the start of a session.
  assert.deepEqual(st.guestRooms(), [0]);
  const guest = st.inviteGuest("cat", makeRng(5));
  assert.equal(guest.room_index, 0);
  const spot = [guest.x, guest.y];
  const moved = st.moveGuests(makeRng(6));
  assert.deepEqual(moved, []);             // nowhere else to go
  assert.equal(st.guests[0].room_index, 0);
  assert.notDeepEqual([st.guests[0].x, st.guests[0].y], spot);
});

test("guests: they are saved, and are not placements", () => {
  const st = new CastleState({ participantId: "P1" });
  st.unlockForProgress(9, 9);
  st.awarded.push("star");
  st.place("star", 1, 0.4, 0.4);
  st.inviteGuest("cat", makeRng(3));
  const json = JSON.parse(JSON.stringify(st.toJSON()));
  assert.equal(json.guests.length, 1);
  assert.deepEqual(Object.keys(json.guests[0]).sort(),
                   ["animal_id", "room_index", "x", "y"]);
  // The child's own placement list is untouched by an arriving guest -- the
  // whole reason the two live in separate lists.
  assert.equal(json.placements.length, 1);
  assert.equal(json.placements[0].sticker_id, "star");
});

test("mini-games: every game scores, ends at ROUND_MS, and calms down", () => {
  // Driven through tick() rather than the frame loop, the same way
  // tests/test_minigames.py drives the desktop ones -- no waiting on 20
  // seconds of wall clock, and no canvas needed.
  const play = (key, reducedMotion) => {
    const finished = [];
    const g = buildGame(key, { theme: {}, reducedMotion,
                               onFinish: (...a) => finished.push(a) });
    g.start();
    for (let f = 0; f * 16 < ROUND_MS + 32; f++) {
      // A perfect player: chase whatever is on screen.
      if (key === "star_catcher" && g._stars.length) {
        g._basketX = g._stars.reduce((a, b) => (a.y > b.y ? a : b)).x;
      }
      if (key === "kite_flyer" && g._sparkles.length) {
        g._aimX = g._sparkles[0].x;
        g._aimY = g._sparkles[0].y;
      }
      g.tick(16);
      if (key === "bubble_pop") {
        for (const b of [...g._bubbles]) g.onPointer({ x: b.x, y: b.y }, true);
      }
      if (key === "firefly_catch") {
        for (const fly of [...g._flies]) g.onPointer({ x: fly.x, y: fly.y }, true);
      }
    }
    return { score: g.score, finished, running: g.running };
  };

  for (const key of Object.keys(GAMES)) {
    const r = play(key, false);
    assert.ok(r.score > 0, `${key} scored nothing for a perfect player`);
    assert.equal(r.finished.length, 1, `${key} finished ${r.finished.length} times`);
    assert.deepEqual(r.finished[0], [key, r.score, ROUND_MS]);
    assert.equal(r.running, false, `${key} left its loop running`);

    // Reduced stimulation slows the world and halves the spawn rate, so the
    // same player meets fewer things. Less to catch, never nothing to catch.
    const calm = play(key, true);
    assert.ok(calm.score > 0, `${key} is unplayable under reduced motion`);
    assert.ok(calm.score < r.score,
              `${key} spawned as much under reduced motion (${calm.score} vs ${r.score})`);
  }
});

test("mini-games: doing it well pays more, doing it badly costs nothing", () => {
  // The firefly's peak band, which is the only skill that game has to offer.
  const f = buildGame("firefly_catch", { theme: {} });
  const points = [];
  f.onScore = (n) => points.push(n);
  f.start();
  const tapAt = (age) => {
    f._flies = [f.newFly({ x: 0.5, y: 0.5, pulse_ms: 1000, age_ms: age })];
    f.onPointer({ x: 0.5, y: 0.5 }, true);
    return f._flies.length;             // 0 = caught
  };
  assert.equal(tapAt(500), 0, "a peak tap did not catch");
  assert.equal(tapAt(350), 0, "a bright tap did not catch");
  // A mistimed tap catches nothing AND takes nothing: the firefly stays, its
  // pulse untouched, and only darts away.
  assert.equal(tapAt(80), 1, "a dim tap removed the firefly");
  assert.ok(f._flies[0].dart_ms > 0, "a mistimed tap did nothing visible");
  assert.deepEqual(points, [2, 1]);

  // The kite's ribbon: sweeping a whole one pays its bonus, and one already
  // broken by an escape pays the ordinary point rather than a penalty.
  const k = buildGame("kite_flyer", { theme: {} });
  const kPoints = [];
  k.onScore = (n) => kPoints.push(n);
  k.start();
  // Park the spawner: a ribbon spawned during this tick would take the next
  // id, which is the one being injected here, and quietly overwrite its count.
  k._nextSpawnMs = 1e6;
  k._nextRibbon = 40;
  k._sparkles = [{ x: 0.5, y: 0.5, v: 0, wob_t: 0, ribbon: 41 },
                 { x: 0.52, y: 0.5, v: 0, wob_t: 0, ribbon: 41 }];
  k._ribbons.set(41, 2);
  k._kiteX = 0.5; k._kiteY = 0.5; k._aimX = 0.5; k._aimY = 0.5;
  k.tick(16);
  assert.deepEqual(kPoints, [1, 1 + GAMES.kite_flyer.RIBBON_BONUS]);
});

test("assets: every image the manifest names has a web-sized copy", () => {
  const indexPath = path.join(REPO, "assets/game/web/assets.json");
  if (!fs.existsSync(indexPath)) {
    // The derivatives are optional by design -- assets.js falls back to the
    // PNG -- so their absence is not a failure, only a missed optimisation.
    console.log("        (no assets/game/web yet; run utilities/build_web_assets.py)");
    return;
  }
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "assets/game/manifest.json"), "utf8"));

  const named = new Set();
  for (const section of ["stickers", "furniture", "backgrounds", "animals"]) {
    for (const item of manifest[section]?.pool ?? []) if (item.image) named.add(item.image);
  }
  for (const rel of manifest.rooms?.progression ?? []) named.add(rel);
  for (const [pose, rel] of Object.entries(manifest.mascot_variants?.neutral ?? {})) {
    if (pose !== "name") named.add(rel);
  }

  const missing = [...named].filter((rel) =>
    fs.existsSync(path.join(REPO, "assets/game", rel)) && !index.entries[rel]);
  assert.deepEqual(missing, [], "images with no web copy -- re-run build_web_assets.py");

  // Every room backdrop needs a THUMB, because the mansion grid draws nine at
  // once and full-size art there is the whole problem this solves.
  for (const rel of manifest.rooms?.progression ?? []) {
    const entry = index.entries[rel];
    if (entry) assert.ok(entry.files.thumb, `${rel} has no mansion thumbnail`);
  }
});

console.log(`\n${pass} passed`);

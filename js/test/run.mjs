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
         COIN_VALUES, COIN_WEIGHTS,
       } from "../src/castle.js";
import { ShopState } from "../src/shop.js";
import { buildPayload, makeResponse } from "../src/save.js";
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

test("?media= repoints the stimuli at another origin", () => {
  // CHS requires stimuli to be hosted online; if they are not served from the
  // same place as the page, every root has to move together.
  const cfg = applyUrlOverrides({ ...CONFIG }, "?media=https://cdn.example.org/");
  assert.equal(cfg.asset_root, "https://cdn.example.org/assets/game");
  assert.equal(cfg.dataset_root,
    "https://cdn.example.org/datasets/Tier1_THINGS_100");
  assert.equal(cfg.tier2_dataset_root,
    "https://cdn.example.org/datasets/Tier2_AV_Matched");
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
  shop.buyFurniture("tapestry", 0, castle.coins_awarded, 0);

  const p = buildPayload({ config: { participant_id: "P1", Tier: 1,
    "Num Blocks": 2, "Num Trials": 4, Age: "6", Gamify: true },
    responses: [], castle, shop, startTime: "2026-01-01 00:00:00", completed: true });

  assert.deepEqual(Object.keys(p.game_state).sort(), ["castle", "shop"]);
  assert.deepEqual(p.game_state.shop.owned_furniture, ["tapestry"]);

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
  assert.equal(shop.buyFurniture("tapestry", 8, 5, 0), false);
  assert.deepEqual(shop.owned_furniture, []);
  assert.deepEqual(shop.purchases, []);
});

test("shop: furniture cannot be re-bought once owned", () => {
  const shop = new ShopState();
  assert.equal(shop.buyFurniture("tapestry", 8, 20, 0), true);
  assert.equal(shop.buyFurniture("tapestry", 8, 20, 1), false,
    "re-bought an already-owned furniture item");
  assert.deepEqual(shop.owned_furniture, ["tapestry"]);
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

test("shop: total spent sums every purchase", () => {
  const shop = new ShopState();
  shop.buyFurniture("tapestry", 8, 100, 0);
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
  shop.buyFurniture("tapestry", 8, 100, 0);
  shop.buyBackground("starlit", 12, 100, 0);
  shop.equipBackground(2, "starlit");
  shop.buyMysteryBox("mystery_box", 15, 100, 1, stream("P1", "shop"), FURNITURE_POOL);

  const json = JSON.parse(JSON.stringify(shop.toJSON()));
  assert.deepEqual(Object.keys(json).sort(), ["background_overrides",
    "owned_backgrounds", "owned_furniture", "purchases", "schema_version", "shop_ms"]);
  assert.deepEqual(json.owned_furniture, ["tapestry"]);
  assert.deepEqual(json.owned_backgrounds, ["starlit"]);
  assert.deepEqual(json.background_overrides, { 2: "starlit" });
  assert.equal(json.purchases.length, 3);
  assert.equal(json.purchases.reduce((a, p) => a + p.cost, 0), shop.totalSpent);
});

console.log(`\n${pass} passed`);

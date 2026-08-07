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
import { CastleState, allocate, MIN_PER_ROOM, MAX_PER_ROOM } from "../src/castle.js";
import { buildPayload, makeResponse } from "../src/save.js";
import { sessionPlan, ageBin, FIXED_TRIALS_PER_SESSION } from "../src/session.js";
import { CONFIG, applyUrlOverrides } from "../src/config.js";
import { setupNeeded } from "../src/setup.js";

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

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
  const st = CastleState.create(3, POOL, stream("P1", "c"), "P1");
  const first = st.completeRoom(0);
  assert.deepEqual(st.completeRoom(0), first, "second call differed");
  assert.equal(st.awarded.length, first.length, "double award");
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

test("a partial session is flagged, not silently pooled", () => {
  const p = buildPayload({ config: { participant_id: "P1", Tier: 1,
    "Num Blocks": 5, "Num Trials": 4 }, responses: [], castle: null,
    startTime: "2026-01-01 00:00:00", completed: false });
  assert.equal(p.participant_data.completion_status, 0);
  assert.equal(p.participant_data.planned_regular_trials, 20);
});

console.log(`\n${pass} passed`);

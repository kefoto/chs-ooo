/**
 * Tier 2: matched-concept triplets under blocked V / A / AV conditions.
 * Port of _init_tier2 and _build_trial_list_tier2 in
 * experiments/two_tier_experiment.py.
 *
 * Tier 2 exists to measure SUPRADDITIVITY: whether seeing-and-hearing an item
 * constrains similarity more than seeing plus hearing it separately. Two
 * design properties carry that measurement, and both live in this file:
 *
 *   1. Conditions are BLOCKED and Latin-square counterbalanced, so modality
 *      is not confounded with time-on-task or fatigue.
 *   2. In "shared" mode the SAME triplet list is presented in every block, so
 *      AV vs (V + A) is a within-item contrast. This is the default, and it
 *      is what makes the supradditivity test well defined at item level.
 */

/** Six orderings of [V, A, AV]: each condition appears in each position. */
export const LATIN_SQUARE_ORDERS = [
  ["V", "A", "AV"],
  ["V", "AV", "A"],
  ["A", "V", "AV"],
  ["A", "AV", "V"],
  ["AV", "V", "A"],
  ["AV", "A", "V"],
];

/** Non-gamified wording, one pair per condition. Mirrors CONDITION_INSTRUCTIONS. */
export const CONDITION_INSTRUCTIONS = {
  V: ["Now you will <b>SEE images</b>",
      "Pick the image that is most different from the other two"],
  A: ["Now you will <b>HEAR sounds</b>",
      "Pick the sound that is most different from the other two"],
  AV: ["Now you will <b>SEE and HEAR</b>",
       "Pick the item that is most different from the other two"],
};

/** Dialogue keys for the gamified framing of each condition. */
export const CONDITION_DIALOGUE = {
  V: { prompt: "trial_prompt_visual", intro: "room_intro_visual" },
  A: { prompt: "trial_prompt_audio", intro: "room_intro_audio" },
  AV: { prompt: "trial_prompt_av", intro: "room_intro_av" },
};

/**
 * Which Latin square a participant gets.
 *
 * Drawn from a dedicated mulberry32 stream, NOT from `hashSeed(pid) % 6`.
 * FNV-1a's low bits are poorly mixed for short, near-sequential ids (P1, P2,
 * 0001, 0002 -- what a facility actually assigns), and taking that modulo 6
 * measurably skews the allocation: over 264 realistic ids it put 52 on one
 * order and 35 on another, and over 200 ids it never produced one of the six
 * orders at all. That is a silently uncounterbalanced design. A test in
 * test/run.mjs holds this: it asserts all six orders appear and requires the
 * spread, so a future "simplification" back to a raw modulo fails loudly.
 *
 * The PyQt build indexes with md5(pid), so a given id does NOT land on the
 * same order in both builds. Never pool a browser session with a desktop
 * session of the same id and assume matched block order -- check
 * `participant_data.platform`, and `game_state.castle.rooms[*].condition`,
 * which records the order actually run.
 */
export function latinSquareIndex(rng) {
  return rng.int(0, LATIN_SQUARE_ORDERS.length - 1);
}

export function blockConditions(nBlocks, orderIndex) {
  const base = LATIN_SQUARE_ORDERS[orderIndex % LATIN_SQUARE_ORDERS.length];
  return Array.from({ length: nBlocks }, (_, i) => base[i % 3]);
}

/**
 * The Tier 2 trial list: blocks in condition order, each block its own
 * regular trials plus its own attention checks, shuffled WITHIN the block.
 *
 * The shuffle is deliberately within-block and never across: shuffling
 * globally would interleave conditions and destroy the blocking the
 * Latin square is there to counterbalance.
 *
 * `mode`:
 *   "shared"   -- every block presents the same `perBlock` triplets (yoked).
 *                 Required for the item-level AV vs (V + A) contrast.
 *   "disjoint" -- each block gets its own triplets. No cross-condition
 *                 carryover, but supports group-level comparison only.
 */
export function buildTrialListTier2({
  concepts, conditions, perBlock, regularTriplets, mode = "shared", orderRng,
}) {
  const totalRegular = perBlock * conditions.length;
  const attentionTotal = Math.max(1, Math.floor(totalRegular * 0.1));
  // At least one per BLOCK, deliberately -- unlike Tier 1, a block here is a
  // CONDITION, and a block with no check leaves no way to tell whether the
  // child was attending during that modality. The cost is that the rate rises
  // with the block count rather than tracking the session's 10%.
  const attentionPerBlock = Math.max(1, Math.floor(attentionTotal / conditions.length));

  const trials = [];
  let cursor = 0;

  conditions.forEach((condition, block) => {
    const blockTrials = [];

    for (let slot = 0; slot < perBlock; slot++) {
      let triplet;
      if (mode === "shared") {
        // Yoke within ONE pass over the conditions, and take fresh triplets on
        // the next. With more than three blocks the conditions come round
        // again, and re-showing the first pass's triplets would make the child
        // judge each one twice per condition -- six exposures instead of three
        // -- folding a practice effect into the very AV-vs-(V+A) contrast the
        // yoking exists to keep clean.
        const idx = Math.floor(block / 3) * perBlock + slot;
        triplet = regularTriplets[idx % regularTriplets.length];
      } else if (cursor < regularTriplets.length) {
        triplet = regularTriplets[cursor++];
      } else {
        // Ran out of pre-generated triplets: draw a fresh one rather than
        // silently reusing, which would bias pair coverage.
        triplet = orderRng.shuffle([...concepts]).slice(0, 3);
      }
      blockTrials.push({
        concepts: [...triplet], is_attention: false, condition, block,
      });
    }

    for (let i = 0; i < attentionPerBlock; i++) {
      const dup = orderRng.choice(concepts);
      const diff = orderRng.choice(concepts.filter((c) => c !== dup));
      blockTrials.push({
        concepts: orderRng.shuffle([dup, dup, diff]),
        is_attention: true, condition, block,
      });
    }

    orderRng.shuffle(blockTrials);
    trials.push(...blockTrials);
  });

  return trials;
}

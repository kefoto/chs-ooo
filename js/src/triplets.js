/**
 * Balanced triplet selection, ported from generate_balanced_triplets in
 * experiments/two_tier_experiment.py.
 *
 * Each odd-one-out triplet {a,b,c} constrains 3 concept PAIRS. Shuffling all
 * C(n,3) combinations and truncating gives uneven coverage: a few pairs appear
 * repeatedly while thousands never appear, which wastes trials and leaves the
 * aggregated embedding poorly conditioned, because pair similarities are only
 * constrained where a pair was actually shown.
 *
 * So: round-robin a shuffled queue of all C(n,2) pairs. Each triplet is
 * anchored on the next least-used pair, and the third concept is chosen
 * greedily to minimise the usage of the two pairs it completes, then overall
 * concept usage. The result is near-uniform pair coverage.
 *
 * Deterministic given `rng`.
 */

const pkey = (x, y) => (x <= y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

export function generateBalancedTriplets(concepts, nTriplets, rng) {
  if (concepts.length < 3) throw new Error("need at least 3 concepts");

  const pairCount = new Map();
  const conceptCount = new Map(concepts.map((c) => [c, 0]));
  const seenTriplets = new Set();

  let pairQueue = [];
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      pairQueue.push(pkey(concepts[i], concepts[j]));
    }
  }
  rng.shuffle(pairQueue);
  let idx = 0;
  let floor = 0;

  // Next pair whose usage is still at the current floor. Pairs already bumped
  // above it -- used earlier as a COMPLETING pair -- are skipped, so no pair
  // is sampled twice while others sit unused. Dropping this is what cost the
  // first version of this port 38 pairs of coverage at 500 trials.
  function nextAnchorPair() {
    for (;;) {
      while (idx < pairQueue.length) {
        const p = pairQueue[idx++];
        if ((pairCount.get(p) || 0) <= floor) return p.split("\u0000");
      }
      rng.shuffle(pairQueue);
      idx = 0;
      floor += 1;
    }
  }

  const triplets = [];
  for (let t = 0; t < nTriplets; t++) {
    const [a, b] = nextAnchorPair();

    // Rank candidates by how much they would unbalance pair coverage, then by
    // concept usage; rng breaks remaining ties.
    const candidates = concepts
      .filter((c) => c !== a && c !== b)
      .map((c) => ({
        c,
        k: [
          (pairCount.get(pkey(a, c)) || 0) + (pairCount.get(pkey(b, c)) || 0),
          conceptCount.get(c),
          rng.random(),
        ],
      }));
    candidates.sort((x, y) =>
      x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.k[2] - y.k[2]);

    let third = candidates[0].c;
    for (const cand of candidates) {
      const set = [a, b, cand.c].slice().sort().join("\u0000");
      if (!seenTriplets.has(set)) { third = cand.c; break; }
    }

    seenTriplets.add([a, b, third].slice().sort().join("\u0000"));
    for (const p of [pkey(a, b), pkey(a, third), pkey(b, third)]) {
      pairCount.set(p, (pairCount.get(p) || 0) + 1);
    }
    for (const c of [a, b, third]) {
      conceptCount.set(c, conceptCount.get(c) + 1);
    }
    triplets.push(rng.shuffle([a, b, third]));
  }
  return triplets;
}

/**
 * Split `total` items over `groups` as evenly as possible, summing to `total`.
 *
 * Not `max(1, total / groups)` per group: that rounds UP for every group and
 * so scales with the room count rather than with the session. At 16 rooms it
 * turned an intended ~10% attention rate into 20%, lengthening the session and
 * changing what `passes_attention_check` is computed over. Some rooms simply
 * get none, which is correct -- the rate is a property of the session.
 */
export function spreadAcross(total, groups) {
  return Array.from({ length: groups }, (_, i) =>
    Math.floor((total * (i + 1)) / groups) - Math.floor((total * i) / groups));
}

/**
 * Full Tier 1 trial list: regular triplets plus ~10% attention checks,
 * grouped into rooms and shuffled WITHIN each room.
 *
 * An attention trial repeats one concept twice, so it is the one trial type
 * with a correct answer. It is presented identically to every other trial and
 * gets identical feedback -- scoring it is an experimenter-side data-quality
 * measure, never something surfaced to the child.
 *
 *     Why rooms are built here rather than counted later
 *     --------------------------------------------------
 *     Attention trials used to be appended and the whole list shuffled
 *     globally, while rooms were derived by counting REGULAR trials only. The
 *     two disagreed: an attention trial could fall after a room's last regular
 *     trial, so the progress bar filled, the room paid out its stickers and
 *     ran the playground -- and then one more trial appeared with the bar
 *     already at 100%. Giving every trial a room here makes the room a
 *     contiguous stretch of the list, so what the bar says and what the child
 *     has left to do cannot drift apart. Mirrors buildTrialListTier2.
 */
export function buildTrialList(concepts, totalRegular, tripletRng, orderRng,
                               rooms = 1, perRoom = totalRegular) {
  const attentionTotal = Math.max(1, Math.floor(totalRegular * 0.1));
  const share = spreadAcross(attentionTotal, rooms);
  const regular = generateBalancedTriplets(concepts, totalRegular, tripletRng);

  const trials = [];
  for (let room = 0; room < rooms; room++) {
    const roomTrials = regular
      .slice(room * perRoom, (room + 1) * perRoom)
      .map((c) => ({ concepts: c, is_attention: false, condition: "V", room }));

    for (let i = 0; i < share[room]; i++) {
      const dup = orderRng.choice(concepts);
      const diff = orderRng.choice(concepts.filter((c) => c !== dup));
      roomTrials.push({
        concepts: orderRng.shuffle([dup, dup, diff]),
        is_attention: true, condition: "V", room,
      });
    }

    orderRng.shuffle(roomTrials);
    trials.push(...roomTrials);
  }
  return trials;
}

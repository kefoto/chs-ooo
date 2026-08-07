/**
 * How long a session is, from age and requested duration.
 * Port of core/flexible_session_manager.py (get_flexible_session_config) and
 * of the block arithmetic experiments/setup_experiment.py does on top of it.
 *
 * The trial counts below are a panel-recommended TABLE, not a calculation.
 * Deriving them from time-per-trial made short/standard/extended collapse to
 * the same number once the age ceiling clamped them.
 *
 *     Blocks are short on purpose
 *     ---------------------------
 *     A block boundary is where a room ends: stickers, then the playground.
 *     At 8-10 trials a 4-6 year old's standard session held three rewards in
 *     the whole sitting. Halving the block splits the SAME total into twice as
 *     many rooms, so the child is rewarded twice as often without working any
 *     longer -- the table still governs how long they actually sit there.
 */

export const AGE_BINS = [
  { name: "early_childhood", max: 6 },
  { name: "middle_childhood", max: 10 },
  { name: "adolescence", max: 17 },
  { name: "adults", max: Infinity },
];

export const DURATIONS = ["short", "standard", "extended"];

/**
 * Trials every session runs, whatever the age or requested duration. Mirrors
 * FIXED_TRIALS_PER_SESSION in core/flexible_session_manager.py -- the two
 * builds must agree or a browser session and a lab session of the "same"
 * length would hold different amounts of data.
 *
 * This replaced an age-bin x duration table (16/24/32 for early childhood up
 * to 350/600/800 for adults). Block sizes must divide it or the session lands
 * short: 550 = 2 x 5^2 x 11, so 5, 10, 11, 22, 25 and 50 all land on it while
 * 4 gives 137 blocks and 548 trials.
 *
 * It does not fit a short session -- ~32 min of responding at the 3.5s visual
 * estimate against 24 effective min -- which is a known and accepted cost.
 */
export const FIXED_TRIALS_PER_SESSION = 550;

export const DURATION_MINUTES = { short: 30, standard: 60, extended: 90 };

/** Fraction of the clock left for trials once setup and breaks are taken out. */
const EFFECTIVE = 0.8;

/**
 * Seconds a Tier 2 trial costs, averaged over its three condition blocks.
 *
 * Tier 2 cannot use the visual trial counts. Its A and AV blocks play three
 * clips -- a settle, then one sound per gap -- so ~9.8s passes before the
 * choice is even available, against ~3.5s for a visual trial. Two thirds of
 * the session is those blocks, giving (3.5 + 12 + 12) / 3. Handing Tier 2 the
 * adult visual count of 600 would schedule ~98 minutes of playback inside a
 * 60-minute session.
 */
export const TIER2_SECONDS_PER_TRIAL = 9.2;

export function ageBin(age) {
  const n = Number(age);
  if (!Number.isFinite(n)) return "adults";
  return AGE_BINS.find((b) => n <= b.max).name;
}

/**
 * Blocks and trials-per-block for a session.
 *
 * `Num Trials` is trials PER BLOCK in both builds -- the runner multiplies it
 * by `Num Blocks`. Handing it the session TOTAL multiplied the session by the
 * block count a second time, which is how an adult's "80 trial" desktop
 * session came to run 704. This returns both figures explicitly so no caller
 * has to guess which one it is holding.
 */
export function sessionPlan(age, duration = "standard", tier = 1) {
  const bin = ageBin(age);
  const dur = DURATIONS.includes(duration) ? duration : "standard";
  const recommended = FIXED_TRIALS_PER_SESSION;

  if (Number(tier) === 2) {
    // Two blocks per condition. Six is still a multiple of three, so every
    // condition keeps its Latin-square position, and it doubles the rooms
    // without lengthening the session.
    const blocks = 6;
    // Capped by Tier 2's own pacing rather than the visual count.
    const cap = Math.floor(
      (DURATION_MINUTES[dur] * 60 * EFFECTIVE) / TIER2_SECONDS_PER_TRIAL);
    const target = Math.max(6, Math.min(recommended, cap));
    const perBlock = Math.max(2, Math.round(target / blocks));
    return { bin, duration: dur, recommended, target, blocks, perBlock,
             total: blocks * perBlock, minutes: DURATION_MINUTES[dur] };
  }

  // A block boundary is where a room ends: stickers, then the playground.
  // Under-18s were on 5, which against a flat 550 meant 110 rooms -- 110
  // sticker ceremonies and playgrounds in one session. 11 gives 50.
  //
  // The size is not free to choose. It must divide FIXED_TRIALS_PER_SESSION
  // or the session lands short, and 550 = 2 x 5^2 x 11 leaves only 10 and 11
  // in the 10-20 range: 10 gives 55 rooms, 11 gives 50.
  //
  // 50 rooms still outruns the 104-sticker pool at 2-4 stickers a room, so
  // children DO see repeat stickers -- CastleState.create reshuffles the pool
  // when it runs dry. Avoiding that entirely needs <= ~34 rooms, i.e. 22 per
  // block, which is outside the range this was asked for.
  //
  // Adults keep 25. They are on 22 rooms, which stays inside the pool, and
  // they normally run the baseline arm where none of this is shown anyway.
  // Must match the desktop build's trials_per_block.
  const n = Number(age);
  const perBlock = n < 18 ? 11 : 25;
  const blocks = Math.max(1, Math.floor(recommended / perBlock));
  return { bin, duration: dur, recommended, blocks, perBlock,
           total: blocks * perBlock, minutes: DURATION_MINUTES[dur] };
}

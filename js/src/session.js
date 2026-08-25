/**
 * How long a session is, from age and requested duration.
 * Port of core/flexible_session_manager.py (get_flexible_session_config) and
 * of the block arithmetic experiments/setup_experiment.py does on top of it.
 *
 * Trial count is derived from the time budget: TRIAL_SECONDS[bin] is how long
 * one trial takes at that age's pace, so recommended = effective time / pace.
 * Both age AND duration drive the count, so a 'short' session actually takes
 * ~30 min at every age instead of everyone running the same total regardless
 * of how long they sat down for.
 *
 *     Blocks are short on purpose
 *     ---------------------------
 *     A block boundary is where a room ends: stickers, then the playground.
 *     At 8-10 trials a 4-6 year old's standard session held three rewards in
 *     the whole sitting. Halving the block splits the SAME total into twice as
 *     many rooms, so the child is rewarded twice as often without working any
 *     longer.
 */

export const AGE_BINS = [
  { name: "early_childhood", max: 6 },
  { name: "middle_childhood", max: 10 },
  { name: "adolescence", max: 17 },
  { name: "adults", max: Infinity },
];

export const DURATIONS = ["short", "standard", "extended"];

export const DURATION_MINUTES = { short: 30, standard: 60, extended: 90 };

/** Fraction of the clock left for trials once setup and breaks are taken out. */
const EFFECTIVE = 0.8;

/**
 * Seconds a visual trial costs, averaged by age bin. Mirrors
 * FlexibleSessionManager.trial_durations in core/flexible_session_manager.py
 * -- the two builds must agree or a browser session and a lab session of the
 * "same" age and duration would hold different amounts of data.
 */
export const TRIAL_SECONDS = {
  early_childhood: 8.0,
  middle_childhood: 6.0,
  adolescence: 4.5,
  adults: 3.5,
};

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
  const effectiveSeconds = DURATION_MINUTES[dur] * 60 * EFFECTIVE;
  // How many trials of this age's estimated pace fit in the time budget.
  const recommended = Math.floor(effectiveSeconds / TRIAL_SECONDS[bin]);

  if (Number(tier) === 2) {
    // Two blocks per condition. Six is still a multiple of three, so every
    // condition keeps its Latin-square position, and it doubles the rooms
    // without lengthening the session.
    const blocks = 6;
    // Capped by Tier 2's own pacing rather than the visual count.
    const cap = Math.floor(effectiveSeconds / TIER2_SECONDS_PER_TRIAL);
    const target = Math.max(6, Math.min(recommended, cap));
    const perBlock = Math.max(2, Math.round(target / blocks));
    return { bin, duration: dur, recommended, target, blocks, perBlock,
             total: blocks * perBlock, minutes: DURATION_MINUTES[dur] };
  }

  // A block boundary is where a room ends: stickers, then the playground.
  // Under-18s get 11 trials per room -- enough sticker ceremonies to feel
  // rewarding without turning every room into a single trial. Adults get 25:
  // a 25-trial block is still only ~90 seconds between breaks, and they
  // normally run the baseline arm where none of this is shown anyway. Must
  // match the desktop build's trials_per_block.
  //
  // Blocks are what actually get scheduled -- num_blocks = recommended //
  // perBlock truncates, so the achievable total is the largest multiple of
  // perBlock that fits under recommended, not recommended itself unless it
  // happens to divide evenly. recommended now varies with age and duration
  // (see TRIAL_SECONDS above), so room count does too, rather than always
  // landing near a fixed 50.
  const n = Number(age);
  const perBlock = n < 18 ? 11 : 25;
  const blocks = Math.max(1, Math.floor(recommended / perBlock));
  return { bin, duration: dur, recommended, blocks, perBlock,
           total: blocks * perBlock, minutes: DURATION_MINUTES[dur] };
}

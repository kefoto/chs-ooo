/**
 * Session output, in the SAME schema the PyQt build writes.
 *
 * This is the point of the whole port. analysis/vice_utils.py reads
 * `responses[*].concept_triplet` / `selected_concept`, and the age-bin
 * analyses read `participant_data.age`. A browser build that emitted its own
 * shape would produce data the existing pipeline cannot touch, and the
 * facility's sessions would need a bespoke converter before anyone could look
 * at them.
 *
 *   {
 *     "participant_data": {...},
 *     "responses":        [...],
 *     "game_state":       {"castle": {...}}     // third top-level key
 *   }
 *
 * `game_state` is deliberately a THIRD top-level key, not nested inside
 * participant_data (REDCap uploads that field-by-field) and not on response
 * rows (vice_utils iterates those per trial).
 */

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function buildPayload({ config, responses, castle, shop, startTime, completed }) {
  const attention = responses.filter((r) => r.is_attention_trial);
  const correct = attention.filter((r) => r.correct).length;
  const score = attention.length ? (correct / attention.length) * 100 : 100;

  const regular = responses.filter((r) => !r.is_attention_trial);
  const plannedRegular = (config["Num Blocks"] || 0) * (config["Num Trials"] || 0);

  const participant_data = {
    participant_id: config.participant_id || "unknown",
    tier: config.Tier || 1,
    total_trials: responses.length,
    start_time: startTime,
    end_time: stamp(),
    attention_accuracy: Math.round(score * 100) / 100,
    passes_attention_check: score >= 80.0,
    // 1 = finished, 0 = ended early. Partial sessions are filterable and are
    // never silently pooled with complete ones.
    completion_status: completed ? 1 : 0,
    planned_regular_trials: plannedRegular,
    completed_regular_trials: regular.length,
    age: config.Age ?? "",
    gender: config.Gender ?? "",
    handedness: config.Handedness ?? "",
    ethnicity: config.Ethnicity ?? "",
    // Race is a separate question from ethnicity, not a finer grain of it.
    // race_self_describe is only ever non-empty when race is
    // "Prefer to self-describe".
    race: config.Race ?? "",
    race_self_describe: config.Race_Self_Describe ?? "",
    first_language: config.First_Language ?? "",
    other_languages: config.Other_Languages ?? "",
    experiment_site: config["Experiment Site"] ?? "",
    setting: config.Setting ?? "",
    vr_exposure: config.VR_Exposure ?? "",
    screen_time: config.Screen_Time ?? "",
    gamified: Boolean(config.Gamify),
    mascot_variant: config.Gamify ? (config.Gamify_Mascot || "neutral") : null,
    // Distinguishes browser sessions from PyQt ones. The two builds seed
    // their RNGs differently, so triplet sequences are NOT comparable across
    // implementations even for the same participant id.
    platform: "jspsych-web",
    // Children Helping Science identity, when the session came in through a
    // CHS external-study link. `age` above is empty for those: CHS does not
    // put it in the link, and the demographic snapshot is joined on
    // chs_child afterwards. Null for lab and facility sessions.
    chs_child: config.chs_child ?? null,
    chs_response: config.chs_response ?? null,
  };

  const payload = { participant_data, responses };
  if (castle) {
    payload.game_state = { castle: castle.toJSON() };
    if (shop) payload.game_state.shop = shop.toJSON();
  }
  return payload;
}

/**
 * One response row, matching experiments/two_tier_experiment._record_response
 * FIELD FOR FIELD. The names are not arbitrary: vice_utils reads
 * `concept_selected` and `concept_similar_pair`, and an almost-right name
 * silently yields zero usable triplets rather than an error.
 */
export function makeResponse({
  trialIndex, concepts, selected, position, isAttention,
  rtMs, condition = "V", tier = 1, blockNumber = 0,
}) {
  // The similar pair is the two NOT selected, excluded by position so a
  // repeated id (attention trials) cannot drop the wrong one.
  const similarPair = concepts.filter((_, i) => i !== position);

  const row = {
    tier,
    condition,
    block_number: blockNumber,
    trial_index: trialIndex,
    concept_triplet: concepts,
    concept_selected: selected,
    concept_similar_pair: similarPair,
    selected_position: position,
    is_attention_trial: Boolean(isAttention),
    response_time_ms: Math.round(rtMs),
    timestamp: new Date().toISOString(),
  };

  if (isAttention) {
    // Correct answer is the concept that appears once. Scored for data
    // quality only; the child is never told.
    const counts = {};
    for (const c of concepts) counts[c] = (counts[c] || 0) + 1;
    const unique = Object.keys(counts).filter((c) => counts[c] === 1);
    row.correct = unique.length ? unique.includes(selected) : false;
  }
  return row;
}

export function filenameFor(payload) {
  const pd = payload.participant_data;
  const suffix = pd.completion_status === 1 ? "" : "_partial";
  return `tier${pd.tier}_${pd.participant_id}_${fileStamp()}${suffix}.json`;
}

/** Trigger a browser download. */
export function downloadPayload(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)],
                        { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filenameFor(payload);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * POST to a collection endpoint, if the config names one.
 *
 * `block` (a room index) marks a per-block checkpoint rather than the final
 * save -- travels as a header, not in the body, so the body stays the raw
 * payload unchanged for every caller of upload_url (an external collection
 * endpoint has no reason to know or care about this build's internal
 * checkpoint/final distinction).
 */
export async function postPayload(url, payload, { ticket, block } = {}) {
  const headers = { "Content-Type": "application/json" };
  // The session-admission ticket from js/src/captcha.js -- api/submit.js
  // verifies it before it will store anything. A header, not a body
  // field, so the payload stays byte-for-byte what a download would be.
  if (ticket) headers.Authorization = `Bearer ${ticket}`;
  if (Number.isFinite(block)) headers["X-Session-Block"] = String(block);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res;
}

/**
 * Session configuration. Mirrors config/gamified_example.json so the same
 * knobs mean the same things in both builds.
 *
 * `Num Blocks` is how many ROOMS the castle has; `Num Trials` is trials per
 * room. Attention checks are added on top at ~10%.
 */
export const CONFIG = {
  Tier: 1,
  participant_id: "WEB01",

  // Overwritten from the age-bin table unless ?rooms/?trials pin them --
  // see session.js. `Num Trials` is trials PER BLOCK, never the session total.
  "Num Blocks": 5,
  "Num Trials": 3,
  Session_Duration: "standard",   // short | standard | extended

  Age: "",
  Gender: "",
  Handedness: "",
  Ethnicity: "",
  // Race is a separate question from ethnicity, not a finer grain of it.
  // Race_Self_Describe is only ever non-empty when Race is
  // "Prefer to self-describe". Languages are free text: a fixed list would be
  // wrong for a multi-site study.
  Race: "",
  Race_Self_Describe: "",
  First_Language: "",
  Other_Languages: "",
  "Experiment Site": "",
  Setting: "lab",
  VR_Exposure: "",
  Screen_Time: "",

  Gamify: true,
  Gamify_Mascot: "neutral",
  Gamify_Reduced_Motion: false,
  // Silences the game's own sound effects. Reduced-motion mode implies it
  // unless the session says otherwise -- the same precedence GameLayer
  // applies on the desktop. Stimulus audio is never affected: a Tier 2 trial
  // without its clips is not the task.
  Gamify_Mute_SFX: false,

  // Where the finished session goes. Download is offered by default; set
  // upload_url to also POST the same JSON to a collection endpoint.
  upload_url: null,

  // Children Helping Science, when this is running as a CHS *external* study.
  // CHS appends these two to the Study URL when a family presses "Participate
  // now" -- the hashed child id and the response id:
  //
  //   https://you.github.io/repo/js/index.html?child=SG7JLN&response=d5c8f502-...
  //
  // They are the only identity CHS hands over. Age and demographics are NOT
  // in the link; they live in the CHS demographic snapshot, joined on
  // chs_child afterwards. Recorded into participant_data so that join is
  // possible at all -- without them a session cannot be tied to a family.
  chs_child: null,
  chs_response: null,

  // Suppressed under CHS: a file download prompt on a parent's home computer
  // is not a data pipeline. Set by applyUrlOverrides, not by hand.
  offer_download: true,

  // Tier 2 only. "shared" yokes the SAME triplets across the V/A/AV blocks,
  // which is what makes the AV vs (V + A) supradditivity contrast well
  // defined at item level; "disjoint" gives each block its own triplets and
  // supports group-level comparison only. Matches the desktop default (the
  // setup GUI writes "shared").
  Tier2_Triplet_Mode: "shared",

  // Stimulus pacing in the A/AV conditions, in ms. Defaults match the desktop
  // build: settle, then one sound every 3s.
  Audio_Lead_In_Ms: 800,
  Audio_Gap_Ms: 3000,

  // Paths are relative to js/index.html, i.e. one level up from js/. They work
  // unchanged when the whole repository is served (GitHub Pages), since the
  // page keeps its position above assets/ and datasets/. Point `?media=` at an
  // absolute origin to serve the media from somewhere else -- that host then
  // needs CORS, since the manifests are fetched rather than <img>-loaded.
  asset_root: "../assets/game",
  dataset_root: "../datasets/Tier1_THINGS_100",
  tier2_dataset_root: "../datasets/Tier2_AV_Matched",
};

/** Read overrides from the query string: ?tier=2&pid=P07&rooms=6&trials=8&age=7 */
export function applyUrlOverrides(cfg, search = window.location.search) {
  const q = new URLSearchParams(search);

  // CHS first: `pid` below still wins, so a hand-built test link overrides it.
  if (q.get("child")) {
    cfg.chs_child = q.get("child");
    cfg.chs_response = q.get("response") || null;
    // The child hash IS the participant id. It is stable per child, which is
    // what the age-bin analyses need to group by, and it seeds the triplets --
    // so a child who participates twice replays the SAME sequence. Seed from
    // chs_response instead if repeat sessions should cover new triplets.
    cfg.participant_id = q.get("child");
    // A parent at home should not be handed a JSON file, and should never see
    // the experimenter's form.
    cfg.offer_download = false;
    cfg.Setting = "home";
  }

  if (q.get("media")) {
    const base = q.get("media").replace(/\/+$/, "");
    cfg.asset_root = `${base}/assets/game`;
    cfg.dataset_root = `${base}/datasets/Tier1_THINGS_100`;
    cfg.tier2_dataset_root = `${base}/datasets/Tier2_AV_Matched`;
  }

  if (q.get("tier")) cfg.Tier = Number(q.get("tier")) === 2 ? 2 : 1;
  if (q.get("mode")) cfg.Tier2_Triplet_Mode = q.get("mode");
  if (q.get("lead")) cfg.Audio_Lead_In_Ms = Number(q.get("lead"));
  if (q.get("gap")) cfg.Audio_Gap_Ms = Number(q.get("gap"));
  if (q.get("pid")) cfg.participant_id = q.get("pid");
  if (q.get("rooms")) cfg["Num Blocks"] = Number(q.get("rooms"));
  if (q.get("trials")) cfg["Num Trials"] = Number(q.get("trials"));
  if (q.get("age")) cfg.Age = q.get("age");
  if (q.get("duration")) cfg.Session_Duration = q.get("duration");
  if (q.get("site")) cfg["Experiment Site"] = q.get("site");
  if (q.get("upload")) cfg.upload_url = q.get("upload");
  if (q.get("plain") === "1") cfg.Gamify = false;
  if (q.get("calm") === "1") cfg.Gamify_Reduced_Motion = true;
  if (q.get("quiet") === "1") cfg.Gamify_Mute_SFX = true;

  // Reduced stimulation implies quiet, unless this session asked for sound
  // explicitly. Mirrors GameLayer.__init__.
  if (cfg.Gamify_Reduced_Motion && !q.has("quiet")) cfg.Gamify_Mute_SFX = true;
  return cfg;
}

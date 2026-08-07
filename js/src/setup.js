/**
 * The experimenter's setup screen, shown before the session starts.
 * Browser counterpart to experiments/setup_experiment.py.
 *
 * Same fields, same meanings, and the same live session preview -- so the
 * person running a remote session fills in what they would fill in at the lab
 * machine, rather than hand-assembling a query string.
 *
 *     When it appears
 *     ---------------
 *     Only when the URL does NOT already carry a participant id. A link with
 *     `?pid=...` is a session someone has already configured -- a facility
 *     link, or the test harness -- and stopping to ask a form would break it.
 *     `?setup=1` forces the form anyway.
 *
 * This screen is for the ADULT, never the child: it is plain, dense, and
 * deliberately unlike the game.
 */

import { sessionPlan, DURATIONS } from "./session.js";

const GENDER = ["", "Female", "Male", "Non-binary", "Prefer not to say"];
const HANDEDNESS = ["", "Right", "Left", "Ambidextrous"];
// Ethnicity is the Hispanic/Latino item and nothing else; race is the separate
// list below. Kept in the same order as field_mappings['ethnicity'] in
// experiments/setup_experiment.py, where the position IS the REDCap code.
const ETHNICITY = ["", "Hispanic or Latino", "Not Hispanic or Latino",
                   "Prefer not to answer"];
// Race, asked separately from ethnicity above -- they are two questions, and
// one is not a finer grain of the other. OMB/US Census categories. Kept in the
// same order as field_mappings['race'] in experiments/setup_experiment.py,
// where the position IS the REDCap code.
const RACE = ["", "American Indian or Alaska Native", "Asian",
              "Black or African American",
              "Native Hawaiian or Other Pacific Islander", "White",
              "Two or more races", "Prefer to self-describe",
              "Prefer not to answer"];
const RACE_SELF_DESCRIBE = "Prefer to self-describe";
const SETTING = ["lab", "home", "school", "clinic"];
const EXPOSURE = ["", "None", "Occasional", "Frequent"];
const SCREEN_TIME = ["", "<1 hour", "1-2 hours", "2-4 hours", "4+ hours"];

const options = (values, selected) => values
  .map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>` +
              `${v || "—"}</option>`)
  .join("");

/** True when the session is already configured and the form should be skipped. */
export function setupNeeded(search = window.location.search) {
  const q = new URLSearchParams(search);
  // A CHS link is a family at home pressing "Participate now". There is no
  // experimenter to fill anything in, and this form asks for demographics CHS
  // already holds -- so it never appears, not even for ?setup=1.
  if (q.get("child")) return false;
  if (q.get("setup") === "1") return true;
  return !q.get("pid");
}

/**
 * Render the form and resolve with the chosen settings merged into `cfg`.
 * Never rejects: the only way out is Start, which always yields a session.
 */
export function showSetup(cfg, root, search = window.location.search) {
  // Start blank unless the URL named a participant. CONFIG carries a
  // placeholder id ("WEB01"), and prefilling it invites an experimenter to
  // press Start straight through -- which would run every session under the
  // same id, and since the id seeds the triplets, block order and reward
  // schedule, give every child an identical session.
  const urlPid = new URLSearchParams(search).get("pid") ?? "";
  return new Promise((resolve) => {
    root.innerHTML = `
      <div class="setup">
        <h1>Session setup</h1>
        <p class="setup-sub">Fill the blank fields in before handing the screen to the child.</p>

        <div class="setup-grid">
          <label>Participant ID
            <input id="s-pid" type="text" value="${urlPid}"
                   autocomplete="off" spellcheck="false"></label>
          <label>Age
            <input id="s-age" type="number" min="3" max="99"
                   value="${cfg.Age ?? ""}" autocomplete="off"></label>

          <label>Task
            <select id="s-tier">
              <option value="1"${cfg.Tier === 2 ? "" : " selected"}>Tier 1: Visual (THINGS 100)</option>
              <option value="2"${cfg.Tier === 2 ? " selected" : ""}>Tier 2: Multisensory (Matched 100)</option>
            </select></label>
          <label>Session length
            <select id="s-duration">
              ${DURATIONS.map((d) => `<option value="${d}"` +
                `${d === cfg.Session_Duration ? " selected" : ""}>${d}</option>`).join("")}
            </select></label>

          <label>Gender
            <select id="s-gender">${options(GENDER, cfg.Gender)}</select></label>
          <label>Handedness
            <select id="s-hand">${options(HANDEDNESS, cfg.Handedness)}</select></label>

          <label>Ethnicity
            <select id="s-eth">${options(ETHNICITY, cfg.Ethnicity)}</select></label>
          <label>Race
            <select id="s-race">${options(RACE, cfg.Race)}</select></label>

          <label class="setup-wide">Self-describe
            <input id="s-race-self" type="text" value="${cfg.Race_Self_Describe ?? ""}"
                   placeholder="Only if &quot;Prefer to self-describe&quot; is selected"
                   autocomplete="off" disabled></label>

          <label>First language
            <input id="s-lang1" type="text" value="${cfg.First_Language ?? ""}"
                   placeholder="e.g. English" autocomplete="off"></label>
          <label>Other languages
            <input id="s-lang2" type="text" value="${cfg.Other_Languages ?? ""}"
                   placeholder="Comma-separated, blank if none"
                   autocomplete="off"></label>

          <label>Site
            <input id="s-site" type="text" value="${cfg["Experiment Site"] ?? ""}"
                   autocomplete="off"></label>

          <label>Setting
            <select id="s-setting">${options(SETTING, cfg.Setting)}</select></label>
          <label>VR exposure
            <select id="s-vr">${options(EXPOSURE, cfg.VR_Exposure)}</select></label>

          <label>Daily screen time
            <select id="s-screen">${options(SCREEN_TIME, cfg.Screen_Time)}</select></label>
          <label class="setup-checks">
            <span class="setup-check">
              <input id="s-gamify" type="checkbox" checked>
              Gamified presentation</span>
            <span class="setup-check">
              <input id="s-calm" type="checkbox">
              Reduced motion</span>
          </label>
        </div>

        <div class="setup-preview" id="s-preview"></div>
        <p class="setup-error" id="s-error" hidden></p>
        <button class="big" id="s-start">Start session</button>
      </div>`;

    const el = (id) => root.querySelector(id);
    const preview = el("#s-preview");
    const error = el("#s-error");

    const plan = () => sessionPlan(el("#s-age").value || 25,
                                   el("#s-duration").value,
                                   Number(el("#s-tier").value));

    function refresh() {
      const p = plan();
      const tier2 = Number(el("#s-tier").value) === 2;
      preview.innerHTML =
        `<strong>Session preview</strong>` +
        `<span>Age group: ${p.bin.replace(/_/g, " ")}</span>` +
        `<span>Target: ${p.recommended} trials (${p.minutes} min)</span>` +
        `<span>Runs: <b>${p.perBlock} per room × ${p.blocks} rooms ` +
        `= ${p.total}</b> + ~10% attention checks</span>` +
        (tier2
          ? `<span>Blocks: 2 each of V / A / AV, Latin-square ordered</span>`
          : `<span>Every room is visual</span>`);
    }

    // The free-text box is live only while it has something to describe.
    // Clearing it on the way out matters: a description typed against
    // "Prefer to self-describe" and then left behind when the category changed
    // would be saved alongside a category that contradicts it.
    function syncRaceSelfDescribe() {
      const wanted = el("#s-race").value === RACE_SELF_DESCRIBE;
      el("#s-race-self").disabled = !wanted;
      if (!wanted) el("#s-race-self").value = "";
    }
    el("#s-race").addEventListener("change", syncRaceSelfDescribe);
    syncRaceSelfDescribe();

    ["#s-age", "#s-duration", "#s-tier"].forEach((id) => {
      el(id).addEventListener("input", refresh);
      el(id).addEventListener("change", refresh);
    });
    refresh();

    el("#s-start").addEventListener("click", () => {
      const pid = el("#s-pid").value.trim();
      // The id seeds the whole session -- triplets, block order, reward
      // schedule. A blank one would make every participant identical.
      if (!pid) {
        error.textContent = "Participant ID is required: it seeds the session.";
        error.hidden = false;
        el("#s-pid").focus();
        return;
      }
      const p = plan();
      resolve({
        ...cfg,
        participant_id: pid,
        Age: el("#s-age").value,
        Tier: Number(el("#s-tier").value),
        "Num Blocks": p.blocks,
        "Num Trials": p.perBlock,
        Session_Duration: p.duration,
        Gender: el("#s-gender").value,
        Handedness: el("#s-hand").value,
        Ethnicity: el("#s-eth").value,
        Race: el("#s-race").value,
        // Read through the category rather than straight off the box, so a
        // description can never outlive the option that invited it.
        Race_Self_Describe: el("#s-race").value === RACE_SELF_DESCRIBE
          ? el("#s-race-self").value.trim() : "",
        First_Language: el("#s-lang1").value.trim(),
        Other_Languages: el("#s-lang2").value.trim(),
        "Experiment Site": el("#s-site").value.trim(),
        Setting: el("#s-setting").value,
        VR_Exposure: el("#s-vr").value,
        Screen_Time: el("#s-screen").value,
        // Written explicitly, not left to the config default, so the saved
        // file states which arm the session actually ran as.
        Gamify: el("#s-gamify").checked,
        Gamify_Reduced_Motion: el("#s-calm").checked,
      });
    });
  });
}

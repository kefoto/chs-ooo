/**
 * Drives a whole session in jsdom against the REAL jsPsych -- and, unlike the
 * first version of this harness, against the REAL src/main.js.
 *
 * That distinction earned itself immediately. The old harness re-implemented
 * main.js's timeline builder inside the test, so the two could drift, and they
 * did: the copy kept passing while the shipping code wrote jsPsych's global
 * timeline index into `trial_index` (5,6,7,11,12,13,... instead of 0..N-1),
 * because jsPsych reserves that field name and overwrites a plugin's value.
 * A harness that imports main.js cannot drift from main.js.
 *
 * Still not a substitute for opening the page: jsdom renders no pixels and
 * plays no audio.
 *
 *   node js/test/browser.mjs                 # both tiers, as subprocesses
 *   node js/test/browser.mjs "?tier=2&pid=X" # one session, in this process
 */
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// No query given: run both tiers, each in its own process. main.js is a module
// with top-level side effects, so one process can only ever run one session.
// ---------------------------------------------------------------------------
if (!process.argv[2]) {
  let bad = 0;
  // Tier 2 runs at compressed pacing (lead=5, gap=20) so the harness does not
  // sit through 9.8s of playback per trial. The sequence still runs in full.
  for (const q of ["?pid=WEBTEST&rooms=2&trials=2",
                   "?tier=2&pid=WEBTEST2&rooms=3&trials=2&lead=5&gap=20",
                   // No pid: the experimenter's setup form must appear, and the
                   // session it produces must take its length from the plan
                   // rather than the config defaults. Rooms and trials are
                   // pinned only so the harness does not sit through all 550.
                   "?setup=1&age=5&duration=short&rooms=2&trials=2",
                   // A Children Helping Science external-study link: the family
                   // presses "Participate now" and CHS appends these two. No
                   // pid, and no form -- there is no experimenter at home.
                   // upload= stands in for the collection endpoint: with no
                   // download offered, the POST is the only way the data
                   // leaves the page, so the harness must exercise it.
                   "?child=SG7JLN&response=d5c8f502-6588-46c8-84fa-a9657a44fe47" +
                   "&rooms=2&trials=2&upload=http://localhost/collect"]) {
    console.log(`\n=================== ${q} ===================`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), q],
                        { stdio: "inherit" });
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const QUERY = process.argv[2];
const TIER2 = new URLSearchParams(QUERY).get("tier") === "2";
// A CHS link carries no pid either, but must NOT raise the form: the identity
// comes from `child` and there is no experimenter to fill anything in. Keying
// this off the missing pid alone left the harness waiting for a form that
// correctly never appeared, and the session never started.
const CHS = Boolean(new URLSearchParams(QUERY).get("child"));
const SETUP = !new URLSearchParams(QUERY).get("pid") && !CHS;
const SETUP_PID = "FORMPID";

// jsdom has no navigation, so save.js's download anchor logs a "not
// implemented" every run. Drop only that; everything else still surfaces.
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  if (!/Not implemented: navigation/.test(e.message)) console.error(e.message);
});
for (const level of ["log", "info", "warn", "error"]) vc.on(level, () => {});

const dom = new JSDOM(
  `<!doctype html><html><body><div id="jspsych-target"></div></body></html>`,
  { url: `http://localhost/js/index.html${QUERY}`,
    pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: vc });

for (const k of ["window", "document", "navigator", "HTMLElement", "Element",
                 "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle",
                 "requestAnimationFrame", "cancelAnimationFrame", "DOMParser",
                 "HTMLMediaElement"]) {
  if (dom.window[k] !== undefined) globalThis[k] = dom.window[k];
}
// NOT dom.window.performance: jsdom's implementation looks the global up
// again, so aliasing it onto globalThis makes now() recurse into itself.

const errors = [];

// jsdom does not fetch images, so probeImages() would time out and every run
// would silently take the text-only cutscene fallback -- leaving CutscenePlugin
// untested. Report the panels as loadable so the real plugin runs.
globalThis.Image = class {
  set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
  get src() { return this._src; }
};
dom.window.Image = globalThis.Image;

// jsdom has no media stack: play() is "not implemented" and would land in the
// error list as a false failure. Resolve it, and count the calls instead --
// which is itself worth asserting, since a Tier 2 session that plays no sounds
// is not a Tier 2 session.
let playCalls = 0;
globalThis.Audio = class extends dom.window.HTMLAudioElement {};
Object.defineProperty(dom.window, "Audio", {
  value: function Audio(src) {
    const el = dom.window.document.createElement("audio");
    if (src !== undefined) el.src = src;
    return el;
  },
  writable: true, configurable: true,
});
globalThis.Audio = dom.window.Audio;
dom.window.HTMLMediaElement.prototype.play = function () {
  if (!String(this.src).startsWith("data:")) playCalls++;
  return Promise.resolve();
};
dom.window.HTMLMediaElement.prototype.pause = function () {};
dom.window.HTMLMediaElement.prototype.load = function () {};

// Capture the payload save.js hands to the download, rather than writing it.
let savedJson = null;
globalThis.Blob = class {
  constructor(parts) { this.__text = parts.join(""); }
};
dom.window.Blob = globalThis.Blob;
globalThis.URL.createObjectURL = (b) => { savedJson = b.__text; return "blob:stub"; };
globalThis.URL.revokeObjectURL = () => {};

// Serve the repo's files straight off disk.
globalThis.fetch = async (url, init) => {
  // A CHS session is never offered a download, so the POST to upload_url is
  // the only place its data appears. Capture it the way the Blob is captured
  // above, or the harness would be blind to exactly the path CHS relies on.
  if (init?.method === "POST") {
    savedJson = init.body;
    return { ok: true, status: 200, json: async () => ({}) };
  }
  const rel = String(url).replace(/^https?:\/\/[^/]+\//, "").replace(/^\.\.\//, "");
  const file = path.join(ROOT, rel.replace(/^js\//, "js/"));
  if (!fs.existsSync(file)) {
    errors.push(`fetch 404: ${url} -> ${file}`);
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const text = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

dom.window.addEventListener("error", (e) => errors.push(`window error: ${e.message}`));
const origErr = console.error;
console.error = (...a) => { errors.push(`console.error: ${a.join(" ")}`); origErr(...a); };
const origWarn = console.warn;
const warnings = [];
console.warn = (...a) => { warnings.push(a.join(" ")); origWarn(...a); };

// Load the standalone build the way index.html does.
const jsPsychSrc = fs.readFileSync(
  path.join(HERE, "..", "vendor", "jspsych-8.2.1.browser.js"), "utf8");
dom.window.eval(jsPsychSrc);
globalThis.jsPsychModule = dom.window.jsPsychModule;
if (typeof globalThis.jsPsychModule?.initJsPsych !== "function") {
  console.error("jsPsych global missing"); process.exit(1);
}

// THE session. Everything above is scaffolding; this is the shipping code.
await import("../src/main.js");

// Drive it: click whatever the current screen offers, until a payload appears.
const target = dom.window.document.getElementById("jspsych-target");
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
let guard = 0;
let setupSeen = false;
let setupPreview = "";
let panelClicks = 0;   // cutscene panels are click-advanced, not button-advanced
// Stickers must be drawn from images, never as emoji text: the glyph would
// otherwise come from whatever emoji font the machine has, which is a tofu box
// on a Linux box with none installed. Sampled through the run because the
// playground and sticker book only exist on some screens.
let stickerImgs = 0;
let stickerTextOnly = 0;
// Every driven case pins rooms/trials in its query, so this only has to cover
// a short session. A form-driven 550-trial run is not attempted -- jsdom did
// not finish one in eight minutes, and the loop just times out, which reads
// confusingly as "no responses recorded".
while (!savedJson && guard++ < 8000) {
  await new Promise((r) => setTimeout(r, 3));
  stickerImgs += target.querySelectorAll("img.sticker-art").length;
  for (const el of target.querySelectorAll(".sticker, .tray-item, .slot")) {
    if (!el.querySelector("img.sticker-art") && el.textContent.trim()) stickerTextOnly++;
  }
  const startBtn = target.querySelector("#s-start");
  if (startBtn) {
    // The setup screen owns the page until it is submitted.
    const pidField = target.querySelector("#s-pid");
    // Always set it: the field starts blank on purpose, and a blank id is
    // rejected, so this is also what proves the form was really shown.
    if (pidField) { pidField.value = SETUP_PID; setupSeen = true; }
    // What the form says it will run, before it runs it. The form derives this
    // from sessionPlan rather than the config defaults, and that derivation is
    // the property this case exists to check.
    setupPreview = (target.querySelector("#s-preview") ?? target).textContent;
    // A form-driven session cannot be driven to completion any more: the plan
    // is a flat 550 trials across 110 rooms, and jsdom did not finish one in
    // eight minutes. The handoff is asserted from the preview instead, and the
    // pid -> session path stays covered by the ?pid= cases above.
    if (SETUP) break;
    click(startBtn);
    continue;
  }
  const scene = target.querySelector("#scene");
  const card = target.querySelector(".audio-card");
  const stim = target.querySelector(".stimulus");
  const auto = target.querySelector("#auto");
  const done = target.querySelector("#done");
  const go = target.querySelector("#go");
  // The cutscene advances on the scene itself, not a button. It also ignores
  // taps mid-fade, so this may need several passes per panel -- which is the
  // behaviour being checked.
  if (scene) { panelClicks++; click(scene); }
  else if (card) {
    // Answer only once the auto-play sequence has finished, the way a child
    // would. Clicking the instant the card appears is what let the first
    // version of this harness report a Tier 2 session that never played a
    // sound -- the trial ended before the lead-in timer even fired.
    const st = target.querySelector("#status")?.textContent ?? "";
    if (!/Pick one|Make your selection|Play it again|blocked/i.test(st)) continue;
    const pick = target.querySelector(".audio-card .pick");
    click(pick ?? card);
  }
  else if (stim) click(stim);
  else if (auto) { click(auto); const d = target.querySelector("#done"); if (d) click(d); }
  else if (done) click(done);
  else if (go) click(go);
}

const payload = savedJson ? JSON.parse(savedJson) : null;
const rows = payload?.responses ?? [];

// --- assertions ------------------------------------------------------------
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

// The bug this harness was rewritten to catch: trial_index must index the
// TRIAL list, exactly as the desktop build's does -- not jsPsych's timeline.
const idxs = rows.map((r) => r.trial_index);

// The setup case stops at the form and never runs a session, so everything
// that reads the payload applies only to the cases that do.
if (!SETUP) {
  check(payload !== null, "session never produced a payload");
  check(payload?.participant_data.completion_status === 1, "session did not complete");
  check(rows.length > 0, "no responses recorded");
  check(JSON.stringify(idxs) === JSON.stringify([...idxs].sort((a, b) => a - b)),
        `trial_index not monotonic: ${idxs}`);
  check(idxs[0] === 0 && idxs[idxs.length - 1] === rows.length - 1,
        `trial_index is not 0..${rows.length - 1}: ${idxs}`);
}

if (TIER2) {
  const conds = rows.map((r) => r.condition);
  check(new Set(conds).size === 3, `expected all of V/A/AV, got ${[...new Set(conds)]}`);
  const blocks = rows.map((r) => r.block_number);
  check(JSON.stringify(blocks) === JSON.stringify([...blocks].sort((a, b) => a - b)),
        `blocks interleaved: ${blocks}`);
  // Every block runs exactly one condition.
  const perBlock = new Map();
  for (const r of rows) {
    if (perBlock.has(r.block_number)) check(perBlock.get(r.block_number) === r.condition,
                                            `block ${r.block_number} mixed conditions`);
    else perBlock.set(r.block_number, r.condition);
  }
  // Shared mode: the same triplets judged under every condition.
  const byCond = {};
  for (const r of rows.filter((x) => !x.is_attention_trial)) {
    (byCond[r.condition] ??= []).push([...r.concept_triplet].sort().join("|"));
  }
  const keys = Object.values(byCond).map((v) => v.slice().sort().join(","));
  check(new Set(keys).size === 1, "shared mode did not yoke triplets across conditions");
  check(playCalls > 0, "a Tier 2 session played no stimulus audio at all");
  check(rows.some((r) => r.condition !== "V" && "playback_ms" in r),
        "A/AV rows carry no playback_ms");
} else {
  check(rows.every((r) => r.condition === "V"), "Tier 1 produced a non-visual trial");
}

fs.writeFileSync(`/tmp/js_browser_session${TIER2 ? "_tier2" : ""}.json`,
                 JSON.stringify(payload, null, 2));

console.log("cutscene panel clicks :", panelClicks);
console.log("responses recorded    :", rows.length);
console.log("trial_index range     :", idxs.length ? `${idxs[0]}..${idxs[idxs.length - 1]}` : "-");
if (TIER2) {
  console.log("conditions            :", [...new Set(rows.map((r) => r.condition))].join(", "));
  console.log("block order           :", (payload?.game_state?.castle?.rooms ?? [])
    .map((r) => r.condition).join(" -> "));
  console.log("stimulus play() calls :", playCalls);
}
if (SETUP) {
  check(setupSeen, "no setup form appeared for a URL without a pid");
  // The form must plan from sessionPlan, not from the config defaults of
  // 5 rooms x 3 trials -- that is what this case has always been for. The
  // session is no longer driven to completion; see the break above.
  check(/550/.test(setupPreview),
        `the form did not plan the flat 550 trials: ${setupPreview.trim()}`);
  check(/11 per room × 50 rooms/.test(setupPreview),
        `the form did not plan 50 rooms of 11: ${setupPreview.trim()}`);
  check(!/3 per room × 5 rooms/.test(setupPreview),
        "the form fell back to the config defaults instead of the plan");
}
if (CHS) {
  // The form must not appear, and the ids CHS supplied must reach the payload
  // -- they are the only way to join this session to the family afterwards.
  check(!setupSeen, "the setup form appeared for a family at home");
  check(payload?.participant_data.chs_child === "SG7JLN",
        `chs_child did not reach the payload: ` +
        `${payload?.participant_data.chs_child}`);
  check(payload?.participant_data.chs_response ===
          "d5c8f502-6588-46c8-84fa-a9657a44fe47",
        `chs_response did not reach the payload: ` +
        `${payload?.participant_data.chs_response}`);
  check(payload?.participant_data.participant_id === "SG7JLN",
        `the child hash should seed the session, got ` +
        `${payload?.participant_data.participant_id}`);
}

// Stickers only exist once a session is running, which the setup case never
// reaches.
if (!SETUP) {
  check(stickerImgs > 0, "no sticker was drawn from an image; they fell back to emoji text");
}
check(stickerTextOnly === 0,
      `${stickerTextOnly} sticker slots rendered as text rather than an image`);

console.log("sticker <img> samples :", stickerImgs, "| text-only slots:", stickerTextOnly);
console.log("rooms completed       :", payload?.game_state?.castle?.rooms
  .filter((r) => r.completed).length, "/", payload?.game_state?.castle?.rooms.length);
console.log("console warnings      :", warnings.length ? warnings : "none");
console.log("errors                :", errors.length ? errors : "none");
console.log("assertions            :", fail.length ? fail : "all passed");

process.exitCode = (errors.length || fail.length) ? 1 : 0;

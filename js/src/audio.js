/**
 * The Tier 2 audio conditions: A (sounds only) and AV (image + sound).
 * Port of _render_audio_trial / _render_av_trial / _play_next_sound in
 * experiments/two_tier_experiment.py.
 *
 *   THE RULE, AGAIN
 *   ---------------
 *   Same as the visual trial: feedback follows the ACT of responding, never
 *   the choice. `afterResponseText()` takes no argument and the highlight is
 *   the same neutral blue, imported from plugins.js so the two screens cannot
 *   drift apart.
 *
 *   WHAT IS SPECIFIC TO AUDIO
 *   -------------------------
 *   A sound is serial where an image is parallel: a child cannot re-look at
 *   sound 1 while sound 3 plays. So every item carries a replay button, the
 *   auto-play sequence is paced (not overlapped), and selection stops
 *   playback BEFORE anything else happens -- a clip still running under the
 *   feedback is a stimulus the child did not choose to hear.
 *
 *   AND THE THING A BROWSER ADDS
 *   ----------------------------
 *   Chrome blocks programmatic playback on a page the user has not interacted
 *   with. A blocked A-only trial is a SILENT trial: the child picks from
 *   nothing and the row looks like ordinary data. `primeAudio()` unlocks
 *   playback on the session's first click, and if a play() still rejects the
 *   trial is flagged so those rows can be filtered rather than analysed.
 */

import { SELECT_COLOUR, afterResponseText } from "./plugins.js";
import { playSfx } from "./sfx.js";

// Defaults match the desktop build. Exposed as plugin parameters (and as
// ?lead= / ?gap=) because pacing is a real design knob -- the clips run 1-2s
// and a younger child may need more space between them -- and because a test
// that had to sit through 9.8s per trial would not be run.
const LEAD_IN_MS = 800;    // settle before the first sound
const PER_SOUND_MS = 3000; // pacing between sounds; clips are ~1-2s

/** 0.05s of silence. Played on the first user gesture to unlock the tab. */
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let primed = false;

// Elements currently mounted by a stimulus trial. sfx.js consults this so a
// reward chime can never land over a Tier 2 clip -- the A and AV conditions
// measure an auditory judgment, and a sound played across one contaminates it.
let livePlayers = [];

/** True while any stimulus clip is sounding. */
export function stimulusAudioActive() {
  return livePlayers.some((p) => p && !p.paused && !p.ended);
}

/**
 * Unlock audio for the session, from inside a user gesture. Call it once and
 * it arms itself against the page's clicks until one actually succeeds.
 *
 * Retrying matters: the first click can fail to unlock (a click the browser
 * does not treat as activation, a tab that was never foregrounded), and a
 * one-shot listener would then leave the session muted for good. Every later
 * click gets another go, and priming stops the moment one works.
 */
export function primeAudio() {
  if (primed) return;
  const a = new Audio(SILENCE);
  a.volume = 0;
  const p = a.play();
  if (p && p.then) {
    p.then(() => { primed = true; }, () => { armPriming(); });
  } else {
    primed = true;
  }
}

/** Try again on the next click, until one unlocks playback. */
export function armPriming() {
  if (primed) return;
  document.addEventListener("click", primeAudio, { once: true });
}

export class AudioTripletPlugin {
  static info = {
    name: "triplet-odd-one-out-audio",
    version: "1.0.0",
    parameters: {
      audio: { type: "STRING", array: true },
      images: { type: "STRING", array: true, default: [] },  // AV only
      concepts: { type: "STRING", array: true },
      condition: { type: "STRING", default: "A" },           // "A" or "AV"
      prompt: { type: "STRING", default: "" },
      is_attention: { type: "BOOL", default: false },
      task_trial_index: { type: "INT", default: 0 },
      gamified: { type: "BOOL", default: true },
      mascot: { type: "STRING", default: "" },
      dialogue: { type: "OBJECT", default: {} },
      progress: { type: "OBJECT", default: null },
      currency_icon: { type: "STRING", default: "\u{1FA99}" },
      feedback_ms: { type: "INT", default: 800 },
      lead_in_ms: { type: "INT", default: LEAD_IN_MS },
      per_sound_ms: { type: "INT", default: PER_SOUND_MS },
    },
    data: {
      task_trial_index: { type: "INT" },
      concepts: { type: "STRING", array: true },
      selected_position: { type: "INT" },
      selected_concept: { type: "STRING" },
      is_attention: { type: "BOOL" },
      condition: { type: "STRING" },
      rt: { type: "FLOAT" },
      playback_ms: { type: "FLOAT" },
      autoplay_blocked: { type: "BOOL" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial, on_load) {
    const gm = trial.gamified;
    const av = trial.condition === "AV";
    const rng = trial.rng;

    const status = (text) => {
      const el = display.querySelector("#status");
      if (el) el.textContent = text;
    };

    display.innerHTML = `
      <div class="screen trial-screen">
        <div class="trial-main">
          <div class="band">
            <div class="bubble aside" id="aside"></div>
            ${gm && trial.mascot ? `<img class="pip" id="pip" src="${trial.mascot}" alt="">` : ""}
            <div class="bubble prompt">${trial.prompt}</div>
          </div>
          <p class="audio-status" id="status">${
            gm ? (av ? "Watch and listen..." : "Listening...") : "Starting playback..."}</p>
          <div class="stimuli audio-row" id="stimuli">
            ${trial.concepts.map((_, i) => `
              <div class="audio-card" data-i="${i}">
                ${av
                  ? `<img src="${trial.images[i]}" alt="">`
                  : `<div class="speaker" aria-hidden="true">\u{1F50A}</div>`}
                <button class="replay" data-replay="${i}">${
                  gm ? "Play it again" : `Replay Sound ${i + 1}`}</button>
                ${av ? "" : `<button class="pick" data-pick="${i}">${
                  gm ? "Pick this one" : "Select This Sound"}</button>`}
              </div>`).join("")}
          </div>
        </div>
        ${trial.progress ? `
          <div class="progress-row">
            <div class="progress-track"><div class="progress-fill" id="pfill"
              style="width:${(trial.progress.current / trial.progress.total) * 100}%"></div></div>
            ${trial.coin_balance ? `<span class="coins" id="coins">
              ${trial.currency_icon} ${trial.coin_balance()}</span>` : ""}
            <span class="level">Level ${trial.progress.level} of ${trial.progress.n_levels}</span>
          </div>` : ""}
      </div>`;

    const t0 = performance.now();
    let answered = false;
    let blocked = false;
    let playbackMs = null;    // when the auto-play sequence finished

    // One element per POSITION, not per concept: an attention trial repeats a
    // concept, and two positions sharing one element would make replaying
    // position 1 restart position 0's clip mid-sequence.
    const players = trial.audio.map((src) => {
      const a = new Audio(src);
      a.preload = "auto";
      return a;
    });
    // Published for the SFX gate; replaced per trial, and emptied when the
    // trial ends so a finished screen never reads as "stimulus playing".
    livePlayers = players;

    const stopAll = () => {
      for (const p of players) { p.pause(); try { p.currentTime = 0; } catch { /* not seekable yet */ } }
    };

    const play = (i) => {
      // Only one stimulus at a time. Overlapping clips are not the stimulus
      // the design specifies, and the child cannot tell them apart.
      stopAll();
      const p = players[i].play();
      if (p && p.catch) {
        p.catch(() => {
          if (blocked || answered) return;
          blocked = true;
          this.jsPsych.pluginAPI.clearAllTimeouts();
          status(gm ? "Tap \u{1F50A} Play it again to hear each one."
                    : "Playback blocked — use the replay buttons.");
          console.warn("[tier2] autoplay blocked; trial flagged", trial.task_trial_index);
        });
      }
    };

    // Paced sequence, one sound at a time, then an explicit "you may choose".
    const step = (i) => {
      if (answered || blocked) return;
      if (i >= trial.concepts.length) {
        playbackMs = performance.now() - t0;
        status(gm ? "That's all three! Pick one whenever you're ready."
                  : "All sounds played. Make your selection:");
        return;
      }
      status(gm ? `Sound ${i + 1}...` : `Playing Sound ${i + 1}`);
      play(i);
      this.jsPsych.pluginAPI.setTimeout(() => step(i + 1), trial.per_sound_ms);
    };
    this.jsPsych.pluginAPI.setTimeout(() => step(0), trial.lead_in_ms);

    const finish = (i) => {
      if (answered) return;
      answered = true;
      const rt = performance.now() - t0;
      // Silence the stimulus BEFORE any feedback, so the two never overlap.
      this.jsPsych.pluginAPI.clearAllTimeouts();
      stopAll();
      // The clips are stopped, so the SFX gate must stop reporting them as
      // live -- otherwise the select chime is swallowed on every audio trial.
      livePlayers = [];
      playSfx("select");

      const card = display.querySelector(`.audio-card[data-i="${i}"]`);
      card.style.outline = `4px solid ${SELECT_COLOUR}`;
      card.style.background = "rgba(124,156,214,0.18)";

      if (gm) {
        const aside = display.querySelector("#aside");
        aside.textContent = afterResponseText(trial.dialogue, rng);
        aside.classList.add("visible");
        const pip = display.querySelector("#pip");
        if (pip && trial.mascot_happy) pip.src = trial.mascot_happy;
        const fill = display.querySelector("#pfill");
        if (fill && trial.progress) {
          fill.style.width =
            `${((trial.progress.current + 1) / trial.progress.total) * 100}%`;
        }
        // Coins: pre-drawn once per trial at session start (see
        // CastleState.awardTrialCoins), never contingent on WHAT was
        // picked. Every trial pays, attention checks included.
        if (trial.award_coins) {
          const balance = trial.award_coins();
          const coinEl = display.querySelector("#coins");
          if (coinEl) coinEl.textContent = `${trial.currency_icon} ${balance}`;
        }
        // Stickers: which trial reveals which was also pre-drawn at session
        // start (see CastleState.awardTrialStickers), never contingent on
        // WHAT was picked. The popup/sfx live in the closure itself.
        if (trial.award_stickers) trial.award_stickers();
      }

      this.jsPsych.pluginAPI.setTimeout(() => {
        display.innerHTML = "";
        this.jsPsych.finishTrial({
          task_trial_index: trial.task_trial_index,
          concepts: trial.concepts,
          selected_position: i,
          selected_concept: trial.concepts[i],
          is_attention: trial.is_attention,
          condition: trial.condition,
          rt,
          playback_ms: playbackMs,
          autoplay_blocked: blocked,
        });
      }, trial.feedback_ms);
    };

    display.querySelectorAll("[data-replay]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();          // replaying is not choosing
        if (answered) return;
        // A replay during the sequence takes over: the child asked for this
        // sound, so the timer must not talk over it a moment later.
        this.jsPsych.pluginAPI.clearAllTimeouts();
        if (playbackMs === null) playbackMs = performance.now() - t0;
        blocked = false;
        status(gm ? "Pick one whenever you're ready."
                  : "Make your selection:");
        play(Number(b.dataset.replay));
      }));

    if (av) {
      // The whole card is the target: an image is the obvious thing to tap.
      display.querySelectorAll(".audio-card").forEach((c) =>
        c.addEventListener("click", () => finish(Number(c.dataset.i))));
    } else {
      // A-only has no image, so a dedicated button says what tapping does.
      display.querySelectorAll("[data-pick]").forEach((b) =>
        b.addEventListener("click", () => finish(Number(b.dataset.pick))));
    }

    if (on_load) on_load();
  }
}

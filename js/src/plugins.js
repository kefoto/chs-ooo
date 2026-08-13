/**
 * jsPsych plugins for the task. Targets jsPsych 8.
 *
 *   THE RULE EVERYTHING FOLLOWS
 *   ---------------------------
 *   The odd-one-out task has NO correct answer on regular trials. Feedback is
 *   a function of the ACT of responding, never of WHAT was chosen. Concretely,
 *   in this file: `afterResponseText()` takes no argument, the selection
 *   highlight is a neutral blue (never success-green or error-red), and no
 *   code path branches on which image was clicked. Breaking that does not
 *   throw -- it silently teaches children a similarity structure and corrupts
 *   every embedding built from the data afterwards.
 */

import { playSfx } from "./sfx.js";

// Exported so the audio conditions highlight identically. One definition, so
// "never green, never red" cannot drift apart between the V and A/AV screens.
export const SELECT_COLOUR = "#7C9CD6";   // deliberately not green, and not red

/** Identical acknowledgement whatever was picked. Takes no arguments. */
export function afterResponseText(bank, rng) {
  const lines = bank.after_response || ["Okay!"];
  return lines[Math.floor(rng.random() * lines.length)];
}

/** Three images; click one. */
export class TripletPlugin {
  static info = {
    name: "triplet-odd-one-out",
    version: "1.0.0",
    parameters: {
      images: { type: "STRING", array: true },
      concepts: { type: "STRING", array: true },
      prompt: { type: "STRING", default: "" },
      is_attention: { type: "BOOL", default: false },
      // NOT `trial_index`: jsPsych reserves that name and writes its own
      // global timeline index over whatever a plugin puts there. That index
      // counts story screens and playgrounds too, so the saved rows came out
      // 5,6,7,11,12,13,... instead of 0..N-1 -- silently different from the
      // desktop build, where trial_index indexes the TRIAL list.
      task_trial_index: { type: "INT", default: 0 },
      gamified: { type: "BOOL", default: true },
      mascot: { type: "STRING", default: "" },
      dialogue: { type: "OBJECT", default: {} },
      progress: { type: "OBJECT", default: null },
      currency_icon: { type: "STRING", default: "\u{1FA99}" },
      feedback_ms: { type: "INT", default: 800 },
    },
    data: {
      task_trial_index: { type: "INT" },
      concepts: { type: "STRING", array: true },
      selected_position: { type: "INT" },
      selected_concept: { type: "STRING" },
      is_attention: { type: "BOOL" },
      rt: { type: "FLOAT" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial, on_load) {
    const rng = trial.rng;
    const gm = trial.gamified;

    display.innerHTML = `
      <div class="screen trial-screen">
        <!-- Everything above the progress bar lives in one centred block, so
             the stimuli sit in the middle of the free space instead of
             hugging the top with the bar pushed to the floor. -->
        <div class="trial-main">
          <div class="band">
            <div class="bubble aside" id="aside"></div>
            ${gm && trial.mascot ? `<img class="pip" id="pip" src="${trial.mascot}" alt="">` : ""}
            <div class="bubble prompt">${trial.prompt}</div>
          </div>
          <div class="stimuli" id="stimuli">
            ${trial.images.map((src, i) => `
              <button class="stimulus" data-i="${i}" aria-label="choice ${i + 1}">
                <img src="${src}" alt="">
              </button>`).join("")}
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
    let answered = false;     // one response per trial; children tap repeatedly

    const finish = (i) => {
      if (answered) return;
      answered = true;
      const rt = performance.now() - t0;
      // Acknowledges the tap, not the answer: it is the same sound whichever
      // card was picked, so it cannot teach a similarity structure.
      playSfx("select");

      const btn = display.querySelector(`.stimulus[data-i="${i}"]`);
      btn.style.outline = `4px solid ${SELECT_COLOUR}`;
      btn.style.background = "rgba(124,156,214,0.18)";

      if (gm) {
        // Feedback that cannot see the choice: no argument is passed in.
        display.querySelector("#aside").textContent =
          afterResponseText(trial.dialogue, rng);
        display.querySelector("#aside").classList.add("visible");
        const pip = display.querySelector("#pip");
        if (pip && trial.mascot_happy) pip.src = trial.mascot_happy;
        const fill = display.querySelector("#pfill");
        if (fill && trial.progress) {
          fill.style.width =
            `${((trial.progress.current + 1) / trial.progress.total) * 100}%`;
        }
        // Coins: pre-drawn once per trial at session start (see
        // CastleState.awardTrialCoins), never contingent on WHAT was
        // picked -- the same rule the neutral aside text above follows.
        // Every trial pays, attention checks included.
        if (trial.award_coins) {
          const balance = trial.award_coins();
          const coinEl = display.querySelector("#coins");
          if (coinEl) coinEl.textContent = `${trial.currency_icon} ${balance}`;
        }
        // Stickers: which trial reveals which was also pre-drawn at session
        // start (see CastleState.awardTrialStickers), never contingent on
        // WHAT was picked. Rare compared to coins -- most calls return
        // nothing. The popup/sfx live in the closure itself; nothing to do
        // with the result here.
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
          rt,
        });
      }, trial.feedback_ms);
    };

    display.querySelectorAll(".stimulus").forEach((b) =>
      b.addEventListener("click", () => finish(Number(b.dataset.i))));
    if (on_load) on_load();
  }
}

/** A story/instruction screen that advances on a button (or SPACE). */
export class ScreenPlugin {
  static info = {
    name: "castle-screen",
    version: "1.0.0",
    parameters: {
      html: { type: "HTML_STRING", default: "" },
      button: { type: "STRING", default: "Next" },
      allow_space: { type: "BOOL", default: true },
      // Optional secondary, visually recessive button (shop addition) --
      // e.g. "Visit the shop" alongside "Put them in the castle!". Omit for
      // every screen that doesn't need one; existing callers are unaffected.
      quiet_button: { type: "STRING", default: "" },
    },
    data: { rt: { type: "FLOAT" }, chose_quiet: { type: "BOOL" } },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial) {
    display.innerHTML = `
      <div class="screen">${trial.html}
        <div class="btn-row">
          ${trial.quiet_button ? `<button class="quiet" id="quiet">${trial.quiet_button}</button>` : ""}
          <button class="big" id="go">${trial.button}</button>
        </div>
      </div>`;
    const t0 = performance.now();
    const done = (choseQuiet) => {
      if (key) document.removeEventListener("keydown", key);
      display.innerHTML = "";
      this.jsPsych.finishTrial({ rt: performance.now() - t0, chose_quiet: choseQuiet });
    };
    display.querySelector("#go").addEventListener("click", () => done(false));
    const quietBtn = display.querySelector("#quiet");
    if (quietBtn) quietBtn.addEventListener("click", () => done(true));
    const key = trial.allow_space
      ? (e) => { if (e.code === "Space") done(false); }
      : null;
    if (key) document.addEventListener("keydown", key);
  }
}

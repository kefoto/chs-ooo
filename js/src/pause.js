/**
 * Mid-trial pause overlay + the inactivity nudge, shared by TripletPlugin
 * and AudioTripletPlugin. Port of _show_pause_screen / nudge_timer /
 * pose_timer / _on_nudge in experiments/two_tier_experiment.py.
 *
 *   Why an overlay, not a screen change
 *   ------------------------------------
 *   A trial is only recorded when a selection is made, so pausing cannot
 *   lose data by construction -- there is nothing to lose. The desktop
 *   build re-shows the SAME trial on resume (rebuilding the screen from
 *   scratch, which resets its own response-time clock); the overlay here is
 *   the jsPsych-shaped equivalent -- the trial's own DOM and listeners stay
 *   alive underneath it the whole time, and resuming just resets the
 *   caller's own `t0` the same way a rebuild would.
 *
 *   Simplification from the desktop build
 *   --------------------------------------
 *   An audio trial's auto-play sequence is not restarted from the top on
 *   resume (the desktop's full-screen rebuild does this for free; nothing
 *   here re-drives that sequence). Every card keeps its own "Play it again"
 *   button, so nothing is unreachable -- a paused-and-resumed audio trial
 *   just doesn't replay automatically the way a freshly-shown one does.
 */

import { playSfx } from "./sfx.js";

/**
 * Wire a pause affordance into an already-rendered trial screen.
 *
 * @param {HTMLElement} display
 * @param {object} opts
 * @param {boolean} opts.gamified   no-op (returns null) when false -- pause
 *                                  is part of the game layer, not the plain arm
 * @param {string} [opts.mascot]   idle mascot image url
 * @param {string} [opts.pausedText]
 * @param {Function} opts.onOpen    () -> void, called just before the overlay shows
 *                                  (stop stimulus audio, clear the nudge timer)
 * @param {Function} opts.onResume  () -> void, called on "Carry on"
 *                                  (reset the rt clock, re-arm the nudge timer)
 * @returns {{open: Function}|null}
 */
export function mountPause(display, { gamified, mascot, pausedText, onOpen, onResume }) {
  if (!gamified) return null;

  const btn = document.createElement("button");
  btn.className = "pause-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Pause");
  btn.textContent = "⏸";
  display.appendChild(btn);

  const overlay = document.createElement("div");
  overlay.className = "pause-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="screen">
      ${mascot ? `<img class="pip big-pip" src="${mascot}" alt="">` : ""}
      <p class="speech">${pausedText || "We're paused. Nothing's lost."}</p>
      <div class="btn-row"><button class="big" id="pause-resume">Carry on</button></div>
    </div>`;
  display.appendChild(overlay);

  const open = () => {
    onOpen?.();
    overlay.hidden = false;
  };
  btn.addEventListener("click", open);
  overlay.querySelector("#pause-resume").addEventListener("click", () => {
    overlay.hidden = true;
    onResume?.();
  });

  return { open };
}

/**
 * Arm a one-shot inactivity nudge. Returns a controller with `clear()` (call
 * on pause and on answering) and `rearm()` (call on resume/trial start).
 * `isStimulusActive`, if given, defers rather than firing over a Tier 2
 * clip -- mirrors _on_nudge's "never talk over a stimulus; try again
 * shortly" retry.
 *
 * @param {object} opts
 * @param {number} opts.afterMs
 * @param {Function} opts.onNudge          () -> void
 * @param {Function} [opts.isStimulusActive]
 */
export function armNudgeTimer({ afterMs, onNudge, isStimulusActive }) {
  let handle = null;
  const clear = () => { if (handle) clearTimeout(handle); handle = null; };
  const rearm = () => {
    clear();
    handle = setTimeout(function fire() {
      if (isStimulusActive?.()) { handle = setTimeout(fire, 2000); return; }
      onNudge();
    }, afterMs);
  };
  return { clear, rearm };
}

/** Gentle re-engagement bubble + sound. Deliberately content-free -- it
 * must not hint at an answer or imply the child is taking too long. */
export function showNudge(display, text) {
  playSfx("nudge");
  const aside = display.querySelector("#aside");
  if (aside && text) {
    aside.textContent = text;
    aside.classList.add("visible");
  }
}

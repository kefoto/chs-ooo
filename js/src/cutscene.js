/**
 * Cross-fading story panels with a dialogue box. Port of
 * experiments/cutscene.py (CutscenePlayer).
 *
 *   Why two stacked images rather than swapping one src
 *   ---------------------------------------------------
 *   Two layers with an animated opacity on the top one give a real cross-fade
 *   with no flash of background between panels. Swapping the src on a single
 *   image cannot do that, and a flash is exactly the kind of abrupt visual
 *   change reduced-stimulation mode exists to suppress.
 *
 * The dialogue box is drawn by the app across the bottom of the panel rather
 * than baked into the artwork: the text comes from the dialogue bank, which is
 * translatable and lint-checked, and the art stays reusable. Panel artwork is
 * composed to keep its bottom ~20% visually calm for this reason.
 *
 * The whole scene is ONE plugin, not one plugin per panel, because a
 * cross-fade needs the outgoing and incoming panels alive at the same moment.
 * Advancing is a click anywhere, or SPACE for an adult sitting alongside.
 */

export class CutscenePlugin {
  static info = {
    name: "castle-cutscene",
    version: "1.0.0",
    parameters: {
      // [{ image, text }] -- resolved from manifest.cutscene[which] against
      // the dialogue bank, exactly as game_layer.cutscene_panels does.
      panels: { type: "OBJECT", array: true, default: [] },
      fade_ms: { type: "INT", default: 450 },
      box_rel: { type: "FLOAT", default: 0.18 },
    },
    data: {
      panels_shown: { type: "INT" },
      rt: { type: "FLOAT" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial) {
    const panels = trial.panels.filter(Boolean);
    if (!panels.length) { this.jsPsych.finishTrial({ panels_shown: 0, rt: 0 }); return; }

    display.innerHTML = `
      <div class="screen cutscene" id="scene">
        <div class="cut-stage">
          <img class="cut-layer" id="under" alt="">
          <img class="cut-layer" id="top" alt="">
          <div class="cut-box" style="min-height:${trial.box_rel * 100}%">
            <p class="cut-text" id="ctext"></p>
            <span class="cut-hint" id="chint"></span>
          </div>
        </div>
      </div>`;

    const under = display.querySelector("#under");
    const top = display.querySelector("#top");
    const text = display.querySelector("#ctext");
    const hint = display.querySelector("#chint");

    const t0 = performance.now();
    let i = 0;
    let fading = false;

    const paint = (n) => {
      text.textContent = panels[n].text || "";
      hint.textContent = n === panels.length - 1 ? "tap to begin" : "tap to continue";
    };

    under.src = panels[0].image || "";
    top.style.opacity = "0";
    paint(0);

    const done = () => {
      document.removeEventListener("keydown", onKey);
      display.innerHTML = "";
      this.jsPsych.finishTrial({
        panels_shown: panels.length,
        rt: performance.now() - t0,
      });
    };

    const advance = () => {
      // Ignore taps during a fade: a child tapping repeatedly must not skip a
      // panel they have not seen yet.
      if (fading) return;
      if (i >= panels.length - 1) { done(); return; }

      const next = panels[++i];
      // Same image twice in a row (the manifest does this deliberately, to
      // hold a scene while the text changes) needs no fade at all.
      if (!trial.fade_ms || next.image === panels[i - 1].image) {
        under.src = next.image || "";
        paint(i);
        return;
      }

      fading = true;
      top.src = next.image || "";
      top.style.transition = "none";
      top.style.opacity = "0";
      void top.offsetWidth;                       // commit the 0 before animating
      top.style.transition = `opacity ${trial.fade_ms}ms ease-in-out`;
      top.style.opacity = "1";
      // Text changes with the panel, as it does in the desktop build.
      paint(i);

      const settle = () => {
        under.src = top.src;
        top.style.transition = "none";
        top.style.opacity = "0";
        fading = false;
      };
      this.jsPsych.pluginAPI.setTimeout(settle, trial.fade_ms + 20);
    };

    const onKey = (e) => { if (e.code === "Space") { e.preventDefault(); advance(); } };
    display.querySelector("#scene").addEventListener("click", advance);
    document.addEventListener("keydown", onKey);
  }
}

/**
 * Resolve manifest.cutscene[which] against the dialogue bank.
 *
 * Returns [] when NO panel has usable art, which is the caller's signal to
 * fall back to the text-only cutscene. Art is made after the code, so a
 * half-populated folder must degrade rather than show a child blank frames.
 */
export function resolvePanels(manifest, dialogue, which, assetRoot, usable) {
  const spec = manifest.cutscene?.[which] ?? [];
  const lines = dialogue[`cutscene_${which}`] ?? [];
  let anyArt = false;
  const panels = spec.filter((e) => e && typeof e === "object").map((e) => {
    const idx = e.line ?? 0;
    const url = e.image ? `${assetRoot}/${e.image}` : "";
    const ok = url && (!usable || usable.has(url));
    if (ok) anyArt = true;
    return { image: ok ? url : "", text: (idx >= 0 && idx < lines.length) ? lines[idx] : "" };
  });
  return anyArt ? panels : [];
}

/**
 * Which of these URLs actually load. Used to decide the fallback above.
 *
 * Panels are large, and this runs before the first screen, so a URL that
 * neither loads nor errors -- a stalled asset server, an environment that
 * does not fetch images at all -- would hang session start with a child
 * waiting. Anything not settled by `timeoutMs` counts as unusable, which
 * degrades to the text-only cutscene instead of to nothing.
 */
export function probeImages(urls, timeoutMs = 8000) {
  const list = [...new Set(urls)].filter(Boolean);
  if (!list.length || typeof Image === "undefined") return Promise.resolve(new Set());
  return Promise.all(list.map((u) => new Promise((res) => {
    const t = setTimeout(() => res(null), timeoutMs);
    const settle = (v) => { clearTimeout(t); res(v); };
    const im = new Image();
    im.onload = () => settle(u);
    im.onerror = () => settle(null);
    im.src = u;
  }))).then((r) => new Set(r.filter(Boolean)));
}

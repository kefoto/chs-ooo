/**
 * Background music for the opening and closing cutscenes: the browser
 * counterpart to GameLayer.play_music()/stop_music() in
 * experiments/game_layer.py.
 *
 * One clip plays under a cutscene -- panel art or the text-only fallback
 * alike -- and stops the moment the cutscene ends. It never plays during a
 * trial, so it can never land over Tier 2 stimulus audio the way `sfx.js`
 * already guards against for the short UI chimes.
 *
 * Both ends fade rather than cut: starting under speech and panel art, a
 * track snapping straight to full volume (or straight to silence mid-scene)
 * reads as a glitch. Switching tracks (one playMusic() call replacing
 * another) is the one case that cuts immediately -- only the silence at
 * either end of a single track fades, matching GameLayer's desktop
 * counterpart.
 *
 * Muting follows `Gamify_Mute_SFX`, the same flag and precedence `sfx.js`
 * applies -- cutscene music is not a separate toggle a parent has to find.
 */

const TARGET_VOLUME = 0.35;          // background, not a chime -- stays under speech
const STEP_MS = 40;                  // ~25 volume updates/sec, smooth without busywork

let muted = false;
let root = "";
let tracks = {};              // key -> path, relative to `root`
let fadeMs = 1200;
let current = null;           // the one HTMLAudioElement playing, if any

function clearRamp(el) {
  if (el._fadeTimer) {
    clearInterval(el._fadeTimer);
    el._fadeTimer = null;
  }
}

/** Linearly ramp `el.volume` to `target` over `duration` ms, then call `onDone`. */
function rampVolume(el, target, duration, onDone) {
  clearRamp(el);
  if (!duration || duration <= 0) {
    el.volume = target;
    if (onDone) onDone();
    return;
  }
  const start = el.volume;
  const t0 = Date.now();
  el._fadeTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - t0) / duration);
    el.volume = start + (target - start) * t;
    if (t >= 1) {
      clearRamp(el);
      if (onDone) onDone();
    }
  }, STEP_MS);
}

/** Cut whatever is playing immediately -- no fade. Used only when switching tracks. */
function hardStop() {
  if (current) {
    clearRamp(current);
    current.pause();
    current = null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.assetRoot  where the manifest's paths resolve from
 * @param {object} opts.music      manifest.music
 * @param {boolean} opts.muted     Gamify_Mute_SFX, after the reduced-motion implication
 * @param {number} [opts.fadeMs]   manifest.music.fade_ms, capped by reduced motion
 */
export function initMusic({ assetRoot, music, muted: isMuted, fadeMs: fade }) {
  root = String(assetRoot ?? "").replace(/\/+$/, "");
  tracks = music ?? {};
  muted = Boolean(isMuted);
  fadeMs = Number.isFinite(fade) ? Number(fade) : 1200;
  hardStop();
}

/** Start a cutscene track by manifest key, fading in. Cuts anything already playing. */
export function playMusic(key) {
  hardStop();
  if (muted) return;
  const rel = tracks[key];
  if (!rel) return;

  const el = new Audio(`${root}/${rel}`);
  el.volume = 0;
  current = el;
  // A rejected play() is an autoplay block, not a bug worth surfacing to a
  // parent: the cutscene is still perfectly usable without its music.
  const p = el.play();
  if (p && p.catch) p.catch(() => {});
  rampVolume(el, TARGET_VOLUME, fadeMs);
}

/** Fade out and stop the cutscene track, if any. Safe to call with nothing playing. */
export function stopMusic() {
  if (!current) return;
  const el = current;
  current = null;
  rampVolume(el, 0, fadeMs, () => el.pause());
}

/** For tests and for a session that mutes partway through. */
export function setMusicMuted(value) {
  muted = Boolean(value);
  if (muted) hardStop();
}

export function musicMuted() {
  return muted;
}

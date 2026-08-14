/**
 * Background music for the opening/closing cutscenes and the mansion's
 * playground/shop screens: the browser counterpart to GameLayer.play_music()/
 * stop_music() in experiments/game_layer.py.
 *
 * A cutscene track plays once under it -- panel art or the text-only
 * fallback alike -- and stops the moment the cutscene ends. The playground
 * and shop tracks LOOP for as long as that screen is open (untimed) and
 * stop the moment the child leaves for a different "place" -- see
 * js/src/mansion.js's showRoom/showShop/showGrid. Neither ever plays during
 * a trial, so it can never land over Tier 2 stimulus audio the way `sfx.js`
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
// Which manifest key `current` is playing. Lets playMusic() recognise a
// request for the track ALREADY playing and leave it alone -- the mansion
// calls it on every screen it shows (grid, room, arcade, result), and
// without this the loop would restart from zero on each hop, which is the
// one thing a continuous background track must not do.
let currentKey = "";

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
  currentKey = "";
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

/**
 * Start a track by manifest key, fading in. Cuts anything already playing.
 * `loop: true` for an untimed screen (playground/shop) that should keep
 * playing until stopMusic() is called; omit for a cutscene's one-shot clip.
 *
 * Asking for the LOOPING track that is already playing does nothing at all,
 * rather than restarting it. That is what lets a caller treat "this screen
 * has playground music" as a property of the screen and simply say so on
 * every one of them: the mansion's grid, rooms, game rooms and result
 * screens all call this with "playground", and the track runs unbroken
 * across the whole visit instead of stuttering back to zero at each hop.
 * A DIFFERENT key (the shop) still cuts and switches, and a one-shot
 * cutscene clip still restarts, since neither is the same looping track.
 */
export function playMusic(key, { loop = false } = {}) {
  if (loop && current && currentKey === key && !current.paused) return;
  hardStop();
  if (muted) return;
  const rel = tracks[key];
  if (!rel) return;

  const el = new Audio(`${root}/${rel}`);
  el.volume = 0;
  el.loop = loop;
  current = el;
  currentKey = key;
  // A rejected play() is an autoplay block, not a bug worth surfacing to a
  // parent: the cutscene is still perfectly usable without its music. But
  // unlike a UI chime, this can be the very FIRST thing the session tries
  // to play -- the opening cutscene's on_start fires before any click when
  // a study link skips the setup form -- so there is no earlier click for
  // audio.js's armPriming() to have unlocked the tab on yet. Retry once on
  // the next click, the same mechanism, scoped to this exact element so a
  // fast tapper who has already moved past this track (or stopped it)
  // does not have it resume under whatever is playing now.
  const p = el.play();
  if (p && p.catch) {
    p.catch(() => {
      const retry = () => {
        if (current !== el) return;
        const p2 = el.play();
        if (p2 && p2.catch) p2.catch(() => {});
      };
      document.addEventListener("click", retry, { once: true });
    });
  }
  rampVolume(el, TARGET_VOLUME, fadeMs);
}

/** Fade out and stop the cutscene track, if any. Safe to call with nothing playing. */
export function stopMusic() {
  if (!current) return;
  const el = current;
  current = null;
  currentKey = "";
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

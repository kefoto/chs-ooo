/**
 * Game sound effects: the browser counterpart to GameLayer.play() in
 * experiments/game_layer.py.
 *
 * The five clips are named in the manifest under `sounds` -- select,
 * level_up, sticker, nudge, finish -- and the desktop build has played them
 * since the game layer existed. This port did not, so every browser session
 * ran silent except for Tier 2 stimulus audio.
 *
 *     Why game sound is gated on the stimulus
 *     ---------------------------------------
 *     In the Tier 2 A and AV conditions the judgment being measured IS an
 *     auditory one. A reward chime landing over a stimulus clip contaminates
 *     it, so `play()` refuses while stimulus audio is sounding rather than
 *     leaving the timing to each caller to remember. The desktop build states
 *     the same rule in GameLayer.play()'s docstring and enforces it at the
 *     call sites; here it is enforced in one place.
 *
 * Volume matches the desktop's 0.5. Muting follows `Gamify_Mute_SFX`, which
 * reduced-motion mode implies unless the session set it explicitly -- the same
 * precedence GameLayer applies.
 */

let muted = false;
let root = "";
let names = {};                 // key -> path, relative to `root`
const cache = new Map();        // key -> HTMLAudioElement
let stimulusActive = () => false;

/**
 * @param {object} opts
 * @param {string} opts.assetRoot   where the manifest's paths resolve from
 * @param {object} opts.sounds      manifest.sounds
 * @param {boolean} opts.muted      Gamify_Mute_SFX, after the reduced-motion implication
 * @param {function} [opts.isStimulusActive] true while a stimulus clip sounds
 */
export function initSfx({ assetRoot, sounds, muted: isMuted, isStimulusActive }) {
  root = String(assetRoot ?? "").replace(/\/+$/, "");
  names = sounds ?? {};
  muted = Boolean(isMuted);
  if (isStimulusActive) stimulusActive = isStimulusActive;
  cache.clear();
}

/** Play a UI sound by manifest key. Silent and safe if anything is missing. */
export function playSfx(key) {
  if (muted) return;
  const rel = names[key];
  if (!rel) return;                       // key not in the manifest
  if (stimulusActive()) return;           // never over a stimulus clip

  let el = cache.get(key);
  if (!el) {
    el = new Audio(`${root}/${rel}`);
    el.volume = 0.5;                      // matches QSoundEffect setVolume(0.5)
    cache.set(key, el);
  }
  // Restart rather than ignore: stickers are awarded in quick succession and
  // a second one must be audible, not swallowed because the first is running.
  try { el.currentTime = 0; } catch { /* not seekable until it has loaded */ }
  // A rejected play() is an autoplay block, not a bug worth surfacing to a
  // parent: the game is still perfectly playable without its chimes.
  const p = el.play();
  if (p && p.catch) p.catch(() => {});
}

/** For tests and for a session that mutes partway through. */
export function setSfxMuted(value) {
  muted = Boolean(value);
}

export function sfxMuted() {
  return muted;
}

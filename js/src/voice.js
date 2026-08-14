/**
 * Narrated dialogue lines: the browser counterpart to GameLayer.speak() /
 * speak_all() / speak_keys() in experiments/game_layer.py.
 *
 * Recordings live at assets/game/voice/<key>_<index>.wav, one per line of
 * dialogue_en.json -- the same addressing utilities/generate_voiceover.py
 * uses (and that a manual ElevenLabs export was renamed into), so this reads
 * the exact same files the desktop build plays. `voice_manifest.json` lists
 * which (key, index) pairs actually have a recording; initVoice() fetches it
 * once so speak() can skip a missing line without a failing network request
 * every time it is called -- the browser equivalent of the desktop's
 * os.path.exists() check.
 *
 * Not gated on Gamify_Mute_SFX (unlike sfx.js): that flag is scoped to UI
 * sound effects, and a narrated dialogue line is content, not decoration --
 * the desktop build makes the same choice in GameLayer.speak().
 *
 *     Why speakAll/speakKeys queue instead of playing together
 *     ----------------------------------------------------------
 *     Most screens here page one dialogue line at a time (Next/Space
 *     between them), so on_start firing once per screen is naturally
 *     non-overlapping. The one exception is the instructions screen, which
 *     shows every line of instructions_tier1/_tier2 stacked at once -- for
 *     that, speakAll chains the recordings so they don't talk over each
 *     other, exactly like the desktop build's cutscene/instructions screens.
 */

let root = "";
let known = new Set();          // "<key>_<index>" slugs with a recording
const cache = new Map();        // path -> HTMLAudioElement

/**
 * @param {object} opts
 * @param {string} opts.assetRoot  where assets/game resolves from (cfg.asset_root)
 */
export async function initVoice({ assetRoot }) {
  root = String(assetRoot ?? "").replace(/\/+$/, "");
  cache.clear();
  known = new Set();
  try {
    const r = await fetch(`${root}/voice/voice_manifest.json`);
    if (r.ok) {
      const manifest = await r.json();
      known = new Set(Object.keys(manifest.lines ?? {}));
    }
  } catch {
    // No voice bank published yet (e.g. local dev without the file, or a
    // network hiccup) -- every speak() call below stays a silent no-op.
  }
}

function voicePath(key, index) {
  return `${root}/voice/${key}_${index}.wav`;
}

function elementFor(path) {
  let el = cache.get(path);
  if (!el) {
    el = new Audio(path);
    el.volume = 0.9;
    cache.set(path, el);
  }
  return el;
}

/**
 * Silence narration, including a queue that is mid-chain.
 *
 * Clearing `onended` before pausing is what actually ends a queue: leaving it
 * connected would let a later event start the next line under a screen that
 * has moved on. Counterpart to GameLayer.stop_voice().
 */
export function stopVoice() {
  for (const el of cache.values()) {
    el.onended = null;
    el.onerror = null;
    el.pause();
    try { el.currentTime = 0; } catch { /* not seekable until loaded */ }
  }
}

/** Play the recorded line for dialogue[key][index]. Silent no-op if none exists. */
export function speak(key, index) {
  if (index == null || !known.has(`${key}_${index}`)) return;
  // One narrated line at a time -- a child tapping through the cutscene
  // panels must not leave the previous line running under the new one.
  stopVoice();
  const el = elementFor(voicePath(key, index));
  el.onended = null;
  el.onerror = null;
  try { el.currentTime = 0; } catch { /* not seekable until loaded */ }
  // A rejected play() is an autoplay block, not a bug worth surfacing --
  // the game is still perfectly playable as text-only. Matches sfx.js.
  const p = el.play();
  if (p && p.catch) p.catch(() => {});
}

/** Speak every line of `key`, back to back, in the order dialogue[key] lists them. */
export function speakAll(dialogue, key) {
  const opts = dialogue[key] ?? [];
  speakKeys(opts.map((_, i) => [key, i]));
}

/**
 * Speak a sequence of [key, index] pairs, back to back, in order. Any pair
 * with no recording is dropped before queueing, so a partially-filled voice
 * bank still speaks the lines it has instead of stalling on a gap.
 */
export function speakKeys(spec) {
  stopVoice();
  playQueue(spec.filter(([key, index]) => index != null && known.has(`${key}_${index}`)));
}

function playQueue(spec) {
  if (!spec.length) return;
  const [[key, index], ...rest] = spec;
  const el = elementFor(voicePath(key, index));
  el.onended = null;
  el.onerror = null;
  if (rest.length) {
    // `onerror` also advances: a corrupt/unreachable file must not stall
    // the rest of the queue.
    const advance = () => { el.onended = null; el.onerror = null; playQueue(rest); };
    el.onended = advance;
    el.onerror = advance;
  }
  try { el.currentTime = 0; } catch { /* not seekable until loaded */ }
  const p = el.play();
  if (p && p.catch) p.catch(() => { if (rest.length) playQueue(rest); });
}

/**
 * Where the browser build gets its art.
 *
 * The PNGs under assets/game/ are drawn for the DESKTOP build, which reads
 * them off a local disk: a room backdrop is ~1.1MB, a furniture cutout
 * ~470KB, a cutscene panel ~4MB. This build fetches them over a home
 * connection onto a family's tablet, and the mansion grid wants nine room
 * images at once. utilities/build_web_assets.py writes web-sized WebP copies
 * next to them (98% smaller for the flat vector art this game uses); this
 * module is what picks one.
 *
 *     It must degrade, not depend
 *     ---------------------------
 *     No web/assets.json, or a path missing from it, returns the original
 *     PNG. A plain checkout with no derivatives runs exactly as it did
 *     before, just heavier -- which is what keeps the pipeline an
 *     optimisation rather than a build step the study cannot start without.
 *
 *     Fetch one screen ahead, not everything
 *     --------------------------------------
 *     Preloading the whole bank at session start would put ~4MB in front of
 *     a child before they see anything. prefetch() is called from the screen
 *     BEFORE the one that needs the art -- the sticker book fetches the
 *     mansion's tiles while it is up -- and idlePrefetch() mops up the rest
 *     when the browser says it is idle.
 */

let root = "../assets/game";
let index = null;                 // parsed web/assets.json, or null
let ready = null;                 // the in-flight fetch, so it happens once
const decoded = new Map();        // url -> Promise<HTMLImageElement>

/**
 * Point the module at an asset root and read the derivative index once.
 * Safe to await more than once, and safe never to await at all: every
 * accessor below works (falling back to the PNG) before it resolves.
 */
export function initAssets(assetRoot) {
  root = assetRoot || root;
  if (ready) return ready;
  ready = fetch(`${root}/web/assets.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => { index = data; return data; })
    .catch(() => {
      // No derivatives here (a plain checkout, or a media host that has not
      // published them). Every call below falls back to the PNG.
      index = null;
      return null;
    });
  return ready;
}

/** True once initAssets has finished, whatever it found. */
export function assetsReady() {
  return ready ? ready.then(() => Boolean(index)) : Promise.resolve(false);
}

function entryFor(rel) {
  if (!index || !rel) return null;
  return index.entries?.[String(rel).replace(/^\/+/, "")] || null;
}

/**
 * The URL to draw `rel` at.
 *
 * `size` is "x1" (the size it is drawn at), "x2" (retina) or "thumb" (the
 * mansion grid's 3x3). A kind with no thumbnail falls through to x1 rather
 * than to the PNG -- a 5KB full-size WebP is still a better tile than a
 * 470KB source.
 */
export function assetUrl(rel, size = "x1", fallbackRoot = null) {
  if (!rel) return "";
  const entry = entryFor(rel);
  const file = entry && (entry.files[size] || entry.files.x1);
  if (file) return `${root}/web/${file.path}`;
  // `fallbackRoot` is for a caller that already knows the root and may run
  // before (or without) initAssets -- resolvePanels in cutscene.js, and its
  // tests, which pass their own.
  return `${fallbackRoot || root}/${rel}`;
}

/**
 * The URL to PLAY `rel` from: the AAC copy where there is one, else the
 * source WAV.
 *
 * Same index and the same degrade-don't-depend rule as assetUrl, for the same
 * reason at a larger scale -- the music is 24-bit 48kHz PCM authored for the
 * desktop's QSoundEffect fallback (which decodes nothing else), and one track
 * is ~23MB of it. utilities/build_web_audio.py writes the derivatives.
 *
 * Resolved per play rather than once at init: initMusic/initVoice run before
 * initAssets has read the index, so a URL captured at init time would always
 * be the WAV.
 */
export function audioUrl(rel) {
  if (!rel) return "";
  const file = entryFor(rel)?.files?.audio;
  return file ? `${root}/web/${file.path}` : `${root}/${rel}`;
}

/** `srcset` for an <img>, so a retina screen picks the 2x itself. Empty when
 * there are no derivatives, which leaves a plain src doing the work. */
export function srcsetFor(rel) {
  const entry = entryFor(rel);
  if (!entry || !entry.files.x2) return "";
  return `${assetUrl(rel, "x1")} 1x, ${assetUrl(rel, "x2")} 2x`;
}

/** An <img> tag for `rel`, sized by CSS. `lazy` defers offscreen tiles. */
export function imgTag(rel, { alt = "", cls = "", size = "x1", lazy = false,
                              style = "" } = {}) {
  const srcset = size === "x1" ? srcsetFor(rel) : "";
  return `<img src="${assetUrl(rel, size)}"`
    + (srcset ? ` srcset="${srcset}"` : "")
    + (cls ? ` class="${cls}"` : "")
    + (style ? ` style="${style}"` : "")
    + (lazy ? ` loading="lazy" decoding="async"` : "")
    + ` alt="${alt}">`;
}

/**
 * Load and DECODE one image, cached by URL.
 *
 * Decoding matters for the two places this is used: a mansion tile and a
 * game-room backdrop are both drawn the instant their screen appears, and an
 * <img> that has downloaded but not decoded paints on a later frame -- which
 * is the flash of half-built grid this avoids. Resolves to null rather than
 * rejecting: a missing decoration must never take a screen down.
 */
export function loadImage(rel, size = "x1") {
  const url = assetUrl(rel, size);
  if (!url) return Promise.resolve(null);
  if (decoded.has(url)) return decoded.get(url);
  const p = new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      if (im.decode) im.decode().then(() => resolve(im)).catch(() => resolve(im));
      else resolve(im);
    };
    im.onerror = () => resolve(null);
    im.src = url;
  });
  decoded.set(url, p);
  return p;
}

/**
 * Warm the cache for art the NEXT screen needs. Returns a promise for
 * callers that want to wait, but is meant to be fired and forgotten from the
 * screen before.
 */
export function prefetch(rels, size = "x1") {
  return Promise.all((rels || []).filter(Boolean).map((rel) => loadImage(rel, size)));
}

/**
 * Fetch the rest when the browser is doing nothing. Everything here is art a
 * child MIGHT reach -- the shop's whole catalogue, the closing cutscene --
 * so it must never compete with a screen that is actually being drawn.
 */
export function idlePrefetch(rels, size = "x1") {
  const list = (rels || []).filter(Boolean);
  const run = () => { for (const rel of list) loadImage(rel, size); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 1500);
}

/** Bytes the derivatives saved, for the console line at session start. Null
 * when there are none. */
export function assetSavings() {
  if (!index) return null;
  const entries = Object.values(index.entries || {});
  if (!entries.length) return null;
  const src = entries.reduce((a, e) => a + (e.src_bytes || 0), 0);
  const web = entries.reduce((a, e) => a + (e.files?.x1?.bytes || 0), 0);
  return { count: entries.length, src, web };
}

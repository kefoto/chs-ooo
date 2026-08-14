# chs-ooo — Pip's Castle, odd-one-out task

Public hosting for a triplet **odd-one-out** study running on
[Children Helping Science](https://childrenhelpingscience.com/) as an *external*
study. This repository exists to be served: CHS requires study code and stimuli
to be reachable at a public URL, and this is that URL.

The study itself — analysis, session management, the PyQt lab build — lives in a
separate private repository. Nothing here is the analysis pipeline.

## The study

Children see three items and pick the one that doesn't belong. Judgments of this
form are what SPoSE/VICE embeddings are fitted to. Two tiers:

- **Tier 1** — visual: three images.
- **Tier 2** — three conditions, blocked and Latin-square counterbalanced:
  visual (**V**), audio (**A**), and audiovisual (**AV**).

A game layer wraps the task for young children: a mascot, a castle that fills
with stickers, and a playground between blocks. `?plain=1` turns all of it off
for the non-gamified baseline arm.

## Running it

The page fetches manifests and media, so it must be served over HTTP —
opening `index.html` from disk fails, because `file://` blocks `fetch`.

```bash
python3 -m http.server 8000
# then open http://localhost:8000/js/index.html
```

With no query string you get the experimenter's setup screen. See
[`js/README.md`](js/README.md) for the full parameter list, the session plan,
the Tier 2 design, and the CHS integration.

## Layout

```
js/          the jsPsych 8 build — timeline, plugins, game layer
assets/      mascot art, backdrops, stickers, cutscene panels, dialogue
datasets/    the stimuli: Tier1_THINGS_560/, Tier2_AV_Matched/
api/         the Vercel serverless functions (Turnstile gate, storage, export)
.nojekyll    serve the tree as-is, without Jekyll
```

### What this copy deliberately does NOT carry

Two things are absent here on purpose, and a sync from the private repo will
try to put both back. Check them by hand every time:

- **`assets/game/font/`** — the lab build's Fontworks display faces cannot be
  redistributed. This copy ships Nunito (SIL OFL) from `js/vendor/font/`
  instead, and `js/css/game.css`'s `@font-face` must keep pointing there.
- **`assets/game/music/*.wav` and `assets/game/voice/*.wav`** — 110 MB of
  24-bit PCM authored for the desktop build (whose QSoundEffect fallback
  decodes nothing else). This copy serves only the AAC derivatives under
  `assets/game/web/audio/`, which `js/src/assets.js` resolves to; the same
  audio at 5 MB. `assets/game/voice/voice_manifest.json` stays, because
  `js/src/voice.js` reads it to learn which lines have a recording.
  Regenerate the derivatives in the private repo with
  `python utilities/build_web_audio.py`.

## Credits and licensing

- **Tier 1 images** — the [THINGS database](https://things-initiative.org/).
- **Tier 2 audio** — the McDermott natural sounds set, trimmed to 2.0 s mono
  44.1 kHz.
- **Tier 2 images** — see
  [`datasets/Tier2_AV_Matched/image_attribution.json`](datasets/Tier2_AV_Matched/image_attribution.json).
- **Emoji-derived art** — see
  [`assets/game/emoji/ATTRIBUTION.txt`](assets/game/emoji/ATTRIBUTION.txt).
- **jsPsych 8.2.1** — MIT, vendored in `js/vendor/`.
- **Nunito** — SIL Open Font License, in `js/vendor/font/` with its
  [`OFL.txt`](js/vendor/font/OFL.txt). Latin subset only, since the dialogue is
  English.

**The display font differs from the lab build.** That build uses a Fontworks
face which is licensed and cannot be redistributed, so this public copy ships
Nunito in its place — rounded in the same spirit, and free to serve from a
public repository. `js/css/game.css` holds the `@font-face`.

Stimulus sets carry the terms of their original sources; check those before
reusing anything in `datasets/`.

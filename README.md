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
datasets/    the stimuli: Tier1_THINGS_100/, Tier2_AV_Matched/
.nojekyll    serve the tree as-is, without Jekyll
```

## Credits and licensing

- **Tier 1 images** — the [THINGS database](https://things-initiative.org/).
- **Tier 2 audio** — the McDermott natural sounds set, trimmed to 2.0 s mono
  44.1 kHz.
- **Tier 2 images** — see
  [`datasets/Tier2_AV_Matched/image_attribution.json`](datasets/Tier2_AV_Matched/image_attribution.json).
- **Emoji-derived art** — see
  [`assets/game/emoji/ATTRIBUTION.txt`](assets/game/emoji/ATTRIBUTION.txt).
- **jsPsych 8.2.1** — MIT, vendored in `js/vendor/`.

**The display font is not included.** The lab build uses a licensed font that
cannot be redistributed, so this copy ships without it and falls back to the
platform UI font. `js/css/game.css` marks where to put an `@font-face` back.

Stimulus sets carry the terms of their original sources; check those before
reusing anything in `datasets/`.

# Cutscene panels

Shipped panels:

    1.png   Pip waves, castle behind him          (intro)
    2.png   cutaway castle, all rooms empty       (intro)
    3.png   the same castle decorated, Pip looking at it  (outro)

Filenames are whatever `manifest.cutscene` points at -- rename freely, edit the
manifest to match. Panels are FIT to the window, not cropped, so the whole
composition is always visible; the letterbox is filled with the page
background.

Prompts: `docs/ASSET_BRIEF.md` §4. Wiring: `manifest.cutscene`.

Until the files exist the session falls back to the text-only cutscene, so
nothing breaks while you iterate. Keep the bottom ~28% of each panel visually
calm -- the dialogue box is drawn over it.

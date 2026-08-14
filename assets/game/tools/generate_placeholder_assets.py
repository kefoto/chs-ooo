#!/usr/bin/env python3
"""Generate placeholder game assets (mascot frames + UI sounds).

These are deliberately simple stand-ins so the game layer is runnable before
any artwork exists. Replace the PNG/WAV files with real assets and keep the
filenames -- ``assets/game/manifest.json`` resolves everything by name.

    python assets/game/tools/generate_placeholder_assets.py

Design constraints baked in here (see docs/GAMIFICATION.md):
  * Mascot expressions never encode correct/incorrect -- only warmth/attention.
  * Sounds are soft, short, and non-startling; no rising "win" fanfare that
    would read as "you got it right".
"""

import math
import os
import struct
import sys
import wave

from PIL import Image, ImageDraw

ASSET_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASCOT_DIR = os.path.join(ASSET_ROOT, "mascot")
SOUND_DIR = os.path.join(ASSET_ROOT, "sounds")

SAMPLE_RATE = 44100

# Muted, low-arousal palette. Deliberately avoids red/green so nothing in the
# game layer can be read as right/wrong feedback.
EYE = (40, 48, 66)
CHEEK = (232, 176, 168)
WHITE = (255, 255, 255)

SIZE = 512

# ONE mascot variant, shown to every participant.
#
# The gendered boy/girl placeholders that used to live here were removed along
# with the feature: selecting the mascot from the participant's gender put a
# systematically different image on screen for every trial, confounding any
# across-gender comparison with the manipulation. Do not add them back -- this
# script would recreate the asset directories and quietly re-enable it.
#
# Real art note: Pip is a rounded, soft-edged fox-raccoon hybrid, deliberately
# not a real species so children do not bring real-animal associations into the
# similarity judgment. Real art now ships in assets/game/mascot/neutral/; this
# blob is only a fallback for regenerating from scratch.
VARIANTS = {
    "neutral": {"body": (110, 158, 154), "dark": (84, 128, 124), "accessory": None},
}

# Module-level current palette, set per variant by generate_variant().
BODY = VARIANTS["neutral"]["body"]
BODY_DARK = VARIANTS["neutral"]["dark"]
ACCESSORY = None


def _base(draw, bob=0):
    """Draw the shared mascot body. `bob` shifts it vertically."""
    cx, cy = SIZE // 2, SIZE // 2 + bob
    draw.ellipse([cx - 150, cy - 130, cx + 150, cy + 160], fill=BODY)
    draw.ellipse([cx - 150, cy + 90, cx + 150, cy + 160], fill=BODY_DARK)
    _accessory(draw, cx, cy)
    return cx, cy


def _accessory(draw, cx, cy):
    """Small variant marker so the placeholders are visually distinguishable."""
    if ACCESSORY == "cap":
        draw.pieslice([cx - 120, cy - 200, cx + 120, cy - 40], 180, 360, fill=BODY_DARK)
        draw.rectangle([cx - 130, cy - 128, cx + 40, cy - 112], fill=BODY_DARK)
    elif ACCESSORY == "bow":
        draw.polygon([(cx + 92, cy - 118), (cx + 148, cy - 152), (cx + 148, cy - 84)],
                     fill=BODY_DARK)
        draw.polygon([(cx + 92, cy - 118), (cx + 36, cy - 152), (cx + 36, cy - 84)],
                     fill=BODY_DARK)
        draw.ellipse([cx + 78, cy - 132, cx + 106, cy - 104], fill=CHEEK)


def _eyes(draw, cx, cy, *, open_amount=1.0, look=(0, 0)):
    dx, dy = look
    for side in (-1, 1):
        ex = cx + side * 58
        ey = cy - 30
        rx, ry = 30, int(30 * open_amount) or 3
        draw.ellipse([ex - rx, ey - ry, ex + rx, ey + ry], fill=WHITE)
        draw.ellipse(
            [ex - 13 + dx, ey - 13 + dy, ex + 13 + dx, ey + 13 + dy], fill=EYE
        )


def _smile(draw, cx, cy, width=70, depth=34):
    draw.arc(
        [cx - width, cy + 6, cx + width, cy + 6 + depth * 2],
        start=15, end=165, fill=EYE, width=10,
    )


def _cheeks(draw, cx, cy):
    for side in (-1, 1):
        draw.ellipse(
            [cx + side * 100 - 24, cy + 6, cx + side * 100 + 24, cy + 40], fill=CHEEK
        )


def mascot_idle():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = _base(d)
    _eyes(d, cx, cy)
    _smile(d, cx, cy)
    return img


def mascot_happy():
    """Warm, but NOT a celebration -- shown after every response equally."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = _base(d, bob=-14)
    _eyes(d, cx, cy, open_amount=0.55)
    _smile(d, cx, cy, width=84, depth=42)
    _cheeks(d, cx, cy)
    return img


def mascot_think():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = _base(d)
    _eyes(d, cx, cy, look=(9, -7))
    d.arc([cx - 40, cy + 18, cx + 40, cy + 52], start=200, end=340, fill=EYE, width=9)
    return img


def mascot_wave():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = _base(d)
    _eyes(d, cx, cy)
    _smile(d, cx, cy)
    d.ellipse([cx + 132, cy - 96, cx + 212, cy - 16], fill=BODY)
    return img


MASCOTS = {
    "mascot_idle.png": mascot_idle,
    "mascot_happy.png": mascot_happy,
    "mascot_think.png": mascot_think,
    "mascot_wave.png": mascot_wave,
}


def _write_wav(path, samples):
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 26000))
                               for s in samples))


def _tone(freqs, duration, *, attack=0.02, release=0.25, gain=0.5):
    """Additive sine tone with a soft attack/release envelope."""
    n = int(SAMPLE_RATE * duration)
    a = max(1, int(SAMPLE_RATE * attack))
    r = max(1, int(SAMPLE_RATE * release))
    out = []
    for i in range(n):
        t = i / SAMPLE_RATE
        v = sum(math.sin(2 * math.pi * f * t) for f in freqs) / len(freqs)
        if i < a:
            env = i / a
        elif i > n - r:
            env = max(0.0, (n - i) / r)
        else:
            env = 1.0
        out.append(v * env * gain)
    return out


def _seq(chunks):
    out = []
    for c in chunks:
        out.extend(c)
    return out


def _silence(duration):
    return [0.0] * int(SAMPLE_RATE * duration)


# Soft major-third dyads. Flat in pitch contour on purpose: a rising interval
# reads as "correct!", which must never attach to a free-choice response.
SOUNDS = {
    # Played after EVERY selection, identical regardless of what was chosen.
    "select.wav": lambda: _tone([523.25, 659.25], 0.22, release=0.18, gain=0.45),
    # Level / block completion -- rewards progress, not choice content.
    "level_up.wav": lambda: _seq([
        _tone([523.25, 659.25], 0.16, release=0.10),
        _tone([587.33, 739.99], 0.16, release=0.10),
        _tone([659.25, 830.61], 0.34, release=0.28),
    ]),
    # A sticker/collectible is added to the book.
    "sticker.wav": lambda: _seq([
        _tone([880.00, 1108.73], 0.12, release=0.08, gain=0.38),
        _tone([1046.50, 1318.51], 0.26, release=0.22, gain=0.38),
    ]),
    # Gentle "still there?" nudge after prolonged inactivity.
    "nudge.wav": lambda: _seq([
        _tone([440.00], 0.14, release=0.10, gain=0.30),
        _silence(0.10),
        _tone([440.00], 0.14, release=0.10, gain=0.30),
    ]),
    # Session complete.
    "finish.wav": lambda: _seq([
        _tone([523.25, 659.25], 0.18, release=0.12),
        _tone([659.25, 783.99], 0.18, release=0.12),
        _tone([783.99, 987.77], 0.48, release=0.40),
    ]),
}


def generate_variant(variant):
    """Render every mascot frame for one variant into its own subdirectory."""
    global BODY, BODY_DARK, ACCESSORY
    spec = VARIANTS[variant]
    BODY, BODY_DARK, ACCESSORY = spec["body"], spec["dark"], spec["accessory"]

    out_dir = os.path.join(MASCOT_DIR, variant)
    os.makedirs(out_dir, exist_ok=True)
    for name, fn in MASCOTS.items():
        path = os.path.join(out_dir, name)
        fn().save(path)
        print(f"  wrote {os.path.relpath(path, ASSET_ROOT)}")


# Placeholder frames are generated at this size. Real art is larger, which is
# what lets us tell the two apart without tracking state.
PLACEHOLDER_SIZE = (SIZE, SIZE)


def _looks_like_real_art(path):
    """True if `path` holds hand-made art rather than a generated placeholder.

    This script OVERWRITES by design, and its whole point is that real assets
    drop in under the same filenames -- which makes "regenerate placeholders"
    and "destroy the commissioned art" the same command. That has already
    happened once. Anything that is not exactly the placeholder dimensions is
    treated as real and left alone.
    """
    if not os.path.exists(path):
        return False
    try:
        with Image.open(path) as im:
            return im.size != PLACEHOLDER_SIZE
    except Exception:
        # Unreadable but present: refuse rather than clobber it.
        return True


def main():
    force = "--force" in sys.argv
    os.makedirs(MASCOT_DIR, exist_ok=True)
    os.makedirs(SOUND_DIR, exist_ok=True)

    protected = []
    for variant in VARIANTS:
        vdir = os.path.join(MASCOT_DIR, variant)
        real = [f for f in ("mascot_idle.png", "mascot_happy.png",
                            "mascot_think.png", "mascot_wave.png")
                if _looks_like_real_art(os.path.join(vdir, f))]
        if real and not force:
            protected.append((variant, real))
            continue
        generate_variant(variant)

    for name, fn in SOUNDS.items():
        path = os.path.join(SOUND_DIR, name)
        _write_wav(path, fn())
        print(f"  wrote {os.path.relpath(path, ASSET_ROOT)}")

    if protected:
        print("\nSKIPPED -- these look like real art, not placeholders:")
        for variant, files in protected:
            print(f"  mascot/{variant}/: {', '.join(files)}")
        print("  Nothing was overwritten. Pass --force if you really do want")
        print("  to replace commissioned art with generated blobs.")

    print("\nPlaceholder assets generated. Replace them with real artwork/audio "
          "using the same filenames.")


if __name__ == "__main__":
    main()

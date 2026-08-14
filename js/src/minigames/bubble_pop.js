/**
 * Bubbles drift up from the bottom; tap one to pop it.
 * Port of BubblePop in experiments/minigames.py.
 *
 * Discrete tapping, the input the youngest children are most reliable at --
 * the same reason tap-to-place exists alongside dragging in the playground.
 */

import { MiniGame, rgba } from "./engine.js";

export class BubblePop extends MiniGame {
  static GAME_KEY = "bubble_pop";
  static TITLE = "Bubble Pop";
  //: A soft pick-up sound rather than the star's chime, and a teal burst to
  //: match the bubbles -- the two games should not sound or flash alike.
  static SCORE_SOUND = "pickup";
  static EFFECT_COLOUR = "palette_teal";

  static BUBBLE_REL = [0.08, 0.15];      // size range, fraction of smaller side
  static RISE_REL_PER_S = [0.16, 0.30];
  static SPAWN_MS = [450, 900];
  static DRIFT_REL_PER_S = 0.05;         // gentle horizontal sway
  //: A ceiling on how many can be on screen at once, so a child who is not
  //: popping does not end up looking at a wall of bubbles.
  static MAX_ACTIVE = 9;

  constructor(opts) {
    super(opts);
    this.resetWorld();
  }

  resetWorld() {
    this._bubbles = [];
    this._nextSpawnMs = 0;
  }

  maxActive() {
    return this.reducedMotion ? 5 : this.constructor.MAX_ACTIVE;
  }

  advance(dtMs) {
    const C = this.constructor;
    const dtS = dtMs / 1000;
    const speed = this.speedScale();
    const ramp = this.ramp();

    this._nextSpawnMs -= dtMs;
    if (this._nextSpawnMs <= 0 && this._bubbles.length < this.maxActive()) {
      this._bubbles.push({
        x: this.uniform(0.10, 0.90),
        y: 1.08,
        v: this.uniform(...C.RISE_REL_PER_S) * speed,
        r: this.uniform(...C.BUBBLE_REL),
        drift: this.uniform(-1, 1) * C.DRIFT_REL_PER_S * speed,
      });
      // Divided by the ramp, so bubbles come faster later in the round.
      this._nextSpawnMs = this.uniform(...C.SPAWN_MS)
        * (this.reducedMotion ? 2 : 1) / ramp;
    }

    const kept = [];
    for (const b of this._bubbles) {
      b.y -= b.v * dtS * ramp;
      b.x = Math.min(0.96, Math.max(0.04, b.x + b.drift * dtS));
      if (b.y < -0.12) continue;        // escaped: it simply leaves
      kept.push(b);
    }
    this._bubbles = kept;
  }

  onPointer(pos, pressed) {
    if (!pressed || !this.running) return;
    const play = this.playRect();
    const side = Math.min(play.w, play.h);
    // Topmost-first, so the bubble a child sees in front is the one that
    // pops -- the same reason the room canvas walks placed items in reverse.
    for (let i = this._bubbles.length - 1; i >= 0; i--) {
      const b = this._bubbles[i];
      const rRelX = (b.r * side / 2) / play.w;
      const rRelY = (b.r * side / 2) / play.h;
      if (Math.abs(pos.x - b.x) <= rRelX && Math.abs(pos.y - b.y) <= rRelY) {
        this._bubbles.splice(i, 1);
        // The burst replaces the bubble exactly where it was, which is what
        // makes it read as the bubble bursting rather than a separate effect.
        this.addPoint([b.x, b.y]);
        return;
      }
    }
  }

  /**
   * A bubble: tinted body, firm rim, one highlight. The body is a TINT rather
   * than solid white -- this game's room is pale mint through the middle, and
   * a white-filled circle on it was a rim and nothing else. The target a
   * 4-year-old aims at has to be visible against its own backdrop, not just
   * against the page colour.
   */
  paintToken(ctx, cx, cy, size) {
    const teal = this.theme.palette_teal || "#6E9E9A";
    const r = size / 2;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(teal, 0.27);
    ctx.fill();
    ctx.lineWidth = Math.max(3, size * 0.08);
    ctx.strokeStyle = teal;
    ctx.stroke();

    // The highlight is what makes a tinted disc read as a BUBBLE rather than
    // a coloured dot -- up and to the left, like every drawn bubble.
    ctx.beginPath();
    ctx.arc(cx - r * 0.35, cy - r * 0.35, Math.max(2, r * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = rgba("#FFFFFF", 0.78);
    ctx.fill();
  }

  paintPlayArea(ctx, rect) {
    const side = Math.min(rect.w, rect.h);
    for (const b of this._bubbles) {
      this.paintToken(ctx, rect.x + b.x * rect.w, rect.y + b.y * rect.h, b.r * side);
    }
  }
}

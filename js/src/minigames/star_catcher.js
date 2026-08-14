/**
 * Stars fall; a basket follows the pointer along the bottom.
 * Port of StarCatcher in experiments/minigames.py.
 *
 * Continuous motor control, the opposite input mode to BubblePop -- which is
 * the point of having two. The basket also answers the arrow keys, so a child
 * who cannot hold a trackpad drag (a real 4-6 difference) can still play.
 */

import { MiniGame, lighten, darken, rgba } from "./engine.js";

export class StarCatcher extends MiniGame {
  static GAME_KEY = "star_catcher";
  static TITLE = "Star Catcher";
  //: A chime for a caught star, and a gold burst to match it.
  static SCORE_SOUND = "sticker";
  static EFFECT_COLOUR = "progress_fill";

  //: Star size and basket width, as fractions of the play area's smaller side
  //: and its width. Generous, for the same reason a sticker's grab radius is.
  static STAR_REL = 0.11;
  static BASKET_REL_W = 0.20;
  //: Height of the catching band above the basket line -- a band, not a line,
  //: so a star cannot tunnel past it between two frames at any sane speed.
  static CATCH_BAND_REL = 0.10;
  //: Fall speed in play-area heights per second, and how often a new star
  //: appears. Both ranges: identical timing every time makes the round one
  //: rhythm to memorise rather than something to watch.
  static FALL_REL_PER_S = [0.30, 0.50];
  static SPAWN_MS = [600, 1100];
  static KEY_STEP_REL = 0.06;

  constructor(opts) {
    super(opts);
    this.resetWorld();
  }

  resetWorld() {
    this._stars = [];
    this._basketX = 0.5;
    this._nextSpawnMs = 0;
  }

  advance(dtMs) {
    const C = this.constructor;
    const dtS = dtMs / 1000;
    const speed = this.speedScale();
    const ramp = this.ramp();

    this._nextSpawnMs -= dtMs;
    if (this._nextSpawnMs <= 0) {
      this._stars.push({
        x: this.uniform(0.08, 0.92),
        y: -0.05,
        v: this.uniform(...C.FALL_REL_PER_S) * speed,
      });
      // Reduced motion spawns half as often, so there is less on screen as
      // well as less speed. Divided by the ramp, so stars arrive more often
      // as the round goes on.
      this._nextSpawnMs = this.uniform(...C.SPAWN_MS)
        * (this.reducedMotion ? 2 : 1) / ramp;
    }

    const bandTop = 1 - C.CATCH_BAND_REL;
    const halfW = C.BASKET_REL_W / 2;
    const kept = [];
    for (const star of this._stars) {
      star.y += star.v * dtS * ramp;
      if (star.y >= bandTop && Math.abs(star.x - this._basketX) <= halfW) {
        // The burst is left AT THE BASKET, not where the star was -- that is
        // where the child was looking.
        this.addPoint([this._basketX, bandTop]);
        continue;                       // caught: leave the world
      }
      if (star.y > 1.15) continue;      // missed: it simply leaves, silently
      kept.push(star);
    }
    this._stars = kept;
  }

  onPointer(pos) {
    // Records the position and NOTHING else -- the basket moves on the next
    // frame, at most a frame later, which is not a delay a person can see.
    // Repainting from here instead is what made dragging feel laggy: a
    // trackpad delivers moves far faster than 60Hz.
    this._basketX = Math.min(1, Math.max(0, pos.x));
  }

  onArrow(dir) {
    const step = this.constructor.KEY_STEP_REL;
    if (dir === "left") this._basketX = Math.max(0, this._basketX - step);
    else if (dir === "right") this._basketX = Math.min(1, this._basketX + step);
  }

  /**
   * A five-pointed star: soft halo, radial-lit body, one highlight. The
   * geometry is the two radii a star is defined by; everything else is depth,
   * so it reads as an object worth catching rather than a flat sign, and
   * separates from the small painted stars in this room's own backdrop.
   */
  paintToken(ctx, cx, cy, size) {
    const gold = this.theme.progress_fill || "#D9BE86";
    const outer = size / 2;
    const inner = outer * 0.42;

    // A soft halo first -- this is what lifts it off a busy night sky.
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer * 1.7);
    halo.addColorStop(0, rgba(gold, 0.35));
    halo.addColorStop(1, rgba(gold, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, outer * 1.7, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + i * Math.PI / 5;   // first point straight up
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    // Lit from the upper left, like every other rounded thing in this art.
    const body = ctx.createRadialGradient(
      cx - outer * 0.3, cy - outer * 0.3, 0, cx - outer * 0.3, cy - outer * 0.3, outer * 1.6);
    body.addColorStop(0, lighten(gold, 135));
    body.addColorStop(1, darken(gold, 108));
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = Math.max(2, size * 0.045);
    ctx.strokeStyle = darken(gold, 140);
    ctx.stroke();

    ctx.fillStyle = rgba("#FFFFFF", 0.59);
    ctx.beginPath();
    ctx.ellipse(cx - outer * 0.22, cy - outer * 0.30, outer * 0.16, outer * 0.12,
                0, 0, Math.PI * 2);
    ctx.fill();
  }

  paintPlayArea(ctx, rect) {
    const box = Math.min(rect.w, rect.h) * this.constructor.STAR_REL;
    for (const star of this._stars) {
      this.paintToken(ctx, rect.x + star.x * rect.w, rect.y + star.y * rect.h, box);
    }
    this._paintBasket(ctx, rect);
  }

  /**
   * A woven basket, not a rounded box: tapered body, a darker rim bar across
   * the top, two weave lines. It SQUASHES for a moment after a catch, which
   * is the feedback that something landed in it on a screen with no score
   * flash and no failure state.
   */
  _paintBasket(ctx, rect) {
    const C = this.constructor;
    const sand = this.theme.palette_sand || "#D9BE86";
    const rim = darken(sand, 125);

    const squash = this.reducedMotion ? 0 : this._cheerT * 0.18;
    const bw = rect.w * C.BASKET_REL_W * (1 + squash * 0.5);
    const bh = rect.h * C.CATCH_BAND_REL * (1 - squash);
    const cx = rect.x + this._basketX * rect.w;
    const by = rect.y + rect.h - bh;

    const topHalf = bw / 2;
    const botHalf = bw / 2 * 0.80;
    ctx.beginPath();
    ctx.moveTo(cx - topHalf, by);
    ctx.lineTo(cx + topHalf, by);
    ctx.lineTo(cx + botHalf, by + bh);
    ctx.lineTo(cx - botHalf, by + bh);
    ctx.closePath();
    ctx.fillStyle = sand;
    ctx.fill();
    ctx.lineWidth = Math.max(2, bh * 0.10);
    ctx.strokeStyle = darken(sand, 150);
    ctx.stroke();

    // Weave: two lines following the taper, so it reads as basketwork rather
    // than a painted stripe.
    ctx.lineWidth = Math.max(1, bh * 0.07);
    ctx.strokeStyle = darken(sand, 122);
    for (const f of [0.36, 0.68]) {
      const half = topHalf + (botHalf - topHalf) * f;
      const yy = by + bh * f;
      ctx.beginPath();
      ctx.moveTo(cx - half, yy);
      ctx.lineTo(cx + half, yy);
      ctx.stroke();
    }

    // The rim sits proud of the body, which is what makes it a container with
    // an opening rather than a solid block.
    const rimH = Math.max(4, bh * 0.26);
    ctx.beginPath();
    const rx = cx - topHalf - bw * 0.03;
    const ry = by - rimH / 2;
    const rw = bw * 1.06;
    const rr = rimH / 2;
    ctx.moveTo(rx + rr, ry);
    ctx.arcTo(rx + rw, ry, rx + rw, ry + rimH, rr);
    ctx.arcTo(rx + rw, ry + rimH, rx, ry + rimH, rr);
    ctx.arcTo(rx, ry + rimH, rx, ry, rr);
    ctx.arcTo(rx, ry, rx + rw, ry, rr);
    ctx.closePath();
    ctx.fillStyle = rim;
    ctx.fill();
    ctx.lineWidth = Math.max(2, bh * 0.08);
    ctx.strokeStyle = darken(rim, 120);
    ctx.stroke();
  }
}

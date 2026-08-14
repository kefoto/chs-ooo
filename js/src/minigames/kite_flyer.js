/**
 * A kite the child steers in two dimensions through ribbons of sparkles.
 * Port of KiteFlyer in experiments/minigames.py.
 *
 * Continuous motor control, the same input mode as StarCatcher -- drag or
 * arrow keys move it, no click needed to catch -- but steering BOTH axes at
 * once is a different skill than sliding a basket along one line, and the
 * sparkles drift sideways rather than falling straight down.
 *
 *     Why the kite has weight
 *     -----------------------
 *     It used to sit exactly on the pointer, which made it a cursor: park it
 *     mid-screen and the sparkles arrived by themselves. Simulated play bore
 *     that out -- a deliberately clumsy player scored 38 and a sharp one 40,
 *     so nothing a child did with their hand mattered. The kite now FOLLOWS
 *     the pointer on a string (FOLLOW_PER_S), so a sparkle has to be led
 *     rather than pounced on, and the tail behind it shows the swing. The lag
 *     is short on purpose (~200ms to settle): enough to feel like flying
 *     something, not enough to feel like the screen is behind you.
 *
 *     Why sparkles come in ribbons
 *     ----------------------------
 *     Single sparkles from random directions reward no plan -- there is never
 *     a reason to be anywhere in particular. A ribbon is a line of them on one
 *     lane, so catching the first tells you where the rest are and a good
 *     sweep takes all of them. Taking a whole ribbon pays RIBBON_BONUS on top
 *     of the last sparkle, which is the only thing in this room worth aiming
 *     for beyond the sparkle in front of you.
 */

import { MiniGame, lighten, darken, rgba } from "./engine.js";

export class KiteFlyer extends MiniGame {
  static GAME_KEY = "kite_flyer";
  static TITLE = "Kite Flyer";
  //: Borrows StarCatcher's chime (its input-mode sibling) rather than
  //: inventing a third scoring sound with no game room left to reuse it.
  static SCORE_SOUND = "sticker";
  static EFFECT_COLOUR = "palette_teal";

  static SPARKLE_REL = 0.075;
  static KITE_REL = 0.14;
  //: Centre-to-centre distance that counts as a catch, as a fraction of the
  //: play area's SMALLER side (see withinReach). Sized between the kite's
  //: half-width and half-height so the reach matches the drawn kite.
  static CATCH_REL = 0.125;
  static DRIFT_REL_PER_S = [0.26, 0.46];
  //: Gentle vertical wobble as a sparkle drifts, cycles per second.
  static BOB_REL_PER_S = 0.35;
  //: One RIBBON spawns at a time, not one sparkle -- this is the gap between
  //: ribbons. How many are in one, and how far apart they ride: close enough
  //: to sweep in one pass, far enough that the sweep is a movement.
  static SPAWN_MS = [600, 1050];
  static RIBBON_LENGTH = [2, 4];
  static RIBBON_GAP_REL = 0.13;
  //: Extra points for taking every sparkle in one ribbon, paid on the last
  //: one. Lost silently if any of them drifts off the far side -- the
  //: ordinary points are still paid, so an incomplete ribbon is a smaller
  //: reward and never a penalty.
  static RIBBON_BONUS = 2;
  static KEY_STEP_REL = 0.05;
  static MAX_ACTIVE = 12;
  //: How hard the kite is pulled toward the pointer, per second. Higher is
  //: tighter; see the class docstring on why it is not infinite.
  static FOLLOW_PER_S = 15.0;
  //: Reduced-stimulation mode flies it almost rigidly: that mode is about
  //: keeping what is on screen predictable, and a swinging kite is the
  //: opposite of predictable.
  static FOLLOW_PER_S_REDUCED = 40.0;
  //: How many past positions the tail is drawn through.
  static TRAIL_LEN = 7;

  constructor(opts) {
    super(opts);
    this.resetWorld();
  }

  resetWorld() {
    this._sparkles = [];
    this._kiteX = 0.5;
    this._kiteY = 0.5;
    this._aimX = 0.5;
    this._aimY = 0.5;
    this._trail = [];
    // {ribbon id: how many of its sparkles are still uncaught}. A ribbon
    // whose id is dropped from here can no longer pay its bonus.
    this._ribbons = new Map();
    this._nextRibbon = 0;
    this._nextSpawnMs = 0;
  }

  maxActive() {
    return this.reducedMotion ? 4 : this.constructor.MAX_ACTIVE;
  }

  wobble(sparkle) {
    if (this.reducedMotion) return 0;
    return Math.sin(sparkle.wob_t * 2 * Math.PI) * 0.03;
  }

  advance(dtMs) {
    const C = this.constructor;
    const dtS = dtMs / 1000;
    const speed = this.speedScale();
    const ramp = this.ramp();

    // The kite is pulled toward where the hand is, not placed there. The
    // exponential makes it frame-rate independent: the same settle whether
    // this is a 16ms or a 33ms frame.
    const pull = this.reducedMotion ? C.FOLLOW_PER_S_REDUCED : C.FOLLOW_PER_S;
    const k = 1 - Math.exp(-pull * dtS);
    this._kiteX += (this._aimX - this._kiteX) * k;
    this._kiteY += (this._aimY - this._kiteY) * k;
    this._trail.push([this._kiteX, this._kiteY]);
    if (this._trail.length > C.TRAIL_LEN) {
      this._trail.splice(0, this._trail.length - C.TRAIL_LEN);
    }

    this._nextSpawnMs -= dtMs;
    if (this._nextSpawnMs <= 0 && this._sparkles.length < this.maxActive()) {
      this.spawnRibbon(speed);
      this._nextSpawnMs = this.uniform(...C.SPAWN_MS)
        * (this.reducedMotion ? 2 : 1) / ramp;
    }

    const kept = [];
    for (const s of this._sparkles) {
      s.x += s.v * dtS * ramp;
      s.wob_t = (s.wob_t + dtS * C.BOB_REL_PER_S) % 1;
      if (s.x < -0.10 || s.x > 1.10) {
        // Drifted off the far side. Its ribbon can no longer be completed, so
        // the bonus is gone -- quietly, with nothing said and nothing taken.
        this._ribbons.delete(s.ribbon);
        continue;
      }
      const sy = s.y + this.wobble(s);
      if (this.withinReach(s.x, sy)) {
        this.addPoint([s.x, sy], this.take(s));
        continue;                       // caught: leave the world
      }
      kept.push(s);
    }
    this._sparkles = kept;
  }

  /**
   * Is a sparkle close enough to the kite to be caught? Measured in PIXELS
   * and then divided by the play area's smaller side, not in raw x/y
   * fractions. A play area is much wider than it is tall, so a fraction-space
   * circle is an ellipse on screen: it reached far to the sides and fell
   * short above and below, which meant a sparkle could sit visibly on the
   * kite's nose and not count.
   */
  withinReach(sx, sy) {
    const play = this.playRect();
    const side = Math.max(1, Math.min(play.w, play.h));
    return Math.hypot((sx - this._kiteX) * play.w, (sy - this._kiteY) * play.h)
      / side <= this.constructor.CATCH_REL;
  }

  /**
   * A line of sparkles on one lane, riding in nose to tail. They share a lane
   * and a speed so they hold formation, and their wobble phases are stepped
   * so the line snakes -- which is what makes a ribbon look like one thing to
   * sweep rather than several things that happen to be near each other.
   */
  spawnRibbon(speed) {
    const C = this.constructor;
    const fromLeft = this.rng.random() < 0.5;
    const lane = this.uniform(0.12, 0.88);
    const v = this.uniform(...C.DRIFT_REL_PER_S) * speed;
    const phase = this.uniform(0, 1);
    let n = this.randint(...C.RIBBON_LENGTH);
    n = Math.min(n, Math.max(1, this.maxActive() - this._sparkles.length));
    this._nextRibbon += 1;
    const rid = this._nextRibbon;
    this._ribbons.set(rid, n);
    for (let i = 0; i < n; i++) {
      const back = i * C.RIBBON_GAP_REL;
      this._sparkles.push({
        x: fromLeft ? -back : 1 + back,
        y: lane,
        v: v * (fromLeft ? 1 : -1),
        wob_t: (phase + i * 0.16) % 1,
        ribbon: rid,
      });
    }
  }

  /** What one caught sparkle is worth: one, or one plus RIBBON_BONUS if it
   * was the last of its ribbon still in the air. */
  take(sparkle) {
    const left = this._ribbons.get(sparkle.ribbon);
    if (left === undefined) return 1;   // a ribbon already broken by an escape
    if (left <= 1) {
      this._ribbons.delete(sparkle.ribbon);
      return 1 + this.constructor.RIBBON_BONUS;
    }
    this._ribbons.set(sparkle.ribbon, left - 1);
    return 1;
  }

  onPointer(pos) {
    // Records where the hand is. The kite catches up in advance().
    this._aimX = Math.min(1, Math.max(0, pos.x));
    this._aimY = Math.min(1, Math.max(0, pos.y));
  }

  onArrow(dir) {
    const step = this.constructor.KEY_STEP_REL;
    if (dir === "left") this._aimX = Math.max(0, this._aimX - step);
    else if (dir === "right") this._aimX = Math.min(1, this._aimX + step);
    else if (dir === "up") this._aimY = Math.max(0, this._aimY - step);
    else if (dir === "down") this._aimY = Math.min(1, this._aimY + step);
  }

  /** A four-pointed sparkle: two crossed diamonds, one long, one short. */
  paintToken(ctx, cx, cy, size) {
    const teal = lighten(this.theme.palette_teal || "#6E9E9A", 120);
    const longR = size / 2;
    const shortR = size * 0.32;
    ctx.fillStyle = teal;
    for (const [wR, hR] of [[longR, shortR], [shortR, longR]]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - hR);
      ctx.lineTo(cx + wR, cy);
      ctx.lineTo(cx, cy + hR);
      ctx.lineTo(cx - wR, cy);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = rgba("#FFFFFF", 0.75);
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }

  paintPlayArea(ctx, rect) {
    const box = Math.min(rect.w, rect.h) * this.constructor.SPARKLE_REL;
    for (const s of this._sparkles) {
      this.paintToken(ctx, rect.x + s.x * rect.w,
                      rect.y + (s.y + this.wobble(s)) * rect.h, box);
    }
    this._paintKite(ctx, rect);
  }

  /**
   * A diamond kite on a short bowed tail, coloured like the sky it flies in.
   * Squashes briefly on a catch, the same feedback StarCatcher's basket
   * gives -- this game has no failure state either, so the only reaction to
   * anything is what happens when it goes well.
   */
  _paintKite(ctx, rect) {
    const C = this.constructor;
    const sky = lighten(this.theme.palette_teal || "#6E9E9A", 140);
    const rim = darken(sky, 130);
    const side = Math.min(rect.w, rect.h);

    const squash = this.reducedMotion ? 0 : this._cheerT * 0.20;
    const kw = side * C.KITE_REL * (1 + squash * 0.4);
    const kh = side * C.KITE_REL * (1 - squash * 0.4);
    const cx = rect.x + this._kiteX * rect.w;
    const cy = rect.y + this._kiteY * rect.h;

    ctx.beginPath();
    ctx.moveTo(cx, cy - kh);
    ctx.lineTo(cx + kw * 0.75, cy);
    ctx.lineTo(cx, cy + kh);
    ctx.lineTo(cx - kw * 0.75, cy);
    ctx.closePath();
    ctx.fillStyle = sky;
    ctx.fill();
    ctx.lineWidth = Math.max(2, kh * 0.12);
    ctx.strokeStyle = rim;
    ctx.stroke();

    ctx.lineWidth = Math.max(1, kh * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx, cy - kh);
    ctx.lineTo(cx, cy + kh);
    ctx.moveTo(cx - kw * 0.75, cy);
    ctx.lineTo(cx + kw * 0.75, cy);
    ctx.stroke();

    // The tail is drawn through where the kite has just BEEN, so it streams
    // out behind a swing instead of hanging straight down. It is also the
    // clearest read on the kite's weight: without it the lag looks like the
    // screen is late, with it the kite looks like it is on a string.
    const tailLen = kh * 1.6;
    const pts = [[cx, cy + kh]];
    if (!this.reducedMotion && this._trail.length > 1) {
      const recent = this._trail.slice(0, -1).slice(-4);
      for (let j = 0; j < recent.length; j++) {
        const [tx, ty] = recent[recent.length - 1 - j];
        const lag = (j + 1) / recent.length;
        pts.push([
          cx + (tx - this._kiteX) * rect.w * 4.5 * lag,
          // Always hangs clear of the body before it starts trailing
          // sideways, or a hard swing folds the tail back across the kite it
          // is hanging from.
          cy + (ty - this._kiteY) * rect.h * 4.5 * lag + tailLen * (0.4 + 0.6 * lag),
        ]);
      }
    } else {
      pts.push([cx, cy + kh + tailLen]);
    }
    ctx.lineWidth = Math.max(2, kh * 0.10);
    ctx.strokeStyle = rim;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
    ctx.stroke();

    // Bows along the tail, placed by walking the same path.
    ctx.fillStyle = this.theme.palette_sand || "#D9BE86";
    for (const f of [0.55, 0.95]) {
      const i = Math.min(pts.length - 1, Math.max(1, Math.round(f * (pts.length - 1))));
      const a = pts[i - 1];
      const b = pts[i];
      const frac = f * (pts.length - 1) - (i - 1);
      ctx.beginPath();
      ctx.ellipse(a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac,
                  kh * 0.16, kh * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

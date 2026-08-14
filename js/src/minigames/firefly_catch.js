/**
 * Fireflies wander and pulse; tap one while it GLOWS to catch it, and catch
 * it at the very top of the pulse for double.
 * Port of FireflyCatch in experiments/minigames.py.
 *
 * Discrete tapping, the same input as BubblePop, but the target is a MOMENT
 * as well as a place -- a tap that lands early or late does nothing at all,
 * not even removing the firefly, so there is nothing here to mistime badly.
 * It just waits for the next pulse.
 *
 *     Why the ring
 *     ------------
 *     The glow alone told a child *that* a firefly was catchable but never
 *     how close the moment was, so an early tap and a perfectly aimed tap
 *     looked identical and the game read as luck. The ring closes as the
 *     pulse rises and snaps shut at the catch window, which turns "wait for
 *     it" into something you can watch and aim at.
 *
 *     Why the peak is worth two
 *     -------------------------
 *     With a single flat point there was no reason to wait past the moment it
 *     became catchable, and the best part of the pulse was dead time.
 *     PEAK_THRESHOLD pays double for holding out, which is the only skill this
 *     game has to offer. Missing the peak still scores the ordinary point --
 *     the bonus is on top, never instead.
 */

import { MiniGame, lighten, rgba } from "./engine.js";

export class FireflyCatch extends MiniGame {
  static GAME_KEY = "firefly_catch";
  static TITLE = "Firefly Catch";
  //: Unused by the other games, so this room neither sounds nor flashes like
  //: either of them.
  static SCORE_SOUND = "select";
  static EFFECT_COLOUR = "palette_rose";

  static FIREFLY_REL = 0.09;
  //: One glow cycle, per firefly and randomised, so the room never pulses in
  //: unison. Short enough that a missed pulse is a moment's wait.
  static PULSE_MS = [1000, 1700];
  //: Brightness (0..1) a tap must land at or above to catch.
  static CATCH_THRESHOLD = 0.62;
  //: ...and at or above THIS the catch is worth PEAK_POINTS instead of one.
  //: A narrow band at the top of the pulse, drawn as the bright inner core so
  //: what a child aims at is exactly what pays.
  static PEAK_THRESHOLD = 0.90;
  static PEAK_POINTS = 2;
  //: A firefly never caught leaves after this long -- the same "no failure
  //: state" contract a missed star keeps.
  static LIFESPAN_MS = 6500;
  //: ...and takes this long to go, dimming the whole way rather than blinking
  //: off. A star leaves by drifting off an edge, so where it went is obvious;
  //: a firefly leaves from the middle of the room, where an instant
  //: disappearance is indistinguishable from a glitch. The fade multiplies
  //: into brightness(), so a going firefly visibly stops being catchable at
  //: the same moment it actually stops being catchable.
  static FADE_MS = 1100;
  static DRIFT_REL_PER_S = 0.05;
  //: How fast a heading turns, in full turns per second. Straight lines with
  //: a bounce looked like a screensaver; a slow constant curve looks alive.
  static TURN_TURNS_PER_S = [-0.30, 0.30];
  static SPAWN_MS = [620, 1150];
  static MAX_ACTIVE = 5;
  //: A tap on a DIM firefly startles it: it darts off at DART_GAIN times its
  //: usual speed for DART_MS. Nothing is lost and no time is added -- it
  //: keeps pulsing on the same cycle -- but the tap now visibly does
  //: something, so "nothing happened" is never ambiguous between a miss and a
  //: broken game.
  static DART_MS = 300;
  static DART_GAIN = 4.0;

  constructor(opts) {
    super(opts);
    this.resetWorld();
  }

  resetWorld() {
    this._flies = [];
    this._nextSpawnMs = 0;
  }

  maxActive() {
    return this.reducedMotion ? 3 : this.constructor.MAX_ACTIVE;
  }

  /**
   * 1.0 while a firefly is here, easing to 0 while it leaves. Fading flies
   * are deliberately NOT counted against maxActive (see advance): one on its
   * way out should not hold a spawn slot, or the room thins out for the last
   * FADE_MS of every firefly's life.
   */
  fade(fly) {
    const over = fly.age_ms - this.constructor.LIFESPAN_MS;
    if (over <= 0) return 1;
    const t = Math.min(1, over / this.constructor.FADE_MS);
    // Smoothstep: holds its glow for a moment, dissolves through the middle,
    // settles out at the end. A linear ramp reads as a dimmer switch being
    // turned; a squared one dumps most of the brightness in the first quarter
    // and then hangs about faintly. Neither looks like drifting away.
    return 1 - t * t * (3 - 2 * t);
  }

  /** How bright this firefly is right now, 0..1 -- pulse times fade. The
   * single number the tap handler checks and the painter draws, so "looks
   * catchable" and "is catchable" cannot drift apart. */
  brightness(fly) {
    const frac = (fly.age_ms % fly.pulse_ms) / fly.pulse_ms;
    const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * frac - Math.PI / 2);
    return pulse * this.fade(fly);
  }

  advance(dtMs) {
    const C = this.constructor;
    const dtS = dtMs / 1000;
    const speed = this.speedScale();
    const ramp = this.ramp();

    this._nextSpawnMs -= dtMs;
    const here = this._flies.filter((f) => f.age_ms < C.LIFESPAN_MS).length;
    if (this._nextSpawnMs <= 0 && here < this.maxActive()) {
      this._flies.push(this.newFly());
      this._nextSpawnMs = this.uniform(...C.SPAWN_MS)
        * (this.reducedMotion ? 2 : 1) / ramp;
    }

    const kept = [];
    for (const fly of this._flies) {
      fly.age_ms += dtMs;
      const darting = fly.dart_ms > 0;
      if (darting) {
        fly.dart_ms = Math.max(0, fly.dart_ms - dtMs);
      } else if (!this.reducedMotion) {
        // Curve the heading rather than holding a straight line. A startled
        // firefly flies straight until it settles, which is what makes a dart
        // read as a dart.
        const turn = (fly.turn || 0) * 2 * Math.PI * dtS;
        if (turn) {
          const c = Math.cos(turn);
          const s = Math.sin(turn);
          const dx = fly.dx * c - fly.dy * s;
          const dy = fly.dx * s + fly.dy * c;
          fly.dx = dx;
          fly.dy = dy;
        }
      }
      const step = dtS * speed * ramp * (darting ? C.DART_GAIN : 1);
      fly.x += fly.dx * step;
      fly.y += fly.dy * step;
      // Bounce off the edges rather than drifting out of the room -- a
      // firefly has nowhere to fall or rise to, unlike a star or bubble.
      if (fly.x <= 0.06 || fly.x >= 0.94) {
        fly.dx *= -1;
        fly.x = Math.min(0.94, Math.max(0.06, fly.x));
      }
      if (fly.y <= 0.08 || fly.y >= 0.90) {
        fly.dy *= -1;
        fly.y = Math.min(0.90, Math.max(0.08, fly.y));
      }
      if (fly.age_ms >= C.LIFESPAN_MS + C.FADE_MS) continue;  // finished fading
      kept.push(fly);
    }
    this._flies = kept;
  }

  /** One firefly. A method rather than a literal so a test can make a valid
   * one without knowing every key advance() reads. */
  newFly(over = {}) {
    const C = this.constructor;
    return {
      x: this.uniform(0.12, 0.88),
      y: this.uniform(0.15, 0.85),
      dx: this.uniform(-1, 1) * C.DRIFT_REL_PER_S,
      dy: this.uniform(-1, 1) * C.DRIFT_REL_PER_S,
      turn: this.uniform(...C.TURN_TURNS_PER_S),
      pulse_ms: this.uniform(...C.PULSE_MS),
      age_ms: 0,
      dart_ms: 0,
      ...over,
    };
  }

  onPointer(pos, pressed) {
    if (!pressed || !this.running) return;
    const C = this.constructor;
    const play = this.playRect();
    const side = Math.min(play.w, play.h);
    const rRelX = (C.FIREFLY_REL * side / 2) / play.w;
    const rRelY = (C.FIREFLY_REL * side / 2) / play.h;
    // Topmost-first, matching BubblePop's hit order.
    for (let i = this._flies.length - 1; i >= 0; i--) {
      const fly = this._flies[i];
      if (Math.abs(pos.x - fly.x) <= rRelX && Math.abs(pos.y - fly.y) <= rRelY) {
        const bright = this.brightness(fly);
        if (bright >= C.CATCH_THRESHOLD) {
          this._flies.splice(i, 1);
          this.addPoint([fly.x, fly.y],
                        bright >= C.PEAK_THRESHOLD ? C.PEAK_POINTS : 1);
        } else {
          // Too early or too late: nothing scored and nothing taken, but it
          // startles and darts away, so the tap is visibly a near miss rather
          // than a dead click.
          this.startle(fly, pos.x, pos.y);
        }
        return;
      }
    }
  }

  /** Send `fly` darting away from the tap. Its pulse is untouched: no time is
   * added and no progress lost, so a mistimed tap costs exactly nothing. It
   * moves, and that is all. */
  startle(fly, px, py) {
    if (this.reducedMotion) return;
    let ax = fly.x - px;
    let ay = fly.y - py;
    let mag = Math.hypot(ax, ay);
    if (mag < 1e-6) {
      ax = this.uniform(-1, 1);
      ay = this.uniform(-1, 1);
      mag = Math.max(1e-6, Math.hypot(ax, ay));
    }
    const drift = this.constructor.DRIFT_REL_PER_S;
    fly.dx = ax / mag * drift;
    fly.dy = ay / mag * drift;
    fly.dart_ms = this.constructor.DART_MS;
  }

  /**
   * A soft halo, a closing timing ring, and a bright core at the peak. All
   * three are tied to the same `brightness` the tap handler checks, so what a
   * child sees is exactly what scores: the RING closes as the pulse rises,
   * turns bright and solid at CATCH_THRESHOLD (catchable now), and the white
   * CORE appears at PEAK_THRESHOLD (the double-point band).
   *
   * `fade` scales every alpha and is what carries a firefly off the screen at
   * the end of its life. Separate from `brightness` because the two do
   * different jobs: brightness also moves the ring and the core, fade only
   * takes the whole thing away.
   */
  paintGlow(ctx, cx, cy, size, brightness, ring = true, fade = 1) {
    const C = this.constructor;
    const rose = this.theme.palette_rose || "#C99A96";
    const outer = size / 2;
    const haloR = outer * (1.6 + brightness * 0.8);

    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, rgba(rose, (0.20 + 0.47 * brightness) * fade));
    halo.addColorStop(1, rgba(rose, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(lighten(rose, 100 + 60 * brightness),
                         (0.47 + 0.51 * brightness) * fade);
    ctx.beginPath();
    ctx.arc(cx, cy, outer * 0.5, 0, Math.PI * 2);
    ctx.fill();

    if (ring) {
      // Closes from far out to just off the body as the pulse rises.
      const ringR = outer * (2.6 - 1.4 * brightness);
      if (brightness >= C.CATCH_THRESHOLD) {
        ctx.strokeStyle = rgba("#FFFFFF", 0.84 * fade);
        ctx.lineWidth = Math.max(2, size * 0.075);
      } else {
        ctx.strokeStyle = rgba(lighten(rose, 125), (0.24 + 0.35 * brightness) * fade);
        ctx.lineWidth = Math.max(1, size * 0.045);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (brightness >= C.PEAK_THRESHOLD) {
      // The double-point band. Nothing else in this room is a solid white
      // disc, so "worth two" is one glance rather than a rule to learn.
      const a = Math.min(1, (brightness - C.PEAK_THRESHOLD)
                            / Math.max(1e-6, 1 - C.PEAK_THRESHOLD));
      ctx.fillStyle = rgba("#FFFFFF", a * fade);
      ctx.beginPath();
      ctx.arc(cx, cy, outer * 0.30, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A firefly at full glow -- the HUD counter, where there is no pulse to
   * show, only the thing that was caught. No ring: the ring means "tap now",
   * and the HUD is not tappable. */
  paintToken(ctx, cx, cy, size) {
    this.paintGlow(ctx, cx, cy, size, 1, false);
  }

  paintPlayArea(ctx, rect) {
    const box = Math.min(rect.w, rect.h) * this.constructor.FIREFLY_REL;
    for (const fly of this._flies) {
      this.paintGlow(ctx, rect.x + fly.x * rect.w, rect.y + fly.y * rect.h, box,
                     this.brightness(fly), true, this.fade(fly));
    }
  }
}

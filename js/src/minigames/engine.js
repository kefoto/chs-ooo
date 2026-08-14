/**
 * Shared frame loop, HUD and round bookkeeping for one mini-game.
 * Port of MiniGameWidget in experiments/minigames.py.
 *
 * Presentation only, like playground.js and the game layer in main.js. These
 * know nothing about trials: they never see a response, and they run strictly
 * BETWEEN blocks inside a mansion visit, so they cannot touch
 * response_time_ms. What one reports outward is a score and a duration; the
 * caller decides what that is worth (CastleState.recordMinigame).
 *
 *     What these games deliberately are NOT
 *     -------------------------------------
 *     No matching, no sorting, no "pick the one that is different". The
 *     session measures how a child judges similarity; a break game built on
 *     the same judgment would teach a grouping right beside the task trying to
 *     measure it. All four are pure hand-eye timing or steering, and none
 *     shows a stimulus image at all.
 *
 *     No failure state
 *     ----------------
 *     A missed star, an escaped bubble, an untapped firefly: all three simply
 *     leave. Nothing flashes, nothing is deducted, there is no "you lost"
 *     screen -- the same reasoning that keeps the trial screens from
 *     evaluating a choice.
 *
 *     Art-free on purpose
 *     -------------------
 *     Every object is PAINTED from the theme palette rather than drawn as an
 *     emoji or loaded from a file, so the games need no asset and no font and
 *     cost the network nothing. A room backdrop can still be dropped in
 *     behind them.
 *
 *     Logic without a canvas
 *     ----------------------
 *     The world, tick() and the input handlers take normalised coordinates
 *     and never touch the DOM, so js/test/run.mjs drives whole rounds
 *     headlessly. attach() is what adds a canvas, its events and painting;
 *     without it a game still plays, it just has nobody watching.
 */

import { lighten, darken, rgba } from "./colour.js";

//: How long one round lasts. Short on purpose: a round should end while a
//: child still wants another one, and "play again" should be a decision they
//: make rather than a wait they sit through. Also keeps a game room's cost to
//: the session small and countable -- see CastleState.minigame_ms.
export const ROUND_MS = 20000;

//: How much faster the world moves by the END of a round than at the start.
//: A flat 20 seconds is 20 seconds of the same thing; ramping gives the round
//: a shape. Applied to movement AND to how often things appear.
export const RAMP_END = 1.9;

//: Frame interval. Reduced-stimulation mode runs at half the rate AND slower
//: object speeds (see speedScale) -- the mode is about how much is moving on
//: screen, which a lower frame rate alone would not change.
export const FRAME_MS = 16;
export const FRAME_MS_REDUCED = 33;

//: Fraction of the canvas height reserved for the HUD strip at the top.
export const HUD_REL_HEIGHT = 0.12;

//: How long a catch/pop burst lasts. Short: this fires on every point, so it
//: has to be gone before the next one lands or the screen turns into confetti.
export const EFFECT_MS = 420;

//: The floating "+2" over a BONUS catch: how long it lasts, how far it rises,
//: and how far above the catch it starts so it never sits inside the burst's
//: own white flash. Only bonuses get one -- a number over every single point
//: would be constant noise.
export const POP_MS = 780;
export const POP_RISE_REL = 0.06;
export const POP_START_REL = 0.045;

//: The cheering animals along the bottom: company, not clutter, and never
//: something to catch.
export const MAX_SPECTATORS = 4;
export const SPECTATOR_REL = 0.13;
export const BOB_MS = 3200;
export const CHEER_MS = 650;
export const BOB_REL = 0.022;
export const HOP_REL = 0.07;

//: A frame longer than this is treated as time the child was not here for --
//: a backgrounded tab stops firing requestAnimationFrame, and charging that
//: gap to the round would end it the instant the tab came back. The desktop
//: build has no equivalent because a Qt timer keeps ticking either way.
const MAX_FRAME_MS = 100;

/** The canvas-free half of a game: world, clock, score, input. */
export class MiniGame {
  static GAME_KEY = "";
  //: Shown in the HUD and on the room's tile. A plain noun phrase, never
  //: anything evaluative -- a break game must not start grading anyone.
  static TITLE = "";
  //: Manifest sound key for scoring a point, declared per game so the rooms
  //: sound different without the screen knowing which game it built.
  static SCORE_SOUND = "select";
  //: Played instead when a catch was worth more than one. Shared by every
  //: game: a bonus should sound like a bonus wherever it happens.
  static BONUS_SOUND = "level_up";
  //: Theme key for this game's burst, so the effect matches what made it.
  static EFFECT_COLOUR = "progress_fill";

  constructor({ theme = {}, reducedMotion = false, rng = null, backdrop = null,
                spectators = [], fontFamily = "", onScore = null,
                onFinish = null } = {}) {
    this.theme = theme || {};
    this.reducedMotion = Boolean(reducedMotion);
    this.fontFamily = fontFamily;
    // Spawn positions only. MUST NOT be the trial rng -- drawing from that
    // stream would shift which triplets the child sees. Nothing here needs to
    // be reproducible: no trial, no reward schedule, no stimulus depends on it.
    this.rng = rng || { random: () => Math.random() };
    // Decoded <img> for the room's own interior, or null for flat colour.
    this.backdrop = backdrop;
    // Decoded animal <img>s that turn up to watch. Purely decorative: they sit
    // below the play area and cannot be caught, popped or clicked.
    this.spectators = (spectators || []).slice(0, MAX_SPECTATORS);
    // A point was just scored, carrying HOW MANY -- so the caller can play a
    // brighter sound for a bonus without this reaching into the sfx module.
    this.onScore = onScore;
    // (gameKey, score, durationMs) when the clock runs out. Only tick()
    // reaching ROUND_MS fires this: a round stopped any other way pays
    // nothing, because an interrupted round is not a result.
    this.onFinish = onFinish;

    this.score = 0;
    this._elapsedMs = 0;
    this._running = false;
    this._raf = 0;
    this._lastTs = 0;
    this._sinceFrame = 0;

    this._cheerT = 0;
    this._bobT = 0;
    // Catch/pop bursts still playing, and the floating "+N" a bonus leaves.
    this._effects = [];
    this._pops = [];

    this.canvas = null;
    this.ctx = null;
    // Layout in CSS pixels. Defaulted so the logic -- KiteFlyer's reach in
    // particular, which measures in pixels -- is well defined before any
    // canvas exists, which is what lets the tests run headless.
    this._size = { w: 720, h: 420 };
    this._detach = null;
  }

  get key() { return this.constructor.GAME_KEY; }
  get title() { return this.constructor.TITLE; }
  get scoreSound() { return this.constructor.SCORE_SOUND; }
  get bonusSound() { return this.constructor.BONUS_SOUND; }
  get effectColour() { return this.constructor.EFFECT_COLOUR; }

  // -- round lifecycle ----------------------------------------------------

  /** Begin a round from zero. Safe to call again for a replay -- the whole
   * point of the game rooms is another go without leaving the room. */
  start() {
    this.score = 0;
    this._elapsedMs = 0;
    this._effects = [];
    this._pops = [];
    this._cheerT = 0;
    this.resetWorld();
    this._running = true;
    this._lastTs = 0;
    this._sinceFrame = 0;
    this._loop();
    this.paint();
  }

  /**
   * Halt the frame loop WITHOUT finishing the round. A round stopped this way
   * pays nothing and records nothing: it is what a screen teardown does, and
   * an interrupted round is not a result.
   */
  stop() {
    this._running = false;
    if (this._raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._raf);
    }
    this._raf = 0;
  }

  get running() { return this._running; }
  get elapsedMs() { return this._elapsedMs; }
  get remainingMs() { return Math.max(0, ROUND_MS - this._elapsedMs); }

  _loop() {
    if (typeof requestAnimationFrame !== "function") return;
    const step = (ts) => {
      if (!this._running) return;
      const dt = this._lastTs ? Math.min(MAX_FRAME_MS, ts - this._lastTs) : FRAME_MS;
      this._lastTs = ts;
      // Reduced motion runs the world at half the frame rate, so accumulate
      // until a full slow frame is due rather than ticking tiny steps.
      this._sinceFrame += dt;
      const due = this.reducedMotion ? FRAME_MS_REDUCED : 0;
      if (this._sinceFrame >= due) {
        const chunk = this._sinceFrame;
        this._sinceFrame = 0;
        this.tick(chunk);
        this.paint();
      }
      if (this._running) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /**
   * Advance the round by `dtMs`, ending it at ROUND_MS.
   *
   * Public and time-agnostic on purpose: the frame loop calls it with the
   * real elapsed time, and a test calls it directly with whatever step it
   * likes rather than waiting 20 real seconds.
   */
  tick(dtMs) {
    // The round ends exactly once. Only the tick that CROSSES ROUND_MS
    // finishes it; anything after that is a no-op, so a caller still driving
    // frames (a late rAF, a test loop that overshoots) cannot pay a child
    // twice for one round.
    if (this._elapsedMs >= ROUND_MS) return;
    const dt = Math.max(0, Math.round(dtMs));
    this._elapsedMs += dt;
    this._advanceDecor(dt);
    this.advance(dt);
    if (this._elapsedMs >= ROUND_MS) {
      this._elapsedMs = ROUND_MS;
      this.stop();
      this.paint();
      if (this.onFinish) this.onFinish(this.key, this.score, ROUND_MS);
    }
  }

  /**
   * Score `points`, optionally leaving a burst at `at` ([x, y] in play-area
   * fractions) and setting the spectators cheering.
   *
   * `points` above one is a BONUS catch -- a firefly taken at its peak, a
   * whole ribbon of sparkles. It gets a bigger burst, a floating "+N" and a
   * brighter sound. This is the only place doing something well is worth more
   * than doing it at all, and it is deliberately additive: there is still
   * nothing that can go wrong, only something that can go better.
   */
  addPoint(at = null, points = 1) {
    this.score += points;
    this._cheerT = 1;
    if (at && !this.reducedMotion) {
      this._effects.push({ x: at[0], y: at[1], t: 0, big: points > 1 });
      if (points > 1) this._pops.push({ x: at[0], y: at[1], t: 0, n: points });
    }
    if (this.onScore) this.onScore(points);
  }

  /** Move the bursts and the spectators on. Separate from advance() so a
   * subclass cannot forget it. */
  _advanceDecor(dtMs) {
    this._bobT = (this._bobT + dtMs / BOB_MS) % 1;
    if (this._cheerT > 0) this._cheerT = Math.max(0, this._cheerT - dtMs / CHEER_MS);
    for (const e of this._effects) e.t += dtMs / EFFECT_MS;
    this._effects = this._effects.filter((e) => e.t < 1);
    for (const q of this._pops) q.t += dtMs / POP_MS;
    this._pops = this._pops.filter((q) => q.t < 1);
  }

  // -- subclass hooks -----------------------------------------------------

  /** Clear whatever the subclass is tracking. Called by start(). */
  resetWorld() {}

  /** Move the world on. Called once per frame with the elapsed ms. */
  advance(_dtMs) {}

  /** Draw the game itself into the play area. */
  paintPlayArea(_ctx, _rect) {}

  /** Draw this game's object -- one star, one bubble -- centred on (cx, cy).
   * Used for the objects AND the HUD counter, so the thing being counted
   * always looks like the thing on screen. */
  paintToken(_ctx, _cx, _cy, _size) {}

  // -- shared maths -------------------------------------------------------

  /** Everything that MOVES is multiplied by this. Reduced-stimulation mode
   * slows the whole world rather than only halving the frame rate. */
  speedScale() { return this.reducedMotion ? 0.6 : 1.0; }

  /**
   * How much quicker the round is right now than at the start: 1.0 rising to
   * RAMP_END as the clock runs out. Applied per FRAME rather than baked in at
   * spawn, so the whole screen accelerates together. Halved under
   * reduced-stimulation mode, which exists to keep motion predictable.
   */
  ramp() {
    const span = (RAMP_END - 1) * (this.reducedMotion ? 0.5 : 1);
    return 1 + span * Math.min(1, this._elapsedMs / ROUND_MS);
  }

  /** A uniform draw in [lo, hi) from this game's own stream. */
  uniform(lo, hi) { return lo + this.rng.random() * (hi - lo); }

  /** An integer in [lo, hi], inclusive both ends -- Python's randint. */
  randint(lo, hi) { return Math.floor(lo + this.rng.random() * (hi - lo + 1)); }

  /** The play area in CSS pixels: everything below the HUD strip. */
  playRect() {
    const { w, h } = this._size;
    const top = Math.round(h * HUD_REL_HEIGHT);
    return { x: 0, y: top, w, h: Math.max(1, h - top) };
  }

  // -- canvas -------------------------------------------------------------

  /**
   * Give the game a canvas to draw on and events to listen to. Returns a
   * teardown function; calling it (or detach()) stops the loop and unhooks
   * everything, which is what a screen leaving must do.
   */
  attach(canvas) {
    this.detach();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    canvas.style.touchAction = "none";     // or a drag scrolls the page instead

    const resize = () => this._resize();
    const down = (ev) => {
      canvas.setPointerCapture?.(ev.pointerId);
      this.onPointer(this._at(ev), true);
    };
    const move = (ev) => this.onPointer(this._at(ev), false);
    const key = (ev) => {
      const dir = { ArrowLeft: "left", ArrowRight: "right",
                    ArrowUp: "up", ArrowDown: "down" }[ev.key];
      if (!dir) return;
      ev.preventDefault();               // arrows must not scroll the page
      this.onArrow(dir);
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("keydown", key);
    let observer = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", resize);
    }
    this._resize();

    this._detach = () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      window.removeEventListener("keydown", key);
      if (observer) observer.disconnect();
      else if (typeof window !== "undefined") window.removeEventListener("resize", resize);
    };
    return this._detach;
  }

  detach() {
    this.stop();
    if (this._detach) this._detach();
    this._detach = null;
    this.canvas = null;
    this.ctx = null;
  }

  /** Match the backing store to the CSS box AND the device pixel ratio: a
   * canvas sized only in CSS pixels renders soft on every phone. */
  _resize() {
    const c = this.canvas;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || c.clientWidth || this._size.w));
    const h = Math.max(1, Math.round(rect.height || c.clientHeight || this._size.h));
    const dpr = Math.min(3, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    this._size = { w, h };
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    // Null in jsdom (no 2D backend unless node-canvas is installed), which
    // the browser harness runs in -- the game must still play there, just
    // unseen, exactly as it does with no canvas at all.
    this.ctx = c.getContext("2d");
    if (!this.ctx) return;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paint();
  }

  /** Pointer position as play-area fractions, clamped to the area. */
  _at(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const play = this.playRect();
    const x = (ev.clientX - rect.left - play.x) / Math.max(1, play.w);
    const y = (ev.clientY - rect.top - play.y) / Math.max(1, play.h);
    return { x, y, inHud: ev.clientY - rect.top < play.y };
  }

  /** A press (`pressed`) or a move, in play-area fractions. */
  onPointer(_pos, _pressed) {}

  /** One arrow key: "left" | "right" | "up" | "down". */
  onArrow(_dir) {}

  // -- painting -----------------------------------------------------------

  paint() {
    const ctx = this.ctx;
    if (!ctx) return;
    const th = this.theme;
    const { w, h } = this._size;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = th.background || "#FAF6EF";
    ctx.fillRect(0, 0, w, h);

    const play = this.playRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(play.x, play.y, play.w, play.h);
    ctx.clip();
    this._paintBackdrop(ctx, play);
    // Spectators behind the game, bursts in front of it: the animals are
    // scenery, the burst belongs to the thing the child just hit.
    this.paintSpectators(ctx, play);
    this.paintPlayArea(ctx, play);
    this.paintEffects(ctx, play);
    ctx.restore();

    this._paintHud(ctx, w, h);
  }

  _paintBackdrop(ctx, play) {
    const img = this.backdrop;
    if (!img || !img.width) return;
    // Cover, cropped from the centre -- the same treatment the room canvas
    // gives a room, so the two screens scale their art identically.
    const scale = Math.max(play.w / img.width, play.h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, play.x + (play.w - dw) / 2, play.y + (play.h - dh) / 2, dw, dh);
  }

  /**
   * The animals that came to watch, along the bottom of the room. Drawn
   * FIRST, behind everything, and low enough to sit on the floor: they are
   * company, not obstacles, and a child must never wonder whether one is
   * catchable. They bob on a slow loop and hop when a point lands -- which is
   * the whole reason they are here, since this game has no failure state and
   * therefore nothing else that reacts to doing well.
   *
   * Under reduced motion they are still DRAWN, just still: the mode is about
   * motion, and an empty room would be a different game rather than a calmer
   * one.
   */
  paintSpectators(ctx, rect) {
    if (!this.spectators.length) return;
    const size = Math.max(24, Math.round(Math.min(rect.w, rect.h) * SPECTATOR_REL));
    const gap = rect.w / (this.spectators.length + 1);
    this.spectators.forEach((img, i) => {
      if (!img || !img.width) return;
      let bob = 0;
      if (!this.reducedMotion) {
        const phase = (this._bobT + i / this.spectators.length) % 1;
        bob = Math.sin(phase * 2 * Math.PI) * size * BOB_REL;
        bob -= Math.sin(this._cheerT * Math.PI) * size * HOP_REL;
      }
      const dh = size;
      const dw = size * (img.width / Math.max(1, img.height));
      ctx.drawImage(img, rect.x + gap * (i + 1) - dw / 2,
                    rect.y + rect.h - dh - size * 0.12 + bob, dw, dh);
    });
  }

  /**
   * The burst left behind by a caught star or a popped bubble: a bright core
   * that flashes and shrinks, then chunky sparks thrown outward in the game's
   * own colour, so the burst reads as coming from the thing that made it.
   * Nothing is added under reduced motion -- addPoint never records one there.
   */
  paintEffects(ctx, rect) {
    if (!this._effects.length && !this._pops.length) return;
    const base = this.theme[this.effectColour] || "#D9BE86";
    const unit = Math.min(rect.w, rect.h);

    for (const e of this._effects) {
      const t = e.t;
      const cx = rect.x + e.x * rect.w;
      const cy = rect.y + e.y * rect.h;
      const ease = 1 - (1 - t) ** 2;          // fast out, gentle settle
      // A bonus throws its burst half again as wide. Same shape, so it reads
      // as more of the same good thing rather than a different event.
      const gain = e.big ? 1.5 : 1;

      // The core is the part that actually registers -- an expanding outline
      // alone read as a hoop drawn on the room. Small: a punctuation mark,
      // not the subject.
      ctx.fillStyle = rgba("#FFFFFF", Math.max(0, 0.9 * (1 - t) ** 1.5));
      const coreR = unit * 0.028 * gain * (1 - t * 0.7);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, coreR), 0, Math.PI * 2);
      ctx.fill();

      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + t * 0.6;
        const d = unit * (0.035 + 0.10 * ease) * gain;
        const sr = unit * 0.022 * gain * (1 - t);
        if (sr < 1) continue;
        ctx.fillStyle = rgba(base, Math.max(0, 0.92 * (1 - t)));
        ctx.beginPath();
        ctx.arc(cx + d * Math.cos(a), cy + d * Math.sin(a), sr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The floating "+N" over a bonus, drawn last so it sits over its own
    // burst. A NUMBER rather than a word: it says what was earned without
    // saying anything about the child ("Great!" would be a judgment, "+2" is
    // a quantity). White on a dark outline, because a game room's backdrop
    // can be a night sky or pale tilework and this has to read on both.
    for (const q of this._pops) {
      const t = q.t;
      const cx = rect.x + q.x * rect.w;
      const rise = POP_START_REL + POP_RISE_REL * (1 - (1 - t) ** 2);
      const cy = rect.y + (q.y - rise) * rect.h;
      const alpha = Math.min(1, (1 - t) * 2.2);
      if (alpha <= 0) continue;
      ctx.save();
      ctx.font = this._font(24, true);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeStyle = rgba("#241F1A", alpha);
      ctx.strokeText(`+${q.n}`, cx, cy);
      ctx.fillStyle = rgba("#FFFFFF", alpha);
      ctx.fillText(`+${q.n}`, cx, cy);
      ctx.restore();
    }
  }

  _font(px, bold = false) {
    const scale = Number(this.theme.ui_scale) || 1;
    const size = Math.max(10, Math.round(px * scale));
    const family = this.fontFamily ? `"${this.fontFamily}", sans-serif` : "sans-serif";
    return `${bold ? "bold " : ""}${size}px ${family}`;
  }

  /** The score, and how much of the round is left. The bar uses the progress
   * palette rather than anything green: a filling bar is not response
   * feedback here either, and the two must not read differently. */
  _paintHud(ctx, w, h) {
    const th = this.theme;
    const hudH = Math.round(h * HUD_REL_HEIGHT);
    const token = Math.max(14, Math.round(hudH * 0.45));

    ctx.save();
    this.paintToken(ctx, 14 + token / 2, hudH / 2, token);
    ctx.restore();

    ctx.save();
    ctx.font = this._font(20, true);
    ctx.fillStyle = th.text || "#33302B";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(String(this.score), 22 + token, hudH / 2);
    ctx.restore();

    const barW = Math.round(w * 0.42);
    const barH = Math.max(8, Math.round(10 * (Number(th.ui_scale) || 1)));
    const barX = w - barW - 14;
    const barY = Math.round((hudH - barH) / 2);
    roundRect(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fillStyle = th.progress_track || "#EDE5D8";
    ctx.fill();
    const left = ROUND_MS ? this.remainingMs / ROUND_MS : 0;
    if (left > 0) {
      roundRect(ctx, barX, barY, Math.max(barH, Math.round(barW * left)), barH, barH / 2);
      ctx.fillStyle = th.progress_fill || "#D9BE86";
      ctx.fill();
    }

    // A soft frame, matching the playground room's diorama edge so the two
    // screens read as the same place.
    roundRect(ctx, 2, 2, w - 4, h - 4, 16);
    ctx.strokeStyle = th.progress_track || "#EDE5D8";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

/** A rounded rectangle path. Canvas2D has roundRect() only in newer browsers,
 * and this build targets whatever tablet a family owns. */
export function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export { lighten, darken, rgba };

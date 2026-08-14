/**
 * Every mini-game, by the key castle.js ARCADE_ROOMS stores. The screens look
 * a room's game up here rather than branching on the key, so adding another
 * game is a room index plus an entry.
 *
 * Port of GAMES / build_game in experiments/minigames.py.
 */

import { StarCatcher } from "./star_catcher.js";
import { BubblePop } from "./bubble_pop.js";
import { FireflyCatch } from "./firefly_catch.js";
import { KiteFlyer } from "./kite_flyer.js";

export { StarCatcher, BubblePop, FireflyCatch, KiteFlyer };
export * from "./engine.js";

export const GAMES = {
  [StarCatcher.GAME_KEY]: StarCatcher,
  [BubblePop.GAME_KEY]: BubblePop,
  [FireflyCatch.GAME_KEY]: FireflyCatch,
  [KiteFlyer.GAME_KEY]: KiteFlyer,
};

/** The one small line above a game room. Says what to DO and nothing about
 * how well it is going, matching the dialogue bank's neutrality rules -- a
 * break game must not start grading anyone either. */
export const HINTS = {
  star_catcher: "Catch the falling stars! Move the basket with your finger.",
  bubble_pop: "Pop the bubbles! Tap them before they float away.",
  firefly_catch: "Tap a firefly when it glows brightest.",
  kite_flyer: "Fly the kite onto the sparkles! Drag it or use the arrows.",
};

export function hintFor(key) {
  return HINTS[key] || HINTS.star_catcher;
}

export function titleFor(key) {
  return GAMES[key] ? GAMES[key].TITLE : "";
}

/**
 * The game for a key, or null if the key is unknown -- a save naming a game
 * this build does not have must degrade to "no game room", not crash a
 * session mid-break.
 */
export function buildGame(key, opts = {}) {
  const Cls = GAMES[key];
  return Cls ? new Cls(opts) : null;
}

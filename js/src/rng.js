/**
 * Seeded randomness. Every stream in the task is derived from the participant
 * id so a session is reproducible from its data file.
 *
 * NOTE ON PARITY: this does not reproduce Python's Mersenne Twister, so the
 * JS build and the PyQt build will not generate identical triplets for the
 * same participant id. Within the JS build a given id is fully reproducible,
 * which is what matters for re-running or auditing a session. Do not assume
 * cross-implementation equivalence when comparing arms.
 */

/** FNV-1a: a small, stable string hash for deriving stream seeds. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: compact, well-distributed, good enough for stimulus ordering. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random: next,
    /** Integer in [lo, hi], inclusive at both ends (like Python randint). */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    choice: (arr) => arr[Math.floor(next() * arr.length)],
    /** Fisher-Yates, in place. */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

/** A named stream for a participant, e.g. stream("P01", "triplets"). */
export function stream(participantId, name) {
  return makeRng(hashSeed(`${participantId}_${name}`));
}

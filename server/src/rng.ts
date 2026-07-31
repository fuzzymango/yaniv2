/**
 * A random source returning a float in [0, 1), same contract as `Math.random`.
 *
 * Every function that needs randomness takes one of these as an explicit argument
 * rather than reaching for `Math.random`, so a test can seed it and replay an exact
 * deal. Those functions are pure *given* an rng; the rng itself carries the mutable
 * bit of state.
 */
export type Rng = () => number;

/** Non-deterministic source for production use. */
export const systemRng: Rng = () => Math.random();

/**
 * mulberry32 — small, fast, well-distributed seeded PRNG. Zero dependencies, and
 * identical output for the same seed across runs and platforms, which is the whole
 * point: a failing round can be reproduced from its seed.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniformly pick an integer in [0, maxExclusive). */
export function randomInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/**
 * Presentation-only seeded randomness (ANIM-03). It is deliberately separate from the runtime's
 * PRNG: blinking and idle variation must never consume or perturb authoritative randomness.
 */
export interface PresentationRandom {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
}

export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32: small, fast and identical everywhere for integer arithmetic. */
export function createPresentationRandom(seed: string): PresentationRandom {
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, range: (min, max) => min + (max - min) * next() };
}

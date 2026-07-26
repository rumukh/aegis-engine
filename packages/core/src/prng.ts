/**
 * Seeded, deterministic pseudo-random number generation.
 *
 * `Math.random()` is banned in simulation code (CHARTER principle 3). All randomness flows
 * through a {@link Prng} seeded from the run's seed. Because system execution order is fixed,
 * a single shared stream is deterministic; however systems SHOULD {@link Prng.fork} a named
 * sub-stream so that adding or reordering a consumer does not shift every downstream draw.
 *
 * The concrete algorithm (a small, fast, well-distributed generator such as SplitMix64 /
 * PCG-XSH-RR) is fixed by the implementation and documented in ADR-0001; it must be pure
 * integer/float arithmetic with no platform dependence.
 *
 * Aegis uses **sfc32** (Small Fast Counter, 128-bit state as four unsigned 32-bit words):
 * it passes PractRand, is trivially serialisable, and runs entirely in `Math.imul`/`>>> 0`
 * 32-bit arithmetic, so every draw is bit-identical on every platform. Any seed (number or
 * string) is expanded to the four state words with a SplitMix32 stretch of an FNV-1a digest.
 * @packageDocumentation
 */

/** Serialisable PRNG state. Snapshotting the world captures this so replays are exact. */
export interface PrngState {
  /** Opaque generator words. Shape is owned by the implementation. */
  readonly s: readonly number[];
}

/** A deterministic random stream. */
export interface Prng {
  /** Next unsigned 32-bit integer in `[0, 2^32)`. */
  nextUint32(): number;
  /** Next float in `[0, 1)`. */
  nextFloat(): number;
  /** Uniform float in `[minInclusive, maxExclusive)`. */
  range(minInclusive: number, maxExclusive: number): number;
  /** Uniform integer in `[minInclusive, maxExclusive)`. */
  int(minInclusive: number, maxExclusive: number): number;
  /** `true` with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** Uniformly pick an element, or throw on an empty array. */
  pick<T>(items: readonly T[]): T;
  /**
   * Derive an independent named sub-stream. The same `streamId` always yields the same
   * sub-stream for a given parent state, decoupling consumers from global draw order.
   */
  fork(streamId: string): Prng;
  /** Snapshot the current state. */
  save(): PrngState;
  /** Restore a previously saved state. */
  load(state: PrngState): void;
}

/** FNV-1a 32-bit digest of a string; used to fold a seed into a 32-bit word. */
function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h ^= code & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= code >>> 8;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** SplitMix32 step: expands one 32-bit seed into a well-mixed stream of 32-bit words. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Canonical string form of a numeric seed (so `1` and `"1"` seed identically). */
function seedToString(seed: number): string {
  return Object.is(seed, -0) ? '0' : String(seed);
}

/** Expand any seed into four non-trivial 32-bit state words. */
function seedWords(seed: number | string): [number, number, number, number] {
  const base = fnv1a32(typeof seed === 'number' ? seedToString(seed) : seed);
  const next = splitmix32((base ^ 0x9e3779b9) >>> 0);
  const w: [number, number, number, number] = [next(), next(), next(), next()];
  if ((w[0] | w[1] | w[2] | w[3]) === 0) w[0] = 0x1; // avoid the degenerate all-zero state
  return w;
}

class Sfc32 implements Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(words: readonly [number, number, number, number]) {
    this.a = words[0] >>> 0;
    this.b = words[1] >>> 0;
    this.c = words[2] >>> 0;
    this.d = words[3] >>> 0;
    // Warm up so early outputs are well mixed regardless of seed.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    const a = this.a >>> 0;
    const b = this.b >>> 0;
    const c = this.c >>> 0;
    const d = this.d >>> 0;
    let t = (a + b) >>> 0;
    t = (t + d) >>> 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) >>> 0;
    this.c = (((c << 21) | (c >>> 11)) + t) >>> 0;
    this.d = (d + 1) >>> 0;
    return t >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  range(minInclusive: number, maxExclusive: number): number {
    return minInclusive + this.nextFloat() * (maxExclusive - minInclusive);
  }

  int(minInclusive: number, maxExclusive: number): number {
    const lo = Math.floor(minInclusive);
    const hi = Math.floor(maxExclusive);
    const span = hi - lo;
    if (span <= 0) return lo;
    return lo + Math.floor(this.nextFloat() * span);
  }

  bool(p: number = 0.5): boolean {
    return this.nextFloat() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('[aegis] Prng.pick: cannot pick from an empty array');
    return items[this.int(0, items.length)] as T;
  }

  fork(streamId: string): Prng {
    // Pure function of (current state, streamId): mix the four words with a digest of the id
    // through SplitMix32. Does not consume the parent's stream.
    const h = fnv1a32(streamId);
    const next = splitmix32((this.a ^ h) >>> 0);
    const words: [number, number, number, number] = [
      (next() ^ this.b) >>> 0,
      (next() ^ this.c) >>> 0,
      (next() ^ this.d) >>> 0,
      (next() ^ h) >>> 0,
    ];
    if ((words[0] | words[1] | words[2] | words[3]) === 0) words[0] = 0x1;
    return new Sfc32(words);
  }

  save(): PrngState {
    return { s: [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0] };
  }

  load(state: PrngState): void {
    const s = state.s;
    if (s.length !== 4) throw new Error('[aegis] Prng.load: expected 4 state words');
    this.a = (s[0] as number) >>> 0;
    this.b = (s[1] as number) >>> 0;
    this.c = (s[2] as number) >>> 0;
    this.d = (s[3] as number) >>> 0;
  }
}

/** Create a PRNG from a numeric or string seed. */
export function createPrng(seed: number | string): Prng {
  return new Sfc32(seedWords(seed));
}

/** Restore a PRNG directly from a saved {@link PrngState}. */
export function prngFromState(state: PrngState): Prng {
  const p = new Sfc32([1, 1, 1, 1]);
  p.load(state);
  return p;
}

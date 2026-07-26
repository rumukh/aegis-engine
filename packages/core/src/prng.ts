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
 * @packageDocumentation
 */
import { notImplemented } from './util.js';

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

/** Create a PRNG from a numeric or string seed. */
export function createPrng(seed: number | string): Prng {
  return notImplemented(`createPrng(${String(seed)})`);
}

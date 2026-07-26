/**
 * State hashing — the linchpin of "deterministic by construction" (CHARTER principle 3).
 *
 * A {@link StateHash} is a short, stable digest of a {@link WorldSnapshot}. The determinism
 * contract is: *same scene + same input script + same seed ⇒ identical `StateHash` on every
 * machine, every run.* QA proves this by hashing after N ticks and comparing across repeated
 * runs and operating systems.
 *
 * The hash is computed over {@link "./serialize".canonicalStringify} of the snapshot using a
 * fixed non-cryptographic 64-bit hash (e.g. FNV-1a), rendered as 16 lowercase hex chars.
 * The algorithm is frozen: changing it is a breaking change to every stored replay.
 * @packageDocumentation
 */
import { notImplemented } from './util.js';
import type { WorldSnapshot } from './serialize.js';

/** A 16-char lowercase-hex digest of world state. */
export type StateHash = string;

/** Hash a full world snapshot. */
export function hashSnapshot(snapshot: WorldSnapshot): StateHash {
  return notImplemented('hashSnapshot');
}

/** Hash an already-canonicalised string (lower level; most callers use {@link hashSnapshot}). */
export function hashString(canonical: string): StateHash {
  return notImplemented('hashString');
}

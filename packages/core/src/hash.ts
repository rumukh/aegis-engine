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
import { canonicalStringify } from './serialize.js';
import type { WorldSnapshot } from './serialize.js';

/** A 16-char lowercase-hex digest of world state. */
export type StateHash = string;

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Hash a full world snapshot. */
export function hashSnapshot(snapshot: WorldSnapshot): StateHash {
  return hashString(canonicalStringify(snapshot));
}

/**
 * Hash an already-canonicalised string (lower level; most callers use {@link hashSnapshot}).
 *
 * FNV-1a over the string's UTF-16 code units, processed low-byte-then-high-byte so the digest
 * depends only on the (platform-independent) string content, never on any text encoder.
 */
export function hashString(canonical: string): StateHash {
  let h = FNV_OFFSET_64;
  for (let i = 0; i < canonical.length; i++) {
    const code = canonical.charCodeAt(i);
    h = ((h ^ BigInt(code & 0xff)) * FNV_PRIME_64) & MASK_64;
    h = ((h ^ BigInt(code >>> 8)) * FNV_PRIME_64) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

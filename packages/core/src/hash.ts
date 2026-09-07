/**
 * State hashing — the linchpin of "deterministic by construction" (CHARTER principle 3).
 *
 * A {@link StateHash} is a short, stable digest of a {@link WorldSnapshot}. The determinism
 * contract is: *same scene + same input script + same seed ⇒ identical `StateHash` on every
 * machine, every run.* QA proves this by hashing after N ticks and comparing across repeated
 * runs and operating systems.
 *
 * The hash is computed over {@link "./serialize".canonicalStringify} of the snapshot using a
 * fixed non-cryptographic 64-bit hash (FNV-1a), rendered as 16 lowercase hex chars.
 * The algorithm is frozen: changing it is a breaking change to every stored replay.
 * @packageDocumentation
 */
import { canonicalStringify } from './serialize.js';
import type { WorldSnapshot } from './serialize.js';

/** A 16-char lowercase-hex digest of world state. */
export type StateHash = string;

const FNV_OFFSET_HIGH = 0xcbf29ce4;
const FNV_OFFSET_LOW = 0x84222325;
const FNV_PRIME_LOW = 0x1b3;

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
  // The prime is 2^40 + 0x1b3. In two 32-bit words, its shifted term contributes
  // only low << 8 to the high word. low * 0x1b3 is below 2^41, so Number keeps
  // every carry bit exactly; imul and >>> 0 reduce the other terms modulo 2^32.
  let high = FNV_OFFSET_HIGH;
  let low = FNV_OFFSET_LOW;
  for (let i = 0; i < canonical.length; i++) {
    const code = canonical.charCodeAt(i);
    low = (low ^ (code & 0xff)) >>> 0;
    let product = low * FNV_PRIME_LOW;
    high = (Math.imul(high, FNV_PRIME_LOW) + (low << 8) + Math.floor(product / 0x100000000)) >>> 0;

    low = ((product >>> 0) ^ (code >>> 8)) >>> 0;
    product = low * FNV_PRIME_LOW;
    high = (Math.imul(high, FNV_PRIME_LOW) + (low << 8) + Math.floor(product / 0x100000000)) >>> 0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

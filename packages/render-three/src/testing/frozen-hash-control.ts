/**
 * Frozen CPU work for the frame-pacing denominator, not a product hash implementation.
 * Keep the pre-optimization BigInt kernel: matching hash bytes alone does not preserve its
 * cost. Do not optimize this helper or replace it with a call into core's live hashString.
 */
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function frozenHashControl(text: string): string {
  let h = FNV_OFFSET_64;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h = ((h ^ BigInt(code & 0xff)) * FNV_PRIME_64) & MASK_64;
    h = ((h ^ BigInt(code >>> 8)) * FNV_PRIME_64) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

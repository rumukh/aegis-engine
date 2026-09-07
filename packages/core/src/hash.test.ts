import { describe, expect, it } from 'vitest';
import { hashString } from './hash.js';
import { createPrng } from './prng.js';

// Keep the pre-optimization implementation independent of the production word arithmetic.
function referenceHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h = ((h ^ BigInt(code & 0xff)) * 0x100000001b3n) & 0xffffffffffffffffn;
    h = ((h ^ BigInt(code >>> 8)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Captured before changing hash.ts and cross-checked with a separate UTF-16LE byte reader
// using BigInt shift/add multiplication. The packed "foobar" case is also the standard
// FNV-1a-64 byte-vector answer, independent of Aegis's string encoding.
const KNOWN_ANSWERS = [
  ['empty', '', 'cbf29ce484222325'],
  ['NUL', '\u0000', '08328807b4eb6fed'],
  ['ASCII', 'hello', '32964f71b2764b97'],
  ['ASCII with controls', 'A\0B\r\n\t', 'bb942cd5f290f548'],
  ['Latin-1', '\u00e9', '0a6a1207b6cd9fac'],
  ['high byte', '\u1234', '07ee9e07b4b1c883'],
  ['low byte only', '\u00ff', '0a99a607b6f60bea'],
  ['high byte only', '\uff00', '0831c907b4ea2b60'],
  ['highest code unit', '\uffff', '0a99c907b6f64763'],
  ['supplementary code point', '\ud83d\ude00', 'f39a100fb654058a'],
  ['lowest high surrogate', '\ud800', '0831b007b4ea00e5'],
  ['highest high surrogate', '\udbff', '0a99ed07b6f6848f'],
  ['lowest low surrogate', '\udc00', '0831ac07b4e9fa19'],
  ['highest low surrogate', '\udfff', '0a99e907b6f67dc3'],
  ['reversed surrogate pair', '\ude00\ud83d', 'c9af567b5c34e116'],
  ['separated unpaired surrogates', '\ud800A\udfff', '87436a028c4d4ffa'],
  ['non-normalized accent', 'e\u0301', '2c98fe60b57bd550'],
  ['BOM', '\ufeff', '0a99c807b6f645b0'],
  ['FNV byte vector foobar', '\u6f66\u626f\u7261', '85944171f73967e8'],
] as const;

// Prefixes found by inverting the old FNV low word, with digests independently checked as
// above. Appending NUL leaves that exact boundary value unmodified for the next multiply;
// appending FFFF also exercises both XORs. 0096a850/51 straddle the first carry at * 435.
const WORD_BOUNDARIES = [
  ['00000000', '\u0000\uc808\u3e9f', '136d64bb00000000', 'e64cf2f300000000', 'e9aff1f302e0f176'],
  ['00000001', '\u0000\uf9d4\u3970', '18f3fd1a00000001', '52b8fd2a0002e329', '5614962a02dd089f'],
  ['0096a850', '\u0000\u2817\uea2c', 'c8189f670096a850', '2017be31ffffe4d0', '215add320112a646'],
  ['0096a851', '\u0000\ufcf4\u45ff', 'c4f4a5130096a851', 'c3b790be0002c7f9', 'c4f349be010ebd6f'],
  ['7fffffff', '\u0001\u4fa0\u0579', '835ed1a57fffffff', 'c15cee017ffd1cd7', 'bdfb53017d1e884d'],
  ['80000000', '\u0000\u4c7a\u56e9', '654eb22e80000000', '65f6c4f280000000', '6959c3f282e0f176'],
  ['fffffffe', '\u0000\uaed8\u2942', 'cd3417fefffffffe', '3e9628d6fffa39ae', '3b39f3d6fd1f0b24'],
  ['ffffffff', '\u0001\uf08e\u0dd2', 'f308ddcbffffffff', '84ac03abfffd1cd7', '814a68abfd1e884d'],
] as const;

describe('hashString - frozen FNV-1a-64 compatibility', () => {
  it.each(KNOWN_ANSWERS)('%s has its independently pinned digest', (_label, text, expected) => {
    expect(referenceHash(text)).toBe(expected);
    expect(hashString(text)).toBe(expected);
  });

  it.each(WORD_BOUNDARIES)(
    'preserves carries, overflow and padding from low word %s',
    (lowWord, prefix, prefixHash, afterNul, afterFFFF) => {
      expect(prefixHash.slice(8)).toBe(lowWord);
      for (const [text, expected] of [
        [prefix, prefixHash],
        [prefix + '\0', afterNul],
        [prefix + '\uffff', afterFFFF],
      ] as const) {
        expect(referenceHash(text)).toBe(expected);
        expect(hashString(text)).toBe(expected);
      }
    },
  );

  it('matches the old algorithm for every individual UTF-16 code unit', () => {
    for (let code = 0; code <= 0xffff; code++) {
      const text = String.fromCharCode(code);
      expect(hashString(text), `code unit ${code.toString(16)}`).toBe(referenceHash(text));
    }
  });

  it('matches the old algorithm across the complete code-unit range in one string', () => {
    const text = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).join('');
    expect(hashString(text)).toBe(referenceHash(text));
  });

  it.each([0, 1, 42, 0x7fffffff, 0x80000000, 0xffffffff])(
    'matches deterministic generated strings with seed %s',
    (seed) => {
      const random = createPrng(seed);
      for (let sample = 0; sample < 256; sample++) {
        const mask = sample % 3 === 0 ? 0x7f : sample % 3 === 1 ? 0xff : 0xffff;
        const text = Array.from({ length: random.int(0, 513) }, () =>
          String.fromCharCode(random.nextUint32() & mask),
        ).join('');
        expect(hashString(text), `seed ${seed}, sample ${sample}`).toBe(referenceHash(text));
      }
    },
  );

  it.each([31, 32, 33, 255, 256, 257, 65535, 65536, 65537, 1048576])(
    'matches the old algorithm over %s mixed code units',
    (length) => {
      const pattern = '\u0000\u00ff\u0100\u7fff\u8000\ud800A\udfff';
      const text = pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
      expect(hashString(text)).toBe(referenceHash(text));
    },
  );
});

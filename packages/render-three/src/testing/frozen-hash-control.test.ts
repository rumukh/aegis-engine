import { describe, expect, it } from 'vitest';
import { frozenHashControl } from './frozen-hash-control.js';

describe('the frozen frame-pacing CPU control', () => {
  it('matches the standard FNV-1a-64 foobar byte-vector answer', () => {
    expect(frozenHashControl('\u6f66\u626f\u7261')).toBe('85944171f73967e8');
  });

  it('retains the pinned answers for all 200 control inputs', () => {
    // Captured from the old kernel before the core optimization, independently cross-checked
    // with a UTF-16LE byte reader and BigInt shift/add multiplication.
    expect(frozenHashControl('aegis-frame-pacing-control-0')).toBe('c7180c531da078fc');
    expect(frozenHashControl('aegis-frame-pacing-control-199')).toBe('8b45957b3a58ee0d');
    let combined = 0n;
    for (let i = 0; i < 200; i++) {
      combined ^= BigInt(`0x${frozenHashControl(`aegis-frame-pacing-control-${i}`)}`);
    }
    expect(combined.toString(16).padStart(16, '0')).toBe('06ed7400003293e0');
  });
});

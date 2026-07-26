import { describe, it, expect } from 'vitest';
import { fpsPlugin, CapsuleBody, LookState } from './index.js';

describe('@aegis/mode-fps', () => {
  it('exposes a well-formed plugin', () => {
    expect(fpsPlugin.mode).toBe('fps');
    expect(fpsPlugin.components().length).toBeGreaterThan(0);
    expect(fpsPlugin.view().mode).toBe('fps');
  });

  it('components construct with sensible defaults', () => {
    expect(CapsuleBody().value.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(LookState().value).toEqual({ yawDeg: 0, pitchDeg: 0 });
  });
});

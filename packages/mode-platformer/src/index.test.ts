import { describe, it, expect } from 'vitest';
import { platformerPlugin, Velocity, PlatformerController } from './index.js';

describe('@aegis/mode-platformer', () => {
  it('exposes a well-formed plugin', () => {
    expect(platformerPlugin.mode).toBe('platformer');
    expect(platformerPlugin.components().length).toBeGreaterThan(0);
    expect(platformerPlugin.view().mode).toBe('platformer');
  });

  it('components construct with sensible defaults', () => {
    expect(Velocity().value).toEqual({ dx: 0, dy: 0 });
    expect(PlatformerController({ moveSpeed: 10 }).value.moveSpeed).toBe(10);
  });
});

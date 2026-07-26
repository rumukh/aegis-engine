import { describe, it, expect } from 'vitest';
import { isoPlugin, GridPosition, MoveOrder } from './index.js';

describe('@aegis/mode-iso', () => {
  it('exposes a well-formed plugin', () => {
    expect(isoPlugin.mode).toBe('iso');
    expect(isoPlugin.components().length).toBeGreaterThan(0);
    expect(isoPlugin.view().mode).toBe('iso');
  });

  it('components construct with sensible defaults', () => {
    expect(GridPosition().value).toEqual({ cellX: 0, cellY: 0, progress: 0 });
    expect(MoveOrder().value.resolved).toBe(false);
  });
});

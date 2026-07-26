import { describe, it, expect } from 'vitest';
import { createRenderer, startDevServer } from './index.js';

describe('@aegis/render-three public surface', () => {
  it('exposes the adapter factory and dev server', () => {
    expect(typeof createRenderer).toBe('function');
    expect(typeof startDevServer).toBe('function');
  });
});

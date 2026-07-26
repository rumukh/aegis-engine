/**
 * Adapter selection: map a {@link GameMode} to its render adapter.
 * @packageDocumentation
 */
import type { GameMode } from '@aegis/core';
import type { RenderAdapter, RenderAdapterOptions } from '../adapter.js';
import { createPlatformerAdapter } from './platformer.js';
import { createIsoAdapter } from './iso.js';
import { createFpsAdapter } from './fps.js';

/**
 * Create the render adapter for `mode`. The adapter builds a `THREE.Scene` and camera only — it
 * touches no GPU state, so this is safe to call in Node (which is exactly how the non-interference
 * proof runs it against a live world).
 */
export function createRenderAdapter(mode: GameMode, options?: RenderAdapterOptions): RenderAdapter {
  switch (mode) {
    case 'platformer':
      return createPlatformerAdapter(options);
    case 'iso':
      return createIsoAdapter(options);
    case 'fps':
      return createFpsAdapter(options);
    default: {
      const unknown: never = mode;
      throw new Error(`[aegis:render-three] unknown mode "${String(unknown)}"`);
    }
  }
}

import { describe, it, expect } from 'vitest';
import {
  AEGIS_VERSION,
  createWorld,
  createSimulation,
  defineComponent,
  Transform,
  SYSTEM_PHASES,
  NULL_ENTITY,
  EMPTY_INPUT_FRAME,
  PI,
} from './index.js';

describe('@aegis/core public surface', () => {
  it('exposes the version', () => {
    expect(AEGIS_VERSION).toBe('0.0.0');
  });

  it('exposes the primary factories as functions', () => {
    expect(typeof createWorld).toBe('function');
    expect(typeof createSimulation).toBe('function');
    expect(typeof defineComponent).toBe('function');
  });

  it('defines the fixed phase order', () => {
    expect(SYSTEM_PHASES[0]).toBe('input');
    expect(SYSTEM_PHASES).toContain('physics');
    expect(SYSTEM_PHASES[SYSTEM_PHASES.length - 1]).toBe('cleanup');
  });

  it('exposes stable constants', () => {
    expect(NULL_ENTITY).toBe(0);
    expect(EMPTY_INPUT_FRAME.pointer).toBeNull();
    expect(PI).toBeCloseTo(Math.PI);
  });

  it('registers the universal Transform component with a stable id', () => {
    expect(Transform.id).toBe('Transform');
  });
});

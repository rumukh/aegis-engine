import { describe, it, expect } from 'vitest';
import {
  parseInputScript,
  runScene,
  defineGameTest,
  GameAssertionError,
  InvariantError,
} from './index.js';

describe('@aegis/harness public surface', () => {
  it('exposes the runner and input parser', () => {
    expect(typeof runScene).toBe('function');
    expect(typeof parseInputScript).toBe('function');
  });

  it('defineGameTest returns the test verbatim (identity helper)', () => {
    const test = defineGameTest({
      name: 'reaches the goal',
      scene: 'scenes/level1.scene.json',
      options: { plugin: undefined as never },
      ticks: 120,
      input: 'hold Right 0..90',
      expect: () => {},
    });
    expect(test.name).toBe('reaches the goal');
    expect(test.ticks).toBe(120);
  });

  it('exposes typed error classes', () => {
    expect(new GameAssertionError('x')).toBeInstanceOf(Error);
    const inv = new InvariantError('grounded', 42);
    expect(inv.tick).toBe(42);
    expect(inv.invariant).toBe('grounded');
  });
});

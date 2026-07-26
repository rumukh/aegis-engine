import { describe, it, expect } from 'vitest';
import {
  asError,
  parseInputScript,
  runScene,
  defineGameTest,
  GameAssertionError,
  InvariantError,
} from './index.js';
import { fakeMode } from './testing/fake-mode.js';

describe('@aegis/harness public surface', () => {
  it('exposes the runner and input parser', () => {
    expect(typeof runScene).toBe('function');
    expect(typeof parseInputScript).toBe('function');
  });

  it('defineGameTest returns the test verbatim (identity helper)', () => {
    const test = defineGameTest({
      name: 'reaches the goal',
      scene: 'scenes/level1.scene.json',
      options: { plugin: fakeMode },
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

  /**
   * `asError` backs every `catch (err)` in the package. The reflex it replaces —
   * `(err as Error).message` — yields `undefined` for a thrown non-Error, inside the diagnostic
   * whose job is to explain the failure. Every call site is currently safe *because of a fact
   * about that call site*; this makes it safe structurally, so the guarantee survives the fact
   * changing.
   */
  it('asError preserves a real Error and never invents an undefined message', () => {
    const real = new TypeError('boom');
    expect(asError(real)).toBe(real); // identity: no wrapping, no lost stack

    for (const thrown of ['a string', 42, null, undefined, { code: 'X' }]) {
      const wrapped = asError(thrown);
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped.message).toBeTypeOf('string');
      expect(wrapped.message.length).toBeGreaterThan(0);
    }
  });
});

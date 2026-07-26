/**
 * Live input: browser reports in, per-tick {@link InputFrame}s out.
 *
 * The behaviour that matters is edge fidelity — a press must land on exactly one tick, and a look
 * flick must not lose degrees — because that is what makes a human's input indistinguishable from
 * a compiled `.input` script as far as the simulation is concerned.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { createLiveInput } from './live-input.js';

describe('live input', () => {
  it('starts idle', () => {
    const input = createLiveInput();
    const frame = input.frameFor(7);
    expect(frame.tick).toBe(7);
    expect(frame.actions).toEqual({});
    expect(frame.pressed).toEqual([]);
    expect(frame.axes).toEqual({});
    expect(frame.look).toEqual({ dx: 0, dy: 0 });
    expect(frame.pointer).toBeNull();
  });

  it('holds level state across ticks but delivers each edge exactly once', () => {
    const input = createLiveInput();
    input.submit({ seq: 1, held: ['Jump'], pressed: ['Jump'], axes: { MoveX: 1 } });

    const first = input.frameFor(0);
    expect(first.pressed).toEqual(['Jump']);
    expect(first.actions['Jump']).toBe(true);
    expect(first.axes['MoveX']).toBe(1);

    const second = input.frameFor(1);
    expect(second.pressed).toEqual([]);
    expect(second.actions['Jump']).toBe(true); // still held
    expect(second.axes['MoveX']).toBe(1);

    input.submit({ seq: 2, held: [], released: ['Jump'], axes: {} });
    const third = input.frameFor(2);
    expect(third.released).toEqual(['Jump']);
    expect(third.actions['Jump']).toBeUndefined();
    expect(input.frameFor(3).released).toEqual([]);
  });

  it('reads a tap that started and ended inside one frame as held for its tick', () => {
    const input = createLiveInput();
    input.submit({ seq: 1, held: [], pressed: ['Fire'], released: ['Fire'] });
    const frame = input.frameFor(0);
    expect(frame.pressed).toEqual(['Fire']);
    expect(frame.released).toEqual(['Fire']);
    expect(frame.actions['Fire']).toBe(true);
    expect(input.frameFor(1).actions['Fire']).toBeUndefined();
  });

  it('accumulates look deltas across several packets and drains them once', () => {
    const input = createLiveInput();
    input.submit({ seq: 1, look: { dx: 12, dy: -3 } });
    input.submit({ seq: 2, look: { dx: 8, dy: -1 } });
    expect(input.frameFor(0).look).toEqual({ dx: 20, dy: -4 });
    expect(input.frameFor(1).look).toEqual({ dx: 0, dy: 0 });
  });

  it('delivers a pointer sample to exactly one tick', () => {
    const input = createLiveInput();
    input.submit({
      seq: 1,
      pointer: { screen: { x: 10, y: 20 }, world: { x: 4, y: 3, z: 0 }, buttons: ['primary'] },
    });
    const frame = input.frameFor(0);
    expect(frame.pointer?.world).toEqual({ x: 4, y: 3, z: 0 });
    expect(frame.pointer?.buttons).toEqual(['primary']);
    expect(input.frameFor(1).pointer).toBeNull();
  });

  it('ignores packets that arrive out of order', () => {
    const input = createLiveInput();
    expect(input.submit({ seq: 5, held: ['Jump'] })).toBe(true);
    expect(input.submit({ seq: 4, held: [], pressed: ['Fire'] })).toBe(false);
    expect(input.lastSeq).toBe(5);
    const frame = input.frameFor(0);
    expect(frame.actions['Jump']).toBe(true);
    expect(frame.pressed).toEqual([]);
  });

  it('de-duplicates repeated edges within one tick', () => {
    const input = createLiveInput();
    input.submit({ seq: 1, pressed: ['Jump'] });
    input.submit({ seq: 2, pressed: ['Jump'] });
    expect(input.frameFor(0).pressed).toEqual(['Jump']);
  });

  it('clear drops held state and pending edges', () => {
    const input = createLiveInput();
    input.submit({ seq: 1, held: ['Jump'], pressed: ['Jump'], look: { dx: 5, dy: 5 } });
    input.clear();
    const frame = input.frameFor(0);
    expect(frame.actions).toEqual({});
    expect(frame.pressed).toEqual([]);
    expect(frame.look).toEqual({ dx: 0, dy: 0 });
  });
});

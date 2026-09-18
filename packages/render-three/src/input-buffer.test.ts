import { describe, expect, it } from 'vitest';
import { createInputBuffer } from './input-buffer.js';
import { createLiveInput } from './live-input.js';

describe('source-owned input packets', () => {
  it('does not release or re-press an action still owned by another device', () => {
    const buffer = createInputBuffer();
    buffer.setSource('keyboard', { held: ['Fire'] });
    expect(buffer.take().pressed).toEqual(['Fire']);
    buffer.setSource('mouse', { held: ['Fire'] });
    buffer.setSource('gamepad', { held: ['Fire'] });
    expect(buffer.take().pressed).toEqual([]);
    buffer.removeSource('mouse');
    buffer.removeSource('keyboard');
    expect(buffer.take()).toMatchObject({ held: ['Fire'], released: [] });
    buffer.removeSource('gamepad');
    expect(buffer.take()).toMatchObject({ held: [], released: ['Fire'] });
    expect(buffer.take().released).toEqual([]);
  });

  it('sums analog ownership, clamps once, and isolates callers from retained levels', () => {
    const buffer = createInputBuffer();
    const axes = { MoveX: 0.35, Trigger: 0.7 };
    buffer.setSource('pad', { axes });
    axes.MoveX = 1;
    buffer.setSource('keys', { axes: { MoveX: 1, Broken: NaN } });
    expect(buffer.take().axes).toEqual({ MoveX: 1, Trigger: 0.7, Broken: 0 });
    buffer.setSource('keys', { axes: { MoveX: -1 } });
    expect(buffer.take().axes?.MoveX).toBeCloseTo(-0.65, 12);
    buffer.removeSource('keys');
    expect(buffer.take().axes).toEqual({ MoveX: 0.35, Trigger: 0.7 });
  });

  it('preserves between-frame taps and drains edges exactly once across catch-up ticks', () => {
    const buffer = createInputBuffer();
    const live = createLiveInput();
    buffer.setSource('pad', { held: ['Jump'] });
    buffer.setSource('pad', { held: [] });
    live.submit(buffer.take());
    live.submit(buffer.take());
    expect(live.frameFor(0)).toMatchObject({
      actions: { Jump: true },
      pressed: ['Jump'],
      released: ['Jump'],
    });
    expect(live.frameFor(1)).toMatchObject({ actions: {}, pressed: [], released: [] });
    expect(live.frameFor(2).pressed).toEqual([]);
  });

  it('integrates look once before spreading it over simulation catch-up', () => {
    const buffer = createInputBuffer();
    const live = createLiveInput();
    for (let display = 0; display < 6; display++) {
      buffer.addLook(120 / 120, -60 / 120);
      live.submit(buffer.take());
    }
    live.spreadLookOver(3);
    const frames = [live.frameFor(0), live.frameFor(1), live.frameFor(2)];
    expect(frames.map((frame) => frame.look)).toEqual([
      { dx: 2, dy: -1 },
      { dx: 2, dy: -1 },
      { dx: 2, dy: -1 },
    ]);
    expect(live.frameFor(3).look).toEqual({ dx: 0, dy: 0 });
  });

  it('drops pending UI impulses at a context boundary without resetting sequence numbers', () => {
    const buffer = createInputBuffer();
    buffer.setSource('pad', { held: ['Confirm'], axes: { MoveX: 1 } });
    buffer.addLook(5, 9);
    expect(buffer.take().seq).toBe(1);
    buffer.clear();
    expect(buffer.take()).toEqual({
      seq: 2,
      reset: true,
      held: [],
      pressed: [],
      released: [],
      axes: {},
      look: { dx: 0, dy: 0 },
      pointer: null,
    });
    buffer.setSource('keys', { held: ['Fire'] });
    buffer.clear({ releaseHeld: true });
    expect(buffer.take()).toMatchObject({ held: [], pressed: [], released: ['Fire'] });
    expect(() => buffer.addLook(Infinity, 0)).toThrow(/finite/);
  });

  it('cancels an already submitted press at focus loss before any simulation tick consumes it', () => {
    const buffer = createInputBuffer();
    const live = createLiveInput();
    buffer.setSource('pad', { held: ['Fire'] });
    live.submit(buffer.take());
    buffer.clear({ releaseHeld: true });
    buffer.clear({ releaseHeld: true });
    live.submit(buffer.take());
    expect(live.frameFor(0)).toMatchObject({
      actions: {},
      pressed: [],
      released: ['Fire'],
      look: { dx: 0, dy: 0 },
    });
    expect(live.frameFor(1).released).toEqual([]);
  });
});

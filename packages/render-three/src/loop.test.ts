/**
 * The accumulator: wall-clock in, fixed steps out.
 *
 * The claim under test is the one that makes real-time play safe — however jittery the frames
 * are, the simulation only ever advances in whole `1 / tickRate` steps, so a played session and a
 * headless run of the same input produce the same state.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { createFixedStepLoop } from './loop.js';

describe('fixed-step loop', () => {
  it('rejects a non-positive tick rate', () => {
    expect(() => createFixedStepLoop({ tickRate: 0 })).toThrow(/tickRate must be > 0/);
    expect(() => createFixedStepLoop({ tickRate: -1 })).toThrow(/tickRate must be > 0/);
  });

  it('runs one step per whole tick and carries the remainder', () => {
    const loop = createFixedStepLoop({ tickRate: 60 });
    let steps = 0;
    const run = (seconds: number): number => loop.advance(seconds, () => steps++);

    expect(run(1 / 120)).toBe(0); // half a tick: nothing yet
    expect(loop.pending).toBeCloseTo(1 / 120);
    expect(run(1 / 120)).toBe(1); // the other half completes it
    expect(loop.pending).toBeCloseTo(0);
    expect(run(1 / 20)).toBe(3); // 50 ms is exactly three 60 Hz ticks
    expect(steps).toBe(4);
  });

  it('ignores zero, negative and non-finite frame times', () => {
    const loop = createFixedStepLoop({ tickRate: 60 });
    let steps = 0;
    const step = (): void => {
      steps++;
    };
    expect(loop.advance(0, step)).toBe(0);
    expect(loop.advance(-5, step)).toBe(0);
    expect(loop.advance(Number.NaN, step)).toBe(0);
    expect(loop.advance(Number.POSITIVE_INFINITY, step)).toBe(0);
    expect(steps).toBe(0);
  });

  it('caps catch-up after a stall instead of spiralling', () => {
    const loop = createFixedStepLoop({ tickRate: 60, maxStepsPerFrame: 4 });
    let steps = 0;
    expect(loop.advance(10, () => steps++)).toBe(4);
    expect(steps).toBe(4);
    // The unusable backlog is dropped, so the next frame starts clean rather than sprinting.
    expect(loop.pending).toBe(0);
  });

  it('reset drops the accumulated remainder', () => {
    const loop = createFixedStepLoop({ tickRate: 60 });
    loop.advance(1 / 120, () => undefined);
    expect(loop.pending).toBeGreaterThan(0);
    loop.reset();
    expect(loop.pending).toBe(0);
  });

  it('produces the same step count from jittered frames as from perfectly even ones', () => {
    // A second of wall-clock is a second of wall-clock, however it is chopped up. (Only the
    // *count* can wobble by one tick from float accumulation; the step size never does, which is
    // what determinism actually depends on — see `session.test.ts` for the state-hash proof.)
    const jitter = [0.004, 0.031, 0.002, 0.05, 0.12, 0.008, 0.017, 0.033, 0.09, 0.045];
    const total = jitter.reduce((sum, frame) => sum + frame, 0);

    const jittered = createFixedStepLoop({ tickRate: 60, maxStepsPerFrame: 64 });
    let jitteredSteps = 0;
    for (const frame of jitter) jittered.advance(frame, () => jitteredSteps++);

    const even = createFixedStepLoop({ tickRate: 60, maxStepsPerFrame: 64 });
    let evenSteps = 0;
    for (let i = 0; i < 100; i++) even.advance(total / 100, () => evenSteps++);

    expect(jitteredSteps).toBe(evenSteps);
    expect(jitteredSteps).toBeGreaterThanOrEqual(Math.floor(total * 60) - 1);
    expect(jitteredSteps).toBeLessThanOrEqual(Math.ceil(total * 60));
  });
});

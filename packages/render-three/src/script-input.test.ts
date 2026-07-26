/**
 * Compiling a game's `.input` script into browser input, and proving the round trip.
 *
 * The load-bearing test here is the last one: take a script, compile it to browser events, replay
 * those events back through the real `LiveInput`, and drive a real simulation with the result —
 * then assert the state hash equals the one the *script itself* produces through the harness.
 *
 * That is what makes the screenshot capture unable to drift. The old capture carried hand-written
 * key timings that silently stopped matching the level; there is now nothing to hand-write, and
 * if the compilation were wrong this test fails headlessly, in `npm run verify`, without a
 * browser or a PNG being involved.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { DiagnosticError } from '@aegis/core';
import type { InputFrame } from '@aegis/core';
import { parseInputScript, runScene } from '@aegis/harness';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import { BINDINGS } from './bindings.js';
import type { ModeBindings } from './bindings.js';
import {
  UnmappableInputError,
  compileDomInput,
  framesFromPlan,
  heldStateFor,
} from './script-input.js';
import { FPS_SCENE, ISO_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';

/** Compile a script to frames, throwing structured diagnostics on a parse failure. */
function framesOf(script: string, ticks: number): readonly InputFrame[] {
  const parsed = parseInputScript(script);
  if (!parsed.ok || parsed.value === undefined) throw new DiagnosticError(parsed.diagnostics);
  return parsed.value.frames(ticks);
}

/** Round-trip a script through the browser-input compiler and back to frames. */
function roundTrip(script: string, ticks: number, bindings: ModeBindings): InputFrame[] {
  return framesFromPlan(compileDomInput(framesOf(script, ticks), bindings), bindings);
}

describe('held state from a frame', () => {
  const idle: InputFrame = {
    tick: 0,
    actions: {},
    pressed: [],
    released: [],
    axes: {},
    look: { dx: 0, dy: 0 },
    pointer: null,
  };

  it('maps a digital action to its bound key', () => {
    const state = heldStateFor({ ...idle, actions: { Jump: true } }, BINDINGS.platformer);
    expect(state.codes).toContain('Space');
    expect(state.button).toBe(false);
  });

  it('maps an axis to the key for that direction', () => {
    expect(heldStateFor({ ...idle, axes: { MoveX: 1 } }, BINDINGS.platformer).codes).toEqual([
      'KeyD',
    ]);
    expect(heldStateFor({ ...idle, axes: { MoveX: -1 } }, BINDINGS.platformer).codes).toEqual([
      'KeyA',
    ]);
  });

  it('resolves a direction alias, because a script may spell an axis as an action', () => {
    // `hold Right` and `axis MoveX 1` are the same thing to `platformer.intake`; a keyboard only
    // has the key, so the table declares the equivalence.
    expect(heldStateFor({ ...idle, actions: { Right: true } }, BINDINGS.platformer).codes).toEqual([
      'KeyD',
    ]);
    expect(heldStateFor({ ...idle, actions: { Left: true } }, BINDINGS.platformer).codes).toEqual([
      'KeyA',
    ]);
  });

  it('routes the button action to the mouse, not the keyboard', () => {
    const state = heldStateFor({ ...idle, actions: { Fire: true } }, BINDINGS.fps);
    expect(state.button).toBe(true);
    expect(state.codes).toEqual([]);
  });

  it('refuses to silently drop an input it cannot produce', () => {
    expect(() =>
      heldStateFor({ ...idle, actions: { Teleport: true } }, BINDINGS.platformer),
    ).toThrow(UnmappableInputError);
    expect(() => heldStateFor({ ...idle, axes: { Throttle: 1 } }, BINDINGS.fps)).toThrow(
      /cannot produce: Throttle=1/,
    );
  });

  it('ignores actions that are held false and axes that are zero', () => {
    const state = heldStateFor(
      { ...idle, actions: { Jump: false }, axes: { MoveX: 0 } },
      BINDINGS.platformer,
    );
    expect(state.codes).toEqual([]);
  });
});

describe('compiling a script to browser input', () => {
  it('collapses unchanged ticks into one segment', () => {
    const plan = compileDomInput(framesOf('hold Right 0..100', 100), BINDINGS.platformer);
    expect(plan.totalTicks).toBe(100);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toMatchObject({ tick: 0, ticks: 100, keyDown: ['KeyD'], keyUp: [] });
  });

  it('splits at every change of held state, and nowhere else', () => {
    const plan = compileDomInput(
      framesOf('hold Right 0..40\npress Jump @10', 40),
      BINDINGS.platformer,
    );
    // [0,10) run · [10,11) run+jump · [11,40) run
    expect(plan.segments.map((s) => [s.tick, s.ticks])).toEqual([
      [0, 10],
      [10, 1],
      [11, 29],
    ]);
    expect(plan.segments[1]?.keyDown).toEqual(['Space']);
    expect(plan.segments[2]?.keyUp).toEqual(['Space']);
  });

  it('turns a pointer click into a one-tick segment carrying the world point', () => {
    const plan = compileDomInput(framesOf('click 4,7 @3', 10), BINDINGS.iso);
    const clicks = plan.segments.filter((segment) => segment.click !== undefined);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.tick).toBe(3);
    expect(clicks[0]?.ticks).toBe(1);
    expect(clicks[0]?.click).toEqual({ x: 4, y: 7, z: 0 });
  });

  it('converts look deltas to whole pixels and carries the remainder', () => {
    // 0.14 deg/px: a 1-degree turn is 7.14 px, so naive rounding would lose 0.14 px each time.
    const plan = compileDomInput(
      framesOf('look 1 0 @0\nlook 1 0 @1\nlook 1 0 @2', 3),
      BINDINGS.fps,
    );
    const pixels = plan.segments
      .map((segment) => segment.mouse?.dx ?? 0)
      .reduce((sum, dx) => sum + dx, 0);
    // Three degrees is 21.43 px; carrying the remainder keeps the total within a pixel.
    expect(Math.abs(pixels - 3 / 0.14)).toBeLessThan(1);
  });

  it('covers every tick exactly once, contiguously', () => {
    for (const [script, ticks, bindings] of [
      ['hold Right 0..40\npress Jump @10\npress Jump @25', 40, BINDINGS.platformer],
      ['click 1,5 @4\nclick 9,1 @30', 50, BINDINGS.iso],
      ['axis Forward 1 5..40\naim 90 0 @8\npress Fire @12', 40, BINDINGS.fps],
    ] as const) {
      const plan = compileDomInput(framesOf(script, ticks), bindings);
      let next = 0;
      for (const segment of plan.segments) {
        expect(segment.tick).toBe(next);
        expect(segment.ticks).toBeGreaterThanOrEqual(1);
        next += segment.ticks;
      }
      expect(next).toBe(ticks);
    }
  });
});

describe('the compiled browser input reproduces the script', () => {
  it('platformer: recovers the same held actions and axes tick for tick', () => {
    const script = 'hold Right 0..30\npress Jump @8\nhold Right 40..60';
    const original = framesOf(script, 60);
    const replayed = roundTrip(script, 60, BINDINGS.platformer);

    expect(replayed).toHaveLength(60);
    for (let tick = 0; tick < 60; tick++) {
      const a = original[tick] as InputFrame;
      const b = replayed[tick] as InputFrame;
      // `hold Right` and the KeyD axis are the same intent; the simulation reads either.
      const wantsRight = a.actions['Right'] === true || (a.axes['MoveX'] ?? 0) > 0;
      const gotRight = b.actions['Right'] === true || (b.axes['MoveX'] ?? 0) > 0;
      expect(gotRight, `tick ${tick} run`).toBe(wantsRight);
      expect(b.actions['Jump'] === true, `tick ${tick} jump`).toBe(a.actions['Jump'] === true);
      expect(b.pressed.includes('Jump'), `tick ${tick} jump edge`).toBe(a.pressed.includes('Jump'));
    }
  });

  it('iso: recovers each click on its own tick', () => {
    const script = 'click 1,5 @4\nclick 9,1 @30';
    const original = framesOf(script, 50);
    const replayed = roundTrip(script, 50, BINDINGS.iso);
    for (let tick = 0; tick < 50; tick++) {
      expect((replayed[tick] as InputFrame).pointer?.world ?? null, `tick ${tick}`).toEqual(
        (original[tick] as InputFrame).pointer?.world ?? null,
      );
    }
  });

  it('fps: recovers the aim to within a pixel of look resolution', () => {
    const script = 'aim 90 0 @4\naim 0 -40 @20';
    const original = framesOf(script, 40);
    const replayed = roundTrip(script, 40, BINDINGS.fps);
    const sum = (frames: readonly InputFrame[], axis: 'dx' | 'dy'): number =>
      frames.reduce((total, frame) => total + frame.look[axis], 0);
    expect(Math.abs(sum(replayed, 'dx') - sum(original, 'dx'))).toBeLessThan(0.14);
    expect(Math.abs(sum(replayed, 'dy') - sum(original, 'dy'))).toBeLessThan(0.14);
  });
});

describe('a replayed script drives the simulation to the same state', () => {
  const cases = [
    {
      name: 'platformer',
      scene: PLATFORMER_SCENE,
      plugin: platformerPlugin,
      bindings: BINDINGS.platformer,
      script: 'hold Right 0..50\npress Jump @12\npress Jump @40\nhold Right 60..90',
      ticks: 90,
    },
    {
      name: 'iso',
      scene: ISO_SCENE,
      plugin: isoPlugin,
      bindings: BINDINGS.iso,
      script: 'click 1,3 @5\nclick 4,3 @40',
      ticks: 90,
    },
  ] as const;

  for (const { name, scene, plugin, bindings, script, ticks } of cases) {
    it(`${name}: browser-replayed input yields the script's exact state hash`, async () => {
      const scripted = await runScene(scene, { plugin, ticks, input: script });
      const replayed = await runScene(scene, {
        plugin,
        ticks,
        input: roundTrip(script, ticks, bindings),
      });
      expect(replayed.hash).toBe(scripted.hash);
      expect([...replayed.tickHashes]).toEqual([...scripted.tickHashes]);
    });
  }

  it('fps: browser-replayed input reaches the same place, within look resolution', async () => {
    // Look is quantised to whole mouse pixels, so fps cannot claim bit equality — it claims the
    // run ends up in the same state, which is what a screenshot is evidence of.
    const script = 'axis Forward 1 0..40\npress Fire @10';
    const scripted = await runScene(FPS_SCENE, { plugin: fpsPlugin, ticks: 60, input: script });
    const replayed = await runScene(FPS_SCENE, {
      plugin: fpsPlugin,
      ticks: 60,
      input: roundTrip(script, 60, BINDINGS.fps),
    });
    expect(replayed.hash).toBe(scripted.hash);
  });
});

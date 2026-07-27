/**
 * Unit tests for the mode's controller behaviour, driven through the real system pipeline on
 * hand-built worlds — independent of the game:
 *  - coyote time: a jump still launches for `coyoteTicks` after leaving the ground;
 *  - jump buffering: a jump pressed before landing still launches within `jumpBufferTicks`;
 *  - carry: a body resting on a kinematic platform is moved with it and boards exactly once.
 */
import { describe, it, expect } from 'vitest';
import { createSchedule, createSimulation, createWorld, Name, Transform } from '@aegis/core';
import type { Entity, InputFrame, InputSource, System, World } from '@aegis/core';
import {
  BodyState,
  KinematicPlatform,
  PlatformerController,
  TileCollider,
  Velocity,
} from './components.js';
import { PlatformerCollision, buildCollisionGrid } from './level.js';
import {
  PLATFORM_BOARDED,
  PLATFORMER_SYSTEM_LIST,
  PLAYER_JUMPED,
  PLAYER_LANDED,
  platformAxisPos,
} from './systems.js';

const DT = 1 / 60;

/** A one-tick input frame that optionally edge-presses `Jump`. */
function frame(tick: number, jump: boolean): InputFrame {
  return {
    tick,
    actions: jump ? { Jump: true } : {},
    pressed: jump ? ['Jump'] : [],
    released: [],
    axes: {},
    look: { dx: 0, dy: 0 },
    pointer: null,
  };
}

/** An input source that presses `Jump` on exactly one tick. */
function jumpAt(pressTick: number): InputSource {
  return { frameFor: (t: number): InputFrame => frame(t, t === pressTick) };
}

/**
 * Run the coyote/buffer scenario: a controller body whose `grounded` flag is scripted by
 * `groundedAt` via a post-integration stub (so we exercise the real gravity logic without
 * needing collision geometry). Returns the recorded `player.jumped` events.
 */
function runGroundScripted(opts: {
  spawnGrounded: boolean;
  groundedAt: (tick: number) => boolean;
  pressTick: number;
  ticks: number;
}): { count: number; fromGround: boolean[] } {
  const world = createWorld({ seed: 'coyote', recordEvents: true });
  world.spawn(
    Name({ value: 'hero' }),
    Velocity({ dx: 0, dy: 0 }),
    PlatformerController(),
    BodyState({ grounded: opts.spawnGrounded }),
  );

  const groundStub: System = {
    name: 'test.ground',
    phase: 'postUpdate',
    run({ world: w, tick }): void {
      const v = w.query({ has: [BodyState] }).first();
      if (v) w.get(v.entity, BodyState)!.grounded = opts.groundedAt(tick);
    },
  };

  const schedule = createSchedule().addAll([...PLATFORMER_SYSTEM_LIST, groundStub]);
  const sim = createSimulation({ world, schedule, tickRate: 60, input: jumpAt(opts.pressTick) });
  sim.run(opts.ticks);

  const jumps = world.events.history().filter((e) => e.type === PLAYER_JUMPED);
  return {
    count: jumps.length,
    fromGround: jumps.map((e) => (e.data as { fromGround: boolean }).fromGround),
  };
}

describe('coyote time', () => {
  // Grounded on ticks 0..9; airborne from tick 10. The gravity phase observes the previous
  // tick's grounded flag, so "left the ground" is first seen at gravity tick 11, and the coyote
  // window (coyoteTicks = 6) keeps a jump valid through gravity tick 16.
  const groundedAt = (t: number): boolean => t < 10;

  it('still jumps within the coyote window (fromGround = false)', () => {
    const r = runGroundScripted({ spawnGrounded: true, groundedAt, pressTick: 16, ticks: 40 });
    expect(r.count).toBe(1);
    expect(r.fromGround).toEqual([false]);
  });

  it('does not jump once the coyote window has expired', () => {
    const r = runGroundScripted({ spawnGrounded: true, groundedAt, pressTick: 17, ticks: 40 });
    expect(r.count).toBe(0);
  });

  it('a jump while genuinely grounded reports fromGround = true', () => {
    const r = runGroundScripted({ spawnGrounded: true, groundedAt, pressTick: 5, ticks: 40 });
    expect(r.count).toBe(1);
    expect(r.fromGround).toEqual([true]);
  });
});

describe('jump buffering', () => {
  // Airborne on ticks 0..19; grounded from tick 20. Landing is first observed at gravity tick 21.
  // A jump press seeds a jumpBufferTicks-tick window; a press at tick 16 is still live when the
  // landing is observed, so it launches on contact.
  const groundedAt = (t: number): boolean => t >= 20;

  it('a jump pressed just before landing launches on contact (fromGround = true)', () => {
    const r = runGroundScripted({ spawnGrounded: false, groundedAt, pressTick: 16, ticks: 40 });
    expect(r.count).toBe(1);
    expect(r.fromGround).toEqual([true]);
  });

  it('a jump pressed too early expires and is not honoured', () => {
    const r = runGroundScripted({ spawnGrounded: false, groundedAt, pressTick: 15, ticks: 40 });
    expect(r.count).toBe(0);
  });
});

describe('carry by a kinematic platform', () => {
  it('moves a resting rider with the platform and boards exactly once', () => {
    const world: World = createWorld({ seed: 'carry', recordEvents: true });
    world.spawn(
      Name({ value: 'lift' }),
      Transform({ position: { x: 5, y: 3, z: 0 } }),
      KinematicPlatform({
        axis: 'x',
        min: 5,
        max: 9,
        speed: 2,
        phase: 0,
        halfWidth: 1.5,
        halfHeight: 0.5,
      }),
    );
    const rider = world.spawn(
      Name({ value: 'hero' }),
      Transform({ position: { x: 5, y: 4, z: 0 } }), // feet at y=3.5 == platform top
      Velocity({ dx: 0, dy: 0 }),
      PlatformerController(),
      BodyState({ grounded: true }),
      TileCollider({ halfWidth: 0.4, halfHeight: 0.5, offsetX: 0, offsetY: 0 }),
    );

    const schedule = createSchedule().addAll(PLATFORMER_SYSTEM_LIST);
    const sim = createSimulation({ world, schedule, tickRate: 60 });
    sim.run(30);

    const t = world.get(rider, Transform)!;
    const expectedX =
      5 +
      (platformAxisPos(
        { axis: 'x', min: 5, max: 9, speed: 2, phase: 0, halfWidth: 1.5, halfHeight: 0.5 },
        29,
        DT,
      ) -
        5);
    expect(t.position.x).toBeCloseTo(expectedX, 6);
    expect(t.position.x).toBeGreaterThan(5.5); // actually rode to the right
    expect(t.position.y).toBeCloseTo(4.0, 6); // stayed on the platform surface
    expect(world.events.count(PLATFORM_BOARDED)).toBe(1);
    expect(world.get(rider, BodyState)!.grounded).toBe(true);
  });
});

describe('player.landed is an edge, not a level', () => {
  /** A 4x4 map whose bottom row is solid ground: the tile at row 3 spans world y in [0, 1]. */
  function groundWorld(seed: string): World {
    const world = createWorld({ seed, recordEvents: true });
    world.setResource(
      PlatformerCollision,
      buildCollisionGrid({
        width: 4,
        height: 4,
        tileSize: 1,
        legend: { '#': { solid: true } },
        layers: [{ name: 'collision', data: ['....', '....', '....', '####'] }],
      }),
    );
    return world;
  }

  /** Spawn a controller body at `y`, airborne. */
  function spawnFaller(world: World, y: number): Entity {
    return world.spawn(
      Name({ value: 'hero' }),
      Transform({ position: { x: 1.5, y, z: 0 } }),
      Velocity({ dx: 0, dy: 0 }),
      PlatformerController(),
      BodyState({ grounded: false }),
      TileCollider({ halfWidth: 0.4, halfHeight: 0.5, offsetX: 0, offsetY: 0 }),
    );
  }

  it('a body that falls once and then rests emits exactly one landing', () => {
    const world = groundWorld('landing-once');
    const hero = spawnFaller(world, 3);

    // Count the grounded ticks, so the assertion can state *how many* landings an emitter
    // triggered by the grounded level — rather than by the airborne -> grounded edge — would have
    // produced. Without this the "exactly 1" below could be read as a lucky coincidence.
    let groundedTicks = 0;
    const probe: System = {
      name: 'test.probe',
      phase: 'postUpdate',
      run({ world: w }): void {
        if (w.get(hero, BodyState)?.grounded === true) groundedTicks += 1;
      },
    };

    const schedule = createSchedule().addAll([...PLATFORMER_SYSTEM_LIST, probe]);
    createSimulation({ world, schedule, tickRate: 60 }).run(120);

    expect(world.get(hero, BodyState)!.grounded).toBe(true);
    expect(world.get(hero, Transform)!.position.y).toBeCloseTo(1.5, 6); // feet on the tile top
    expect(groundedTicks).toBeGreaterThan(80); // it rested for most of the run…
    expect(world.events.count(PLAYER_LANDED)).toBe(1); // …and still landed once
  });

  it('leaving the ground and coming down again lands a second time', () => {
    const world = groundWorld('landing-twice');
    const hero = spawnFaller(world, 3);

    const schedule = createSchedule().addAll(PLATFORMER_SYSTEM_LIST);
    createSimulation({ world, schedule, tickRate: 60, input: jumpAt(40) }).run(160);

    // One landing from the initial fall, one from the jump — the positive control that stops
    // "exactly 1" above from being satisfiable by an emitter that has been deleted entirely.
    expect(world.events.count(PLAYER_JUMPED)).toBe(1);
    expect(world.events.count(PLAYER_LANDED)).toBe(2);
    expect(world.get(hero, BodyState)!.grounded).toBe(true);
  });
});

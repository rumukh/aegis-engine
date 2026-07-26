import { describe, it, expect } from 'vitest';
import { createWorld, createSimulation, createSchedule, Transform } from '@aegis/core';
import type { World, InputFrame, Entity, Vec3, GameEvent } from '@aegis/core';
import { Health } from '@aegis/content';
import {
  CapsuleBody,
  FpsCamera,
  FpsController,
  Hitscan,
  HitBox,
  LookState,
} from './components.js';
import { FPS_COLLISION, extrudeFloorplan } from './geometry.js';
import type { FloorplanSpec } from './geometry.js';
import {
  gravitySystem,
  integrateSystem,
  intakeSystem,
  lookSystem,
  hitscanSystem,
  HITSCAN_HIT,
  HITSCAN_MISS,
} from './systems.js';
import type { HitscanHitEvent } from './systems.js';

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

/** An open floor `w × h` of `.` tiles (floor 0, ceil 4), origin at the SW corner cell. */
function openFloor(w: number, h: number): FloorplanSpec {
  const rows: string[] = [];
  for (let r = 0; r < h; r++) rows.push('.'.repeat(w));
  return {
    width: w,
    height: h,
    tileSize: 1,
    origin: { x: 0, z: 0 },
    rows,
    legend: { '.': { solid: false, floor: 0, ceil: 4 } },
  };
}

function frame(over: Partial<InputFrame> & { tick: number }): InputFrame {
  return {
    tick: over.tick,
    actions: over.actions ?? {},
    pressed: over.pressed ?? [],
    axes: over.axes ?? {},
    look: over.look ?? { dx: 0, dy: 0 },
  };
}

function spawnActor(world: World, pos: Vec3): Entity {
  return world.spawn(
    Transform({ position: { ...pos }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    CapsuleBody({ radius: 0.4, height: 1.8, velocity: { x: 0, y: 0, z: 0 }, grounded: true }),
    FpsController(),
    LookState(),
    FpsCamera(),
    Hitscan(),
  );
}

describe('gravity + jump arc', () => {
  it('rests on the floor when not jumping', () => {
    const world = createWorld({ seed: 'g' });
    world.setResource(FPS_COLLISION, extrudeFloorplan(openFloor(5, 5)));
    const actor = spawnActor(world, { x: 2, y: 0, z: 2 });
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([gravitySystem, integrateSystem]),
      tickRate: TICK_RATE,
    });
    sim.run(30);
    const body = world.get(actor, CapsuleBody)!;
    expect(world.get(actor, Transform)!.position.y).toBeCloseTo(0, 6);
    expect(body.grounded).toBe(true);
  });

  it('jumps to the expected apex and lands, staying grounded', () => {
    const world = createWorld({ seed: 'j' });
    world.setResource(FPS_COLLISION, extrudeFloorplan(openFloor(5, 5)));
    const actor = spawnActor(world, { x: 2, y: 0, z: 2 });
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([intakeSystem, gravitySystem, integrateSystem]),
      tickRate: TICK_RATE,
    });

    let apex = 0;
    let airborneTicks = 0;
    // Jump on tick 0, then coast.
    for (let t = 0; t < 90; t++) {
      sim.step(t === 0 ? frame({ tick: t, pressed: ['Jump'] }) : frame({ tick: t }));
      const y = world.get(actor, Transform)!.position.y;
      if (y > apex) apex = y;
      if (!world.get(actor, CapsuleBody)!.grounded) airborneTicks++;
    }

    // Analytic apex = v^2 / 2g = 8^2 / (2*24) = 1.333; discrete integration is close.
    expect(apex).toBeGreaterThan(1.25);
    expect(apex).toBeLessThan(1.45);
    // Airborne time ~ 2v/g = 0.667s ~ 40 ticks.
    expect(airborneTicks).toBeGreaterThan(35);
    expect(airborneTicks).toBeLessThan(45);
    // Back on the ground by the end.
    expect(world.get(actor, Transform)!.position.y).toBeCloseTo(0, 6);
    expect(world.get(actor, CapsuleBody)!.grounded).toBe(true);
  });
});

describe('capsule-vs-wall collision', () => {
  /** Open floor with a wall column at world x = 3 (col 3), spanning all rows. */
  function wallAtX3(): FloorplanSpec {
    const w = 6;
    const h = 3;
    const rows: string[] = [];
    for (let r = 0; r < h; r++) rows.push('...#..');
    return {
      width: w,
      height: h,
      tileSize: 1,
      origin: { x: 0, z: 0 },
      rows,
      legend: {
        '.': { solid: false, floor: 0, ceil: 4 },
        '#': { solid: true, floor: 0, ceil: 4 },
      },
    };
  }

  it('stops at the wall and never penetrates it', () => {
    const world = createWorld({ seed: 'w' });
    world.setResource(FPS_COLLISION, extrudeFloorplan(wallAtX3()));
    const actor = spawnActor(world, { x: 0, y: 0, z: 1 });
    world.get(actor, CapsuleBody)!.velocity = { x: 6, y: 0, z: 0 };
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([integrateSystem]),
      tickRate: TICK_RATE,
    });
    // Re-assert velocity each tick (intake normally does this); here drive x directly.
    for (let t = 0; t < 60; t++) {
      world.get(actor, CapsuleBody)!.velocity.x = 6;
      sim.step(frame({ tick: t }));
    }
    const x = world.get(actor, Transform)!.position.x;
    // Wall face is at x = 2.5; capsule radius 0.4 -> centre clamps near 2.1.
    expect(x).toBeGreaterThan(1.9);
    expect(x).toBeLessThan(2.2);
  });

  it('slides along a wall: blocked axis stops, free axis keeps moving', () => {
    const world = createWorld({ seed: 's' });
    world.setResource(FPS_COLLISION, extrudeFloorplan(wallAtX3()));
    const actor = spawnActor(world, { x: 0, y: 0, z: 1 });
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([integrateSystem]),
      tickRate: TICK_RATE,
    });
    for (let t = 0; t < 60; t++) {
      world.get(actor, CapsuleBody)!.velocity = { x: 6, y: 0, z: 6 };
      sim.step(frame({ tick: t }));
    }
    const pos = world.get(actor, Transform)!.position;
    expect(pos.x).toBeLessThan(2.2); // blocked by the wall
    expect(pos.z).toBeGreaterThan(1.5); // still slid north
  });
});

describe('hitscan steered by look direction', () => {
  /** A shooter at origin and a shootable, damageable target 3 units east. */
  function scene(seed: string): { world: World; shooter: Entity; target: Entity } {
    const world = createWorld({ seed, recordEvents: true });
    world.setResource(FPS_COLLISION, extrudeFloorplan(openFloor(21, 21)));
    const shooter = world.spawn(
      Transform({ position: { x: 10, y: 0, z: 10 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
      LookState(),
      FpsCamera(),
      Hitscan({ range: 100, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 }),
    );
    const target = world.spawn(
      Transform({ position: { x: 13, y: 0, z: 10 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
      HitBox({ half: { x: 0.5, y: 0.5, z: 0.5 }, offset: { x: 0, y: 1.6, z: 0 } }),
      Health({ current: 100, max: 100 }),
    );
    return { world, shooter, target };
  }

  function fireOnce(world: World, tick: number): void {
    createSimulation({
      world,
      schedule: createSchedule().addAll([hitscanSystem]),
      tickRate: TICK_RATE,
    }).step(frame({ tick, pressed: ['Fire'] }));
  }

  it('hits the target when the look points at it (yaw 90 = +X)', () => {
    const { world, target } = scene('hit');
    // Aim east.
    for (const v of world.query({ has: [LookState, Hitscan] }).views()) v.get(LookState).yawDeg = 90;
    fireOnce(world, 0);
    expect(world.get(target, Health)!.current).toBe(75);
    const hits = world.events.history().filter((e) => e.type === HITSCAN_HIT) as GameEvent<
      HitscanHitEvent
    >[];
    expect(hits.some((e) => e.data.distance < 3)).toBe(true);
  });

  it('does not hit the target when looking elsewhere (yaw 0 = +Z)', () => {
    const { world, target } = scene('miss-dir');
    for (const v of world.query({ has: [LookState, Hitscan] }).views()) v.get(LookState).yawDeg = 0;
    fireOnce(world, 0);
    // Target is due east; a north-facing ray must not damage it.
    expect(world.get(target, Health)!.current).toBe(100);
  });

  it('is blocked by a wall between shooter and target', () => {
    const world = createWorld({ seed: 'blocked', recordEvents: true });
    // Wall column at x = 12, between shooter (x=10) and target (x=13).
    const rows: string[] = [];
    for (let r = 0; r < 21; r++) rows.push('.'.repeat(12) + '#' + '.'.repeat(8));
    world.setResource(
      FPS_COLLISION,
      extrudeFloorplan({
        width: 21,
        height: 21,
        tileSize: 1,
        origin: { x: 0, z: 0 },
        rows,
        legend: {
          '.': { solid: false, floor: 0, ceil: 4 },
          '#': { solid: true, floor: 0, ceil: 4 },
        },
      }),
    );
    const target = world.spawn(
      Transform({ position: { x: 13, y: 0, z: 10 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
      HitBox({ half: { x: 0.5, y: 0.5, z: 0.5 }, offset: { x: 0, y: 1.6, z: 0 } }),
      Health({ current: 100, max: 100 }),
    );
    world.spawn(
      Transform({ position: { x: 10, y: 0, z: 10 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
      LookState({ yawDeg: 90, pitchDeg: 0 }),
      FpsCamera(),
      Hitscan({ range: 100, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 }),
    );
    fireOnce(world, 0);
    expect(world.get(target, Health)!.current).toBe(100); // wall absorbed the shot
    const hits = world.events.history().filter((e) => e.type === HITSCAN_HIT) as GameEvent<
      HitscanHitEvent
    >[];
    expect(hits[0]!.data.target).toBe('wall');
  });

  it('emits a clean miss when nothing is within range', () => {
    const world = createWorld({ seed: 'miss', recordEvents: true });
    world.setResource(FPS_COLLISION, extrudeFloorplan(openFloor(51, 51)));
    world.spawn(
      Transform({ position: { x: 25, y: 0, z: 25 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
      LookState({ yawDeg: 90, pitchDeg: 0 }),
      FpsCamera(),
      Hitscan({ range: 1, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 }),
    );
    fireOnce(world, 0);
    expect(world.events.count(HITSCAN_MISS)).toBe(1);
    expect(world.events.count(HITSCAN_HIT)).toBe(0);
  });

  it('respects the cooldown between shots', () => {
    const { world, target } = scene('cooldown');
    for (const v of world.query({ has: [LookState, Hitscan] }).views()) v.get(LookState).yawDeg = 90;
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([hitscanSystem]),
      tickRate: TICK_RATE,
    });
    // Hold Fire for 10 ticks; cooldown is 12 so only one shot lands.
    for (let t = 0; t < 10; t++) sim.step(frame({ tick: t, pressed: ['Fire'] }));
    expect(world.get(target, Health)!.current).toBe(75);
  });
});

describe('look accumulation', () => {
  it('integrates look deltas 1:1 and clamps pitch', () => {
    const world = createWorld({ seed: 'l' });
    const actor = world.spawn(LookState(), FpsController());
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([lookSystem]),
      tickRate: TICK_RATE,
    });
    sim.step(frame({ tick: 0, look: { dx: 90, dy: 45 } }));
    let look = world.get(actor, LookState)!;
    expect(look.yawDeg).toBeCloseTo(90, 6);
    expect(look.pitchDeg).toBeCloseTo(45, 6);
    // Push pitch past the clamp.
    sim.step(frame({ tick: 1, look: { dx: 0, dy: 80 } }));
    look = world.get(actor, LookState)!;
    expect(look.pitchDeg).toBe(89); // maxPitchDeg
  });
});

describe('determinism', () => {
  function runOnce(seed: string): string {
    const world = createWorld({ seed });
    world.setResource(FPS_COLLISION, extrudeFloorplan(openFloor(9, 9)));
    const actor = spawnActor(world, { x: 4, y: 0, z: 4 });
    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll([lookSystem, intakeSystem, gravitySystem, integrateSystem]),
      tickRate: TICK_RATE,
    });
    for (let t = 0; t < 50; t++) {
      const input =
        t === 0
          ? frame({ tick: t, pressed: ['Jump'], axes: { Forward: 1 }, look: { dx: 30, dy: 0 } })
          : frame({ tick: t, axes: { Forward: 1 } });
      sim.step(input);
    }
    void actor;
    return JSON.stringify(world.hash());
  }

  it('produces an identical state hash across two identical runs', () => {
    expect(runOnce('same')).toBe(runOnce('same'));
  });
});

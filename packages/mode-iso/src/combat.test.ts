import { describe, it, expect } from 'vitest';
import { createSchedule, createSimulation, createWorld, Name } from '@aegis/core';
import type { Entity, World } from '@aegis/core';
import { Health } from '@aegis/content';
import {
  AttackOrder,
  Attacker,
  Controlled,
  GridPosition,
  IsoActor,
  NavGrid,
} from './components.js';
import type { IsoGridConfig } from './components.js';
import { buildNavGrid } from './grid.js';
import { isoSystems } from './plugin.js';
import { ATTACK_FIRED, DAMAGE_TAKEN, ENEMY_DAMAGED, ENEMY_KILLED, PATH_BLOCKED } from './events.js';

/** An open grid of the given size with no static walls. */
function openGrid(width: number, height: number): IsoGridConfig {
  return {
    width,
    height,
    tileSize: 1,
    walls: Array.from({ length: height }, () => '.'.repeat(width)),
  };
}

/** A world with a baked nav grid and event recording on. */
function makeWorld(config: IsoGridConfig): World {
  const world = createWorld({ seed: 'iso-combat', recordEvents: true });
  world.setResource(NavGrid, buildNavGrid(config));
  return world;
}

/** Step the full iso pipeline for `ticks` ticks. */
function run(world: World, ticks: number): void {
  const schedule = createSchedule().addAll(isoSystems());
  const sim = createSimulation({ world, schedule, tickRate: 60 });
  for (let t = 0; t < ticks; t++) sim.step();
}

/** The ticks (in order) on which an event of `type` was emitted. */
function firedTicks(world: World, type: string): number[] {
  return world.events
    .history()
    .filter((e) => e.type === type)
    .map((e) => e.tick);
}

/** The payloads (in order) of every event of `type` across the whole run. */
function payloads<T>(world: World, type: string): T[] {
  return world.events
    .history()
    .filter((e) => e.type === type)
    .map((e) => e.data as T);
}

describe('combat — range + line of sight gating', () => {
  it('fires immediately when the target is in range with clear LOS', () => {
    const world = makeWorld(openGrid(6, 1));
    const attacker = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 3, damage: 5, cooldownTicks: 30 }),
      Health({ current: 30, max: 30 }),
      Controlled(),
    );
    const target = world.spawn(
      GridPosition({ cellX: 2, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 40, max: 40 }),
      Name({ value: 'dummy' }),
    );
    world.add(attacker, AttackOrder, { target, path: [], resolved: false });

    run(world, 5);

    expect(world.events.contains(ATTACK_FIRED)).toBe(true);
    // Attacker is Controlled → its landed hits are `enemy.damaged`, never `damage.taken`.
    expect(world.events.contains(ENEMY_DAMAGED)).toBe(true);
    expect(world.events.contains(DAMAGE_TAKEN)).toBe(false);
    expect(world.getOrThrow(target, Health).current).toBe(35);
  });

  it('does not fire — and honestly reports blocked — when a wall denies LOS and no cell can close', () => {
    // 1-row corridor with a wall at x=2 seals the attacker (x=0) away from the target (x=4):
    // no reachable cell has both range and line of sight.
    const world = makeWorld({ width: 5, height: 1, tileSize: 1, walls: ['..#..'] });
    const attacker = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 5, damage: 5, cooldownTicks: 30 }),
      Health({ current: 30, max: 30 }),
      Controlled(),
    );
    const target = world.spawn(
      GridPosition({ cellX: 4, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 40, max: 40 }),
      Name({ value: 'dummy' }),
    );
    world.add(attacker, AttackOrder, { target, path: [], resolved: false });

    run(world, 20);

    expect(world.events.contains(ATTACK_FIRED)).toBe(false);
    expect(world.events.contains(PATH_BLOCKED)).toBe(true);
    expect(world.getOrThrow(target, Health).current).toBe(40); // untouched
  });

  it('closes to weapon range along a path, then fires', () => {
    const world = makeWorld(openGrid(8, 1));
    const attacker = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 2, damage: 5, cooldownTicks: 30 }),
      Health({ current: 30, max: 30 }),
      Controlled(),
    );
    const target = world.spawn(
      GridPosition({ cellX: 6, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 40, max: 40 }),
      Name({ value: 'dummy' }),
    );
    world.add(attacker, AttackOrder, { target, path: [], resolved: false });

    // Needs to walk from x=0 to x=4 (4 cells at 15 ticks/cell = 60 ticks) then fire.
    run(world, 90);

    const gp = world.getOrThrow(attacker, GridPosition);
    expect(gp.cellX).toBe(4); // stopped at the nearest in-range cell, not on the target
    expect(world.events.contains(ATTACK_FIRED)).toBe(true);
    expect(world.getOrThrow(target, Health).current).toBeLessThan(40);
  });
});

describe('combat — cooldown cadence', () => {
  it('spaces shots exactly cooldownTicks apart', () => {
    const world = makeWorld(openGrid(4, 1));
    const attacker = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 3, damage: 5, cooldownTicks: 30 }),
      Health({ current: 30, max: 30 }),
      Controlled(),
    );
    const target = world.spawn(
      GridPosition({ cellX: 2, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 999, max: 999 }),
      Name({ value: 'dummy' }),
    );
    world.add(attacker, AttackOrder, { target, path: [], resolved: false });

    run(world, 65);

    const ticks = firedTicks(world, ATTACK_FIRED);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(30); // every gap is exactly the cooldown
    }
    // HP fell by damage once per shot — no double-fire within a cooldown window.
    expect(world.getOrThrow(target, Health).current).toBe(999 - 5 * ticks.length);
  });

  it('a dead attacker never fires', () => {
    const world = makeWorld(openGrid(4, 1));
    const attacker = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 3, damage: 5, cooldownTicks: 30 }),
      Health({ current: 0, max: 30 }),
      Controlled(),
    );
    const target = world.spawn(
      GridPosition({ cellX: 2, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 40, max: 40 }),
      Name({ value: 'dummy' }),
    );
    world.add(attacker, AttackOrder, { target, path: [], resolved: false });

    run(world, 40);

    expect(world.events.contains(ATTACK_FIRED)).toBe(false);
    expect(world.getOrThrow(target, Health).current).toBe(40);
  });
});

describe('combat — perspective events and lethality', () => {
  it('emits damage.taken (not enemy.damaged) when the controlled actor is the victim', () => {
    const world = makeWorld(openGrid(4, 1));
    // The guard is the attacker and is NOT controlled; the operative is the controlled victim.
    const guard = world.spawn(
      GridPosition({ cellX: 2, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 3, damage: 5, cooldownTicks: 40 }),
      Health({ current: 20, max: 20 }),
      Name({ value: 'guard' }),
    );
    const operative = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 30, max: 30 }),
      Controlled(),
      Name({ value: 'operative' }),
    );
    world.add(guard, AttackOrder, { target: operative, path: [], resolved: false });

    run(world, 5);

    expect(world.events.contains(DAMAGE_TAKEN)).toBe(true);
    expect(world.events.contains(ENEMY_DAMAGED)).toBe(false);
    const dt = payloads<{ amount: number; source: Entity; remaining: number }>(world, DAMAGE_TAKEN);
    expect(dt.length).toBeGreaterThanOrEqual(1);
    expect(dt[0]!.amount).toBe(5);
    expect(dt[0]!.source).toBe(guard);
    expect(world.getOrThrow(operative, Health).current).toBe(25);
  });

  it('emits enemy.killed exactly once on the lethal blow and then stops', () => {
    const world = makeWorld(openGrid(4, 1));
    const attacker = world.spawn(
      GridPosition({ cellX: 0, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Attacker({ rangeCells: 3, damage: 5, cooldownTicks: 30 }),
      Health({ current: 30, max: 30 }),
      Controlled(),
    );
    const target = world.spawn(
      GridPosition({ cellX: 2, cellY: 0 }),
      IsoActor({ speed: 4 }),
      Health({ current: 10, max: 10 }), // dies on the second 5-damage shot
      Name({ value: 'grunt' }),
    );
    world.add(attacker, AttackOrder, { target, path: [], resolved: false });

    run(world, 70);

    expect(world.events.count(ENEMY_KILLED)).toBe(1);
    expect(world.events.count(ATTACK_FIRED)).toBe(2); // no shots after the kill
    expect(world.getOrThrow(target, Health).current).toBe(0);
    const killed = payloads<{ name: string | null }>(world, ENEMY_KILLED);
    expect(killed[0]!.name).toBe('grunt');
  });
});

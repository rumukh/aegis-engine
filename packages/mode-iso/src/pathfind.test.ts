/**
 * `iso.pathfind` — the dynamic repath branch: what happens when the grid becomes *more* blocked
 * underneath a route that has already been resolved.
 *
 * ## Why this file exists
 * `pathfindSystem` repaths a move order when it is unresolved **or** when its remaining route now
 * crosses a blocked cell. The second half of that condition was structurally unreachable in
 * everything this repository ran. The only `Blocking` entity in any scene is the server vault's
 * door; the only system that touches it *removes* it; nothing anywhere adds one. The grid
 * therefore only ever became more passable, a resolved route could never turn invalid, and
 * deleting `|| pathNowBlocked(mo.path, blocked)` changed no test's result.
 *
 * `grid.test.ts` covers a mutated grid at the `findPath` level — it hands the function a different
 * `Blocked` predicate and checks the detour — but nothing exercised the *system* noticing that the
 * world changed under an order already in flight. Those are different claims: the first is "the
 * search can route around a closed door", the second is "the mover finds out that the door closed".
 *
 * An unreachable branch in a game is usually a missing scenario rather than dead code, and this is
 * the missing scenario: a door slams shut on the route you are already walking.
 */
import { describe, it, expect } from 'vitest';
import { createSchedule, createSimulation, createWorld } from '@aegis/core';
import type { Entity, World } from '@aegis/core';
import { Blocking, Controlled, GridPosition, IsoActor, MoveOrder, NavGrid } from './components.js';
import type { Cell, IsoGridConfig } from './components.js';
import { CELL_ENTERED, PATH_BLOCKED, PATH_RESOLVED } from './events.js';
import type { CellEnteredEvent, PathResolvedEvent } from './events.js';
import { buildNavGrid } from './grid.js';
import { isoSystems } from './plugin.js';

/** A world with a baked nav grid from ASCII rows, and event recording on. */
function makeWorld(walls: readonly string[]): World {
  const config: IsoGridConfig = {
    width: walls[0]?.length ?? 0,
    height: walls.length,
    tileSize: 1,
    walls,
  };
  const world = createWorld({ seed: 'iso-repath', recordEvents: true });
  world.setResource(NavGrid, buildNavGrid(config));
  return world;
}

/** Spawn a controlled mover at `at` and give it a move order to `to`. */
function spawnMover(world: World, at: Cell, to: Cell): Entity {
  const actor = world.spawn(
    GridPosition({ cellX: at.x, cellY: at.y }),
    IsoActor({ speed: 4 }),
    Controlled(),
  );
  world.add(actor, MoveOrder, { target: to, path: [], resolved: false });
  return actor;
}

/**
 * Step the iso pipeline for `ticks`, running `onTick` **before** each step so a test can mutate
 * the world between ticks — which is exactly how a door slams: some other system changes the grid
 * while an order is in flight.
 */
function run(world: World, ticks: number, onTick?: (tick: number) => void): void {
  const sim = createSimulation({
    world,
    schedule: createSchedule().addAll(isoSystems()),
    tickRate: 60,
  });
  for (let t = 0; t < ticks; t++) {
    onTick?.(t);
    sim.step();
  }
}

/** Every `path.resolved` payload of the run, in order. */
function resolutions(world: World): PathResolvedEvent[] {
  return world.events
    .history()
    .filter((e) => e.type === PATH_RESOLVED)
    .map((e) => e.data as PathResolvedEvent);
}

/** Every cell the run reported being entered, as `"x,y"`. */
function entered(world: World): string[] {
  return world.events
    .history()
    .filter((e) => e.type === CELL_ENTERED)
    .map((e) => {
      const d = e.data as CellEnteredEvent;
      return `${d.x},${d.y}`;
    });
}

/** Place an impassable entity on a cell — a door slamming shut. */
function slamDoor(world: World, at: Cell): void {
  world.spawn(GridPosition({ cellX: at.x, cellY: at.y }), Blocking());
}

describe('iso.pathfind — a door that slams on a route already in flight', () => {
  it('control: with nothing slamming, the route is resolved once and walked straight through', () => {
    const world = makeWorld(['...', '...', '...']);
    const actor = spawnMover(world, { x: 0, y: 0 }, { x: 0, y: 2 });

    run(world, 90);

    // One resolution, of the straight two-cell column, and the actor walked it.
    expect(resolutions(world).map((r) => r.length)).toEqual([2]);
    expect(entered(world)).toEqual(['0,1', '0,2']);
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 0, y: 2 });
  });

  it('repaths around a cell that becomes impassable after the route was resolved', () => {
    const world = makeWorld(['...', '...', '...']);
    const actor = spawnMover(world, { x: 0, y: 0 }, { x: 0, y: 2 });

    // At 4 cells/second and 60 Hz a cell takes 15 ticks, so on tick 5 the actor is still on its
    // start cell with (0,1) — the next cell of its resolved route — still ahead of it.
    run(world, 120, (tick) => {
      if (tick === 5) slamDoor(world, { x: 0, y: 1 });
    });

    // Resolved twice: the straight column, then the four-cell detour around the shut door.
    expect(resolutions(world).map((r) => r.length)).toEqual([2, 4]);
    // It never walked through the door…
    expect(entered(world)).not.toContain('0,1');
    // …it went around, and still arrived.
    expect(entered(world)).toEqual(['1,0', '1,1', '1,2', '0,2']);
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 0, y: 2 });
  });

  it('reports path.blocked and drops the order when the slam seals the destination', () => {
    // A one-wide corridor: blocking its middle cell leaves no route at all.
    const world = makeWorld(['#.#', '#.#', '#.#']);
    const actor = spawnMover(world, { x: 1, y: 0 }, { x: 1, y: 2 });

    run(world, 60, (tick) => {
      if (tick === 5) slamDoor(world, { x: 1, y: 1 });
    });

    expect(world.events.count(PATH_BLOCKED)).toBe(1);
    expect(entered(world)).toEqual([]); // never a silent half-move
    expect(world.has(actor, MoveOrder)).toBe(false); // the order is dropped, not left hanging
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 1, y: 0 });
  });

  it('the length reported by path.resolved is the length of the path actually stored', () => {
    // `path.resolved { length }` is what a game reads to reason about a route; it must be the
    // route, not a number computed beside it.
    const world = makeWorld(['.....', '.....', '.....']);
    const actor = spawnMover(world, { x: 0, y: 0 }, { x: 4, y: 2 });

    run(world, 1);

    const reported = resolutions(world);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.length).toBe(world.getOrThrow(actor, MoveOrder).path.length);
    expect(reported[0]!.entity).toBe(actor);
  });
});

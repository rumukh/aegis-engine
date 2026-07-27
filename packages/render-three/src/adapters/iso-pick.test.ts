/**
 * **Can a human click the thing they are looking at?**
 *
 * In the isometric game the only input is the pointer, so a click that resolves to the wrong cell
 * is not a rendering blemish — it is the whole game. The reported symptom was "in isometry only
 * walking works": the guard could not be attacked and most of the level could not be ordered to,
 * while clicking bare floor looked fine.
 *
 * Two independent causes, both measured on "The Server Vault" in a real browser before the fix:
 *
 * 1. `IsoAdapter.pick` intersected the `y = 0` ground plane and ignored the geometry actually
 *    drawn. A body is 1.1 units tall and hides the tile it stands on, so the only part of the
 *    guard a human can aim at is its body — and a ray through that body reaches the ground
 *    several cells further on. A click on the guard's body at cell (2,5) resolved to **(1,4)**.
 * 2. Walls were 1.6 units tall. The camera looks along `(-1,-1,-1)`, so the pixel showing floor
 *    point `(x, 0, z)` also shows every point `(x+t, t, z+t)`: a wall on the cell diagonally in
 *    front spans `t ∈ [0.5, 1.5]` there and hides the cell behind it **completely**. The exit pad
 *    at (4,7) could not be clicked at any pixel, because the whole bottom corridor sits behind
 *    the outer wall ring.
 *
 * The expectation here is derived, not recorded: *whatever* is drawn where a cell is, clicking
 * that pixel must select that cell — for every passable cell, without exception, whatever shape
 * the level happens to be. A test that sampled a few cells would have passed on the broken build,
 * because the cells with an open diagonal neighbour always worked.
 *
 * No browser is needed: the adapter builds a real `THREE.OrthographicCamera` and a real scene
 * graph in Node, and `pick` takes normalised device coordinates — which is exactly what
 * projecting a world point through that camera produces.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import { Health } from '@aegis/content';
import { Controlled, GridPosition, NavGrid, isoPlugin } from '@aegis/mode-iso';
import type { World } from '@aegis/core';
import { createIsoAdapter } from './iso.js';
import type { IsoAdapter } from './iso.js';
import { ISO_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';

/** The normalised device coordinates a world point lands on, through the adapter's own camera. */
function ndcOf(adapter: IsoAdapter, x: number, y: number, z: number): { x: number; y: number } {
  const projected = new Vector3(x, y, z).project(adapter.camera);
  return { x: projected.x, y: projected.y };
}

/** Every passable cell of the world's baked nav grid. */
function passableCells(world: World): { x: number; y: number }[] {
  const nav = world.getResource(NavGrid);
  if (nav === undefined) return [];
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < nav.height; y++) {
    for (let x = 0; x < nav.width; x++) {
      if (nav.blocked[y * nav.width + x] !== true) cells.push({ x, y });
    }
  }
  return cells;
}

describe('clicking what you can see, in isometry', () => {
  it('resolves every passable cell to itself, whatever is standing near it', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: 16 / 9 });
    adapter.mount(world);

    const cells = passableCells(world);
    // Anti-vacuity. An empty cell list would make every assertion below hold trivially, and this
    // scene's grid is known: a 6x5 border ring with two interior walls leaves ten open cells.
    expect(cells.length).toBe(10);

    const wrong: string[] = [];
    const offScreen: string[] = [];
    for (const cell of cells) {
      const ndc = ndcOf(adapter, cell.x, 0, cell.y);
      // A cell outside the frustum is a different failure from a cell that resolves wrongly, and
      // conflating them would let a camera that framed nothing pass as "no wrong cells".
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) {
        offScreen.push(`(${cell.x},${cell.y})`);
        continue;
      }
      const picked = adapter.pick(ndc.x, ndc.y);
      if (picked === null || picked.x !== cell.x || picked.y !== cell.y) {
        wrong.push(`(${cell.x},${cell.y}) -> (${picked?.x},${picked?.y})`);
      }
    }

    expect(offScreen).toEqual([]);
    expect(wrong).toEqual([]);

    adapter.dispose();
  });

  it('selects an actor when you click the actor, not the floor behind it', () => {
    // The specific shape of the original bug: the guard's body is the only part of it a human can
    // aim at, and a ray through a body reaches the ground beyond. Aiming at the body — not at the
    // tile under it — must still order an action against the guard's own cell.
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: 16 / 9 });
    adapter.mount(world);

    const guard = world.query({ has: [GridPosition, Health], none: [Controlled] }).one();
    const cell = guard.get(GridPosition);
    const group = adapter.scene.getObjectByName(`actor:${guard.entity}`) as Object3D;
    const body = group.getObjectByName('body') as Mesh;
    // Precondition: the body really is a solid box standing above the tile, so "click the body"
    // means something. If it ever became a flat decal this test would silently become the
    // ground-plane test it is meant to replace.
    expect(body.scale.y).toBeGreaterThan(0.5);
    const bodyTop = group.position.y + body.position.y + body.scale.y / 2;
    expect(bodyTop).toBeGreaterThan(0.9);

    for (const height of [0.2, body.position.y, bodyTop - 0.05]) {
      const ndc = ndcOf(adapter, group.position.x, height, group.position.z);
      expect(adapter.pick(ndc.x, ndc.y), `aiming at height ${height} on the guard`).toEqual({
        x: cell.cellX,
        y: cell.cellY,
        z: 0,
      });
    }

    adapter.dispose();
  });

  it('keeps walls short enough that they cannot hide the cell behind them', () => {
    // The geometric bound, asserted directly so a future art change is caught here with the
    // reason attached rather than as "the level became unplayable again".
    //
    // The camera direction is (-1,-1,-1) normalised: one cell of x plus one cell of z is one unit
    // of height. A wall on the cell diagonally in front of a floor point therefore covers the
    // ray over t in [0.5, 1.5] -- so a wall taller than 0.5 hides that floor point outright.
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: 16 / 9 });
    adapter.mount(world);

    const wall = adapter.scene.getObjectByName('wall:2:2') as Mesh;
    expect(wall).toBeDefined();
    const top = wall.position.y + wall.scale.y / 2;
    expect(top).toBeLessThan(0.5);
    // And it is still a wall a human can see, not a hairline: the guard against "fix it by
    // drawing nothing".
    expect(top).toBeGreaterThan(0.2);

    adapter.dispose();
  });
});

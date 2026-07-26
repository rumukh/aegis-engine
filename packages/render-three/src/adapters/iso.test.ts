/**
 * Iso adapter: scene-graph construction from the baked nav grid, the door that vanishes when the
 * simulation unseals it, and the screen-to-cell unprojection that turns a click into the pointer
 * the mode's `iso.intake` reads.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { Mesh, Object3D } from 'three';
import { OrthographicCamera } from 'three';
import { Health } from '@aegis/content';
import { Blocking, Controlled, GridPosition, MoveOrder, isoPlugin } from '@aegis/mode-iso';
import { createIsoAdapter } from './iso.js';
import { ROLE_COLORS } from '../appearance.js';
import { ISO_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';

/** Names of every descendant of the named child group. */
function namesIn(root: Object3D, group: string): string[] {
  const parent = root.getObjectByName(group);
  return parent === undefined ? [] : parent.children.map((child) => child.name);
}

/** The colour of a mesh's material, as `#rrggbb`. */
function colorOf(object: Object3D | undefined): string {
  const material = (object as Mesh | undefined)?.material as { color?: { getHexString(): string } };
  return `#${material.color?.getHexString() ?? ''}`;
}

describe('iso adapter', () => {
  it('builds a wall column for every blocked cell and a floor plate for every passable one', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter();
    adapter.mount(world);

    const level = namesIn(adapter.scene, 'level');
    // 6x5 grid: the border ring plus two interior walls at (2,2) and (3,2).
    expect(level).toHaveLength(30);
    expect(level.filter((name) => name.startsWith('wall:'))).toHaveLength(20);
    expect(level.filter((name) => name.startsWith('floor:'))).toHaveLength(10);
    expect(level).toContain('wall:2:2');
    expect(level).toContain('floor:1:1');

    // Cell (cx, cy) maps to world (cx, _, cy) — the same mapping the semantic frame uses.
    const wall = adapter.scene.getObjectByName('wall:2:2') as Mesh;
    expect(wall.position.x).toBeCloseTo(2);
    expect(wall.position.z).toBeCloseTo(2);
    expect(wall.position.y).toBeGreaterThan(0);
    expect(colorOf(wall)).toBe(ROLE_COLORS.wall);

    adapter.dispose();
  });

  it('draws actors with a health bar, and greys a corpse', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter();
    adapter.mount(world);

    const guard = world.query({ has: [GridPosition, Health], none: [Controlled] }).one();
    const group = adapter.scene.getObjectByName(`actor:${guard.entity}`) as Object3D;
    expect(group.position.x).toBeCloseTo(4);
    expect(group.position.z).toBeCloseTo(3);
    expect(colorOf(group.getObjectByName('body'))).toBe(ROLE_COLORS.enemy);
    const fullBar = (group.getObjectByName('bar:fill') as Mesh).scale.x;

    world.getOrThrow(guard.entity, Health).current = 5;
    adapter.sync(world);
    expect((group.getObjectByName('bar:fill') as Mesh).scale.x).toBeCloseTo(fullBar * 0.25);

    world.getOrThrow(guard.entity, Health).current = 0;
    adapter.sync(world);
    expect(colorOf(group.getObjectByName('body'))).toBe(ROLE_COLORS.dead);
    expect((group.getObjectByName('bar:fill') as Mesh).visible).toBe(false);

    adapter.dispose();
  });

  it('drops the sealed door from the scene the tick the simulation unseals it', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter();
    adapter.mount(world);

    const door = world.query({ has: [Blocking, GridPosition] }).one().entity;
    expect(namesIn(adapter.scene, 'entities')).toContain(`door:${door}`);
    expect(colorOf(adapter.scene.getObjectByName(`door:${door}`))).toBe(ROLE_COLORS.door);

    world.remove(door, Blocking);
    adapter.sync(world);
    expect(namesIn(adapter.scene, 'entities')).not.toContain(`door:${door}`);

    adapter.dispose();
  });

  it('interpolates an actor along its resolved path using GridPosition.progress', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter();
    adapter.mount(world);

    const operative = world.query({ has: [Controlled, GridPosition] }).one().entity;
    world.add(operative, MoveOrder, {
      target: { x: 1, y: 3 },
      path: [{ x: 1, y: 2 }],
      resolved: true,
    });
    world.getOrThrow(operative, GridPosition).progress = 0.5;
    adapter.sync(world);

    const group = adapter.scene.getObjectByName(`actor:${operative}`) as Object3D;
    expect(group.position.x).toBeCloseTo(1);
    expect(group.position.z).toBeCloseTo(1.5);

    adapter.dispose();
  });

  it('projects a click at the viewport centre back to the followed cell', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: 16 / 9 });
    adapter.mount(world);

    // The camera looks at the operative's cell (1, 1), so the centre of the screen is that cell.
    expect(adapter.pick(0, 0)).toEqual({ x: 1, y: 1, z: 0 });

    // The projection is isometric: moving right on screen moves +x and -y in grid space.
    const right = adapter.pick(0.35, 0);
    expect(right).not.toBeNull();
    expect(right!.x).toBeGreaterThan(1);
    expect(right!.y).toBeLessThan(1);

    adapter.dispose();
  });

  it('spans the authored viewHeight orthographically', () => {
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: 1 });
    adapter.mount(world);
    const camera = adapter.camera as OrthographicCamera;
    expect(camera).toBeInstanceOf(OrthographicCamera);
    expect(camera.top - camera.bottom).toBeCloseTo(12);
    expect(camera.right - camera.left).toBeCloseTo(12);
    adapter.resize(1920, 1080);
    expect((camera.right - camera.left) / (camera.top - camera.bottom)).toBeCloseTo(16 / 9);
    adapter.dispose();
  });
});

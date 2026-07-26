/**
 * FPS adapter: extruding the collision grid into walls with per-tile heights, the blast door that
 * disappears when the game flips its cell, and the perspective camera driven by `LookState`.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type { Mesh, Object3D } from 'three';
import { PerspectiveCamera, Vector3 } from 'three';
import { Transform } from '@aegis/core';
import { Health } from '@aegis/content';
import {
  FPS_COLLISION,
  FpsCamera,
  HitBox,
  LookState,
  forwardFromLook,
  fpsPlugin,
} from '@aegis/mode-fps';
import { createFpsAdapter } from './fps.js';
import { ROLE_COLORS } from '../appearance.js';
import { FPS_SCENE } from '../testing/scenes.js';
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

describe('fps adapter', () => {
  it('extrudes every solid cell into a column from its floor to its ceiling', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const adapter = createFpsAdapter();
    adapter.mount(world);

    const level = namesIn(adapter.scene, 'level');
    const grid = world.getResource(FPS_COLLISION);
    const solid = grid?.cells.filter((cell) => cell.solid).length ?? 0;
    const open = (grid?.cells.length ?? 0) - solid;
    expect(level.filter((name) => name.startsWith('wall:'))).toHaveLength(solid);
    // Every open cell gets a ground slab and a ceiling slab.
    expect(level.filter((name) => name.startsWith('ground:'))).toHaveLength(open);
    expect(level.filter((name) => name.startsWith('ceiling:'))).toHaveLength(open);

    const wall = adapter.scene.getObjectByName('wall:0:0') as Mesh;
    expect(wall.scale.y).toBeCloseTo(4);
    expect(wall.position.y).toBeCloseTo(2);
    expect(colorOf(wall)).toBe(ROLE_COLORS.wall);

    adapter.dispose();
  });

  it('sinks the hazard pit to its own floor height and colours it', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const adapter = createFpsAdapter();
    adapter.mount(world);

    // The `T` tile sits at row 2, col 2 with floor -3.
    const pit = adapter.scene.getObjectByName('ground:2:2') as Mesh;
    expect(pit.position.y).toBeLessThan(-2.9);
    expect(colorOf(pit)).toBe(ROLE_COLORS.pit);

    const flat = adapter.scene.getObjectByName('ground:2:1') as Mesh;
    expect(flat.position.y).toBeGreaterThan(-1);
    expect(colorOf(flat)).toBe(ROLE_COLORS.floor);

    adapter.dispose();
  });

  it('draws the blast door in the door colour and removes it when the cell opens', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const adapter = createFpsAdapter();
    adapter.mount(world);

    // The `=` door tile is at row 3, col 2.
    expect(colorOf(adapter.scene.getObjectByName('wall:2:3'))).toBe(ROLE_COLORS.door);

    const grid = world.getResource(FPS_COLLISION);
    const cell = grid?.cells[3 * (grid?.width ?? 0) + 2];
    expect(cell?.door).toBe(true);
    if (cell !== undefined) cell.solid = false;
    adapter.sync(world);

    expect(namesIn(adapter.scene, 'level')).not.toContain('wall:2:3');
    expect(namesIn(adapter.scene, 'level')).toContain('ground:2:3');

    adapter.dispose();
  });

  it('draws shootable hit boxes exactly where the hitscan resolves them', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const adapter = createFpsAdapter();
    adapter.mount(world);

    const panel = world.query({ has: [HitBox, Transform], none: [Health] }).one();
    const mesh = adapter.scene.getObjectByName(`hitbox:${panel.entity}`) as Mesh;
    const box = panel.get(HitBox);
    const at = panel.get(Transform).position;
    expect(mesh.position.x).toBeCloseTo(at.x + box.offset.x);
    expect(mesh.position.y).toBeCloseTo(at.y + box.offset.y);
    expect(mesh.scale.y).toBeCloseTo(box.half.y * 2);
    expect(colorOf(mesh)).toBe(ROLE_COLORS.switch);

    const grunt = world.query({ has: [HitBox, Health] }).one();
    const gruntMesh = adapter.scene.getObjectByName(`hitbox:${grunt.entity}`) as Mesh;
    expect(colorOf(gruntMesh)).toBe(ROLE_COLORS.enemy);
    world.getOrThrow(grunt.entity, Health).current = 0;
    adapter.sync(world);
    expect(colorOf(gruntMesh)).toBe(ROLE_COLORS.dead);

    adapter.dispose();
  });

  it('puts the camera at the eye and aims it exactly where the mode says forward is', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const adapter = createFpsAdapter({ aspect: 16 / 9 });
    adapter.mount(world);

    const player = world.query({ has: [FpsCamera, LookState, Transform] }).one();
    const rig = player.get(FpsCamera);
    const at = player.get(Transform).position;
    const camera = adapter.camera as PerspectiveCamera;

    expect(camera).toBeInstanceOf(PerspectiveCamera);
    expect(camera.fov).toBeCloseTo(rig.fovDegrees);
    expect(camera.near).toBeCloseTo(rig.near);
    expect(camera.position.y).toBeCloseTo(at.y + rig.eyeHeight);
    expect(camera.position.z).toBeCloseTo(at.z);

    for (const [yaw, pitch] of [
      [0, 0],
      [90, 0],
      [-135, 20],
      [37, -41],
    ] as const) {
      const look = world.getOrThrow(player.entity, LookState);
      look.yawDeg = yaw;
      look.pitchDeg = pitch;
      adapter.sync(world);

      const expected = forwardFromLook(yaw, pitch);
      // three's camera looks down its local -Z; its world forward must equal the mode's.
      const actual = camera.getWorldDirection(new Vector3());
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.z).toBeCloseTo(expected.z, 5);
    }

    adapter.resize(1600, 900);
    expect(camera.aspect).toBeCloseTo(16 / 9);

    adapter.dispose();
  });
});

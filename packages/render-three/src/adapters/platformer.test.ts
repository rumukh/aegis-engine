/**
 * Platformer adapter: scene-graph construction from a known world, and the orthographic
 * projection driven by the mode's own camera rig.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { Transform } from '@aegis/core';
import type { Mesh, Object3D } from 'three';
import { OrthographicCamera } from 'three';
import { PlatformerCamera, PlatformerController } from '@aegis/mode-platformer';
import { BodyState, platformerPlugin } from '@aegis/mode-platformer';
import { createPlatformerAdapter } from './platformer.js';
import { ROLE_COLORS } from '../appearance.js';
import { PLATFORMER_SCENE } from '../testing/scenes.js';
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

describe('platformer adapter', () => {
  it('extrudes the baked tilemap into solid and hazard blocks', () => {
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = createPlatformerAdapter();
    adapter.mount(world);

    const tiles = namesIn(adapter.scene, 'level');
    // Row 4 has 4 + 5 solid tiles, row 5 has 4 + 5 solid plus 3 hazards.
    expect(tiles.filter((name) => name.startsWith('tile:'))).toHaveLength(21);
    expect(tiles).toContain('tile:0:4');
    expect(tiles).toContain('tile:5:5');
    expect(tiles).not.toContain('tile:5:4');

    // A tile at (col, row) spans x in [col, col+1] and y in [H-1-row, H-row].
    const ground = adapter.scene.getObjectByName('tile:0:4') as Mesh;
    expect(ground.position.x).toBeCloseTo(0.5);
    expect(ground.position.y).toBeCloseTo(1.5);
    expect(colorOf(ground)).toBe(ROLE_COLORS.wall);

    const spikes = adapter.scene.getObjectByName('tile:5:5') as Mesh;
    expect(colorOf(spikes)).toBe(ROLE_COLORS.hazard);
    expect(spikes.scale.y).toBeLessThan(1);

    adapter.dispose();
  });

  it('draws the player, the critter, the moving platform and the goal volume', () => {
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = createPlatformerAdapter();
    adapter.mount(world);

    const player = world.query({ has: [PlatformerController, Transform] }).one();
    const entities = namesIn(adapter.scene, 'entities');
    expect(entities).toContain(`actor:${player.entity}`);
    expect(entities.filter((name) => name.startsWith('actor:'))).toHaveLength(2);
    expect(entities.filter((name) => name.startsWith('platform:'))).toHaveLength(1);
    expect(entities.filter((name) => name.startsWith('trigger:'))).toHaveLength(1);

    const group = adapter.scene.getObjectByName(`actor:${player.entity}`) as Object3D;
    expect(group.position.x).toBeCloseTo(1.5);
    expect(group.position.y).toBeCloseTo(2.5);
    const body = group.getObjectByName('body') as Mesh;
    expect(colorOf(body)).toBe(ROLE_COLORS.player);
    expect(body.scale.x).toBeCloseTo(0.8);
    expect(body.scale.y).toBeCloseTo(1);

    adapter.dispose();
  });

  it('flips the facing pip with BodyState.facing', () => {
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = createPlatformerAdapter();
    adapter.mount(world);
    const player = world.query({ has: [PlatformerController] }).one();
    const pip = (): Mesh =>
      (adapter.scene.getObjectByName(`actor:${player.entity}`) as Object3D).getObjectByName(
        'facing',
      ) as Mesh;

    expect(pip().position.x).toBeGreaterThan(0);
    world.getOrThrow(player.entity, BodyState).facing = -1;
    adapter.sync(world);
    expect(pip().position.x).toBeLessThan(0);

    adapter.dispose();
  });

  it('takes the orthographic frustum from the camera rig and the viewport aspect', () => {
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = createPlatformerAdapter({ aspect: 2 });
    adapter.mount(world);

    const camera = adapter.camera as OrthographicCamera;
    expect(camera).toBeInstanceOf(OrthographicCamera);
    // viewHeight 10 -> +/-5 vertically, and +/-10 horizontally at aspect 2.
    expect(camera.top).toBeCloseTo(5);
    expect(camera.bottom).toBeCloseTo(-5);
    expect(camera.right).toBeCloseTo(10);
    expect(camera.left).toBeCloseTo(-10);

    const rig = world
      .query({ has: [PlatformerCamera, Transform] })
      .one()
      .get(Transform).position;
    expect(camera.position.x).toBeCloseTo(rig.x);
    expect(camera.position.y).toBeCloseTo(rig.y);
    expect(camera.position.z).toBeGreaterThan(0);

    adapter.resize(1600, 400);
    expect(camera.right / camera.top).toBeCloseTo(4);

    adapter.dispose();
  });

  it('has no pointer semantics', () => {
    const adapter = createPlatformerAdapter();
    expect(adapter.pick(0, 0)).toBeNull();
    adapter.dispose();
  });
});

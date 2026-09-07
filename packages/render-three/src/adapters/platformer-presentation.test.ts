import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import type { Mesh } from 'three';
import { Sprite, Trigger } from '@aegis/content';
import { TileCollider, platformerPlugin } from '@aegis/mode-platformer';
import { buildTestWorld } from '../testing/world.js';
import { PLATFORMER_SCENE } from '../testing/scenes.js';
import { entityNamed, runtimeAssets, runtimeManifest } from '../presentation/runtime-test-utils.js';
import { createPlatformerAdapter } from './platformer.js';

describe('platformer presentation bindings', () => {
  it('honors authored sprite offsets and size without fitting them to the collider', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
          fit: 'authored',
          pose: { position: [0.3, 0.5, -0.2], scale: [1.5, 2, 1] },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const before = world.snapshot();
      adapter.mount(world);
      const visual = adapter.presentation!.entity('player')!;
      expect(visual.root.position.toArray()).toEqual([1.5, 2.5, 0]);
      const box = new Box3().setFromObject(visual.root);
      expect(box.getSize(new Vector3()).toArray()).toEqual([expect.closeTo(1.5, 12), 2, 0]);
      expect(box.getCenter(new Vector3()).toArray()).toEqual([expect.closeTo(1.8, 12), 3, -0.2]);
      const body = adapter.scene
        .getObjectByName(`actor:${entityNamed(world, 'player')}`)!
        .getObjectByName('body')!;
      expect(body.scale.toArray()).toEqual([0.8, 1, 0.8]);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('keeps authored models at entity origin rather than applying collider offsets/depth or fitting metres away', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'model', mesh: 'rig' },
          fit: 'authored',
          pose: { scale: [2, 2, 2] },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const player = entityNamed(world, 'player');
      const collider = world.getOrThrow(player, TileCollider);
      collider.offsetX = 0.7;
      collider.offsetY = -0.2;
      const before = world.snapshot();
      adapter.mount(world);
      const mechanical = adapter.scene.getObjectByName(`actor:${player}`)!;
      const body = mechanical.getObjectByName('body') as Mesh;
      expect(mechanical.position.toArray()).toEqual([2.2, 2.3, 0.5]);
      expect(body.scale.toArray()).toEqual([0.8, 1, 0.8]);
      const visual = adapter.presentation!.entity('player')!;
      expect(visual.root.position.toArray()).toEqual([1.5, 2.5, 0]);
      expect(visual.root.getObjectByName('presentation:fit')!.scale.toArray()).toEqual([1, 1, 1]);
      expect(new Box3().setFromObject(visual.root).getSize(new Vector3()).y).toBeCloseTo(2.7);
      expect(body.visible).toBe(false);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('hides legacy groups only when explicitly requested and exposes them in diagnostics without hiding actors', async () => {
    const manifest = runtimeManifest({
      legacy: { level: false, triggers: false },
      objects: [{ id: 'authored-level', visual: { kind: 'primitive', shape: 'plane' } }],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      adapter.mount(world);
      const level = adapter.scene.getObjectByName('level')!;
      const trigger = adapter.scene.getObjectByName(`trigger:${entityNamed(world, 'goal')}`)!;
      const player = adapter.scene.getObjectByName(`actor:${entityNamed(world, 'player')}`)!;
      const before = world.snapshot();
      const geometry = level.children.map((mesh) => ({
        object: mesh,
        position: mesh.position.toArray(),
        scale: mesh.scale.toArray(),
      }));
      expect(adapter.presentation!.stats().legacy).toEqual({
        level: false,
        triggers: false,
        debugGeometry: false,
        levelVisible: false,
        retainedMeshes: 27,
        visibleMeshes: 5,
      });
      expect(level.visible).toBe(false);
      expect(trigger.visible).toBe(false);
      expect(player.getObjectByName('body')?.visible).toBe(true);
      expect(adapter.presentation!.entity('player')).toBeUndefined();
      adapter.presentation!.setDebugGeometry(true);
      expect(level.visible).toBe(true);
      expect(trigger.visible).toBe(true);
      expect(adapter.presentation!.stats().legacy).toMatchObject({
        debugGeometry: true,
        levelVisible: true,
        retainedMeshes: 27,
        visibleMeshes: 27,
      });
      adapter.sync(world);
      expect(trigger.visible).toBe(true);
      adapter.presentation!.setDebugGeometry(false);
      expect(level.visible).toBe(false);
      expect(trigger.visible).toBe(false);
      expect(player.getObjectByName('body')?.visible).toBe(true);
      expect(
        level.children.map((mesh) => ({
          object: mesh,
          position: mesh.position.toArray(),
          scale: mesh.scale.toArray(),
        })),
      ).toEqual(geometry);
      expect(world.snapshot()).toEqual(before);
      expect(adapter.presentation!.stats().legacy.visibleMeshes).toBe(5);

      const playerEntity = entityNamed(world, 'player');
      world.add(playerEntity, Trigger, { kind: 'goal', half: { x: 1, y: 1, z: 1 } });
      adapter.sync(world);
      expect(player.getObjectByName('body')?.visible).toBe(true);
      expect(adapter.scene.getObjectByName(`trigger:${playerEntity}`)?.visible).toBe(false);
      expect(adapter.presentation!.stats().legacy.retainedMeshes).toBe(28);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('reveals retained collision geometry even when an appearance hides its whole actor group', async () => {
    const manifest = runtimeManifest({
      entities: [{ target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig' } }],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const playerEntity = entityNamed(world, 'player');
      world.add(playerEntity, Sprite, { texture: '', visible: false });
      adapter.mount(world);
      const runtime = adapter.presentation!;
      const actor = adapter.scene.getObjectByName(`actor:${playerEntity}`)!;
      const body = actor.getObjectByName('body')!;
      const before = world.snapshot();
      expect(actor.visible).toBe(false);
      expect(body.visible).toBe(false);
      expect(runtime.stats().legacy.visibleMeshes).toBe(25);
      runtime.setDebugGeometry(true);
      expect(actor.visible).toBe(true);
      expect(body.visible).toBe(true);
      expect(runtime.stats().legacy.visibleMeshes).toBe(27);
      adapter.sync(world);
      expect(actor.visible).toBe(true);
      expect(body.visible).toBe(true);
      runtime.setDebugGeometry(false);
      expect(actor.visible).toBe(false);
      expect(body.visible).toBe(false);
      expect(world.snapshot()).toEqual(before);

      runtime.setDebugGeometry(true);
      world.getOrThrow(playerEntity, Sprite).visible = true;
      adapter.sync(world);
      runtime.setDebugGeometry(false);
      expect(actor.visible).toBe(true);
      expect(body.visible).toBe(false);
      expect(runtime.entity('player')!.root.visible).toBe(true);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('updates tint/visibility even on the descriptor-free primitive path', () => {
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Sprite, { texture: '', tint: '#ff0000', visible: true });
    const adapter = createPlatformerAdapter();
    try {
      adapter.mount(world);
      expect(adapter.presentation).toBeUndefined();
      const actor = adapter.scene.getObjectByName(`actor:${player}`)!;
      expect(actor.visible).toBe(true);
      world.getOrThrow(player, Sprite).visible = false;
      adapter.sync(world);
      expect(actor.visible).toBe(false);
      expect(actor.getObjectByName('facing')?.visible).toBe(false);
    } finally {
      adapter.dispose();
    }
  });
});

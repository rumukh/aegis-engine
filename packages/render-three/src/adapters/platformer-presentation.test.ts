import { describe, expect, it } from 'vitest';
import { Box3, MeshBasicMaterial, Vector3 } from 'three';
import type { Mesh } from 'three';
import { createSchedule, createSimulation, Transform } from '@aegis/core';
import { Health, Sprite, Trigger } from '@aegis/content';
import { BodyState, TileCollider, Velocity, platformerPlugin } from '@aegis/mode-platformer';
import { buildTestWorld } from '../testing/world.js';
import { PLATFORMER_SCENE } from '../testing/scenes.js';
import {
  entityNamed,
  presentationFrame,
  runtimeAssets,
  runtimeManifest,
} from '../presentation/runtime-test-utils.js';
import { createPlatformerAdapter } from './platformer.js';

describe('platformer presentation bindings', () => {
  it('animates and faces a Transform-driven actor without requiring a Velocity or game component', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { role: 'enemy' },
          visual: {
            kind: 'sprite',
            texture: 'surface',
            frame: 'left',
            animations: {
              idle: { frames: ['left'], frameTicks: 1 },
              move: { frames: ['left', 'right'], frameTicks: 2 },
              dead: { frames: ['right'], frameTicks: 1 },
            },
          },
          fit: 'authored',
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const actor = entityNamed(world, 'critter');
      expect(world.has(actor, Velocity)).toBe(false);
      const position = world.getOrThrow(actor, Transform).position;
      const simulation = createSimulation({ world, schedule: createSchedule(), tickRate: 60 });
      adapter.mount(world);
      adapter.present(presentationFrame(0));
      const runtime = adapter.presentation!;
      const visual = runtime.entity('critter')!;
      const mesh = visual.object as Mesh;
      const map = () => {
        expect(mesh.material).toBeInstanceOf(MeshBasicMaterial);
        return (mesh.material as MeshBasicMaterial).map;
      };
      expect(visual.state).toBe('idle');
      expect(map()).toBe(assets.texture('surface', 'left'));

      position.x -= 0.1;
      simulation.step();
      const before = world.snapshot();
      adapter.sync(world);
      adapter.present(presentationFrame(1));
      expect(runtime.entity('critter')!.state).toBe('move');
      expect(visual.root.scale.x).toBe(-1);
      const resources = runtime.stats().resources;
      // Picking, paused frames and repeated drawing must not turn a walking actor back to idle.
      for (let i = 0; i < 4; i++) adapter.sync(world);
      adapter.present(presentationFrame(1, { paused: true }));
      expect(runtime.entity('critter')!.state).toBe('move');
      expect(world.snapshot()).toEqual(before);

      simulation.run(2);
      position.x -= 0.2;
      adapter.sync(world);
      adapter.present(presentationFrame(3));
      expect(map()).toBe(assets.texture('surface', 'right'));
      expect(runtime.stats().resources).toEqual(resources);

      simulation.step();
      adapter.sync(world);
      adapter.present(presentationFrame(4));
      expect(runtime.entity('critter')!.state).toBe('idle');
      expect(visual.root.scale.x).toBe(-1);
      expect(map()).toBe(assets.texture('surface', 'left'));

      position.x += 0.1;
      simulation.step();
      adapter.sync(world);
      expect(visual.root.scale.x).toBe(1);
      world.getOrThrow(actor, Health).current = 0;
      adapter.sync(world);
      adapter.present(presentationFrame(5));
      expect(runtime.entity('critter')!.state).toBe('dead');
      expect(map()).toBe(assets.texture('surface', 'right'));
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('keeps a carried body idle and obeys its authoritative facing and airborne state', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { role: 'player' },
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const player = entityNamed(world, 'player');
      const body = world.getOrThrow(player, BodyState);
      const velocity = world.getOrThrow(player, Velocity);
      const position = world.getOrThrow(player, Transform).position;
      const simulation = createSimulation({ world, schedule: createSchedule(), tickRate: 60 });
      body.grounded = true;
      body.facing = -1;
      body.carriedBy = entityNamed(world, 'lift');
      adapter.mount(world);
      position.x += 0.5;
      simulation.run(5);
      const before = world.snapshot();
      adapter.sync(world);
      expect(adapter.presentation!.entity('player')!.state).toBe('idle');
      expect(adapter.presentation!.entity('player')!.root.scale.x).toBe(-1);
      expect(world.snapshot()).toEqual(before);

      velocity.dx = 8;
      adapter.sync(world);
      expect(adapter.presentation!.entity('player')!.state).toBe('move');
      expect(adapter.presentation!.entity('player')!.root.scale.x).toBe(-1);
      body.grounded = false;
      velocity.dy = 16;
      adapter.sync(world);
      expect(adapter.presentation!.entity('player')!.state).toBe('rise');
      velocity.dy = -10;
      adapter.sync(world);
      expect(adapter.presentation!.entity('player')!.state).toBe('fall');
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('forgets sampled patrol motion on rewind, reset, remount and entity replacement', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { role: 'enemy' },
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const actor = entityNamed(world, 'critter');
      const initial = world.snapshot();
      const simulation = createSimulation({ world, schedule: createSchedule(), tickRate: 60 });
      adapter.mount(world);
      const move = () => {
        world.getOrThrow(actor, Transform).position.x -= 0.1;
        simulation.step();
        adapter.sync(world);
        expect(adapter.presentation!.entity('critter')!.state).toBe('move');
        expect(adapter.presentation!.entity('critter')!.root.scale.x).toBe(-1);
      };
      move();
      world.restore(initial);
      adapter.sync(world);
      expect(adapter.presentation!.entity('critter')!.state).toBe('idle');
      expect(adapter.presentation!.entity('critter')!.root.scale.x).toBe(1);
      move();
      adapter.resetPresentation();
      adapter.sync(world);
      expect(adapter.presentation!.entity('critter')!.state).toBe('idle');
      expect(adapter.presentation!.entity('critter')!.root.scale.x).toBe(1);
      move();
      adapter.mount(world);
      expect(adapter.presentation!.entity('critter')!.state).toBe('idle');
      expect(adapter.presentation!.entity('critter')!.root.scale.x).toBe(1);

      move();
      world.despawn(actor);
      adapter.sync(world);
      expect(adapter.presentation!.entity('critter')).toBeUndefined();
      const replacement = world.spawn();
      world.add(replacement, Transform, { position: { x: 3, y: 2.4, z: 0 } });
      world.add(replacement, TileCollider);
      world.add(replacement, Health);
      adapter.sync(world);
      expect(adapter.presentation!.entity(String(replacement))!.state).toBe('idle');
      expect(adapter.presentation!.entity(String(replacement))!.root.scale.x).toBe(1);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

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

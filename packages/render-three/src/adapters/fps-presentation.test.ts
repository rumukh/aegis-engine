import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Mesh } from 'three';
import { Transform } from '@aegis/core';
import { fpsPlugin } from '@aegis/mode-fps';
import { buildTestWorld } from '../testing/world.js';
import { FPS_SCENE } from '../testing/scenes.js';
import {
  entityNamed,
  presentationFrame,
  runtimeAssets,
  runtimeManifest,
} from '../presentation/runtime-test-utils.js';
import { createFpsAdapter } from './fps.js';

describe('fps presentation bindings', () => {
  it('preserves authored origin/metres/orientation independently of a raised HitBox', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'panel' },
          fit: 'authored',
          visual: { kind: 'model', mesh: 'rig' },
          pose: { position: [0, 0.2, 0], scale: [2, 2, 2] },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createFpsAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(FPS_SCENE, fpsPlugin);
      const panel = entityNamed(world, 'panel');
      const transform = world.getOrThrow(panel, Transform);
      const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
      Object.assign(transform.rotation, {
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w,
      });
      const before = world.snapshot();
      adapter.mount(world);
      const hitbox = adapter.scene.getObjectByName(`hitbox:${panel}`) as Mesh;
      expect(hitbox.position.toArray()).toEqual([1, 1.5, 1]);
      expect(hitbox.scale.toArray()).toEqual([0.6, 1, 1]);
      const visual = adapter.presentation!.entity('panel')!;
      expect(visual.root.position.toArray()).toEqual([1, 0, 1]);
      expect(visual.root.quaternion.toArray()).toEqual(rotation.toArray());
      expect(visual.root.getObjectByName('presentation:fit')!.scale.toArray()).toEqual([1, 1, 1]);
      expect(visual.root.getObjectByName('presentation:pose')!.scale.toArray()).toEqual([2, 2, 2]);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('recoils a named view-object node without moving the camera, hitbox, or any projected hit point', async () => {
    const manifest = runtimeManifest({
      objects: [
        {
          id: 'view-tool',
          anchor: 'camera',
          visual: { kind: 'model', mesh: 'rig' },
          pose: { position: [0.2, -0.2, -2] },
        },
      ],
      effects: [
        {
          event: 'fire',
          kind: 'recoil',
          target: { object: 'view-tool', node: 'fin' },
          durationTicks: 20,
          amount: 0.3,
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createFpsAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(FPS_SCENE, fpsPlugin);
      adapter.mount(world);
      const runtime = adapter.presentation!;
      const fin = runtime.object('view-tool')!.object.getObjectByName('fin')!;
      const hitbox = adapter.scene.getObjectByName(`hitbox:${entityNamed(world, 'panel')}`)!;
      const position = hitbox.position.toArray();
      const projected = hitbox.position.clone().project(adapter.camera).toArray();
      const camera = adapter.camera.matrixWorld.toArray();
      const before = world.snapshot();
      runtime.present(presentationFrame(0, { events: [{ type: 'fire', tick: 0, sequence: 0 }] }));
      expect(fin.position.z).toBeCloseTo(0.3);
      adapter.sync(world);
      expect(fin.position.z).toBeCloseTo(0.3);
      expect(adapter.camera.matrixWorld.toArray()).toEqual(camera);
      expect(hitbox.position.toArray()).toEqual(position);
      expect(hitbox.position.clone().project(adapter.camera).toArray()).toEqual(projected);
      runtime.present(presentationFrame(10));
      expect(fin.position.z).toBeCloseTo(0.15);
      runtime.present(presentationFrame(100, { paused: true }));
      expect(fin.position.z).toBeCloseTo(0.15);
      runtime.present(presentationFrame(20));
      expect(fin.position.z).toBe(0);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('rejects recoil on a world object rather than silently approximating camera shake', async () => {
    const manifest = runtimeManifest({
      objects: [{ id: 'world-tool', visual: { kind: 'primitive', shape: 'box' } }],
      effects: [
        { event: 'fire', kind: 'recoil', target: { object: 'world-tool' }, durationTicks: 10 },
      ],
    });
    const assets = await runtimeAssets(manifest);
    try {
      expect(() => createFpsAdapter({ presentation: { manifest, assets } })).toThrow(
        /camera-anchored presentation object, never the camera/,
      );
    } finally {
      assets.dispose();
    }
  });
});

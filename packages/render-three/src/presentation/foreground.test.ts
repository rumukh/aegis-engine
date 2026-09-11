import { describe, expect, it, vi } from 'vitest';
import { Mesh, Vector3 } from 'three';
import { fpsPlugin } from '@aegis/mode-fps';
import { createFpsAdapter } from '../adapters/fps.js';
import { FPS_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';
import { presentationFrame, runtimeAssets, runtimeManifest } from './runtime-test-utils.js';

describe('camera-object foreground ownership', () => {
  it('routes only camera-object bursts to the foreground, keeping world coordinates and fallback', async () => {
    const manifest = runtimeManifest({
      objects: [
        {
          id: 'view',
          anchor: 'camera',
          visual: { kind: 'model', mesh: 'rig' },
          pose: { position: [0.2, -0.2, -1] },
        },
        { id: 'world', visual: { kind: 'model', mesh: 'rig' }, pose: { position: [2, 1, 5] } },
      ],
      effects: [
        {
          event: 'fire',
          kind: 'burst',
          target: { object: 'view', node: 'fin' },
          count: 2,
          durationTicks: 12,
        },
        {
          event: 'fire',
          kind: 'burst',
          target: { object: 'world', node: 'fin' },
          count: 3,
          durationTicks: 12,
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createFpsAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(FPS_SCENE, fpsPlugin);
      const before = world.snapshot();
      adapter.mount(world);
      const runtime = adapter.presentation!;
      const foreground = adapter.foreground!.scene;
      const view = runtime.object('view')!;
      expect(view.root.parent).toBe(foreground);
      expect(runtime.object('world')?.root.parent).not.toBe(foreground);
      adapter.present(presentationFrame(0, { events: [{ type: 'fire', tick: 0, sequence: 0 }] }));
      const sparks = foreground.children.filter((node) => node.name.startsWith('effect:burst:'));
      expect(sparks).toHaveLength(2);
      expect(adapter.scene.getObjectByName('presentation:effects')?.children).toHaveLength(3);
      const origin = view.object.getObjectByName('fin')!.getWorldPosition(new Vector3());
      for (const spark of sparks) expect(spark.position.toArray()).toEqual(origin.toArray());
      runtime.setCameraEffectsParent(undefined);
      adapter.present(presentationFrame(1, { events: [{ type: 'fire', tick: 1, sequence: 1 }] }));
      expect(
        foreground.children.filter((node) => node.name.startsWith('effect:burst:')),
      ).toHaveLength(2);
      expect(adapter.scene.getObjectByName('presentation:effects')?.children).toHaveLength(8);
      adapter.present(presentationFrame(13));
      expect(runtime.stats().effects.active).toBe(0);
      expect(
        foreground.children.filter((node) => node.name.startsWith('effect:burst:')),
      ).toHaveLength(0);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('retains material self-depth and borrowed resources through reset, eviction and remount', async () => {
    const manifest = runtimeManifest({
      objects: [{ id: 'view', anchor: 'camera', visual: { kind: 'model', mesh: 'rig' } }],
      effects: [
        {
          event: 'fire',
          kind: 'burst',
          target: { object: 'view', node: 'fin' },
          count: 4,
          durationTicks: 12,
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createFpsAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(FPS_SCENE, fpsPlugin);
      adapter.mount(world);
      const runtime = adapter.presentation!;
      const visual = runtime.object('view')!.object;
      const mesh = visual.getObjectByName('body');
      if (!(mesh instanceof Mesh)) throw new Error('Fixture must contain model geometry.');
      const material = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
      const geometryDisposal = vi.fn(),
        materialDisposal = vi.fn();
      mesh.geometry.addEventListener('dispose', geometryDisposal);
      material.addEventListener('dispose', materialDisposal);
      runtime.setQuality('low');
      adapter.present(
        presentationFrame(0, {
          events: Array.from({ length: 20 }, (_, sequence) => ({
            type: 'fire',
            tick: 0,
            sequence,
          })),
        }),
      );
      expect(runtime.stats().effects.active).toBe(32);
      expect(
        adapter.foreground!.scene.children.filter((node) => node.name.startsWith('effect:burst:')),
      ).toHaveLength(32);
      adapter.resetPresentation();
      expect(
        adapter.foreground!.scene.children.filter((node) => node.name.startsWith('effect:burst:')),
      ).toHaveLength(0);
      adapter.mount(world);
      adapter.present(
        presentationFrame(0, { generation: 1, events: [{ type: 'fire', tick: 0, sequence: 0 }] }),
      );
      expect(
        adapter.foreground!.scene.children.filter((node) => node.name.startsWith('effect:burst:')),
      ).toHaveLength(4);
      expect(material.depthTest).toBe(true);
      expect(material.depthWrite).toBe(true);
      expect(material.transparent).toBe(false);
      expect(mesh.material).toBe(material);
      expect(geometryDisposal).not.toHaveBeenCalled();
      adapter.dispose();
      adapter.dispose();
      expect(adapter.foreground!.scene.children).toHaveLength(0);
      expect(assets.stats().modelInstances).toBe(0);
      expect(geometryDisposal).not.toHaveBeenCalled();
      expect(materialDisposal).not.toHaveBeenCalled();
      assets.dispose();
      expect(geometryDisposal).toHaveBeenCalledTimes(1);
      expect(materialDisposal).toHaveBeenCalledTimes(1);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });
});

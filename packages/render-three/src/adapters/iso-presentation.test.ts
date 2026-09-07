import { describe, expect, it } from 'vitest';
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
import { Blocking, GridPosition, MoveOrder, NavGrid, isoPlugin } from '@aegis/mode-iso';
import { buildTestWorld } from '../testing/world.js';
import { ISO_SCENE } from '../testing/scenes.js';
import {
  entityNamed,
  modelPart,
  presentationFrame,
  runtimeAssets,
  runtimeManifest,
} from '../presentation/runtime-test-utils.js';
import { createIsoAdapter } from './iso.js';

describe('iso presentation bindings', () => {
  it('lets the owner replace a short cell wall using declared visual data without changing its pick bounds', async () => {
    const manifest = runtimeManifest({
      entities: [{ target: { role: 'wall' }, visual: { kind: 'model', mesh: 'rig' } }],
    });
    const assets = await runtimeAssets(manifest, (gltf) => {
      gltf.animations = [];
      gltf.scene.clear();
      const mesh = new Mesh(
        new BoxGeometry(1, 0.45, 1),
        new MeshBasicMaterial({ color: '#c0c0c0' }),
      );
      mesh.name = 'authored-wall';
      mesh.position.y = 0.225;
      gltf.scene.add(mesh);
    });
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const before = world.snapshot();
      adapter.mount(world);
      const runtime = adapter.presentation!;
      const oldWall = adapter.scene.getObjectByName('wall:2:2')!;
      expect(oldWall).toBeInstanceOf(Mesh);
      expect(assets.stats().modelInstances).toBe(0);
      const visual = runtime.createVisual(manifest.entities![0]!.visual);
      const cell = new Group();
      cell.name = oldWall.name;
      cell.position.copy(oldWall.position);
      visual.root.position.y = -0.225;
      cell.add(visual.root);
      const level = oldWall.parent!;
      oldWall.removeFromParent();
      level.add(cell);
      adapter.sync(world);
      const bounds = new Box3().setFromObject(cell);
      expect(bounds.getSize(new Vector3()).toArray()).toEqual([1, expect.closeTo(0.45, 6), 1]);
      expect(bounds.min.y).toBeCloseTo(0);
      expect(bounds.max.y).toBeLessThan(0.5);
      expect(bounds.max.y).toBeGreaterThan(0.2);
      const mesh = visual.root.getObjectByName('authored-wall') as Mesh;
      expect((mesh.material as MeshBasicMaterial).opacity).toBe(1);
      expect((mesh.material as MeshBasicMaterial).transparent).toBe(false);
      const at = new Vector3(2, 0.4, 2).project(adapter.camera);
      const ray = new Raycaster();
      adapter.scene.updateMatrixWorld(true);
      ray.setFromCamera(new Vector2(at.x, at.y), adapter.camera);
      expect(ray.intersectObject(visual.root, true).length).toBeGreaterThan(0);
      expect(adapter.pick(at.x, at.y)).toEqual({ x: 2, y: 2, z: 0 });
      const nav = world.getResource(NavGrid)!;
      let checked = 0;
      for (let y = 0; y < nav.height; y++)
        for (let x = 0; x < nav.width; x++) {
          if (nav.blocked[y * nav.width + x]) continue;
          const ndc = new Vector3(x, 0, y).project(adapter.camera);
          expect(adapter.pick(ndc.x, ndc.y)).toEqual({ x, y, z: 0 });
          checked++;
        }
      expect(checked).toBe(10);
      expect(world.snapshot()).toEqual(before);
      visual.dispose();
      expect(assets.stats().modelInstances).toBe(0);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('does not squash authored tall trigger props into the floor-pad bounds', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'security-switch' },
          fit: 'authored',
          visual: { kind: 'model', mesh: 'rig' },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      adapter.mount(world);
      const visual = adapter.presentation!.entity('security-switch')!;
      const pad = adapter.scene.getObjectByName(
        `trigger:${entityNamed(world, 'security-switch')}`,
      ) as Mesh;
      expect(pad.position.toArray()).toEqual([1, 0.06, 3]);
      expect(pad.scale.toArray()).toEqual([0.8, 0.12, 0.8]);
      expect(visual.root.position.toArray()).toEqual([1, 0, 3]);
      expect(new Box3().setFromObject(visual.root).getSize(new Vector3()).y).toBeCloseTo(1.35);
      expect(modelPart(adapter.presentation!, 'security-switch').position.y).toBeCloseTo(1.1);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('retains every passable-cell and guard-body click with replacement actors and an actual ray-occluding decoration', async () => {
    const manifest = runtimeManifest({
      entities: [{ target: { role: 'enemy' }, visual: { kind: 'model', mesh: 'rig' } }],
      objects: [
        {
          id: 'occluder',
          anchor: 'camera',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { position: [0, 0, -2], scale: [100, 100, 0.1] },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      adapter.mount(world);
      adapter.scene.updateMatrixWorld(true);
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(0, 0), adapter.camera);
      expect(
        ray.intersectObject(adapter.presentation!.object('occluder')!.root, true).length,
      ).toBeGreaterThan(0);
      const nav = world.getResource(NavGrid)!;
      let checked = 0;
      for (let y = 0; y < nav.height; y++)
        for (let x = 0; x < nav.width; x++) {
          if (nav.blocked[y * nav.width + x]) continue;
          const ndc = new Vector3(x, 0, y).project(adapter.camera);
          expect(adapter.pick(ndc.x, ndc.y)).toEqual({ x, y, z: 0 });
          checked++;
        }
      expect(checked).toBe(10);
      const guard = world.getOrThrow(entityNamed(world, 'guard'), GridPosition);
      for (const height of [0.2, 0.55, 1.05]) {
        const ndc = new Vector3(guard.cellX, height, guard.cellY).project(adapter.camera);
        expect(adapter.pick(ndc.x, ndc.y)).toEqual({ x: 4, y: 3, z: 0 });
      }
      const wall = adapter.scene.getObjectByName('wall:2:2') as Mesh;
      expect(wall.position.y + wall.scale.y / 2).toBeLessThan(0.5);
      expect(wall.position.y + wall.scale.y / 2).toBeGreaterThan(0.2);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('uses interpolated feet anchors and keeps a door animation instance when Blocking is removed', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'operative' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
        { target: { name: 'vault-door' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
      ],
      effects: [
        {
          event: 'unseal',
          kind: 'clip',
          target: { entity: 'vault-door' },
          durationTicks: 30,
          clip: 'lift',
          holdLast: true,
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const operative = entityNamed(world, 'operative');
      world.add(operative, MoveOrder, {
        target: { x: 1, y: 3 },
        path: [{ x: 1, y: 2 }],
        resolved: true,
      });
      world.getOrThrow(operative, GridPosition).progress = 0.5;
      adapter.mount(world);
      const runtime = adapter.presentation!;
      expect(runtime.entity('operative')!.root.position.toArray()).toEqual([1, 0, 1.5]);
      const door = runtime.entity('vault-door')!.object;
      runtime.present(presentationFrame(0, { events: [{ type: 'unseal', tick: 0, sequence: 0 }] }));
      runtime.present(presentationFrame(30));
      expect(modelPart(runtime, 'vault-door').position.y).toBeCloseTo(2.1);
      world.remove(entityNamed(world, 'vault-door'), Blocking);
      adapter.sync(world);
      runtime.present(presentationFrame(31));
      expect(runtime.entity('vault-door')!.object).toBe(door);
      expect(modelPart(runtime, 'vault-door').position.y).toBeCloseTo(2.1);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });
});

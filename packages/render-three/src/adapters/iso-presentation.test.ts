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
import { Health } from '@aegis/content';
import {
  AttackOrder,
  Blocking,
  GridPosition,
  MoveOrder,
  NavGrid,
  isoPlugin,
} from '@aegis/mode-iso';
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

  it('walks an observed cell-stepped actor without moving its logical click target or advancing on repeated sync', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'guard' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const guard = entityNamed(world, 'guard');
      adapter.mount(world);
      world.restore({ ...world.snapshot(), tick: 19 });
      adapter.sync(world);
      world.getOrThrow(guard, GridPosition).cellX = 3;
      world.restore({ ...world.snapshot(), tick: 20 });
      const before = world.snapshot();
      adapter.sync(world);
      const runtime = adapter.presentation!;
      expect(runtime.entity('guard')!.root.position.toArray()).toEqual([4, 0, 3]);
      expect(runtime.entity('guard')!.state).toBe('move');
      for (let i = 0; i < 4; i++) adapter.sync(world);
      expect(runtime.entity('guard')!.root.position.x).toBe(4);
      const direction = new Vector3(0, 0, 1).applyQuaternion(
        runtime.entity('guard')!.root.quaternion,
      );
      expect(direction.x).toBeCloseTo(-1);
      expect(direction.z).toBeCloseTo(0);
      const ndc = new Vector3(4, 0.55, 3).project(adapter.camera);
      expect(adapter.pick(ndc.x, ndc.y)).toEqual({ x: 3, y: 3, z: 0 });
      expect(world.snapshot()).toEqual(before);

      world.restore({ ...world.snapshot(), tick: 24 });
      adapter.sync(world);
      expect(runtime.entity('guard')!.root.position.toArray()).toEqual([3.5, 0, 3]);
      expect(runtime.entity('guard')!.state).toBe('move');
      world.restore({ ...world.snapshot(), tick: 28 });
      adapter.sync(world);
      expect(runtime.entity('guard')!.root.position.toArray()).toEqual([3, 0, 3]);
      expect(runtime.entity('guard')!.state).toBe('idle');
      adapter.mount(world);
      expect(runtime.entity('guard')!.root.position.toArray()).toEqual([3, 0, 3]);
      expect(assets.stats().modelInstances).toBe(1);
    } finally {
      adapter.dispose();
      expect(assets.stats().modelInstances).toBe(0);
      assets.dispose();
    }
  });

  it('faces the resolved route or current opponent and keeps a path-interpolated actor clickable as itself', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'operative' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
        { target: { name: 'guard' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const operative = entityNamed(world, 'operative');
      const guard = entityNamed(world, 'guard');
      world.add(operative, MoveOrder, {
        target: { x: 2, y: 1 },
        path: [{ x: 2, y: 1 }],
        resolved: true,
      });
      world.getOrThrow(operative, GridPosition).progress = 0.75;
      adapter.mount(world);
      const runtime = adapter.presentation!;
      const actor = runtime.entity('operative')!;
      expect(actor.root.position.toArray()).toEqual([1.75, 0, 1]);
      expect(new Vector3(0, 0, 1).applyQuaternion(actor.root.quaternion).x).toBeCloseTo(1);
      const onBody = new Vector3(1.75, 0.55, 1).project(adapter.camera);
      expect(adapter.pick(onBody.x, onBody.y)).toEqual({ x: 1, y: 1, z: 0 });

      world.remove(operative, MoveOrder);
      world.getOrThrow(operative, GridPosition).progress = 0;
      world.add(guard, AttackOrder, { target: operative, path: [], resolved: true });
      adapter.sync(world);
      const heading = new Vector3(0, 0, 1).applyQuaternion(
        runtime.entity('guard')!.root.quaternion,
      );
      const towardOperative = new Vector3(-3, 0, -2).normalize();
      expect(heading.distanceTo(towardOperative)).toBeLessThan(1e-6);
      world.getOrThrow(guard, Health).current = 0;
      const before = runtime.entity('guard')!.root.quaternion.clone();
      world.getOrThrow(operative, GridPosition).cellX = 4;
      adapter.sync(world);
      expect(runtime.entity('guard')!.state).toBe('dead');
      expect(runtime.entity('guard')!.root.quaternion.equals(before)).toBe(true);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('keeps the health meter left edge camera-aligned and hides it on death', async () => {
    const manifest = runtimeManifest({ surfaces: { enemy: 'red' } });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const guard = entityNamed(world, 'guard');
      adapter.mount(world);
      const group = adapter.scene.getObjectByName(`actor:${guard}`)!;
      const meter = group.getObjectByName('health-meter')!;
      const fill = group.getObjectByName('bar:fill') as Mesh;
      const leftEdge = () => {
        adapter.scene.updateMatrixWorld(true);
        return fill.localToWorld(new Vector3(-0.5, 0, 0)).project(adapter.camera);
      };
      const fullLeft = leftEdge();
      world.getOrThrow(guard, Health).current = 5;
      adapter.sync(world);
      expect(meter.quaternion.equals(adapter.camera.quaternion)).toBe(true);
      expect(fill.material).toBe(assets.material('red'));
      expect(fill.scale.x).toBeCloseTo(0.175);
      expect(leftEdge().distanceTo(fullLeft)).toBeLessThan(1e-6);
      world.getOrThrow(guard, Health).current = 0;
      adapter.sync(world);
      expect(meter.visible).toBe(false);
      expect(fill.visible).toBe(false);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('does not animate a teleport through intervening walls or retain stale patrol positions after rewind', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'guard' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const initial = world.snapshot();
      const guard = entityNamed(world, 'guard');
      adapter.mount(world);
      world.getOrThrow(guard, GridPosition).cellX = 1;
      world.restore({ ...world.snapshot(), tick: 40 });
      adapter.sync(world);
      expect(adapter.presentation!.entity('guard')!.root.position.toArray()).toEqual([1, 0, 3]);
      expect(adapter.presentation!.entity('guard')!.state).toBe('idle');
      world.restore(initial);
      adapter.sync(world);
      expect(adapter.presentation!.entity('guard')!.root.position.toArray()).toEqual([4, 0, 3]);
      expect(adapter.presentation!.entity('guard')!.state).toBe('idle');
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('snaps a stale observed patrol step instead of drawing a false actor over the script destination', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'guard' }, fit: 'authored', visual: { kind: 'model', mesh: 'rig' } },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const guard = entityNamed(world, 'guard');
      world.getOrThrow(guard, GridPosition).cellX = 1;
      adapter.mount(world);
      world.getOrThrow(guard, GridPosition).cellX = 2;
      world.restore({ ...world.snapshot(), tick: 40 });
      adapter.sync(world);
      expect(adapter.presentation!.entity('guard')!.root.position.toArray()).toEqual([2, 0, 3]);
      const destination = new Vector3(1, 0, 3).project(adapter.camera);
      expect(adapter.pick(destination.x, destination.y)).toEqual({ x: 1, y: 3, z: 0 });
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('fits the static level and rear architecture at narrow aspects without changing the authoritative camera', async () => {
    const manifest = runtimeManifest({
      camera: { framing: 'level' },
      objects: [
        {
          id: 'rear-equipment',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { position: [2, 2, -0.6], scale: [6, 4, 0.4] },
        },
      ],
    });
    const assets = await runtimeAssets(manifest);
    const adapter = createIsoAdapter({ presentation: { manifest, assets } });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      const before = world.snapshot();
      adapter.mount(world);
      const focus = adapter.camera.position.clone();
      const height = adapter.camera.top - adapter.camera.bottom;
      // Omitted padding means a literal 0.75 world-unit margin on each side.
      const noPadding = createIsoAdapter({
        presentation: {
          manifest: { ...manifest, camera: { framing: 'level', padding: 0 } },
          assets,
        },
      });
      try {
        noPadding.mount(world);
        expect(height - (noPadding.camera.top - noPadding.camera.bottom)).toBeCloseTo(1.5);
      } finally {
        noPadding.dispose();
      }
      for (const [width, viewportHeight] of [
        [1280, 800],
        [390, 844],
      ]) {
        adapter.resize(width!, viewportHeight!);
        adapter.sync(world);
        const nav = world.getResource(NavGrid)!;
        for (let y = 0; y < nav.height; y++)
          for (let x = 0; x < nav.width; x++) {
            const point = new Vector3(x, 0, y).project(adapter.camera);
            expect(Math.abs(point.x)).toBeLessThan(1);
            expect(Math.abs(point.y)).toBeLessThan(1);
          }
        for (const x of [-1, 5])
          for (const y of [0, 4])
            for (const z of [-0.8, -0.4]) {
              const point = new Vector3(x, y, z).project(adapter.camera);
              expect(Math.abs(point.x)).toBeLessThan(1);
              expect(Math.abs(point.y)).toBeLessThan(1);
            }
      }
      world.getOrThrow(entityNamed(world, 'operative'), GridPosition).cellX = 4;
      adapter.sync(world);
      expect(adapter.camera.position.toArray()).toEqual(focus.toArray());
      world.restore(before);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
      assets.dispose();
    }
  });

  it('keeps explicit follow behavior unchanged and rejects invalid overview extents', async () => {
    const manifest = runtimeManifest({ camera: { framing: 'follow' } });
    const assets = await runtimeAssets(manifest);
    const follow = createIsoAdapter({ presentation: { manifest, assets } });
    const legacy = createIsoAdapter();
    const invalid = createIsoAdapter({
      aspect: NaN,
      presentation: {
        manifest: { ...manifest, camera: { framing: 'level' } },
        assets,
      },
    });
    try {
      const world = buildTestWorld(ISO_SCENE, isoPlugin);
      follow.mount(world);
      legacy.mount(world);
      expect(follow.camera.position.toArray()).toEqual(legacy.camera.position.toArray());
      expect(follow.camera.projectionMatrix.elements).toEqual(
        legacy.camera.projectionMatrix.elements,
      );
      expect(() => invalid.mount(world)).toThrow(/finite bounds.*positive viewport aspect/);
    } finally {
      follow.dispose();
      legacy.dispose();
      invalid.dispose();
      assets.dispose();
    }
  });
});

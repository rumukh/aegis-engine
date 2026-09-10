import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Box3,
  Bone,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  SkinnedMesh,
  Skeleton,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { createSimulation, DiagnosticError, Transform } from '@aegis/core';
import type { World } from '@aegis/core';
import { Health, Light, Model, Sprite } from '@aegis/content';
import type { PrefabFile, SceneFile } from '@aegis/content';
import { parseInputScript } from '@aegis/harness';
import type { ModePlugin } from '@aegis/harness';
import { BodyState, Velocity, platformerPlugin } from '@aegis/mode-platformer';
import { GridPosition, MoveOrder, isoPlugin } from '@aegis/mode-iso';
import { CapsuleBody, fpsPlugin } from '@aegis/mode-fps';
import { createRenderAdapter } from '../adapters/index.js';
import type { RenderAdapter } from '../adapter.js';
import { FPS_SCENE, ISO_SCENE, PLATFORMER_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';
import type { PresentationAssets } from './assets.js';
import type { PresentationEffect, PresentationRuntime } from './runtime.js';
import type { PresentationManifest } from './schema.js';
import {
  entityNamed,
  modelPart,
  presentationFrame as frame,
  runtimeAssets,
  runtimeManifest,
} from './runtime-test-utils.js';

const owned: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(resource: T): T {
  owned.push(resource);
  return resource;
}
afterEach(() => {
  for (const resource of owned.reverse()) resource.dispose();
  owned.length = 0;
});

function presentation(adapter: RenderAdapter): PresentationRuntime {
  if (adapter.presentation === undefined)
    throw new Error('Presentation runtime was not installed.');
  return adapter.presentation;
}

function spriteMesh(runtime: PresentationRuntime, name: string): Mesh {
  const object = runtime.entity(name)?.object;
  if (!(object instanceof Mesh)) throw new Error('Sprite was not instantiated as mesh geometry.');
  return object;
}

function namedSpriteManifest(): PresentationManifest {
  return runtimeManifest({
    assets: runtimeManifest().assets?.map((asset) =>
      asset.kind !== 'texture'
        ? asset
        : {
            ...asset,
            frames: {
              'default-pose': [0, 0, 0.125, 1],
              quiet: [0.125, 0, 0.25, 1],
              q7: [0.25, 0, 0.375, 1],
              'shape-B': [0.375, 0, 0.5, 1],
              'touch-down': [0.5, 0, 0.625, 1],
              settled: [0.625, 0, 0.75, 1],
            },
          },
    ),
    entities: [
      {
        target: { name: 'player' },
        visual: {
          kind: 'sprite',
          texture: 'surface',
          frame: 'default-pose',
          animations: {
            idle: { frames: ['quiet'], frameTicks: 4 },
            move: { frames: ['q7', 'shape-B'], frameTicks: 4 },
          },
        },
      },
    ],
    effects: [
      {
        event: 'land',
        kind: 'frames',
        target: { entity: 'player' },
        frames: ['touch-down', 'settled'],
        frameTicks: 3,
        durationTicks: 6,
      },
      {
        event: 'win',
        kind: 'frames',
        target: { entity: 'player' },
        frames: ['quiet', 'settled'],
        frameTicks: 3,
        durationTicks: 6,
        holdLast: true,
      },
    ],
  });
}

const cases: { scene: SceneFile; plugin: ModePlugin; actor: string; size: number[] }[] = [
  { scene: PLATFORMER_SCENE, plugin: platformerPlugin, actor: 'player', size: [0.8, 1, 0.8] },
  { scene: ISO_SCENE, plugin: isoPlugin, actor: 'operative', size: [0.5, 1.1, 0.5] },
  { scene: FPS_SCENE, plugin: fpsPlugin, actor: 'grunt', size: [0.8, 2, 1] },
];

describe('initialized-world rendering', () => {
  it.each(['platformer', 'fps'] as const)(
    'rejects unsupported camera overrides rather than ignoring them in %s',
    async (mode) => {
      const manifest = runtimeManifest({ camera: { framing: 'level', padding: 1 } });
      const assets = own(await runtimeAssets(manifest));
      expect(() => createRenderAdapter(mode, { presentation: { manifest, assets } })).toThrow(
        /camera framing overrides are supported only in isometric mode/,
      );
    },
  );

  it('renders real expanded prefab children without repeating bootstrap', async () => {
    const prefab: PrefabFile = {
      aegis: 'prefab/1',
      name: 'assembly',
      components: { Transform: { position: { x: 20, y: 0, z: 0 } } },
      children: [
        {
          id: 'child',
          components: {
            Transform: { position: { x: 1, y: 2.5, z: 0 } },
            TileCollider: { halfWidth: 0.4, halfHeight: 0.5 },
            Health: { current: 1, max: 1 },
          },
        },
        { id: 'hud', components: { Health: { current: 3, max: 3 } } },
      ],
    };
    const init = vi.fn((world: World) => platformerPlugin.init?.(world));
    const plugin: ModePlugin = { ...platformerPlugin, prefabs: () => [prefab], init };
    const scene: SceneFile = {
      ...PLATFORMER_SCENE,
      entities: [...PLATFORMER_SCENE.entities, { id: 'rig', prefab: 'assembly' }],
    };
    const manifest = runtimeManifest({
      entities: [{ target: { name: 'rig/child' }, visual: { kind: 'model', mesh: 'rig' } }],
      hud: { playerName: 'rig/hud', winEvent: 'win', loseEvents: ['lose'] },
      objects: [
        {
          id: 'badge',
          visual: { kind: 'primitive', shape: 'box' },
          anchor: { entity: 'rig/child' },
        },
      ],
      effects: [
        {
          event: 'impact',
          kind: 'burst',
          target: { entity: 'rig/child' },
          durationTicks: 10,
          count: 1,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(scene, plugin);
    const before = world.snapshot();
    expect(scene.entities.map((entity) => entity.id)).not.toContain('rig/child');
    expect(world.get(entityNamed(world, 'rig/hud'), Transform)).toBeUndefined();
    expect(init).toHaveBeenCalledTimes(1);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    expect(runtime.entity('rig/child')).toBeDefined();
    expect(runtime.object('badge')!.root.position.x).toBe(21);
    runtime.present(frame(0, { events: [{ type: 'impact', tick: 0, sequence: 0 }] }));
    expect(runtime.stats().effects.active).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(world.snapshot()).toEqual(before);
  });

  it('allows despawned entities during sync/remount without duplicating the host Name gate', async () => {
    const manifest = runtimeManifest({
      entities: [{ target: { name: 'player' }, visual: { kind: 'primitive', shape: 'box' } }],
      hud: { playerName: 'player', winEvent: 'win', loseEvents: ['lose'] },
      objects: [
        {
          id: 'badge',
          visual: { kind: 'primitive', shape: 'box' },
          anchor: { entity: 'player' },
        },
      ],
      effects: [
        {
          event: 'impact',
          kind: 'burst',
          target: { entity: 'player' },
          durationTicks: 10,
          count: 3,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    world.despawn(entityNamed(world, 'player'));
    const before = world.snapshot();
    expect(() => adapter.sync(world)).not.toThrow();
    const runtime = presentation(adapter);
    runtime.present(frame(1, { events: [{ type: 'impact', tick: 1, sequence: 0 }] }));
    expect(runtime.stats().effects.active).toBe(0);
    expect(runtime.stats().dropped).toBe(3);
    expect(runtime.object('badge')!.root.visible).toBe(false);
    expect(world.snapshot()).toEqual(before);
    expect(() => adapter.mount(world)).not.toThrow();
  });
});

describe('asset-backed presentation geometry', () => {
  for (const { scene, plugin, actor, size } of cases)
    it(`${plugin.mode}: replaces real body geometry/maps and fits existing bounds without writing the world`, async () => {
      const manifest = runtimeManifest({
        entities: [
          {
            target: { name: actor },
            visual: { kind: 'model', mesh: 'rig', material: 'striped', clip: 'spin' },
          },
        ],
        surfaces: { wall: 'striped', floor: 'striped' },
      });
      const assets = own(await runtimeAssets(manifest));
      const world = buildTestWorld(scene, plugin);
      const before = world.snapshot();
      const adapter = own(createRenderAdapter(plugin.mode, { presentation: { manifest, assets } }));
      adapter.mount(world);
      const runtime = presentation(adapter);
      expect(runtime.stats().legacy).toMatchObject({
        level: true,
        triggers: true,
        debugGeometry: false,
        levelVisible: true,
      });
      const entity = runtime.entity(actor);
      expect(entity).toBeDefined();
      const body = modelPart(runtime, actor, 'body');
      expect(body.geometry.getAttribute('position').count).toBe(12);
      expect((body.material as MeshBasicMaterial).map).toBe(assets.texture('surface'));
      const actual = new Box3().setFromObject(entity!.root).getSize(new Vector3()).toArray();
      actual.forEach((value, i) => expect(value).toBeCloseTo(size[i]!));
      runtime.present(frame(30));
      expect(modelPart(runtime, actor).quaternion.z).toBeCloseTo(Math.SQRT1_2, 5);
      for (let i = 0; i < 4; i++) adapter.sync(world);
      expect(modelPart(runtime, actor).quaternion.z).toBeCloseTo(Math.SQRT1_2, 5);
      expect(world.snapshot()).toEqual(before);
      const level = adapter.scene.getObjectByName('level');
      const wall = level?.children.find((node) =>
        node.name.startsWith(plugin.mode === 'platformer' ? 'tile:' : 'wall:'),
      );
      expect(wall).toBeInstanceOf(Mesh);
      expect((wall as Mesh).material).toBe(assets.material('striped'));
      const wallPosition = wall!.position.toArray();
      const wallScale = wall!.scale.toArray();
      const camera = adapter.camera.matrixWorld.toArray();
      const picked = adapter.pick(0, 0);
      runtime.setDebugGeometry(true);
      adapter.sync(world);
      expect(runtime.stats().legacy.visibleMeshes).toBe(runtime.stats().legacy.retainedMeshes);
      expect(adapter.pick(0, 0)).toEqual(picked);
      runtime.setDebugGeometry(false);
      expect(wall!.position.toArray()).toEqual(wallPosition);
      expect(wall!.scale.toArray()).toEqual(wallScale);
      expect(adapter.camera.matrixWorld.toArray()).toEqual(camera);
      expect(world.snapshot()).toEqual(before);
    });

  it('updates sprite visibility/tint/order/atlas frames during sync and reuses material and map variants', async () => {
    const manifest = runtimeManifest();
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Sprite, { texture: 'surface', frame: 'left', tint: '#ffffff', z: 3 });
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const mesh = spriteMesh(runtime, 'player');
    expect(mesh.geometry.type).toBe('PlaneGeometry');
    const left = mesh.material;
    expect((left as MeshBasicMaterial).map).toBe(assets.texture('surface', 'left'));
    const sprite = world.getOrThrow(player, Sprite);
    sprite.frame = 'right';
    sprite.tint = '#80ff00cc';
    sprite.visible = false;
    sprite.z = 11;
    adapter.sync(world);
    const right = mesh.material as MeshBasicMaterial;
    expect(right.map).toBe(assets.texture('surface', 'right'));
    expect(right.color.getHexString()).toBe('80ff00');
    expect(right.opacity).toBeCloseTo(0.8);
    expect(mesh.renderOrder).toBe(11);
    expect(runtime.entity('player')?.root.visible).toBe(false);
    sprite.frame = 'left';
    sprite.tint = '#ffffff';
    adapter.sync(world);
    sprite.frame = 'right';
    sprite.tint = '#80ff00cc';
    adapter.sync(world);
    const textures = assets.stats().textures;
    const materials = runtime.stats().resources.runtimeMaterials;
    for (let tick = 0; tick < 100; tick++) {
      sprite.frame = tick % 2 === 0 ? 'left' : 'right';
      sprite.tint = tick % 2 === 0 ? '#ffffff' : '#80ff00cc';
      adapter.sync(world);
      runtime.present(frame(tick));
      expect(mesh.material).toBe(tick % 2 === 0 ? left : right);
    }
    expect(assets.stats().textures).toBe(textures);
    expect(runtime.stats().resources.runtimeMaterials).toBe(materials);
  });

  it('honors dynamic Model.material/visibility/shadow hints without mutating a sibling material', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { role: 'player' }, visual: { kind: 'model', mesh: 'rig' } },
        { target: { role: 'enemy' }, visual: { kind: 'model', mesh: 'rig' } },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Model, { mesh: '', material: 'striped', visible: true });
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const body = modelPart(runtime, 'player', 'body');
    const other = modelPart(runtime, 'critter', 'body');
    const original = other.material;
    expect((body.material as MeshBasicMaterial).map).toBe(assets.texture('surface'));
    const model = world.getOrThrow(player, Model);
    model.material = 'red';
    model.visible = false;
    model.castShadow = true;
    adapter.sync(world);
    expect(body.material).toBe(assets.material('red'));
    expect(body.castShadow).toBe(true);
    expect(runtime.entity('player')?.root.visible).toBe(false);
    expect(other.material).toBe(original);
    expect(body.geometry).toBe(other.geometry);
    model.material = 'missing';
    expect(() => adapter.sync(world)).toThrow(/Unknown material "missing"/);
  });

  it.each(['left', 'old-idle'])(
    'uses an explicit replacement frame instead of the previous atlas frame %s',
    async (oldFrame) => {
      const manifest = runtimeManifest({
        entities: [
          {
            target: { name: 'player' },
            visual: { kind: 'sprite', texture: 'surface', frame: 'right' },
          },
        ],
      });
      const assets = own(await runtimeAssets(manifest));
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      const player = entityNamed(world, 'player');
      world.add(player, Sprite, { texture: 'old-atlas', frame: oldFrame, z: 7 });
      const before = world.snapshot();
      const adapter = own(
        createRenderAdapter('platformer', { presentation: { manifest, assets } }),
      );
      adapter.mount(world);
      const runtime = presentation(adapter);
      const mesh = spriteMesh(runtime, 'player');
      expect((mesh.material as MeshBasicMaterial).map).toBe(assets.texture('surface', 'right'));
      runtime.present(frame(0));
      adapter.sync(world);
      runtime.present(frame(10));
      expect((mesh.material as MeshBasicMaterial).map).toBe(assets.texture('surface', 'right'));
      expect(mesh.renderOrder).toBe(7);
      expect(world.snapshot()).toEqual(before);
    },
  );

  it('does not apply an old atlas frame when the replacement omits a frame', async () => {
    const manifest = runtimeManifest({
      entities: [{ target: { name: 'player' }, visual: { kind: 'sprite', texture: 'surface' } }],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Sprite, { texture: 'old-atlas', frame: 'old-idle' });
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    runtime.present(frame(0));
    expect((spriteMesh(runtime, 'player').material as MeshBasicMaterial).map).toBe(
      assets.texture('surface'),
    );
    const sprite = world.getOrThrow(player, Sprite);
    sprite.texture = 'surface';
    for (const [tick, selected] of ['left', 'right'].entries()) {
      sprite.frame = selected;
      adapter.sync(world);
      runtime.present(frame(tick + 1));
      expect((spriteMesh(runtime, 'player').material as MeshBasicMaterial).map).toBe(
        assets.texture('surface', selected),
      );
    }
  });

  it('uses named bindings, then nonempty components, then role bindings, without asset-id fallbacks', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { role: 'player' },
          visual: { kind: 'primitive', shape: 'box', material: 'red' },
        },
        { target: { name: 'critter' }, visual: { kind: 'model', mesh: 'rig' } },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Sprite, { texture: 'surface' });
    world.add(entityNamed(world, 'critter'), Sprite, { texture: 'surface' });
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    expect(spriteMesh(runtime, 'player').geometry.type).toBe('PlaneGeometry');
    expect(modelPart(runtime, 'critter', 'body').geometry.getAttribute('position').count).toBe(12);
    world.getOrThrow(player, Sprite).texture = 'missing';
    expect(() => adapter.sync(world)).toThrow(/Unknown texture "missing"/);
    world.remove(player, Sprite);
    world.add(player, Model, { mesh: 'missing' });
    expect(() => adapter.sync(world)).toThrow(/Unknown model "missing"/);
  });
});

describe('tick-derived motion and state-linked animation', () => {
  it('selects model clips from every inferred generic state without a transition graph', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: {
            kind: 'model',
            mesh: 'rig',
            animations: { idle: 'spin', move: 'lift', rise: 'spin', fall: 'lift', dead: 'spin' },
          },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    const body = world.getOrThrow(player, BodyState);
    const velocity = world.getOrThrow(player, Velocity);
    const health = world.getOrThrow(player, Health);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const fin = modelPart(runtime, 'player');
    const steps = [
      { state: 'idle', grounded: true, dx: 0, dy: 0, hp: 1, spin: true },
      { state: 'move', grounded: true, dx: 2, dy: 0, hp: 1, spin: false },
      { state: 'rise', grounded: false, dx: 2, dy: 3, hp: 1, spin: true },
      { state: 'fall', grounded: false, dx: 2, dy: -3, hp: 1, spin: false },
      { state: 'dead', grounded: false, dx: 2, dy: -3, hp: 0, spin: true },
    ];
    for (const [i, step] of steps.entries()) {
      body.grounded = step.grounded;
      velocity.dx = step.dx;
      velocity.dy = step.dy;
      health.current = step.hp;
      adapter.sync(world);
      runtime.present(frame(i * 90));
      runtime.present(frame(i * 90 + 30));
      expect(runtime.entity('player')!.state).toBe(step.state);
      expect(fin.quaternion.z).toBeCloseTo(step.spin ? Math.SQRT1_2 : 0);
      expect(fin.position.y).toBeCloseTo(step.spin ? 1.1 : 1.6);
    }
  });

  it('falls back to the authored model clip, not an unrelated idle mapping, for an unmapped state', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'model', mesh: 'rig', clip: 'lift', animations: { idle: 'spin' } },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.getOrThrow(player, BodyState).grounded = true;
    world.getOrThrow(player, Velocity).dx = 2;
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    runtime.present(frame(30));
    expect(runtime.entity('player')!.state).toBe('move');
    expect(modelPart(runtime, 'player').position.y).toBeCloseTo(1.6);
    expect(modelPart(runtime, 'player').quaternion.z).toBeCloseTo(0);
  });

  it('samples bob/spin/pulse, follows world/entity/camera anchors, and preserves pause through extra syncs', async () => {
    const manifest = runtimeManifest({
      objects: [
        {
          id: 'bob',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { position: [0, 4, 0] },
          motion: { kind: 'bob', axis: 'y', amplitude: 2, periodTicks: 120 },
        },
        {
          id: 'spin',
          visual: { kind: 'primitive', shape: 'box' },
          motion: { kind: 'spin', axis: 'y', amplitude: 360, periodTicks: 120 },
        },
        {
          id: 'pulse',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { scale: [1, 1, 2] },
          motion: { kind: 'pulse', axis: 'z', amplitude: 0.25, periodTicks: 120 },
        },
        {
          id: 'background',
          visual: { kind: 'primitive', shape: 'plane' },
          pose: { position: [2, 3, -8] },
          parallax: 0.25,
        },
        {
          id: 'attachment',
          visual: { kind: 'primitive', shape: 'box' },
          anchor: { entity: 'player' },
          pose: { position: [0, 2, 0] },
        },
        {
          id: 'view',
          visual: { kind: 'primitive', shape: 'box' },
          anchor: 'camera',
          pose: { position: [0.2, -0.2, -2] },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const pose = (id: string) => runtime.object(id)!.root.getObjectByName('presentation:pose')!;
    runtime.present(frame(0));
    runtime.present(frame(30));
    expect(pose('bob').position.y).toBeCloseTo(6);
    expect(pose('spin').rotation.y).toBeCloseTo(Math.PI / 2);
    expect(pose('pulse').scale.z).toBeCloseTo(2.5);
    const oldCamera = adapter.camera.position.clone();
    world.getOrThrow(entityNamed(world, 'camera'), Transform).position.x += 4;
    world.getOrThrow(entityNamed(world, 'player'), Transform).position.x += 3;
    adapter.sync(world);
    expect(pose('bob').position.y).toBeCloseTo(6);
    expect(runtime.object('background')!.root.position.x).toBeCloseTo(1);
    expect(pose('background').position.x).toBe(2);
    expect(runtime.object('attachment')!.root.position.x).toBeCloseTo(4.5);
    expect(runtime.object('view')!.root.position.x).toBeCloseTo(oldCamera.x + 4);
    expect(runtime.object('view')!.root.quaternion.toArray()).toEqual(
      adapter.camera.quaternion.toArray(),
    );
    runtime.present(frame(90, { paused: true }));
    expect(pose('bob').position.y).toBeCloseTo(6);
    runtime.present(frame(90));
    expect(pose('bob').position.y).toBeCloseTo(2);
    adapter.resetPresentation?.();
    expect(pose('bob').position.y).toBe(4);
    expect(pose('spin').rotation.y).toBe(0);
    expect(pose('pulse').scale.z).toBe(2);
  });

  it('selects real sprite frames from inferred movement/air/death state and the extension override', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: {
            kind: 'sprite',
            texture: 'surface',
            animations: {
              idle: { frames: ['left'], frameTicks: 5 },
              move: { frames: ['right', 'left'], frameTicks: 5 },
              rise: { frames: ['left'], frameTicks: 5 },
              fall: { frames: ['right'], frameTicks: 5 },
              dead: { frames: ['right'], frameTicks: 5 },
            },
          },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    const body = world.getOrThrow(player, BodyState);
    body.grounded = true;
    const velocity = world.getOrThrow(player, Velocity);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const map = () => (spriteMesh(runtime, 'player').material as MeshBasicMaterial).map;
    runtime.present(frame(0));
    expect(map()).toBe(assets.texture('surface', 'left'));
    velocity.dx = 2;
    adapter.sync(world);
    runtime.present(frame(5));
    expect(map()).toBe(assets.texture('surface', 'right'));
    for (let i = 0; i < 5; i++) adapter.sync(world);
    expect(map()).toBe(assets.texture('surface', 'right'));
    runtime.present(frame(10));
    expect(map()).toBe(assets.texture('surface', 'left'));
    body.grounded = false;
    velocity.dy = 4;
    adapter.sync(world);
    runtime.present(frame(11));
    expect(runtime.entity('player')?.state).toBe('rise');
    expect(map()).toBe(assets.texture('surface', 'left'));
    velocity.dy = -4;
    adapter.sync(world);
    runtime.present(frame(12));
    expect(runtime.entity('player')?.state).toBe('fall');
    expect(map()).toBe(assets.texture('surface', 'right'));
    world.getOrThrow(player, Health).current = 0;
    adapter.sync(world);
    runtime.present(frame(13));
    expect(runtime.entity('player')?.state).toBe('dead');
    runtime.setEntityState('player', 'idle');
    runtime.present(frame(14));
    expect(map()).toBe(assets.texture('surface', 'left'));
    runtime.present(frame(0, { generation: 1 }));
    expect(runtime.entity('player')?.state).toBe('dead');
    expect(map()).toBe(assets.texture('surface', 'right'));
  });

  it('samples named model clips by tickRate and switches actual node poses on movement state', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'model', mesh: 'rig', animations: { idle: 'spin', move: 'lift' } },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.getOrThrow(player, BodyState).grounded = true;
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const fin = modelPart(runtime, 'player');
    runtime.present(frame(60, { tickRate: 120 }));
    expect(fin.quaternion.z).toBeCloseTo(Math.SQRT1_2);
    world.getOrThrow(player, Velocity).dx = 2;
    adapter.sync(world);
    runtime.present(frame(61));
    expect(fin.position.y).toBeCloseTo(1.1);
    runtime.present(frame(91));
    expect(fin.position.y).toBeCloseTo(1.6);
    adapter.sync(world);
    expect(fin.position.y).toBeCloseTo(1.6);
    runtime.setEntityState('player', 'idle');
    runtime.present(frame(92));
    expect(fin.position.y).toBeCloseTo(1.1);
    expect(fin.quaternion.z).toBeCloseTo(0);
  });
});

describe('data-owned sprite sequence names', () => {
  it('warms every state/event map and uses the explicit binding frame for unmapped states', async () => {
    const manifest = namedSpriteManifest();
    const assets = own(await runtimeAssets(manifest));
    const clone = vi.spyOn(assets.texture('surface'), 'clone');
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Sprite, { texture: '', frame: 'default-pose' });
    world.getOrThrow(player, BodyState).grounded = true;
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const map = () => (spriteMesh(runtime, 'player').material as MeshBasicMaterial).map;
    expect(clone).toHaveBeenCalledTimes(6);
    expect(assets.stats().textures).toBe(7);
    const materials = runtime.stats().resources.runtimeMaterials;
    runtime.present(frame(0));
    expect(map()).toBe(assets.texture('surface', 'quiet'));
    world.getOrThrow(player, Velocity).dx = 2;
    adapter.sync(world);
    runtime.present(frame(10));
    expect(map()).toBe(assets.texture('surface', 'q7'));
    runtime.present(frame(14));
    expect(map()).toBe(assets.texture('surface', 'shape-B'));
    world.getOrThrow(player, Sprite).frame = 'settled';
    adapter.sync(world);
    expect(map()).toBe(assets.texture('surface', 'shape-B'));
    world.getOrThrow(player, BodyState).grounded = false;
    world.getOrThrow(player, Velocity).dy = -2;
    adapter.sync(world);
    runtime.present(frame(15));
    expect(runtime.entity('player')!.state).toBe('fall');
    expect(map()).toBe(assets.texture('surface', 'default-pose'));
    delete world.getOrThrow(player, Sprite).frame;
    adapter.sync(world);
    runtime.present(frame(16));
    expect(map()).toBe(assets.texture('surface', 'default-pose'));
    expect(clone).toHaveBeenCalledTimes(6);
    expect(runtime.stats().resources.runtimeMaterials).toBe(materials);
  });

  it('runs composition-owned event frame sequences, resumes state animation, and holds an authored final frame', async () => {
    const manifest = namedSpriteManifest();
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const map = () => (spriteMesh(runtime, 'player').material as MeshBasicMaterial).map;
    const materials = runtime.stats().resources.runtimeMaterials;
    const textures = assets.stats().textures;
    runtime.present(frame(0));
    runtime.present(frame(1, { events: [{ type: 'land', tick: 1, sequence: 0 }] }));
    expect(map()).toBe(assets.texture('surface', 'touch-down'));
    runtime.present(frame(4));
    expect(map()).toBe(assets.texture('surface', 'settled'));
    adapter.sync(world);
    expect(map()).toBe(assets.texture('surface', 'settled'));
    runtime.present(frame(7));
    expect(map()).toBe(assets.texture('surface', 'quiet'));
    expect(runtime.stats().effects.active).toBe(0);
    runtime.present(frame(10, { events: [{ type: 'win', tick: 10, sequence: 1 }] }));
    expect(map()).toBe(assets.texture('surface', 'quiet'));
    runtime.present(frame(13));
    expect(map()).toBe(assets.texture('surface', 'settled'));
    runtime.present(frame(16));
    runtime.present(frame(40));
    expect(map()).toBe(assets.texture('surface', 'settled'));
    expect(runtime.stats().effects.active).toBe(0);
    expect(runtime.stats().resources.runtimeMaterials).toBe(materials);
    expect(assets.stats().textures).toBe(textures);
    runtime.present(frame(0, { generation: 1 }));
    expect(map()).toBe(assets.texture('surface', 'quiet'));
  });

  it('rejects event frames absent from the target atlas and rejects non-sprite targets during mount', async () => {
    const missing = namedSpriteManifest();
    missing.effects = [
      {
        event: 'land',
        kind: 'frames',
        target: { entity: 'player' },
        frames: ['not-an-atlas-member'],
        frameTicks: 2,
        durationTicks: 4,
      },
    ];
    const assets = own(await runtimeAssets(missing));
    const adapter = own(
      createRenderAdapter('platformer', { presentation: { manifest: missing, assets } }),
    );
    expect(() => adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin))).toThrow(
      /Unknown atlas frame "not-an-atlas-member" on "surface"/,
    );
    const model = namedSpriteManifest();
    model.entities = [{ target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig' } }];
    const other = own(
      createRenderAdapter('platformer', { presentation: { manifest: model, assets } }),
    );
    expect(() => other.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin))).toThrow(
      /frames effect requires a sprite/,
    );
  });

  for (const mode of ['iso', 'fps'] as const)
    it(`${mode}: supplies generic movement/death state without asset-name conventions`, async () => {
      const scene = mode === 'iso' ? ISO_SCENE : FPS_SCENE;
      const plugin = mode === 'iso' ? isoPlugin : fpsPlugin;
      const name = mode === 'iso' ? 'operative' : 'player';
      const manifest = runtimeManifest({
        entities: [
          {
            target: { name },
            visual: {
              kind: 'sprite',
              texture: 'surface',
              frame: 'right',
              animations: {
                move: { frames: ['left'], frameTicks: 3 },
                dead: { frames: ['left'], frameTicks: 3 },
              },
            },
          },
        ],
      });
      const assets = own(await runtimeAssets(manifest));
      const world = buildTestWorld(scene, plugin);
      const entity = entityNamed(world, name);
      const adapter = own(createRenderAdapter(mode, { presentation: { manifest, assets } }));
      adapter.mount(world);
      const runtime = presentation(adapter);
      const map = () => (spriteMesh(runtime, name).material as MeshBasicMaterial).map;
      runtime.present(frame(0));
      expect(map()).toBe(assets.texture('surface', 'right'));
      if (mode === 'iso') {
        world.add(entity, MoveOrder, {
          target: { x: 1, y: 3 },
          path: [{ x: 1, y: 2 }],
          resolved: true,
        });
        world.getOrThrow(entity, GridPosition).progress = 0.5;
      } else {
        const capsule = world.getOrThrow(entity, CapsuleBody);
        capsule.grounded = true;
        capsule.velocity.x = 1;
      }
      adapter.sync(world);
      runtime.present(frame(10));
      expect(runtime.entity(name)!.state).toBe('move');
      expect(map()).toBe(assets.texture('surface', 'left'));
      world.getOrThrow(entity, Health).current = 0;
      adapter.sync(world);
      runtime.present(frame(20));
      expect(runtime.entity(name)!.state).toBe('dead');
      expect(map()).toBe(assets.texture('surface', 'left'));
    });
});

describe('named visual nodes', () => {
  function manifestFor(kind: 'entity' | 'object', node = 'probe-socket'): PresentationManifest {
    const target = kind === 'entity' ? { entity: 'grunt' } : { object: 'view-model' };
    return runtimeManifest({
      entities:
        kind === 'entity'
          ? [
              {
                target: { name: 'grunt' },
                visual: { kind: 'model', mesh: 'rig', clip: 'spin' },
                fit: 'authored',
                pose: {
                  position: [0.6, 0.25, 0.4],
                  rotation: [15, 25, 30],
                  scale: [0.8, 0.9, 1.1],
                },
              },
            ]
          : [],
      objects:
        kind === 'object'
          ? [
              {
                id: 'view-model',
                anchor: 'camera',
                visual: { kind: 'model', mesh: 'rig', clip: 'spin' },
                pose: { position: [0.2, -0.3, -2], rotation: [0, 10, 0], scale: [0.5, 0.5, 0.5] },
              },
            ]
          : [],
      effects: [
        {
          event: 'emit',
          kind: kind === 'entity' ? 'pulse' : 'recoil',
          target: { ...target, node: 'fin' },
          amount: 0.3,
          durationTicks: 12,
        },
        { event: 'emit', kind: 'burst', target: { ...target, node }, count: 1, durationTicks: 12 },
      ],
    });
  }

  async function withSocket(manifest: PresentationManifest): Promise<PresentationAssets> {
    return own(
      await runtimeAssets(manifest, (gltf) => {
        const fin = gltf.scene.getObjectByName('fin');
        if (fin === undefined) throw new Error('Fixture fin is absent.');
        const socket = new Group();
        socket.name = 'probe-socket';
        socket.position.set(0.33, 0.44, 0.55);
        fin.add(socket);
      }),
    );
  }

  for (const kind of ['entity', 'object'] as const) {
    it(`${kind}: emits at the actual animated named anchor after same-frame cosmetic feedback`, async () => {
      const manifest = manifestFor(kind);
      const assets = await withSocket(manifest);
      const world = buildTestWorld(FPS_SCENE, fpsPlugin);
      const before = world.snapshot();
      const adapter = own(createRenderAdapter('fps', { presentation: { manifest, assets } }));
      adapter.mount(world);
      const runtime = presentation(adapter);
      const object =
        kind === 'entity' ? runtime.entity('grunt')!.object : runtime.object('view-model')!.object;
      const socket = object.getObjectByName('probe-socket')!;
      const camera = adapter.camera.matrixWorld.toArray();
      const hitbox = adapter.scene.getObjectByName(`hitbox:${entityNamed(world, 'grunt')}`)!;
      const position = hitbox.position.toArray();
      const scale = hitbox.scale.toArray();
      runtime.present(frame(30));
      const withoutFeedback = socket.getWorldPosition(new Vector3());
      runtime.present(frame(30, { events: [{ type: 'emit', tick: 30, sequence: 0 }] }));
      const actualAnchor = socket.getWorldPosition(new Vector3());
      expect(actualAnchor.distanceTo(withoutFeedback)).toBeGreaterThan(0.01);
      const particles = adapter.scene.getObjectByName('presentation:effects')!.children;
      expect(particles).toHaveLength(1);
      const particle = particles[0]!;
      expect(particle.getWorldPosition(new Vector3()).distanceTo(actualAnchor)).toBeLessThan(1e-10);
      adapter.sync(world);
      expect(
        particle.getWorldPosition(new Vector3()).distanceTo(socket.getWorldPosition(new Vector3())),
      ).toBeLessThan(1e-10);
      expect(hitbox.position.toArray()).toEqual(position);
      expect(hitbox.scale.toArray()).toEqual(scale);
      expect(adapter.camera.matrixWorld.toArray()).toEqual(camera);
      expect(world.snapshot()).toEqual(before);
      const emitted = particle.position.clone();
      runtime.present(frame(31));
      expect(particle.position.x).toBeCloseTo(emitted.x + 1.8 / 60, 12);
      expect(particle.position.y).toBeCloseTo(emitted.y + 0.8 / 60 - 1.2 / (60 * 60), 12);
      expect(particle.position.z).toBeCloseTo(emitted.z - 0.35 / 60, 12);
    });

    it(`${kind}: diagnoses an unknown named node before ready, at the authored target field`, async () => {
      const manifest = manifestFor(kind, 'absent-socket');
      const assets = await withSocket(manifest);
      let failure: unknown;
      try {
        const adapter = own(createRenderAdapter('fps', { presentation: { manifest, assets } }));
        adapter.mount(buildTestWorld(FPS_SCENE, fpsPlugin));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DiagnosticError);
      if (!(failure instanceof DiagnosticError)) throw new Error('Missing node was not diagnosed.');
      expect(failure.diagnostics[0]?.location?.path).toBe('effects[1].target.node');
      expect(failure.message).toContain('absent-socket');
      expect(failure.message).toContain('probe-socket');
    });
  }

  it('does not apply an evicted recoil while resolving bounded named-node bursts', async () => {
    const manifest = manifestFor('object');
    manifest.effects![1]!.count = 32;
    const assets = await withSocket(manifest);
    const adapter = own(
      createRenderAdapter('fps', {
        presentation: { manifest, assets, quality: 'low' },
      }),
    );
    adapter.mount(buildTestWorld(FPS_SCENE, fpsPlugin));
    const runtime = presentation(adapter);
    const socket = runtime.object('view-model')!.object.getObjectByName('probe-socket')!;
    runtime.present(frame(0));
    const expected = socket.getWorldPosition(new Vector3());
    runtime.present(frame(0, { events: [{ type: 'emit', tick: 0, sequence: 0 }] }));
    expect(runtime.stats().effects.active).toBe(32);
    expect(runtime.stats().dropped).toBe(1);
    expect(socket.getWorldPosition(new Vector3()).distanceTo(expected)).toBeLessThan(1e-10);
    const particles = adapter.scene.getObjectByName('presentation:effects')!.children;
    expect(particles).toHaveLength(32);
    for (const particle of particles)
      expect(particle.getWorldPosition(new Vector3()).distanceTo(expected)).toBeLessThan(1e-10);
  });
});

describe('generation-aware event feedback', () => {
  it('samples paused world steps without advancing on extra display frames and resets on remount', async () => {
    const manifest = runtimeManifest();
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const simulation = createSimulation({
      world,
      schedule: platformerPlugin.systems(),
      tickRate: 60,
    });
    adapter.mount(world);
    const runtime = presentation(adapter);
    const sampled: number[] = [];
    runtime.addEffect({
      update: (sample) => {
        sampled.push(sample.tick);
      },
      reset: vi.fn(),
      dispose: vi.fn(),
    });

    runtime.present(frame(0, { paused: true }));
    runtime.present(frame(99, { paused: true }));
    simulation.run(6);
    adapter.sync(world);
    expect(sampled).toEqual([0, 0]);
    runtime.present(frame(6, { paused: true }));
    adapter.sync(world);
    runtime.present(frame(99, { paused: true }));
    runtime.present(frame(3, { paused: true }));
    simulation.run(3);
    adapter.sync(world);
    runtime.present(frame(9, { paused: true }));
    expect(sampled).toEqual([0, 0, 6, 6, 6, 9]);

    const nextWorld = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const nextSimulation = createSimulation({
      world: nextWorld,
      schedule: platformerPlugin.systems(),
      tickRate: 60,
    });
    adapter.mount(nextWorld);
    runtime.present(frame(0, { paused: true, generation: 1 }));
    runtime.present(frame(99, { paused: true, generation: 1 }));
    nextSimulation.run(4);
    adapter.sync(nextWorld);
    runtime.present(frame(4, { paused: true, generation: 1 }));
    expect(sampled).toEqual([0, 0, 6, 6, 6, 9, 0, 0, 4]);
  });

  it('preserves two same-type/same-tick occurrences and payloads, deduplicates re-delivery, and rejects old generations', async () => {
    const manifest = runtimeManifest({
      effects: [
        {
          event: 'impact',
          kind: 'burst',
          target: { entity: 'player' },
          durationTicks: 60,
          count: 2,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const extension: PresentationEffect = { update: vi.fn(), reset: vi.fn(), dispose: vi.fn() };
    runtime.addEffect(extension);
    const events = [
      { tick: 5, type: 'impact', sequence: 0, data: { target: 1 } },
      { tick: 5, type: 'impact', sequence: 1, data: { target: 2 } },
    ];
    runtime.present(frame(5, { events }));
    expect(runtime.stats().effects.active).toBe(4);
    const effectGroup = adapter.scene.getObjectByName('presentation:effects')!;
    expect(effectGroup.children).toHaveLength(4);
    expect(effectGroup.children.every((node) => node instanceof Mesh)).toBe(true);
    runtime.present(frame(5, { events }));
    adapter.sync(world);
    expect(runtime.stats().effects.active).toBe(4);
    expect(extension.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ events }));
    expect(extension.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ events: [] }));
    runtime.present(frame(5, { events: [{ tick: 5, type: 'impact', sequence: 2 }] }));
    expect(runtime.stats().effects.active).toBe(6);
    runtime.present(frame(5, { events: [{ tick: 5, type: 'impact', sequence: 4 }] }));
    runtime.present(frame(5, { events: [{ tick: 5, type: 'impact', sequence: 3 }] }));
    runtime.present(frame(5, { events: [{ tick: 5, type: 'impact', sequence: 4 }] }));
    expect(runtime.stats().effects.active).toBe(10);
    runtime.present(
      frame(0, { generation: 1, events: [{ tick: 0, type: 'impact', sequence: 0 }] }),
    );
    expect(runtime.stats().effects.active).toBe(2);
    expect(extension.reset).toHaveBeenCalledTimes(1);
    runtime.present(
      frame(500, { generation: 0, events: [{ tick: 500, type: 'impact', sequence: 100 }] }),
    );
    expect(runtime.stats().effects.active).toBe(2);
    expect(events[0]?.data).toEqual({ target: 1 });
  });

  it('uses occurrence ordinals for legacy unsequenced batches rather than collapsing duplicates', async () => {
    const manifest = runtimeManifest({
      effects: [
        {
          event: 'impact',
          kind: 'burst',
          target: { entity: 'player' },
          durationTicks: 60,
          count: 2,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const runtime = presentation(adapter);
    const events = [
      { tick: 3, type: 'impact' },
      { tick: 3, type: 'impact' },
    ];
    runtime.present(frame(3, { events }));
    runtime.present(frame(3, { events }));
    expect(runtime.stats().effects.active).toBe(4);
    runtime.present(frame(3, { events: [...events, { tick: 3, type: 'impact' }] }));
    expect(runtime.stats().effects.active).toBe(6);
  });

  it('plays one-shot named clips, holds the final node pose, and clears it on restart', async () => {
    const manifest = runtimeManifest({
      entities: [{ target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig' } }],
      effects: [
        {
          event: 'open',
          kind: 'clip',
          target: { entity: 'player' },
          clip: 'lift',
          durationTicks: 60,
          holdLast: true,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const fin = modelPart(runtime, 'player');
    runtime.present(frame(10, { events: [{ type: 'open', tick: 10, sequence: 0 }] }));
    expect(fin.position.y).toBeCloseTo(1.1);
    runtime.present(frame(40));
    expect(fin.position.y).toBeCloseTo(1.6);
    adapter.sync(world);
    expect(fin.position.y).toBeCloseTo(1.6);
    runtime.present(frame(70));
    expect(fin.position.y).toBeCloseTo(2.1);
    expect(runtime.stats().effects.active).toBe(0);
    runtime.present(frame(100));
    expect(fin.position.y).toBeCloseTo(2.1);
    runtime.present(frame(0, { generation: 1 }));
    expect(fin.position.y).toBeCloseTo(1.1);
  });

  it('holds event sprite frames through unrelated sync and releases them on reset', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
        },
      ],
      effects: [
        {
          event: 'finish',
          kind: 'frames',
          target: { entity: 'player' },
          frames: ['left', 'right'],
          frameTicks: 5,
          durationTicks: 10,
          holdLast: true,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const map = () => (spriteMesh(runtime, 'player').material as MeshBasicMaterial).map;
    runtime.present(frame(0, { events: [{ tick: 0, type: 'finish', sequence: 0 }] }));
    runtime.present(frame(5));
    expect(map()).toBe(assets.texture('surface', 'right'));
    adapter.sync(world);
    expect(map()).toBe(assets.texture('surface', 'right'));
    runtime.present(frame(10));
    runtime.present(frame(100));
    expect(map()).toBe(assets.texture('surface', 'right'));
    runtime.reset();
    expect(map()).toBe(assets.texture('surface', 'left'));
  });

  it('pulses only a visual wrapper and private material variants, never the shared asset or mechanical body', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig', material: 'striped' } },
        {
          target: { name: 'critter' },
          visual: { kind: 'model', mesh: 'rig', material: 'striped' },
        },
      ],
      effects: [
        {
          event: 'hit',
          kind: 'pulse',
          target: { entity: 'player' },
          durationTicks: 10,
          color: '#ff0000',
          amount: 0.5,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const body = modelPart(runtime, 'player', 'body');
    const mechanical = adapter.scene.getObjectByName(`actor:${entityNamed(world, 'player')}`)!;
    const originalScale = mechanical.scale.toArray();
    const originalPosition = mechanical.position.toArray();
    runtime.present(
      frame(0, {
        events: [
          { type: 'hit', tick: 0, sequence: 0 },
          { type: 'hit', tick: 0, sequence: 1 },
        ],
      }),
    );
    expect(
      runtime.entity('player')!.root.getObjectByName('presentation:effect')!.scale.x,
    ).toBeCloseTo(2.25);
    expect((body.material as MeshBasicMaterial).color.getHexString()).toBe('ff0000');
    expect((assets.material('striped') as MeshBasicMaterial).color.getHexString()).toBe('ffffff');
    expect(modelPart(runtime, 'critter', 'body').material).toBe(assets.material('striped'));
    adapter.sync(world);
    expect((body.material as MeshBasicMaterial).color.getHexString()).toBe('ff0000');
    world.add(entityNamed(world, 'player'), Model, { mesh: '', material: 'red' });
    adapter.sync(world);
    expect((body.material as MeshBasicMaterial).type).toBe('MeshBasicMaterial');
    expect(body.material).not.toBe(assets.material('red'));
    expect((body.material as MeshBasicMaterial).color.getHexString()).toBe('ff0000');
    runtime.present(frame(10));
    expect(body.material).toBe(assets.material('red'));
    expect(runtime.entity('player')!.root.getObjectByName('presentation:effect')!.scale.x).toBe(1);
    expect(mechanical.scale.toArray()).toEqual(originalScale);
    expect(mechanical.position.toArray()).toEqual(originalPosition);
  });

  it('bounds bursts and registrations at both quality tiers and counts intentional evictions', async () => {
    const manifest = runtimeManifest({
      effects: [
        {
          event: 'impact',
          kind: 'burst',
          target: { entity: 'player' },
          durationTicks: 120,
          count: 128,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const runtime = presentation(adapter);
    runtime.present(frame(0, { events: [{ type: 'impact', tick: 0, sequence: 0 }] }));
    expect(runtime.stats().effects.active).toBe(128);
    expect(runtime.stats().effects.limit).toBe(128);
    runtime.setQuality('low');
    expect(runtime.stats().effects.active).toBe(32);
    expect(runtime.stats().dropped).toBe(96);
    expect(adapter.scene.getObjectByName('presentation:effects')?.children).toHaveLength(32);
    runtime.present(frame(120));
    expect(runtime.stats().effects.active).toBe(0);
    const effects = Array.from({ length: 40 }, () => ({
      update: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }));
    const remove = effects.map((effect) => runtime.addEffect(effect));
    expect(runtime.stats().effects.registered).toBe(32);
    expect(runtime.stats().dropped).toBe(104);
    for (const effect of effects.slice(0, 8)) expect(effect.dispose).toHaveBeenCalledTimes(1);
    for (const dispose of remove) {
      dispose();
      dispose();
    }
    expect(runtime.stats().effects.registered).toBe(0);
    for (const effect of effects) expect(effect.dispose).toHaveBeenCalledTimes(1);
  });

  it('validates missing glTF clips, state clips, and event nodes before an adapter becomes ready', async () => {
    for (const extra of [{ clip: 'absent' }, { animations: { idle: 'absent' } }]) {
      const manifest = runtimeManifest({
        entities: [
          { target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig', ...extra } },
        ],
      });
      const assets = own(await runtimeAssets(manifest));
      const adapter = own(
        createRenderAdapter('platformer', { presentation: { manifest, assets } }),
      );
      expect(() => adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin))).toThrow(
        /Unknown animation clip "absent".*spin, lift/,
      );
      expect(assets.stats().modelInstances).toBe(0);
    }
    const manifest = runtimeManifest({
      entities: [{ target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig' } }],
      effects: [
        {
          event: 'hit',
          kind: 'pulse',
          target: { entity: 'player', node: 'absent' },
          durationTicks: 10,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    expect(() => adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin))).toThrow(
      /Unknown visual node "absent"/,
    );
  });

  it('validates clip tracks below the selected node, with a working named-node control', async () => {
    for (const node of ['body', 'fin']) {
      const manifest = runtimeManifest({
        entities: [{ target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig' } }],
        effects: [
          {
            event: 'open',
            kind: 'clip',
            clip: 'lift',
            durationTicks: 60,
            target: { entity: 'player', node },
          },
        ],
      });
      const assets = own(await runtimeAssets(manifest));
      const adapter = own(
        createRenderAdapter('platformer', { presentation: { manifest, assets } }),
      );
      const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
      if (node === 'body') {
        expect(() => adapter.mount(world)).toThrow(
          /track "fin.position\[y\]" does not resolve below "body"/,
        );
      } else {
        adapter.mount(world);
        const runtime = presentation(adapter);
        runtime.present(frame(0, { events: [{ tick: 0, type: 'open', sequence: 0 }] }));
        runtime.present(frame(30));
        expect(modelPart(runtime, 'player').position.y).toBeCloseTo(1.6);
      }
    }
  });
});

describe('silent persistent-history hydration', () => {
  it('restores only the latest held state, seeds deduplication and never replays transient extension events', async () => {
    const manifest = runtimeManifest({
      objects: [
        { id: 'gate', visual: { kind: 'model', mesh: 'rig' } },
        { id: 'sign', visual: { kind: 'sprite', texture: 'surface', frame: 'left' } },
      ],
      effects: [
        {
          event: 'open',
          kind: 'clip',
          target: { object: 'gate' },
          clip: 'lift',
          durationTicks: 30,
          holdLast: true,
        },
        {
          event: 'mark',
          kind: 'frames',
          target: { object: 'sign' },
          frames: ['right'],
          frameTicks: 1,
          durationTicks: 1,
          holdLast: true,
        },
        {
          event: 'clear',
          kind: 'frames',
          target: { object: 'sign' },
          frames: ['left'],
          frameTicks: 1,
          durationTicks: 1,
          holdLast: true,
        },
        { event: 'spark', kind: 'burst', target: { object: 'gate' }, count: 3, durationTicks: 80 },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const extension = { update: vi.fn(), reset: vi.fn(), dispose: vi.fn() };
    runtime.addEffect(extension);
    const before = world.snapshot();
    const events = [
      { type: 'open', tick: 10, sequence: 0 },
      { type: 'mark', tick: 12, sequence: 1 },
      { type: 'spark', tick: 14, sequence: 2 },
      { type: 'clear', tick: 40, sequence: 3 },
    ];
    runtime.hydrate(frame(50, { events }));
    const sign = runtime.object('sign')!.object as Mesh;
    expect(runtime.object('gate')!.object.getObjectByName('fin')!.position.y).toBeCloseTo(2.1);
    expect((sign.material as MeshBasicMaterial).map).toBe(assets.texture('surface', 'left'));
    expect(runtime.stats().effects.active).toBe(0);
    expect(runtime.stats().dropped).toBe(0);
    expect(extension.update).not.toHaveBeenCalled();
    runtime.present(frame(50, { events }));
    expect(runtime.stats().effects.active).toBe(0);
    expect(extension.update).toHaveBeenLastCalledWith(expect.objectContaining({ events: [] }));
    runtime.present(frame(51, { events: [{ type: 'spark', tick: 50, sequence: 4 }] }));
    expect(runtime.stats().effects.active).toBe(3);
    expect(extension.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ events: [{ type: 'spark', tick: 50, sequence: 4 }] }),
    );
    expect(world.snapshot()).toEqual(before);
  });

  it('reconstructs an in-flight held clip at its current age and clears it on restart', async () => {
    const manifest = runtimeManifest({
      objects: [{ id: 'gate', visual: { kind: 'model', mesh: 'rig' } }],
      effects: [
        {
          event: 'open',
          kind: 'clip',
          target: { object: 'gate' },
          clip: 'lift',
          durationTicks: 30,
          holdLast: true,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const runtime = presentation(adapter);
    const fin = runtime.object('gate')!.object.getObjectByName('fin')!;
    runtime.setReducedMotion(true);
    runtime.hydrate(frame(20, { events: [{ type: 'open', tick: 10, sequence: 0 }] }));
    expect(fin.position.y).toBeCloseTo(1.1 + 10 / 30);
    expect(runtime.stats().effects.active).toBe(1);
    runtime.present(frame(40));
    expect(fin.position.y).toBeCloseTo(2.1);
    expect(runtime.stats().effects.active).toBe(0);
    runtime.hydrate(frame(0, { generation: 1 }));
    expect(fin.position.y).toBeCloseTo(1.1);
    runtime.hydrate(
      frame(100, { generation: 0, events: [{ type: 'open', tick: 10, sequence: 0 }] }),
    );
    expect(fin.position.y).toBeCloseTo(1.1);
  });

  it('does not revive an older held frame superseded by a later nonpersistent animation', async () => {
    const manifest = runtimeManifest({
      objects: [{ id: 'sign', visual: { kind: 'sprite', texture: 'surface', frame: 'left' } }],
      effects: [
        {
          event: 'mark',
          kind: 'frames',
          target: { object: 'sign' },
          frames: ['right'],
          durationTicks: 2,
          frameTicks: 2,
          holdLast: true,
        },
        {
          event: 'flash',
          kind: 'frames',
          target: { object: 'sign' },
          frames: ['right'],
          durationTicks: 2,
          frameTicks: 2,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const runtime = presentation(adapter);
    runtime.hydrate(
      frame(50, {
        events: [
          { type: 'mark', tick: 0, sequence: 0 },
          { type: 'flash', tick: 10, sequence: 1 },
        ],
      }),
    );
    expect(((runtime.object('sign')!.object as Mesh).material as MeshBasicMaterial).map).toBe(
      assets.texture('surface', 'left'),
    );
    expect(runtime.stats().effects.active).toBe(0);
  });

  it('refuses incomplete or future history before changing presentation state', async () => {
    const manifest = runtimeManifest();
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const runtime = presentation(adapter);
    for (const events of [
      [{ type: 'open', tick: 0, sequence: 1 }],
      [{ type: 'open', tick: 0 }],
      [{ type: 'open', tick: 5, sequence: 0 }],
      [
        { type: 'open', tick: 2, sequence: 0 },
        { type: 'close', tick: 1, sequence: 1 },
      ],
    ]) {
      expect(() => runtime.hydrate(frame(3, { events }))).toThrow(/Invalid presentation history/);
    }
    expect(runtime.stats().effects.active).toBe(0);
    expect(runtime.stats().dropped).toBe(0);
  });
});

describe('reduced-motion preference', () => {
  it('stops active decorative motion/feedback immediately, suppresses new feedback, and preserves door clips', async () => {
    const manifest = runtimeManifest({
      entities: [
        { target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig', clip: 'spin' } },
      ],
      objects: [
        {
          id: 'bob',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { position: [0, 4, 0] },
          motion: { kind: 'bob', axis: 'y', amplitude: 2, periodTicks: 120 },
        },
        {
          id: 'spin',
          visual: { kind: 'primitive', shape: 'box' },
          motion: { kind: 'spin', axis: 'y', amplitude: 360, periodTicks: 120 },
        },
        {
          id: 'pulse',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { scale: [1, 1, 2] },
          motion: { kind: 'pulse', axis: 'z', amplitude: 0.25, periodTicks: 120 },
        },
        { id: 'background', visual: { kind: 'primitive', shape: 'plane' }, parallax: 0.25 },
        {
          id: 'view',
          anchor: 'camera',
          visual: { kind: 'primitive', shape: 'box' },
          pose: { position: [0.2, -0.2, -2] },
        },
        { id: 'door', visual: { kind: 'model', mesh: 'rig' }, pose: { position: [5, 0, 0] } },
      ],
      effects: [
        {
          event: 'impact',
          kind: 'burst',
          target: { entity: 'player' },
          count: 4,
          durationTicks: 60,
        },
        {
          event: 'hit',
          kind: 'pulse',
          target: { entity: 'player' },
          color: '#ff0000',
          amount: 0.3,
          durationTicks: 60,
        },
        {
          event: 'fire',
          kind: 'recoil',
          target: { object: 'view' },
          amount: 0.2,
          durationTicks: 60,
        },
        {
          event: 'open',
          kind: 'clip',
          target: { object: 'door' },
          clip: 'lift',
          durationTicks: 60,
          holdLast: true,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const pose = (id: string) => runtime.object(id)!.root.getObjectByName('presentation:pose')!;
    const recoil = runtime.object('view')!.root.getObjectByName('presentation:effect')!;
    const body = modelPart(runtime, 'player', 'body');
    const material = body.material;
    runtime.present(frame(0));
    world.getOrThrow(entityNamed(world, 'camera'), Transform).position.x += 4;
    adapter.sync(world);
    runtime.present(
      frame(30, {
        events: ['impact', 'hit', 'fire', 'open'].map((type, sequence) => ({
          type,
          tick: 30,
          sequence,
        })),
      }),
    );
    expect(pose('bob').position.y).toBeCloseTo(6);
    expect(pose('spin').rotation.y).toBeCloseTo(Math.PI / 2);
    expect(pose('pulse').scale.z).toBeCloseTo(2.5);
    expect(runtime.object('background')!.root.position.x).toBe(1);
    expect(recoil.position.z).toBe(0.2);
    expect(body.material).not.toBe(material);
    expect(runtime.stats().effects.active).toBe(7);
    const before = world.snapshot();
    runtime.setReducedMotion(true);
    expect(runtime.stats().reducedMotion).toBe(true);
    expect(pose('bob').position.y).toBe(4);
    expect(pose('spin').rotation.y).toBe(0);
    expect(pose('pulse').scale.z).toBe(2);
    expect(runtime.object('background')!.root.position.x).toBe(0);
    expect(recoil.position.z).toBe(0);
    expect(body.material).toBe(material);
    expect(runtime.stats().effects.active).toBe(1);
    expect(runtime.stats().dropped).toBe(6);
    expect(adapter.scene.getObjectByName('presentation:effects')!.children).toHaveLength(0);
    expect(world.snapshot()).toEqual(before);
    runtime.present(frame(60));
    expect(modelPart(runtime, 'player').quaternion.z).toBeCloseTo(1);
    expect(runtime.object('door')!.object.getObjectByName('fin')!.position.y).toBeCloseTo(1.6);
    expect(pose('bob').position.y).toBe(4);
    expect(pose('spin').rotation.y).toBe(0);
    runtime.present(
      frame(61, {
        events: ['impact', 'hit', 'fire'].map((type, sequence) => ({
          type,
          tick: 61,
          sequence: sequence + 4,
        })),
      }),
    );
    expect(runtime.stats().effects.active).toBe(1);
    expect(runtime.stats().dropped).toBe(12);
    runtime.present(frame(90));
    expect(runtime.object('door')!.object.getObjectByName('fin')!.position.y).toBeCloseTo(2.1);
    expect(runtime.stats().effects.active).toBe(0);
    runtime.setReducedMotion(false);
    runtime.present(frame(150, { events: [{ type: 'impact', tick: 150, sequence: 7 }] }));
    expect(runtime.stats().reducedMotion).toBe(false);
    expect(pose('bob').position.y).toBeCloseTo(6);
    expect(runtime.stats().effects.active).toBe(4);
    expect(runtime.object('door')!.object.getObjectByName('fin')!.position.y).toBeCloseTo(2.1);
  });

  it('retains essential actor state and event-frame transitions, including across resets and remounts', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'model', mesh: 'rig', animations: { move: 'lift', dead: 'spin' } },
        },
        {
          target: { name: 'critter' },
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
        },
      ],
      effects: [
        {
          event: 'status',
          kind: 'frames',
          target: { entity: 'critter' },
          frames: ['left', 'right'],
          frameTicks: 3,
          durationTicks: 6,
          holdLast: true,
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const player = entityNamed(world, 'player');
    world.getOrThrow(player, BodyState).grounded = true;
    world.getOrThrow(player, Velocity).dx = 2;
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    const runtime = presentation(adapter);
    runtime.setReducedMotion(true);
    adapter.mount(world);
    expect(runtime.stats().reducedMotion).toBe(true);
    runtime.present(frame(0));
    runtime.present(frame(30, { events: [{ type: 'status', tick: 30, sequence: 0 }] }));
    expect(runtime.entity('player')!.state).toBe('move');
    expect(modelPart(runtime, 'player').position.y).toBeCloseTo(1.6);
    runtime.present(frame(33));
    expect((spriteMesh(runtime, 'critter').material as MeshBasicMaterial).map).toBe(
      assets.texture('surface', 'right'),
    );
    world.getOrThrow(player, Health).current = 0;
    adapter.sync(world);
    runtime.present(frame(60));
    runtime.present(frame(90));
    expect(runtime.entity('player')!.state).toBe('dead');
    expect(modelPart(runtime, 'player').quaternion.z).toBeCloseTo(Math.SQRT1_2);
    expect((spriteMesh(runtime, 'critter').material as MeshBasicMaterial).map).toBe(
      assets.texture('surface', 'right'),
    );
    expect(runtime.stats().effects.active).toBe(0);
    expect(runtime.stats().dropped).toBe(0);
    runtime.reset();
    expect(runtime.stats().reducedMotion).toBe(true);
    adapter.mount(world);
    expect(runtime.stats().reducedMotion).toBe(true);
  });
});

describe('reusable visual factory', () => {
  it('exposes the borrowed assets and creates caller-parented models, sprites and primitives in authored units', async () => {
    const manifest = runtimeManifest();
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const before = world.snapshot();
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    expect(runtime.assets).toBe(assets);
    expect(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), 'assets')?.set,
    ).toBeUndefined();
    const a = runtime.createVisual({
      kind: 'model',
      mesh: 'rig',
      material: 'striped',
      animations: { idle: 'spin' },
    });
    const b = runtime.createVisual({ kind: 'model', mesh: 'rig' });
    const sprite = runtime.createVisual({ kind: 'sprite', texture: 'surface', frame: 'left' });
    const box = runtime.createVisual({ kind: 'primitive', shape: 'box', material: 'red' });
    expect(a.root.parent).toBeNull();
    expect(b.root.parent).toBeNull();
    expect(a.clips.map((clip) => clip.name)).toEqual(['spin', 'lift']);
    expect(sprite.clips).toEqual([]);
    expect(box.clips).toEqual([]);
    expect((sprite.root.getObjectByName('sprite') as Mesh).geometry.type).toBe('PlaneGeometry');
    expect(
      ((sprite.root.getObjectByName('sprite') as Mesh).material as MeshBasicMaterial).map,
    ).toBe(assets.texture('surface', 'left'));
    expect((box.root.getObjectByName('box') as Mesh).material).toBe(assets.material('red'));
    const bodyA = a.root.getObjectByName('body') as Mesh;
    const bodyB = b.root.getObjectByName('body') as Mesh;
    expect(bodyA.geometry).toBe(bodyB.geometry);
    expect(bodyA.material).toBe(assets.material('striped'));
    const parent = new Group();
    parent.position.set(2, 0, 3);
    adapter.scene.add(parent);
    parent.add(a.root, b.root);
    a.root.position.set(0.1, 0.2, 0.3);
    expect(new Box3().setFromObject(a.root).getSize(new Vector3()).y).toBeCloseTo(1.35);
    runtime.present(frame(30));
    expect(a.root.getObjectByName('fin')!.quaternion.z).toBeCloseTo(Math.SQRT1_2);
    expect(b.root.getObjectByName('fin')!.quaternion.z).toBe(0);
    expect(a.root.position.toArray()).toEqual([0.1, 0.2, 0.3]);
    expect(parent.position.toArray()).toEqual([2, 0, 3]);
    expect(runtime.stats().resources.objects).toBe(4);
    expect(world.snapshot()).toEqual(before);
    runtime.reset();
    expect(a.root.getObjectByName('fin')!.quaternion.z).toBe(0);
    expect(a.root.position.toArray()).toEqual([0.1, 0.2, 0.3]);
  });

  it('releases handles on removal/remount/dispose, preserves shared resources, and rejects invalid specs early', async () => {
    const manifest = runtimeManifest();
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const a = runtime.createVisual({ kind: 'model', mesh: 'rig' });
    const b = runtime.createVisual({ kind: 'model', mesh: 'rig' });
    adapter.scene.add(a.root, b.root);
    const geometry = (a.root.getObjectByName('body') as Mesh).geometry;
    const disposeGeometry = vi.fn();
    geometry.addEventListener('dispose', disposeGeometry);
    expect(assets.stats().modelInstances).toBe(2);
    a.dispose();
    a.dispose();
    expect(a.root.parent).toBeNull();
    expect(assets.stats().modelInstances).toBe(1);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(() => runtime.createVisual({ kind: 'model', mesh: 'missing' })).toThrow(/missing/);
    expect(() => runtime.createVisual({ kind: 'model', mesh: 'rig', clip: 'missing' })).toThrow(
      /Unknown animation clip/,
    );
    expect(() =>
      runtime.createVisual({ kind: 'sprite', texture: 'surface', frame: 'missing' }),
    ).toThrow(/Unknown atlas frame/);
    expect(runtime.stats().resources.objects).toBe(1);
    expect(assets.stats().modelInstances).toBe(1);
    adapter.mount(world);
    expect(b.root.parent).toBeNull();
    expect(assets.stats().modelInstances).toBe(0);
    expect(runtime.stats().resources.objects).toBe(0);
    b.dispose();
    const c = runtime.createVisual({ kind: 'model', mesh: 'rig' });
    adapter.scene.add(c.root);
    adapter.dispose();
    c.dispose();
    expect(assets.stats().modelInstances).toBe(0);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(() => runtime.createVisual({ kind: 'primitive', shape: 'box' })).toThrow(
      /disposed presentation/,
    );
    assets.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
  });
});

describe('static batching, light budgets, and resource lifetime', () => {
  it('batches a multi-mesh/material model per compatible geometry/material and preserves node transforms', async () => {
    const manifest = runtimeManifest({
      objects: [
        {
          id: 'scenery',
          visual: { kind: 'model', mesh: 'rig' },
          pose: { position: [10, 0, 0] },
          instances: [{ position: [1, 0, 2] }, { position: [3, 0, 4], scale: [2, 2, 2] }],
        },
      ],
    });
    const assets = own(
      await runtimeAssets(manifest, (gltf) => {
        gltf.animations = [];
        const fin = gltf.scene.getObjectByName('fin');
        if (!(fin instanceof Mesh)) throw new Error('Fixture fin missing.');
        fin.material = new MeshBasicMaterial({ color: '#ff0000' });
      }),
    );
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const runtime = presentation(adapter);
    const root = runtime.object('scenery')!.root;
    expect(root.children).toHaveLength(2);
    expect(root.children.every((child) => child instanceof InstancedMesh)).toBe(true);
    const [body, fin] = root.children as InstancedMesh[];
    expect(body!.count).toBe(2);
    expect(fin!.count).toBe(2);
    const matrix = new Matrix4();
    fin!.getMatrixAt(0, matrix);
    expect(new Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([
      1,
      expect.closeTo(1.1),
      2,
    ]);
    fin!.getMatrixAt(1, matrix);
    expect(new Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([
      3,
      expect.closeTo(2.2),
      4,
    ]);
    expect(root.position.x).toBe(10);
    expect(runtime.stats().resources.instances).toBe(2);
    expect(runtime.stats().resources.batches).toBe(2);
    expect(assets.stats().modelInstances).toBe(0);
    const combined = runtimeManifest({
      objects: [
        {
          ...manifest.objects![0]!,
          visual: { kind: 'model', mesh: 'rig', material: 'red' },
        },
      ],
    });
    const shared = own(
      createRenderAdapter('platformer', { presentation: { manifest: combined, assets } }),
    );
    shared.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    const merged = presentation(shared).object('scenery')!.root.children;
    expect(merged).toHaveLength(1);
    expect((merged[0] as InstancedMesh).count).toBe(4);
    expect((merged[0] as InstancedMesh).material).toBe(assets.material('red'));
  });

  it('creates the full 4096-instance budget, rejects 4097, and never clones animated/skinned instances', async () => {
    const manifest = runtimeManifest({
      objects: [
        {
          id: 'many',
          visual: { kind: 'primitive', shape: 'box' },
          instances: Array.from({ length: 4096 }, (_, x) => ({ position: [x, 0, 0] as const })),
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    expect(presentation(adapter).stats().resources.instances).toBe(4096);
    expect((presentation(adapter).object('many')!.root.children[0] as InstancedMesh).count).toBe(
      4096,
    );
    const oversized = runtimeManifest({
      objects: [
        {
          id: 'many',
          visual: { kind: 'primitive', shape: 'box' },
          instances: Array.from({ length: 4097 }, () => ({})),
        },
      ],
    });
    expect(() =>
      createRenderAdapter('platformer', { presentation: { manifest: oversized, assets } }),
    ).toThrow(/4096/);
    const animated = runtimeManifest({
      objects: [{ id: 'many', visual: { kind: 'model', mesh: 'rig' }, instances: [{}, {}] }],
    });
    expect(() =>
      createRenderAdapter('platformer', { presentation: { manifest: animated, assets } }),
    ).toThrow(/animated visual/);
    expect(assets.stats().modelInstances).toBe(0);
    const skinned = own(
      await runtimeAssets(animated, (gltf) => {
        gltf.animations = [];
        const body = gltf.scene.getObjectByName('body');
        if (!(body instanceof Mesh)) throw new Error('Fixture body missing.');
        const geometry = body.geometry.clone();
        const vertices = geometry.getAttribute('position').count;
        geometry.setAttribute(
          'skinIndex',
          new Uint16BufferAttribute(new Uint16Array(vertices * 4), 4),
        );
        const weights = new Float32Array(vertices * 4);
        for (let i = 0; i < vertices; i++) weights[i * 4] = 1;
        geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
        const skin = new SkinnedMesh(geometry, body.material);
        const bone = new Bone();
        skin.add(bone);
        skin.bind(new Skeleton([bone]));
        skin.name = 'skin';
        gltf.scene.add(skin);
      }),
    );
    expect(() =>
      createRenderAdapter('platformer', { presentation: { manifest: animated, assets: skinned } }),
    ).toThrow(/skinned, morphed/);
    expect(skinned.stats().modelInstances).toBe(0);
  });

  it('honors authored environment and content lights, updates/removes them, and caps their combined count', async () => {
    const manifest = runtimeManifest({
      environment: {
        background: '#112233',
        ambient: { color: '#ffffff', intensity: 0.4 },
        directional: { color: '#ffeedd', intensity: 1.5, position: [2, 3, 4] },
        points: [{ color: '#ff0000', intensity: 2, position: [1, 2, 3], distance: 9 }],
        fog: { color: '#112233', near: 5, far: 50 },
      },
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const lightEntity = entityNamed(world, 'security-switch');
    world.add(lightEntity, Light, { kind: 'point', color: '#00ff00', intensity: 3 });
    world.getOrThrow(lightEntity, Transform).position.z = 2;
    const adapter = own(createRenderAdapter('iso', { presentation: { manifest, assets } }));
    adapter.mount(world);
    const runtime = presentation(adapter);
    const light = adapter.scene.getObjectByName('light:content:security-switch') as PointLight;
    expect(light).toBeInstanceOf(PointLight);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
    expect(light.intensity).toBe(3);
    expect(light.color.getHexString()).toBe('00ff00');
    expect(runtime.stats().resources.pointLights).toBe(2);
    expect(runtime.stats().resources.lights).toBe(4);
    expect(adapter.scene.getObjectByName('light:ambient')).toBeUndefined();
    expect(adapter.scene.fog?.color.getHexString()).toBe('112233');
    world.getOrThrow(lightEntity, Light).intensity = 4;
    adapter.sync(world);
    expect(light.intensity).toBe(4);
    world.remove(lightEntity, Light);
    adapter.sync(world);
    expect(runtime.stats().resources.pointLights).toBe(1);
    const tooMany = runtimeManifest({
      environment: {
        points: Array.from({ length: 8 }, () => ({
          color: '#ffffff',
          intensity: 1,
          position: [0, 1, 0] as const,
          distance: 5,
        })),
      },
    });
    world.add(lightEntity, Light, { kind: 'point' });
    const crowded = own(
      createRenderAdapter('iso', { presentation: { manifest: tooMany, assets } }),
    );
    expect(() => crowded.mount(world)).toThrow(/9 point lights.*limit is 8/);
  });

  it('releases only owned instances on despawn/remount/dispose while another adapter keeps using shared resources', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'model', mesh: 'rig', material: 'striped', clip: 'spin' },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
    const a = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    const b = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    a.mount(world);
    b.mount(world);
    const geometry = modelPart(presentation(a), 'player', 'body').geometry;
    const disposeGeometry = vi.fn();
    const disposeMaterial = vi.fn();
    const disposeTexture = vi.fn();
    geometry.addEventListener('dispose', disposeGeometry);
    assets.material('striped').addEventListener('dispose', disposeMaterial);
    assets.texture('surface').addEventListener('dispose', disposeTexture);
    expect(assets.stats().modelInstances).toBe(2);
    a.mount(world);
    expect(assets.stats().modelInstances).toBe(2);
    expect(a.scene.getObjectByName('level')?.children).toHaveLength(21);
    expect(a.scene.children.filter((node) => node.name.startsWith('light:'))).toHaveLength(2);
    a.dispose();
    a.dispose();
    expect(assets.stats().modelInstances).toBe(1);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();
    expect(disposeTexture).not.toHaveBeenCalled();
    presentation(b).present(frame(30));
    expect(modelPart(presentation(b), 'player').quaternion.z).toBeCloseTo(Math.SQRT1_2);
    world.despawn(entityNamed(world, 'player'));
    b.sync(world);
    expect(assets.stats().modelInstances).toBe(0);
    expect(disposeGeometry).not.toHaveBeenCalled();
    b.dispose();
    assets.dispose();
    assets.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
    expect(disposeTexture).toHaveBeenCalledTimes(1);
  });

  it('can cleanly dispose a mounted sprite runtime even when its asset owner was already released', async () => {
    const manifest = runtimeManifest({
      entities: [
        {
          target: { name: 'player' },
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
        },
      ],
    });
    const assets = own(await runtimeAssets(manifest));
    const adapter = own(createRenderAdapter('platformer', { presentation: { manifest, assets } }));
    adapter.mount(buildTestWorld(PLATFORMER_SCENE, platformerPlugin));
    presentation(adapter).present(frame(20));
    assets.dispose();
    expect(() => adapter.dispose()).not.toThrow();
    expect(adapter.scene.children).toHaveLength(0);
    expect(presentation(adapter).stats().resources.runtimeMaterials).toBe(0);
  });
});

describe('presentation-enabled per-tick noninterference', () => {
  for (const { scene, plugin, actor } of cases)
    it(`${plugin.mode}: independently stepped worlds retain equal hashes with animation/effects and extra syncs`, async () => {
      const manifest = runtimeManifest({
        entities: [
          { target: { name: actor }, visual: { kind: 'model', mesh: 'rig', clip: 'spin' } },
        ],
        effects: [
          {
            event: 'feedback',
            kind: 'burst',
            target: { entity: actor },
            count: 4,
            durationTicks: 8,
          },
        ],
        objects: [
          {
            id: 'marker',
            visual: { kind: 'sprite', texture: 'surface' },
            motion: { kind: 'bob', axis: 'y', amplitude: 0.3, periodTicks: 20 },
          },
        ],
      });
      const assets: PresentationAssets = own(await runtimeAssets(manifest));
      const plain = buildTestWorld(scene, plugin);
      const rendered = buildTestWorld(scene, plugin);
      const script =
        plugin.mode === 'platformer'
          ? 'hold Right 0..30\npress Jump @2'
          : plugin.mode === 'iso'
            ? 'click 4,3 @2'
            : 'axis Forward 1 0..30\npress Fire @8';
      const parsed = parseInputScript(script);
      if (!parsed.ok || parsed.value === undefined) throw new Error('Test input did not compile.');
      const frames = parsed.value.frames(40);
      const simulations = [plain, rendered].map((world) =>
        createSimulation({
          world,
          schedule: plugin.systems(),
          tickRate: 60,
          input: { frameFor: (tick) => frames[tick]! },
        }),
      );
      const adapter = own(createRenderAdapter(plugin.mode, { presentation: { manifest, assets } }));
      adapter.mount(rendered);
      const initial = plain.hash();
      for (let tick = 0; tick < 40; tick++) {
        for (const simulation of simulations) simulation.step();
        adapter.sync(rendered);
        adapter.present?.(frame(tick, { events: [{ type: 'feedback', tick, sequence: tick }] }));
        adapter.sync(rendered);
        expect(rendered.hash(), `world changed at tick ${tick}`).toBe(plain.hash());
      }
      expect(plain.hash()).not.toBe(initial);
      expect(presentation(adapter).stats().resources.mixers).toBe(1);
    });
});

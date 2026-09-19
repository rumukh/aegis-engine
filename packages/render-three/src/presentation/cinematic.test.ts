import { afterEach, describe, expect, it } from 'vitest';
import { MeshStandardMaterial, SpotLight, Vector3 } from 'three';
import { defineComponent, Transform } from '@aegis/core';
import { fpsPlugin } from '@aegis/mode-fps';
import { createRenderAdapter } from '../adapters/index.js';
import { FPS_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';
import { cinematicSize } from './pipeline.js';
import { readDataPath } from './state.js';
import { validatePresentation } from './validate.js';
import { validatePresentationWorld } from './world.js';
import {
  entityNamed,
  modelPart,
  presentationFrame,
  runtimeAssets,
  runtimeManifest,
} from './runtime-test-utils.js';
import type { PresentationManifest } from './schema.js';

const Status = defineComponent({
  id: 'FixtureStatus',
  defaults: () => ({ enabled: true, mode: 'idle', prompt: '' }),
});
const when = { entity: 'player', component: 'FixtureStatus', field: 'enabled', equals: true };
const owned: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
  owned.push(value);
  return value;
}
afterEach(() => {
  for (const value of owned.reverse()) value.dispose();
  owned.length = 0;
});
function manifest(): PresentationManifest {
  return runtimeManifest({
    quality: 'high',
    pipeline: {
      toneMapping: 'aces',
      exposure: 1,
      bloom: { strength: 0.15, radius: 0.3, threshold: 1 },
      ambientOcclusion: { radius: 4, minDistance: 0.002, maxDistance: 0.04 },
    },
    environment: {
      spots: [
        {
          id: 'flashlight',
          color: '#ffffff',
          intensity: 18,
          position: [0.1, -0.1, 0],
          target: [0.1, -0.1, -6],
          distance: 20,
          angle: 24,
          anchor: 'camera',
          enabledWhen: { ...when },
          shadow: { mapSize: 2048 },
        },
      ],
    },
    objects: [
      { id: 'powered', visual: { kind: 'primitive', shape: 'box' }, visibleWhen: { ...when } },
    ],
  });
}

describe('opt-in cinematic presentation', () => {
  it('uses literal backing-pixel budgets, including high-DPR and non-16:9 viewports', () => {
    expect(cinematicSize(2560, 1440, 1, 'high')).toEqual({ width: 2560, height: 1440 });
    expect(cinematicSize(2560, 1440, 2, 'high')).toEqual({ width: 2560, height: 1440 });
    expect(cinematicSize(3840, 2160, 2, 'photo')).toEqual({ width: 3840, height: 2160 });
    expect(cinematicSize(3840, 2160, 1, 'low')).toEqual({ width: 1280, height: 720 });
    const tall = cinematicSize(1000, 3000, 3, 'high');
    expect(tall.width * tall.height).toBeLessThanOrEqual(3686400);
    expect(tall.width / tall.height).toBeCloseTo(1 / 3, 3);
    for (const invalid of [0, -1, Infinity, NaN])
      expect(() => cinematicSize(invalid, 100, 1, 'high')).toThrow(/positive/);
  });

  it('projects a gated camera flashlight, preserves world hashes and caps/disposes shadow sizes', async () => {
    const spec = manifest();
    const assets = own(await runtimeAssets(spec));
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Status);
    const hash = world.hash();
    const adapter = own(createRenderAdapter('fps', { presentation: { manifest: spec, assets } }));
    adapter.mount(world);
    const light = adapter.scene.getObjectByName('presentation:spot:flashlight');
    expect(light).toBeInstanceOf(SpotLight);
    if (!(light instanceof SpotLight)) throw new Error('missing spotlight');
    expect(light.castShadow).toBe(true);
    expect(light.shadow.mapSize.toArray()).toEqual([1024, 1024]);
    expect(light.position.toArray()).toEqual(
      new Vector3(0.1, -0.1, 0).applyMatrix4(adapter.camera.matrixWorld).toArray(),
    );
    expect(light.target.position.toArray()).toEqual(
      new Vector3(0.1, -0.1, -6).applyMatrix4(adapter.camera.matrixWorld).toArray(),
    );
    for (let tick = 0; tick < 20; tick++) {
      adapter.sync(world);
      adapter.present?.(presentationFrame(tick));
    }
    expect(world.hash()).toBe(hash);
    world.getOrThrow(player, Status).enabled = false;
    adapter.sync(world);
    expect(light.visible).toBe(false);
    expect(adapter.presentation?.object('powered')?.root.visible).toBe(false);
    adapter.presentation?.setQuality('photo');
    expect(light.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    adapter.presentation?.setQuality('low');
    expect(light.shadow.mapSize.toArray()).toEqual([512, 512]);
    adapter.resetPresentation?.();
    world.getOrThrow(player, Status).enabled = true;
    adapter.sync(world);
    expect(light.visible).toBe(true);
  });

  it('refuses missing and mistyped binding subjects instead of silently disabling a light', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    expect(validatePresentationWorld(manifest(), world).ok).toBe(false);
    world.add(entityNamed(world, 'player'), Status);
    const bad = manifest();
    bad.environment!.spots![0]!.enabledWhen!.equals = 'true';
    expect(validatePresentationWorld(bad, world).diagnostics[0]?.message).toMatch(
      /different scalar types/,
    );
    expect(readDataPath({ nested: { value: 7 } }, 'nested.value')).toBe(7);
    expect(readDataPath({}, '__proto__.value')).toBeUndefined();
  });

  it('supports independent PBR texture maps through the shared material loader', async () => {
    const spec = runtimeManifest({
      assets: [
        {
          id: 'data',
          src: 'data.png',
          kind: 'texture',
          colorSpace: 'linear',
          provenance: { author: 'fixture', license: 'MIT', source: 'fixture' },
        },
      ],
      materials: [
        {
          id: 'pbr',
          shading: 'standard',
          roughnessMap: 'data',
          metalnessMap: 'data',
          aoMap: 'data',
          normalMap: 'data',
          normalScale: 0.6,
          aoIntensity: 0.5,
          envMapIntensity: 0.8,
          repeat: [2, 3],
        },
      ],
    });
    const assets = own(await runtimeAssets(spec));
    const material = assets.material('pbr');
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    if (!(material instanceof MeshStandardMaterial)) throw new Error('wrong material');
    expect(material.roughnessMap?.repeat.toArray()).toEqual([2, 3]);
    expect(material.roughnessMap).toBe(material.metalnessMap);
    expect(material.aoMap).toBe(material.roughnessMap);
    expect(material.normalScale.toArray()).toEqual([0.6, 0.6]);
    expect(material.aoMapIntensity).toBe(0.5);
    expect(material.envMapIntensity).toBe(0.8);
    const invalid = structuredClone(spec);
    if (invalid.assets?.[0]?.kind === 'texture') invalid.assets[0].colorSpace = 'srgb';
    expect(
      validatePresentation(invalid).diagnostics.filter((v) => v.message.includes('Scalar PBR')),
    ).toHaveLength(3);
  });

  it('loops condition-selected model clips and gives one-shot effects priority without fake physics', async () => {
    const spec = manifest();
    spec.entities = [
      {
        target: { name: 'grunt' },
        visual: {
          kind: 'model',
          mesh: 'rig',
          stateClips: [
            { when: { ...when, field: 'mode', equals: 'idle' }, clip: 'lift', timeScale: 0 },
            { when: { ...when, field: 'mode', equals: 'move' }, clip: 'lift' },
          ],
        },
      },
    ];
    spec.effects = [
      {
        event: 'signal',
        kind: 'clip',
        target: { entity: 'grunt' },
        clip: 'lift',
        durationTicks: 60,
      },
    ];
    const assets = own(await runtimeAssets(spec));
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const player = entityNamed(world, 'player');
    world.add(player, Status);
    const adapter = own(createRenderAdapter('fps', { presentation: { manifest: spec, assets } }));
    adapter.mount(world);
    const runtime = adapter.presentation!;
    adapter.present?.(presentationFrame(30));
    expect(modelPart(runtime, 'grunt').position.y).toBeCloseTo(1.1);
    world.getOrThrow(player, Status).mode = 'move';
    adapter.sync(world);
    adapter.present?.(presentationFrame(60));
    adapter.present?.(presentationFrame(90));
    expect(modelPart(runtime, 'grunt').position.y).toBeCloseTo(1.6);
    adapter.present?.(presentationFrame(150));
    expect(modelPart(runtime, 'grunt').position.y).toBeCloseTo(1.6);
    world.getOrThrow(player, Status).mode = 'idle';
    adapter.sync(world);
    adapter.present?.(
      presentationFrame(150, { events: [{ type: 'signal', tick: 150, sequence: 0 }] }),
    );
    adapter.present?.(presentationFrame(180));
    expect(modelPart(runtime, 'grunt').position.y).toBeCloseTo(1.6);
    adapter.present?.(presentationFrame(211));
    expect(modelPart(runtime, 'grunt').position.y).toBeCloseTo(1.1);
  });

  it('rejects unbounded lights, missing pipeline, invalid scalar paths, spatial and caption mistakes', () => {
    const cases: unknown[] = [
      { ...manifest(), pipeline: undefined },
      {
        ...manifest(),
        environment: {
          spots: Array.from({ length: 5 }, (_, i) => ({
            ...manifest().environment!.spots![0],
            id: `light-${i}`,
          })),
        },
      },
      {
        ...manifest(),
        objects: [
          {
            id: 'bad',
            visual: { kind: 'primitive', shape: 'box' },
            visibleWhen: { ...when, field: '__proto__.enabled' },
          },
        ],
      },
      { aegis: 'presentation/1', audio: { cues: [{ event: 'x' }] } },
      {
        aegis: 'presentation/1',
        audio: {
          cues: [{ event: 'x', caption: { text: 'text' }, when: { field: 'variant', equals: {} } }],
        },
      },
      {
        ...manifest(),
        audio: {
          layers: [
            { id: 'x', asset: 'tone', spatial: { target: { entity: 'player' }, maxDistance: 1 } },
          ],
        },
      },
    ];
    for (const value of cases) expect(validatePresentation(value).ok).toBe(false);
    expect(
      validatePresentation({
        aegis: 'presentation/1',
        audio: {
          cues: [
            {
              event: 'x',
              caption: { text: 'Caption only' },
              when: { field: 'variant', equals: 2 },
            },
          ],
        },
      }).ok,
    ).toBe(true);
  });

  it('rejects spatial targets without Transform during world initialization', () => {
    const world = buildTestWorld(FPS_SCENE, fpsPlugin);
    const player = entityNamed(world, 'player');
    world.remove(player, Transform);
    const spec = runtimeManifest({
      audio: { layers: [{ id: 'room', asset: 'tone', spatial: { target: { entity: 'player' } } }] },
    });
    expect(validatePresentationWorld(spec, world).diagnostics[0]?.message).toMatch(/no Transform/);
  });
});

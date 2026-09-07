import { describe, expect, it } from 'vitest';
import {
  createSchedule,
  defineComponent,
  defineResource,
  DiagnosticError,
  Transform,
} from '@aegis/core';
import {
  ContentCode,
  createPrefabResolver,
  createRegistry,
  createResourceRegistry,
  validateScene,
} from '@aegis/content';
import type { PrefabFile, SceneFile } from '@aegis/content';
import { bootstrapScene, createSceneContext } from './bootstrap.js';
import type { ModePlugin } from './plugin.js';
import { runScene } from './run.js';
import { fakeMode } from './testing/fake-mode.js';

const Settings = defineResource('game.settings', () => ({ offset: 0 }));
const Extra = defineComponent({ id: 'Extra', defaults: () => ({ enabled: false }) });
const actor: PrefabFile = {
  aegis: 'prefab/1',
  name: 'actor',
  components: { Transform: { position: { x: 2, y: 0, z: 0 } } },
};
const legacy: ModePlugin = {
  mode: 'platformer',
  components: () => [],
  systems: () => createSchedule(),
  view: () => fakeMode.view(),
};
const plugin: ModePlugin = {
  ...legacy,
  resources: () => [Settings],
  prefabs: () => [actor],
  init(world) {
    const settings = world.getResource(Settings);
    if (settings === undefined) throw new Error('game.settings was not loaded before init');
    world
      .query({ has: [Transform] })
      .one()
      .get(Transform).position.x += settings.offset;
  },
};
const scene: SceneFile = {
  aegis: 'scene/1',
  name: 'bootstrap-test',
  mode: 'platformer',
  seed: 'bootstrap',
  resources: { 'game.settings': { offset: 5 } },
  entities: [{ id: 'hero', prefab: 'actor' }],
};

describe('shared scene bootstrap', () => {
  it('registers core/content/plugin vocabulary and explicit extras without mutating registries', () => {
    const registry = createRegistry(Extra);
    const resources = createResourceRegistry('game.extra');
    const context = createSceneContext(plugin, { registry, resources });
    expect(context.registry.has('Transform')).toBe(true);
    expect(context.registry.has('Health')).toBe(true);
    expect(context.registry.get('Extra')).toBe(Extra);
    expect(context.resources.ids()).toEqual(['game.extra', 'game.settings']);
    expect(registry.ids()).toEqual(['Extra']);
    expect(resources.ids()).toEqual(['game.extra']);
    expect(createSceneContext(legacy).resources.ids()).toEqual([]);
  });

  it('loads declared resources and prefabs before running init exactly once', async () => {
    const beforeScene = JSON.stringify(scene);
    const beforePrefab = JSON.stringify(actor);
    const boot = bootstrapScene(scene, { plugin });
    expect(boot.world.tick).toBe(0);
    expect(boot.seed).toBe('bootstrap');
    expect(boot.world.getOrThrow(boot.entities['hero']!, Transform).position.x).toBe(7);
    expect(boot.world.getResource(Settings)).toEqual({ offset: 5 });
    expect(boot.context.resources.ids()).toEqual(['game.settings']);
    const run = await runScene(scene, { plugin, ticks: 0 });
    expect(run.hash).toBe(boot.world.hash());
    expect(run.replay().hash).toBe(run.hash);
    expect(JSON.stringify(scene)).toBe(beforeScene);
    expect(JSON.stringify(actor)).toBe(beforePrefab);
  });

  it('reports unknown resource IDs consistently before init or any tick', async () => {
    const invalid: SceneFile = {
      ...scene,
      resources: { 'game.setings': { offset: 5 } },
    };
    const validated = validateScene(
      invalid,
      createSceneContext(plugin, { file: 'level.scene.json' }),
    );
    expect(validated.ok).toBe(false);
    expect(validated.diagnostics[0]).toMatchObject({
      code: ContentCode.UnknownResource,
      location: { file: 'level.scene.json', path: 'resources["game.setings"]' },
      data: { suggestion: 'game.settings' },
    });
    expect(() => bootstrapScene(invalid, { plugin })).toThrow(DiagnosticError);
    await expect(runScene(invalid, { plugin, ticks: 1 })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: ContentCode.UnknownResource })],
    });
  });

  it('keeps resource-free legacy plugins usable and diagnoses the resource migration', async () => {
    const empty: SceneFile = { ...scene, resources: {}, entities: [] };
    expect(bootstrapScene(empty, { plugin: legacy }).world.entityCount).toBe(0);
    const authored = { ...empty, resources: { 'game.settings': { offset: 1 } } };
    const validated = validateScene(authored, createSceneContext(legacy));
    expect(validated.ok).toBe(false);
    expect(validated.diagnostics[0]?.fix).toContain('ModePlugin.resources()');
    expect(() => bootstrapScene(authored, { plugin: legacy })).toThrow(DiagnosticError);
    const explicit = await runScene(authored, {
      plugin: legacy,
      resources: createResourceRegistry(Settings),
      ticks: 0,
    });
    expect(explicit.world.getResource(Settings)).toEqual({ offset: 1 });
  });

  it('propagates caller resolvers through run and replay, with explicit precedence', async () => {
    const override = { ...actor, components: { Transform: { position: { x: 9, y: 0, z: 0 } } } };
    const prefabs = createPrefabResolver(override);
    const run = await runScene(scene, { plugin, prefabs, ticks: 1 });
    expect(
      run
        .query({ has: [Transform] })
        .one()
        .get(Transform).position.x,
    ).toBe(14);
    expect(run.replay().hash).toBe(run.hash);
    const fallback = createSceneContext(plugin, { prefabs: createPrefabResolver() });
    expect(fallback.prefabs.resolve('actor')).toBe(actor);
  });

  it('rejects duplicate catalog names instead of silently picking a prefab', () => {
    const duplicate = { ...plugin, prefabs: () => [actor, { ...actor }] };
    expect(() => createSceneContext(duplicate)).toThrow(DiagnosticError);
    expect(() => createPrefabResolver(actor, actor)).toThrow('Duplicate prefab name "actor"');
  });

  it('expands prefab children through public run and replay paths', async () => {
    const composed: ModePlugin = {
      ...legacy,
      prefabs: () => [
        {
          ...actor,
          children: [
            { id: 'child', components: { Transform: { position: { x: 1, y: 0, z: 0 } } } },
          ],
        },
      ],
    };
    const run = await runScene({ ...scene, resources: {} }, { plugin: composed, ticks: 1 });
    const positions = run
      .query({ has: [Transform] })
      .views()
      .map((v) => v.get(Transform).position.x);
    expect(positions).toEqual([2, 3]);
    expect(run.world.snapshot().entities.map((e) => e.name)).toEqual(['hero', 'hero/child']);
    expect(run.replay().hash).toBe(run.hash);
  });
});

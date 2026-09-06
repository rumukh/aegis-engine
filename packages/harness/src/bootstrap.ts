/**
 * Shared scene initialization for headless runs, CLI tooling and live hosts.
 * Registries are built per run; all authored resource IDs are checked before plugin.init.
 * @packageDocumentation
 */
import { createWorld, DiagnosticError, Name, Transform } from '@aegis/core';
import type { Diagnostic, Entity, World } from '@aegis/core';
import {
  createPrefabResolver,
  createRegistry,
  createResourceRegistry,
  Dead,
  Health,
  instantiateScene,
  Light,
  Model,
  Sprite,
  Trigger,
  Triggered,
} from '@aegis/content';
import type {
  ComponentRegistry,
  PrefabResolver,
  ResourceRegistry,
  SceneFile,
  ValidateOptions,
} from '@aegis/content';
import type { ModePlugin } from './plugin.js';

/** Additional content declarations supplied by a host rather than by its plugin. */
export interface SceneContentOptions {
  /** Extra components, added to the core/content/plugin registry. */
  registry?: ComponentRegistry;
  /** Extra resource IDs, added to the plugin's declarations (never inferred from the scene). */
  resources?: ResourceRegistry;
  /** Explicit resolver, consulted before the plugin's prefab catalog. */
  prefabs?: PrefabResolver;
  /** Source filename for content diagnostics. */
  file?: string;
}

/** The exact registries/resolver used to validate and instantiate one scene. */
export interface SceneContext extends ValidateOptions {
  resources: ResourceRegistry;
  prefabs: PrefabResolver;
}

/** Reject plugin spec strings at the boundary; only the CLI resolves module names. */
function requirePlugin(plugin: ModePlugin): void {
  if (
    typeof plugin === 'object' &&
    plugin !== null &&
    typeof plugin.components === 'function' &&
    typeof plugin.systems === 'function' &&
    typeof plugin.view === 'function' &&
    (plugin.init === undefined || typeof plugin.init === 'function') &&
    (plugin.resources === undefined || typeof plugin.resources === 'function') &&
    (plugin.prefabs === undefined || typeof plugin.prefabs === 'function')
  ) {
    return;
  }
  const named = typeof plugin === 'string' ? ` (got the string ${JSON.stringify(plugin)})` : '';
  const advice =
    typeof plugin === 'string'
      ? `A plugin *spec* string is resolved by the CLI — \`aegis test\`, \`--plugin ${plugin}\`, or ` +
        `{ "plugin": ${JSON.stringify(plugin)} } in an aegis.json beside the scene. The harness ` +
        `cannot resolve it itself: importing a concrete @aegis/mode-* would invert the package ` +
        `graph (ADR-0006). To run this test in-process, import the plugin object yourself — a mode ` +
        `package exports platformerPlugin / isoPlugin / fpsPlugin — and substitute it:\n` +
        `  await runGameTest({ ...spec, options: { ...spec.options, plugin: myPlugin } });`
      : `Pass the ModePlugin object itself. components(), systems() and view() are required; ` +
        `init, resources and prefabs must be methods when present.`;
  throw new TypeError(
    `[aegis] scene bootstrap: options.plugin is not a ModePlugin${named}.\n${advice}`,
  );
}

/** The core/content vocabulary, before any mode or game declarations. */
export function createBaseRegistry(): ComponentRegistry {
  return createRegistry(Transform, Name, Sprite, Model, Light, Health, Trigger, Dead, Triggered);
}

/** Build the same content vocabulary for validation, execution and capability discovery. */
export function createSceneContext(
  plugin: ModePlugin,
  options: SceneContentOptions = {},
): SceneContext {
  requirePlugin(plugin);
  const registry = createBaseRegistry();
  registry.registerAll(plugin.components());
  if (options.registry !== undefined) {
    for (const id of options.registry.ids()) {
      const type = options.registry.get(id);
      if (type !== undefined) registry.register(type);
    }
  }
  const resources = createResourceRegistry(...(plugin.resources?.() ?? []));
  if (options.resources !== undefined) resources.registerAll(options.resources.ids());
  const catalog = createPrefabResolver(...(plugin.prefabs?.() ?? []));
  const prefabs: PrefabResolver = {
    resolve: (name) => options.prefabs?.resolve(name) ?? catalog.resolve(name),
  };
  return {
    registry,
    resources,
    prefabs,
    ...(options.file !== undefined ? { file: options.file } : {}),
  };
}

/** Options for creating an initialized world, without stepping it. */
export interface BootstrapOptions extends SceneContentOptions {
  plugin: ModePlugin;
  /** Overrides the scene seed; otherwise the scene seed or 0 is used. */
  seed?: number | string;
  /** Retain emitted events for observation. Default true. */
  recordEvents?: boolean;
}

/** Initialized scene state, before tick 0. */
export interface SceneBootstrap {
  world: World;
  seed: number | string;
  context: SceneContext;
  entities: Readonly<Record<string, Entity>>;
  diagnostics: readonly Diagnostic[];
}

/**
 * Instantiate content with a complete vocabulary, then call plugin.init exactly once.
 * World writes defensively copy scene/prefab values; neither authoring document is mutated.
 */
export function bootstrapScene(scene: SceneFile, options: BootstrapOptions): SceneBootstrap {
  const context = createSceneContext(options.plugin, options);
  const seed = options.seed ?? scene.seed ?? 0;
  const world = createWorld({ seed, recordEvents: options.recordEvents ?? true });
  const result = instantiateScene(world, scene, context);
  if (!result.ok) throw new DiagnosticError(result.diagnostics);
  options.plugin.init?.(world);
  return { world, seed, context, entities: result.entities, diagnostics: result.diagnostics };
}

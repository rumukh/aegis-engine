/**
 * Simulation helpers shared by `run`, `inspect`, `record` and `replay`: load and parse a scene
 * against {@link CliIO.cwd}, resolve the {@link ModePlugin} that will actually run it, prove the
 * scene *can* run under that plugin, and summarise event logs.
 *
 * The load-bearing rule here is the one the whole CLI is judged by: **never report a clean run of
 * a world we did not really simulate.** A scene whose components no registered plugin provides is
 * refused before tick 0 rather than silently instantiated with those components missing.
 * @packageDocumentation
 */
import {
  createRegistry,
  Dead,
  Health,
  Light,
  Model,
  parseScene,
  Sprite,
  Trigger,
  Triggered,
  validateScene,
} from '@aegis/content';
import type { ComponentRegistry, EntityDecl, SceneFile } from '@aegis/content';
import { DiagnosticError, Name, Transform } from '@aegis/core';
import type { Diagnostic, EventReader, World } from '@aegis/core';
import type { AsciiView, ModePlugin, SemanticFrame, SimResult, ViewOptions } from '@aegis/harness';
import { dirname } from 'node:path';
import type { CommandContext } from '../command.js';
import { AegisCliError, CliCode, messageOf } from '../errors.js';
import { describePluginSource, discoverPluginSpec, loadPlugin } from '../plugin.js';
import type { ResolvedPlugin } from '../plugin.js';
import { flagString, readText, resolvePath } from './shared.js';

/** A scene loaded from disk: its absolute path, the path as the user gave it, and the parsed file. */
export interface LoadedScene {
  abs: string;
  ref: string;
  scene: SceneFile;
}

/** Read and parse a scene document, throwing {@link DiagnosticError} (exit 2) if it is invalid. */
export function loadScene(ctx: CommandContext, rel: string): LoadedScene {
  const abs = resolvePath(ctx.io, rel);
  const text = readText(abs, ctx.io);
  const parsed = parseScene(text, rel);
  if (!parsed.ok || !parsed.value) throw new DiagnosticError(parsed.diagnostics);
  return { abs, ref: rel, scene: parsed.value };
}

/** The base registry the harness always installs, before any plugin components. */
export function baseRegistry(): ComponentRegistry {
  return createRegistry(Transform, Name, Sprite, Model, Light, Health, Trigger, Dead, Triggered);
}

/** The registry a run will actually have: base components plus the plugin's. */
export function registryFor(plugin: ModePlugin): ComponentRegistry {
  const registry = baseRegistry();
  registry.registerAll(plugin.components());
  return registry;
}

/** Reject a plugin whose mode disagrees with the scene (or with an explicit `--mode`). */
function checkModeAgreement(resolved: ResolvedPlugin, sceneMode: string, flagMode?: string): void {
  const expected = flagMode ?? sceneMode;
  if (resolved.plugin.mode === expected) return;
  throw new AegisCliError(
    CliCode.PluginModeMismatch,
    `Plugin ${describePluginSource(resolved)} is a "${resolved.plugin.mode}" plugin, but ${
      flagMode !== undefined
        ? `--mode ${flagMode} was given`
        : `the scene declares mode "${sceneMode}"`
    }.`,
    {
      fix: `Point --plugin at a "${expected}" plugin, or drop the mismatching ${flagMode !== undefined ? '--mode' : '--plugin'}.`,
      data: {
        pluginMode: resolved.plugin.mode,
        sceneMode,
        ...(flagMode !== undefined ? { flagMode } : {}),
      },
    },
  );
}

/**
 * Resolve the plugin a simulating command should run, with provenance.
 *
 * Precedence: `--plugin` → the nearest `aegis.json` above the scene → the stock plugin for
 * `--mode`/the scene's mode.
 */
export async function resolveRunPlugin(
  ctx: CommandContext,
  scene: SceneFile,
  sceneAbs: string,
  options: {
    specOverride?: string;
    overrideSource?: ResolvedPlugin['source'];
    overrideBaseDirs?: readonly string[];
  } = {},
): Promise<ResolvedPlugin> {
  const { args, io } = ctx;
  const flagMode = flagString(args, 'mode');
  const flagSpec = flagString(args, 'plugin');
  const spec = flagSpec ?? options.specOverride;

  if (spec !== undefined) {
    const source = flagSpec !== undefined ? 'flag' : (options.overrideSource ?? 'flag');
    const baseDirs =
      flagSpec !== undefined ? [io.cwd] : (options.overrideBaseDirs ?? [io.cwd, dirname(sceneAbs)]);
    const resolved: ResolvedPlugin = {
      plugin: await loadPlugin(spec, baseDirs, ctx.modes),
      spec,
      source,
    };
    checkModeAgreement(resolved, scene.mode, flagMode);
    return resolved;
  }

  const discovered = discoverPluginSpec(dirname(sceneAbs));
  if (discovered) {
    const resolved: ResolvedPlugin = {
      plugin: await loadPlugin(discovered.spec, [discovered.baseDir], ctx.modes),
      spec: discovered.spec,
      source: 'config',
      configFile: discovered.file,
    };
    checkModeAgreement(resolved, scene.mode, flagMode);
    return resolved;
  }

  const modeName = flagMode ?? scene.mode;
  return { plugin: ctx.modes.resolve(modeName), spec: modeName, source: 'mode' };
}

/**
 * Refuse to simulate a scene whose components the resolved plugin does not register.
 *
 * `instantiateScene` reports an unknown component as a diagnostic and carries on, which is how a
 * game scene run under a *stock* mode plugin produced a clean, hashed, successful run of a world
 * missing half its components. Validating against the exact registry the run will use turns that
 * into a loud, coded failure that names the fix.
 */
function assertComponentsRegistered(
  scene: SceneFile,
  sceneRef: string,
  resolved: ResolvedPlugin,
): void {
  const validated = validateScene(scene, { registry: registryFor(resolved.plugin) });
  const errors = validated.diagnostics.filter((d: Diagnostic) => d.severity === 'error');
  if (errors.length === 0) return;

  const unknown = [
    ...new Set(
      errors
        .map((d) => (d.data as { component?: unknown } | undefined)?.component)
        .filter((c): c is string => typeof c === 'string'),
    ),
  ].sort();

  const detail = errors
    .slice(0, 5)
    .map((d) => `  ${d.code} ${d.location?.path ?? ''}: ${d.message}`.trimEnd())
    .join('\n');

  throw new AegisCliError(
    CliCode.SceneNotRunnable,
    `Scene "${sceneRef}" cannot run under plugin ${describePluginSource(resolved)} — ` +
      `${errors.length} component(s) it uses are not registered by that plugin:\n${detail}`,
    {
      fix:
        `A game ships a composed ModePlugin (the mode plugin plus its own components and systems); ` +
        `the stock "${resolved.plugin.mode}" plugin does not know ${unknown.length > 0 ? unknown.map((c) => `"${c}"`).join(', ') : 'these components'}. ` +
        `Pass --plugin <module>#<export> (e.g. --plugin @aegis/game-iso#serverVaultPlugin), ` +
        `or drop an aegis.json next to the game with { "plugin": "@aegis/game-iso#serverVaultPlugin" }. ` +
        `Running anyway would simulate a world with those components missing and report success.`,
      exitCode: 2,
      data: {
        scene: sceneRef,
        plugin: resolved.spec,
        pluginSource: resolved.source,
        mode: resolved.plugin.mode,
        unknownComponents: unknown,
        diagnostics: errors,
      },
    },
  );
}

/**
 * Refuse a run whose plugin was **defaulted** rather than resolved, when the scene speaks a
 * vocabulary that default does not know.
 *
 * This closes the one hole no content check can reach. A game's iso vocabulary — `Operative`,
 * `Guard`, `Patrol` — is declared as **tags**, and `@aegis/content` validates component ids
 * against the registry but deliberately does *not* validate tags, because free-form markers are
 * legal by design. So the iso PoC scene validates perfectly against the stock iso plugin and used
 * to run to a clean, hashed exit 0 with an empty event log — its entire semantic layer silently
 * absent. Printing which plugin ran makes that visible, but a correct line of output an agent
 * skips past is a record, not a control.
 *
 * So the rule is about *confidence*, not about tags: if nobody said which plugin to run, and the
 * scene needs vocabulary the guess does not provide, the CLI will not guess. It is deliberately
 * scoped to `source === 'mode'` — an explicit `--plugin` or `aegis.json` is the operator taking
 * responsibility, including `{ "plugin": "iso" }` to mean "stock really is what I want".
 *
 * ## This check was removed once and reinstated — don't re-litigate it without reading this
 *
 * The objection was that it makes the CLI enforce a content rule `@aegis/content` declines to
 * enforce, since tags are free-form by design. That objection is sound *about tags* and wrong
 * about this check: it never claims an unregistered tag is invalid. The scene is valid — it is
 * valid **under the right plugin**, and nobody said which. Refusing is the CLI declining to
 * assert confidence it does not have, which is a statement about its own position rather than
 * about the content.
 *
 * What settled it: `exit 0` with an empty event log is a false green in the agent's primary
 * interface. A report mitigates that only for a reader who notices, and an agent parsing an exit
 * code does not notice — it has no peripheral vision. Restoring cost near zero because
 * `aegis scaffold game` writes an `aegis.json`, all three shipped games declare one, and any
 * explicit naming bypasses the check entirely; it fires on nothing that previously worked.
 */
function assertPluginResolved(scene: SceneFile, sceneRef: string, resolved: ResolvedPlugin): void {
  if (resolved.source !== 'mode') return;
  const registry = registryFor(resolved.plugin);
  const markers = [...sceneTags(scene)].filter((tag) => !registry.has(tag)).sort();
  if (markers.length === 0) return;

  const mode = resolved.plugin.mode;
  throw new AegisCliError(
    CliCode.PluginNotResolved,
    `Refusing to run "${sceneRef}": no plugin was named for it, and it declares ${markers.length} marker(s) the default "${mode}" mode plugin does not provide: ${markers.join(', ')}.`,
    {
      fix:
        `No registered system reads those markers, so this run would exercise the "${mode}" mode alone and still exit 0 — the exact silent failure this check exists to prevent. ` +
        `Name the plugin: --plugin <module>#<export> (e.g. --plugin @aegis/game-${mode}#myGamePlugin), ` +
        `or declare it once beside the scene in aegis.json: { "plugin": "@aegis/game-${mode}#myGamePlugin" } — ` +
        `\`aegis scaffold game\` writes that file for you. ` +
        `If the stock "${mode}" mode genuinely is what you want, say so with { "plugin": "${mode}" } and the markers become yours to consume.`,
      exitCode: 2,
      data: {
        scene: sceneRef,
        mode,
        pluginSource: resolved.source,
        unregisteredMarkers: markers,
      },
    },
  );
}

/**
 * Everything that must hold before a scene is simulated: its components must be registered by the
 * plugin that will run, and that plugin must have been *chosen* rather than defaulted into when
 * the scene needs more than the default provides.
 */
export function assertSceneRunnable(
  scene: SceneFile,
  sceneRef: string,
  resolved: ResolvedPlugin,
): void {
  assertComponentsRegistered(scene, sceneRef, resolved);
  assertPluginResolved(scene, sceneRef, resolved);
}

/** Count events by type into a Map (used for greppable histograms and JSON). */

/**
 * What a run is *actually made of*: the systems that will execute, and any marker the scene uses
 * that the resolved plugin does not register.
 *
 * The iso failure could not be caught by the component check, because a game's vocabulary there is
 * **tags** (`Operative`, `Guard`, `Patrol`) — and a scene tag is free-form by design, so an
 * unregistered one cannot be an error. But it is never *nothing*: a marker no plugin provides is a
 * marker no system reads. Reporting it, next to the system count, is what turns "clean run, no
 * events" from an unfalsifiable claim into a statement an agent can check.
 */
export interface RunComposition {
  /** Number of systems in the resolved schedule. */
  systemCount: number;
  /** Their names, in execution order. */
  systemNames: readonly string[];
  /** Scene markers (tags) no registered component type backs, sorted. */
  unregisteredMarkers: readonly string[];
}

/** Every tag used anywhere in a scene, including nested children. */
function sceneTags(scene: SceneFile): Set<string> {
  const tags = new Set<string>();
  const visit = (entities: readonly EntityDecl[] | undefined): void => {
    for (const entity of entities ?? []) {
      for (const tag of entity.tags ?? []) tags.add(tag);
      visit(entity.children);
    }
  };
  visit(scene.entities);
  return tags;
}

/** Describe what will really run, so "which systems executed" is data rather than an assumption. */
export function composeRun(scene: SceneFile, plugin: ModePlugin): RunComposition {
  const registry = registryFor(plugin);
  const systems = plugin.systems().resolved();
  const unregisteredMarkers = [...sceneTags(scene)].filter((tag) => !registry.has(tag)).sort();
  return {
    systemCount: systems.length,
    systemNames: systems.map((s) => s.name),
    unregisteredMarkers,
  };
}

/**
 * The report line naming markers the running plugin does not provide. `undefined` when there are
 * none. Printed by every simulating command, because this is the only signal that distinguishes
 * "the game ran" from "the stock mode ran over the game's scene".
 */
export function markerReport(composition: RunComposition): string | undefined {
  const markers = composition.unregisteredMarkers;
  if (markers.length === 0) return undefined;
  return [
    `markers  : ${markers.join(', ')}`,
    `           ^ no registered plugin provides these, so no system reads them. That is expected`,
    `             for markers your own systems will consume; if they belong to a game whose systems`,
    `             should be running, pass --plugin <module>#<export> or add an aegis.json beside`,
    `             the scene.`,
  ].join('\n');
}

export function eventCounts(events: EventReader): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events.history()) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return counts;
}

/** Event counts as a plain, canonical-JSON-friendly record. */
export function eventCountsObject(events: EventReader): Record<string, number> {
  return Object.fromEntries(eventCounts(events));
}

/** Produce the semantic frame, mapping a not-yet-implemented mode view to {@link CliCode.ViewUnavailable}. */
export function frameOf(
  result: SimResult,
  mode: string,
  tick?: number,
  options?: ViewOptions,
): SemanticFrame {
  try {
    return result.frame(tick, options);
  } catch (err) {
    if (err instanceof AegisCliError) throw err;
    throw new AegisCliError(
      CliCode.ViewUnavailable,
      `Mode "${mode}" cannot produce a semantic frame: ${messageOf(err)}`,
      { fix: `The ${mode} view provider may not be implemented yet.`, cause: err },
    );
  }
}

/** The resource ids present in a world, sorted — the evidence behind an "no ASCII view" report. */
function resourceIds(world: World): string[] {
  return Object.keys(world.snapshot().resources).sort();
}

/**
 * Resources that look like a grid but have no cells (`width` or `height` of 0).
 *
 * This is the actual cause of a missing 2D ASCII view: a mode's `init` bakes an *empty* grid
 * when the scene declares no tilemap, and the view provider then has nothing to rasterise.
 * Naming the empty grid turns a vague "no ASCII view" into a specific, fixable fact.
 */
function emptyGridResources(world: World): string[] {
  const resources = world.snapshot().resources;
  return Object.keys(resources)
    .filter((id) => {
      const value = resources[id] as { width?: unknown; height?: unknown } | undefined;
      if (typeof value !== 'object' || value === null) return false;
      const { width, height } = value;
      if (typeof width !== 'number' || typeof height !== 'number') return false;
      return width === 0 || height === 0;
    })
    .sort();
}

/** The scene-side fix for a missing grid, phrased in the mode's own resource vocabulary. */
const GRID_HINT =
  'A 2D ASCII view rasterises the collision/nav grid a mode bakes from authored level data. ' +
  'Embed it in the scene\'s "resources" — "platformer.tilemap": { "aegis": "tilemap/1", … } for ' +
  'platformer, "IsoGrid": { … } for iso, "fps.floorplan": { … } for fps — then re-run.';

/**
 * Produce the ASCII view, or an actionable {@link CliCode.ViewUnavailable} error.
 *
 * A `ViewProvider` returns `undefined` both when the mode has no ASCII projection *at all* and
 * when this particular world lacks the grid it would rasterise. Reporting the first when the
 * truth is the second ("mode platformer has no ASCII view") sends an agent off to rewrite the
 * mode when the real problem is a scene with no tilemap. So we look at the world and say which.
 */
export function asciiOf(result: SimResult, mode: string, tick?: number, world?: World): AsciiView {
  let view: AsciiView | undefined;
  try {
    view = result.ascii(tick);
  } catch (err) {
    throw new AegisCliError(
      CliCode.ViewUnavailable,
      `Mode "${mode}" cannot produce an ASCII view: ${messageOf(err)}`,
      { fix: `The ${mode} view provider may not be implemented yet.`, cause: err },
    );
  }
  if (view) return view;

  const at = `at tick ${tick ?? result.tick}`;
  const resources = world ? resourceIds(world) : undefined;
  const empty = world ? emptyGridResources(world) : [];

  const [firstEmpty] = empty;
  if (firstEmpty !== undefined) {
    throw new AegisCliError(
      CliCode.ViewUnavailable,
      `No ASCII view for THIS WORLD — not for the "${mode}" mode: the view provider produced none ${at} because the grid it rasterises is empty (${empty.map((id) => `"${id}"`).join(', ')} has a zero width or height).`,
      {
        fix: `${GRID_HINT} The mode baked an empty grid because the scene declares no level data for it.`,
        data: {
          mode,
          tick: tick ?? result.tick,
          emptyGridResources: empty,
          ...(resources !== undefined ? { worldResources: resources } : {}),
          cause: 'world-grid-is-empty',
        },
      },
    );
  }

  if (resources !== undefined && resources.length === 0) {
    throw new AegisCliError(
      CliCode.ViewUnavailable,
      `No ASCII view for THIS WORLD — not for the "${mode}" mode: the view provider produced none ${at}, and the world holds no resources at all, so there is no grid to rasterise.`,
      {
        fix: `${GRID_HINT} Use --view frame / --frame for a view that needs no grid.`,
        data: {
          mode,
          tick: tick ?? result.tick,
          worldResources: resources,
          cause: 'world-has-no-resources',
        },
      },
    );
  }

  throw new AegisCliError(
    CliCode.ViewUnavailable,
    `No ASCII view for this run: the "${mode}" view provider produced none ${at}${
      resources !== undefined
        ? ` for a world holding ${resources.length} resource(s): ${resources.join(', ')}`
        : ''
    }. None of those is an empty grid, so this mode most likely provides no ASCII projection at all.`,
    {
      fix: `Use --view frame / --frame — the semantic frame is available for every mode.${resources !== undefined && resources.length > 0 ? ` If you expected ASCII, check that one of ${resources.join(', ')} is the grid this mode rasterises.` : ''}`,
      data: {
        mode,
        tick: tick ?? result.tick,
        ...(resources !== undefined ? { worldResources: resources } : {}),
        cause: 'provider-returned-none',
      },
    },
  );
}

/**
 * `aegis inspect` — the agent's debugging surface (CHARTER principles 4, 7 & 9).
 *
 * Advance a scene to a tick, then *see* it without a GPU: dump world state (every entity and its
 * components as canonical JSON), filter entities with a query, print the structured semantic
 * frame, or print the ASCII view. This is how an agent answers "what is actually in the world,
 * and where is everything?" purely from text — including *which plugin* produced that world.
 * @packageDocumentation
 */
import { canonicalStringify } from '@aegis/core';
import { runScene } from '@aegis/harness';
import type { RunOptions } from '@aegis/harness';
import { Exit } from '../errors.js';
import {
  formatAscii,
  formatEntity,
  formatFields,
  formatFrame,
  entityParts,
  json,
} from '../format.js';
import { describeQuery, parseQuery } from '../query.js';
import type { Command, CommandContext } from '../command.js';
import { describePluginSource } from '../plugin.js';
import {
  flagBool,
  flagChoice,
  flagSeed,
  flagString,
  flagTicks,
  readText,
  requirePositional,
  resolvePath,
} from './shared.js';
import { assertSceneRunnable, asciiOf, frameOf, loadScene, resolveRunPlugin } from './sim.js';

const VIEWS = ['world', 'frame', 'ascii'] as const;

const USAGE = [
  'aegis inspect <scene> [options]',
  '',
  'Advance a scene to a tick and inspect it as data — the primary headless debugging tool.',
  '',
  '  --tick <n>        Advance to tick <n> before inspecting (default: 0 = initial state).',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --plugin <spec>   Plugin to run: <module>#<export>, a package, or a mode name.',
  '  --input <file>    Input-script (.input DSL) to drive the run.',
  '  --seed <value>    PRNG seed override.',
  '  --max-ticks <n>   Raise the tick ceiling (default: 1000000).',
  '  --view <kind>     world | frame | ascii (default: world).',
  '  --query <expr>    Filter the world dump, e.g. "has:Player none:Dead" (world view).',
  '  --json            Emit as JSON.',
  '',
  'Examples:',
  '  aegis inspect level1.scene.json --tick 60',
  '  aegis inspect level1.scene.json --tick 60 --query "has:Enemy" --json',
  '  aegis inspect level1.scene.json --tick 60 --view ascii',
  '  aegis inspect level1.scene.json --view frame --json',
].join('\n');

/** `aegis inspect` — dump world/frame/entity state at a given tick for debugging. */
export const inspectCommand: Command = {
  name: 'inspect',
  summary: 'Inspect world, semantic frame or ASCII view at a tick.',
  usage: USAGE,
  flags: {
    tick: 'value',
    mode: 'value',
    plugin: 'value',
    input: 'value',
    seed: 'value',
    'max-ticks': 'value',
    view: 'value',
    query: 'value',
  },
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const sceneArg = requirePositional(args, 0, 'scene', 'aegis inspect <scene>');
    const tick = flagTicks(args, 'tick', false);
    const view = flagChoice(args, 'view', VIEWS, 'world');
    const loaded = loadScene(ctx, sceneArg);
    const resolved = await resolveRunPlugin(ctx, loaded.scene, loaded.abs);
    assertSceneRunnable(loaded.scene, loaded.ref, resolved);
    const modeName = resolved.plugin.mode;

    // Only the final tick is inspected, so per-tick hashes would be retained and never read.
    const options: RunOptions = { plugin: resolved.plugin, ticks: tick, captureTickHashes: false };
    const seed = flagSeed(args);
    if (seed !== undefined) options.seed = seed;
    const inputFile = flagString(args, 'input');
    if (inputFile !== undefined) options.input = readText(resolvePath(io, inputFile), io);

    const result = await runScene(loaded.scene, options);
    const wantJson = flagBool(args, 'json');

    if (view === 'frame') {
      const frame = frameOf(result, modeName);
      io.out(wantJson ? json(frame) : formatFrame(frame) + '\n');
      return Exit.Ok;
    }
    if (view === 'ascii') {
      const ascii = asciiOf(result, modeName, undefined, result.world);
      io.out(wantJson ? json(ascii) : formatAscii(ascii) + '\n');
      return Exit.Ok;
    }

    // world view
    const snapshot = result.world.snapshot();
    const descriptor = parseQuery(flagString(args, 'query') ?? '');
    const selected = new Set<number>(
      result
        .query(descriptor)
        .entities()
        .map((e) => Number(e)),
    );
    const entities = snapshot.entities.filter((e) => selected.has(Number(e.id)));

    if (wantJson) {
      const jsonEntities = entities.map((e) => ({ ...e, ...entityParts(Number(e.id)) }));
      io.out(
        json({
          scene: loaded.ref,
          mode: modeName,
          plugin: { spec: resolved.spec, source: resolved.source },
          tick: result.tick,
          seed: result.seed,
          hash: result.hash,
          query: flagString(args, 'query') ?? null,
          matched: entities.length,
          total: snapshot.entities.length,
          entities: jsonEntities,
          resources: snapshot.resources,
        }),
      );
      return Exit.Ok;
    }

    const lines: string[] = [
      formatFields([
        ['scene', loaded.ref],
        ['mode', modeName],
        ['plugin', describePluginSource(resolved)],
        ['tick', String(result.tick)],
        ['seed', String(result.seed)],
        ['hash', result.hash],
      ]),
      `query: ${describeQuery(descriptor)}`,
      `entities: ${entities.length} of ${snapshot.entities.length}`,
    ];
    for (const e of entities) {
      lines.push(`${formatEntity(Number(e.id))}${e.name !== undefined ? ` "${e.name}"` : ''}`);
      const ids = Object.keys(e.components).sort();
      for (const id of ids) lines.push(`  ${id} = ${canonicalStringify(e.components[id])}`);
    }
    const resourceIds = Object.keys(snapshot.resources).sort();
    if (resourceIds.length > 0) {
      lines.push('resources:');
      for (const id of resourceIds) {
        lines.push(`  ${id} = ${canonicalStringify(snapshot.resources[id])}`);
      }
    }
    io.out(lines.join('\n') + '\n');
    return Exit.Ok;
  },
};

/**
 * `aegis run` — simulate a scene headlessly for N ticks under an optional input script, and
 * report the outcome as data (CHARTER principles 6 & 9).
 *
 * Determinism is exposed, not hidden: the seed used, **the plugin that actually ran** and the
 * final state hash are always printed, so a run can be reproduced exactly — and so an agent can
 * see whether a game's own systems were installed or only the stock mode's.
 * `--frame`/`--ascii` let an agent "see" the final state without a GPU.
 * @packageDocumentation
 */
import { runScene } from '@aegis/harness';
import type { RunOptions } from '@aegis/harness';
import { Exit } from '../errors.js';
import { formatAscii, formatEventHistogram, formatFields, formatFrame, json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import { describePluginSource } from '../plugin.js';
import {
  flagBool,
  flagSeed,
  flagString,
  flagTicks,
  readText,
  requirePositional,
  resolvePath,
} from './shared.js';
import {
  assertSceneRunnable,
  asciiOf,
  composeRun,
  eventCounts,
  eventCountsObject,
  frameOf,
  loadScene,
  markerReport,
  resolveRunPlugin,
} from './sim.js';

const USAGE = [
  'aegis run <scene> --ticks <n> [options]',
  '',
  'Simulate a scene headlessly and report the result as data.',
  '',
  '  --ticks <n>       Number of ticks to simulate (required, >= 0).',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --plugin <spec>   Plugin to run: <module>#<export>, a package, or a mode name.',
  '                    A game ships a composed ModePlugin; without this you get the stock mode.',
  '  --input <file>    Input-script (.input DSL) to drive the run.',
  '  --seed <value>    PRNG seed override (all-digits → number, else string).',
  '  --max-ticks <n>   Raise the tick ceiling (default: 1000000).',
  '  --hash            Print ONLY the final state hash (for scripting).',
  '  --frame           Also print the final semantic frame.',
  '  --ascii           Also print the final ASCII view.',
  '  --json            Emit the whole result as JSON.',
  '',
  'Examples:',
  '  aegis run level1.scene.json --ticks 120',
  '  aegis run level1.scene.json --ticks 120 --input walk-right.input --json',
  '  aegis run games/iso/levels/server-vault.scene.json --ticks 960 \\',
  '    --plugin games/iso/dist/server-vault.js#serverVaultPlugin',
  '  HASH=$(aegis run level1.scene.json --ticks 120 --hash)',
].join('\n');

/** `aegis run` — simulate a scene headlessly for N ticks under an input script. */
export const runCommand: Command = {
  name: 'run',
  summary: 'Simulate a scene headlessly for a number of ticks.',
  usage: USAGE,
  flags: {
    ticks: 'value',
    mode: 'value',
    plugin: 'value',
    input: 'value',
    seed: 'value',
    'max-ticks': 'value',
    hash: 'boolean',
    frame: 'boolean',
    ascii: 'boolean',
  },
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const sceneArg = requirePositional(args, 0, 'scene', 'aegis run <scene> --ticks <n>');
    const ticks = flagTicks(args);
    const loaded = loadScene(ctx, sceneArg);
    const resolved = await resolveRunPlugin(ctx, loaded.scene, loaded.abs);
    assertSceneRunnable(loaded.scene, loaded.ref, resolved);
    const composition = composeRun(loaded.scene, resolved.plugin);
    const modeName = resolved.plugin.mode;

    // `run` only ever reports the FINAL hash, so asking the harness to retain one string per
    // tick is pure waste — and unbounded: it is what turned a large --ticks into a V8 OOM.
    const options: RunOptions = { plugin: resolved.plugin, ticks, captureTickHashes: false };
    const seed = flagSeed(args);
    if (seed !== undefined) options.seed = seed;
    const inputFile = flagString(args, 'input');
    if (inputFile !== undefined) options.input = readText(resolvePath(io, inputFile), io);

    const result = await runScene(loaded.scene, options);

    // --hash: emit just the bare hash, nothing else (scriptable capture). A marker warning still
    // goes to stderr, so capturing the hash never silently discards the reason it may be wrong.
    if (flagBool(args, 'hash') && !flagBool(args, 'json')) {
      const warning = markerReport(composition);
      if (warning !== undefined) io.err(warning + '\n');
      io.out(result.hash + '\n');
      return Exit.Ok;
    }

    const entities = result.query({ has: [] }).count();

    if (flagBool(args, 'json')) {
      const frame = flagBool(args, 'frame') ? frameOf(result, modeName) : undefined;
      const ascii = flagBool(args, 'ascii')
        ? asciiOf(result, modeName, undefined, result.world)
        : undefined;
      io.out(
        json({
          scene: loaded.ref,
          mode: modeName,
          plugin: {
            spec: resolved.spec,
            source: resolved.source,
            systems: composition.systemNames,
          },
          unregisteredMarkers: composition.unregisteredMarkers,
          ticks: result.tick,
          seed: result.seed,
          hash: result.hash,
          entities,
          events: eventCountsObject(result.events),
          ...(frame ? { frame } : {}),
          ...(ascii ? { ascii } : {}),
        }),
      );
      return Exit.Ok;
    }

    const blocks: string[] = [
      formatFields([
        ['scene', loaded.ref],
        ['mode', modeName],
        ['plugin', describePluginSource(resolved)],
        ['systems', String(composition.systemCount)],
        ['ticks', String(result.tick)],
        ['seed', String(result.seed)],
        ['hash', result.hash],
        ['entities', String(entities)],
      ]),
      'events:',
      formatEventHistogram(eventCounts(result.events)),
    ];
    const warning = markerReport(composition);
    if (warning !== undefined) blocks.push(warning);
    if (flagBool(args, 'frame')) blocks.push(formatFrame(frameOf(result, modeName)));
    if (flagBool(args, 'ascii')) {
      blocks.push(formatAscii(asciiOf(result, modeName, undefined, result.world)));
    }
    io.out(blocks.join('\n') + '\n');
    return Exit.Ok;
  },
};

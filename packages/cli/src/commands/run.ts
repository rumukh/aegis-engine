/**
 * `aegis run` — simulate a scene headlessly for N ticks under an optional input script, and
 * report the outcome as data (CHARTER principles 6 & 9).
 *
 * Determinism is exposed, not hidden: the seed used and the final state hash are always printed,
 * so a run can be reproduced exactly from what the CLI shows. `--frame`/`--ascii` let an agent
 * "see" the final state without a GPU.
 * @packageDocumentation
 */
import { runScene } from '@aegis/harness';
import type { RunOptions } from '@aegis/harness';
import { Exit } from '../errors.js';
import { formatAscii, formatEventHistogram, formatFields, formatFrame, json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import {
  flagBool,
  flagInt,
  flagSeed,
  flagString,
  readText,
  requirePositional,
  resolvePath,
} from './shared.js';
import {
  asciiOf,
  eventCounts,
  eventCountsObject,
  frameOf,
  loadScene,
  resolvePlugin,
} from './sim.js';

const USAGE = [
  'aegis run <scene> --ticks <n> [options]',
  '',
  'Simulate a scene headlessly and report the result as data.',
  '',
  '  --ticks <n>       Number of ticks to simulate (required, >= 0).',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --input <file>    Input-script (.input DSL) to drive the run.',
  '  --seed <value>    PRNG seed override (all-digits → number, else string).',
  '  --hash            Print ONLY the final state hash (for scripting).',
  '  --frame           Also print the final semantic frame.',
  '  --ascii           Also print the final ASCII view (2D modes).',
  '  --json            Emit the whole result as JSON.',
  '',
  'Examples:',
  '  aegis run level1.scene.json --ticks 120',
  '  aegis run level1.scene.json --ticks 120 --input walk-right.input --json',
  '  HASH=$(aegis run level1.scene.json --ticks 120 --hash)',
].join('\n');

/** `aegis run` — simulate a scene headlessly for N ticks under an input script. */
export const runCommand: Command = {
  name: 'run',
  summary: 'Simulate a scene headlessly for a number of ticks.',
  usage: USAGE,
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const sceneArg = requirePositional(args, 0, 'scene', 'aegis run <scene> --ticks <n>');
    const ticks = flagInt(args, 'ticks', { required: true, min: 0 }) as number;
    const loaded = loadScene(ctx, sceneArg);
    const modeName = flagString(args, 'mode') ?? loaded.scene.mode;
    const plugin = resolvePlugin(ctx, loaded.scene, flagString(args, 'mode'));

    const options: RunOptions = { plugin, ticks };
    const seed = flagSeed(args);
    if (seed !== undefined) options.seed = seed;
    const inputFile = flagString(args, 'input');
    if (inputFile !== undefined) options.input = readText(resolvePath(io, inputFile), io);

    const result = await runScene(loaded.scene, options);

    // --hash: emit just the bare hash, nothing else (scriptable capture).
    if (flagBool(args, 'hash') && !flagBool(args, 'json')) {
      io.out(result.hash + '\n');
      return Exit.Ok;
    }

    const entities = result.query({ has: [] }).count();

    if (flagBool(args, 'json')) {
      const frame = flagBool(args, 'frame') ? frameOf(result, modeName) : undefined;
      const ascii = flagBool(args, 'ascii') ? asciiOf(result, modeName) : undefined;
      io.out(
        json({
          scene: loaded.ref,
          mode: modeName,
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
        ['ticks', String(result.tick)],
        ['seed', String(result.seed)],
        ['hash', result.hash],
        ['entities', String(entities)],
      ]),
      'events:',
      formatEventHistogram(eventCounts(result.events)),
    ];
    if (flagBool(args, 'frame')) blocks.push(formatFrame(frameOf(result, modeName)));
    if (flagBool(args, 'ascii')) blocks.push(formatAscii(asciiOf(result, modeName)));
    io.out(blocks.join('\n') + '\n');
    return Exit.Ok;
  },
};

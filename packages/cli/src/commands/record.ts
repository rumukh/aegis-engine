/**
 * `aegis record` — run a scene and write a portable, human-readable {@link Recording} to disk
 * (CHARTER principle 5). The recording pins the seed, tick count, input DSL and the final state
 * hash (plus per-tick hashes), so `aegis replay` can prove the run reproduces bit-for-bit.
 * @packageDocumentation
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { runScene, serializeRecording } from '@aegis/harness';
import type { RunOptions } from '@aegis/harness';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { formatFields, json } from '../format.js';
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
import { loadScene, resolvePlugin } from './sim.js';

const USAGE = [
  'aegis record <scene> --out <file> --ticks <n> [options]',
  '',
  'Run a scene and write a *.replay.json recording that replays deterministically.',
  '',
  '  --out <file>      Where to write the recording (required).',
  '  --ticks <n>       Number of ticks to record (required, >= 0).',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --input <file>    Input-script (.input DSL) to drive the run.',
  '  --seed <value>    PRNG seed override.',
  '  --force           Overwrite <file> if it already exists.',
  '  --json            Emit the record summary as JSON.',
  '',
  'Examples:',
  '  aegis record level1.scene.json --out run.replay.json --ticks 120',
  '  aegis record level1.scene.json --out run.replay.json --ticks 120 --input walk.input',
].join('\n');

/** `aegis record` — run a scene and write a replay recording. */
export const recordCommand: Command = {
  name: 'record',
  summary: 'Run a scene and write a replay recording.',
  usage: USAGE,
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const sceneArg = requirePositional(
      args,
      0,
      'scene',
      'aegis record <scene> --out <file> --ticks <n>',
    );
    const outArg = flagString(args, 'out');
    if (outArg === undefined) {
      throw new AegisCliError(CliCode.MissingArgument, 'Flag --out is required.', {
        fix: 'Pass --out <file> (e.g. --out run.replay.json).',
      });
    }
    const ticks = flagInt(args, 'ticks', { required: true, min: 0 }) as number;
    const outAbs = resolvePath(io, outArg);
    if (existsSync(outAbs) && !flagBool(args, 'force')) {
      throw new AegisCliError(CliCode.OutputExists, `Output already exists: ${outArg}`, {
        fix: 'Choose a different --out path, or pass --force to overwrite.',
        exitCode: Exit.Error,
      });
    }

    const loaded = loadScene(ctx, sceneArg);
    const modeName = flagString(args, 'mode') ?? loaded.scene.mode;
    const plugin = resolvePlugin(ctx, loaded.scene, flagString(args, 'mode'));

    const options: RunOptions = { plugin, ticks };
    const seed = flagSeed(args);
    if (seed !== undefined) options.seed = seed;
    const inputFile = flagString(args, 'input');
    if (inputFile !== undefined) options.input = readText(resolvePath(io, inputFile), io);

    const result = await runScene(loaded.scene, options);
    // Keep the scene reference the user gave (a portable, relative path) rather than the
    // scene's logical name, so `aegis replay` can locate the scene again.
    const recording = { ...result.recording(), scene: loaded.ref };

    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, serializeRecording(recording), 'utf8');

    if (flagBool(args, 'json')) {
      io.out(
        json({
          recording: outArg,
          scene: loaded.ref,
          mode: modeName,
          ticks: result.tick,
          seed: result.seed,
          hash: result.hash,
        }),
      );
      return Exit.Ok;
    }
    io.out(
      formatFields([
        ['recording', outArg],
        ['scene', loaded.ref],
        ['mode', modeName],
        ['ticks', String(result.tick)],
        ['seed', String(result.seed)],
        ['hash', result.hash],
      ]) + '\n',
    );
    return Exit.Ok;
  },
};

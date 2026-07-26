/**
 * `aegis record` — run a scene and write a portable, human-readable {@link Recording} to disk
 * (CHARTER principle 5). The recording pins the seed, tick count, input DSL and the final state
 * hash (plus per-tick hashes), so `aegis replay` can prove the run reproduces bit-for-bit.
 *
 * It also records **which plugin ran**, as an extra top-level `plugin` key. A recording that
 * cannot say which systems produced its hash is not reproducible in practice: replaying a game's
 * recording under the stock mode plugin would report a determinism failure that is really a
 * missing-plugin failure. `parseRecording` ignores unknown keys, so the frozen `Recording`
 * contract is untouched.
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
import { assertSceneRunnable, loadScene, resolveRunPlugin } from './sim.js';

const USAGE = [
  'aegis record <scene> --out <file> --ticks <n> [options]',
  '',
  'Run a scene and write a *.replay.json recording that replays deterministically.',
  '',
  '  --out <file>      Where to write the recording (required).',
  '  --ticks <n>       Number of ticks to record (required, >= 0).',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --plugin <spec>   Plugin to run: <module>#<export>, a package, or a mode name.',
  '                    Stored in the recording so `aegis replay` reuses it automatically.',
  '  --input <file>    Input-script (.input DSL) to drive the run.',
  '  --seed <value>    PRNG seed override.',
  '  --max-ticks <n>   Raise the tick ceiling (default: 1000000).',
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
  flags: {
    out: 'value',
    ticks: 'value',
    mode: 'value',
    plugin: 'value',
    input: 'value',
    seed: 'value',
    'max-ticks': 'value',
    force: 'boolean',
  },
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
    const ticks = flagTicks(args);
    const outAbs = resolvePath(io, outArg);
    if (existsSync(outAbs) && !flagBool(args, 'force')) {
      throw new AegisCliError(CliCode.OutputExists, `Output already exists: ${outArg}`, {
        fix: 'Choose a different --out path, or pass --force to overwrite.',
        exitCode: Exit.Error,
      });
    }

    const loaded = loadScene(ctx, sceneArg);
    const resolved = await resolveRunPlugin(ctx, loaded.scene, loaded.abs);
    assertSceneRunnable(loaded.scene, loaded.ref, resolved);
    const modeName = resolved.plugin.mode;

    const options: RunOptions = { plugin: resolved.plugin, ticks };
    const seed = flagSeed(args);
    if (seed !== undefined) options.seed = seed;
    const inputFile = flagString(args, 'input');
    if (inputFile !== undefined) options.input = readText(resolvePath(io, inputFile), io);

    const result = await runScene(loaded.scene, options);
    // Keep the scene reference the user gave (a portable, relative path) rather than the
    // scene's logical name, so `aegis replay` can locate the scene again.
    const recording = { ...result.recording(), scene: loaded.ref };

    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, withPluginKey(serializeRecording(recording), resolved.spec), 'utf8');

    if (flagBool(args, 'json')) {
      io.out(
        json({
          recording: outArg,
          scene: loaded.ref,
          mode: modeName,
          plugin: { spec: resolved.spec, source: resolved.source },
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
        ['plugin', describePluginSource(resolved)],
        ['ticks', String(result.tick)],
        ['seed', String(result.seed)],
        ['hash', result.hash],
      ]) + '\n',
    );
    return Exit.Ok;
  },
};

/**
 * Add the `plugin` key to serialised recording text, immediately after `scene`.
 *
 * Done by re-serialising rather than by string surgery, and with a fixed key order, so two
 * recordings of the same run stay byte-identical (the harness's own guarantee).
 */
function withPluginKey(text: string, spec: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    ordered[key] = parsed[key];
    if (key === 'scene') ordered['plugin'] = spec;
  }
  if (ordered['plugin'] === undefined) ordered['plugin'] = spec;
  return JSON.stringify(ordered, null, 2) + '\n';
}

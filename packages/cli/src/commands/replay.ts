/**
 * `aegis replay` — re-run a {@link Recording} and verify it reproduces the pinned state hash
 * (CHARTER principle 5). A mismatch is a determinism bug; the command reports the first divergent
 * tick (from the recorded per-tick hashes) and exits non-zero so CI/agents can catch regressions.
 * @packageDocumentation
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseRecording, runScene } from '@aegis/harness';
import type { RunOptions } from '@aegis/harness';
import type { StateHash } from '@aegis/core';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { formatAscii, formatFields, formatFrame, json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import { flagBool, flagString, readText, requirePositional, resolvePath } from './shared.js';
import { asciiOf, frameOf, resolvePlugin } from './sim.js';
import { parseScene } from '@aegis/content';
import { DiagnosticError } from '@aegis/core';

const USAGE = [
  'aegis replay <recording> [options]',
  '',
  'Replay a *.replay.json recording and verify it reproduces its pinned state hash.',
  '',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --no-verify       Replay without failing on a hash mismatch (still reports it).',
  '  --frame           Also print the final semantic frame.',
  '  --ascii           Also print the final ASCII view (2D modes).',
  '  --json            Emit the replay result as JSON.',
  '',
  'Verification is ON by default. Exit codes: 0 = hash matched, 1 = mismatch (a determinism bug).',
  '',
  'Examples:',
  '  aegis replay run.replay.json',
  '  aegis replay run.replay.json --json',
  '  aegis replay run.replay.json --no-verify --frame',
].join('\n');

/** Locate the scene referenced by a recording: relative to cwd first, then to the recording. */
function resolveScenePath(
  io: CommandContext['io'],
  recordingAbs: string,
  sceneRef: string,
): string {
  const fromCwd = resolvePath(io, sceneRef);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRecording = resolve(dirname(recordingAbs), sceneRef);
  if (existsSync(fromRecording)) return fromRecording;
  throw new AegisCliError(
    CliCode.FileNotFound,
    `Scene "${sceneRef}" referenced by the recording was not found.`,
    {
      fix: `Looked in ${fromCwd} and ${fromRecording}. Run replay from the scene's directory, or move the files together.`,
      data: { sceneRef },
    },
  );
}

/** First tick whose replayed hash differs from the recorded one, if any. */
function firstDivergentTick(
  recorded: readonly StateHash[] | undefined,
  actual: readonly StateHash[],
): number | undefined {
  if (!recorded) return undefined;
  const n = Math.min(recorded.length, actual.length);
  for (let t = 0; t < n; t++) if (recorded[t] !== actual[t]) return t;
  return undefined;
}

/** `aegis replay` — replay a recording and verify it reproduces its state hash. */
export const replayCommand: Command = {
  name: 'replay',
  summary: 'Replay a recording and verify determinism.',
  usage: USAGE,
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const recordingArg = requirePositional(args, 0, 'recording', 'aegis replay <recording>');
    const recordingAbs = resolvePath(io, recordingArg);
    const recording = parseRecording(readText(recordingAbs, io));

    const sceneAbs = resolveScenePath(io, recordingAbs, recording.scene);
    const parsedScene = parseScene(readText(sceneAbs, io), recording.scene);
    if (!parsedScene.ok || !parsedScene.value) throw new DiagnosticError(parsedScene.diagnostics);
    const scene = parsedScene.value;
    const modeName = flagString(args, 'mode') ?? scene.mode;
    const plugin = resolvePlugin(ctx, scene, flagString(args, 'mode'));

    const options: RunOptions = { plugin, ticks: recording.ticks, seed: recording.seed };
    if (recording.input.length > 0) options.input = recording.input;
    const result = await runScene(scene, options);

    const matched = result.hash === recording.finalHash;
    const divergentTick = firstDivergentTick(recording.tickHashes, result.tickHashes);
    const verify = !(args.flags['no-verify'] === true || args.flags['verify'] === 'false');

    if (flagBool(args, 'json')) {
      const frame = flagBool(args, 'frame') ? frameOf(result, modeName) : undefined;
      const ascii = flagBool(args, 'ascii') ? asciiOf(result, modeName) : undefined;
      io.out(
        json({
          recording: recordingArg,
          scene: recording.scene,
          mode: modeName,
          ticks: recording.ticks,
          seed: recording.seed,
          expectedHash: recording.finalHash,
          actualHash: result.hash,
          match: matched,
          ...(divergentTick !== undefined ? { firstDivergentTick: divergentTick } : {}),
          ...(frame ? { frame } : {}),
          ...(ascii ? { ascii } : {}),
        }),
      );
    } else {
      const blocks: string[] = [
        formatFields([
          ['recording', recordingArg],
          ['scene', recording.scene],
          ['mode', modeName],
          ['ticks', String(recording.ticks)],
          ['seed', String(recording.seed)],
          ['expected', recording.finalHash],
          ['actual', result.hash],
          ['match', matched ? 'yes' : 'no'],
        ]),
      ];
      if (!matched && divergentTick !== undefined) {
        blocks.push(`first divergence at tick ${divergentTick}`);
      }
      if (flagBool(args, 'frame')) blocks.push(formatFrame(frameOf(result, modeName)));
      if (flagBool(args, 'ascii')) blocks.push(formatAscii(asciiOf(result, modeName)));
      io.out(blocks.join('\n') + '\n');
    }

    if (!matched && verify) {
      const where =
        divergentTick === undefined
          ? 'the final hash differs'
          : `first divergence at tick ${divergentTick}`;
      throw new AegisCliError(
        CliCode.ReplayMismatch,
        `Replay determinism check FAILED: expected ${recording.finalHash}, got ${result.hash} (${where}).`,
        {
          fix: 'A recording must replay identically. Check for non-determinism (wall-clock, Math.random, unstable iteration) in a system, or confirm the scene/mode has not changed since recording.',
          data: {
            expectedHash: recording.finalHash,
            actualHash: result.hash,
            ...(divergentTick !== undefined ? { firstDivergentTick: divergentTick } : {}),
          },
        },
      );
    }
    return Exit.Ok;
  },
};

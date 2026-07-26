/**
 * `aegis replay` — re-run a {@link Recording} and verify it reproduces the pinned state hash
 * (CHARTER principle 5). A mismatch is a determinism bug; the command reports the first divergent
 * tick (from the recorded per-tick hashes) and exits non-zero so CI/agents can catch regressions.
 *
 * The plugin is taken from the recording's `plugin` key when present (see `aegis record`), so a
 * game's recording replays against the systems that produced it. `--plugin` overrides.
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
import { describePluginSource } from '../plugin.js';
import { flagBool, readText, requirePositional, resolvePath } from './shared.js';
import {
  assertSceneRunnable,
  asciiOf,
  composeRun,
  frameOf,
  markerReport,
  resolveRunPlugin,
} from './sim.js';
import { parseScene } from '@aegis/content';
import { DiagnosticError } from '@aegis/core';

const USAGE = [
  'aegis replay <recording> [options]',
  '',
  'Replay a *.replay.json recording and verify it reproduces its pinned state hash.',
  '',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --plugin <spec>   Override the plugin recorded in the file (<module>#<export>).',
  '  --no-verify       Replay without failing on a hash mismatch (still reports it).',
  '  --frame           Also print the final semantic frame.',
  '  --ascii           Also print the final ASCII view.',
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

/**
 * First tick whose replayed hash differs from the recorded one, if any.
 *
 * The harness has an identical private helper (`harness/run.ts`); it is not exported, and the
 * harness is not ours to change. Flagged to the PM — once `firstDivergentTick` is exported this
 * copy should go.
 */
function firstDivergentTick(
  recorded: readonly StateHash[] | undefined,
  actual: readonly StateHash[],
): number | undefined {
  if (!recorded) return undefined;
  const n = Math.min(recorded.length, actual.length);
  for (let t = 0; t < n; t++) if (recorded[t] !== actual[t]) return t;
  return undefined;
}

/** The optional `plugin` spec `aegis record` writes alongside the frozen `Recording` fields. */
function recordedPluginSpec(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // parseRecording reports malformed JSON with a better message.
  }
  const value = (parsed as { plugin?: unknown } | null)?.plugin;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `aegis replay` — replay a recording and verify it reproduces its state hash. */
export const replayCommand: Command = {
  name: 'replay',
  summary: 'Replay a recording and verify determinism.',
  usage: USAGE,
  flags: {
    mode: 'value',
    plugin: 'value',
    'no-verify': 'boolean',
    verify: 'boolean',
    frame: 'boolean',
    ascii: 'boolean',
  },
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const recordingArg = requirePositional(args, 0, 'recording', 'aegis replay <recording>');
    const recordingAbs = resolvePath(io, recordingArg);
    const recordingText = readText(recordingAbs, io);
    const recording = parseRecording(recordingText);

    const sceneAbs = resolveScenePath(io, recordingAbs, recording.scene);
    const parsedScene = parseScene(readText(sceneAbs, io), recording.scene);
    if (!parsedScene.ok || !parsedScene.value) throw new DiagnosticError(parsedScene.diagnostics);
    const scene = parsedScene.value;

    const recordedSpec = recordedPluginSpec(recordingText);
    const resolved = await resolveRunPlugin(ctx, scene, sceneAbs, {
      ...(recordedSpec !== undefined ? { specOverride: recordedSpec } : {}),
      overrideSource: 'recording',
      // A recorded spec was written relative to the cwd of `aegis record`; fall back to the
      // recording's own directory so a recording stays replayable when it is moved with its game.
      overrideBaseDirs: [io.cwd, dirname(recordingAbs), dirname(sceneAbs)],
    });
    assertSceneRunnable(scene, recording.scene, resolved);
    const composition = composeRun(scene, resolved.plugin);
    const modeName = resolved.plugin.mode;

    const options: RunOptions = {
      plugin: resolved.plugin,
      ticks: recording.ticks,
      seed: recording.seed,
    };
    if (recording.input.length > 0) options.input = recording.input;
    const result = await runScene(scene, options);

    const matched = result.hash === recording.finalHash;
    const divergentTick = firstDivergentTick(recording.tickHashes, result.tickHashes);
    const verify = !(flagBool(args, 'no-verify') || args.flags['verify'] === 'false');

    if (flagBool(args, 'json')) {
      const frame = flagBool(args, 'frame') ? frameOf(result, modeName) : undefined;
      const ascii = flagBool(args, 'ascii')
        ? asciiOf(result, modeName, undefined, result.world)
        : undefined;
      io.out(
        json({
          recording: recordingArg,
          scene: recording.scene,
          mode: modeName,
          plugin: {
            spec: resolved.spec,
            source: resolved.source,
            systems: composition.systemNames,
          },
          unregisteredMarkers: composition.unregisteredMarkers,
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
          ['plugin', describePluginSource(resolved)],
          ['systems', String(composition.systemCount)],
          ['ticks', String(recording.ticks)],
          ['seed', String(recording.seed)],
          ['expected', recording.finalHash],
          ['actual', result.hash],
          ['match', matched ? 'yes' : 'no'],
        ]),
      ];
      const warning = markerReport(composition);
      if (warning !== undefined) blocks.push(warning);
      if (!matched && divergentTick !== undefined) {
        blocks.push(`first divergence at tick ${divergentTick}`);
      }
      if (flagBool(args, 'frame')) blocks.push(formatFrame(frameOf(result, modeName)));
      if (flagBool(args, 'ascii')) {
        blocks.push(formatAscii(asciiOf(result, modeName, undefined, result.world)));
      }
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
          fix: `A recording must replay identically. This run used plugin ${describePluginSource(resolved)} — check it is the same one that recorded the file, then look for non-determinism (wall-clock, Math.random, unstable iteration) in a system, or a changed scene/mode.`,
          data: {
            expectedHash: recording.finalHash,
            actualHash: result.hash,
            plugin: resolved.spec,
            pluginSource: resolved.source,
            ...(divergentTick !== undefined ? { firstDivergentTick: divergentTick } : {}),
          },
        },
      );
    }
    return Exit.Ok;
  },
};

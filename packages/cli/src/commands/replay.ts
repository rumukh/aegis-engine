/**
 * `aegis replay` — re-run a {@link Recording} and verify it reproduces everything the file pins
 * (CHARTER principle 5): the final state hash **and** the per-tick timeline. A mismatch is either
 * a determinism bug or a recording that no longer describes the run it claims to; the command
 * reports every discrepancy and exits non-zero so CI/agents catch it.
 *
 * Verification used to compare the final hash alone and read `tickHashes` only after that
 * comparison had failed, so a recording whose whole timeline had been zeroed — or truncated to
 * three of a hundred and twenty entries — replayed clean and exited 0.
 *
 * The plugin is taken from the recording's `plugin` key when present (see `aegis record`), so a
 * game's recording replays against the systems that produced it. `--plugin` overrides.
 * @packageDocumentation
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseRecording, recordingTickRate, runScene, verifyReplay } from '@aegis/harness';
import type { RunOptions } from '@aegis/harness';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { formatAscii, formatDiagnostics, formatFields, formatFrame, json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import { describePluginSource } from '../plugin.js';
import { flagBool, flagTickRate, readText, requirePositional, resolvePath } from './shared.js';
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
import type { Diagnostic } from '@aegis/core';

const USAGE = [
  'aegis replay <recording> [options]',
  '',
  'Replay a *.replay.json recording and verify it reproduces its pinned state hash.',
  '',
  "  --mode <mode>     platformer | iso | fps (default: the scene's mode).",
  '  --plugin <spec>   Override the plugin recorded in the file (<module>#<export>).',
  '  --tick-rate <hz>  Override the recorded rate (legacy files otherwise default to 60).',
  '  --no-verify       Replay without failing on a mismatch (still reports it).',
  '  --frame           Also print the final semantic frame.',
  '  --ascii           Also print the final ASCII view.',
  '  --json            Emit the replay result as JSON.',
  '',
  'Verification is ON by default and covers the final state hash AND the recorded per-tick',
  'timeline. Exit codes: 0 = everything the recording pinned was reproduced, 1 = it was not.',
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
    'tick-rate': 'value',
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
    const rateOverride = flagTickRate(args);
    const tickRate = rateOverride ?? recordingTickRate(recording);
    const tickRateSource =
      rateOverride !== undefined
        ? 'flag'
        : recording.tickRate !== undefined
          ? 'recording'
          : 'legacy-default';

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
      tickRate,
    };
    // A recording's script is the whole run, not a prefix of one, so a statement in it that has
    // no effect means the file was edited after it was written. `aegis run` deliberately stays
    // quiet about this (running a prefix of a playthrough is a first-class workflow); a replay
    // has no such excuse.
    const inputDiagnostics: Diagnostic[] = [];
    options.onInputDiagnostics = (d) => inputDiagnostics.push(...d);
    if (recording.input.length > 0) options.input = recording.input;
    const result = await runScene(scene, options);

    const verified = verifyReplay(recording, result);
    const matched = verified.finalHashMatched;
    const divergentTick = verified.firstDivergentTick;
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
          tickRate: result.tickRate,
          tickRateSource,
          seed: recording.seed,
          expectedHash: recording.finalHash,
          actualHash: result.hash,
          match: matched,
          verified: verified.ok,
          problems: verified.problems,
          unverified: verified.unverified,
          ...(inputDiagnostics.length > 0 ? { inputDiagnostics } : {}),
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
          ['tick rate', `${result.tickRate} (${tickRateSource})`],
          ['seed', String(recording.seed)],
          ['expected', recording.finalHash],
          ['actual', result.hash],
          ['match', matched ? 'yes' : 'no'],
          ['verified', verified.ok ? 'yes' : 'no'],
        ]),
      ];
      const warning = markerReport(composition);
      if (warning !== undefined) blocks.push(warning);
      if (verified.problems.length > 0) {
        blocks.push(
          [
            'the replay does not match the recording:',
            ...verified.problems.map((p) => `  - ${p}`),
          ].join('\n'),
        );
      }
      // Never let "checked and agreed" and "had nothing to check" print the same clean result.
      if (verified.unverified.length > 0) {
        blocks.push(
          ['not verified by this replay:', ...verified.unverified.map((u) => `  - ${u}`)].join(
            '\n',
          ),
        );
      }
      if (inputDiagnostics.length > 0) blocks.push(formatDiagnostics(inputDiagnostics));
      if (!matched && divergentTick !== undefined) {
        blocks.push(`first divergence at tick ${divergentTick}`);
      }
      if (flagBool(args, 'frame')) blocks.push(formatFrame(frameOf(result, modeName)));
      if (flagBool(args, 'ascii')) {
        blocks.push(formatAscii(asciiOf(result, modeName, undefined, result.world)));
      }
      io.out(blocks.join('\n') + '\n');
    }

    if (!verified.ok && verify) {
      const where =
        divergentTick === undefined
          ? 'the final hash differs'
          : `first divergence at tick ${divergentTick}`;
      throw new AegisCliError(
        CliCode.ReplayMismatch,
        `Replay verification FAILED (${verified.problems.length} discrepanc${verified.problems.length === 1 ? 'y' : 'ies'}): ` +
          verified.problems.join('; ') +
          (matched ? '.' : ` (${where}).`),
        {
          fix: `A recording must replay identically to what it pins. This run used plugin ${describePluginSource(resolved)} — check it is the same one that recorded the file, then look for non-determinism (wall-clock, Math.random, unstable iteration) in a system, a changed scene/mode, or a recording that was edited after it was written.`,
          data: {
            expectedHash: recording.finalHash,
            actualHash: result.hash,
            problems: verified.problems,
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

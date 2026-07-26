/**
 * The seven subcommands that make up the entire Aegis surface (CHARTER principle 8 — one CLI,
 * no GUI ever required). Each command's `usage` documents its intended behaviour precisely so
 * the implementing session has an unambiguous spec; the `run` bodies are stubs.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { Command } from './command.js';

/** `aegis run` — simulate a scene headlessly for N ticks under an input script. */
export const runCommand: Command = {
  name: 'run',
  summary: 'Simulate a scene headlessly for a number of ticks.',
  usage: [
    'aegis run <scene> [options]',
    '',
    '  --ticks <n>       Number of ticks to simulate (required).',
    '  --mode <mode>     platformer | iso | fps (default: from scene).',
    '  --input <file>    Input-script (.input) to drive the run.',
    '  --seed <value>    PRNG seed override.',
    '  --hash            Print the final deterministic state hash.',
    '  --frame           Print the final semantic frame as JSON.',
    '  --ascii           Print the final ASCII view (2D modes).',
  ].join('\n'),
  run: () => notImplemented('aegis run'),
};

/** `aegis test` — discover and run headless game tests, report pass/fail. */
export const testCommand: Command = {
  name: 'test',
  summary: 'Discover and run headless gameplay tests.',
  usage: [
    'aegis test [glob] [options]',
    '',
    '  --filter <substr>  Only run tests whose name contains <substr>.',
    '  --reporter <kind>  "tap" | "json" | "pretty" (default: pretty).',
  ].join('\n'),
  run: () => notImplemented('aegis test'),
};

/** `aegis inspect` — dump world/frame/entity state at a given tick for debugging. */
export const inspectCommand: Command = {
  name: 'inspect',
  summary: 'Inspect world, semantic frame or ASCII view at a tick.',
  usage: [
    'aegis inspect <scene> [options]',
    '',
    '  --tick <n>        Advance to tick <n> before inspecting (default: 0).',
    '  --input <file>    Input-script to drive the run.',
    '  --query <expr>    Only show entities matching the query.',
    '  --view <kind>     "world" | "frame" | "ascii" (default: world).',
  ].join('\n'),
  run: () => notImplemented('aegis inspect'),
};

/** `aegis validate` — validate a scene/prefab/tilemap document against the schema. */
export const validateCommand: Command = {
  name: 'validate',
  summary: 'Validate a scene/prefab/tilemap document.',
  usage: [
    'aegis validate <file...> [options]',
    '',
    '  --json            Emit diagnostics as JSON (stable error codes).',
    '  --strict          Treat warnings as errors.',
  ].join('\n'),
  run: () => notImplemented('aegis validate'),
};

/** `aegis record` — run a scene and write a replay recording. */
export const recordCommand: Command = {
  name: 'record',
  summary: 'Run a scene and write a replay recording.',
  usage: [
    'aegis record <scene> --out <file> [options]',
    '',
    '  --ticks <n>       Number of ticks to record (required).',
    '  --input <file>    Input-script to drive the run.',
    '  --seed <value>    PRNG seed override.',
  ].join('\n'),
  run: () => notImplemented('aegis record'),
};

/** `aegis replay` — replay a recording and verify it reproduces its state hash. */
export const replayCommand: Command = {
  name: 'replay',
  summary: 'Replay a recording and verify determinism.',
  usage: [
    'aegis replay <recording> [options]',
    '',
    '  --verify          Fail if the replayed state hash diverges (default: on).',
    '  --frame           Print the final semantic frame as JSON.',
  ].join('\n'),
  run: () => notImplemented('aegis replay'),
};

/** `aegis scaffold` — generate a new scene, prefab, mode or test from a template. */
export const scaffoldCommand: Command = {
  name: 'scaffold',
  summary: 'Generate a scene, prefab or test from a template.',
  usage: [
    'aegis scaffold <kind> <name> [options]',
    '',
    '  <kind>            "scene" | "prefab" | "tilemap" | "test".',
    '  --mode <mode>     Target mode for the generated artifact.',
    '  --force           Overwrite an existing file.',
  ].join('\n'),
  run: () => notImplemented('aegis scaffold'),
};

/** Every command, in help-display order. */
export const COMMANDS: readonly Command[] = [
  runCommand,
  testCommand,
  inspectCommand,
  validateCommand,
  recordCommand,
  replayCommand,
  scaffoldCommand,
];

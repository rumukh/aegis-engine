/**
 * The dispatcher: parse argv, select a {@link Command}, run it, and render any failure through
 * one uniform, actionable path (CHARTER principle 8).
 *
 * All game logic lives in the individual commands; this file only routes and reports. Failures
 * are mapped to stable exit codes: an {@link AegisCliError} carries its own `exitCode`, a
 * {@link DiagnosticError} (a scene/script that failed schema validation) exits `2`, and anything
 * else is a generic exit `1`. With `--json`, the error is emitted as a machine-readable object.
 * @packageDocumentation
 */
import { DiagnosticError } from '@aegis/core';
import { parseArgs } from './args.js';
import type { ParsedArgs } from './args.js';
import { COMMANDS } from './commands.js';
import type { Command } from './command.js';
import type { CliIO } from './io.js';
import { AegisCliError, Exit, formatCliError } from './errors.js';
import { formatDiagnostics, json } from './format.js';
import { defaultModeResolver } from './modes.js';
import type { ModeResolver } from './modes.js';

/** Injectable dependencies, so tests can substitute a fake mode resolver. */
export interface CliDeps {
  /** Resolves mode names to plugins. Defaults to the three shipped `@aegis/mode-*` plugins. */
  modes: ModeResolver;
}

/** Find a registered command by name. */
export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Render the top-level help text. */
export function topLevelHelp(): string {
  const width = COMMANDS.reduce((w, c) => Math.max(w, c.name.length), 0);
  const lines = [
    'aegis — the agent-first, headless game engine CLI',
    '',
    'Usage: aegis <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    "Run 'aegis <command> --help' for command-specific usage.",
    'Add --json to most commands for machine-readable output.',
  ];
  return lines.join('\n');
}

/** Whether `--json` was requested. */
function wantsJson(args: ParsedArgs): boolean {
  return args.flags['json'] === true;
}

/** Report a failure to stderr, as JSON when requested, and return its exit code. */
function reportError(io: CliIO, args: ParsedArgs, error: unknown): number {
  if (error instanceof AegisCliError) {
    if (wantsJson(args)) {
      io.err(
        json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.fix !== undefined ? { fix: error.fix } : {}),
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
        }),
      );
    } else {
      io.err(formatCliError(error) + '\n');
    }
    return error.exitCode;
  }
  if (error instanceof DiagnosticError) {
    if (wantsJson(args)) {
      io.err(json({ diagnostics: error.diagnostics }));
    } else {
      io.err(formatDiagnostics(error.diagnostics) + '\n');
    }
    return Exit.Validation;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (wantsJson(args)) io.err(json({ error: { message } }));
  else io.err(`error: ${message}\n`);
  return Exit.Error;
}

/**
 * Parse `io.argv`, dispatch to the matching command, and return its exit code.
 *
 * - No command, `--help`, or `-h` → print top-level help, return `0`.
 * - `<command> --help` → print that command's usage, return `0`.
 * - Unknown command → error to stderr, return `1`.
 * - Otherwise → run the command and return its exit code; a thrown {@link AegisCliError} or
 *   {@link DiagnosticError} is rendered actionably and mapped to its exit code.
 */
export async function main(io: CliIO, deps?: CliDeps): Promise<number> {
  const resolved: CliDeps = deps ?? { modes: defaultModeResolver() };
  const [name, ...rest] = io.argv;

  if (name === undefined || name === '--help' || name === '-h') {
    io.out(topLevelHelp() + '\n');
    return 0;
  }

  const command = findCommand(name);
  if (!command) {
    io.err(`Unknown command: ${name}\n\n`);
    io.err(topLevelHelp() + '\n');
    return 1;
  }

  const args = parseArgs(rest);
  if (args.flags['help'] === true || args.flags['h'] === true) {
    io.out(command.usage + '\n');
    return 0;
  }

  try {
    return await command.run({ args, io, modes: resolved.modes });
  } catch (error) {
    return reportError(io, args, error);
  }
}

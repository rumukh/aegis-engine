/**
 * The dispatcher: parse argv, select a {@link Command}, run it, and render any failure through
 * one uniform, actionable path (CHARTER principle 8).
 *
 * All game logic lives in the individual commands; this file only routes and reports. Failures
 * are mapped to stable exit codes: an {@link AegisCliError} carries its own `exitCode`, a
 * {@link DiagnosticError} (a scene/script that failed schema validation) exits `2`, and anything
 * else is a generic exit `1`. With `--json`, the error is emitted as a machine-readable object —
 * including an unknown *command*, which is why argv is parsed before the command is looked up.
 * @packageDocumentation
 */
import { DiagnosticError } from '@aegis/core';
import { GLOBAL_FLAGS, parseArgs, suggestFlag } from './args.js';
import type { FlagSpec, ParsedArgs } from './args.js';
import { COMMANDS } from './commands.js';
import type { Command } from './command.js';
import type { CliIO } from './io.js';
import { AegisCliError, CliCode, Exit, formatCliError } from './errors.js';
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

/** Whether `--json` was requested (`--json` or `--json=true`). */
function wantsJson(args: ParsedArgs): boolean {
  const value = args.flags['json'];
  return value === true || value === 'true';
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

/** Closest command name to `name`, for a did-you-mean on an unknown command. */
function suggestCommand(name: string): string | undefined {
  const lower = name.toLowerCase();
  return COMMANDS.map((c) => c.name).find((c) => c.startsWith(lower) || lower.startsWith(c));
}

/**
 * Reject undeclared flags and declared value-flags that were given no value.
 *
 * Silently ignoring `--asci` is the worst possible behaviour: the command succeeds, exits `0`,
 * and simply never does the thing that was asked for.
 */
function checkFlags(args: ParsedArgs, spec: FlagSpec, command: string): void {
  const [firstUnknown] = args.unknown;
  if (firstUnknown !== undefined) {
    const suggestion = suggestFlag(firstUnknown, spec);
    const known = Object.keys(spec)
      .filter((f) => f.length > 1)
      .sort();
    throw new AegisCliError(
      CliCode.UnknownFlag,
      `Unknown flag --${firstUnknown} for 'aegis ${command}'.`,
      {
        fix:
          (suggestion !== undefined ? `Did you mean --${suggestion}? ` : '') +
          `Known flags: ${known.map((f) => `--${f}`).join(', ')}. Run 'aegis ${command} --help'.`,
        data: {
          flag: firstUnknown,
          unknown: args.unknown,
          known,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
      },
    );
  }
  const [firstMissing] = args.missingValues;
  if (firstMissing !== undefined) {
    throw new AegisCliError(CliCode.InvalidFlagValue, `Flag --${firstMissing} needs a value.`, {
      fix: `Pass a value, e.g. --${firstMissing} <value> or --${firstMissing}=<value>.`,
      data: { flag: firstMissing },
    });
  }
}

/**
 * Parse `io.argv`, dispatch to the matching command, and return its exit code.
 *
 * - No command, `--help`, or `-h` → print top-level help, return `0`.
 * - `<command> --help` → print that command's usage, return `0`.
 * - Unknown command → {@link CliCode.UnknownCommand} on stderr (JSON under `--json`), return `1`.
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
    // Parse permissively first: an unknown command with `--json` must still answer in JSON.
    const globalArgs = parseArgs(rest, GLOBAL_FLAGS);
    const suggestion = suggestCommand(name);
    return reportError(
      io,
      globalArgs,
      new AegisCliError(CliCode.UnknownCommand, `Unknown command: ${name}`, {
        fix:
          (suggestion !== undefined ? `Did you mean 'aegis ${suggestion}'? ` : '') +
          `Available commands: ${COMMANDS.map((c) => c.name).join(', ')}.`,
        data: {
          command: name,
          available: COMMANDS.map((c) => c.name),
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
      }),
    );
  }

  const spec: FlagSpec = { ...GLOBAL_FLAGS, ...command.flags };
  const args = parseArgs(rest, spec);
  if (args.flags['help'] === true || args.flags['h'] === true) {
    io.out(command.usage + '\n');
    return 0;
  }

  try {
    checkFlags(args, spec, command.name);
    return await command.run({ args, io, modes: resolved.modes });
  } catch (error) {
    return reportError(io, args, error);
  }
}

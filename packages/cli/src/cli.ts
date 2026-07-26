/**
 * The dispatcher: parse argv, select a {@link Command}, and run it. This is plumbing — it is
 * implemented so `aegis --help` and unknown-command handling work in the skeleton — but it
 * contains no game logic; every real command body is a stub.
 * @packageDocumentation
 */
import { parseArgs } from './args.js';
import { COMMANDS } from './commands.js';
import type { Command } from './command.js';
import type { CliIO } from './io.js';

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
  ];
  return lines.join('\n');
}

/**
 * Parse `io.argv`, dispatch to the matching command, and return its exit code.
 *
 * - No command, `--help`, or `-h` → print top-level help, return `0`.
 * - `<command> --help` → print that command's usage, return `0`.
 * - Unknown command → error to stderr, return `1`.
 * - Otherwise → run the command and return its exit code; a thrown error (including the
 *   `notImplemented` stubs) is caught, reported to stderr, and mapped to exit code `1`.
 */
export async function main(io: CliIO): Promise<number> {
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
    return await command.run({ args, io });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`error: ${message}\n`);
    return 1;
  }
}

/**
 * The seven subcommands that make up the entire Aegis surface (CHARTER principle 9 — one CLI,
 * no GUI ever required). Each command lives in its own module under `commands/`; this file
 * assembles them into the registry the dispatcher walks, and re-exports each for tests.
 * @packageDocumentation
 */
import type { Command } from './command.js';
import { runCommand } from './commands/run.js';
import { testCommand } from './commands/test.js';
import { inspectCommand } from './commands/inspect.js';
import { validateCommand } from './commands/validate.js';
import { recordCommand } from './commands/record.js';
import { replayCommand } from './commands/replay.js';
import { scaffoldCommand } from './commands/scaffold.js';

export { runCommand } from './commands/run.js';
export { testCommand } from './commands/test.js';
export { inspectCommand } from './commands/inspect.js';
export { validateCommand } from './commands/validate.js';
export { recordCommand } from './commands/record.js';
export { replayCommand } from './commands/replay.js';
export { scaffoldCommand } from './commands/scaffold.js';

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

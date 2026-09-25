/**
 * The subcommands that make up the entire Aegis surface (CHARTER principle 9 — one CLI,
 * no GUI ever required). Each command lives in its own module under `commands/`; this file
 * assembles them into the registry the dispatcher walks, and re-exports each for tests.
 * @packageDocumentation
 */
import type { Command } from './command.js';
import { runCommand } from './commands/run.js';
import { testCommand } from './commands/test.js';
import { inspectCommand } from './commands/inspect.js';
import { validateCommand, VALIDATION_FORMATS } from './commands/validate.js';
import { recordCommand } from './commands/record.js';
import { replayCommand } from './commands/replay.js';
import { scaffoldCommand } from './commands/scaffold.js';
import { createDescribeCommand } from './commands/describe.js';
import { previewCommand } from './commands/preview.js';
import { importCommand } from './commands/import.js';

export { runCommand } from './commands/run.js';
export { testCommand } from './commands/test.js';
export { inspectCommand } from './commands/inspect.js';
export { validateCommand } from './commands/validate.js';
export { recordCommand } from './commands/record.js';
export { replayCommand } from './commands/replay.js';
export { scaffoldCommand } from './commands/scaffold.js';
export { previewCommand, createPreviewCommand } from './commands/preview.js';
export { importCommand } from './commands/import.js';

/** Capability discovery reads this same live registry, including its own registration. */
export const describeCommand = createDescribeCommand(() => COMMANDS);

/** Every command, in help-display order. */
export const COMMANDS: readonly Command[] = [
  {
    ...runCommand,
    formats: { reads: ['scene/1', 'input-script'], writes: [], stdout: ['text', 'json'] },
  },
  {
    ...testCommand,
    formats: {
      reads: ['game-test-module', 'aegis.json', 'scene/1', 'input-script'],
      writes: [],
      stdout: ['pretty', 'tap', 'json'],
    },
  },
  {
    ...inspectCommand,
    formats: { reads: ['scene/1', 'input-script'], writes: [], stdout: ['text', 'json'] },
  },
  {
    ...describeCommand,
    formats: { reads: ['scene/1', 'aegis.json'], writes: [], stdout: ['text', 'capabilities/1'] },
  },
  {
    ...validateCommand,
    formats: {
      reads: VALIDATION_FORMATS,
      writes: [],
      stdout: ['text', 'json'],
    },
  },
  previewCommand,
  importCommand,
  {
    ...recordCommand,
    formats: {
      reads: ['scene/1', 'input-script'],
      writes: ['recording/1'],
      stdout: ['text', 'json'],
    },
  },
  {
    ...replayCommand,
    formats: { reads: ['recording/1', 'scene/1'], writes: [], stdout: ['text', 'json'] },
  },
  {
    ...scaffoldCommand,
    formats: {
      reads: [],
      writes: [
        'scene/1',
        'prefab/1',
        'tilemap/1',
        'input-script',
        'game-test-module',
        'aegis.json',
      ],
      stdout: ['text', 'json'],
    },
  },
];

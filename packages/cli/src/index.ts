/**
 * `@aegis/cli` — the single command-line surface for Aegis: `run`, `test`, `inspect`,
 * `validate`, `record`, `replay`, `scaffold`. This barrel exposes the programmatic API
 * (dispatcher, command registry, IO seam, arg parser) so the CLI can be embedded and tested;
 * the executable entry point lives in `main.ts`.
 * @packageDocumentation
 */
export * from './io.js';
export * from './args.js';
export * from './command.js';
export * from './commands.js';
export * from './cli.js';

/**
 * The Server Vault's discovery entry point for `aegis test`.
 *
 * `aegis test` runs, by default, every `GameTest` exported by any compiled module matching
 * any `*.gametest.js` / `.mjs` / `.cjs` module. This game's playthroughs are defined in `server-vault.ts`, which
 * is also the package's main entry (the renderer imports `serverVaultPlugin` from it), so it
 * cannot be renamed without churning every consumer. This module supplies the conventional name
 * instead: two lines, no logic, and the iso PoC becomes part of the CLI gate.
 *
 * That matters more than it looks. Before it, `aegis test` discovered the platformer alone and
 * exited 0 with a green summary — a gate covering one of three PoCs, which reads as coverage and
 * is therefore a worse signal than the empty result it replaced. The discovery guard in
 * `games/platformer/test` now fails if any game stops being discoverable, including a fourth
 * one added later.
 *
 * The vitest runner in `test/` imports the tests from `server-vault.ts` directly; both paths lead
 * to the same two objects.
 * @packageDocumentation
 */
export { default as serverVault, serverVaultDeathTest } from './server-vault.js';

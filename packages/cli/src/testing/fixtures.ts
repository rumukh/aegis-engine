/**
 * Throwaway working directories for the CLI's own end-to-end tests.
 *
 * The fixtures must live **inside this package**, not in the OS temp dir: generated `*.gametest.mjs`
 * modules import `@aegis/harness` by bare specifier, which only resolves from a directory inside
 * the workspace.
 *
 * That makes cleanup load-bearing. `afterEach` handles the normal case, but a test that kills its
 * worker — the pre-fix reproduction of the `--ticks` out-of-memory defect does exactly that —
 * never runs it, and the orphan then fails `prettier --check` and shows up as untracked in
 * `git status`, which reads like a broken branch. So every run also sweeps orphans left by
 * previous runs: the mess is self-healing rather than something a human has to know about.
 *
 * ## Why the prefix is per-worker
 * The sweep runs at module load, and Vitest loads several test files **in parallel workers**. With
 * one shared prefix, the second file's sweep deleted the first file's *live* fixtures mid-test —
 * observed as `Cannot find module …/good.gametest.mjs` from a run whose glob had found the file
 * moments earlier, in a test that had passed a hundred times before. Namespacing by
 * `VITEST_WORKER_ID` (falling back to the pid) means a sweep can only ever reach directories from
 * an earlier run of the *same* worker slot, which is exactly the set it was written to collect.
 * @packageDocumentation
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root — where the built `dist/` the tests reach for lives. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where scratch directories live: **inside the repository's `node_modules`**.
 *
 * They were created directly under `PACKAGE_ROOT`, which put transient directories in the middle
 * of `packages/`, and that is a source tree other tests *walk*. `golden-hash.invariant.test.ts`
 * recurses every directory under `packages/` and `games/` that is not `node_modules`, `dist` or
 * `coverage`; a fixture directory matched none of those, so the walker would `readdir` the parent,
 * see a fixture, and `readdir` the child **after** its owning test had deleted it:
 *
 * ```
 * Error: ENOENT: no such file or directory, scandir '…/packages/cli/aegis-clitest-02uq7a'
 * ```
 *
 * A harness invariant test dying inside a CLI test's scratch directory. That is a different race
 * from the one the per-worker prefix fixed — this one is between a walker's `readdir` of a parent
 * and its `readdir` of the child, and no naming scheme can prevent it.
 *
 * `node_modules` fixes it structurally, for every walker that exists and every one written later:
 * both repo walkers are rooted at `packages/` and `games/`, so the repository's `node_modules` is
 * never entered at all, and `node_modules` is *additionally* in their skip sets. It is git-ignored
 * and not linted, so an orphan can no longer break `prettier --check` or show up as untracked.
 * Module resolution still works — verified, not assumed: a `.mjs` file here resolves `@aegis/harness`
 * and `@aegis/core`, because the ancestor walk reaches `<repo>/node_modules`, which is exactly where
 * the workspace links live. That resolution is why fixtures had to be inside the repo in the first
 * place, and it is preserved.
 *
 * The root `node_modules` rather than `packages/cli/node_modules`: npm hoists this workspace, so
 * `packages/cli/node_modules` **does not exist** after `npm ci` (measured) and would have to be
 * invented.
 */
const FIXTURE_ROOT = resolve(PACKAGE_ROOT, '..', '..', 'node_modules', '.aegis-clitest');

/** Shared prefix for every fixture directory, so orphans are identifiable and sweepable. */
const PREFIX = `aegis-clitest-w${process.env['VITEST_WORKER_ID'] ?? String(process.pid)}-`;

/** Where a fixture directory will be created. Exported so tests can assert on the location. */
export function fixtureRoot(): string {
  return FIXTURE_ROOT;
}

/** Remove fixture directories orphaned by an earlier run (e.g. one whose worker was killed). */
export function sweepStaleFixtures(): void {
  let entries: string[];
  try {
    entries = readdirSync(FIXTURE_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(PREFIX))
      rmSync(join(FIXTURE_ROOT, entry), { recursive: true, force: true });
  }
}

/** Create a fresh fixture directory and return its absolute path. */
export function makeFixtureDir(): string {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  return mkdtempSync(join(FIXTURE_ROOT, PREFIX));
}

/** Remove a fixture directory, ignoring one that is already gone. */
export function removeFixtureDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

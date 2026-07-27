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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root — fixtures are created here so bare `@aegis/*` specifiers resolve. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Shared prefix for every fixture directory, so orphans are identifiable and sweepable. */
const PREFIX = `aegis-clitest-w${process.env['VITEST_WORKER_ID'] ?? String(process.pid)}-`;

/** Remove fixture directories orphaned by an earlier run (e.g. one whose worker was killed). */
export function sweepStaleFixtures(): void {
  let entries: string[];
  try {
    entries = readdirSync(PACKAGE_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(PREFIX))
      rmSync(join(PACKAGE_ROOT, entry), { recursive: true, force: true });
  }
}

/** Create a fresh fixture directory and return its absolute path. */
export function makeFixtureDir(): string {
  return mkdtempSync(join(PACKAGE_ROOT, PREFIX));
}

/** Remove a fixture directory, ignoring one that is already gone. */
export function removeFixtureDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

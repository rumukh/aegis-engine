/**
 * A fixture sweep must not be able to reach a directory another worker is using.
 *
 * `sweepStaleFixtures()` runs at **module scope**, so Vitest fires it the moment a worker loads
 * each test file — and three files in this package call it. With a single shared prefix it matched
 * on the one thing every fixture directory has in common by design, so whichever file loaded last
 * deleted the live scratch directories of the ones already running. `mkdtempSync` gives each case a
 * unique path; the uniqueness was irrelevant, because the sweep matched the prefix.
 *
 * Measured on the pre-fix code, two processes, no simulation of the sweep itself:
 *
 * ```
 * A created  : aegis-clitest-TYjXSi   file exists: true
 * B said     : B swept                    <- B only LOADED a sibling test module
 * A file still exists after B loaded a sibling test file: FALSE
 * ```
 *
 * The symptom was a `packages/cli` test failing **fast** (~125-200 ms, not a timeout) because a
 * file the glob had listed moments earlier was gone; always two files at once, never the same pair,
 * never outside this package, and green in isolation — where the three files load within ~24 ms of
 * one another, before any of them has created a fixture, so the sweep finds nothing to destroy.
 * It ran at roughly 25% of full-suite runs on a 16-core machine.
 *
 * The fix namespaces the prefix per worker, so a sweep can only ever reach directories from an
 * earlier run of the **same worker slot** — which is exactly the set it was written to collect, so
 * the self-healing property that justifies the sweep is kept. Both halves are asserted below: it
 * must not reach another worker's live directory, **and** it must still collect its own orphan. A
 * "fix" that merely disabled the sweeper would pass the first test and fail the second.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFixtureDir, PACKAGE_ROOT, removeFixtureDir, sweepStaleFixtures } from './fixtures.js';

/** The built module a *different worker* would load — the real code, not a re-implementation. */
const FIXTURES_DIST = join(PACKAGE_ROOT, 'dist', 'testing', 'fixtures.js');

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Run `code` in a real child process with `VITEST_WORKER_ID` set to `worker`. */
function asWorker(worker: string, code: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, VITEST_WORKER_ID: worker },
  });
}

describe('a fixture sweep cannot reach another worker’s live directory', () => {
  it('needs the built fixtures module, which is what another worker would load', () => {
    // Precondition, not decoration: if this path were wrong the child below would exit non-zero
    // and the "directory survived" assertion would pass for the wrong reason.
    expect(
      existsSync(FIXTURES_DIST),
      `${FIXTURES_DIST} is missing — run \`npm run build\` (\`npm run verify\` builds first)`,
    ).toBe(true);
  });

  it('leaves a live directory alone when another worker loads a test file', () => {
    const dir = makeFixtureDir();
    created.push(dir);
    const marker = join(dir, 'live.gametest.mjs');
    writeFileSync(marker, 'export default {};\n', 'utf8');
    expect(existsSync(marker)).toBe(true);

    const other = asWorker(
      'sweep-probe',
      `const m = await import(${JSON.stringify(`file:///${FIXTURES_DIST.replace(/\\/g, '/')}`)});
       m.sweepStaleFixtures();`,
    );
    expect(other.status, other.stderr).toBe(0);

    // Red against the single-shared-prefix version: the child's sweep deleted this file.
    expect(
      existsSync(marker),
      'another worker merely LOADING a sibling test file deleted this run’s live fixture',
    ).toBe(true);
  });

  /**
   * The other half. The sweep exists because a test that kills its own worker never runs
   * `afterEach`, and the orphan then fails `prettier --check` and shows up as untracked. Disabling
   * the sweeper would satisfy the test above and quietly reintroduce that.
   */
  it('still collects an orphan left by an earlier run of its own slot', () => {
    const orphan = makeFixtureDir();
    writeFileSync(join(orphan, 'left-behind.txt'), 'x', 'utf8');
    expect(existsSync(orphan)).toBe(true);

    sweepStaleFixtures();

    expect(existsSync(orphan), 'the sweeper stopped collecting its own orphans').toBe(false);
  });

  it('names directories so that one worker’s prefix cannot match another’s', () => {
    const a = makeFixtureDir();
    created.push(a);
    const probe = asWorker(
      'sweep-probe',
      `const m = await import(${JSON.stringify(`file:///${FIXTURES_DIST.replace(/\\/g, '/')}`)});
       const d = m.makeFixtureDir();
       process.stdout.write(d.slice(m.PACKAGE_ROOT.length));
       m.removeFixtureDir(d);`,
    );
    expect(probe.status, probe.stderr).toBe(0);

    const mine = a.slice(PACKAGE_ROOT.length);
    const theirs = probe.stdout.trim();
    // Both are `aegis-clitest-…`; what matters is that each carries its own worker's identity, so
    // neither falls inside the other's sweep prefix.
    expect(theirs).not.toBe(mine);
    expect(theirs).toContain('sweep-probe');
    expect(mine).not.toContain('sweep-probe');
  });

  it('leaves nothing of its own behind', () => {
    // Cheap guard on the guard: this file must not become a source of the orphans it is about.
    const before = readdirSync(PACKAGE_ROOT).filter((e) => e.startsWith('aegis-clitest-'));
    const dir = join(PACKAGE_ROOT, 'aegis-clitest-selfcheck');
    mkdirSync(dir, { recursive: true });
    removeFixtureDir(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(PACKAGE_ROOT).filter((e) => e.startsWith('aegis-clitest-'))).toEqual(before);
  });
});

/**
 * Controls for the test-run audit.
 *
 * The audit's whole job is to refuse a run that did not happen, so the only evidence that
 * matters is watching it refuse each shape that has actually occurred on CI, and watching it
 * *accept* a clean one. Without the accepting arm every case below would be satisfied by an
 * auditor that refuses everything, which is a different way of learning nothing.
 *
 * The three shapes marked MEASURED were produced by `windows-latest` on runs 30323223392 and
 * 30324264768 against trees `d5487e8` and `747653f`, and every one of them was reported green.
 *
 * These drive the real CLI as a subprocess rather than importing a function, because the CLI
 * is what `npm run test` actually invokes — including its argument handling and its exit codes,
 * which are the parts that were trusted and should not have been.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const auditor = join(root, 'scripts', 'audit-test-report.mjs');

/**
 * Fixtures live under the repository's own `node_modules` on purpose: it is in the skip set of
 * every repo-walking test here and is git-ignored, so a fixture can never be mistaken for a
 * stray artifact or crash an unrelated walker. Same reasoning as the CLI fixture relocation.
 */
const fixtureRoot = join(root, 'node_modules', '.aegis-audit-fixtures');

/** A report describing a full, clean run — the shape everything else is a mutation of. */
function cleanReport(): Record<string, unknown> {
  return {
    numTotalTestSuites: 300,
    numFailedTestSuites: 0,
    numTotalTests: 960,
    numPassedTests: 960,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: Array.from({ length: 70 }, (_unused, index) => ({
      name: `file-${String(index)}.test.ts`,
    })),
  };
}

function runAudit(report: Record<string, unknown> | undefined, name: string, ...args: string[]) {
  const path = join(fixtureRoot, `${name}.json`);
  if (report !== undefined) writeFileSync(path, JSON.stringify(report), 'utf8');
  const result = spawnSync(process.execPath, [auditor, path, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeAll(() => {
  mkdirSync(fixtureRoot, { recursive: true });
});
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('the test-run audit refuses a run that cannot be shown to have happened', () => {
  it('accepts a clean full run — without this arm, every refusal below proves nothing', () => {
    const { status, output } = runAudit(cleanReport(), 'clean');
    expect(output).toContain('70 files / 960 tests');
    expect(status).toBe(0);
  });

  it('MEASURED shape 2: refuses failing tests even though vitest exited 0', () => {
    const { status, output } = runAudit(
      { ...cleanReport(), numFailedTests: 8, numPassedTests: 952 },
      'failed',
    );
    expect(status).toBe(1);
    expect(output).toContain('8 test(s) failed');
  });

  it('MEASURED shape 3: refuses SKIPPED tests, which is how a dead beforeAll reads as green', () => {
    const { status, output } = runAudit(
      { ...cleanReport(), numPendingTests: 9, numPassedTests: 951 },
      'skipped',
    );
    expect(status).toBe(1);
    expect(output).toContain('9 test(s) were SKIPPED');
    // The diagnosis matters as much as the refusal: the next person to see this needs to be
    // pointed at the hook, not sent looking for a test that says `.skip`.
    expect(output).toContain('beforeAll');
  });

  it('refuses a report whose own success flag is false while every counter reads clean', () => {
    const { status, output } = runAudit({ ...cleanReport(), success: false }, 'unsuccessful');
    expect(status).toBe(1);
    expect(output).toContain('success flag is false');
  });

  it('refuses a run whose corpus collapsed, by file count and by test count independently', () => {
    const fewFiles = { ...cleanReport(), testResults: [{ name: 'only.test.ts' }] };
    const fewFilesResult = runAudit(fewFiles, 'few-files');
    expect(fewFilesResult.status).toBe(1);
    expect(fewFilesResult.output).toContain('only 1 test files ran');

    const fewTests = { ...cleanReport(), numTotalTests: 12, numPassedTests: 12 };
    const fewTestsResult = runAudit(fewTests, 'few-tests');
    expect(fewTestsResult.status).toBe(1);
    expect(fewTestsResult.output).toContain('only 12 tests ran');
  });

  it('refuses a report missing entirely — no artefact is no evidence, not a pass', () => {
    const { status, output } = runAudit(undefined, 'never-written');
    expect(status).toBe(1);
    expect(output).toContain('the run produced no evidence');
  });

  it('refuses a report whose counters have been renamed, rather than reading them as zero', () => {
    const renamed = cleanReport();
    delete renamed.numPendingTests;
    const { status, output } = runAudit(renamed, 'renamed');
    expect(status).toBe(1);
    expect(output).toContain("the reporter's shape changed");
  });

  it('drops only the corpus floors under --subset, and still refuses failures and skips', () => {
    const small = {
      ...cleanReport(),
      numTotalTests: 3,
      numPassedTests: 3,
      testResults: [{ name: 'one.test.ts' }],
    };
    expect(runAudit(small, 'subset-clean', '--subset').status).toBe(0);

    const smallSkipped = { ...small, numPendingTests: 1, numPassedTests: 2 };
    const refused = runAudit(smallSkipped, 'subset-skipped', '--subset');
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('SKIPPED');
  });
});

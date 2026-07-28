#!/usr/bin/env node
/**
 * Audit vitest's own JSON report and refuse a run that did not actually happen.
 *
 * WHY THIS EXISTS — measured on `windows-latest`, run 30323223392 / 30324264768.
 *
 * A green CI leg was produced three separate times by a suite that never ran its browser
 * tests, in three different shapes:
 *
 *   1. attempt 1 on `d5487e8`: 8 browser tests failed  -> job RED   (the only honest one)
 *   2. attempt 2 on `d5487e8`: 8 browser tests failed  -> job GREEN
 *      `vitest run` printed `(9 tests | 8 failed)` at 03:09:25.50 and npm started `lint`
 *      at 03:09:26.63 — 1.1s later. `verify` is an `&&` chain, so `npm run test` exited 0
 *      with eight failing tests.
 *   3. `747653f`:             9 browser tests SKIPPED -> job GREEN
 *      `beforeAll` launches the browser; when it times out vitest marks the whole file's
 *      tests *skipped*, and a skipped test is not a failing test.
 *
 * So the gate reported success while the deliverable's only end-to-end instrument was
 * either failing or absent. That is this project's oldest defect in its most expensive
 * position: an instrument that produces nothing reads as an instrument reporting no
 * problem — here, at the level of the gate itself.
 *
 * A per-file repair (make that one `beforeAll` throw harder) would leave the class open
 * for the next file. This checks the property that actually matters and that no single
 * test can assert about itself: *the run as a whole executed what it claims to have
 * executed*. It reads vitest's own report rather than its exit code, because the exit
 * code is the thing measured to be unreliable.
 *
 * Usage:  node scripts/audit-test-report.mjs <report.json> [--subset]
 * `--subset` drops the corpus floors only; failures and skips are refused either way.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Floors, not exact counts. An exact count trains people to bump the number without
 * reading why it moved; a floor only ever fires when the corpus genuinely collapses.
 * Measured at the commit that introduced this file: 70 files / 960 tests.
 */
export const MIN_TEST_FILES = 60;
export const MIN_TESTS = 900;

/**
 * @param {unknown} report parsed vitest JSON report
 * @param {{ enforceFloors?: boolean }} [options]
 * @returns {{ problems: string[], summary: string }}
 */
export function auditReport(report, options = {}) {
  const enforceFloors = options.enforceFloors !== false;
  const problems = [];

  if (report === null || typeof report !== 'object') {
    return { problems: ['the report is not a JSON object'], summary: 'unreadable' };
  }

  const r = /** @type {Record<string, unknown>} */ (report);
  const count = (key) => (typeof r[key] === 'number' ? /** @type {number} */ (r[key]) : undefined);

  // Every counter this audit relies on must be present. A renamed field in a future vitest
  // would otherwise read as zero — which is to say, as good news.
  const required = ['numTotalTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'];
  const missing = required.filter((key) => count(key) === undefined);
  if (missing.length > 0) {
    return {
      problems: [`the report is missing ${missing.join(', ')} — the reporter's shape changed`],
      summary: 'unusable',
    };
  }

  const files = Array.isArray(r.testResults) ? r.testResults.length : 0;
  const total = /** @type {number} */ (count('numTotalTests'));
  const failed = /** @type {number} */ (count('numFailedTests'));
  const pending = /** @type {number} */ (count('numPendingTests'));
  const todo = /** @type {number} */ (count('numTodoTests'));

  const summary =
    `${files} files / ${total} tests — ` +
    `${failed} failed, ${pending} skipped, ${todo} todo, success=${String(r.success)}`;

  if (failed > 0) problems.push(`${failed} test(s) failed`);

  // This repo has no `it.skip`/`it.todo` anywhere — verified with `git ls-files '*.test.ts'`
  // at the introducing commit — so any skipped test means a hook died and took its file's
  // cases with it, silently. That is shape 3 above.
  if (pending > 0) {
    problems.push(
      `${pending} test(s) were SKIPPED — this repo declares no skipped tests, so a hook ` +
        `(usually a beforeAll) failed and vitest reported its cases as skipped rather than failed`,
    );
  }
  if (todo > 0) problems.push(`${todo} test(s) marked todo`);

  // Checked last and independently of the counters: `success` can be false while every
  // counter reads clean, which is what an aborted or crashed run looks like.
  if (r.success !== true) problems.push(`the report's own success flag is ${String(r.success)}`);

  if (enforceFloors) {
    if (files < MIN_TEST_FILES)
      problems.push(`only ${files} test files ran, floor is ${MIN_TEST_FILES}`);
    if (total < MIN_TESTS) problems.push(`only ${total} tests ran, floor is ${MIN_TESTS}`);
  }

  return { problems, summary };
}

/** @param {string[]} argv */
export function main(argv) {
  const args = argv.filter((a) => a !== '--subset');
  const enforceFloors = !argv.includes('--subset');
  const path = args[0];

  if (path === undefined) {
    process.stderr.write('usage: node scripts/audit-test-report.mjs <report.json> [--subset]\n');
    return 2;
  }
  if (!existsSync(path)) {
    // Not a warning. vitest was asked for a report and produced none, so there is no
    // evidence the suite ran at all — which is precisely the state this audit exists to refuse.
    process.stderr.write(
      `[test-audit] REFUSED: no report at ${path} — the run produced no evidence\n`,
    );
    return 1;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(`[test-audit] REFUSED: ${path} is not valid JSON (${String(error)})\n`);
    return 1;
  }

  const { problems, summary } = auditReport(report, { enforceFloors });
  process.stdout.write(
    `[test-audit] ${summary}${enforceFloors ? '' : ' (subset run: floors not enforced)'}\n`,
  );

  if (problems.length === 0) return 0;
  process.stderr.write('[test-audit] REFUSED — the test run cannot be called green:\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  return 1;
}

// Path comparison, not a string suffix test: on Windows `process.argv[1]` and the URL
// disagree on separators and on drive-letter case, and a suffix test quietly answers "no".
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

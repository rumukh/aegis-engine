#!/usr/bin/env node
/**
 * Run the test suite and refuse to report success unless the run can be shown to have happened.
 *
 * `npm run test` used to be `vitest run`, and CI trusted its exit code. That exit code was
 * measured to be unreliable on `windows-latest`: a run that printed `(9 tests | 8 failed)`
 * was followed 1.1 seconds later by the next link in `verify`'s `&&` chain, so it exited 0
 * with eight failing tests. A second run skipped nine browser tests outright and also exited 0.
 * See scripts/audit-test-report.mjs for the full measurement.
 *
 * The repair is not to trust a different single signal. It is to make the run produce an
 * artefact describing itself, and to check the artefact — with the deletion, the run and the
 * check all in **one process**, so a stale report from an earlier run cannot be mistaken for
 * this one's. That staleness is the same defect class the audit exists to catch, so leaving
 * the delete to a separate npm script would have reintroduced it one level down.
 *
 * The suite runs in **phases** — see scripts/test-phases.mjs for the measurement that made that
 * necessary. Each phase is deleted, run and audited on its own with its own floors, and the
 * floors describing the suite as a whole are checked against the **sum** at the end. Both, not
 * either: per-phase floors alone would let one phase silently run nothing, and a sum floor alone
 * would let a phase that ran a lot cover it.
 *
 * Exit code is the union of every signal: each phase's vitest exit code, each phase's audit,
 * and the whole-suite floors.
 */

import { rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as audit, MIN_TEST_FILES, MIN_TESTS } from './audit-test-report.mjs';
import { browserSpecs, hostsBrowserSpecs, testPhases } from './test-phases.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const forwarded = process.argv.slice(2);

// A subset run (`npm run test -- some.test.ts`) cannot satisfy the corpus floors, and pretending
// otherwise would make the floors something developers learn to work around rather than trust.
// Failures and skips are still refused. CI runs `npm run verify`, which passes no arguments.
const isSubset = forwarded.length > 0;

// Printed because every deadline in this repository is justified against how much machine there
// is, and until now no CI log said how much there was. `windows-latest` starving this process to
// a 0% CPU share (run 30377421271) was diagnosed without this number anywhere beside it.
process.stdout.write(
  `[test-run] ${process.platform} · ${String(cpus().length)} logical CPU(s) · ` +
    `${String(Math.round(totalmem() / 2 ** 30))} GiB RAM · node ${process.version}\n`,
);

/** @type {import('./test-phases.mjs').TestPhase[]} */
const phases = isSubset
  ? [
      {
        name: 'subset',
        why: `filtered by ${forwarded.join(' ')}`,
        report: '.vitest-report.json',
        args: forwarded,
        minFiles: 0,
        minTests: 0,
      },
    ]
  : testPhases(root, (path) => readFileSync(join(root, path), 'utf8'));

// Said out loud, at the top of the log, naming the files. A platform that runs less of the suite
// than another one is a fact a reader must be handed rather than one they could derive by noticing
// a phase heading is missing — "I checked and found nothing" and "I never looked" print the same,
// and this is the branch where the second one is true by design.
if (!isSubset && !hostsBrowserSpecs(process.platform)) {
  const skipped = browserSpecs(root, (path) => readFileSync(join(root, path), 'utf8'));
  process.stdout.write(
    `[test-run] NOT RUN ON ${process.platform}: ${String(skipped.length)} browser spec(s)\n` +
      skipped.map((path) => `[test-run]   - ${path}\n`).join('') +
      `[test-run]   They gate on every non-windows leg of the CI matrix, which ` +
      `test/browser-specs-run-solo.test.ts requires to exist. scripts/test-phases.mjs carries ` +
      `the measurement that put them there.\n`,
  );
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
let failed = false;
let totalFiles = 0;
let totalTests = 0;

for (const phase of phases) {
  const reportPath = join(root, phase.report);

  rmSync(reportPath, { force: true });
  if (existsSync(reportPath)) {
    process.stderr.write(
      `[test-run] REFUSED: could not delete ${reportPath}; a stale report would be read as this run\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`\n[test-run] phase "${phase.name}": ${phase.why}\n`);
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
      ...phase.args,
    ],
    { stdio: 'inherit', cwd: root },
  );

  if (result.error !== undefined) {
    process.stderr.write(`[test-run] vitest could not be started: ${String(result.error)}\n`);
    process.exit(1);
  }
  // `status` is null when the child was killed by a signal — which is exactly the shape that
  // loses an exit code, so it is treated as a failure rather than as an absent one.
  const vitestFailed = result.status !== 0;
  process.stdout.write(
    `[test-run] phase "${phase.name}" vitest exited ` +
      `${result.status === null ? `on signal ${String(result.signal)}` : String(result.status)}\n`,
  );

  const auditArgs = [reportPath];
  if (isSubset) auditArgs.push('--subset');
  else
    auditArgs.push(
      `--min-files=${String(phase.minFiles)}`,
      `--min-tests=${String(phase.minTests)}`,
    );
  const auditFailed = audit(auditArgs) !== 0;

  if (vitestFailed && !auditFailed) {
    // Worth naming rather than folding into the exit code: the suite itself was clean, so the
    // failure is in the runner or the tooling around it, and looking for a failing test wastes time.
    process.stderr.write(
      `[test-run] phase "${phase.name}": vitest reported failure but its own report is clean — ` +
        `the failure is outside the tests\n`,
    );
  }
  if (auditFailed && !vitestFailed) {
    process.stderr.write(
      `[test-run] phase "${phase.name}": vitest exited 0 but its own report is not clean — ` +
        `this is the defect this wrapper exists for\n`,
    );
  }
  failed = failed || vitestFailed || auditFailed;

  // Counted from the report rather than from the console: the console is the thing that has been
  // measured lying about this run. A report that is missing or unreadable has already been
  // refused by the audit above, so contributing zero here cannot turn a red into a green.
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      totalFiles += Array.isArray(report.testResults) ? report.testResults.length : 0;
      totalTests += typeof report.numTotalTests === 'number' ? report.numTotalTests : 0;
    } catch {
      // Already refused above; nothing to add.
    }
  }
}

if (!isSubset) {
  process.stdout.write(
    `[test-run] whole suite: ${String(totalFiles)} files / ${String(totalTests)} tests ` +
      `across ${String(phases.length)} phase(s)\n`,
  );
  if (totalFiles < MIN_TEST_FILES || totalTests < MIN_TESTS) {
    process.stderr.write(
      `[test-run] REFUSED: the suite as a whole ran ${String(totalFiles)} files / ` +
        `${String(totalTests)} tests, floors are ${String(MIN_TEST_FILES)} / ${String(MIN_TESTS)}\n`,
    );
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

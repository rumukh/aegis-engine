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
 * Exit code is the union of both signals: vitest's own, and the audit's.
 */

import { rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as audit } from './audit-test-report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = join(root, '.vitest-report.json');
const forwarded = process.argv.slice(2);

// A subset run (`npm run test -- some.test.ts`) cannot satisfy the corpus floors, and pretending
// otherwise would make the floors something developers learn to work around rather than trust.
// Failures and skips are still refused. CI runs `npm run verify`, which passes no arguments.
const isSubset = forwarded.length > 0;

rmSync(reportPath, { force: true });
if (existsSync(reportPath)) {
  process.stderr.write(
    `[test-run] REFUSED: could not delete ${reportPath}; a stale report would be read as this run\n`,
  );
  process.exit(1);
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    ...forwarded,
  ],
  { stdio: 'inherit', cwd: root },
);

// `status` is null when the child was killed by a signal — which is exactly the shape that
// loses an exit code, so it is treated as a failure rather than as an absent one.
const vitestFailed = result.status !== 0;
if (result.error !== undefined) {
  process.stderr.write(`[test-run] vitest could not be started: ${String(result.error)}\n`);
  process.exit(1);
}
process.stdout.write(
  `[test-run] vitest exited ${result.status === null ? `on signal ${result.signal}` : String(result.status)}\n`,
);

const auditFailed = audit(isSubset ? [reportPath, '--subset'] : [reportPath]) !== 0;

if (vitestFailed && !auditFailed) {
  // Worth naming rather than folding into the exit code: the suite itself was clean, so the
  // failure is in the runner or the tooling around it, and looking for a failing test wastes time.
  process.stderr.write(
    '[test-run] vitest reported failure but its own report is clean — the failure is outside the tests\n',
  );
}
if (auditFailed && !vitestFailed) {
  process.stderr.write(
    '[test-run] vitest exited 0 but its own report is not clean — this is the defect this wrapper exists for\n',
  );
}

process.exit(vitestFailed || auditFailed ? 1 : 0);

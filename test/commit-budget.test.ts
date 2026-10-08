import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot } from '../scripts/sdk-tools.mjs';

/**
 * F12 (SAVE-09, issue #17): per-commit cost of a Fluffy-sized state (eight cases at three
 * levels, a ~200-entry notebook, ~100 collection items). The documented budget is p50 < 15 ms
 * and p95 < 35 ms on the reference machine (docs/api/action-runtime.md). This gate uses three
 * times the p50 budget so that shared-machine load cannot redden it, while a gross regression
 * (for example per-listener deep copies or re-validating every commit twice again) still does.
 * The final hash is pinned as a literal: removing redundant work must not change behaviour.
 */
describe('Fluffy-sized commit cost (F12)', () => {
  it('stays within three times the documented p50 budget and keeps the pinned final hash', () => {
    const output = execFileSync(
      process.execPath,
      [
        join(repositoryRoot, 'scripts', 'bench-runtime-content.mjs'),
        '--fluffy',
        '--rounds',
        '1',
        '--json',
      ],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 110_000 },
    );
    const report = JSON.parse(output.slice(output.indexOf('{'))) as {
      perCommitMs: { p50: number; p95: number };
      finalHash: string;
      workload: { commitsPerRound: number };
    };
    console.info('Fluffy commit cost', JSON.stringify(report.perCommitMs));
    expect(report.finalHash).toBe('0bb319b5ff6be9f4');
    expect(report.workload.commitsPerRound).toBe(330);
    expect(report.perCommitMs.p50).toBeLessThan(45);
  }, 120_000);
});

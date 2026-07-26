/**
 * `aegis test` — discover and run headless {@link GameTest}s, report pass/fail with the harness's
 * rich failure messages, and exit non-zero on any failure (CHARTER principles 6 & 9).
 *
 * Discovery is glob + shape based, never layout based: the three PoC games are authored in
 * parallel with this CLI and have not settled on a directory structure, so `test` finds any
 * module that *exports a `GameTest`* (default or named), regardless of where it lives. The CLI
 * runs compiled JS, so the default patterns target `*.gametest.{js,mjs,cjs}`.
 * @packageDocumentation
 */
import { pathToFileURL } from 'node:url';
import { runGameTest } from '@aegis/harness';
import type { GameTest, GameTestResult } from '@aegis/harness';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { decomposeHandlesInText, json } from '../format.js';
import { globAll } from '../glob.js';
import type { Command, CommandContext } from '../command.js';
import { flagChoice, flagString } from './shared.js';

const REPORTERS = ['pretty', 'tap', 'json'] as const;

const DEFAULT_PATTERNS = ['**/*.gametest.js', '**/*.gametest.mjs', '**/*.gametest.cjs'];

const USAGE = [
  'aegis test [glob] [options]',
  '',
  'Discover and run headless gameplay tests. Any module exporting a GameTest (default or named)',
  'is discovered — layout-agnostic. Default glob: **/*.gametest.{js,mjs,cjs} (compiled JS).',
  '',
  '  --filter <substr>  Only run tests whose name contains <substr>.',
  '  --reporter <kind>  pretty | tap | json (default: pretty).',
  '  --json             Shorthand for --reporter json.',
  '',
  'Exit codes: 0 = all passed, 1 = a test failed or no tests were found.',
  '',
  'Examples:',
  '  aegis test',
  '  aegis test "games/**/*.gametest.js"',
  '  aegis test --filter completes --reporter tap',
].join('\n');

/** Whether an arbitrary exported value is a runnable {@link GameTest}. */
function isGameTest(value: unknown): value is GameTest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string' &&
    typeof v['scene'] === 'string' &&
    typeof v['ticks'] === 'number' &&
    typeof v['expect'] === 'function' &&
    typeof v['options'] === 'object' &&
    v['options'] !== null &&
    'plugin' in (v['options'] as Record<string, unknown>)
  );
}

/** Import a module by absolute path and collect every {@link GameTest} it exports. */
async function collectFromFile(abs: string): Promise<GameTest[]> {
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const found: GameTest[] = [];
  const seen = new Set<unknown>();
  for (const value of Object.values(mod)) {
    if (!seen.has(value) && isGameTest(value)) {
      seen.add(value);
      found.push(value);
    }
  }
  return found;
}

/** Render results for the TAP reporter. */
function renderTap(results: readonly GameTestResult[]): string {
  const lines = ['TAP version 13', `1..${results.length}`];
  results.forEach((r, i) => {
    lines.push(`${r.passed ? 'ok' : 'not ok'} ${i + 1} - ${r.name}`);
    if (!r.passed && r.error) {
      lines.push('  ---', '  message: |');
      for (const line of decomposeHandlesInText(r.error.message).split('\n'))
        lines.push(`    ${line}`);
      lines.push('  ...');
    }
  });
  return lines.join('\n');
}

/** Render results for the default human reporter. */
function renderPretty(results: readonly GameTestResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.name} (${r.ticks} ticks)`);
    if (!r.passed && r.error) {
      for (const line of decomposeHandlesInText(r.error.message).split('\n'))
        lines.push(`     ${line}`);
    }
  }
  const failed = results.filter((r) => !r.passed).length;
  lines.push(`-- ${results.length - failed} passed, ${failed} failed of ${results.length}`);
  return lines.join('\n');
}

/** `aegis test` — discover and run headless game tests, report pass/fail. */
export const testCommand: Command = {
  name: 'test',
  summary: 'Discover and run headless gameplay tests.',
  usage: USAGE,
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const patterns = args.positionals.length > 0 ? [...args.positionals] : DEFAULT_PATTERNS;
    const files = globAll(patterns, io.cwd);

    const filter = flagString(args, 'filter');
    const reporter =
      args.flags['json'] === true ? 'json' : flagChoice(args, 'reporter', REPORTERS, 'pretty');

    const tests: GameTest[] = [];
    for (const file of files) {
      for (const test of await collectFromFile(file)) {
        if (filter === undefined || test.name.includes(filter)) tests.push(test);
      }
    }

    if (tests.length === 0) {
      throw new AegisCliError(CliCode.NoTestsFound, 'No game tests were discovered.', {
        fix: `Checked ${files.length} file(s) matching ${patterns.join(', ')} under ${io.cwd}. A test module must export a GameTest (see defineGameTest).`,
        data: { patterns, filesScanned: files.length },
      });
    }

    const results: GameTestResult[] = [];
    for (const test of tests) results.push(await runGameTest(test));
    const failed = results.filter((r) => !r.passed).length;

    if (reporter === 'json') {
      io.out(
        json({
          passed: results.length - failed,
          failed,
          total: results.length,
          tests: results.map((r) => ({
            name: r.name,
            passed: r.passed,
            ticks: r.ticks,
            ...(r.error ? { error: decomposeHandlesInText(r.error.message) } : {}),
          })),
        }),
      );
    } else if (reporter === 'tap') {
      io.out(renderTap(results) + '\n');
    } else {
      io.out(renderPretty(results) + '\n');
    }

    return failed > 0 ? Exit.Error : Exit.Ok;
  },
};

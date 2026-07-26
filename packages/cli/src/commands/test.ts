/**
 * `aegis test` — discover and run headless {@link GameTest}s, report pass/fail with the harness's
 * rich failure messages, and exit non-zero on any failure (CHARTER principles 6 & 9).
 *
 * Discovery is glob + shape based, never layout based: `test` finds any module that *exports a
 * `GameTest`*, regardless of where it lives. The CLI runs compiled JS, so the default patterns
 * target `*.gametest.{js,mjs,cjs}`.
 *
 * ## Discovery reports what it checked
 *
 * A shape-based discovery that silently skips non-matching exports cannot tell "there was nothing
 * to run" from "your test had a typo and I deleted it from the suite". One wrong field type —
 * `ticks: '30'` instead of `30` — used to make a red test vanish and the run report `1 passed,
 * 0 failed`, exit 0. So discovery now (a) reports files scanned, tests found and exports skipped
 * in every reporter, and (b) treats an export that is *nearly* a `GameTest` as a **broken test**
 * with a stable code, not as an unrelated export.
 *
 * A test may also name its plugin as a string — `options: { plugin: 'platformer' }` or
 * `'./dist/game.js#gamePlugin'` — which the CLI resolves before handing the harness a real
 * `GameTest`. That is what lets a scaffolded test run from a directory with no `node_modules`.
 * @packageDocumentation
 */
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGameTest } from '@aegis/harness';
import type { GameTest, GameTestResult, ModePlugin } from '@aegis/harness';
import { AegisCliError, CliCode, Exit, formatCliError } from '../errors.js';
import { json } from '../format.js';
import { globAll } from '../glob.js';
import { isModePlugin, loadPlugin } from '../plugin.js';
import type { Command, CommandContext } from '../command.js';
import { flagChoice, flagString } from './shared.js';

const REPORTERS = ['pretty', 'tap', 'json'] as const;

const DEFAULT_PATTERNS = ['**/*.gametest.js', '**/*.gametest.mjs', '**/*.gametest.cjs'];

const USAGE = [
  'aegis test [glob...] [options]',
  '',
  'Discover and run headless gameplay tests. Any module exporting a GameTest (default or named)',
  'is discovered — layout-agnostic. Default glob: **/*.gametest.{js,mjs,cjs} (compiled JS).',
  '',
  '  --filter <substr>  Only run tests whose name contains <substr>.',
  '  --reporter <kind>  pretty | tap | json (default: pretty).',
  '  --json             Shorthand for --reporter json.',
  '',
  'Every reporter states what discovery actually checked: files scanned, tests found, exports',
  'skipped, and any export that is *almost* a GameTest (reported as a broken test, never skipped).',
  '',
  'Exit codes: 0 = all passed, 1 = a test failed, a test was malformed, or none were found.',
  '',
  'Examples:',
  '  aegis test',
  '  aegis test "games/**/*.gametest.js"',
  '  aegis test --filter completes --reporter tap',
].join('\n');

/** The required fields of a {@link GameTest}, and the type each must have. */
const FIELDS: ReadonlyArray<{ key: string; expect: string; check(v: unknown): boolean }> = [
  { key: 'name', expect: 'string', check: (v) => typeof v === 'string' },
  { key: 'scene', expect: 'string', check: (v) => typeof v === 'string' },
  { key: 'ticks', expect: 'number', check: (v) => typeof v === 'number' },
  { key: 'expect', expect: 'function', check: (v) => typeof v === 'function' },
  { key: 'options', expect: 'object', check: (v) => typeof v === 'object' && v !== null },
];

/** An export that looks like a game test but cannot run. */
export interface InvalidTest {
  /** Absolute file it was exported from. */
  file: string;
  /** The export name (`default` for a default export). */
  exportName: string;
  /** The test's `name`, when it had a usable one. */
  name?: string;
  /** One human-readable problem per malformed field. */
  problems: readonly string[];
}

/** A discovered test, plus where it came from (so failures can name the file). */
interface DiscoveredTest {
  test: GameTest;
  file: string;
  exportName: string;
}

/** What a discovery pass actually examined — reported in full by every reporter. */
interface Discovery {
  filesScanned: number;
  exportsSkipped: number;
  tests: DiscoveredTest[];
  invalid: InvalidTest[];
}

/** Whether a value is close enough to a `GameTest` that silently skipping it would hide a bug. */
function looksLikeGameTest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const signals = [
    typeof v['name'] === 'string',
    typeof v['expect'] === 'function',
    typeof v['scene'] === 'string',
    'ticks' in v,
    'options' in v,
  ].filter(Boolean).length;
  // `name` + `expect` is the signature of a hand-written test; so is any 3-of-5 near miss.
  return (typeof v['name'] === 'string' && typeof v['expect'] === 'function') || signals >= 3;
}

/** Describe every way `value` fails the {@link GameTest} contract. Empty ⇒ it is a valid test. */
function problemsWith(value: unknown): string[] {
  if (typeof value !== 'object' || value === null)
    return [`must be an object, got ${typeof value}`];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of FIELDS) {
    const actual = v[field.key];
    if (actual === undefined) {
      problems.push(`missing required field "${field.key}" (${field.expect})`);
    } else if (!field.check(actual)) {
      problems.push(
        `field "${field.key}" must be a ${field.expect}, got ${typeof actual} (${JSON.stringify(actual)})`,
      );
    }
  }
  const options = v['options'];
  if (typeof options === 'object' && options !== null) {
    const plugin = (options as Record<string, unknown>)['plugin'];
    if (plugin === undefined) {
      problems.push(
        'options.plugin is missing — set it to a ModePlugin, a mode name ("platformer"), or "<module>#<export>"',
      );
    } else if (typeof plugin !== 'string' && !isModePlugin(plugin)) {
      problems.push(
        'options.plugin is neither a ModePlugin { mode, components(), systems(), view() } nor a "<module>#<export>" string',
      );
    }
  }
  return problems;
}

/** Resolve a string `options.plugin` to a real plugin, so the harness receives a true GameTest. */
async function materialise(
  discovered: DiscoveredTest,
  ctx: CommandContext,
): Promise<DiscoveredTest> {
  const options = discovered.test.options as { plugin?: unknown };
  if (!(typeof options.plugin === 'string')) return discovered;
  const plugin: ModePlugin = await loadPlugin(
    options.plugin,
    [dirname(discovered.file)],
    ctx.modes,
  );
  return {
    ...discovered,
    test: { ...discovered.test, options: { ...discovered.test.options, plugin } },
  };
}

/** Import a module and classify every export: a test, a broken test, or an unrelated export. */
async function collectFromFile(abs: string, into: Discovery): Promise<void> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (err) {
    into.invalid.push({
      file: abs,
      exportName: '<module>',
      problems: [`could not be imported: ${(err as Error).message}`],
    });
    return;
  }
  const seen = new Set<unknown>();
  for (const [exportName, value] of Object.entries(mod)) {
    if (seen.has(value)) continue;
    seen.add(value);
    const problems = problemsWith(value);
    if (problems.length === 0) {
      into.tests.push({ test: value as GameTest, file: abs, exportName });
    } else if (looksLikeGameTest(value)) {
      const name = (value as { name?: unknown }).name;
      into.invalid.push({
        file: abs,
        exportName,
        ...(typeof name === 'string' ? { name } : {}),
        problems,
      });
    } else {
      into.exportsSkipped += 1;
    }
  }
}

/** The stable-coded error a malformed test produces, rendered into every reporter. */
function invalidTestError(invalid: readonly InvalidTest[]): AegisCliError {
  const detail = invalid
    .map(
      (i) =>
        `  ${i.file} [${i.exportName}]${i.name !== undefined ? ` "${i.name}"` : ''}\n` +
        i.problems.map((p) => `    - ${p}`).join('\n'),
    )
    .join('\n');
  return new AegisCliError(
    CliCode.InvalidGameTest,
    `${invalid.length} export(s) look like game tests but cannot run:\n${detail}`,
    {
      fix: 'Fix the fields above. A GameTest is { name: string, scene: string, ticks: number, options: { plugin }, expect(result) }. Using defineGameTest() from @aegis/harness type-checks this at compile time. These are counted as failures, never skipped — a malformed test must never disappear from a green suite.',
      data: { invalid },
    },
  );
}

/** Render results for the TAP reporter. */
function renderTap(results: readonly GameTestResult[], discovery: Discovery): string {
  const total = results.length + discovery.invalid.length;
  const lines = ['TAP version 13', `1..${total}`];
  results.forEach((r, i) => {
    lines.push(`${r.passed ? 'ok' : 'not ok'} ${i + 1} - ${r.name}`);
    if (!r.passed && r.error) {
      lines.push('  ---', '  message: |');
      for (const line of r.error.message.split('\n')) lines.push(`    ${line}`);
      lines.push('  ...');
    }
  });
  discovery.invalid.forEach((i, n) => {
    lines.push(
      `not ok ${results.length + n + 1} - ${i.name ?? `${i.file} [${i.exportName}]`} # ${CliCode.InvalidGameTest}`,
    );
    lines.push('  ---', '  message: |');
    for (const problem of i.problems) lines.push(`    ${problem}`);
    lines.push('  ...');
  });
  lines.push(`# ${summaryLine(results, discovery)}`);
  return lines.join('\n');
}

/** The one-line statement of what discovery checked — printed by pretty and TAP. */
function summaryLine(results: readonly GameTestResult[], discovery: Discovery): string {
  const failed = results.filter((r) => !r.passed).length;
  return (
    `${results.length - failed} passed, ${failed} failed, ${discovery.invalid.length} invalid ` +
    `of ${results.length + discovery.invalid.length} — ` +
    `${discovery.filesScanned} file(s) scanned, ${discovery.tests.length} test(s) found, ` +
    `${discovery.exportsSkipped} unrelated export(s) skipped`
  );
}

/** Render results for the default human reporter. */
function renderPretty(results: readonly GameTestResult[], discovery: Discovery): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.name} (${r.ticks} ticks)`);
    if (!r.passed && r.error) {
      for (const line of r.error.message.split('\n')) lines.push(`     ${line}`);
    }
  }
  for (const i of discovery.invalid) {
    lines.push(`INVALID ${i.name ?? `${i.file} [${i.exportName}]`} [${CliCode.InvalidGameTest}]`);
    lines.push(`     ${i.file} [${i.exportName}]`);
    for (const problem of i.problems) lines.push(`     - ${problem}`);
  }
  lines.push(`-- ${summaryLine(results, discovery)}`);
  return lines.join('\n');
}

/** `aegis test` — discover and run headless game tests, report pass/fail. */
export const testCommand: Command = {
  name: 'test',
  summary: 'Discover and run headless gameplay tests.',
  usage: USAGE,
  flags: { filter: 'value', reporter: 'value' },
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const patterns = args.positionals.length > 0 ? [...args.positionals] : DEFAULT_PATTERNS;
    const files = globAll(patterns, io.cwd);

    const filter = flagString(args, 'filter');
    const reporter =
      args.flags['json'] === true ? 'json' : flagChoice(args, 'reporter', REPORTERS, 'pretty');

    const discovery: Discovery = {
      filesScanned: files.length,
      exportsSkipped: 0,
      tests: [],
      invalid: [],
    };
    for (const file of files) await collectFromFile(file, discovery);

    const discovered = discovery.tests.length;
    const discoveredNames = discovery.tests.map((t) => t.test.name);
    if (filter !== undefined) {
      discovery.tests = discovery.tests.filter((t) => t.test.name.includes(filter));
    }

    // Resolve string plugin specs before running; a bad spec is a broken test, not a crash.
    const runnable: DiscoveredTest[] = [];
    for (const test of discovery.tests) {
      try {
        runnable.push(await materialise(test, ctx));
      } catch (err) {
        discovery.invalid.push({
          file: test.file,
          exportName: test.exportName,
          name: test.test.name,
          problems: [
            `options.plugin could not be resolved: ${err instanceof AegisCliError ? `${err.code} ${err.message}` : (err as Error).message}`,
          ],
        });
      }
    }
    discovery.tests = runnable;

    if (discovery.tests.length === 0 && discovery.invalid.length === 0) {
      const filtered = filter !== undefined && discovered > 0;
      throw new AegisCliError(
        CliCode.NoTestsFound,
        filtered
          ? `No game tests matched --filter "${filter}" (${discovered} discovered).`
          : 'No game tests were discovered.',
        {
          fix: filtered
            ? `${discovered} test(s) were discovered in ${discovery.filesScanned} file(s), but none matched the filter. Discovered names: ${discoveredNames.map((n) => `"${n}"`).join(', ')}. Drop --filter, or use a substring of one of those names.`
            : `Scanned ${discovery.filesScanned} file(s) matching ${patterns.join(', ')} under ${io.cwd}, and skipped ${discovery.exportsSkipped} unrelated export(s). A test module must export a GameTest (see defineGameTest).`,
          data: {
            patterns,
            filesScanned: discovery.filesScanned,
            testsDiscovered: discovered,
            exportsSkipped: discovery.exportsSkipped,
            ...(filter !== undefined ? { filter, discoveredNames } : {}),
          },
        },
      );
    }

    const results: GameTestResult[] = [];
    for (const { test } of discovery.tests) results.push(await runGameTest(test));
    const failed = results.filter((r) => !r.passed).length;

    if (reporter === 'json') {
      io.out(
        json({
          passed: results.length - failed,
          failed,
          invalid: discovery.invalid.length,
          total: results.length + discovery.invalid.length,
          filesScanned: discovery.filesScanned,
          testsDiscovered: discovered,
          testsRun: results.length,
          exportsSkipped: discovery.exportsSkipped,
          ...(filter !== undefined ? { filter } : {}),
          tests: results.map((r) => ({
            name: r.name,
            passed: r.passed,
            ticks: r.ticks,
            ...(r.error ? { error: r.error.message } : {}),
          })),
          invalidTests: discovery.invalid.map((i) => ({
            code: CliCode.InvalidGameTest,
            file: i.file,
            export: i.exportName,
            ...(i.name !== undefined ? { name: i.name } : {}),
            problems: i.problems,
          })),
        }),
      );
    } else if (reporter === 'tap') {
      io.out(renderTap(results, discovery) + '\n');
    } else {
      io.out(renderPretty(results, discovery) + '\n');
    }

    if (discovery.invalid.length > 0) {
      // Stderr too: a malformed test is a hard, greppable failure even when stdout is a report.
      io.err(formatCliError(invalidTestError(discovery.invalid)) + '\n');
      return Exit.Error;
    }
    return failed > 0 ? Exit.Error : Exit.Ok;
  },
};

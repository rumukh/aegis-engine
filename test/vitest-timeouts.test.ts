import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The root vitest config must bound **hooks**, not only tests.
 *
 * Why this guard exists, measured rather than supposed. At the revision this was written the
 * repository contained 27 hooks across its test files. Twenty-six of them ran on vitest's
 * `hookTimeout` default of 10 000 ms, and exactly one carried an explicit budget —
 * `packages/render-three/src/browser-playability.test.ts`'s `beforeAll`, raised to 180s in a
 * landing that fixed the file in front of it and left the class open. Meanwhile `testTimeout` had
 * been deliberately raised to 120 000 ms, with a long justification, in the same config object.
 * So a hook had one twelfth of a test's budget while doing the same kind of work: these hooks
 * spawn CLI subprocesses, launch Chrome, and delete scaffolded game trees on Windows.
 *
 * The consequence is not a slow test going red. It is a **silent green**. A `beforeAll` that
 * exceeds its budget does not fail its file — vitest reports that file's cases as *skipped*, and
 * a skipped test is not a failing test. CI run 30324264768 reported a green `windows-latest` leg
 * in 3m36s with nine browser tests that never executed, by exactly this mechanism. A guard that
 * only bounds tests leaves the half of the run that can fail invisibly unbounded.
 *
 * Two arms, with deliberately different provenance, because they fail in different worlds:
 *
 *   1. The **declaration** arm reads `vitest.config.ts` off disk and checks what it says. It
 *      catches an edit that deletes or shrinks the setting, at the moment of the edit, with a
 *      message naming the file. It cannot see a value overridden on the command line.
 *   2. The **effective** arm sleeps past the default inside a real hook. It measures the number
 *      actually in force in this process, whatever produced it. It cannot tell you which source
 *      produced it.
 *
 * Neither subsumes the other, and a failure of one but not both is itself informative: arm 1 red
 * with arm 2 green means the config was edited and something else is compensating; arm 2 red with
 * arm 1 green means the config is right and the run is being overridden from outside it.
 */
const CONFIG_PATH = fileURLToPath(new URL('../vitest.config.ts', import.meta.url));

/** vitest's own default, and the value this guard exists to keep the suite away from.
 *
 * Measured rather than taken from documentation: with `hookTimeout` deleted from the config, a
 * hook on this box died with `Hook timed out in 10000ms`. */
const VITEST_DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * Reads a numeric `test:` setting out of the config source.
 *
 * Anchored to the start of a line so that prose in a comment cannot satisfy it — every mention of
 * `hookTimeout` in that file's own commentary is prefixed with `//`, and several of them are
 * followed by a number. A regex that matched anywhere would be green on a config that had the
 * setting deleted and only discussed.
 */
const numericSetting = (source: string, name: string): number | undefined => {
  const digits = new RegExp(`^\\s*${name}:\\s*([\\d_]+),`, 'm').exec(source)?.[1];
  return digits === undefined ? undefined : Number(digits.replaceAll('_', ''));
};

describe('the root vitest config bounds hooks as well as tests', () => {
  // Working-tree files are CRLF here and blobs are LF; normalise before matching.
  const source = readFileSync(CONFIG_PATH, 'utf8').replaceAll('\r\n', '\n');

  it('reads a config that is actually there (anti-vacuity)', () => {
    // Without this, every check below is satisfiable by an empty string — the failure mode this
    // repository has hit more times than any other.
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('defineConfig');
  });

  it('declares hookTimeout, and at least the test budget', () => {
    const hook = numericSetting(source, 'hookTimeout');
    const test = numericSetting(source, 'testTimeout');

    expect(test, 'testTimeout is missing from vitest.config.ts').toBeDefined();
    expect(
      hook,
      'vitest.config.ts sets testTimeout but not hookTimeout, so every hook in the repository ' +
        `falls back to vitest's ${VITEST_DEFAULT_HOOK_TIMEOUT_MS}ms default. A hook that exceeds ` +
        'it does not fail its file: vitest reports that file as skipped, and skipped reads as ' +
        'green. Set hookTimeout explicitly.',
    ).toBeDefined();

    expect(hook).toBeGreaterThan(VITEST_DEFAULT_HOOK_TIMEOUT_MS);
    if (hook === undefined || test === undefined) {
      // Unreachable past the assertions above; present so the comparison below needs no cast.
      // A named throw rather than `!`, so a config this reader cannot parse says so out loud
      // instead of failing on an index.
      throw new Error('vitest.config.ts: could not read testTimeout and hookTimeout as numbers');
    }
    expect(
      hook,
      'hookTimeout is below testTimeout. Hooks in this repository spawn subprocesses, launch ' +
        'browsers and delete scaffolded trees — the same work the cases do — so a smaller bound ' +
        'on the hook than on the case it serves has no justification.',
    ).toBeGreaterThanOrEqual(test);
  });

  it('the setting reader is anchored, and can answer both ways', () => {
    // Control. Without an arm that returns nothing, a reader that produced a number for every
    // input would satisfy the check above while proving nothing about the config at all.
    expect(numericSetting(source, 'thisSettingDoesNotExist')).toBeUndefined();

    // The anchor is load-bearing: a config that only *discusses* the setting must not satisfy it.
    // Driven against synthetic sources rather than against the real file, because the real file
    // happens not to contain a commented-out declaration — an arm that cannot fire is not a
    // control, and asserting against today's prose would be a claim about the prose.
    const discussedOnly = 'export default {\n  // hookTimeout: 120_000, removed for now\n};\n';
    expect(numericSetting(discussedOnly, 'hookTimeout')).toBeUndefined();

    // ...and the same reader must find a real declaration in the same shape, or the arm above is
    // satisfied by a reader that finds nothing anywhere.
    const declared = 'export default {\n  hookTimeout: 120_000,\n};\n';
    expect(numericSetting(declared, 'hookTimeout')).toBe(120_000);
  });
});

describe('the effective hook timeout in this process', () => {
  let sleptFor = 0;

  /**
   * Sleeps past vitest's default. This is the whole instrument.
   *
   * If `hookTimeout` ever reverts to 10 000 ms, this hook is killed and vitest reports this file's
   * cases as **skipped**. Two independent things then refuse the run, and both were watched:
   *
   *   - vitest's own report sets `success:false` and the process exits 1;
   *   - `scripts/audit-test-report.mjs` refuses by name — *"1 test(s) were SKIPPED — this repo
   *     declares no skipped tests, so a hook (usually a beforeAll) failed"* — and exits 1.
   *
   * The second is not redundant, and the reason is specific rather than belt-and-braces: on
   * `windows-latest` `npm run test`'s exit code has been measured being **lost** (CI run
   * 30323223392 reported a green leg with eight failing tests, 1.1s apart in the log). The path
   * that would otherwise catch this is exactly the path known to drop its verdict on the leg that
   * matters. The auditor reads vitest's report rather than its exit code, so the two cannot fail
   * the same way.
   *
   * An earlier draft of this comment said a skipped case "reads as green on its own". That was
   * inherited from the CI incident rather than measured, and it is wrong for this shape: run
   * directly, vitest does mark the run failed. Corrected here because a comment that over-claims
   * is a claim nobody re-derives.
   *
   * Cost is ~10.5s of wall clock in one worker, and close to zero of anyone's time: a sleeping
   * hook holds no CPU, and vitest runs files in parallel, so this file overlaps whatever else is
   * running rather than extending the suite.
   */
  beforeAll(async () => {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, VITEST_DEFAULT_HOOK_TIMEOUT_MS + 500));
    sleptFor = Date.now() - started;
  });

  it('lets a hook run longer than vitest would by default', () => {
    // Reaching this line at all is the measurement. The assertion states what was observed so a
    // regression is a number in a log rather than an absence nobody notices.
    expect(sleptFor).toBeGreaterThan(VITEST_DEFAULT_HOOK_TIMEOUT_MS);
    console.log(
      `[hook-timeout] a beforeAll ran for ${sleptFor}ms; vitest's default bound is ` +
        `${VITEST_DEFAULT_HOOK_TIMEOUT_MS}ms`,
    );
  });
});

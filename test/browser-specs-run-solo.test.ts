/**
 * The browser specs must not share the machine, and the split that arranges that must not be
 * a list somebody has to remember to update.
 *
 * WHY — measured on `windows-latest`, run 30377421271. Seven cases in
 * `packages/render-three/src/browser-playability.test.ts` failed, and the deadline instrument
 * printed the cause: `this process held a CPU only 0% of the window — it was NOT SCHEDULED`,
 * with the event loop's own sampler taking 2 readings where ~815 were due. From the same log,
 * `browser-diagnostics` emitted inside `browser-playability`'s window — two software-rasterising
 * Chromes at once, alongside the rest of the worker pool. scripts/test-phases.mjs carries the
 * numbers in full.
 *
 * scripts/test-phases.mjs therefore *derives* the split from the property that justifies it —
 * the file launches a browser — instead of naming files. This guard exists because deriving it
 * moves the failure mode rather than removing it: a classifier that stops matching does not
 * announce itself, it just returns a smaller set, and a browser spec quietly back in the shared
 * phase is an intermittent CI red that will be attributed to whatever landed that week.
 *
 * So the claim under test is completeness, checked against a corpus this file scans itself:
 * a spec launches a browser **if and only if** it is in the solo phase.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MIN_TEST_FILES } from '../scripts/audit-test-report.mjs';
import {
  BROWSER_MARKER,
  browserSpecs,
  isHostedCi,
  SOLO_SKIP_REASON,
  soloEnabled,
  specFiles,
  testPhases,
} from '../scripts/test-phases.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The detector, written the way the classifier writes it and for the same reason: this file is
 * itself in the corpus it scans, so a literal here would classify this test as a browser spec.
 * `browser-diagnostics.test.ts`'s containment guard was caught matching its own detector string
 * exactly this way.
 */
const MARKER = 'launchBrowser' + '(';

/** @param {string} path repo-relative */
function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/**
 * The corpus, enumerated here rather than taken from the classifier. `--others` keeps
 * uncommitted specs in scope so a new browser test is classified while it is being written.
 */
function allSpecsFromGit(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.(?:test|spec)\.ts$/.test(line));
}

/**
 * Look a phase up by name rather than by position, and throw when it is missing. An index into
 * a list nobody validates is the shared-mutable-index defect AGENTS.md §9 describes; a
 * destructure that silently yields `undefined` is the same thing with better syntax.
 *
 * Platform and hosted-ness are passed **explicitly**, never defaulted. The solo phase is omitted
 * on a hosted `win32` runner (ADR-0010), so an arm that let `testPhases` read `process.platform`
 * would assert a different property depending on which leg of the CI matrix ran it — and would
 * pass on ubuntu while being unreachable on windows, which is an arm nobody controls.
 */
function phase(name: string, platform = 'linux', hosted = true) {
  const found = testPhases(root, read, platform, hosted).find((p) => p.name === name);
  if (found === undefined) {
    const names = testPhases(root, read, platform, hosted).map((p) => p.name);
    throw new Error(`no phase named "${name}" — testPhases returned [${names.join(', ')}]`);
  }
  return found;
}

/**
 * The browser specs, derived here and *not* taken from the classifier.
 *
 * Every arm below that says something about the phases has to compare them against a set with
 * independent provenance, or it is comparing the classifier to itself. Measured: the first
 * version of this file drove the solo-phase and `minFiles` arms from `browserSpecs()`, and the
 * undercount control — make the classifier return one file instead of two — left both of them
 * **green**, because both sides shrank together. Only the arm anchored on this scan went red.
 */
function scannedBrowserSpecs(): string[] {
  return allSpecsFromGit()
    .filter((path) => read(path).includes(MARKER))
    .sort((a, b) => a.localeCompare(b));
}

describe('every spec that launches a browser runs in the solo phase', () => {
  it('finds a corpus at all — without this floor every check below passes over nothing', () => {
    const specs = specFiles(root);
    // Compared against the audit's own file floor rather than against a number written here:
    // two floors that drift apart would be two floors nobody trusts, and the suite cannot both
    // satisfy the audit and contain fewer files than it.
    expect(specs.length).toBeGreaterThanOrEqual(MIN_TEST_FILES);
    // The classifier's path pattern mirrors vitest.config.ts's `include`. Measured equal today
    // (73 = 73), and asserted as an equality rather than a floor because the two ways it can
    // break are both real findings: the pattern narrowing drops a file from the split, and a
    // spec appearing outside the include roots is a spec vitest never runs at all.
    expect([...specs].sort((a, b) => a.localeCompare(b))).toEqual(
      allSpecsFromGit().sort((a, b) => a.localeCompare(b)),
    );
  });

  it('classifies exactly the specs that launch a browser, by an independent scan', () => {
    const scanned = scannedBrowserSpecs();

    // Anti-vacuity on the *other* side of the equality: "no file launches a browser" would
    // satisfy an if-and-only-if trivially, and it is also the exact state a broken scan
    // produces. Both sides must be non-empty for the equality to mean anything.
    expect(scanned.length).toBeGreaterThan(0);

    const classified = [...browserSpecs(root, read)].sort((a, b) => a.localeCompare(b));
    expect(classified).toEqual(scanned);
  });

  it('puts every one of them in the solo phase and none of them in the shared phase', () => {
    const shared = phase('shared');
    const solo = phase('solo');
    const browsers = scannedBrowserSpecs();
    expect(browsers.length).toBeGreaterThan(0);

    for (const spec of browsers) {
      expect(solo.args).toContain(spec);
      // The shared phase excludes it explicitly. Asserting the exclusion rather than merely
      // asserting absence from a list matters: the shared phase is defined by a glob over
      // everything, so "not mentioned" is how a file gets *included*.
      expect(shared.args).toContain(spec);
      expect(shared.args[shared.args.indexOf(spec) - 1]).toBe('--exclude');
    }
    expect(shared.args.filter((a: string) => a === '--exclude')).toHaveLength(browsers.length);
  });

  it('turns file parallelism off in the solo phase — that is the whole mechanism', () => {
    expect(phase('solo').args).toContain('--no-file-parallelism');
  });

  it('runs the browser phase last, so it inherits a quiet machine rather than a loaded one', () => {
    // Not cosmetic. Probe 4 (run 30362542986) measured a browser launched late into a
    // `windows-latest` job painting immediately, where one launched early painted 3 frames in
    // 3 seconds — the cold period is a property of the job, not of the browser instance.
    // Running these last buys that warm-up for free.
    expect(testPhases(root, read, 'linux', true).map((p: { name: string }) => p.name)).toEqual([
      'shared',
      'solo',
    ]);
  });

  it('demands every solo file report in, rather than a floor a partial run could clear', () => {
    expect(phase('solo').minFiles).toBe(scannedBrowserSpecs().length);
    // The shared phase keeps a floor rather than an exact count: it is a large corpus that
    // legitimately grows, and an exact count there would train people to bump a number.
    expect(phase('shared').minFiles).toBeGreaterThan(0);
    expect(phase('shared').minTests).toBeGreaterThan(0);
  });

  it('refuses to produce a split at all when the classifier finds nothing', () => {
    // The failure this guard is really about. A classifier that silently matched no file would
    // return every browser spec to the shared phase and report a healthy two-phase split, which
    // is this repository's oldest defect: an instrument producing nothing reads as an instrument
    // reporting nothing wrong. It must throw, and it must say what it could not find.
    expect(() => browserSpecs(root, () => '')).toThrow(/no spec contains/);
    expect(() => testPhases(root, () => '')).toThrow(
      new RegExp(BROWSER_MARKER.replace('(', '\\(')),
    );
  });

  it('classifies by the marker and not by the file name', () => {
    // A name-based rule is the tempting shortcut and it is wrong in both directions: a spec
    // called `browser-*` that never launches one would be serialised for no reason, and a spec
    // called anything else that does would be starved. Driven over a corpus written here, so
    // both directions are exercised on data this repository does not happen to contain.
    const corpus = [
      'packages/x/src/quiet-browser.test.ts', // named for a browser, launches none
      'packages/x/src/renderer-e2e.test.ts', // named for nothing, launches one
    ];
    const synthetic = (path: string): string =>
      path === 'packages/x/src/renderer-e2e.test.ts' ? `await ${MARKER}{ headless: true });` : '';
    expect(browserSpecs(root, synthetic, corpus)).toEqual(['packages/x/src/renderer-e2e.test.ts']);
  });
});

describe('the browser phase is omitted on a hosted windows runner, and only there', () => {
  // WHY this exclusion exists at all is ADR-0010, and it is not a small claim: it is the one
  // place in this repository where a gate deliberately covers less than it could. The arms below
  // pin the *shape* of that decision so it cannot widen quietly — a platform check written inline
  // would be one edit away from excluding ubuntu too, and nothing would have said so.

  it('runs the browser phase everywhere except a hosted windows runner', () => {
    // All four cells, because three of them are the reason this is a two-argument predicate and
    // not a `process.platform === 'win32'` check. Windows on a workstation runs these specs and
    // passes — this repository's landing gate has run them on Windows before every landing — and
    // a hosted linux runner runs them and passes on every push.
    expect(soloEnabled('linux', true)).toBe(true);
    expect(soloEnabled('linux', false)).toBe(true);
    expect(soloEnabled('win32', false)).toBe(true);
    expect(soloEnabled('win32', true)).toBe(false);
  });

  it('actually drops the phase from the plan, rather than merely reporting that it could', () => {
    // The predicate could be correct and unused. This drives the real `testPhases`, which is the
    // only thing `run-tests.mjs` executes.
    expect(testPhases(root, read, 'win32', true).map((p) => p.name)).toEqual(['shared']);
    expect(testPhases(root, read, 'win32', false).map((p) => p.name)).toEqual(['shared', 'solo']);
    expect(testPhases(root, read, 'linux', true).map((p) => p.name)).toEqual(['shared', 'solo']);
  });

  it('changes nothing about the shared phase — only whether the solo phase runs', () => {
    // The dangerous adjacent failure. `shared` is defined by excluding the browser specs, so a
    // change that also stopped excluding them would put a software-rasterising Chrome back into
    // the parallel pool on the exact runner that cannot schedule one, and the leg would go red
    // for a reason that reads like a regression in whatever landed that day.
    const onWindowsCi = phase('shared', 'win32', true);
    const elsewhere = phase('shared', 'linux', true);
    expect(onWindowsCi.args).toEqual(elsewhere.args);
    expect(onWindowsCi.minFiles).toBe(elsewhere.minFiles);
    expect(onWindowsCi.minTests).toBe(elsewhere.minTests);
    // And the exclusions are really still there, asserted against the independent scan rather
    // than against the classifier, for the reason `scannedBrowserSpecs` exists.
    for (const spec of scannedBrowserSpecs()) expect(onWindowsCi.args).toContain(spec);
  });

  it('still classifies the browser specs on windows CI, so a broken classifier still throws', () => {
    // Omitting the phase must not omit the check. `browserSpecs` throwing on an empty result is
    // what stops a classifier that stopped matching from returning every browser spec to the
    // shared pool; short-circuiting the call on windows would have removed that guarantee on the
    // one leg where a browser spec in the shared pool does the most damage.
    expect(() => testPhases(root, () => '', 'win32', true)).toThrow(
      new RegExp(BROWSER_MARKER.replace('(', '\\(')),
    );
  });

  it('states a reason that names the ADR and does not read as a pass', () => {
    // A skip reason is prose in a log, which this project has measured to be the highest
    // half-life propagation channel it has. So the two things a reader most needs are pinned:
    // where the evidence lives, and that this is an exclusion rather than coverage.
    expect(SOLO_SKIP_REASON).toContain(
      'docs/adr/0010-browser-specs-do-not-run-on-hosted-windows.md',
    );
    expect(SOLO_SKIP_REASON).toContain('exclusion, not a pass');
    // The measured asymmetry that justifies it, carried in the message itself: a reason a reader
    // has to go and look up is a reason nobody checks.
    expect(SOLO_SKIP_REASON).toMatch(/74823ms/);
  });

  it('recognises a hosted runner from the environment, and a workstation from its absence', () => {
    // Injected rather than mutated: `process.env.CI` is read by other machinery in the same
    // worker, and a test that sets it would be measuring its own side effect.
    expect(isHostedCi({ CI: 'true' })).toBe(true);
    expect(isHostedCi({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isHostedCi({})).toBe(false);
    // `CI` is a string, and the string 'false' is the value a runner sets when it means false.
    expect(isHostedCi({ CI: 'false' })).toBe(false);
  });
});

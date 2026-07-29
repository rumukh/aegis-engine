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
  hostsBrowserSpecs,
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
 * The platform defaults to `linux` rather than to this host's: the phase list is now
 * platform-dependent, and a guard that asked the host would assert one arrangement on a developer's
 * Windows box and the other on CI, silently, which is the shape of every defect this file exists
 * to catch. Both arrangements are asserted explicitly below instead.
 */
function phase(name: string, platform = 'linux', env: Record<string, string | undefined> = {}) {
  const found = testPhases(root, read, platform, env).find((p) => p.name === name);
  if (found === undefined) {
    const names = testPhases(root, read, platform, env).map((p) => p.name);
    throw new Error(
      `no phase named "${name}" on ${platform} — testPhases returned [${names.join(', ')}]`,
    );
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
    expect(testPhases(root, read, 'linux', {}).map((p: { name: string }) => p.name)).toEqual([
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

/**
 * The browser specs do not run on `windows-latest`, and that must stay a scope decision rather
 * than becoming a silent retirement.
 *
 * scripts/test-phases.mjs carries the measurement (eleven CI rounds; the same commit producing 0
 * failures and then 3; both directions of the priority lever each starving the other party). What
 * that measurement licenses is narrow: *this host cannot run them*. It does not license *nobody
 * runs them*, and the distance between those two is one edit to a matrix line — an edit that
 * would turn every leg green and remove the entire browser suite from the gate at the same time.
 *
 * So the claim under test is a conjunction, and both halves matter: the split omits them exactly
 * on Windows, and the CI matrix still contains a host that does not omit them.
 */
describe('dropping the browser specs on Windows cannot become dropping them everywhere', () => {
  /** Runner labels from the workflow's matrix, read from the file rather than assumed. */
  function matrixRunners(): string[] {
    const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const list = /^\s*os:\s*\[([^\]]+)\]/m.exec(yml)?.[1];
    if (list === undefined) {
      throw new Error(
        'could not read the `os:` matrix out of .github/workflows/ci.yml. This guard is the only ' +
          'thing keeping the browser specs on some host; a parse that silently returned nothing ' +
          'would report health while they ran nowhere, so it throws instead.',
      );
    }
    return list.split(',').map((entry) => entry.trim());
  }

  /**
   * A runner label's `process.platform`. Throws on an unknown label rather than guessing: a new
   * runner image must be classified deliberately, because guessing wrong in the permissive
   * direction is exactly the silent retirement this file is about.
   */
  function nodePlatformOf(runner: string): string {
    if (runner.startsWith('windows')) return 'win32';
    if (runner.startsWith('ubuntu')) return 'linux';
    if (runner.startsWith('macos')) return 'darwin';
    throw new Error(
      `unknown runner label "${runner}" — teach nodePlatformOf() its process.platform value, ` +
        `and check hostsBrowserSpecs() gives the answer you want for it.`,
    );
  }

  it('omits the solo phase only on a Windows CI runner', () => {
    const CI = { CI: 'true' };
    expect(testPhases(root, read, 'win32', CI).map((p) => p.name)).toEqual(['shared']);
    expect(testPhases(root, read, 'linux', CI).map((p) => p.name)).toEqual(['shared', 'solo']);
    expect(testPhases(root, read, 'darwin', CI).map((p) => p.name)).toEqual(['shared', 'solo']);
    // The condition is the hosted runner, not the operating system. ENVIRONMENT.md names Windows
    // as the primary development host and these specs pass there; keying on the OS alone would
    // have retired them from the machine most of this work happens on, to fix a fault it does not
    // have. Asserted rather than left to the docblock, because it is the half a later "simplify
    // this predicate" edit would drop first.
    expect(testPhases(root, read, 'win32', {}).map((p) => p.name)).toEqual(['shared', 'solo']);
  });

  it('still excludes them from the shared phase on Windows, rather than handing them back', () => {
    // The tempting simplification — drop the solo phase and let the shared glob pick them up — is
    // the worst available arrangement: it runs them in parallel with ~70 other files, which is the
    // contention originally measured at seven failures, and reports it as full coverage.
    const shared = phase('shared', 'win32', { CI: 'true' });
    const browsers = scannedBrowserSpecs();
    expect(browsers.length).toBeGreaterThan(0);
    for (const spec of browsers) {
      expect(shared.args).toContain(spec);
      expect(shared.args[shared.args.indexOf(spec) - 1]).toBe('--exclude');
    }
  });

  it('keeps a host in the CI matrix that runs them', () => {
    const runners = matrixRunners();

    // Anti-vacuity, and pointed at the specific way this could pass over nothing: a regex that
    // matched an empty list, or a workflow that lost its matrix, would satisfy the arm below by
    // having nothing to disagree with.
    expect(runners.length).toBeGreaterThan(1);
    expect(runners).toContain('windows-latest');

    // `{ CI: 'true' }` explicitly, never `process.env`: the question is what happens *on a
    // runner*, and reading this machine's environment would answer it for a developer's laptop
    // instead — where the predicate is true for every platform and the check therefore cannot
    // fail. That is the same defect as asserting on a value derived from the thing under test.
    expect(
      runners.filter((runner) => hostsBrowserSpecs(nodePlatformOf(runner), { CI: 'true' })),
      'every runner in the CI matrix is one that skips the browser specs, so they now run ' +
        'nowhere and every leg will be green. scripts/test-phases.mjs drops them on a Windows ' +
        'runner because that host was measured unable to run them — not because they stopped ' +
        'mattering. Keep a non-Windows leg, or move the browser specs back into the shared gate.',
    ).not.toEqual([]);
  });

  it('the matrix check can fail — control', () => {
    // The assertion above is worth exactly as much as its ability to go red, and its input is a
    // file this test also parses. Drive it with a Windows-only matrix and the same predicate must
    // reject: without this, a `hostsBrowserSpecs` that returned true for everything would leave
    // the arm above green while licensing precisely the edit it forbids.
    const onCi = { CI: 'true' };
    expect(['windows-latest'].filter((r) => hostsBrowserSpecs(nodePlatformOf(r), onCi))).toEqual(
      [],
    );
    expect(['ubuntu-latest'].filter((r) => hostsBrowserSpecs(nodePlatformOf(r), onCi))).toEqual([
      'ubuntu-latest',
    ]);
    expect(() => nodePlatformOf('freebsd-13')).toThrow(/unknown runner label/);
  });
});

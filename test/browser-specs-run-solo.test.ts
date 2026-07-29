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
  BROWSER_IMPORT,
  browserSpecs,
  isHostedCi,
  SOLO_SKIP_REASON,
  soloEnabled,
  specFiles,
  testPhases,
} from '../scripts/test-phases.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The binding name, written as a concatenation — and the asymmetry with the classifier is the
 * whole point of this file, not an inconsistency.
 *
 * `scripts/test-phases.mjs` classifies by parsing the file's syntax, so a mention of the name in
 * a comment, a string or a template literal cannot be mistaken for an import; it needs no dodge
 * and has none. This guard's scan is deliberately **textual**, because a second detector that
 * shares the first one's mechanism cannot disagree with it, and a check whose two sides cannot
 * disagree is a tautology (AGENTS.md §6.2). Textual means self-matching, so this file — which is
 * itself in the corpus it scans, and which builds synthetic import statements below — has to keep
 * the concatenation.
 */
const NAME = 'launch' + 'Browser';

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
 * Strip line and block comments, so a file that merely *discusses* the launcher is not counted
 * as using it. Approximate by design: a comment opener inside a string literal is stripped too.
 * That is safe in one direction only, and one direction is enough — stripping can only *remove*
 * text, so it can only ever produce a false negative, and a false negative here shows up as a
 * disagreement with the classifier, i.e. as a red, never as a silent pass.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The browser specs, derived here and *not* taken from the classifier.
 *
 * Every arm below that says something about the phases has to compare them against a set with
 * independent provenance, or it is comparing the classifier to itself. Measured: the first
 * version of this file drove the solo-phase and `minFiles` arms from `browserSpecs()`, and the
 * undercount control — make the classifier return one file instead of two — left both of them
 * **green**, because both sides shrank together. Only the arm anchored on this scan went red.
 *
 * "Independent" now means independent of *mechanism*, not merely of corpus. The classifier parses
 * the file and asks whether it imports the binding; this asks whether the name appears in code
 * once comments are removed. The two agree on this repository today (measured: the same two
 * files) and are built to fail differently, which is what makes their equality a real check:
 *
 *   - a mention in a comment, a string or a template literal — neither sees it;
 *   - `import { launchBrowser as boot }` — both see it (the classifier reads the imported name,
 *     not the local alias; the scan sees the word);
 *   - `import * as browser` then `browser.<name>(` — this scan sees it, the classifier does not;
 *   - a dynamic `await import(...)` — the classifier does not see it, and neither does this
 *     unless the name is written out.
 *
 * Each of those disagreements is a finding rather than a nuisance: it names a call shape one of
 * the two detectors cannot classify, which is precisely the information a single detector of
 * either kind destroys by answering confidently.
 */
function scannedBrowserSpecs(): string[] {
  const word = new RegExp(`\\b${NAME}\\b`);
  return allSpecsFromGit()
    .filter((path) => word.test(withoutComments(read(path))))
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
    expect(() => browserSpecs(root, () => '')).toThrow(/no spec imports/);
    expect(() => testPhases(root, () => '')).toThrow(new RegExp(BROWSER_IMPORT));
  });

  it('classifies by the import and not by the file name', () => {
    // A name-based rule is the tempting shortcut and it is wrong in both directions: a spec
    // called `browser-*` that never launches one would be serialised for no reason, and a spec
    // called anything else that does would be starved. Driven over a corpus written here, so
    // both directions are exercised on data this repository does not happen to contain.
    const corpus = [
      'packages/x/src/quiet-browser.test.ts', // named for a browser, launches none
      'packages/x/src/renderer-e2e.test.ts', // named for nothing, launches one
    ];
    const synthetic = (path: string): string =>
      path === 'packages/x/src/renderer-e2e.test.ts'
        ? `import { ${NAME} } from './browser.js';\nawait ${NAME}();\n`
        : '';
    expect(browserSpecs(root, synthetic, corpus)).toEqual(['packages/x/src/renderer-e2e.test.ts']);
  });

  it('does not classify a file whose only mention of the launcher is in prose', () => {
    // The defect this landing closes, watched directly rather than inferred from the rewrite.
    // Under the previous text-occurrence rule every one of these three files was classified as a
    // browser spec and pushed into the serialised phase; a file that discusses the launcher and a
    // file that uses it were the same bytes. `browser-playability.test.ts` really does mention it
    // in four comments and a regex source, so this is the live shape and not an invented one.
    const corpus = [
      'packages/x/src/talks-about-it.test.ts',
      'packages/x/src/quotes-an-import.test.ts',
      'packages/x/src/holds-a-regex.test.ts',
      'packages/x/src/actually-imports-it.test.ts',
    ];
    const sources: Record<string, string> = {
      'packages/x/src/talks-about-it.test.ts': `// call ${NAME}() before each case\nexport const a = 1;\n`,
      'packages/x/src/quotes-an-import.test.ts': `/* import { ${NAME} } from './browser.js'; */\nexport const a = 1;\n`,
      'packages/x/src/holds-a-regex.test.ts': `const calls = /${NAME}\\(([^;\\n]*)\\)/g;\nexport const a = calls;\n`,
      'packages/x/src/actually-imports-it.test.ts': `import { ${NAME} } from './browser.js';\nawait ${NAME}();\n`,
    };
    const read4 = (path: string): string => sources[path] ?? '';

    // The accepting arm sits in the same corpus deliberately: a classifier that answered "no" to
    // everything would satisfy the three refusals, and "found nothing" is the exact failure this
    // whole file exists to refuse.
    expect(browserSpecs(root, read4, corpus)).toEqual([
      'packages/x/src/actually-imports-it.test.ts',
    ]);
  });

  it('sees a renamed import, which is the same capability under another local name', () => {
    const corpus = ['packages/x/src/renamed.test.ts'];
    const renamed = (): string =>
      `import { ${NAME} as boot } from './browser.js';\nawait boot();\n`;
    expect(browserSpecs(root, renamed, corpus)).toEqual(corpus);
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
    expect(() => testPhases(root, () => '', 'win32', true)).toThrow(new RegExp(BROWSER_IMPORT));
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

  it('does not re-assert the demand parity that landing #34 withdrew', () => {
    // THE RETIRED CLAIM. This string said "with identical page demand on both", and the ADR said
    // "the demand is the same on both legs". Both rested on the three phase windows agreeing
    // across the legs -- and all three of those windows close on `about:blank`, before the first
    // navigation to a `/play/*` page. So they establish parity for a blank page and say nothing
    // about the page whose cost is the entire question. Measured separately by the
    // `rumukh-fix-ci-workflows` session: blank paces at 60fps on ubuntu and 64fps on windows,
    // while the fps game page runs its sim at 65.0 and 7.0 ticks/s.
    //
    // WHY AN ASSERTION RATHER THAN JUST A FIXED STRING. This repository has measured that a wrong
    // claim removed from one place reappears from another -- one line in a design doc reached six
    // channels, and one sentence in AGENTS.md reproduced itself into three. A correction with no
    // detector is a correction with a half-life. The deletion is the thing under test, in the same
    // shape as `BROWSER_MARKER`'s: the proof that a class is closed is that putting it back fails.
    expect(SOLO_SKIP_REASON).not.toContain('identical page demand');
    expect(SOLO_SKIP_REASON).not.toMatch(/demand is the same/i);
    // And the withdrawal is stated rather than merely absent -- a reader who finds no demand claim
    // cannot tell "measured equal, not worth saying" from "never measured".
    expect(SOLO_SKIP_REASON).toMatch(/OPEN/);
    expect(SOLO_SKIP_REASON).toContain('about:blank');

    // Anti-vacuity. Every assertion above is satisfied by the empty string, which is exactly the
    // shape that has produced six false negatives in this project: an instrument returning
    // nothing reads identical to an instrument reporting nothing wrong.
    expect(SOLO_SKIP_REASON.length).toBeGreaterThan(200);
    // ...and the negative arms really can fire: the same checks against the string as it stood
    // before this landing must fail, or they are pinning nothing.
    const retired =
      'a hosted windows-latest runner cannot schedule this process alongside a ' +
      'software-rasterising Chrome: ... at 88% and 100% box load respectively, with identical ' +
      'page demand on both. See docs/adr/0010-browser-specs-do-not-run-on-hosted-windows.md — ' +
      'this is an exclusion, not a pass';
    expect(retired).toContain('identical page demand');
    expect(retired).not.toMatch(/OPEN/);
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

/**
 * The browser phase is omitted on a hosted Windows runner. That must stay a statement about *that
 * host* and never become a statement about every host.
 *
 * The guards above are complete about the phase logic: given a platform and a hosted flag, they
 * pin exactly which phases run. None of them can see the input that decides whether the exempt
 * branch is the only branch ever taken — the CI matrix. `soloEnabled` is a pure function of
 * arguments the workflow supplies, so trimming `.github/workflows/ci.yml` to Windows alone leaves
 * every assertion in this file green while the browser specs run **nowhere**, and the visible
 * result is a fully green CI, which is the outcome an author making that edit is looking for.
 *
 * That is this repository's oldest failure shape — an instrument that produces nothing reading
 * identically to an instrument reporting nothing wrong — reached through the one door the
 * exemption opened. It costs one assertion to close, and the exemption is what makes it load
 * bearing: the fix that turned CI green (landing #33) is only sound while a non-Windows leg
 * exists to carry the specs it stopped running.
 */
describe('the windows exemption cannot quietly become a universal one', () => {
  /** Runner labels from the workflow's matrix, read from the file rather than assumed. */
  function matrixRunners(): string[] {
    const yml = read('.github/workflows/ci.yml');
    const list = /^\s*os:\s*\[([^\]]+)\]/m.exec(yml)?.[1];
    if (list === undefined) {
      throw new Error(
        'could not read the `os:` matrix out of .github/workflows/ci.yml. This guard is the only ' +
          'thing keeping the browser specs on any host at all, so a parse that silently returned ' +
          'nothing would report health while they ran nowhere. It throws instead.',
      );
    }
    return list.split(',').map((entry) => entry.trim());
  }

  /**
   * A runner label's `process.platform`. Throws on an unknown label rather than guessing: a new
   * runner image has to be classified deliberately, because guessing in the permissive direction
   * is precisely the silent retirement this block exists to prevent.
   */
  function nodePlatformOf(runner: string): string {
    if (runner.startsWith('windows')) return 'win32';
    if (runner.startsWith('ubuntu')) return 'linux';
    if (runner.startsWith('macos')) return 'darwin';
    throw new Error(
      `unknown runner label "${runner}" — teach nodePlatformOf() its process.platform value, and ` +
        `check soloEnabled() gives the answer you want for it.`,
    );
  }

  it('keeps a runner in the CI matrix that actually runs the browser phase', () => {
    const runners = matrixRunners();

    // Anti-vacuity, aimed at the specific way this arm could pass over nothing: a regex that
    // matched an empty list, or a workflow that lost its matrix, leaves the check below with
    // nothing to disagree with.
    expect(runners.length).toBeGreaterThan(1);
    expect(runners).toContain('windows-latest');

    // `true` for hosted, always, and never `isHostedCi()`: the question is what happens *on a
    // runner*. Reading this process's environment would answer it for whichever machine happened
    // to run the suite — and on a workstation `soloEnabled` is true for every platform, so the
    // assertion would be incapable of failing exactly where it is most needed.
    expect(
      runners.filter((runner) => soloEnabled(nodePlatformOf(runner), true)),
      'every runner in the CI matrix is one that skips the browser specs, so they now run ' +
        'nowhere and every leg will report green. scripts/test-phases.mjs drops them on a hosted ' +
        'windows runner because that host was measured unable to run them — not because they ' +
        'stopped mattering. Keep a non-windows leg, or move them back into the shared gate.',
    ).not.toEqual([]);
  });

  it('the matrix check can fail — control', () => {
    // The arm above is worth exactly what its ability to go red is worth, and it reads a file
    // this block also parses. Driven here over matrices written down rather than read, so both
    // answers are exercised on data this repository does not currently contain.
    expect(['windows-latest'].filter((r) => soloEnabled(nodePlatformOf(r), true))).toEqual([]);
    expect(['ubuntu-latest'].filter((r) => soloEnabled(nodePlatformOf(r), true))).toEqual([
      'ubuntu-latest',
    ]);
    expect(() => nodePlatformOf('freebsd-13')).toThrow(/unknown runner label/);
  });
});

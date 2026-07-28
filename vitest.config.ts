import { fileURLToPath } from 'node:url';
import { defaultExclude, defineConfig } from 'vitest/config';

/** Absolute path to a package's TypeScript source entry point. */
const src = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

/**
 * `@aegis/*` resolves to **source**, not to each package's built `dist`.
 *
 * Every cross-package specifier used to resolve through the workspace `node_modules` symlinks into
 * `dist`, which meant a test run could read a stale or half-written build. In a deterministic
 * engine that failure mode is genuinely dangerous: it surfaces as a state-hash mismatch that is
 * indistinguishable from a real determinism regression, and it cost the fps slice a debugging
 * session. Resolving to source removes the hazard at the root rather than ordering around it —
 * there is no build artefact for a test to race.
 *
 * The built output is still proven: `tsc -b` type-checks and emits every project (including
 * declaration emit, which validates each public surface), and `packages/cli` loads real emitted
 * `dist` modules by file URL in its command tests. Those need a complete build, which the root
 * `pretest` hook guarantees by running `tsc -b` before `vitest`.
 *
 * Keep this list in sync with the workspace packages.
 */
const aegisSourceAliases = [
  { find: /^@aegis\/core\/math$/, replacement: src('core/src/math/index.ts') },
  { find: /^@aegis\/core$/, replacement: src('core/src/index.ts') },
  { find: /^@aegis\/content$/, replacement: src('content/src/index.ts') },
  { find: /^@aegis\/harness$/, replacement: src('harness/src/index.ts') },
  { find: /^@aegis\/mode-platformer$/, replacement: src('mode-platformer/src/index.ts') },
  { find: /^@aegis\/mode-iso$/, replacement: src('mode-iso/src/index.ts') },
  { find: /^@aegis\/mode-fps$/, replacement: src('mode-fps/src/index.ts') },
  { find: /^@aegis\/render-three$/, replacement: src('render-three/src/index.ts') },
  { find: /^@aegis\/cli$/, replacement: src('cli/src/index.ts') },
];

/**
 * Test files that launch a real Chromium, and must therefore run with the machine to themselves.
 *
 * This is the fix for the only failure this repository's CI has ever produced repeatedly. Every
 * red `windows-latest` leg for thirteen consecutive pushes to `main` failed in exactly one file,
 * `browser-playability.test.ts`, while `ubuntu-latest` ran the identical 72 files and 1020 tests
 * green. Run 30377421271 is the representative measurement:
 *
 *      leg                suite      browser-playability.test.ts   result
 *      ubuntu-latest      147.7s     47.7s, 16/16                  green
 *      windows-latest     729.5s     607.3s, 9/16                  red
 *
 * Not one of the seven failures was a statement about the product. Two were CDP requests that
 * never came back; three were the file's own ratio of failed to successful page exchanges; two
 * were boot waits expiring with the page's resource timings showing ES modules arriving at 41 546,
 * 54 727, 62 417 and 66 669 ms — a queue draining monotonically. And the file's own CPU sampler
 * named the cause in the log, in the first failure, before anyone read the code:
 *
 *      "this process held a CPU only 0% of the window — it was NOT SCHEDULED, so the box is
 *       oversubscribed by something outside this process."
 *
 * *Outside this process* was the rest of this suite. Vitest's default pool schedules one worker
 * per available core and had ~70 other files to place, so on a 4-vCPU runner the worker hosting
 * the dev server and driving CDP was competing with the whole workspace **and** with the Chromium
 * and SwiftShader processes it had just spawned. Chrome's renderer is not a vitest worker; the
 * pool cannot account for it, so a browser test is oversubscribed by construction wherever cores
 * are scarce. Ubuntu survived it because its runners are faster, which is why this reproduces on
 * one leg only and never on a 16-core development box.
 *
 * `groupOrder` makes the ordering explicit instead: everything else runs as group 0, then these
 * files run alone as group 1, one at a time. That trades a few minutes of wall clock for the only
 * condition under which a wall-clock measurement means anything. A frame-budget assertion on a
 * box that is not scheduling the process is not a slow test — it is an instrument reporting on
 * something other than its subject, and no threshold can repair that.
 *
 * Keep this list in step with reality: `browser-project-membership.test.ts` fails if any test file
 * calls `launchBrowser(` and is not named here.
 */
const BROWSER_TEST_FILES = [
  'packages/render-three/src/browser-playability.test.ts',
  'packages/render-three/src/browser-diagnostics.test.ts',
];

/**
 * The whole workspace is the gate (docs/working-agreement.md §3): every package *and* every
 * PoC game under `games`. The games are what CHARTER §4.3 means by "all three PoCs complete
 * their scripted playthrough headlessly in CI, and assert on gameplay outcomes", so their
 * tests are discovered here — not by a per-game vitest config, and not through a shim
 * parked inside a `packages/mode-<x>` directory.
 *
 * The root `test/` entry covers checks whose subject is the *repository*, not any one
 * package: today, that every code template in `AGENTS.md` is still a verbatim quote of a file
 * this gate runs. Those belong to whoever owns the root documents — the PM — and putting them
 * in a package would hand the guard to an owner who does not own the thing guarded. Adding
 * the glob is what keeps that directory from being an un-gated tree at the repo root, which
 * is the reason a scaffolded `ledge-hop/` was deliberately not committed.
 */
const WORKSPACE_TESTS = [
  'packages/*/src/**/*.{test,spec}.ts',
  'packages/*/test/**/*.{test,spec}.ts',
  'games/*/src/**/*.{test,spec}.ts',
  'games/*/test/**/*.{test,spec}.ts',
  'test/**/*.{test,spec}.ts',
];

export default defineConfig({
  resolve: { alias: aegisSourceAliases },
  test: {
    // Both projects below inherit everything in this block via `extends: true`, including the
    // `@aegis/*` source aliases above. The two `include` lists partition `WORKSPACE_TESTS`, so
    // the corpus the auditor counts is unchanged by the split — `scripts/audit-test-report.mjs`
    // floors it at 60 files and 900 tests precisely so a partition that silently loses a slice
    // cannot read as green.
    projects: [
      {
        extends: true,
        test: {
          name: 'suite',
          include: WORKSPACE_TESTS,
          // Replacing `exclude` replaces vitest's default, so the defaults come along explicitly.
          exclude: [...defaultExclude, ...BROWSER_TEST_FILES],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: BROWSER_TEST_FILES,
          // Runs after group 0 has finished, and one file at a time within itself: two files that
          // each launch Chrome are as bad a pairing as either is with the rest of the suite.
          //
          // `singleFork` rather than the more obvious `fileParallelism: false`, which vitest lists
          // in `NonProjectOptions` — it is settable only at root level, where it would serialize
          // the whole suite. Set on a project it type-errors, and had it been accepted it would
          // have been worse than useless: measured on the first green run of this split, the two
          // browser files were correctly separated from the other 70 and then ran 20–80s and
          // 29–46s, overlapping each other for seventeen seconds. Half a fix that reports as a
          // whole one is the failure mode this repository is most careful about, so the setting
          // that does the work is pinned by `test/browser-project-membership.test.ts`.
          sequence: { groupOrder: 1 },
          poolOptions: {
            forks: { singleFork: true },
            threads: { singleThread: true },
          },
        },
      },
    ],
    // Vitest's 5s default is wrong for this project. A determinism proof legitimately runs the
    // same scripted playthrough two or three times end to end — the fps PoC is three 600-tick
    // first-person simulations plus a full per-tick hash comparison in a single test, and it has
    // been measured between 4.6s and 6.8s depending on how warm the machine is. That is not a
    // slow test to be fixed; it is the work the charter asks for. Left at the default it fails
    // intermittently *by timeout*, which in a deterministic engine reads exactly like a
    // determinism regression and sends whoever sees it hunting a bug that isn't there.
    //
    // 30s was still too tight, and the measurement that shows it is not the obvious one. Per-test
    // durations from a full `--reporter=json` run on a busy 16-core box:
    //
    //   129.3s  harness  lint-guard-rails.invariant  "the probe pipeline itself works"
    //    28.9s  games    sector-breach  "is deterministic: identical hash across independent runs"
    //    14.3s  games    gametest-discovery  "every game exposes at least one runnable GameTest"
    //
    // The dangerous row is the middle one: a *determinism* test finishing 1.06s inside a 30s
    // limit. Nothing about that test is broken — it is one loaded machine from turning red, and
    // the red it produces is the exact false positive the paragraph above exists to prevent. CI
    // runners have 2-4 cores against this box's 16, so the margin there is smaller still, and the
    // `ubuntu-latest` leg is the first cross-OS determinism run this project has ever executed:
    // a timeout there would be indistinguishable from the finding that leg exists to produce.
    //
    // 120s is four times the slowest test that is not a subprocess pipeline. It is a bound on
    // hangs, not a budget — the 129s outlier spawns a real eslint run and needs its own explicit
    // timeout in its own file, which belongs to whoever owns `packages/harness`.
    testTimeout: 120_000,
    // And the same number for hooks, because the default is 10s and nothing here had ever said so.
    //
    // Measured, not reasoned: of the 27 hooks in this repository, 26 ran on vitest's 10 000 ms
    // default and exactly one carried an explicit budget — `browser-playability.test.ts`'s
    // `beforeAll`, raised to 180s in a landing that fixed the file in front of it and left the
    // class open. So a hook had one twelfth of a test's budget while doing the same kind of work:
    // these hooks spawn CLI subprocesses, launch Chrome, and delete scaffolded game trees on
    // Windows. `packages/cli/src/discovery.test.ts`'s `afterEach` blew the 10s default mid-gate at
    // 22 771 ms, in a file whose own sibling case is measured at 12 715 ms — the cleanup was given
    // less room than the thing it cleans up after.
    //
    // The failure mode is the worst one available in this suite, which is why this is not merely
    // tidiness. A `beforeAll` that times out does not fail its file: vitest reports that file's
    // cases as **skipped**, and skipped is not failed. That is exactly how CI run 30324264768
    // reported a green windows leg in 3m36s with nine browser tests that never executed. An
    // `afterEach` that times out is louder but no better — it fails a case that had already
    // passed, and blames whichever case happened to be last.
    //
    // 120s is not a budget for hooks to spend; it is the same bound-on-hangs argument as the line
    // above, applied to the half of the run that had been left on a default nobody chose. A hook
    // that genuinely needs more says so in its own file, and `browser-playability.test.ts`'s 180s
    // still does — it is now an override above a stated root rather than the only thing standing
    // between this suite and 10 seconds.
    hookTimeout: 120_000,
    environment: 'node',
    reporters: ['default'],
  },
});

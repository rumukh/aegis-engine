import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
  { find: /^@aegis\/runtime$/, replacement: src('runtime/src/index.ts') },
  { find: /^@aegis\/narrative$/, replacement: src('narrative/src/index.ts') },
  { find: /^@aegis\/browser$/, replacement: src('browser/src/index.ts') },
  { find: /^@aegis\/browser\/save$/, replacement: src('browser/src/save/index.ts') },
  { find: /^@aegis\/browser\/indexeddb$/, replacement: src('browser/src/save/indexeddb.ts') },
  { find: /^@aegis\/browser\/checkpoint$/, replacement: src('browser/src/save/checkpoint.ts') },
  { find: /^@aegis\/browser\/audio$/, replacement: src('browser/src/audio/index.ts') },
  { find: /^@aegis\/browser\/audio\/nodes$/, replacement: src('browser/src/audio/nodes.ts') },
  { find: /^@aegis\/browser\/ui$/, replacement: src('browser/src/ui/index.ts') },
  { find: /^@aegis\/browser\/offline$/, replacement: src('browser/src/offline/index.ts') },
  { find: /^@aegis\/browser\/offline\/worker$/, replacement: src('browser/src/offline/worker.ts') },
  { find: /^@aegis\/content$/, replacement: src('content/src/index.ts') },
  { find: /^@aegis\/harness$/, replacement: src('harness/src/index.ts') },
  { find: /^@aegis\/mode-platformer$/, replacement: src('mode-platformer/src/index.ts') },
  { find: /^@aegis\/mode-iso$/, replacement: src('mode-iso/src/index.ts') },
  { find: /^@aegis\/mode-fps$/, replacement: src('mode-fps/src/index.ts') },
  { find: /^@aegis\/render-three$/, replacement: src('render-three/src/index.ts') },
  { find: /^@aegis\/cli$/, replacement: src('cli/src/index.ts') },
];

export default defineConfig({
  resolve: { alias: aegisSourceAliases },
  test: {
    setupFiles: ['./test/setup/cooperative-worker.ts'],
    // The whole workspace is the gate (docs/working-agreement.md §3): every package *and* every
    // PoC game under `games`. The games are what CHARTER §4.3 means by "all three PoCs complete
    // their scripted playthrough headlessly in CI, and assert on gameplay outcomes", so their
    // tests are discovered here — not by a per-game vitest config, and not through a shim
    // parked inside a `packages/mode-<x>` directory.
    //
    // The root `test/` entry covers checks whose subject is the *repository*, not any one
    // package: today, that every code template in `AGENTS.md` is still a verbatim quote of a file
    // this gate runs. Those belong to whoever owns the root documents — the PM — and putting them
    // in a package would hand the guard to an owner who does not own the thing guarded. Adding
    // the glob is what keeps that directory from being an un-gated tree at the repo root, which
    // is the reason a scaffolded `ledge-hop/` was deliberately not committed.
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/test/**/*.{test,spec}.ts',
      'games/*/src/**/*.{test,spec}.ts',
      'games/*/test/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
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

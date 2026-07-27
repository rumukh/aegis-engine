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
    testTimeout: 30_000,
    environment: 'node',
    reporters: ['default'],
  },
});

// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Determinism guard rails (CHARTER principle 3).
 *
 * Simulation packages must never read a wall clock or an unseeded RNG, and must
 * never call a platform-provided transcendental (libm results are not guaranteed
 * bit-identical across OS/CPU). They use `@aegis/core`'s deterministic math instead.
 * See docs/adr/0001-determinism-strategy.md.
 */
const bannedMathProps = [
  'random',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'exp',
  'expm1',
  'pow',
  'log',
  'log2',
  'log10',
  'log1p',
  'cbrt',
  'hypot',
  'sinh',
  'cosh',
  'tanh',
].map((property) => ({
  object: 'Math',
  property,
  message:
    'Non-deterministic or platform-dependent. Use @aegis/core deterministic math (see ADR-0001).',
}));

/**
 * Golden-hash guard rail (CHARTER principle 6, ADR-0008).
 *
 * A golden master must be pinned to a **literal**. `hashEquals(result.hash)` compares a run to
 * itself: it is vacuously true, can never fail, and pins nothing — while reading exactly like a
 * determinism regression test. See docs/architecture.md §7.
 *
 * **The scope is the rule, not the pattern.** The same line is *correct* inside `@aegis/harness`'s
 * own tests, where `expectSim` is the subject under test and feeding it a matching hash is
 * precisely how you assert "accepts a correct hash without throwing". Everywhere else — games,
 * modes, the CLI — `expectSim` is a tool being used to pin a golden master, and the
 * self-comparison is always a defect. So the ban is lifted for `packages/harness/src/**` *.test.ts
 * by location, in preference to inline exemptions, which are exactly the thing that would get
 * copy-pasted into a game test later.
 */
const noSelfReferentialGoldenHash = {
  selector:
    "CallExpression[callee.property.name='hashEquals'] > MemberExpression[property.name='hash']",
  message:
    'hashEquals(<run>.hash) compares the run to itself and can never fail. Pin a literal golden hash instead (docs/architecture.md §7, ADR-0008).',
};

/** Wall-clock time is not reproducible; the simulation substrate may never read it (ADR-0001). */
const noWallClockDate = {
  selector: "NewExpression[callee.name='Date']",
  message: 'Wall-clock time breaks determinism (ADR-0001).',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      // Contract stubs legitimately throw for not-yet-implemented behaviour.
      '@typescript-eslint/no-empty-function': 'off',
      'no-restricted-syntax': ['error', noSelfReferentialGoldenHash],
    },
  },
  {
    // Determinism-sensitive code: the simulation substrate *and* everything built on it that
    // participates in a state hash.
    //
    // `games/*` belongs here and was missing until now. That was the worst possible omission:
    // game code is where the AI, patrols, damage and win conditions live, so it is the code most
    // likely to reach for a random or a clock, and the code whose non-determinism would silently
    // corrupt a golden hash. The guard rail was pointed at the safest packages and away from the
    // riskiest. Verified before the fix: `Math.random() + Date.now()` inserted into
    // `games/iso/src/server-vault.ts` produced zero eslint problems.
    //
    // `test/**` is listed alongside `src/**` deliberately. Package tests already live in `src`, so
    // they were always covered; game tests live in a sibling `test/` directory and were not. A
    // determinism proof that itself reads a wall clock proves nothing. The `packages/*/test/**`
    // entries are prospective — no such directory exists today — so that a guard rail is never
    // again defeated simply by putting a file in a directory the glob forgot.
    //
    // Deliberately NOT listed: `packages/render-three` (a renderer legitimately runs on a wall
    // clock) and `packages/cli` (a process, not a simulation).
    files: [
      'packages/core/src/**/*.ts',
      'packages/core/test/**/*.ts',
      'packages/content/src/**/*.ts',
      'packages/content/test/**/*.ts',
      'packages/harness/src/**/*.ts',
      'packages/harness/test/**/*.ts',
      'packages/mode-platformer/src/**/*.ts',
      'packages/mode-platformer/test/**/*.ts',
      'packages/mode-iso/src/**/*.ts',
      'packages/mode-iso/test/**/*.ts',
      'packages/mode-fps/src/**/*.ts',
      'packages/mode-fps/test/**/*.ts',
      'games/*/src/**/*.ts',
      'games/*/test/**/*.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Wall-clock time breaks determinism (ADR-0001).' },
        { name: 'performance', message: 'Wall-clock time breaks determinism (ADR-0001).' },
      ],
      'no-restricted-properties': [
        'error',
        ...bannedMathProps,
        {
          object: 'performance',
          property: 'now',
          message: 'Wall-clock time breaks determinism (ADR-0001).',
        },
      ],
      // Flat config replaces a rule's options wholesale rather than merging them, so each block
      // that sets `no-restricted-syntax` must restate every selector it wants to keep.
      'no-restricted-syntax': ['error', noWallClockDate, noSelfReferentialGoldenHash],
    },
  },
  {
    // The harness's own tests are the one place `expectSim` is the *subject* rather than the tool,
    // so `hashEquals(result.hash)` there is the correct way to assert "accepts a matching hash
    // without throwing" — see the note on `noSelfReferentialGoldenHash`. The determinism selectors
    // still apply. Must stay after the block above, which this narrows.
    files: ['packages/harness/src/**/*.test.ts', 'packages/harness/test/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noWallClockDate],
    },
  },
  {
    // Node tooling scripts and flat-config files run in Node, not the sim sandbox.
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,mjs,ts}', 'eslint.config.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Test files may use loose typing helpers.
    files: ['**/*.{test,spec}.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);

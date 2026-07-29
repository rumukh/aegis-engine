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
];

const bannedMathMessage =
  'Non-deterministic or platform-dependent. Use @aegis/core deterministic math (see ADR-0001).';

const restrictedMathProperties = bannedMathProps.map((property) => ({
  object: 'Math',
  property,
  message: bannedMathMessage,
}));

/**
 * Golden-hash guard rail (CHARTER principle 6, ADR-0008).
 *
 * A golden master must be pinned to a **literal**. `hashEquals(result.hash)` compares a run to
 * itself: it is vacuously true, can never fail, and pins nothing — while reading exactly like a
 * determinism regression test. See docs/architecture.md §7.
 *
 * **Absolute: no location scoping, no exemptions.** The idiom was found independently four times,
 * which is the evidence that human attention is the wrong control for it — so the rule must have
 * no special case for anyone to imitate. A rule that is legal in the package that authors the
 * exemplars would not have stopped this, and an inline `eslint-disable` is exactly what the next
 * author copies (and is forbidden by docs/working-agreement.md §4 anyway). The one place the
 * pattern was arguably legitimate — a harness test where the hash is incidental rather than the
 * subject — pins the literal too, so nothing needed an exception.
 *
 * Known limit, stated rather than implied: this is syntactic. `const h = r.hash` followed by
 * `hashEquals(h)` evades it, so it catches the idiom as written and copied, not every possible
 * spelling of a self-comparison. That bypass is deliberately **not demonstrated anywhere in the
 * repository** — there are zero occurrences of a run's own hash reaching `hashEquals`, by any
 * spelling, and `packages/harness/src/golden-hash.invariant.test.ts` is the runner for that claim,
 * since this selector cannot check it. An author blocked by this rule will grep for how others
 * satisfied it, and a working example of the bypass is the next thing that would be copied.
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

// `no-restricted-properties` sees `Math.sin` and, in this ESLint version, also
// `const { sin } = Math` and `Math['sin']`. It does **not** see two forms that were verified to
// slip through: aliasing the object (`const M = Math; M.sin(x)`) and a non-literal computed key
// (`const k = 'sin'; Math[k](x)`). Neither has a legitimate use in a simulation package — core
// exposes its own math surface — so both are banned outright rather than enumerated.
const restrictedMathSyntax = [
  {
    selector: "MemberExpression[computed=true][object.name='Math']",
    message: `${bannedMathMessage} Computed access to Math is banned outright, because a non-literal key evades the property rule.`,
  },
  {
    selector: "VariableDeclarator[init.name='Math']",
    message: `${bannedMathMessage} Aliasing or destructuring Math is banned outright, because an alias evades the property rule.`,
  },
];

export default tseslint.config(
  {
    // `dist-site/` is the exported static site: a copy of already-linted `dist/` output plus
    // three.js's 1.27 MB bundle. Linting it produced 240 errors about `console` and `window` in
    // somebody else's ESM build. It is ignored for exactly the reason `**/dist/**` is — it is
    // output, not source — and it needs its own entry only because the name does not end in
    // `dist`.
    ignores: [
      '**/dist/**',
      'dist-site/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'coverage/**',
    ],
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
        ...restrictedMathProperties,
        {
          object: 'performance',
          property: 'now',
          message: 'Wall-clock time breaks determinism (ADR-0001).',
        },
      ],
      // Flat config *replaces* a rule's options rather than merging them, so every selector that
      // must apply to these files has to live in this one array. Declaring any of them in another
      // block that also matches would silently drop the rest — and a lint rule that has stopped
      // firing does not fail, it just checks less, so `npm run verify` is green either way.
      //
      // All three families are therefore restated here: the wall-clock ban, the two Math evasions,
      // and the golden-hash ban. That last one is also set by the earlier `**/*.ts` block, which
      // matches these files too; this block wins because it comes later, so omitting it here would
      // silently disarm the golden-hash rule for the entire simulation substrate and all three
      // games. The hazard is therefore order-dependent as well as co-location-dependent: moving
      // these two blocks past each other, or adding a third matching block below, breaks it.
      'no-restricted-syntax': [
        'error',
        noWallClockDate,
        ...restrictedMathSyntax,
        noSelfReferentialGoldenHash,
      ],
    },
  },
  {
    // Node tooling scripts and flat-config files run in Node, not the sim sandbox.
    //
    // `poc/**` is here for the same reason: it is the composition root where the engine meets the
    // games, it runs under `node`, and `poc/build-site.mjs` reads `process.argv` and writes to
    // `process.stdout`. Without this entry those are bare `no-undef` errors — a lint failure that
    // says nothing about determinism and everything about a glob that had not been extended.
    files: [
      'scripts/**/*.{js,mjs}',
      'poc/**/*.{js,mjs}',
      '*.config.{js,mjs,ts}',
      'eslint.config.js',
    ],
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

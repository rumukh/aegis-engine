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
 * `hashEquals(result.hash)` compares a run to itself: it is vacuously true, can never
 * fail, and pins nothing — while reading exactly like a determinism regression test.
 * The golden hash must be a literal, derived once from a green run and updated
 * deliberately. See docs/architecture.md §7.
 */
const noSelfReferentialGoldenHash = {
  selector: "CallExpression[callee.property.name='hashEquals'] > MemberExpression[property.name='hash']",
  message:
    'hashEquals(<run>.hash) compares the run to itself and can never fail. Pin a literal golden hash instead (docs/architecture.md §7, ADR-0008).',
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
    // Determinism-sensitive packages: the simulation substrate.
    files: [
      'packages/core/src/**/*.ts',
      'packages/content/src/**/*.ts',
      'packages/harness/src/**/*.ts',
      'packages/mode-platformer/src/**/*.ts',
      'packages/mode-iso/src/**/*.ts',
      'packages/mode-fps/src/**/*.ts',
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
      // Flat config replaces a rule's options wholesale rather than merging them, so this
      // block must restate the golden-hash selector alongside its own.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Wall-clock time breaks determinism (ADR-0001).',
        },
        noSelfReferentialGoldenHash,
      ],
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

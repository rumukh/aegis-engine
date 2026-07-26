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
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Wall-clock time breaks determinism (ADR-0001).',
        },
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

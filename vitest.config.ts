import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests import from each package's `src` (relative) or from built siblings via
    // workspace symlinks. `npm run build` runs before `npm test` in CI so cross-package
    // imports resolve against emitted declarations.
    include: ['packages/*/src/**/*.{test,spec}.ts', 'packages/*/test/**/*.{test,spec}.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});

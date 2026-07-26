import { defineConfig } from 'vitest/config';

// Local config so this slice's game test can be run independently:
//   npx vitest run --config games/fps/vitest.config.ts
// The root `vitest.config.ts` only globs `packages/*`, so until the harness owner wires
// `games/*` into the root include (see the handoff), this is how the game's `defineGameTest`
// is exercised. Tests resolve `@aegis/*` from the built workspace packages via node_modules
// symlinks, exactly as the package tests do.
export default defineConfig({
  test: {
    include: ['games/fps/test/**/*.{test,spec}.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});

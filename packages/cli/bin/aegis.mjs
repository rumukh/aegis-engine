#!/usr/bin/env node
/**
 * The `aegis` executable, as a file that **exists in the repository**.
 *
 * npm creates `node_modules/.bin/aegis` during install, and it only links a `bin` whose target is
 * already on disk. Pointing `bin` straight at `dist/main.js` therefore produced a chicken-and-egg
 * failure on every clean clone: `npm ci` linked nothing (`dist` does not exist yet), `npm run
 * build` created the target too late, and `npx aegis` died with `could not determine executable to
 * run` — a message naming neither this package nor the build. The documented workaround was to run
 * `npm install` a second time (`AGENTS.md` §9 #7).
 *
 * That is a footgun on a workstation and a hazard in CI, where a hosted runner *is* a clean clone:
 * anything shelling out to `aegis` fails there in a way that reads as a registry or proxy fault.
 *
 * This file is committed, so the link is always created. It forwards to the build when there is
 * one; when there is not, it says exactly that — which is the point. An absent build should be a
 * one-line instruction, not a missing command.
 *
 * `node:process` is imported rather than taken from the global, because the repository's flat
 * ESLint config only grants Node globals to `scripts/**` and `*.config.*`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stderr, exit } from 'node:process';

const entry = new URL('../dist/main.js', import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  stderr.write(
    `[aegis] this checkout has no build yet: ${fileURLToPath(entry)} does not exist.\n` +
      `Run \`npm run build\` from the repository root (\`npm run verify\` builds before it tests).\n`,
  );
  exit(69); // EX_UNAVAILABLE — the command exists; its implementation is not built.
}

await import(entry.href);

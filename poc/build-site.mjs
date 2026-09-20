// Export the four demo games as a **static** site — the artifact GitHub Pages serves:
//
//   npm run build
//   npm run build:site            # writes dist-site/
//   node poc/build-site.mjs --out somewhere/else
//
// The site has no server behind it. Each game page builds the same deterministic simulation
// `node poc/play.mjs` builds — same composed plugin, same scene document, same fixed timestep —
// and steps it in the browser. See packages/render-three/src/static-site.ts for the export rules
// and packages/render-three/src/client/static-boot.ts for what runs in the page.
//
// Like the rest of `poc/`, this file is the composition root where the engine meets the games. It
// is deliberately not a workspace project, which is the only reason it is allowed to name both.
import { join } from 'node:path';
import { exportStaticSite } from '../packages/render-three/dist/static-site.js';
import { findRepoRoot } from '../packages/render-three/dist/catalog.js';
import { pocStaticGames, pocStaticModules } from './poc-games.mjs';

const root = findRepoRoot();
const flag = process.argv.indexOf('--out');
const outDir =
  flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : join(root, 'dist-site');

const result = exportStaticSite({
  games: await pocStaticGames(),
  modules: await pocStaticModules(root),
  outDir,
  repoRoot: root,
});

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
process.stdout.write(
  `static site : ${result.outDir}\n` +
    `pages       : ${result.pages.join(', ')}\n` +
    `modules     : ${result.modules} (module graph crawled from the pages' own entry points)\n` +
    `files       : ${result.files.length}\n` +
    `size        : ${kb(result.bytes)}\n`,
);
// Named rather than swallowed: a deferred specifier is a `import(...)` the artifact cannot serve.
// It is not fatal — the branch may never run, which is exactly why `@aegis/harness` defers
// `node:fs/promises` — but a build that quietly knew about one and said nothing would be the
// difference between "we checked" and "we looked away".
if (result.deferred.length > 0) {
  process.stdout.write(
    `deferred    : ${result.deferred.length} dynamic import(s) the site does not serve\n` +
      result.deferred.map((line) => `              ${line}\n`).join(''),
  );
}

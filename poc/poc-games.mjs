// The composition root for playing the three proof-of-concept games in a browser.
//
// This file, not `packages/render-three/src/`, is where the renderer meets the games.
// `@aegis/render-three` is *engine*: `scripts/check-deps.mjs` forbids anything under `packages/`
// from importing anything under `games/`, by package name or by relative path — "the engine must
// NEVER depend on a game". The dev server is therefore game-agnostic (`startDevServer({ games })`
// takes a catalogue), and the three PoCs are wired in here.
//
// It used to live at `packages/render-three/poc-games.mjs`, where it imported all three
// `@aegis/game-*` packages — a straight violation of that rule that the checker did not see,
// because it scanned only `.ts` files under `src/` and `test/`. Both halves are fixed: the checker
// now scans project-root `.mjs`, and this wiring lives in `poc/`, which is deliberately **not** a
// workspace project. It may name both sides precisely because nothing can depend on it.
//
// The games are ordinary built workspace packages, imported by bare specifier. Nothing is
// transpiled, stripped or resolved by hand.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { platformer } from './platformer.mjs';
import { iso } from './iso.mjs';
import { fps } from './fps.mjs';
import { BINDINGS } from '../packages/render-three/dist/bindings.js';
import { findRepoRoot, loadInputScript, loadScene } from '../packages/render-three/dist/catalog.js';

/**
 * The three PoC games: id, presentation, the **composed** plugin, the scene it runs, the game's
 * own `.input` script, and what a completed playthrough looks like.
 *
 * The script and the acceptance pair are what let the screenshot capture refuse to ship a failed
 * run: it replays the same file the game's acceptance test runs, then requires the win event and
 * a live player. Both are the game's facts, declared here, where the renderer is allowed to know
 * them.
 *
 * `pluginModule`/`pluginExport` say the same thing as `plugin`, in the one other form a consumer
 * can need: a **string** a browser's import map can resolve. The static GitHub Pages build has no
 * Node process to hand it a plugin object, so its generated boot module writes
 * `import { <pluginExport> } from '<pluginModule>'` and the import map points that specifier at
 * the game's own built `dist`. Nothing about the game is duplicated — the page imports the very
 * module `poc/play.mjs` does. `test/pages-site.test.ts` asserts the string and the value agree, so
 * the two spellings cannot drift apart.
 */
export const POC = [platformer, iso, fps];

/** Resolve a repo-relative POSIX path against the repository root. */
function at(root, relative) {
  return join(root, ...relative.split('/'));
}

/** Build the catalogue the dev server and the screenshot capture both serve. */
export async function pocGames() {
  const root = findRepoRoot();
  return Promise.all(
    POC.map(async (entry) => ({
      id: entry.id,
      title: entry.title,
      blurb: entry.blurb,
      objective: entry.objective,
      mode: entry.plugin.mode,
      plugin: entry.plugin,
      scene: await loadScene(at(root, entry.scene)),
      script: await loadInputScript(at(root, entry.script)),
      scriptTicks: entry.scriptTicks,
      acceptance: entry.acceptance,
      presentation: entry.presentation,
      bindings: BINDINGS[entry.plugin.mode],
    })),
  );
}

/**
 * The same catalogue, in the shape the **static** exporter needs.
 *
 * Two differences, and both are consequences of there being no Node process on the other side:
 * the scene travels as *text* (the page embeds it verbatim and runs it through the same
 * `parseScene` a headless run does), and the plugin travels as a module specifier plus an export
 * name rather than as an object.
 */
export async function pocStaticGames() {
  const root = findRepoRoot();
  return Promise.all(
    POC.map(async (entry) => ({
      id: entry.id,
      title: entry.title,
      blurb: entry.blurb,
      objective: entry.objective,
      mode: entry.plugin.mode,
      bindings: BINDINGS[entry.plugin.mode],
      sceneText: await readFile(at(root, entry.scene), 'utf8'),
      pluginModule: entry.pluginModule,
      pluginExport: entry.pluginExport,
      presentation: entry.presentation,
    })),
  );
}

/**
 * The games' own bare specifiers, for the exported site's import map.
 *
 * The entry is read out of each game's `package.json` rather than guessed: `@aegis/game-iso`'s
 * main is `dist/server-vault.js`, not `dist/index.js`, and a table that assumed otherwise would
 * have shipped a site whose iso page imported a module that does not exist.
 */
export async function pocStaticModules(root = findRepoRoot()) {
  return Promise.all(
    POC.map(async (entry) => {
      const dir = at(root, entry.packageDir);
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      const main =
        manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default ?? manifest.main;
      if (typeof main !== 'string') {
        throw new Error(`[aegis:poc] ${entry.packageDir}/package.json names no ESM entry point`);
      }
      return {
        specifier: entry.pluginModule,
        name: entry.pluginModule,
        root: dir,
        entry: join(dir, ...main.replace(/^\.\//, '').split('/')),
      };
    }),
  );
}

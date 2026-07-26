/**
 * The playable catalogue: which games the dev server serves, and how it gets hold of them.
 *
 * A {@link GameDefinition} is deliberately just data plus a {@link ModePlugin} — the dev server
 * never imports a game itself, so it stays game-agnostic and testable with a fake.
 *
 * ## Loading the three PoC games (stopgap — reported to the PM)
 * `games/*` is not consumable by any package today: two of the three have no `package.json`, none
 * are npm workspaces, none appear in the root `tsconfig.json` references, and `check-deps.mjs` has
 * no allow-list entry for `@aegis/game-*`. There is therefore no built artefact to import. Until
 * that is wired centrally, {@link loadPocGames} imports the composed plugins straight from
 * TypeScript source using Node's built-in type stripping, plus a tiny resolver that maps a missing
 * relative `./x.js` to the `./x.ts` beside it (which is what the games' `NodeNext` imports mean).
 * This affects the dev-server process only; nothing is compiled, cached or written to disk.
 * @packageDocumentation
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DiagnosticError } from '@aegis/core';
import type { GameMode } from '@aegis/core';
import { parseScene } from '@aegis/content';
import type { SceneFile } from '@aegis/content';
import type { ModePlugin } from '@aegis/harness';
import { BINDINGS } from './bindings.js';
import type { ModeBindings } from './bindings.js';

/** One playable entry in the dev server's catalogue. */
export interface GameDefinition {
  /** URL slug, e.g. `"iso"`. */
  id: string;
  /** Display title, e.g. `"The Server Vault"`. */
  title: string;
  /** One-line pitch shown on the landing page. */
  blurb: string;
  /** The mode whose adapter draws it. */
  mode: GameMode;
  /** The **composed** game plugin: mode systems plus the game's own. */
  plugin: ModePlugin;
  /** The parsed scene document. */
  scene: SceneFile;
  /** Seed override; defaults to the scene's. */
  seed?: number | string;
  /** Fixed ticks per second. Defaults to `60`. */
  tickRate?: number;
  /** How a human drives it. */
  bindings: ModeBindings;
  /** What "winning" looks like, shown in the HUD. */
  objective: string;
}

/** Where the three PoC games live, relative to the repository root. */
const POC_SOURCES = [
  {
    id: 'platformer',
    title: 'Coyote Gap',
    blurb: 'Side-on platformer: coyote time, jump buffering, a moving platform and a critter.',
    objective: 'Cross the gaps and reach the goal volume on the far right.',
    module: 'games/platformer/src/index.ts',
    exportName: 'coyoteGapPlugin',
    scene: 'games/platformer/levels/coyote-gap.scene.json',
  },
  {
    id: 'iso',
    title: 'The Server Vault',
    blurb: 'Isometric infiltration: click-to-move A*, a patrolling guard, a switch and a door.',
    objective: 'Flip the switch to unseal the vault door, then reach the exit pad.',
    module: 'games/iso/src/server-vault.ts',
    exportName: 'serverVaultPlugin',
    scene: 'games/iso/levels/server-vault.scene.json',
  },
  {
    id: 'fps',
    title: 'Sector Breach',
    blurb: 'First person: hitscan weapon, a blast door, a coolant pit and a security grunt.',
    objective: 'Shoot the panel, jump the coolant pit, kill the grunt, reach the exit.',
    module: 'games/fps/src/index.ts',
    exportName: 'sectorBreachPlugin',
    scene: 'games/fps/levels/sector-breach.scene.json',
  },
] as const;

let hooksRegistered = false;

/**
 * Teach Node's resolver that a relative `./x.js` with no file on disk means the `./x.ts` beside
 * it. `NodeNext` sources are authored that way and Node's type stripping does not rewrite the
 * specifier. Idempotent, and scoped to relative specifiers so nothing else can be affected.
 */
export function registerTypeScriptSourceResolution(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (!relative || !specifier.endsWith('.js')) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const candidate = `${specifier.slice(0, -3)}.ts`;
        try {
          return nextResolve(candidate, context);
        } catch {
          throw error;
        }
      }
    },
  });
}

/**
 * Find the repository root by walking up from this module until a directory holds both `packages`
 * and `games`. Works from `src/` under vitest and from `dist/` when built.
 */
export function findRepoRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'games'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[aegis:render-three] could not locate the repository root above ${from} ` +
      '(expected a directory containing both "packages" and "games").',
  );
}

/** Read and parse a scene document, throwing structured diagnostics on failure. */
async function loadScene(path: string): Promise<SceneFile> {
  const text = await readFile(path, 'utf8');
  const parsed = parseScene(text, path);
  if (!parsed.ok || parsed.value === undefined) throw new DiagnosticError(parsed.diagnostics);
  return parsed.value;
}

/**
 * Load the three PoC games: each game's **composed** plugin (never the bare mode plugin — that
 * would give you a world with the mode's physics and none of the game's rules) plus its scene.
 */
export async function loadPocGames(repoRoot: string = findRepoRoot()): Promise<GameDefinition[]> {
  registerTypeScriptSourceResolution();
  const games: GameDefinition[] = [];
  for (const source of POC_SOURCES) {
    const moduleUrl = pathToFileURL(resolve(repoRoot, source.module)).href;
    const loaded = (await import(moduleUrl)) as Record<string, unknown>;
    const plugin = loaded[source.exportName] as ModePlugin | undefined;
    if (plugin === undefined) {
      throw new Error(
        `[aegis:render-three] ${source.module} does not export "${source.exportName}".`,
      );
    }
    games.push({
      id: source.id,
      title: source.title,
      blurb: source.blurb,
      objective: source.objective,
      mode: plugin.mode,
      plugin,
      scene: await loadScene(resolve(repoRoot, source.scene)),
      bindings: BINDINGS[plugin.mode],
    });
  }
  return games;
}

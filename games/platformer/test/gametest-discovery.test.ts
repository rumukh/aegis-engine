/**
 * The CLI discovery guard: **every** PoC game must be reachable by `aegis test`'s default run.
 *
 * This check is about the games as a *set*, not about the platformer — it lives here only because
 * the root vitest config globs each game's `test` directory, so a cross-game check has to sit inside one of
 * them. It enumerates `games/` from disk, so a fourth game added later is covered automatically
 * and this fails until it too ships a discoverable module.
 *
 * ## Why it exists
 * `aegis test` defaults to any `*.gametest.js` / `.mjs` / `.cjs` module over compiled output and runs every
 * `GameTest` each matched module exports. For a while only `games/platformer` followed that
 * convention: iso defined its playthroughs in `src/server-vault.ts`, and fps defined its inside a
 * vitest file under `test/`, which `tsconfig.json` excludes from the build. So the CLI gate ran
 * the platformer, found nothing wrong, and exited 0 with a green summary — a gate over one of
 * three PoCs. That is a *more* dangerous signal than the empty one it replaced, because it reads
 * as coverage. The failure mode is the one this whole review keeps finding: an instrument that
 * appears to measure more than it does.
 *
 * The check deliberately mirrors the CLI's own contract (glob suffix + "exports a GameTest")
 * rather than shelling out to `aegis test`, which would re-run every playthrough for a second
 * time in the same suite. `packages/cli` owns proving that the runner runs them.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The suffix `aegis test` globs for by default, minus the extension. */
const CONVENTION = '.gametest';

/** Every game workspace directory, read from disk so a new game is picked up automatically. */
function gameDirs(): string[] {
  return readdirSync('games', { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join('games', e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
}

/** Compiled `*.gametest.js` modules a game publishes into `dist/`, as the CLI would find them. */
function discoverableModules(game: string): string[] {
  const dist = join('games', game, 'dist');
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .filter((f) => f.endsWith(`${CONVENTION}.js`))
    .map((f) => join(dist, f))
    .sort();
}

/** The CLI's own predicate for "this export is a runnable GameTest". */
function isGameTest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t['name'] === 'string' &&
    typeof t['scene'] === 'string' &&
    typeof t['ticks'] === 'number' &&
    typeof t['expect'] === 'function'
  );
}

describe('aegis test discovery covers every PoC game', () => {
  it('every game ships at least one *.gametest module in dist', () => {
    const games = gameDirs();
    // Guards against the enumeration itself silently finding nothing.
    expect(games.length).toBeGreaterThanOrEqual(3);

    const found = Object.fromEntries(games.map((g) => [g, discoverableModules(g).length]));
    const missing = games.filter((g) => found[g] === 0);
    expect(
      missing,
      `these games are invisible to \`aegis test\` — they need a src/*${CONVENTION}.ts module: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every game exposes at least one runnable GameTest through that module', async () => {
    const counts: Record<string, number> = {};
    for (const game of gameDirs()) {
      let total = 0;
      for (const file of discoverableModules(game)) {
        const mod: Record<string, unknown> = await import(pathToFileURL(file).href);
        const seen = new Set<unknown>();
        for (const value of Object.values(mod)) {
          if (!seen.has(value) && isGameTest(value)) {
            seen.add(value);
            total += 1;
          }
        }
      }
      counts[game] = total;
    }
    // Reported as a map, not a bare total: a failure names the game that went dark rather than
    // just saying a number moved.
    const empty = Object.entries(counts).filter(([, n]) => n === 0);
    expect(empty, `games discovered but exporting no GameTest: ${JSON.stringify(counts)}`).toEqual(
      [],
    );
  });
});

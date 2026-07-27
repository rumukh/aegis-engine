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
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
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

/** Every `*.gametest.ts` under a game workspace, as repo-relative paths. */
function specSources(game: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith(`${CONVENTION}.ts`)) {
        out.push(full);
      }
    }
  };
  walk(join('games', game));
  return out.sort();
}

/** The `include` each game's tsconfig declares, as authored. */
function tsconfigInclude(game: string): string[] {
  const raw = readFileSync(join('games', game, 'tsconfig.json'), 'utf8');
  return (JSON.parse(raw) as { include?: string[] }).include ?? [];
}

/**
 * The hazard these checks close is the one recorded in
 * (`AGENTS.md` §9, "A spec the build excludes is invisible") — a spec that never reaches the
 * build is never run, and nothing says so out loud.
 *
 * Cited by title fragment rather than by row number on purpose: §9 is a numbered table whose rows
 * get removed and renumbered, so `#3` is an index into a list nobody validates and goes silently
 * wrong the moment a row above it is deleted. The same reasoning is why nothing below quotes the
 * row's *wording*. A comment that restates another document's current text is stale by
 * construction — it decays exactly like the row number does, and a reader who trusts it inherits
 * whatever the other document used to say. What follows is measured from this repository instead,
 * so it is checkable here and does not depend on any other file staying still.
 *
 * **Measured mechanism.** `packages/cli/src/commands/test.ts:36` sets three *recursive* default
 * patterns over `*.gametest.js`, `.mjs` and `.cjs`, rooted at the working directory, and that
 * file's own header states discovery is "glob + shape based, never layout based".
 * `dist/*.gametest.js` is only what each game's `aegis.json` declares; it is not what the CLI
 * looks for. Confirmed behaviourally: a hand-written `.gametest.mjs` placed inside an excluded
 * `test/` directory is found and run (`1 file(s) scanned, 1 test(s) found`).
 *
 * So the binding precondition is **"the build compiles this file to JS"**, not "the file lives
 * under `src/`". Compilation is the mechanism; location is only this repo's convention. That
 * distinction is what makes the three checks below different claims rather than one repeated:
 *
 *  1. **`compiles to a dist artefact` — the mechanism check.** True of a spec in any directory,
 *     and the one that actually catches a spec `aegis test` cannot see: a TypeScript spec the
 *     build skips emits no `.js`, so the layout-agnostic glob has nothing to match.
 *  2. **`lives under src/` — a convention check**, narrower than the mechanism on purpose.
 *     Deriving "will tsc compile this?" honestly would mean re-implementing TypeScript's
 *     include/exclude resolution here, which is a new place to be wrong *in the same direction as
 *     the thing it checks*. A literal test is fine so long as it is labelled convention.
 *  3. **`src/ is every game's only compiled root` — the check that keeps #2 honest.** It asserts
 *     the assumption #2 rests on, so the day a game grows a second compiled root this file names
 *     the broken assumption instead of failing #2 on a perfectly good layout.
 *
 * These replace a mitigation that asked a human to read the scan count in the CLI summary. A
 * number someone is supposed to notice is not a gate; a test that names the offending path is.
 */
describe('a game spec cannot hide from the build', () => {
  it('compiles to a dist artefact — the mechanism `aegis test` actually depends on', () => {
    const missing: string[] = [];
    for (const game of gameDirs()) {
      for (const spec of specSources(game)) {
        const compiled = spec
          .replace(`${sep}src${sep}`, `${sep}dist${sep}`)
          .replace(/\.ts$/, '.js');
        if (!existsSync(compiled)) missing.push(`${spec} -> ${compiled}`);
      }
    }
    expect(
      missing,
      `these specs produced no compiled artefact, so the CLI's **/*.gametest.{js,mjs,cjs} glob ` +
        `has nothing to match and \`aegis test\` runs without them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('follows the convention that a spec lives under src/ (narrower than the mechanism)', () => {
    const stray = gameDirs()
      .flatMap((g) => specSources(g))
      .filter((p) => !p.split(sep).includes('src'));
    expect(
      stray,
      `these specs sit outside src/. That is this repo's convention, not the CLI's rule — the ` +
        `binding constraint is that the build compiles them, which the first check covers: ${stray.join(', ')}`,
    ).toEqual([]);
  });

  it('src/ really is every game\u2019s only compiled root, which is what makes that convention safe', () => {
    const unexpected = gameDirs()
      .map((g) => ({ game: g, include: tsconfigInclude(g) }))
      .filter((e) => e.include.length !== 1 || e.include[0] !== 'src/**/*.ts')
      .map((e) => `${e.game}: include=${JSON.stringify(e.include)}`);
    expect(
      unexpected,
      `the convention check above assumes src/ is the only compiled root. These games declare ` +
        `something else, so that assumption no longer holds and the check must be widened or ` +
        `derived from tsconfig: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });
});

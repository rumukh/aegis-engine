/**
 * The static-site exporter, at the level a synthetic module tree can reach.
 *
 * Everything here is about the ways an export could look successful and be a shell: an import map
 * with an address nothing serves, a page with a root-relative URL that dies under a project Pages
 * prefix, or a module graph that quietly reaches a Node built-in. Each is checked, and each check
 * is separately shown to be capable of firing — a graph checker that answers "closed" to every
 * input would pass this file's happy path and prove nothing at all.
 *
 * The real artifact is checked in `test/pages-site.test.ts`, and the real *browser* is checked in
 * `test/pages-site.browser.test.ts`. Three altitudes, and the reason for three is that they fail
 * differently: this one can be wrong about the repository, the second can be wrong about what a
 * browser does with the bytes, and only the third runs the game.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BINDINGS } from './bindings.js';
import {
  collectModuleGraph,
  engineModules,
  exportStaticSite,
  moduleSpecifiers,
  renderStaticBootModule,
  renderStaticIndexPage,
  renderStaticPlayPage,
  staticImportMap,
  StaticGraphError,
  STATIC_BOOT_SPECIFIER,
} from './static-site.js';
import type { StaticGame, StaticModule } from './static-site.js';

/** A minimal but complete catalogue entry, so each test can vary one thing. */
function game(overrides: Partial<StaticGame> = {}): StaticGame {
  return {
    id: 'demo',
    title: 'Demo',
    blurb: 'A demo.',
    mode: 'platformer',
    objective: 'Reach the flag.',
    bindings: BINDINGS.platformer,
    sceneText: '{"aegis":"scene/1","name":"Demo","mode":"platformer","entities":[]}',
    pluginModule: '@demo/game',
    pluginExport: 'demoPlugin',
    ...overrides,
  };
}

describe('moduleSpecifiers', () => {
  it('finds the three import forms a browser would fetch', () => {
    const found = moduleSpecifiers(
      [
        "import { a } from './a.js';",
        "export * from '../b/c.js';",
        "import 'three';",
        "const later = await import('node:fs/promises');",
      ].join('\n'),
    );
    expect(found.statik.sort()).toEqual(['../b/c.js', './a.js', 'three']);
    expect(found.dynamic).toEqual(['node:fs/promises']);
  });

  it('spans a multi-line import clause, which is how tsc emits a long one', () => {
    const found = moduleSpecifiers("import {\n  a,\n  b,\n  c,\n} from '@aegis/core';\n");
    expect(found.statik).toEqual(['@aegis/core']);
  });

  it('does not read a specifier out of a comment or an indented string (anti-vacuity)', () => {
    // Both of these contain a perfectly well-formed import statement as *text*. An unanchored,
    // comment-blind scan reports two specifiers here, fails the export over modules nobody
    // imports, and sends whoever hits it looking for an import that does not exist.
    const found = moduleSpecifiers(
      [
        "// import { x } from 'not-imported';",
        "/* import { y } from 'also-not'; */",
        '  throw new Error("cannot import z from \'string-only\'");',
      ].join('\n'),
    );
    expect(found.statik).toEqual([]);
  });

  it('still fires on the same text once it is a real statement (the other half)', () => {
    // Without this, the case above would pass over a scanner that found nothing in anything.
    const found = moduleSpecifiers("import { x } from 'not-imported';\n");
    expect(found.statik).toEqual(['not-imported']);
  });
});

describe('collectModuleGraph', () => {
  // Absolute paths are resolved through `path.resolve` on both sides, so the synthetic tree means
  // the same thing on Windows (`C:\pkg\lib`) as on POSIX (`/pkg/lib`).
  const modules: StaticModule[] = [
    {
      specifier: 'lib',
      name: 'lib',
      root: resolve('/pkg/lib'),
      entry: resolve('/pkg/lib/dist/index.js'),
    },
  ];
  /** Drive the crawler over a synthetic tree, so every arm can be reached deliberately. */
  const crawl = (tree: Record<string, string>, entries = ['/site/boot.js']) => {
    const files = new Map(Object.entries(tree).map(([path, text]) => [resolve(path), text]));
    return collectModuleGraph({
      entries: entries.map((entry) => resolve(entry)),
      modules,
      siteRoot: resolve('/site'),
      read: (file) => files.get(resolve(file)) ?? '',
      exists: (file) => files.has(resolve(file)),
    });
  };

  it('follows relative and bare imports and places each module', () => {
    const graph = crawl({
      '/site/boot.js': "import 'lib';",
      '/pkg/lib/dist/index.js': "export * from './inner.js';",
      '/pkg/lib/dist/inner.js': '',
    });
    expect(graph.files.map((f) => f.target)).toEqual([
      'boot.js',
      'vendor/lib/dist/index.js',
      'vendor/lib/dist/inner.js',
    ]);
    expect(graph.usedSpecifiers).toEqual(['lib']);
    expect(graph.deferred).toEqual([]);
  });

  it('refuses a static import it cannot serve — including a Node built-in', () => {
    expect(() =>
      crawl({ '/site/boot.js': "import { readFile } from 'node:fs/promises';" }),
    ).toThrow(StaticGraphError);
    expect(() => crawl({ '/site/boot.js': "import 'node:fs/promises';" })).toThrow(
      /statically imports "node:fs\/promises"/,
    );
  });

  it('records a deferred dynamic import instead of failing on it', () => {
    // This is exactly `@aegis/harness`'s `run.ts`: a Node built-in behind a branch a page never
    // takes. Failing here would forbid the harness from being importable in a browser at all.
    const graph = crawl({
      '/site/boot.js': "const fs = await import('node:fs/promises');",
    });
    expect(graph.deferred).toEqual([expect.stringContaining('node:fs/promises')]);
    expect(graph.files.map((f) => f.target)).toEqual(['boot.js']);
  });

  it('refuses a module that does not exist', () => {
    expect(() => crawl({ '/site/boot.js': "import './missing.js';" })).toThrow(/does not exist/);
  });

  it('refuses a module outside every package root', () => {
    expect(() => crawl({ '/site/boot.js': "import '../escaped.js';", '/escaped.js': '' })).toThrow(
      /outside every package/,
    );
  });

  it('visits each module once, however many times it is imported', () => {
    const graph = crawl({
      '/site/boot.js': "import 'lib';\nimport 'lib';",
      '/pkg/lib/dist/index.js': "import './inner.js';\nexport * from './inner.js';",
      '/pkg/lib/dist/inner.js': '',
    });
    expect(graph.files).toHaveLength(3);
  });
});

describe('staticImportMap', () => {
  it('writes only relative addresses, which is what survives a /<repo>/ Pages prefix', () => {
    const map = JSON.parse(staticImportMap('../../', engineModules('/repo'))) as {
      imports: Record<string, string>;
    };
    const addresses = Object.values(map.imports);
    expect(addresses.length).toBeGreaterThan(5);
    for (const address of addresses) {
      expect(address.startsWith('../../vendor/'), address).toBe(true);
      expect(address.startsWith('/'), address).toBe(false);
    }
  });

  it('maps the browser runtime by its declared subpath, never the Node-only barrel', () => {
    const map = JSON.parse(staticImportMap('../../', engineModules('/repo'))) as {
      imports: Record<string, string>;
    };
    expect(map.imports[STATIC_BOOT_SPECIFIER]).toBe(
      '../../vendor/@aegis/render-three/dist/client/static-boot.js',
    );
    // The barrel re-exports `dev-server.js`, which imports `node:http`. Mapping it would be an
    // invitation to import it.
    expect(map.imports['@aegis/render-three']).toBeUndefined();
  });
});

describe('the generated pages', () => {
  it('never writes a root-relative URL', () => {
    const games = [game(), game({ id: 'other', mode: 'fps', bindings: BINDINGS.fps })];
    const html = [
      renderStaticIndexPage(games),
      ...games.map((g) => renderStaticPlayPage(g, engineModules('/repo'))),
    ].join('\n');
    // A `data:` favicon is the one href that is neither relative nor root-relative, and it is the
    // reason the page makes no request the site does not own.
    for (const match of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      const url = match[1] as string;
      expect(url.startsWith('/'), `${url} is root-relative and breaks under a Pages prefix`).toBe(
        false,
      );
    }
    expect(html).not.toContain('/api/');
  });

  it('links every game from the landing page by a relative route', () => {
    const html = renderStaticIndexPage([game({ id: 'iso' }), game({ id: 'fps' })]);
    expect(html).toContain('href="play/iso/"');
    expect(html).toContain('href="play/fps/"');
  });

  it('shows the session controls, so a human can find pause, step and restart', () => {
    const html = renderStaticPlayPage(game(), engineModules('/repo'));
    expect(html).toContain('pause / resume');
    expect(html).toContain('single-step one tick');
    expect(html).toContain('restart at tick 0');
  });
});

describe('renderStaticBootModule', () => {
  it('imports the plugin by the catalogue’s own specifier and export name', () => {
    const source = renderStaticBootModule(game());
    expect(source).toContain("import { demoPlugin } from '@demo/game';");
    expect(source).toContain(`from '${STATIC_BOOT_SPECIFIER}'`);
    expect(moduleSpecifiers(source).statik.sort()).toEqual(
      ['@aegis/content', '@demo/game', STATIC_BOOT_SPECIFIER].sort(),
    );
  });

  it('embeds the scene document verbatim, and validates it in the page', () => {
    const scene = game().sceneText;
    const source = renderStaticBootModule(game());
    expect(source).toContain(JSON.stringify(scene));
    expect(source).toContain('parseScene(SCENE_TEXT');
  });

  it('refuses an export name that is not an identifier', () => {
    expect(() => renderStaticBootModule(game({ pluginExport: 'not an identifier' }))).toThrow(
      StaticGraphError,
    );
  });
});

describe('exportStaticSite refuses to delete something that matters', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-site-guard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a directory the repository lives inside', () => {
    const repoRoot = join(dir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    expect(() => exportStaticSite({ games: [game()], outDir: dir, repoRoot })).toThrow(
      /repository is inside it/,
    );
  });

  it('refuses a directory holding a package.json', () => {
    const outDir = join(dir, 'project');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'package.json'), '{}');
    expect(() =>
      exportStaticSite({ games: [game()], outDir, repoRoot: join(dir, 'elsewhere') }),
    ).toThrow(/looks like a project directory/);
  });

  it('accepts an ordinary empty output directory (the other half)', () => {
    // Without this the two refusals above would pass over a guard that refused everything, and the
    // exporter would be unusable rather than safe.
    const outDir = join(dir, 'out');
    const repoRoot = join(dir, 'repo');
    const entry = join(repoRoot, 'pkg', 'index.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'export const demoPlugin = {};\n');
    expect(
      () =>
        exportStaticSite({
          games: [game()],
          outDir,
          repoRoot,
          modules: [
            { specifier: '@demo/game', name: '@demo/game', root: join(repoRoot, 'pkg'), entry },
          ],
        }),
      // It gets as far as the engine module table, which does not exist under this fake root — a
      // different failure from the guards above, which is the point: the guard let it through.
    ).toThrow(/does not exist/);
  });
});

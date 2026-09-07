import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticError } from '@aegis/core';
import { BINDINGS } from './bindings.js';
import { findRepoRoot } from './catalog.js';
import { renderIndexPage, renderPlayPage } from './pages.js';
import { platformerPlugin } from '@aegis/mode-platformer';
import type { GameDefinition } from './catalog.js';
import type { PresentationManifest, ResolvedPresentation } from './presentation/schema.js';
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
} from './static-site.js';
import type { ExportOptions, StaticGame, StaticModule } from './static-site.js';

const workspace = resolve(`.aegis-static-presentation-${process.pid}`);
const repoRoot = join(workspace, 'repo');
const assetRoot = join(workspace, 'authored');
const outDir = join(workspace, 'site');
const realRepo = findRepoRoot();
const provenance = { author: 'Aegis tests', license: 'MIT', source: 'authored delivery fixture' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z" fill="#fff"/></svg>';
const manifest: PresentationManifest = {
  aegis: 'presentation/1',
  assets: [
    { id: 'cover', src: 'image.svg', kind: 'texture', provenance },
    { id: 'rig', src: 'model/rig.gltf', kind: 'gltf', provenance },
    { id: 'tone', src: 'tone.wav', kind: 'audio', provenance },
  ],
  entities: [{ target: { name: 'player' }, visual: { kind: 'model', mesh: 'rig' } }],
  hud: { playerName: 'player', winEvent: 'won', loseEvents: ['lost'] },
  ui: { cover: 'cover', eyebrow: 'Local assets', accent: '#123456' },
};
const paths = [
  'image.svg',
  'model/maps/surface.svg',
  'model/mesh.bin',
  'model/rig.gltf',
  'tone.wav',
];
const scene = {
  aegis: 'scene/1',
  name: 'Demo',
  mode: 'platformer',
  entities: [{ id: 'player' }],
} as const;

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function game(overrides: Partial<StaticGame> = {}): StaticGame {
  return {
    id: 'demo',
    title: 'Demo presentation',
    blurb: 'A local fixture.',
    objective: 'Reach the flag.',
    mode: 'platformer',
    bindings: BINDINGS.platformer,
    sceneText: JSON.stringify(scene),
    pluginModule: '@delivery/game',
    pluginExport: 'demoPlugin',
    tickRate: 30,
    presentation: { manifest, assetRoot },
    ...overrides,
  };
}
function modules(): StaticModule[] {
  return [
    ...engineModules(realRepo).filter((module) =>
      [
        'three',
        'three/addons/loaders/GLTFLoader.js',
        'three/addons/utils/SkeletonUtils.js',
      ].includes(module.specifier),
    ),
    {
      specifier: '@delivery/game',
      name: '@delivery/game',
      root: join(repoRoot, 'game'),
      entry: join(repoRoot, 'game', 'index.js'),
    },
  ];
}
function options(games = [game()]): ExportOptions {
  return { games, outDir, repoRoot, modules: modules() };
}
function bootConfig(source: string): {
  presentation?: ResolvedPresentation;
  title: string;
  objective: string;
  tickRate: number;
} {
  const text = /bootStatic\(\{ \.\.\.(\{[^\n]*\}), plugin:/.exec(source)?.[1];
  expect(text).toBeDefined();
  return JSON.parse(text!) as {
    presentation?: ResolvedPresentation;
    title: string;
    objective: string;
    tickRate: number;
  };
}
function sentinel(): void {
  write(join(outDir, 'keep.txt'), 'previous working site');
}

beforeEach(() => {
  write(join(assetRoot, 'image.svg'), svg);
  write(join(assetRoot, 'model', 'maps', 'surface.svg'), svg);
  write(join(assetRoot, 'model', 'mesh.bin'), 'mesh');
  write(
    join(assetRoot, 'model', 'rig.gltf'),
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'mesh.bin', byteLength: 4 }],
      images: [{ uri: 'maps/surface.svg' }],
    }),
  );
  write(join(assetRoot, 'tone.wav'), 'RIFF0000WAVE');
  write(join(assetRoot, 'not-declared.txt'), 'not part of the asset graph');
  // Synthetic engine/plugin entry points isolate the exporter; the addon graph below is real.
  write(join(repoRoot, 'game', 'index.js'), 'export const demoPlugin = {};\n');
  write(
    join(repoRoot, 'packages', 'content', 'dist', 'index.js'),
    'export function parseScene() {}\n',
  );
  write(
    join(repoRoot, 'packages', 'render-three', 'dist', 'client', 'static-boot.js'),
    [
      "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';",
      "import { clone } from 'three/addons/utils/SkeletonUtils.js';",
      'export function bootStatic() {}',
    ].join('\n'),
  );
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('static presentation assets', () => {
  it('copies the exact prepared closure and reports public file/byte/digest/provenance inventory', () => {
    sentinel();
    const result = exportStaticSite(options());
    expect(existsSync(join(outDir, 'keep.txt'))).toBe(false);
    expect(result.assetFiles).toBe(5);
    expect(result.assets.map((entry) => entry.path)).toEqual(
      paths.map((path) => `assets/demo/${path}`),
    );
    expect(result.assetBytes).toBe(
      paths.reduce((total, path) => total + statSync(join(assetRoot, ...path.split('/'))).size, 0),
    );
    for (const entry of result.assets) {
      expect(entry.gameId).toBe('demo');
      expect(entry.provenance).toEqual(provenance);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.files).toContain(entry.path);
      expect(readFileSync(join(outDir, ...entry.path.split('/')))).toEqual(
        readFileSync(join(assetRoot, ...entry.path.slice('assets/demo/'.length).split('/'))),
      );
    }
    expect(result.bytes).toBe(
      result.files.reduce((sum, path) => sum + statSync(join(outDir, ...path.split('/'))).size, 0),
    );
    expect(existsSync(join(outDir, 'assets', 'demo', 'not-declared.txt'))).toBe(false);
    expect(JSON.stringify(result.assets)).not.toContain(assetRoot);
    const config = bootConfig(readFileSync(join(outDir, 'play', 'demo', 'boot.js'), 'utf8'));
    expect(config.presentation).toEqual({ manifest, baseUrl: '../../assets/demo/', files: paths });
    expect(config.title).toBe('Demo presentation');
    expect(config.objective).toBe('Reach the flag.');
    expect(config.tickRate).toBe(30);
    for (const path of [...result.pages, 'play/demo/boot.js']) {
      const text = readFileSync(join(outDir, ...path.split('/')), 'utf8');
      expect(text).not.toContain(assetRoot);
      expect(text).not.toContain('assetRoot');
    }
  });

  it('preflights every game before touching the previous output', () => {
    sentinel();
    const missing = game({
      id: 'missing',
      presentation: {
        assetRoot,
        manifest: {
          aegis: 'presentation/1',
          assets: [{ id: 'absent', src: 'missing.png', kind: 'texture', provenance }],
        },
      },
    });
    expect(() => exportStaticSite(options([game(), missing]))).toThrow(
      /AEG-RENDER-0004.*missing.png/,
    );
    expect(readFileSync(join(outDir, 'keep.txt'), 'utf8')).toBe('previous working site');
    expect(existsSync(join(outDir, 'play'))).toBe(false);
  });

  it('rejects missing model dependencies before replacing output', () => {
    sentinel();
    rmSync(join(assetRoot, 'model', 'mesh.bin'));
    expect(() => exportStaticSite(options())).toThrow(DiagnosticError);
    expect(readFileSync(join(outDir, 'keep.txt'), 'utf8')).toBe('previous working site');
  });

  it.each([false, true])(
    'exports raw-missing names with prefabs=%s unchanged and defers checking to initialization',
    (withPrefabs) => {
      const pending = game({
        sceneText: JSON.stringify({
          ...scene,
          entities: [{ id: 'parent', ...(withPrefabs ? { prefab: 'actor-family' } : {}) }],
        }),
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = exportStaticSite(options([pending]));
        expect(result.assetFiles).toBe(5);
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics?.map((diagnostic) => diagnostic.location?.path)).toEqual([
          'entities[0].target.name',
          'hud.playerName',
        ]);
        for (const note of result.diagnostics ?? []) {
          expect(note).toMatchObject({
            code: 'AEG-RENDER-0002',
            severity: 'warning',
            data: {
              gameId: 'demo',
              entity: 'player',
              deferred: true,
              reason: 'world-initialization',
            },
          });
          expect(note.fix).toContain('fully initialized world');
        }
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('deferred'));
        const boot = readFileSync(join(outDir, 'play', 'demo', 'boot.js'), 'utf8');
        expect(bootConfig(boot).presentation?.manifest).toEqual(manifest);
        expect(readFileSync(join(outDir, 'assets', 'demo', 'model', 'mesh.bin'), 'utf8')).toBe(
          'mesh',
        );
      } finally {
        warning.mockRestore();
      }
    },
  );

  it('still preserves the previous export when an asset fails in a prefab-dependent scene', () => {
    sentinel();
    rmSync(join(assetRoot, 'model', 'mesh.bin'));
    const pending = game({
      sceneText: JSON.stringify({ ...scene, entities: [{ id: 'parent', prefab: 'actor-family' }] }),
    });
    expect(() => exportStaticSite(options([pending]))).toThrow(/AEG-RENDER-0004.*mesh.bin/);
    expect(readFileSync(join(outDir, 'keep.txt'), 'utf8')).toBe('previous working site');
  });

  it('does not delete its own authored assets if outDir points at their directory', () => {
    expect(() => exportStaticSite({ ...options(), outDir: assetRoot })).toThrow(
      /AEG-RENDER-0003.*source asset/,
    );
    expect(readFileSync(join(assetRoot, 'image.svg'), 'utf8')).toBe(svg);
    expect(existsSync(join(assetRoot, '.nojekyll'))).toBe(false);
  });

  it('rejects unsafe or colliding game ids before replacing any output', () => {
    sentinel();
    for (const games of [
      [game({ id: '../escape' })],
      [game(), game({ id: 'DEMO' })],
      [game({ id: 'demo/subdirectory' })],
    ])
      expect(() => exportStaticSite(options(games))).toThrow(StaticGraphError);
    expect(readFileSync(join(outDir, 'keep.txt'), 'utf8')).toBe('previous working site');
  });

  it('retains legacy asset-free exports without serializing a presentation field', () => {
    const legacy = game({ presentation: undefined });
    const result = exportStaticSite(options([legacy]));
    expect(result.assetFiles).toBe(0);
    expect(result.assetBytes).toBe(0);
    expect(result.assets).toEqual([]);
    expect(
      bootConfig(readFileSync(join(outDir, 'play', 'demo', 'boot.js'), 'utf8')).presentation,
    ).toBeUndefined();
  });
});

describe('closed static addon graph', () => {
  it('maps only the exact loaders and walks their installed relative dependencies normally', () => {
    const table = engineModules(realRepo);
    const map = JSON.parse(staticImportMap('../../', table)) as { imports: Record<string, string> };
    expect(map.imports['three/addons/loaders/GLTFLoader.js']).toBe(
      '../../vendor/three/examples/jsm/loaders/GLTFLoader.js',
    );
    expect(map.imports['three/addons/utils/SkeletonUtils.js']).toBe(
      '../../vendor/three/examples/jsm/utils/SkeletonUtils.js',
    );
    expect(map.imports['three/addons/']).toBeUndefined();
    expect(map.imports['@aegis/render-three/presentation/node']).toBeUndefined();
    const graph = collectModuleGraph({
      entries: table
        .filter((module) => module.specifier.startsWith('three/addons/'))
        .map((module) => module.entry),
      modules: table,
    });
    expect(graph.files.map((file) => file.target)).toContain(
      'vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
    );
    for (const file of graph.files) {
      const imports = moduleSpecifiers(readFileSync(file.source, 'utf8')).statik;
      expect(imports.some((specifier) => specifier.startsWith('node:'))).toBe(false);
    }
  });

  it('exports only the reachable modules and gives every import-map entry a real file', () => {
    const result = exportStaticSite(options());
    expect(result.files).toContain('vendor/three/examples/jsm/loaders/GLTFLoader.js');
    expect(result.files).toContain('vendor/three/examples/jsm/utils/SkeletonUtils.js');
    expect(result.files).toContain('vendor/three/examples/jsm/utils/BufferGeometryUtils.js');
    expect(result.files.some((path) => /(?:dev-server|presentation\/files)\.js$/.test(path))).toBe(
      false,
    );
    const html = readFileSync(join(outDir, 'play', 'demo', 'index.html'), 'utf8');
    const imports = (
      JSON.parse(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html)![1]!) as {
        imports: Record<string, string>;
      }
    ).imports;
    for (const path of Object.values(imports)) {
      expect(path).toMatch(/^\.\.\/\.\.\/vendor\//);
      expect(existsSync(join(outDir, ...path.slice('../../'.length).split('/'))), path).toBe(true);
      const nested = new URL(path, 'https://example.test/review/nested/play/demo/').pathname;
      expect(nested.startsWith('/review/nested/vendor/')).toBe(true);
    }
  });

  it('refuses an unservable import without destroying the previously exported site', () => {
    sentinel();
    write(join(repoRoot, 'game', 'index.js'), "import 'node:fs';\nexport const demoPlugin = {};\n");
    expect(() => exportStaticSite(options())).toThrow(/statically imports "node:fs"/);
    expect(readFileSync(join(outDir, 'keep.txt'), 'utf8')).toBe('previous working site');
  });
});

describe('shared generated chrome and safe metadata', () => {
  it('uses the same game chrome in dev and static pages, with canonical relative links and covers', () => {
    const staticGame = game();
    const devGame: GameDefinition = {
      ...staticGame,
      plugin: platformerPlugin,
      scene,
    };
    const devPage = renderPlayPage(devGame);
    const staticPage = renderStaticPlayPage(staticGame, engineModules(realRepo));
    const body = (html: string): string =>
      /<body>\s*([\s\S]*?)\s*<script type="module"/.exec(html)![1]!;
    expect(body(devPage)).toBe(body(staticPage));
    for (const id of [
      'stage',
      'hud',
      'hud-tick',
      'hud-status',
      'hud-stats',
      'hud-events',
      'controls',
    ])
      expect(staticPage).toContain(`id="${id}"`);
    for (const html of [renderIndexPage([devGame]), renderStaticIndexPage([staticGame])]) {
      expect(html).toContain('href="play/demo/"');
      expect(html).toContain('assets/demo/image.svg');
      expect(html).toContain('Demo presentation');
    }
    expect(staticPage).toContain('href="../../"');
    expect(staticPage).toContain('src="./boot.js"');
  });

  it('escapes script closers in all new static boot metadata while retaining the original values', () => {
    const attack = '</script><script id="injected">bad()</script>';
    const malicious = game({
      title: attack,
      objective: attack,
      bindings: { ...BINDINGS.platformer, help: [{ keys: attack, does: attack }] },
      presentation: { manifest: { ...manifest, ui: { eyebrow: attack } }, assetRoot },
      sceneText: JSON.stringify({ ...scene, name: attack }),
    });
    const boot = renderStaticBootModule(malicious);
    expect(boot).not.toContain('</script>');
    expect(boot).toContain('\\u003c/script\\u003e');
    expect(bootConfig(boot).title).toBe(attack);
    expect(bootConfig(boot).presentation?.manifest.ui?.eyebrow).toBe(attack);
    const html = renderStaticPlayPage(malicious, engineModules(realRepo));
    expect(html).not.toContain('<script id="injected">');
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2);
  });
});

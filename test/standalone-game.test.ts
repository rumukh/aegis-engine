import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { put, standaloneFixture } from './support/standalone-game.js';

let f: ReturnType<typeof standaloneFixture>;
beforeAll(() => {
  f = standaloneFixture();
});
beforeEach(async () => {
  rmSync(f.game, { recursive: true, force: true });
  await f.cli(['scaffold', 'game', 'first-light', '--mode', 'platformer']);
});
afterAll(() => f?.dispose());

/** Resolve the actual HTML entry and its import map at a deployment prefix; use a second linker
 * to check all exported names and imports. No Node/Vite workspace resolution may satisfy a URL.
 */
async function linkExport(site: string) {
  const url = new URL('https://static.example/reviews/build/play/first-light/');
  const local = (href: string) => {
    const target = new URL(href, url);
    expect(target.origin).toBe(url.origin);
    expect(target.pathname).toMatch(/^\/reviews\/build\//);
    return join(site, target.pathname.slice('/reviews/build/'.length));
  };
  const html = readFileSync(join(site, 'play/first-light/index.html'), 'utf8');
  const entry = local(/<script type="module" src="([^"]+)"/.exec(html)![1]!);
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!)
    .imports as Record<string, string>;
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    external: ['node:fs/promises'],
    alias: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, local(v)])),
  });
  expect(Object.keys(result.metafile.inputs).length).toBeGreaterThan(30);
  for (const source of Object.keys(result.metafile.inputs)) {
    const rel = relative(site, resolve(source));
    expect(rel.startsWith('..') || isAbsolute(rel), `not shipped: ${source}`).toBe(false);
  }
  return entry;
}

describe('installed CLI, fresh game, real export', () => {
  it('runs the starter tests, plays its input via live HTTP, and links the relocatable static entry', async () => {
    expect(
      (await f.cli(['validate', 'first-light.scene.json', 'first-light.presentation.json'], f.game))
        .stdout,
    ).toContain('no problems found');
    expect((await f.cli(['test'], f.game)).stdout).toContain('1 passed, 0 failed');
    const { stdout } = await f.cli(
      ['run', 'first-light.scene.json', '--input', 'first-light.input', '--ticks', '120', '--hash'],
      f.game,
    );
    const live = await f.startLive();
    try {
      expect(new URL(live.url).pathname).toBe('/reviews/live/play/first-light/');
      expect(await (await fetch(live.url)).text()).toContain('first-light · platformer');
      const example = await (await fetch(new URL('example.input', live.url))).text();
      expect(example).toContain('hold Right 0..120');
      const vendor = await fetch(
        new URL('vendor/@aegis/render-three/dist/client/boot.js', live.rootUrl),
      );
      expect(vendor.ok).toBe(true);
      expect(await vendor.text()).toContain('export function boot(');
      const post = async (endpoint: string, body: object) => {
        const response = await fetch(`${live.rootUrl}api/first-light/${endpoint}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      await post('control', { command: 'pause' });
      await post('frame', { input: { seq: 1, held: ['Right'], pressed: ['Right'] } });
      expect(await post('control', { command: 'step', ticks: 120 })).toMatchObject({
        tick: 120,
        hash: stdout.trim(),
      });
    } finally {
      await live.close();
    }
    await f.cli(['export', '.'], f.game);
    const moved = join(f.root, 'relocated-site');
    renameSync(join(f.game, 'dist-site'), moved);
    const entry = await linkExport(moved);
    expect(readFileSync(join(dirname(entry), 'example.input'), 'utf8')).toBe(
      readFileSync(join(f.game, 'first-light.input'), 'utf8'),
    );
  });

  it('bundles the selected game-local ESM package and its own dependencies, not a stock substitute', async () => {
    const pkg = join(f.game, 'node_modules', 'local-game');
    put(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'local-game', type: 'module', exports: { import: './game.js' } }),
    );
    put(join(pkg, 'beat.js'), "export const beat = 'project.bundle.ready';");
    put(
      join(pkg, 'game.js'),
      `import {platformerPlugin as base} from '@aegis/mode-platformer';
      import {beat} from './beat.js';
      export default { ...base, init(world) { base.init(world); world.events.emit(beat, {}); } };`,
    );
    const manifest = join(f.game, 'aegis.json');
    put(
      manifest,
      JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), plugin: 'local-game' }),
    );
    await f.cli(['export', f.game], f.root, true);
    const entry = await linkExport(join(f.game, 'dist-site'));
    const bundled = pathToFileURL(join(dirname(entry), 'game.js')).href;
    const { runScene } = await import('@aegis/harness');
    const { default: plugin } = await import(/* @vite-ignore */ bundled);
    const result = await runScene(join(f.game, 'first-light.scene.json'), { plugin, ticks: 4 });
    expect(result.events.count('project.bundle.ready')).toBe(1);
  });

  it('fails closed on unreviewed media, then exports the exact deliberately cleared fixture', async () => {
    const path = join(f.game, 'aegis.json');
    const config = {
      ...JSON.parse(readFileSync(path, 'utf8')),
      presentation: './art/presentation.json',
    };
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="lime"/></svg>';
    put(join(f.game, 'art', 'cover.svg'), svg);
    put(
      join(f.game, 'art', 'presentation.json'),
      JSON.stringify({
        aegis: 'presentation/1',
        assets: [
          {
            id: 'cover',
            kind: 'texture',
            src: 'cover.svg',
            provenance: {
              author: 'Test fixture author',
              license: 'Review required',
              source: 'original fixture in standalone-game.test.ts',
            },
          },
        ],
        ui: { cover: 'cover' },
      }),
    );
    put(path, JSON.stringify(config));
    await f.cli(['export', '.'], f.game);
    const receipt = join(f.game, 'dist-site', 'release.json');
    const evaluation = readFileSync(receipt, 'utf8');
    await expect(f.cli(['export', '.', '--release', 'commercial'], f.game)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(
        /cover\.svg is unreviewed.*Review required.*standalone-game\.test\.ts/,
      ),
    });
    expect(readFileSync(receipt, 'utf8')).toBe(evaluation);
    config.rights = './review/media.json';
    put(path, JSON.stringify(config));
    const sha256 = createHash('sha256').update(svg).digest('hex');
    put(
      join(f.game, config.rights),
      JSON.stringify({
        aegis: 'asset-rights/1',
        files: [
          {
            path: 'cover.svg',
            sha256,
            commercial: 'cleared',
            reviewer: 'Test fixture author',
            evidence:
              'Original two-pixel rectangle; deliberately cleared fixture, not production art.',
          },
        ],
      }),
    );
    await f.cli(['export', path, '--release', 'commercial'], f.root);
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      release: 'commercial',
      assets: [{ path: 'assets/first-light/cover.svg', sha256, commercial: 'cleared' }],
    });
    expect(readFileSync(join(f.game, 'dist-site/assets/first-light/cover.svg'), 'utf8')).toBe(svg);
  });

  it('names bad manifest references and refuses to erase authored directories', async () => {
    const manifest = join(f.game, 'aegis.json');
    const orig = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const field of ['scene', 'input', 'presentation', 'rights']) {
      put(manifest, JSON.stringify({ ...orig, [field]: './missing-file' }));
      await expect(f.cli(['export', manifest])).rejects.toMatchObject({
        stderr: expect.stringContaining(`(${field}): "./missing-file"`),
      });
    }
    put(manifest, JSON.stringify(orig));
    await expect(f.cli(['export', '.', '--out', '.'], f.game)).rejects.toMatchObject({
      stderr: expect.stringContaining('contains the game'),
    });
    put(join(f.game, 'authored', 'keep.txt'), 'not an output');
    await expect(f.cli(['export', '.', '--out', 'authored'], f.game)).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing to replace'),
    });
    expect(readFileSync(join(f.game, 'authored', 'keep.txt'), 'utf8')).toBe('not an output');
  });
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformerPlugin } from '@aegis/mode-platformer';
import { BINDINGS } from './bindings.js';
import { findRepoRoot } from './catalog.js';
import type { GameDefinition } from './catalog.js';
import { normalizeBasePath, startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import type { BootConfig, EventLog, FrameResponse } from './protocol.js';
import type { PresentationManifest } from './presentation/schema.js';
import { PLATFORMER_SCENE } from './testing/scenes.js';

const repoRoot = findRepoRoot();
const workspace = resolve(`.aegis-dev-presentation-${process.pid}`);
const assetRoot = join(workspace, 'assets');
const provenance = { author: 'Aegis tests', license: 'MIT', source: 'authored delivery fixture' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z" fill="#fff"/></svg>';
const manifest: PresentationManifest = {
  aegis: 'presentation/1',
  assets: [
    { id: 'cover', kind: 'texture', src: 'image.svg', provenance },
    { id: 'rig', kind: 'gltf', src: 'models/rig.gltf', provenance },
    { id: 'tone', kind: 'audio', src: 'tone.wav', provenance },
  ],
  ui: { cover: 'cover', eyebrow: 'Authored presentation', accent: '#123456' },
};
const paths = ['image.svg', 'models/mesh.bin', 'models/paint.svg', 'models/rig.gltf', 'tone.wav'];
const games: DevServer[] = [];
let now = 0;

function write(path: string, contents: string): void {
  const file = join(assetRoot, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
function game(presentation = true): GameDefinition {
  return {
    id: 'demo',
    title: 'Delivery fixture',
    blurb: 'A local playable fixture.',
    objective: 'Reach the flag.',
    mode: 'platformer',
    plugin: platformerPlugin,
    scene: PLATFORMER_SCENE,
    bindings: BINDINGS.platformer,
    ...(presentation ? { presentation: { manifest, assetRoot } } : {}),
  };
}
async function start(basePath = '', definition = game()): Promise<DevServer> {
  const server = await startDevServer({
    games: [definition],
    port: 0,
    repoRoot,
    basePath,
    clock: () => now,
  });
  games.push(server);
  return server;
}
async function frame(
  server: DevServer,
  presentationGeneration?: number | null,
): Promise<FrameResponse> {
  const response = await fetch(`${server.url}/api/demo/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { seq: 1 }, presentationGeneration }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<FrameResponse>;
}
async function state(server: DevServer): Promise<FrameResponse> {
  const response = await fetch(`${server.url}/api/demo/state`);
  expect(response.status).toBe(200);
  return response.json() as Promise<FrameResponse>;
}
async function control(server: DevServer, command: string, ticks?: number): Promise<FrameResponse> {
  const response = await fetch(`${server.url}/api/demo/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, ticks }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<FrameResponse>;
}
function bootConfig(html: string): BootConfig {
  const config = /\bboot\((\{[^\n]*\})\);/.exec(html)?.[1];
  expect(config).toBeDefined();
  return JSON.parse(config!) as BootConfig;
}

beforeEach(() => {
  now = 0;
  write('image.svg', svg);
  write('models/paint.svg', svg);
  write('models/mesh.bin', 'mesh');
  write(
    'models/rig.gltf',
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'mesh.bin', byteLength: 4 }],
      images: [{ uri: 'paint.svg' }],
    }),
  );
  write('tone.wav', 'RIFF0000WAVE');
  write('private.txt', 'not a declared asset');
});
afterEach(async () => {
  await Promise.all(games.splice(0).map((server) => server.close()));
  rmSync(workspace, { recursive: true, force: true });
});

describe('prefix-safe dev delivery', () => {
  it('normalizes local prefixes and refuses URL escapes', () => {
    expect(normalizeBasePath()).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('preview//aegis/')).toBe('/preview/aegis');
    for (const path of ['../preview', '/a/../b', 'https://host/a', '/a?x', '/a#x', '/%61', '\\a'])
      expect(() => normalizeBasePath(path), path).toThrow(/basePath/);
  });

  it('serves identical play/catalog bytes at the root and at a normalized nested prefix', async () => {
    const root = await start();
    const nested = await start('/preview//aegis/');
    expect(new URL(nested.url).pathname).toBe('/preview/aegis');
    const rootIndex = await (await fetch(root.url)).text();
    expect(await (await fetch(nested.url)).text()).toBe(rootIndex);
    expect(rootIndex).toContain('href="play/demo/"');
    expect(rootIndex).toContain('assets/demo/image.svg');
    const rootPage = await (await fetch(`${root.url}/play/demo/`)).text();
    expect(await (await fetch(`${nested.url}/play/demo/`)).text()).toBe(rootPage);
    expect(rootPage).not.toContain(assetRoot);
    for (const match of rootPage.matchAll(/\b(?:href|src)="([^"]*)"/g))
      expect(match[1]?.startsWith('/'), match[1]).toBe(false);
    const outsidePrefix = await fetch(`${new URL(nested.url).origin}/play/demo/`);
    expect(outsidePrefix.status).toBe(404);
  });

  it.each(['', '/preview/aegis'])(
    'redirects legacy play links to their canonical directory at %s',
    async (base) => {
      const server = await start(base);
      for (const suffix of ['', '/index.html']) {
        const response = await fetch(`${server.url}/play/demo${suffix}?capture=1`, {
          redirect: 'manual',
        });
        expect(response.status).toBe(308);
        expect(response.headers.get('location')).toBe(`${base}/play/demo/?capture=1`);
      }
      expect((await fetch(`${server.url}/play/demo/`)).status).toBe(200);
    },
  );

  it.each(['', '/preview/aegis'])(
    'resolves every boot URL inside its deployment at %s',
    async (base) => {
      const server = await start(base);
      const page = `${server.url}/play/demo/`;
      const html = await (await fetch(page)).text();
      const config = bootConfig(html);
      expect(config.bindings).toEqual(BINDINGS.platformer);
      expect(config.tickRate).toBe(60);
      expect(config.api).toBe('../../api/demo');
      expect(config.presentation).toEqual({
        manifest,
        baseUrl: '../../assets/demo/',
        files: paths,
      });
      const stateUrl = new URL(`${config.api}/state`, page);
      expect(stateUrl.pathname).toBe(`${base}/api/demo/state`);
      expect((await fetch(stateUrl)).status).toBe(200);
      const mapText = /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html)?.[1];
      const imports = (JSON.parse(mapText!) as { imports: Record<string, string> }).imports;
      for (const specifier of [
        '@aegis/core',
        'three/addons/loaders/GLTFLoader.js',
        'three/addons/utils/SkeletonUtils.js',
      ]) {
        const address = imports[specifier]!;
        expect(address).toMatch(/^\.\.\/\.\.\/vendor\//);
        const module = await fetch(new URL(address, page));
        expect(module.status, specifier).toBe(200);
        expect(module.headers.get('content-type')).toContain('text/javascript');
      }
      for (const path of paths) {
        const address = new URL(`${config.presentation!.baseUrl}${path}`, page);
        expect(address.pathname).toBe(`${base}/assets/demo/${path}`);
        expect((await fetch(address)).status, address.href).toBe(200);
      }
    },
  );

  it('serves only the prepared asset inventory, with media MIME and no directory fallback', async () => {
    const server = await start('/nested');
    const expected = new Map([
      ['image.svg', 'image/svg+xml'],
      ['models/rig.gltf', 'model/gltf+json'],
      ['models/mesh.bin', 'application/octet-stream'],
      ['tone.wav', 'audio/wav'],
    ]);
    for (const [path, mime] of expected) {
      const response = await fetch(`${server.url}/assets/demo/${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(mime);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const head = await fetch(`${server.url}/assets/demo/image.svg`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const path of ['private.txt', '', 'models/', '%69mage.svg', 'models%2f..%2fprivate.txt'])
      expect((await fetch(`${server.url}/assets/demo/${path}`)).status, path).toBe(404);
    expect((await fetch(`${server.url}/assets/unknown/image.svg`)).status).toBe(404);
    expect((await fetch(`${server.url}/vendor/node_modules/vitest/package.json`)).status).toBe(404);
    expect((await fetch(`${server.url}/vendor/%xx`)).status).toBe(404);
  });

  it('refuses changed assets instead of serving unchecked replacement content', async () => {
    const server = await start();
    write('image.svg', '<svg><image href="https://example.test/outside.png"/></svg>');
    const response = await fetch(`${server.url}/assets/demo/image.svg`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      diagnostics: [{ code: 'AEG-RENDER-0004', fix: expect.stringContaining('Restart') }],
    });
  });

  it('still rejects missing assets before opening a server when a HUD name needs world initialization', () => {
    rmSync(join(assetRoot, 'models', 'mesh.bin'));
    const broken = game();
    broken.presentation = {
      assetRoot,
      manifest: { ...manifest, hud: { playerName: 'absent', winEvent: 'won', loseEvents: [] } },
    };
    expect(() => startDevServer({ games: [broken], port: 0, repoRoot })).toThrow(
      /AEG-RENDER-0004.*mesh.bin/,
    );
  });

  it('escapes script closers in display metadata, bindings and the embedded manifest', async () => {
    const attack = '</script><script id="injected">bad()</script>';
    const authored = game();
    authored.title = attack;
    authored.objective = attack;
    authored.bindings = { ...BINDINGS.platformer, help: [{ keys: attack, does: attack }] };
    authored.presentation = { manifest: { ...manifest, ui: { eyebrow: attack } }, assetRoot };
    const server = await start('', authored);
    const html = await (await fetch(`${server.url}/play/demo/`)).text();
    expect(html).not.toContain('<script id="injected">');
    expect(html).not.toContain(assetRoot);
    expect(bootConfig(html).title).toBe(attack);
    expect(bootConfig(html).presentation?.manifest.ui?.eyebrow).toBe(attack);
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2);
  });

  it.each([false, true])(
    'reports raw-missing names with prefabs=%s without skipping assets or initializing a world',
    async (withPrefabs) => {
      const authored = game();
      authored.scene = {
        ...PLATFORMER_SCENE,
        entities: [{ id: 'parent', ...(withPrefabs ? { prefab: 'actor-family' } : {}) }],
      };
      authored.presentation = {
        assetRoot,
        manifest: {
          ...manifest,
          hud: { playerName: 'expanded-child', winEvent: 'won', loseEvents: [] },
        },
      };
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const server = await start('', authored);
        expect(server.diagnostics).toMatchObject([
          {
            code: 'AEG-RENDER-0002',
            severity: 'warning',
            location: { path: 'hud.playerName' },
            data: {
              gameId: 'demo',
              entity: 'expanded-child',
              deferred: true,
              reason: 'world-initialization',
            },
          },
        ]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('AEG-RENDER-0002'));
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('deferred'));
        expect((await fetch(`${server.url}/assets/demo/models/mesh.bin`)).status).toBe(200);
        expect(server.session('demo')).toBeUndefined();
      } finally {
        warning.mockRestore();
      }
    },
  );
});

describe('presentation event transport and pacing', () => {
  it('hydrates a new client from the full history atomically with the snapshot after the live cursor was drained', async () => {
    const server = await start();
    await state(server);
    server.session('demo')!.world.events.emit('opened', { door: 'gate' });
    const drained = await frame(server);
    expect(drained.events).toEqual([
      { type: 'opened', tick: 0, data: { door: 'gate' }, sequence: 0 },
    ]);
    const before = (await state(server)).hash;
    const cold = await frame(server, null);
    expect(cold.events).toEqual([]);
    expect(cold.eventHistory).toEqual(drained.events);
    expect(cold.snapshot.tick).toBe(cold.tick);
    expect(cold.generation).toBe(0);
    expect((await state(server)).hash).toBe(before);
    expect((await frame(server, 0)).eventHistory).toBeUndefined();

    await control(server, 'restart');
    server.session('demo')!.world.events.emit('after', { value: 2 });
    const changed = await frame(server, 0);
    expect(changed.generation).toBe(1);
    expect(changed.eventHistory).toEqual([
      { type: 'after', tick: 0, data: { value: 2 }, sequence: 0 },
    ]);
    expect(changed.events).toEqual(changed.eventHistory);
    expect((await frame(server, 1)).eventHistory).toBeUndefined();
    const log = (await (await fetch(`${server.url}/api/demo/events`)).json()) as EventLog;
    expect(log.events).toEqual(changed.eventHistory);
  });

  it('preserves immutable payloads and original log indices; only /frame drains the cursor', async () => {
    const server = await start();
    await state(server);
    const payload = { amount: 3, position: { x: 1 } };
    server.session('demo')!.world.events.emit('impact', payload);
    server.session('demo')!.world.events.emit('impact', payload);
    payload.position.x = 99;
    expect((await state(server)).events).toEqual([]);
    expect((await control(server, 'pause')).events).toEqual([]);
    const expected = [
      { type: 'impact', tick: 0, data: { amount: 3, position: { x: 1 } }, sequence: 0 },
      { type: 'impact', tick: 0, data: { amount: 3, position: { x: 1 } }, sequence: 1 },
    ];
    const log = (await (await fetch(`${server.url}/api/demo/events`)).json()) as EventLog;
    expect(log).toEqual({ tick: 0, generation: 0, events: expected });
    expect((await frame(server)).events).toEqual(expected);
    expect((await frame(server)).events).toEqual([]);
    server.session('demo')!.world.events.emit('impact', { amount: 4 });
    const next = await frame(server);
    expect(next.generation).toBe(0);
    expect(next.events).toEqual([{ type: 'impact', tick: 0, data: { amount: 4 }, sequence: 2 }]);
    expect(next.hash).toBeUndefined();
    expect((await state(server)).hash).toEqual(expect.any(String));
  });

  it('rejects invalid hydration generations without advancing or draining the session', async () => {
    const server = await start();
    await state(server);
    server.session('demo')!.world.events.emit('retained', {});
    const before = (await state(server)).hash;
    for (const presentationGeneration of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
      const reply = await fetch(`${server.url}/api/demo/frame`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { seq: 1 }, presentationGeneration }),
      });
      expect(reply.status).toBe(400);
      expect(await reply.json()).toEqual({
        error: 'presentationGeneration must be null or a nonnegative safe integer.',
      });
    }
    expect((await state(server)).hash).toBe(before);
    expect((await frame(server)).events).toEqual([
      { type: 'retained', tick: 0, data: {}, sequence: 0 },
    ]);
  });

  it('increments generation on restart and restarts sequence indices without draining control reads', async () => {
    const server = await start();
    await state(server);
    server.session('demo')!.world.events.emit('before', { value: 1 });
    expect((await frame(server)).generation).toBe(0);
    await control(server, 'pause');
    const reset = await control(server, 'restart');
    expect(reset.generation).toBe(1);
    expect(reset.events).toEqual([]);
    expect(reset.tick).toBe(0);
    expect(reset.paused).toBe(true);
    server.session('demo')!.world.events.emit('after', { value: 2 });
    expect((await state(server)).generation).toBe(1);
    const postRestart = await frame(server);
    expect(postRestart.generation).toBe(1);
    expect(postRestart.events).toEqual([
      { type: 'after', tick: 0, data: { value: 2 }, sequence: 0 },
    ]);
    expect((await control(server, 'restart')).generation).toBe(2);
    expect((await frame(server)).events).toEqual([]);
  });

  it('keeps the complete legacy response/event shape unchanged without presentation', async () => {
    const server = await start('', game(false));
    const initial = await state(server);
    expect(Object.keys(initial).sort()).toEqual([
      'events',
      'hash',
      'paused',
      'snapshot',
      'steps',
      'tick',
    ]);
    server.session('demo')!.world.events.emit('legacy', { notTransported: true });
    const log = (await (await fetch(`${server.url}/api/demo/events`)).json()) as EventLog;
    expect(log).toEqual({ tick: 0, events: [{ type: 'legacy', tick: 0 }] });
    const response = await frame(server);
    expect(response.events).toEqual([{ type: 'legacy', tick: 0 }]);
    expect(Object.keys(response).sort()).toEqual(['events', 'paused', 'snapshot', 'steps', 'tick']);
    expect((await control(server, 'restart')).generation).toBeUndefined();
  });

  it('does not turn initial page/asset loading time into catch-up steps', async () => {
    const server = await start();
    await fetch(`${server.url}/play/demo/`);
    expect(server.session('demo')!.tick).toBe(0);
    now += 60;
    await fetch(`${server.url}/assets/demo/models/rig.gltf`);
    expect((await state(server)).tick).toBe(0);
    now += 1;
    const first = await frame(server);
    expect(first.steps).toBe(0);
    expect(first.tick).toBe(0);
    now += 1 / 60 + 1e-8;
    expect((await frame(server)).tick).toBe(1);
  });

  it('starts a presentation clock only on its first frame, even after API inspection and steps', async () => {
    const server = await start();
    expect((await state(server)).tick).toBe(0);
    now += 30;
    expect((await control(server, 'step', 4)).tick).toBe(4);
    await fetch(`${server.url}/play/demo/`);
    now += 30;
    const first = await frame(server);
    expect(first.steps).toBe(0);
    expect(first.tick).toBe(4);
    now += 2 / 60 + 1e-8;
    expect((await frame(server)).tick).toBe(6);
  });

  it('starts a fresh presentation clock after restart instead of accruing remount time', async () => {
    const server = await start();
    await frame(server);
    now += 1 / 60;
    expect((await frame(server)).tick).toBe(1);
    expect((await control(server, 'restart')).generation).toBe(1);
    now += 30;
    const first = await frame(server);
    expect(first.steps).toBe(0);
    expect(first.tick).toBe(0);
    expect(first.generation).toBe(1);
    now += 1 / 60 + 1e-8;
    expect((await frame(server)).tick).toBe(1);
  });

  it('retains legacy direct API state/step priming and fixed-step pacing', async () => {
    const server = await start('', game(false));
    expect((await state(server)).tick).toBe(0);
    now += 3 / 60;
    expect((await frame(server)).tick).toBe(3);
    const stepped = await control(server, 'step', 4);
    expect(stepped.tick).toBe(7);
    expect((await frame(server)).tick).toBe(7);
    now += 2 / 60;
    expect((await frame(server)).tick).toBe(9);
  });
});

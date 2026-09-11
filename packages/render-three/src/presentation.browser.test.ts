import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameMode } from '@aegis/core';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import type { GameDefinition } from './catalog.js';
import { findRepoRoot } from './catalog.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { exportStaticSite } from './static-site.js';
import { BINDINGS } from './bindings.js';
import {
  closeAllPages,
  click,
  evaluate,
  key,
  launchBrowser,
  openPage,
  screenshot,
  until,
  waitForPaint,
} from './browser.js';
import type { LaunchedBrowser } from './browser.js';
import { FPS_SCENE, ISO_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';
import { fixturePng, writePresentationFixture } from './testing/presentation-fixture.js';
import type { PresentationSource } from './presentation/schema.js';

const VIEWPORT = { width: 640, height: 360 };
const CASES = [
  {
    id: 'platformer',
    plugin: platformerPlugin,
    scene: PLATFORMER_SCENE,
    exportName: 'platformerPlugin',
  },
  { id: 'iso', plugin: isoPlugin, scene: ISO_SCENE, exportName: 'isoPlugin' },
  { id: 'fps', plugin: fpsPlugin, scene: FPS_SCENE, exportName: 'fpsPlugin' },
] as const;

let temporary: string;
let dev: DevServer;
let staticServer: Server;
let staticUrl: string;
let browser: LaunchedBrowser;

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aegis-presentation-browser-'));
  const presentation = writePresentationFixture(join(temporary, 'assets'));
  writeFileSync(
    join(temporary, 'assets', 'surface.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="0 0 48 24">' +
      '<rect width="24" height="24" fill="#ff0000"/>' +
      '<rect x="24" width="24" height="24" fill="#00ff00"/></svg>',
  );
  presentation.manifest.assets = [
    ...(presentation.manifest.assets ?? []),
    {
      id: 'vector',
      kind: 'texture',
      src: 'surface.svg',
      provenance: {
        author: 'Aegis contributors',
        license: 'MIT',
        source: 'presentation.browser.test.ts',
      },
    },
  ];
  // The perspective fixture must sit in front of the nearby blast door, not behind it.
  const forMode = (mode: GameMode): PresentationSource => ({
    ...presentation,
    manifest: {
      ...presentation.manifest,
      objects: [
        {
          id: 'specimen',
          anchor: 'camera',
          visual: { kind: 'model', mesh: 'rig', clip: 'spin' },
          pose:
            mode === 'fps'
              ? { position: [-0.23, -0.28, -0.8], scale: [0.38, 0.38, 0.38] }
              : { position: [-1.2, -0.7, -3], scale: [1.4, 1.4, 1.4] },
        },
        {
          id: 'atlas',
          anchor: 'camera',
          visual: { kind: 'sprite', texture: 'surface', frame: 'left' },
          pose:
            mode === 'fps'
              ? { position: [0.28, 0, -0.65], scale: [0.22, 0.22, 0.22] }
              : { position: [1.5, 0, -3], scale: [0.75, 0.75, 0.75] },
        },
        {
          id: 'vector',
          anchor: 'camera',
          visual: { kind: 'sprite', texture: 'vector' },
          pose:
            mode === 'fps'
              ? { position: [0.28, 0.26, -0.65], scale: [0.22, 0.11, 0.22] }
              : { position: [1.5, 1, -3], scale: [0.75, 0.375, 0.75] },
        },
      ],
    },
  });
  presentation.manifest.audio = {
    ambient: { asset: 'tone', volume: 0.15 },
    cues: [{ event: 'player.jumped', asset: 'tone' }],
  };
  const games: GameDefinition[] = CASES.map((entry) => ({
    id: entry.id,
    title: `Presentation ${entry.id}`,
    blurb: 'Original asset fixture',
    objective: 'Inspect the striped rig and animated fin.',
    mode: entry.id,
    plugin: entry.plugin,
    scene: entry.scene,
    bindings: BINDINGS[entry.id],
    presentation: forMode(entry.id),
  }));
  const reloadPresentation = forMode('platformer');
  reloadPresentation.manifest.hud = {
    playerName: 'player',
    winEvent: 'completed',
    loseEvents: [],
    steps: [{ id: 'gate', label: 'Open the gate', event: 'opened' }],
  };
  reloadPresentation.manifest.effects = [
    {
      event: 'opened',
      kind: 'frames',
      target: { object: 'atlas' },
      frames: ['right'],
      frameTicks: 1,
      durationTicks: 1,
      holdLast: true,
    },
    { event: 'ping', kind: 'burst', target: { object: 'atlas' }, durationTicks: 10, count: 2 },
  ];
  reloadPresentation.manifest.audio = {
    cues: [
      { event: 'opened', asset: 'tone' },
      { event: 'ping', asset: 'tone' },
    ],
  };
  const broken = writePresentationFixture(join(temporary, 'broken'));
  const undecodable = writePresentationFixture(join(temporary, 'undecodable'));
  const invalidImage = fixturePng();
  const imageData = invalidImage.indexOf(Buffer.from('IDAT')) + 4;
  invalidImage[imageData] = 0; // Keep the PNG header/dimensions, corrupt the compressed pixels.
  writeFileSync(join(temporary, 'undecodable', 'surface.png'), invalidImage);
  dev = await startDevServer({
    games: [
      ...games,
      { ...games[0]!, id: 'reload', presentation: reloadPresentation },
      {
        id: 'broken',
        title: 'Broken required texture',
        blurb: 'Negative control',
        objective: 'This page must show the required-asset failure.',
        mode: 'platformer',
        plugin: platformerPlugin,
        scene: PLATFORMER_SCENE,
        bindings: BINDINGS.platformer,
        presentation: broken,
      },
      {
        id: 'undecodable',
        title: 'Undecodable texture',
        blurb: 'Decoder negative control',
        objective: 'The declared bytes are stable, but the browser must reject this image.',
        mode: 'platformer',
        plugin: platformerPlugin,
        scene: PLATFORMER_SCENE,
        bindings: BINDINGS.platformer,
        presentation: undecodable,
      },
    ],
    port: 0,
    basePath: '/preview/',
  });
  // The file was valid at preflight. Prove a later corrupt response is not a fallback surface.
  writeFileSync(join(temporary, 'broken', 'surface.png'), Buffer.from('not a decodable image'));
  const outDir = join(temporary, 'site');
  exportStaticSite({
    games: games.map((game, index) => ({
      id: game.id,
      title: game.title,
      blurb: game.blurb,
      objective: game.objective,
      mode: game.mode,
      bindings: game.bindings,
      sceneText: JSON.stringify(game.scene),
      pluginModule: `@aegis/mode-${game.mode}`,
      pluginExport: CASES[index]!.exportName,
      ...(game.presentation === undefined ? {} : { presentation: game.presentation }),
    })),
    outDir,
    repoRoot: findRepoRoot(),
  });
  const mime: Readonly<Record<string, string>> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
  };
  staticServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    if (request.method !== 'GET' || !path.startsWith('/nested/site/')) {
      response.writeHead(404).end();
      return;
    }
    let relative = decodeURIComponent(path.slice('/nested/site/'.length));
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const target = resolve(outDir, relative);
    if (!target.startsWith(outDir + sep)) {
      response.writeHead(403).end();
      return;
    }
    let exists = false;
    try {
      exists = statSync(target).isFile();
    } catch {
      /* A missing artifact must return 404. */
    }
    if (!exists) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': mime[extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    staticServer.once('error', fail);
    staticServer.listen(0, '127.0.0.1', () => done());
  });
  const address = staticServer.address();
  if (address === null || typeof address === 'string')
    throw new Error('Static fixture did not bind.');
  staticUrl = `http://127.0.0.1:${address.port}/nested/site`;
  browser = await launchBrowser({ viewport: VIEWPORT });
  const blank = await openPage(browser.port, 'about:blank', VIEWPORT);
  await waitForPaint(blank);
  await blank.close();
}, 180_000);

afterAll(async () => {
  if (browser !== undefined) {
    await closeAllPages(browser.port);
    browser.process.kill();
  }
  await dev?.close();
  if (staticServer !== undefined)
    await new Promise<void>((done) => {
      staticServer.closeAllConnections();
      staticServer.close(() => done());
    });
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

describe('real asset presentation in dev and static browsers', () => {
  it('reloads a live session with its held visual and HUD progress but no historical audio or bursts', async () => {
    const cdp = await openPage(browser.port, `${dev.url}/play/reload/`, VIEWPORT);
    const control = async (command: string, ticks?: number): Promise<void> => {
      const reply = await fetch(`${dev.url}/api/reload/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, ticks }),
      });
      expect(reply.status).toBe(200);
    };
    const read = `(() => ({
      tick: globalThis.aegis.tick(),
      generation: globalThis.aegis.presentation().generation,
      frame: globalThis.aegis.adapter.presentation.object('atlas').object.material.map.offset.x,
      progress: document.getElementById('hud-progress').textContent,
      outcome: document.getElementById('hud-outcome').textContent,
      effects: globalThis.aegis.presentation().render.effects.active,
      dropped: globalThis.aegis.presentation().audio.dropped,
      hash: globalThis.aegis.world.hash(),
    }))()`;
    try {
      await until<boolean>(
        cdp,
        "globalThis.aegis !== undefined && globalThis.aegis.presentation().status === 'ready'",
        (ready) => ready,
      );
      await control('pause');
      const session = dev.session('reload')!;
      session.world.events.emit('opened', {});
      session.world.events.emit('ping', {});
      session.world.events.emit('completed', {});
      await control('step', 45);
      const targetTick = session.tick;
      const first = await until<{
        tick: number;
        frame: number;
        hash: string;
        progress: string;
        effects: number;
      }>(
        cdp,
        read,
        (value) =>
          value.tick === targetTick &&
          value.frame === 0.5 &&
          value.progress === '1 / 1 complete' &&
          value.effects === 0,
      );
      expect(first.frame).toBe(0.5);
      const timeOrigin = await evaluate<number>(cdp, 'performance.timeOrigin');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until<boolean>(
        cdp,
        `performance.timeOrigin !== ${timeOrigin} && globalThis.aegis !== undefined && globalThis.aegis.presentation().status === 'ready'`,
        (ready) => ready,
      );
      await evaluate(cdp, 'globalThis.aegis.ready.then(() => true)');
      expect(await evaluate(cdp, read)).toEqual({
        tick: targetTick,
        generation: 0,
        frame: 0.5,
        progress: '1 / 1 complete',
        outcome: 'Objective complete',
        effects: 0,
        dropped: 0,
        hash: first.hash,
      });
      session.world.events.emit('ping', {});
      await until<number>(
        cdp,
        'globalThis.aegis.presentation().render.effects.active',
        (count) => count === 2,
      );
      expect(await evaluate<number>(cdp, 'globalThis.aegis.presentation().audio.dropped')).toBe(1);
    } finally {
      try {
        await cdp.send('Page.navigate', { url: 'about:blank' });
      } finally {
        cdp.close();
      }
    }
  }, 180_000);

  for (const id of ['broken', 'undecodable'])
    it(`${id}: shows the required-asset failure instead of an empty ready game`, async () => {
      const cdp = await openPage(browser.port, `${dev.url}/play/${id}/`, VIEWPORT);
      try {
        await until<boolean>(
          cdp,
          "globalThis.aegis !== undefined && globalThis.aegis.presentation().status === 'error'",
          (value) => value,
        );
        expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBe(-1);
        const error = await evaluate<string>(
          cdp,
          'globalThis.aegis.ready.then(() => "incorrectly ready", error => error.message)',
        );
        expect(error).toMatch(/AEG-RENDER-0004/);
        expect(error).toMatch(id === 'broken' ? /responded 409/ : /Cannot load "surface"/);
        const message = await evaluate<string>(
          cdp,
          "document.getElementById('loading-message').textContent",
        );
        expect(message).toMatch(/surface|rig/);
        expect(message).toMatch(/Check|Repair|retry/i);
        await key(cdp, 'KeyP', true);
        await key(cdp, 'KeyP', false);
        expect(
          await evaluate<string>(cdp, "document.getElementById('loading-message').textContent"),
        ).toBe(message);
        if (process.env['AEGIS_PRESENTATION_CAPTURE_DIR'] !== undefined)
          await screenshot(
            cdp,
            join(process.env['AEGIS_PRESENTATION_CAPTURE_DIR'], `fixture-${id}-error.png`),
          );
      } finally {
        await cdp.close();
      }
    }, 120_000);
  for (const transport of ['dev', 'static'] as const)
    for (const entry of CASES) {
      it(`${transport} ${entry.id}: decodes visible textures/models, animates, keeps prefix and restarts cleanly`, async () => {
        const base = transport === 'dev' ? dev.url : staticUrl;
        const cdp = await openPage(browser.port, `${base}/play/${entry.id}/`, VIEWPORT);
        try {
          await until<boolean>(
            cdp,
            "globalThis.aegis !== undefined && globalThis.aegis.tick() >= 0 && globalThis.aegis.presentation().status === 'ready'",
            (value) => value,
          );
          await evaluate(cdp, 'globalThis.aegis.ready.then(() => true)');
          const inspect = `(() => {
          const adapter = globalThis.aegis.adapter;
          const scenes = [adapter.scene, ...(adapter.foreground ? [adapter.foreground.scene] : [])];
          const result = {textures: [], rigVertices: [], fins: [], passes: scenes.length};
          for (const scene of scenes) scene.traverse(o => {
              if (o.name === 'fin') result.fins.push(o.quaternion.toArray());
              if (o.isMesh && o.geometry?.attributes.position?.count === 12) result.rigVertices.push(12);
              if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material])
                if (m?.map?.image) result.textures.push(m.map.image.width);
            });
          return result;
        })()`;
          const first = await evaluate<{
            textures: number[];
            rigVertices: number[];
            fins: number[][];
            passes: number;
          }>(cdp, inspect);
          expect(first.passes).toBe(entry.id === 'fps' ? 2 : 1);
          expect(first.textures).toContain(32);
          expect(first.textures).toContain(48);
          expect(first.rigVertices.length).toBeGreaterThanOrEqual(2);
          expect(first.fins).toHaveLength(1);
          const vector = await evaluate<{ size: number[]; pixels: number[] }>(
            cdp,
            `(() => {
              const image = globalThis.aegis.adapter.presentation.assets.texture('vector').image;
              const canvas = document.createElement('canvas');
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext('2d');
              if (context === null) throw new Error('SVG pixel probe requires a 2D context.');
              context.drawImage(image, 0, 0);
              return {
                size: [image.width, image.height],
                pixels: [
                  ...context.getImageData(8, 12, 1, 1).data,
                  ...context.getImageData(40, 12, 1, 1).data,
                ],
              };
            })()`,
          );
          expect(vector.size).toEqual([48, 24]);
          expect(vector.pixels).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
          const visibility = await evaluate<{ inView: boolean; nearestIsModel: boolean }>(
            cdp,
            `(async () => {
              const {Box3, Vector3, Raycaster} = await import('three');
              const adapter = globalThis.aegis.adapter;
              const passes = [
                ...(adapter.foreground ? [adapter.foreground] : []),
                {scene: adapter.scene, camera: adapter.camera},
              ];
              for (const pass of passes) pass.scene.updateMatrixWorld(true);
              const model = adapter.presentation.object('specimen').object;
              const owner = passes.find(pass => pass.scene.getObjectById(model.id));
              if (!owner) throw new Error('The fixture model is not in a rendered pass.');
              const body = model.getObjectByName('body');
              const center = new Box3().setFromObject(body).getCenter(new Vector3());
              const ndc = center.project(owner.camera);
              const ray = new Raycaster();
              let hits = [];
              for (const pass of passes) {
                ray.setFromCamera({x:ndc.x,y:ndc.y}, pass.camera);
                hits = ray.intersectObjects(pass.scene.children, true).filter(hit => {
                  for (let node = hit.object; node; node = node.parent) if (!node.visible) return false;
                  const material = Array.isArray(hit.object.material)
                    ? hit.object.material[hit.face?.materialIndex ?? 0] : hit.object.material;
                  return material?.visible !== false && (material?.opacity ?? 1) >= 1;
                });
                if (hits.length > 0) break;
              }
              let nearestIsModel = false;
              for (let node = hits[0]?.object; node; node = node.parent)
                if (node === model) nearestIsModel = true;
              return {inView: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z < 1, nearestIsModel};
            })()`,
          );
          expect(visibility.inView).toBe(true);
          expect(
            visibility.nearestIsModel,
            'The fixture model must be visible, not merely loaded behind a wall.',
          ).toBe(true);
          const initialTick = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
          await until<number>(cdp, 'globalThis.aegis.tick()', (tick) => tick >= initialTick + 15);
          // A looping clip can revisit the first pose between two asynchronous observations.
          const next = await until<typeof first>(
            cdp,
            inspect,
            (value) =>
              value.fins[0]?.some((component, index) => component !== first.fins[0]?.[index]) ===
              true,
          );
          expect(next.fins[0]).not.toEqual(first.fins[0]);
          const traffic = await evaluate<string[]>(
            cdp,
            "performance.getEntriesByType('resource').map(r => r.name).filter(u => !u.startsWith('blob:') && !u.startsWith('data:'))",
          );
          const prefix = transport === 'dev' ? '/preview/' : '/nested/site/';
          expect(traffic.some((url) => url.endsWith('/surface.png'))).toBe(true);
          expect(traffic.some((url) => url.endsWith('/surface.svg'))).toBe(true);
          expect(traffic.some((url) => url.endsWith('/rig.gltf'))).toBe(true);
          expect(traffic.every((url) => new URL(url).pathname.startsWith(prefix))).toBe(true);
          const before = await evaluate<{ assets: { modelInstances: number; textures: number } }>(
            cdp,
            'globalThis.aegis.presentation()',
          );
          await key(cdp, 'KeyR', true);
          await key(cdp, 'KeyR', false);
          await until<number>(
            cdp,
            'globalThis.aegis.presentation().generation',
            (generation) => generation > 0,
          );
          const after = await evaluate<typeof before>(cdp, 'globalThis.aegis.presentation()');
          expect(after.assets.modelInstances).toBe(before.assets.modelInstances);
          expect(after.assets.textures).toBe(before.assets.textures);
          if (entry.id === 'platformer') {
            await until<string>(
              cdp,
              'globalThis.aegis.presentation().audio.status',
              (status) => status === 'ready',
            );
            await until<number>(
              cdp,
              'globalThis.aegis.presentation().audio.voices',
              (voices) => voices > 0,
            );
            await key(cdp, 'KeyP', true);
            await key(cdp, 'KeyP', false);
            await until<number>(
              cdp,
              'globalThis.aegis.presentation().audio.voices',
              (voices) => voices === 0,
            );
            await key(cdp, 'KeyP', true);
            await key(cdp, 'KeyP', false);
            const mute = await evaluate<{ x: number; y: number }>(
              cdp,
              "(() => { const r = document.getElementById('action-mute').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()",
            );
            await click(cdp, mute.x, mute.y);
            await until<boolean>(
              cdp,
              'globalThis.aegis.presentation().audio.muted',
              (muted) => muted,
            );
            expect(
              await evaluate<number>(cdp, 'globalThis.aegis.presentation().audio.voices'),
            ).toBe(0);
          }
          if (process.env['AEGIS_PRESENTATION_CAPTURE_DIR'] !== undefined)
            await screenshot(
              cdp,
              join(
                process.env['AEGIS_PRESENTATION_CAPTURE_DIR'],
                `fixture-${transport}-${entry.id}.png`,
              ),
            );
        } finally {
          await cdp.close();
        }
      }, 180_000);
    }
});

import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Health } from '@aegis/content';
import { fpsPlugin } from '@aegis/mode-fps';
import { findRepoRoot } from './catalog.js';
import { BINDINGS } from './bindings.js';
import {
  CdpDisconnectedError,
  closeAllPages,
  evaluate,
  launchBrowser,
  openPage,
  screenshot,
  until,
  waitForPaint,
  click,
} from './browser.js';
import type { LaunchedBrowser } from './browser.js';
import { closeOwnedBrowser } from './testing/browser-lifecycle.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { exportStaticSite } from './static-site.js';
import { FPS_SCENE } from './testing/scenes.js';
import { writePresentationFixture } from './testing/presentation-fixture.js';
import type { PresentationManifest } from './presentation/schema.js';
import { entityNamed } from './presentation/runtime-test-utils.js';

const HARDWARE = process.env['AEGIS_CINEMATIC_HARDWARE'] === '1';
const VIEWPORT = HARDWARE ? { width: 2560, height: 1440 } : { width: 640, height: 360 };
let root: string;
let dev: DevServer;
let server: Server;
let staticUrl: string;
let browser: LaunchedBrowser;
const ready = "globalThis.aegis?.presentation().status === 'ready'";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aegis-cinematic-'));
  const presentation = writePresentationFixture(join(root, 'assets'));
  const rig = presentation.manifest.assets?.find((asset) => asset.id === 'rig');
  if (rig?.kind !== 'gltf') throw new Error('Fixture model is missing.');
  copyFileSync(join(root, 'assets', rig.src), join(root, 'assets', 'rig-copy.gltf'));
  const manifest: PresentationManifest = {
    aegis: 'presentation/1',
    assets: [...presentation.manifest.assets!, { ...rig, id: 'rig-copy', src: 'rig-copy.gltf' }],
    quality: 'high',
    ui: { layout: 'cinematic' },
    hud: {
      playerName: 'player',
      winEvent: 'done',
      loseEvents: [],
      steps: [{ id: 'later', label: 'A later objective', event: 'done' }],
    },
    pipeline: {
      toneMapping: 'aces',
      exposure: 1.1,
      saturation: 0.9,
      bloom: { strength: 0.18, radius: 0.25, threshold: 1 },
      ambientOcclusion: { radius: 4, minDistance: 0.002, maxDistance: 0.025 },
    },
    environment: {
      background: '#080d13',
      ambient: { color: '#a6b7d0', intensity: 0.06 },
      reflections: { texture: 'surface', intensity: 0.18 },
      fog: { color: '#111822', near: 10, far: 35 },
      spots: [
        {
          id: 'flashlight',
          anchor: 'camera',
          position: [0.18, -0.1, 0],
          target: [0.18, -0.1, -8],
          color: '#dce8ee',
          intensity: 80,
          angle: 26,
          distance: 18,
          penumbra: 0.55,
          enabledWhen: { entity: 'player', component: 'Health', field: 'current', equals: 100 },
          shadow: { mapSize: 1024 },
        },
        {
          id: 'practical',
          position: [-1.7, 3.5, 8],
          target: [-0.8, 0, 8],
          color: '#ffc794',
          intensity: 90,
          distance: 12,
          angle: 40,
          penumbra: 0.7,
          shadow: { mapSize: 1024 },
        },
      ],
    },
    materials: [
      { id: 'ivory', shading: 'standard', color: '#9a9d98', roughness: 0.75, metalness: 0.12 },
      { id: 'graphite', shading: 'standard', color: '#435364', roughness: 0.45, metalness: 0.4 },
      {
        id: 'screen',
        shading: 'standard',
        color: '#2a8c99',
        emissive: '#52c9d4',
        emissiveIntensity: 2.5,
      },
    ],
    legacy: { level: false, triggers: false },
    objects: [
      {
        id: 'source-copy',
        visual: { kind: 'model', mesh: 'rig-copy' },
        pose: { position: [2.5, 0, 10] },
      },
      {
        id: 'floor',
        visual: { kind: 'primitive', shape: 'box', material: 'graphite' },
        pose: { position: [0, -0.2, 7], scale: [8, 0.4, 14] },
      },
      {
        id: 'back',
        visual: { kind: 'primitive', shape: 'box', material: 'ivory' },
        pose: { position: [0, 2, 14], scale: [8, 4, 0.3] },
      },
      {
        id: 'left',
        visual: { kind: 'primitive', shape: 'box', material: 'ivory' },
        pose: { position: [-4, 2, 7], scale: [0.3, 4, 14] },
      },
      {
        id: 'right',
        visual: { kind: 'primitive', shape: 'box', material: 'ivory' },
        pose: { position: [4, 2, 7], scale: [0.3, 4, 14] },
      },
      {
        id: 'occluder',
        visual: { kind: 'primitive', shape: 'box', material: 'ivory' },
        pose: { position: [-0.8, 0.8, 7], scale: [1, 1.6, 1] },
      },
      {
        id: 'terminal',
        visual: { kind: 'primitive', shape: 'box', material: 'screen' },
        pose: { position: [2, 1.7, 9], scale: [1.3, 0.8, 0.3] },
      },
      {
        id: 'handheld',
        anchor: 'camera',
        visual: { kind: 'model', mesh: 'rig' },
        pose: { position: [0.48, -0.45, -0.7], scale: [0.12, 0.12, 0.12] },
      },
    ],
    audio: {
      headroom: 0.6,
      layers: [
        { id: 'vent', asset: 'tone', volume: 0.05, spatial: { target: { entity: 'grunt' } } },
      ],
      cues: [
        {
          event: 'sample',
          asset: 'tone',
          maxVoices: 2,
          spatial: { target: { entity: 'grunt' } },
          caption: { text: 'A mechanical step nearby', durationTicks: 120 },
        },
      ],
    },
  };
  presentation.manifest = manifest;
  const scene = structuredClone(FPS_SCENE);
  scene.entities = [
    scene.entities[0]!,
    { id: 'grunt', components: { Transform: { position: { x: 3, y: 0, z: 5 } } } },
  ];
  const game = {
    id: 'cinematic',
    title: 'Cinematic engine fixture',
    blurb: 'Lighting and audio fixture',
    objective: 'Two shadow lights; LDR reflections; linear foreground composition.',
    mode: 'fps' as const,
    plugin: fpsPlugin,
    scene,
    bindings: BINDINGS.fps,
    presentation,
  };
  dev = await startDevServer({ games: [game], port: 0 });
  const initial = await fetch(`${dev.url}/api/cinematic/state`);
  expect(initial.ok).toBe(true);
  dev.session('cinematic')!.paused = true;
  const outDir = join(root, 'site');
  exportStaticSite({
    games: [
      {
        ...game,
        sceneText: JSON.stringify(scene),
        pluginModule: '@aegis/mode-fps',
        pluginExport: 'fpsPlugin',
      },
    ],
    repoRoot: findRepoRoot(),
    outDir,
  });
  server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    const target = resolve(outDir, `.${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`);
    if (!target.startsWith(outDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    let exists = false;
    try {
      exists = statSync(target).isFile();
    } catch {
      /* Explicit HTTP refusal below. */
    }
    if (!exists) {
      res.writeHead(404).end();
      return;
    }
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.html': 'text/html',
      '.json': 'application/json',
      '.gltf': 'model/gltf+json',
      '.png': 'image/png',
      '.wav': 'audio/wav',
    };
    res.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream' });
    createReadStream(target).pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing static fixture port.');
  staticUrl = `http://127.0.0.1:${address.port}`;
  browser = await launchBrowser({
    viewport: VIEWPORT,
    graphics: HARDWARE ? 'hardware' : 'software',
  });
  console.info(
    '[cinematic-browser:owned]',
    JSON.stringify({
      pid: browser.process.pid,
      profile: browser.profile,
      graphics: HARDWARE ? 'hardware' : 'software',
    }),
  );
  const blank = await openPage(browser.port, 'about:blank', VIEWPORT);
  await waitForPaint(blank);
  await blank.close();
}, 180_000);

afterAll(async () => {
  try {
    if (browser !== undefined) {
      await closeAllPages(browser.port);
      await closeOwnedBrowser(browser, {
        inspectProcesses: true,
        onTrace: (event) => console.info('[cinematic-browser:close]', JSON.stringify(event)),
      });
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    await dev?.close();
    if (server !== undefined)
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('cinematic browser parity', () => {
  it('rejects pending CDP work on owner disconnect rather than leaving a stale timeout', async () => {
    const page = await openPage(browser.port, 'about:blank', VIEWPORT);
    const pending = page.send('Runtime.evaluate', {
      expression: 'new Promise(()=>{})',
      awaitPromise: true,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(CdpDisconnectedError);
    page.close();
    await rejected;
    await expect(page.send('Runtime.evaluate', { expression: '1' })).rejects.toBeInstanceOf(
      CdpDisconnectedError,
    );
  });
  for (const kind of ['dev', 'static'] as const)
    it(`${kind} renders actual shadow maps, postprocessing, foreground and HRTF audio`, async () => {
      const cdp = await openPage(
        browser.port,
        `${kind === 'dev' ? dev.url : staticUrl}/play/cinematic/`,
        VIEWPORT,
      );
      try {
        // World readiness precedes the first render that allocates GPU shadow targets.
        await until(
          cdp,
          `${ready} && ['flashlight','practical'].every(id => Boolean(aegis.adapter.scene.getObjectByName('presentation:spot:'+id)?.shadow?.map))`,
          (value) => value === true,
          90_000,
        );
        const state = await evaluate<{
          pixels: number[];
          stats: {
            pipeline: {
              outputTransforms: number;
              width: number;
              height: number;
              reflections: boolean;
            };
            render: { resources: { shadowLights: number } };
          };
          lights: { name: string; allocated: boolean; size: number }[];
          foreground: number;
          gpu: string;
          sharedPixels: boolean;
        }>(
          cdp,
          `(() => {
        const a=aegis.adapter,canvas=document.getElementById('stage'),gl=canvas.getContext('webgl2');
        const ext=gl.getExtension('WEBGL_debug_renderer_info');
        const first=a.presentation.object('handheld').object.getObjectByName('body').material.map;
        const second=a.presentation.object('source-copy').object.getObjectByName('body').material.map;
        return {pixels:[canvas.width,canvas.height],stats:aegis.presentation(),sharedPixels:first!==second&&first.source===second.source,
          lights:['flashlight','practical'].map(id=>{
            const l=a.scene.getObjectByName('presentation:spot:'+id);return {name:id,allocated:l.shadow.map!==null,size:l.shadow.mapSize.x};
          }),foreground:a.foreground.scene.children.length,gpu:gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER)};
      })()`,
        );
        expect(state.pixels).toEqual([VIEWPORT.width, VIEWPORT.height]);
        expect(state.stats.pipeline).toMatchObject({ outputTransforms: 1, reflections: true });
        expect(state.stats.render.resources.shadowLights).toBe(2);
        expect(state.lights.every((light) => light.allocated && light.size === 1024)).toBe(true);
        expect(state.foreground).toBeGreaterThan(1);
        expect(state.sharedPixels).toBe(true);
        const textures = await evaluate<number>(
          cdp,
          'aegis.presentation().pipeline.gpuResources.textures',
        );
        await evaluate(
          cdp,
          `(async()=>{
          const {Source}=await import('three');
          const material=aegis.adapter.presentation.object('source-copy').object.getObjectByName('body').material;
          const original=material.map, copy=original.clone();
          copy.source=new Source(original.source.data); copy.needsUpdate=true;
          globalThis.__sourceProbe={material,original,copy}; material.map=copy;
        })()`,
        );
        try {
          await until<number>(
            cdp,
            'aegis.presentation().pipeline.gpuResources.textures',
            (count) => count === textures + 1,
          );
        } finally {
          await evaluate(
            cdp,
            '(()=>{const p=globalThis.__sourceProbe;p.material.map=p.original;p.copy.dispose();delete globalThis.__sourceProbe;})()',
          );
        }
        await until<number>(
          cdp,
          'aegis.presentation().pipeline.gpuResources.textures',
          (count) => count === textures,
        );
        if (HARDWARE) expect(state.gpu).not.toMatch(/swiftshader|llvmpipe/i);
        const hash = kind === 'dev' ? dev.session('cinematic')!.world.hash() : undefined;
        expect(await evaluate(cdp, "document.getElementById('mission-status').open")).toBe(false);
        expect(await evaluate(cdp, "document.getElementById('hud-step-0').checkVisibility()")).toBe(
          false,
        );
        const status = await evaluate<{ x: number; y: number }>(
          cdp,
          "(()=>{const r=document.querySelector('#mission-status summary').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
        );
        await click(cdp, status.x, status.y);
        expect(
          await evaluate(
            cdp,
            `({
          open: document.getElementById('mission-status').open,
          listDisplay: getComputedStyle(document.getElementById('hud-steps')).display,
          stepVisible: document.getElementById('hud-step-0').checkVisibility(),
        })`,
          ),
        ).toEqual({ open: true, listDisplay: 'block', stepVisible: true });
        if (!HARDWARE) {
          try {
            await evaluate(
              cdp,
              "document.getElementById('game-shell').removeAttribute('data-layout')",
            );
            expect(
              await evaluate(cdp, "getComputedStyle(document.getElementById('hud-steps')).display"),
            ).toBe('none');
            expect(
              await evaluate(cdp, "document.getElementById('hud-step-0').checkVisibility()"),
            ).toBe(false);
          } finally {
            await evaluate(
              cdp,
              "document.getElementById('game-shell').setAttribute('data-layout','cinematic')",
            );
          }
          expect(
            await evaluate(cdp, "document.getElementById('hud-step-0').checkVisibility()"),
          ).toBe(true);
        }
        await click(cdp, status.x, status.y);
        expect(await evaluate(cdp, "document.getElementById('mission-status').open")).toBe(false);
        expect(await evaluate(cdp, "document.getElementById('hud-step-0').checkVisibility()")).toBe(
          false,
        );
        const session = await evaluate<{ x: number; y: number }>(
          cdp,
          "(()=>{const r=document.querySelector('#session-menu summary').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
        );
        await click(cdp, session.x, session.y);
        const mute = await evaluate<{ x: number; y: number }>(
          cdp,
          "(()=>{const r=document.getElementById('action-mute').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
        );
        await click(cdp, mute.x, mute.y);
        await until(cdp, 'aegis.presentation().audio.status', (value) => value === 'ready');
        await click(cdp, session.x, session.y);
        expect(await evaluate(cdp, 'aegis.presentation().audio.voices')).toBe(
          kind === 'dev' ? 0 : 1,
        );
        if (kind === 'dev') {
          const world = dev.session('cinematic')!.world;
          expect(world.hash()).toBe(hash);
          world.events.emit('sample', {});
          await until(
            cdp,
            "document.getElementById('hud-subtitle').textContent",
            (value) => value === 'A mechanical step nearby',
          );
          world.getOrThrow(entityNamed(world, 'player'), Health).current = 99;
          await until(
            cdp,
            "aegis.adapter.scene.getObjectByName('presentation:spot:flashlight').visible",
            (value) => value === false,
          );
          world.getOrThrow(entityNamed(world, 'player'), Health).current = 100;
          await until(
            cdp,
            "aegis.adapter.scene.getObjectByName('presentation:spot:flashlight').visible",
            (value) => value === true,
          );
        }
        const evidence = process.env['AEGIS_CINEMATIC_EVIDENCE'];
        if (evidence !== undefined) {
          mkdirSync(evidence, { recursive: true });
          await screenshot(
            cdp,
            join(evidence, `${kind}-${HARDWARE ? 'hardware' : 'software'}.png`),
          );
          if (kind === 'dev') {
            await evaluate(cdp, 'new Promise(r=>setTimeout(r,2000))');
            await evaluate(cdp, 'aegis.resetTimings(); new Promise(r=>setTimeout(r,4000))');
            const measurements = await evaluate(
              cdp,
              '({timings:aegis.timings(),samples:aegis.samples(),presentation:aegis.presentation()})',
            );
            writeFileSync(
              join(evidence, 'measurements.json'),
              JSON.stringify(
                {
                  ...state,
                  recordedAt: new Date().toISOString(),
                  warmupMs: 2000,
                  sampleWindowMs: 4000,
                  context:
                    process.env['AEGIS_MEASUREMENT_CONTEXT'] ??
                    'Shared-machine load not recorded; not isolated game performance.',
                  simulation: 'paused primitive fixture, not the final game',
                  measurements,
                },
                null,
                2,
              ),
            );
          }
        }
        await evaluate(
          cdp,
          "document.getElementById('quality').value='low';document.getElementById('quality').dispatchEvent(new Event('change'))",
        );
        await until(cdp, 'aegis.presentation().pipeline.quality', (value) => value === 'low');
        expect(await evaluate(cdp, 'aegis.presentation().pipeline.ambientOcclusion')).toBe(false);
        expect(
          await evaluate(
            cdp,
            "aegis.adapter.scene.getObjectByName('presentation:spot:flashlight').shadow.mapSize.x",
          ),
        ).toBe(512);
        await evaluate(
          cdp,
          "document.getElementById('quality').value='photo';document.getElementById('quality').dispatchEvent(new Event('change'))",
        );
        await until(cdp, 'aegis.presentation().pipeline.quality', (value) => value === 'photo');
        expect(await evaluate(cdp, 'aegis.presentation().pipeline.ambientOcclusion')).toBe(true);
        expect(cdp.diagnostics).toEqual([]);
      } finally {
        try {
          await cdp.send('Page.navigate', { url: 'about:blank' });
        } finally {
          cdp.close();
        }
      }
    }, 180_000);
});

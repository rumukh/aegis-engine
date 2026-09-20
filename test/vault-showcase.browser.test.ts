import { createReadStream, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseInputScript, runScene } from '@aegis/harness';
import { SERVER_VAULT_SCRIPT, SERVER_VAULT_DEATH_SCRIPT, serverVaultPlugin } from '@aegis/game-iso';
import { pocGames, pocStaticGames, pocStaticModules } from '../poc/poc-games.mjs';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import type { DevServer } from '../packages/render-three/src/dev-server.js';
import { exportStaticSite } from '../packages/render-three/src/static-site.js';
import { compileDomInput } from '../packages/render-three/src/script-input.js';
import {
  click,
  evaluate,
  key,
  launchBrowser,
  openPage,
  screenshot,
  until,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { navigateAndWait } from '../packages/render-three/src/browser-navigation.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import type { GameDefinition } from '../packages/render-three/src/catalog.js';
import type { EventLine } from '../packages/render-three/src/protocol.js';

type Transport = 'dev' | 'static';
const VIEWPORT = { width: 1280, height: 800 };
const PREFIX = '/nested/vault/';
const captures = process.env['AEGIS_VAULT_CAPTURE_DIR'];
const reports: Record<string, unknown> = {};
const browserLifetimes: object[] = [];
reports['browserLifetimes'] = browserLifetimes;
const images: { path: string; tick: number; viewport: { width: number; height: number } }[] = [];
reports['images'] = images;
let temporary: string;
let game: GameDefinition;
let dev: DevServer;
let staticServer: Server;
let staticUrl: string;
let browser: LaunchedBrowser | undefined;
const requests: string[] = [];

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aegis-vault-acceptance-'));
  game = (await pocGames()).find((entry) => entry.id === 'iso')!;
  expect(game.script).toBeDefined();
  dev = await startDevServer({ games: [game], port: 0, basePath: '/preview/' });
  const output = join(temporary, 'site');
  exportStaticSite({
    games: (await pocStaticGames()).filter((entry) => entry.id === 'iso'),
    modules: await pocStaticModules(),
    repoRoot: resolve('.'),
    outDir: output,
  });
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary',
    '.wav': 'audio/wav',
  };
  staticServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method !== 'GET' || !url.pathname.startsWith(PREFIX)) {
      response.writeHead(404).end();
      return;
    }
    let path = decodeURIComponent(url.pathname.slice(PREFIX.length));
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const target = resolve(output, path);
    if (!target.startsWith(output + sep)) {
      response.writeHead(403).end();
      return;
    }
    let exists = false;
    try {
      exists = statSync(target).isFile();
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (!exists) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': mime[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    staticServer.once('error', fail);
    staticServer.listen(0, '127.0.0.1', done);
  });
  const address = staticServer.address();
  if (address === null || typeof address === 'string') throw new Error('No static server port');
  staticUrl = `http://127.0.0.1:${address.port}${PREFIX.slice(0, -1)}`;
  if (captures !== undefined) mkdirSync(captures, { recursive: true });
}, 180_000);

beforeEach(async () => {
  browser = await launchBrowser({ viewport: VIEWPORT });
  reports['ownedBrowser'] = {
    pid: browser.process.pid,
    profile: browser.profile,
    port: browser.port,
  };
});

afterEach(async ({ task }) => {
  const owned = browser;
  browser = undefined;
  if (owned === undefined) return;
  try {
    await closeOwnedBrowser(owned);
  } finally {
    await rm(owned.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  browserLifetimes.push({
    test: task.name,
    pid: owned.process.pid,
    method: 'Browser.close',
    exitCode: owned.process.exitCode,
    profileRemoved: true,
  });
});

afterAll(async () => {
  const failures: unknown[] = [];
  const cleanup = [
    async () => {
      if (captures === undefined) return;
      mkdirSync(captures, { recursive: true });
      writeFileSync(join(captures, 'browser-report.json'), JSON.stringify(reports, null, 2));
    },
    async () => {
      await dev?.close();
    },
    async () => {
      if (staticServer === undefined) return;
      staticServer.closeAllConnections();
      await new Promise<void>((done) => staticServer.close(() => done()));
    },
    async () => {
      if (temporary !== undefined)
        await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  ];
  for (const release of cleanup) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Vault acceptance cleanup failed');
}, 120_000);

async function open(transport: Transport): Promise<CdpSession> {
  if (browser === undefined) throw new Error('The test browser is not running.');
  const page = await openPage(
    browser.port,
    `${transport === 'dev' ? dev.url : staticUrl}/play/iso/`,
    VIEWPORT,
  );
  await until(page, "globalThis.aegis?.presentation().status === 'ready'", Boolean);
  await evaluate(page, 'globalThis.aegis.ready.then(() => true)');
  return page;
}

async function control(
  page: CdpSession,
  transport: Transport,
  command: 'pause' | 'resume' | 'restart' | 'step',
  ticks = 1,
): Promise<void> {
  if (transport === 'dev') {
    const response = await fetch(`${dev.url}/api/iso/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, ticks }),
    });
    expect(response.status).toBe(200);
  } else if (command === 'step') {
    // Time control only: gameplay clicks still enter through real CDP mouse input.
    await evaluate(
      page,
      `(() => {
      for (let i=0;i<${ticks};i++) window.dispatchEvent(new KeyboardEvent('keydown', {code:'Period'}));
    })()`,
    );
  } else {
    if (command === 'pause' && (await evaluate<boolean>(page, 'globalThis.aegis.paused()'))) return;
    if (command === 'resume' && !(await evaluate<boolean>(page, 'globalThis.aegis.paused()')))
      return;
    const code = command === 'restart' ? 'KeyR' : 'KeyP';
    await evaluate(page, 'document.activeElement?.blur()');
    await key(page, code, true);
    await key(page, code, false);
  }
  await evaluate(page, 'globalThis.aegis.sync().then(() => true)');
}

async function draw(page: CdpSession, tick: number): Promise<void> {
  await until<number>(page, 'globalThis.aegis.tick()', (value) => value === tick);
  await evaluate(
    page,
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
  );
}

async function photo(page: CdpSession, name: string): Promise<void> {
  if (captures === undefined) return;
  const path = join(captures, `${name}.png`);
  await screenshot(page, path);
  images.push({
    path,
    ...(await evaluate<{ tick: number; viewport: { width: number; height: number } }>(
      page,
      '({tick:globalThis.aegis?.tick()??-1,viewport:{width:innerWidth,height:innerHeight}})',
    )),
  });
}

async function reset(page: CdpSession, transport: Transport): Promise<void> {
  await control(page, transport, 'pause');
  await control(page, transport, 'restart');
  await draw(page, 0);
}

const appearance = `(() => {
  const runtime = globalThis.aegis.adapter.presentation;
  return {
    tick: globalThis.aegis.tick(),
    hash: globalThis.aegis.world.hash(),
    leftDoor: runtime.entity('vault-door').object.getObjectByName('leaf-left').position.x,
    rightDoor: runtime.entity('vault-door').object.getObjectByName('leaf-right').position.x,
    activeConsole: runtime.entity('security-switch').object.getObjectByName('screen-active').scale.x,
    uplink: runtime.entity('vault-exit').object.getObjectByName('uplink-column').scale.y,
    actors:['operative','guard'].map(name=>{
      const actor=runtime.entity(name);
      return {name,state:actor.state,position:actor.root.position.toArray(),
        gait:actor.object.getObjectByName('leg-right').rotation.x};
    }),
    outcome: document.getElementById('hud-outcome').textContent,
    outcomeHidden: document.getElementById('hud-outcome').hidden,
    progress: document.getElementById('hud-progress').textContent,
    presentation: globalThis.aegis.presentation(),
  };
})()`;

const tacticalRead = `(() => {
  const adapter=globalThis.aegis.adapter;
  adapter.sync(globalThis.aegis.world);
  const canvas=document.getElementById('stage').getBoundingClientRect();
  const panels=[...document.querySelectorAll('.panel')].filter(p=>!p.hidden&&p.getClientRects().length).map(p=>p.getBoundingClientRect());
  return ['operative','guard','security-switch','vault-door','vault-exit'].map(name=>{
    const visual=adapter.presentation.entity(name);
    const point=visual.root.position.clone();
    point.y+=name==='operative'||name==='guard'?0.6:name==='security-switch'?0.3:0.05;
    const ndc=point.project(adapter.camera),x=canvas.x+(ndc.x+1)*canvas.width/2,y=canvas.y+(1-ndc.y)*canvas.height/2;
    const logical=globalThis.aegis.world.snapshot().entities.find(e=>e.name===name).components;
    const expected=logical.GridPosition?{x:logical.GridPosition.cellX,y:logical.GridPosition.cellY}:{x:logical.Transform.position.x,y:logical.Transform.position.y};
    const pick=adapter.pick(ndc.x,ndc.y);
    return {name,inView:Math.abs(ndc.x)<=1&&Math.abs(ndc.y)<=1,
      covered:panels.some(r=>x>=r.x&&x<=r.right&&y>=r.y&&y<=r.bottom),
      correctPick:pick?.x===expected.x&&pick?.y===expected.y};
  });
})()`;

interface AppearanceRead {
  tick: number;
  hash: string;
  leftDoor: number;
  rightDoor: number;
  activeConsole: number;
  uplink: number;
  outcome: string;
  outcomeHidden: boolean;
  progress: string;
  actors: { name: string; state: string; position: number[]; gait: number }[];
  presentation: {
    generation: number;
    status: string;
    assets: { modelInstances: number; textures: number; geometries: number };
    render: {
      effects: { active: number };
      resources: { instances: number; batches: number };
      dropped: number;
    };
    audio: { status: string; muted: boolean; voices: number; dropped: number };
  };
}

async function replay(
  page: CdpSession,
  transport: Transport,
  script: string,
  ticks: number,
  label: string,
): Promise<EventLine[]> {
  const parsed = parseInputScript(script);
  if (!parsed.ok || parsed.value === undefined) throw new Error('Invalid shipped input script');
  const plan = compileDomInput(parsed.value.frames(ticks), game.bindings);
  const reference = await runScene(game.scene, {
    plugin: serverVaultPlugin,
    input: script,
    ticks,
    captureHistory: true,
  });
  const beats = new Map<number, string>(
    ticks === 960
      ? [
          [0, 'start'],
          [25, 'patrol-step'],
          [65, 'patrol'],
          [180, 'first-fire'],
          [220, 'firefight'],
          [301, 'sealed-route'],
          [324, 'switch'],
          [348, 'unsealing'],
          [382, 'open-vault'],
          [506, 'extraction'],
          [580, 'extracted'],
        ]
      : [
          [0, 'start'],
          [180, 'under-fire'],
          [260, 'death'],
        ],
  );
  const boundaries = [
    ...new Set([
      0,
      ticks,
      ...plan.segments.map((segment) => segment.tick),
      ...beats.keys(),
      ...(ticks === 960 ? [19, 21] : []),
    ]),
  ].sort((a, b) => a - b);
  const states: AppearanceRead[] = [];
  for (let index = 0; index < boundaries.length; index++) {
    const tick = boundaries[index]!;
    const beat = beats.get(tick);
    if (beat !== undefined) {
      await draw(page, tick);
      const state = await evaluate<AppearanceRead>(page, appearance);
      states.push(state);
      if (beat === 'patrol-step') {
        const guard = state.actors.find((actor) => actor.name === 'guard')!;
        expect(guard.state).toBe('move');
        expect(guard.position[0]).toBeGreaterThan(1);
        expect(guard.position[0]).toBeLessThan(2);
        expect(Math.abs(guard.gait)).toBeGreaterThan(0.01);
      }
      await photo(page, `${transport}-${label}-${beat}`);
      const tactical = await evaluate<
        { name: string; inView: boolean; covered: boolean; correctPick: boolean }[]
      >(page, tacticalRead);
      reports[`${transport}-${label}-${beat}-targets`] = tactical;
      expect(
        tactical.filter((target) => !target.inView || target.covered),
        `critical targets at ${beat}`,
      ).toEqual([]);
      // A collapsed corpse is no longer a target at standing-body height.
      expect(
        tactical.filter(
          (target) => target.name !== 'guard' && target.name !== 'operative' && !target.correctPick,
        ),
      ).toEqual([]);
    }
    const segment = plan.segments.find((segment) => segment.tick === tick);
    if (segment?.click !== undefined) {
      await evaluate(page, 'globalThis.aegis.sync().then(() => true)');
      const pointer = await evaluate<{ x: number; y: number } | null>(
        page,
        `(() => {
          const guard=globalThis.aegis.world.snapshot().entities.find(e=>e.name==='guard').components;
          const onGuard=guard.Health.current>0&&guard.GridPosition.cellX===${segment.click.x}&&guard.GridPosition.cellY===${segment.click.y};
          return globalThis.aegis.project(${segment.click.x},onGuard?0.65:0,${segment.click.y});
        })()`,
      );
      expect(pointer, `script cell must be visible at tick ${tick}`).not.toBeNull();
      const picked = await evaluate<{ x: number; y: number; z: number }>(
        page,
        `(() => { const a=globalThis.aegis; const r=document.getElementById('stage').getBoundingClientRect();
          return a.adapter.pick((${pointer!.x}-r.left)/r.width*2-1,1-(${pointer!.y}-r.top)/r.height*2); })()`,
      );
      expect(picked, `logical pick at script tick ${tick}`).toEqual({
        x: segment.click.x,
        y: segment.click.y,
        z: 0,
      });
      const target = await evaluate<string | null>(
        page,
        `document.elementFromPoint(${pointer!.x},${pointer!.y})?.id ?? null`,
      );
      expect(target, `HUD must not intercept tick ${tick} gameplay click`).toBe('stage');
      await click(page, pointer!.x, pointer!.y);
      await evaluate(page, 'globalThis.aegis.sync().then(() => true)');
    }
    const next = boundaries[index + 1];
    if (next !== undefined) {
      await control(page, transport, 'step', next - tick);
      await draw(page, next);
      expect(
        await evaluate<string>(page, 'globalThis.aegis.world.hash()'),
        `${transport} first divergent boundary after ${tick}..${next}`,
      ).toBe(reference.at(next - 1).hash());
    }
  }
  reports[`${transport}-${label}`] = states;
  return transport === 'dev'
    ? ((await (await fetch(`${dev.url}/api/iso/events`)).json()) as { events: EventLine[] }).events
    : await evaluate<EventLine[]>(page, 'globalThis.aegis.events()');
}

describe('Server Vault actual showcase', () => {
  for (const transport of ['dev', 'static'] as const) {
    it(`${transport}: required model loading is visible, failure is explicit and retry recovers`, async () => {
      if (browser === undefined) throw new Error('The test browser is not running.');
      const page = await openPage(browser.port, 'about:blank', VIEWPORT);
      const url = `${transport === 'dev' ? dev.url : staticUrl}/play/iso/`;
      try {
        await page.send('Network.enable');
        await page.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 15,
          downloadThroughput: 180_000,
          uploadThroughput: 180_000,
        });
        await navigateAndWait(page, () => page.send('Page.navigate', { url }));
        await until(page, "globalThis.aegis?.presentation().status==='loading'", Boolean);
        expect(await evaluate(page, "document.getElementById('loading-panel').hidden")).toBe(false);
        expect(await evaluate(page, "document.getElementById('action-restart').disabled")).toBe(
          true,
        );
        await photo(page, `${transport}-loading`);
        await page.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await until(page, "globalThis.aegis?.presentation().status==='ready'", Boolean);
        await page.send('Network.setBlockedURLs', { urls: ['*operative.gltf'] });
        const origin = await evaluate<number>(page, 'performance.timeOrigin');
        await navigateAndWait(page, () => page.send('Page.reload', { ignoreCache: true }));
        await until(
          page,
          `performance.timeOrigin!==${origin} && globalThis.aegis?.presentation().status==='error'`,
          Boolean,
        );
        const message = await evaluate<string>(
          page,
          "document.getElementById('loading-message').textContent",
        );
        expect(message).toContain('operative');
        expect(message).toContain('AEG-RENDER-0004');
        expect(await evaluate(page, 'globalThis.aegis.tick()')).toBe(-1);
        await photo(page, `${transport}-required-model-error`);
        await page.send('Network.setBlockedURLs', { urls: [] });
        const button = await evaluate<{ x: number; y: number }>(
          page,
          "(() => {const r=document.getElementById('action-retry').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
        );
        await navigateAndWait(page, () => click(page, button.x, button.y));
        await until(page, "globalThis.aegis?.presentation().status==='ready'", Boolean);
        expect(await evaluate(page, 'globalThis.aegis.presentation().assets.modelInstances')).toBe(
          6,
        );
        reports[`${transport}-asset-recovery`] = {
          loadingVisible: true,
          requiredFailure: message,
          retry: 'ready',
        };
      } finally {
        page.close();
      }
    }, 180_000);

    it(`${transport}: audio, controls, reduced motion and disposal remain usable at narrow widths`, async () => {
      const page = await open(transport);
      const pressButton = async (id: string) => {
        const point = await evaluate<{ x: number; y: number }>(
          page,
          `(() => {const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await click(page, point.x, point.y);
      };
      try {
        await evaluate(
          page,
          `(() => {
          globalThis.vaultAudioStarts=[];
          const original=AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start=function(...args) {
            globalThis.vaultAudioStarts.push({loop:this.loop,duration:this.buffer?.duration??0});
            return original.apply(this,args);
          };
        })()`,
        );
        expect(await evaluate(page, 'globalThis.aegis.presentation().audio.status')).toBe('locked');
        await pressButton('action-mute');
        await until(page, "globalThis.aegis.presentation().audio.status==='ready'", Boolean);
        await control(page, transport, 'resume');
        await until<number>(
          page,
          'globalThis.aegis.presentation().audio.voices',
          (voices) => voices > 0,
        );
        await pressButton('action-mute');
        await until(page, 'globalThis.aegis.presentation().audio.muted', Boolean);
        expect(await evaluate(page, 'globalThis.aegis.presentation().audio.voices')).toBe(0);
        await pressButton('action-mute');
        await until<number>(
          page,
          'globalThis.aegis.presentation().audio.voices',
          (voices) => voices > 0,
        );
        await reset(page, transport);
        expect(await evaluate(page, 'globalThis.aegis.presentation().audio.voices')).toBe(0);
        // Prefix of the shipped lose route: let a new, live guard shot prove cue playback.
        await control(page, transport, 'step', 2);
        const walk = await evaluate<{ x: number; y: number }>(
          page,
          'globalThis.aegis.project(1,0,2)',
        );
        await click(page, walk.x, walk.y);
        await evaluate(page, 'globalThis.aegis.sync().then(()=>true)');
        await control(page, transport, 'step', 175);
        expect(
          await evaluate(page, 'globalThis.vaultAudioStarts.filter(voice=>!voice.loop).length'),
        ).toBe(0);
        await control(page, transport, 'resume');
        await until(page, 'globalThis.vaultAudioStarts.some(voice=>!voice.loop)', Boolean);
        await control(page, transport, 'pause');
        const audioStarts = await evaluate<{ loop: boolean; duration: number }[]>(
          page,
          'globalThis.vaultAudioStarts',
        );
        expect(
          audioStarts.some((voice) => !voice.loop && Math.abs(voice.duration - 0.2) < 0.002),
        ).toBe(true);
        await reset(page, transport);
        const baseline = await evaluate(page, 'globalThis.aegis.presentation().assets');
        for (let repeat = 0; repeat < 3; repeat++) {
          await pressButton('action-restart');
          await until<number>(page, 'globalThis.aegis.tick()', (tick) => tick === 0);
          expect(await evaluate(page, 'globalThis.aegis.presentation().assets')).toEqual(baseline);
        }
        await page.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await until(page, 'globalThis.aegis.presentation().render.reducedMotion', Boolean);
        await evaluate(
          page,
          `(() => { const quality=document.getElementById('quality'); quality.value='low'; quality.dispatchEvent(new Event('change')); })()`,
        );
        expect(await evaluate(page, 'globalThis.aegis.presentation().quality')).toBe('low');
        expect(await evaluate(page, 'globalThis.aegis.presentation().render.effects.limit')).toBe(
          32,
        );
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await evaluate(
          page,
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
        );
        const layout = await evaluate<{
          scrollWidth: number;
          width: number;
          controls: { id: string; visible: boolean }[];
          route: { cell: number[]; visible: boolean; covered: boolean; picked: boolean }[];
          cellPixels: number;
        }>(
          page,
          `(() => {
            const panelRects=[...document.querySelectorAll('.panel')].filter(panel=>!panel.hidden&&panel.getClientRects().length).map(panel=>panel.getBoundingClientRect());
            const canvas=document.getElementById('stage').getBoundingClientRect();
            const a=globalThis.aegis.project(5,0,5),b=globalThis.aegis.project(6,0,5);
            return {
            scrollWidth:document.documentElement.scrollWidth,width:innerWidth,
            cellPixels:Math.hypot(a.x-b.x,a.y-b.y),
            controls:['action-pause','action-restart','action-mute','quality'].map(id=>{
              const e=document.getElementById(id),r=e.getBoundingClientRect();
              return {id,visible:r.width>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
            }),
            route:[[1,1],[1,5],[9,5],[9,1],[4,6],[4,7]].map(cell=>{
              const p=globalThis.aegis.project(cell[0],0,cell[1]);
              const picked=p&&globalThis.aegis.adapter.pick((p.x-canvas.x)/canvas.width*2-1,1-(p.y-canvas.y)/canvas.height*2);
              return {cell,visible:p!==null&&p.x>=0&&p.x<innerWidth&&p.y>=0&&p.y<innerHeight,
                covered:p!==null&&panelRects.some(r=>p.x>=r.x&&p.x<=r.right&&p.y>=r.y&&p.y<=r.bottom),
                picked:picked?.x===cell[0]&&picked?.y===cell[1]};
            }),
          };})()`,
        );
        reports[`${transport}-narrow`] = layout;
        await photo(page, `${transport}-narrow`);
        expect(layout.scrollWidth).toBe(layout.width);
        expect(layout.controls.every((control) => control.visible)).toBe(true);
        expect(layout.route.filter((cell) => !cell.visible)).toEqual([]);
        expect(layout.route.filter((cell) => cell.covered || !cell.picked)).toEqual([]);
        expect(layout.cellPixels).toBeGreaterThanOrEqual(14);
        await evaluate(page, "window.dispatchEvent(new Event('beforeunload'))");
        const disposed = await evaluate<AppearanceRead['presentation']>(
          page,
          'globalThis.aegis.presentation()',
        );
        expect(disposed.status).toBe('disposed');
        expect(disposed.assets.modelInstances).toBe(0);
        expect(disposed.assets.geometries).toBe(0);
        expect(disposed.assets.textures).toBe(0);
        expect(disposed.audio.voices).toBe(0);
        reports[`${transport}-lifecycle`] = { audioStarts, baseline, disposed };
      } finally {
        page.close();
      }
    }, 180_000);

    it(`${transport}: original winning route renders and stays deterministic through every named beat`, async () => {
      const page = await open(transport);
      try {
        await reset(page, transport);
        const events = await replay(page, transport, SERVER_VAULT_SCRIPT, 960, 'win');
        const ticks = (type: string) =>
          events.filter((event) => event.type === type).map((event) => event.tick);
        expect(ticks('guard.alerted')).toEqual([178]);
        expect(ticks('attack.fired')).toEqual([178, 195, 218, 225]);
        expect(ticks('path.blocked')).toEqual([300]);
        expect(ticks('switch.activated')).toEqual([322]);
        expect(ticks('door.opened')).toEqual([322]);
        expect(ticks('mission.completed')).toEqual([505]);
        expect(ticks('player.died')).toEqual([]);
        const state = await evaluate<AppearanceRead>(page, appearance);
        reports[`${transport}-win-final`] = { ...state, events };
        expect(state.hash).toBe('cb0f07007ad8608a');
        expect(state.leftDoor).toBeCloseTo(-0.62);
        expect(state.rightDoor).toBeCloseTo(0.62);
        expect(state.activeConsole).toBe(1);
        expect(state.uplink).toBeCloseTo(1.3);
        expect(state.progress).toBe('4 / 4 complete');
        expect(state.outcomeHidden).toBe(false);
        expect(state.presentation.assets.modelInstances).toBe(6);
        expect(state.presentation.render.resources.batches).toBe(11);
        if (transport === 'static') {
          const urls = await evaluate<string[]>(
            page,
            "performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>!name.startsWith('blob:')&&!name.startsWith('data:'))",
          );
          expect(urls.length).toBeGreaterThan(40);
          expect(urls.every((url) => new URL(url).pathname.startsWith(PREFIX))).toBe(true);
          expect(requests.some((request) => request.startsWith('POST '))).toBe(false);
        } else {
          const beforeReload = await evaluate<AppearanceRead>(page, appearance);
          const origin = await evaluate<number>(page, 'performance.timeOrigin');
          await navigateAndWait(page, () => page.send('Page.reload', { ignoreCache: true }));
          await until(
            page,
            `performance.timeOrigin!==${origin} && globalThis.aegis?.presentation().status==='ready'`,
            Boolean,
          );
          await draw(page, 960);
          const afterReload = await evaluate<AppearanceRead>(page, appearance);
          expect(afterReload.hash).toBe(beforeReload.hash);
          expect(afterReload.leftDoor).toBe(beforeReload.leftDoor);
          expect(afterReload.activeConsole).toBe(1);
          expect(afterReload.uplink).toBeCloseTo(1.3);
          expect(afterReload.progress).toBe('4 / 4 complete');
          expect(afterReload.presentation.audio.dropped).toBe(0);
          expect(afterReload.presentation.render.effects.active).toBe(0);
          await photo(page, 'dev-reloaded-extraction');
          reports['reload'] = afterReload;
        }
        await reset(page, transport);
        const restarted = await evaluate<AppearanceRead>(page, appearance);
        expect(restarted.leftDoor).toBeCloseTo(-0.197);
        expect(restarted.activeConsole).toBe(0);
        expect(restarted.uplink).toBe(0);
        expect(restarted.progress).toBe('0 / 4 complete');
        expect(restarted.presentation.assets).toEqual(state.presentation.assets);
        expect(restarted.presentation.render.effects.active).toBe(0);
        if (transport === 'dev') {
          await page.send('Emulation.setDeviceMetricsOverride', {
            width: 640,
            height: 360,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await control(page, transport, 'resume');
          await evaluate(page, 'globalThis.aegis.resetTimings()');
          await until(
            page,
            'globalThis.aegis.samples().work.length>=20 && globalThis.aegis.timings().snapshots>=3',
            Boolean,
            20_000,
          );
          const metrics = await evaluate<{
            drawCalls: number;
            triangles: number;
            exchangeBytes: number;
            snapshots: number;
            exchangeErrors: number;
            frames: number;
          }>(page, 'globalThis.aegis.timings()');
          expect(metrics.frames).toBeGreaterThan(10);
          expect(metrics.snapshots).toBeGreaterThanOrEqual(3);
          expect(metrics.drawCalls).toBeGreaterThan(0);
          expect(metrics.drawCalls).toBeLessThanOrEqual(2000);
          expect(metrics.exchangeBytes).toBeGreaterThan(0);
          expect(metrics.exchangeBytes).toBeLessThanOrEqual(24000);
          expect(metrics.exchangeErrors * 2).toBeLessThanOrEqual(metrics.snapshots);
          reports['performance'] = {
            ...metrics,
            viewport: { width: 640, height: 360 },
            samples: await evaluate(page, 'globalThis.aegis.samples()'),
          };
          await control(page, transport, 'pause');
        }
      } finally {
        await photo(page, `${transport}-last`);
        page.close();
      }
    }, 240_000);

    it(`${transport}: the original lose route kills the operative without unlocking the vault`, async () => {
      const page = await open(transport);
      try {
        await reset(page, transport);
        const events = await replay(page, transport, SERVER_VAULT_DEATH_SCRIPT, 300, 'lose');
        expect(events.filter((event) => event.type === 'damage.taken')).toHaveLength(6);
        expect(
          events.filter((event) => event.type === 'player.died').map((event) => event.tick),
        ).toEqual([218]);
        expect(events.some((event) => event.type === 'mission.completed')).toBe(false);
        const reference = await runScene(game.scene, {
          plugin: serverVaultPlugin,
          input: SERVER_VAULT_DEATH_SCRIPT,
          ticks: 300,
        });
        const state = await evaluate<AppearanceRead>(page, appearance);
        reports[`${transport}-lose-final`] = { ...state, referenceHash: reference.hash, events };
        expect(state.hash).toBe(reference.hash);
        expect(state.leftDoor).toBeCloseTo(-0.197);
        expect(state.activeConsole).toBe(0);
        expect(state.uplink).toBe(0);
        expect(state.outcome).toContain('Run ended');
        expect(state.outcomeHidden).toBe(false);
      } finally {
        page.close();
      }
    }, 180_000);
  }
});

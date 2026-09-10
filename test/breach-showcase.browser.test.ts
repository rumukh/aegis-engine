import assert from 'node:assert/strict';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInputScript } from '@aegis/harness';
import {
  sectorBreachPitDeath,
  sectorBreachWallSlide,
} from '../games/fps/src/sector-breach.gametest.js';
import { pocGames, pocStaticGames, pocStaticModules } from '../poc/poc-games.mjs';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import type { DevServer } from '../packages/render-three/src/dev-server.js';
import { exportStaticSite } from '../packages/render-three/src/static-site.js';
import { compileDomInput } from '../packages/render-three/src/script-input.js';
import type { DomInputPlan } from '../packages/render-three/src/script-input.js';
import { BINDINGS } from '../packages/render-three/src/bindings.js';
import {
  click,
  closeAllPages,
  evaluate,
  key,
  launchBrowser,
  mouseButton,
  mouseMove,
  openPage,
  screenshot,
  until,
  waitForPaint,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import type { EventLine } from '../packages/render-three/src/protocol.js';

const VIEWPORT = { width: 1280, height: 720 };
const PREFIX = '/review/sector-breach/';
const FRAME = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))`;
const READY = `globalThis.aegis?.presentation().status === 'ready'`;
const AUDIO_OBSERVER = `(() => {
  globalThis.__breachAudioStarts = [];
  const original = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...args) {
    const result = original.apply(this,args);
    globalThis.__breachAudioStarts.push({loop:this.loop,seconds:this.buffer?.duration});
    return result;
  };
})()`;
const READ = `(() => {
  const a = globalThis.aegis, p = a.presentation(), r = a.adapter.presentation;
  const entity = name => a.world.snapshot().entities.find(e => e.name === name)?.components;
  const lights = scene => {
    const count={all:0,point:0};
    scene?.traverse(node=>{if(node.isLight)count.all++;if(node.isPointLight)count.point++;});
    return count;
  };
  return {
    tick: a.tick(), hash: a.world.hash(), player: entity('player'), grunt: entity('grunt'),
    presentation: p, door: r.object('blast-door').object.getObjectByName('DoorLeaf').position.y,
    lock: r.entity('button').object.getObjectByName('LockStatus').scale.toArray(),
    progress: document.getElementById('hud-progress').textContent,
    outcome: document.getElementById('hud-outcome').textContent,
    locked: document.pointerLockElement === document.getElementById('stage'),
    camera: a.adapter.camera.matrixWorld.toArray(),
    viewport: [innerWidth, innerHeight],
    timings: a.timings?.(),
    audioStarts: globalThis.__breachAudioStarts ?? [],
    foregroundDraws: globalThis.__breachForegroundDraws ?? 0,
    lights: {world:lights(a.adapter.scene),foreground:lights(a.adapter.foreground?.scene)},
  };
})()`;

interface Reading {
  tick: number;
  hash: string;
  player: {
    Transform: { position: { x: number; y: number; z: number } };
    LookState: { yawDeg: number; pitchDeg: number };
    Health: { current: number };
    Dead?: object;
  };
  grunt: { Health: { current: number } };
  presentation: {
    status: string;
    generation: number;
    assets: {
      loadedFiles: number;
      modelInstances: number;
      textures: number;
      geometries: number;
      materials: number;
      audioBytes: number;
    };
    render: {
      effects: { active: number; limit: number };
      resources: { modelInstances: number; pointLights: number };
      legacy: { levelVisible: boolean; retainedMeshes: number; visibleMeshes: number };
    };
    audio: { status: string; muted: boolean; voices: number; dropped: number };
  };
  door: number;
  lock: number[];
  progress: string;
  outcome: string;
  locked: boolean;
  camera: number[];
  viewport: number[];
  timings?: {
    drawCalls: number;
    triangles: number;
    exchangeBytes: number;
    exchangeErrors: number;
    snapshots: number;
  };
  audioStarts: { loop: boolean; seconds: number }[];
  foregroundDraws: number;
  lights: { world: { all: number; point: number }; foreground: { all: number; point: number } };
}

let temporary: string;
let artifacts: string;
let dev: DevServer;
let fileServer: Server;
let staticUrl: string;
let browser: LaunchedBrowser;
const blocked = new Set<string>();
const observations: object[] = [];

function plan(text: string, ticks: number): DomInputPlan {
  const parsed = parseInputScript(text);
  assert.ok(parsed.ok && parsed.value);
  return compileDomInput(parsed.value.frames(ticks), BINDINGS.fps);
}

const win = plan(readFileSync('games/fps/play/sector-breach.input', 'utf8'), 600);
assert.equal(typeof sectorBreachPitDeath.input, 'string');
assert.equal(typeof sectorBreachWallSlide.input, 'string');
const loss = plan(sectorBreachPitDeath.input as string, 300);
const walls = plan(sectorBreachWallSlide.input as string, 200);

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aegis-breach-acceptance-'));
  artifacts =
    process.env['AEGIS_FPS_ARTIFACTS'] === undefined
      ? join(temporary, 'evidence')
      : resolve(process.env['AEGIS_FPS_ARTIFACTS']);
  mkdirSync(artifacts, { recursive: true });
  const game = (await pocGames()).find((entry) => entry.id === 'fps');
  assert.ok(game);
  dev = await startDevServer({ games: [{ ...game, seed: 'poc-fps' }], port: 0 });
  expect((await fetch(`${dev.url}/`)).status).toBe(200);
  const staticGame = (await pocStaticGames()).find((entry) => entry.id === 'fps');
  assert.ok(staticGame);
  const out = join(temporary, 'site');
  exportStaticSite({
    games: [{ ...staticGame, seed: 'poc-fps' }],
    modules: (await pocStaticModules()).filter((entry) => entry.specifier === '@aegis/game-fps'),
    outDir: out,
    repoRoot: process.cwd(),
  });
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
    '.wav': 'audio/wav',
    '.svg': 'image/svg+xml',
  };
  fileServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    if (request.method !== 'GET' || !path.startsWith(PREFIX)) {
      response.writeHead(404).end();
      return;
    }
    if (blocked.has(path)) {
      response.writeHead(503).end('Required asset deliberately unavailable');
      return;
    }
    const relative = decodeURIComponent(path.slice(PREFIX.length)) || 'index.html';
    const file = resolve(out, relative.endsWith('/') ? `${relative}index.html` : relative);
    if (!file.startsWith(out + sep)) {
      response.writeHead(403).end();
      return;
    }
    let exists = false;
    try {
      exists = statSync(file).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!exists) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    fileServer.once('error', fail);
    fileServer.listen(0, '127.0.0.1', done);
  });
  const address = fileServer.address();
  assert.ok(address !== null && typeof address !== 'string');
  staticUrl = `http://127.0.0.1:${address.port}${PREFIX}`;
  expect((await fetch(staticUrl)).status).toBe(200);
  browser = await launchBrowser({ viewport: VIEWPORT });
  const blank = await openPage(browser.port, 'about:blank', VIEWPORT);
  await waitForPaint(blank);
  await closeAllPages(browser.port);
}, 180_000);

afterAll(async () => {
  if (artifacts !== undefined)
    writeFileSync(
      join(artifacts, 'observations.json'),
      `${JSON.stringify(observations, null, 2)}\n`,
    );
  if (browser !== undefined) {
    await closeAllPages(browser.port);
    browser.process.kill();
  }
  await dev?.close();
  if (fileServer !== undefined)
    await new Promise<void>((done) => {
      fileServer.closeAllConnections();
      fileServer.close(() => done());
    });
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

type Transport = 'dev' | 'static';

async function sync(cdp: CdpSession): Promise<void> {
  await evaluate(cdp, 'globalThis.aegis.sync().then(() => null)');
  await evaluate(cdp, FRAME);
}

async function command(
  cdp: CdpSession,
  transport: Transport,
  cmd: 'pause' | 'restart' | 'step',
  ticks = 1,
): Promise<void> {
  if (transport === 'dev') {
    const response = await fetch(`${dev.url}/api/fps/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: cmd, ticks }),
    });
    expect(response.status).toBe(200);
  } else {
    // Only the session-step control is batched. All gameplay keys, aim and shots below use CDP.
    // This calls the ordinary keyboard command path, not the simulation or its private world.
    await evaluate(
      cdp,
      `(() => {
      const code = ${JSON.stringify(cmd === 'pause' ? 'KeyP' : cmd === 'restart' ? 'KeyR' : 'Period')};
      const count = ${cmd === 'step' ? ticks : 1};
      if (${JSON.stringify(cmd)} === 'pause' && globalThis.aegis.paused()) return;
      for (let i = 0; i < count; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', {code, bubbles:true}));
        window.dispatchEvent(new KeyboardEvent('keyup', {code, bubbles:true}));
      }
    })()`,
    );
  }
  await sync(cdp);
}

async function events(cdp: CdpSession, transport: Transport): Promise<EventLine[]> {
  if (transport === 'static') return evaluate(cdp, 'globalThis.aegis.events()');
  const response = await fetch(`${dev.url}/api/fps/events`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { events: EventLine[] }).events;
}

async function button(cdp: CdpSession, id: string): Promise<void> {
  await evaluate(cdp, 'document.exitPointerLock(); null');
  const center = await evaluate<{ x: number; y: number }>(
    cdp,
    `(() => {
    const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return {x:r.x+r.width/2, y:r.y+r.height/2};
  })()`,
  );
  await click(cdp, center.x, center.y);
  await evaluate(cdp, FRAME);
}

async function open(transport: Transport): Promise<CdpSession> {
  const url = transport === 'dev' ? `${dev.url}/play/fps/` : `${staticUrl}play/fps/`;
  const cdp = await openPage(browser.port, 'about:blank', VIEWPORT);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_OBSERVER });
  await cdp.send('Page.navigate', { url });
  await until(cdp, READY, (value) => value === true);
  await evaluate(
    cdp,
    `(() => {
    globalThis.__breachForegroundDraws = 0;
    const scene=globalThis.aegis.adapter.foreground?.scene;
    if(!scene) throw new Error('FPS foreground pass is not mounted');
    scene.traverse(mesh=>{
      if(!mesh.isMesh) return;
      const original=mesh.onAfterRender;
      mesh.onAfterRender=function(...args){
        globalThis.__breachForegroundDraws++;
        original.apply(this,args);
      };
    });
  })()`,
  );
  await command(cdp, transport, 'pause');
  return cdp;
}

async function reset(cdp: CdpSession, transport: Transport, input: DomInputPlan) {
  await command(cdp, transport, 'pause');
  for (const code of new Set(input.segments.flatMap((segment) => segment.keyDown)))
    await key(cdp, code, false);
  await mouseButton(cdp, false, 640, 360);
  await click(cdp, 640, 360);
  await until(cdp, 'document.pointerLockElement !== null', (value) => value === true);
  // The largest script yaw walk is negative X: start right of it, as capture.ts does.
  let dx = 0,
    minX = 0,
    dy = 0,
    minY = 0;
  for (const segment of input.segments) {
    dx += segment.mouse?.dx ?? 0;
    dy += segment.mouse?.dy ?? 0;
    minX = Math.min(minX, dx);
    minY = Math.min(minY, dy);
  }
  const cursor = { x: 8 - minX, y: 8 - minY };
  await mouseMove(cdp, cursor.x, cursor.y);
  await sync(cdp);
  await command(cdp, transport, 'restart');
  await until(cdp, 'globalThis.aegis.tick()', (tick) => tick === 0);
  return cursor;
}

async function capture(cdp: CdpSession, name: string): Promise<Reading> {
  await evaluate(cdp, FRAME);
  const state = await evaluate<Reading>(cdp, READ);
  expect(state.presentation.status).toBe('ready');
  await screenshot(cdp, join(artifacts, `${name}.png`));
  observations.push({ name, ...state });
  return state;
}

async function replay(
  cdp: CdpSession,
  transport: Transport,
  input: DomInputPlan,
  shots: ReadonlyMap<number, string> = new Map(),
) {
  const cursor = await reset(cdp, transport, input);
  if (shots.has(0)) await capture(cdp, `${transport}-${shots.get(0)}`);
  for (const segment of input.segments) {
    for (const code of segment.keyUp) await key(cdp, code, false);
    for (const code of segment.keyDown) await key(cdp, code, true);
    if (segment.buttonDown) await mouseButton(cdp, true, cursor.x, cursor.y);
    if (segment.buttonUp) await mouseButton(cdp, false, cursor.x, cursor.y);
    if (segment.mouse !== undefined) {
      cursor.x += segment.mouse.dx;
      cursor.y += segment.mouse.dy;
      await mouseMove(cdp, cursor.x, cursor.y);
    }
    await sync(cdp);
    const end = segment.tick + segment.ticks;
    const checkpoints = [...shots.keys()]
      .filter((tick) => tick > segment.tick && tick <= end)
      .sort((a, b) => a - b);
    let at = segment.tick;
    for (const target of [...new Set([...checkpoints, end])]) {
      await command(cdp, transport, 'step', target - at);
      expect(await evaluate(cdp, 'globalThis.aegis.tick()')).toBe(target);
      if (shots.has(target)) await capture(cdp, `${transport}-${shots.get(target)}`);
      at = target;
    }
  }
  for (const code of new Set(input.segments.flatMap((segment) => segment.keyDown)))
    await key(cdp, code, false);
  await mouseButton(cdp, false, cursor.x, cursor.y);
  await sync(cdp);
  return evaluate<Reading>(cdp, READ);
}

describe('Sector Breach complete browser showcase', () => {
  for (const transport of ['dev', 'static'] as const) {
    it(`${transport}: completes the original win, coolant-death and wall-slide routes with real gameplay input`, async () => {
      const cdp = await open(transport);
      try {
        const unlocked = await evaluate<Reading>(cdp, READ);
        expect(unlocked.presentation.assets.loadedFiles).toBe(13);
        expect(unlocked.presentation.assets.modelInstances).toBe(6);
        const result = await replay(
          cdp,
          transport,
          win,
          new Map([
            [0, 'start'],
            [21, 'panel'],
            [44, 'door'],
            [124, 'coolant'],
            [136, 'jump'],
            [177, 'combat'],
            [193, 'shutdown'],
            [241, 'extraction'],
            [600, 'win'],
          ]),
        );
        expect(result.hash).toBe('f86540b793f071a3');
        expect(result.player.Health.current).toBe(90);
        expect(result.grunt.Health.current).toBe(0);
        expect(result.door).toBeCloseTo(4.1, 5);
        expect(result.lock).toEqual([1, 1, 1]);
        expect(result.progress).toBe('3 / 3 complete');
        expect(result.outcome).toBe('Objective complete');
        const log = await events(cdp, transport);
        const count = (type: string) => log.filter((event) => event.type === type).length;
        expect(count('weapon.fired')).toBe(5);
        expect(count('enemy.damaged')).toBe(2);
        expect(count('damage.taken')).toBe(1);
        expect(count('level.completed')).toBe(1);
        expect(count('player.died')).toBe(0);
        expect(result.presentation.render.effects.active).toBe(0);
        expect(result.presentation.assets.modelInstances).toBe(6);
        expect(result.lights).toEqual({
          world: { all: 6, point: 4 },
          foreground: { all: 6, point: 4 },
        });
        expect(result.locked).toBe(true);
        expect(result.foregroundDraws).toBeGreaterThan(0);
        expect(result.presentation.audio.status).toBe('ready');
        if (result.timings !== undefined) {
          expect(result.timings.drawCalls).toBeGreaterThan(0);
          expect(result.timings.drawCalls).toBeLessThanOrEqual(2000);
          expect(result.timings.exchangeBytes).toBeLessThanOrEqual(24_000);
          expect(result.timings.exchangeErrors).toBe(0);
        }

        const dead = await replay(
          cdp,
          transport,
          loss,
          new Map([
            [147, 'pit-death'],
            [300, 'loss'],
          ]),
        );
        expect(dead.player.Dead).toBeDefined();
        expect(dead.player.Health.current).toBeLessThanOrEqual(0);
        expect(dead.outcome).toContain('Run ended');
        const lost = await events(cdp, transport);
        expect(lost.filter((event) => event.type === 'player.died')).toHaveLength(1);
        expect(lost.filter((event) => event.type === 'level.completed')).toHaveLength(0);
        expect(lost.find((event) => event.type === 'player.died')?.tick).toBe(146);
        const wall = await replay(cdp, transport, walls, new Map([[200, 'wall-slide']]));
        expect(wall.player.Transform.position.x).toBeLessThanOrEqual(4.100001);
        expect(wall.player.Transform.position.x).toBeGreaterThan(4.0292);
        expect(wall.player.Transform.position.z).toBeLessThanOrEqual(5.100001);
        expect(wall.player.Transform.position.z).toBeGreaterThan(5.0292);
        expect(wall.player.Health.current).toBe(100);
        expect(wall.presentation.assets.modelInstances).toBe(6);
        expect(wall.lights).toEqual(result.lights);

        if (transport === 'static') {
          const urls = await evaluate<string[]>(
            cdp,
            `performance.getEntriesByType('resource').map(r => r.name)`,
          );
          expect(urls.length).toBeGreaterThan(40);
          expect(urls.filter((url) => url.includes('/api/'))).toEqual([]);
          const origin = new URL(staticUrl).origin;
          expect(
            urls.filter((url) => url.startsWith(origin) && !url.startsWith(staticUrl)),
          ).toEqual([]);

          it(`${transport}: responds to locked look/fire, plays only live audio and keeps self-depth`, async () => {
            const cdp = await open(transport);
            try {
              const cursor = await reset(cdp, transport, win);
              const start = await evaluate<Reading>(cdp, READ);
              expect(start.presentation.audio.status).toBe('ready');
              await mouseMove(cdp, cursor.x + 30, cursor.y + 12);
              await sync(cdp);
              await command(cdp, transport, 'step');
              const looked = await evaluate<Reading>(cdp, READ);
              expect(looked.player.LookState.yawDeg).toBeCloseTo(
                30 * (BINDINGS.fps.lookDegreesPerPixel ?? 0.14) * (BINDINGS.fps.lookXSign ?? 1),
                5,
              );
              expect(looked.player.LookState.pitchDeg).toBeCloseTo(
                -12 * (BINDINGS.fps.lookDegreesPerPixel ?? 0.14),
                5,
              );
              expect(looked.locked).toBe(true);
              await mouseButton(cdp, true, cursor.x + 30, cursor.y + 12);
              await sync(cdp);
              await command(cdp, transport, 'step');
              const fired = await evaluate<Reading>(cdp, READ);
              expect(fired.player.LookState).toEqual(looked.player.LookState);
              expect(fired.camera).toEqual(looked.camera);
              const foreground = await evaluate<{ flash: number; recoil: number; depth: boolean }>(
                cdp,
                `(() => {
                const a=globalThis.aegis, f=a.adapter.foreground.scene;
                const weapon=a.adapter.presentation.object('weapon');
                let depth=true;
                weapon.object.traverse(m=>{
                  if(!m.isMesh) return;
                  for(const mat of Array.isArray(m.material)?m.material:[m.material])
                    depth=depth && mat.depthTest && mat.depthWrite && !mat.transparent;
                });
                return {flash:f.children.filter(n=>n.name.startsWith('effect:burst:')).length,
                  recoil:weapon.root.getObjectByName('presentation:effect').position.z,depth};
              })()`,
              );
              expect(foreground.flash).toBe(6);
              expect(foreground.recoil).toBeGreaterThan(0);
              expect(foreground.depth).toBe(true);
              await mouseButton(cdp, false, cursor.x + 30, cursor.y + 12);
              await sync(cdp);
              await command(cdp, transport, 'step', 12);
              const quiet = await evaluate<Reading>(cdp, READ);
              const priorStarts = quiet.audioStarts.length;
              await button(cdp, 'action-pause');
              await until(
                cdp,
                `globalThis.aegis.tick()`,
                (tick) => typeof tick === 'number' && tick > quiet.tick,
              );
              await until(
                cdp,
                `globalThis.__breachAudioStarts.length`,
                (count) => typeof count === 'number' && count > priorStarts,
              );
              const resumed = await evaluate<Reading>(cdp, READ);
              expect(resumed.audioStarts.slice(priorStarts).every((voice) => voice.loop)).toBe(
                true,
              );
              await click(cdp, 640, 360);
              await until(
                cdp,
                `globalThis.__breachAudioStarts.some(voice=>!voice.loop && Math.abs(voice.seconds-.28)<.001)`,
                (value) => value === true,
              );
              await button(cdp, 'action-mute');
              const muted = await evaluate<Reading>(cdp, READ);
              expect(muted.presentation.audio.muted).toBe(true);
              expect(muted.presentation.audio.voices).toBe(0);
              await button(cdp, 'action-mute');
              await until(
                cdp,
                `globalThis.aegis.presentation().audio.voices`,
                (count) => count === 1,
              );
              const unmuted = await evaluate<Reading>(cdp, READ);
              expect(
                unmuted.audioStarts.slice(muted.audioStarts.length).every((voice) => voice.loop),
              ).toBe(true);
              await command(cdp, transport, 'pause');
              observations.push({
                name: `${transport}-live-input-audio`,
                looked,
                fired,
                foreground,
                muted,
                unmuted,
              });
              expect(unmuted.presentation.assets.modelInstances).toBe(6);
              expect(unmuted.foregroundDraws).toBeGreaterThan(0);
              if (transport === 'static') {
                await evaluate(cdp, `window.dispatchEvent(new Event('beforeunload')); null`);
                const disposed = await evaluate<Reading['presentation']>(
                  cdp,
                  'globalThis.aegis.presentation()',
                );
                expect(disposed.status).toBe('disposed');
                expect(disposed.assets.modelInstances).toBe(0);
                expect(disposed.assets.loadedFiles).toBe(0);
                expect(disposed.audio.voices).toBe(0);
              }
            } finally {
              cdp.close();
              await closeAllPages(browser.port);
            }
          }, 150_000);
        }
      } finally {
        cdp.close();
        await closeAllPages(browser.port);
      }
    }, 240_000);
  }

  it('restores the open dev door and HUD on reload without old audio, then restarts cleanly', async () => {
    const cdp = await open('dev');
    try {
      const result = await replay(cdp, 'dev', win);
      expect(result.progress).toBe('3 / 3 complete');
      const origin = await evaluate<number>(cdp, 'performance.timeOrigin');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until(
        cdp,
        `performance.timeOrigin !== ${origin} && ${READY}`,
        (value) => value === true,
      );
      await sync(cdp);
      const reload = await capture(cdp, 'dev-reload');
      expect(reload.hash).toBe('f86540b793f071a3');
      expect(reload.door).toBeCloseTo(4.1, 5);
      expect(reload.progress).toBe('3 / 3 complete');
      expect(reload.presentation.audio.status).toBe('locked');
      expect(reload.presentation.audio.voices).toBe(0);
      expect(reload.presentation.audio.dropped).toBe(0);
      await button(cdp, 'action-mute');
      await until(
        cdp,
        `globalThis.aegis.presentation().audio.status`,
        (value) => value === 'ready',
      );
      expect((await evaluate<Reading>(cdp, READ)).presentation.audio.voices).toBe(0);
      await button(cdp, 'action-mute');
      expect((await evaluate<Reading>(cdp, READ)).presentation.audio.muted).toBe(true);
      await button(cdp, 'action-mute');
      expect((await evaluate<Reading>(cdp, READ)).presentation.audio.muted).toBe(false);
      await button(cdp, 'action-restart');
      await until(cdp, 'globalThis.aegis.tick()', (tick) => tick === 0);
      await sync(cdp);
      const restarted = await evaluate<Reading>(cdp, READ);
      expect(restarted.door).toBe(0);
      expect(restarted.lock).toEqual([0, 0, 0]);
      expect(restarted.progress).toBe('0 / 3 complete');
      expect(restarted.presentation.assets).toEqual(result.presentation.assets);
      expect(restarted.lights).toEqual(result.lights);
      expect(restarted.presentation.audio.voices).toBe(0);
      await evaluate(cdp, `window.dispatchEvent(new Event('beforeunload')); null`);
      const disposed = await evaluate<{
        status: string;
        assets: Reading['presentation']['assets'];
      }>(cdp, 'globalThis.aegis.presentation()');
      expect(disposed.status).toBe('disposed');
      expect(disposed.assets).toEqual({
        loadedFiles: 0,
        modelInstances: 0,
        textures: 0,
        geometries: 0,
        materials: 0,
        audioBytes: 0,
      });
    } finally {
      cdp.close();
      await closeAllPages(browser.port);
    }
  }, 240_000);

  it('keeps narrow-screen aim readable and refuses a missing required rifle before retrying', async () => {
    const asset = `${PREFIX}assets/fps/vaultline-rifle.glb`;
    blocked.add(asset);
    const cdp = await openPage(browser.port, `${staticUrl}play/fps/`, { width: 640, height: 720 });
    try {
      await until(
        cdp,
        `document.getElementById('loading-panel')?.dataset.state`,
        (state) => state === 'error',
      );
      const message = await evaluate<string>(
        cdp,
        `document.getElementById('loading-message').textContent`,
      );
      expect(message).toContain('rifle');
      await screenshot(cdp, join(artifacts, 'static-required-asset-error.png'));
      blocked.delete(asset);
      await button(cdp, 'action-retry');
      await until(cdp, READY, (value) => value === true);
      await command(cdp, 'static', 'pause');
      await capture(cdp, 'static-narrow');
      const layout = (await evaluate(
        cdp,
        `(() => {
        const a=globalThis.aegis, canvas=document.getElementById('stage').getBoundingClientRect();
        const weapon=a.adapter.presentation.object('weapon').object;
        const points=[];
        weapon.updateWorldMatrix(true,true);
        weapon.traverse(m=>{
          if(!m.isMesh) return;
          const p=m.geometry.getAttribute('position');
          for(let i=0;i<p.count;i++){
            const v=m.position.clone().fromBufferAttribute(p,i).applyMatrix4(m.matrixWorld).applyMatrix4(a.adapter.camera.matrixWorldInverse);
            points.push([v.x,v.y,v.z]);
          }
        });
        return {scroll:document.documentElement.scrollWidth,width:innerWidth,aspect:a.adapter.camera.aspect,
          canvas:[canvas.width,canvas.height],highest:Math.max(...points.map(p=>p[1])),nearest:Math.max(...points.map(p=>p[2]))};
      })()`,
      )) as {
        scroll: number;
        width: number;
        aspect: number;
        canvas: number[];
        highest: number;
        nearest: number;
      };
      expect(layout.scroll).toBeLessThanOrEqual(layout.width);
      expect(layout.highest).toBeLessThan(-0.07);
      expect(layout.nearest).toBeLessThan(-0.1);
      expect(layout.aspect).toBeCloseTo(layout.canvas[0]! / layout.canvas[1]!, 5);
    } finally {
      blocked.delete(asset);
      cdp.close();
      await closeAllPages(browser.port);
    }
  }, 180_000);
});

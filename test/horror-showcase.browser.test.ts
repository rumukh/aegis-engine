import assert from 'node:assert/strict';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseInputScript } from '@aegis/harness';
import { CAUGHT_ROUTE, POWER_ROUTE, WIN_ROUTE, WIN_TICKS } from '../games/horror/src/routes.js';
import { horrorBindings } from '../poc/horror.mjs';
import { pocGames, pocStaticGames, pocStaticModules } from '../poc/poc-games.mjs';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import type { DevServer } from '../packages/render-three/src/dev-server.js';
import { exportStaticSite } from '../packages/render-three/src/static-site.js';
import { compileDomInput } from '../packages/render-three/src/script-input.js';
import type { DomInputPlan } from '../packages/render-three/src/script-input.js';
import {
  click,
  evaluate,
  key,
  launchBrowser,
  mouseButton,
  mouseMove,
  openPage,
  screenshot,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { navigateAndWait } from '../packages/render-three/src/browser-navigation.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { closeHorrorPage, reportHorrorFailure } from './support/horror-failure-context.js';
import {
  gamepadFrames,
  installVirtualPad,
  setPad,
} from '../packages/render-three/src/testing/gamepad-browser.js';

// Software CI correctness uses a bounded canvas. RTX 1440p performance is measured separately.
const HARDWARE = process.env['AEGIS_HORROR_HARDWARE'] === '1';
const MEASURE_PURSUIT = process.env['AEGIS_HORROR_MEASURE_PURSUIT'] === '1';
const VIEWPORT = HARDWARE ? { width: 2560, height: 1440 } : { width: 960, height: 540 };
const ARTIFACTS = process.env['AEGIS_HORROR_ARTIFACTS'];
const SHOTS = new Map([
  [2478, 'power'],
  [3812, 'medical'],
  [4819, 'archive'],
  [5038, 'cover-contact'],
  [6901, 'observation'],
  [8154, 'extraction'],
]);
const parsed = parseInputScript(WIN_ROUTE);
assert.ok(parsed.ok && parsed.value);
// The terminal UI blocks further keyboard stepping after the win at8153. The canonical
// headless8217 proof remains unchanged; its final63 frames contain no active gameplay input.
const BROWSER_WIN_TICKS = 8154;
const winFrames = parsed.value.frames(WIN_TICKS);
assert.equal(WIN_TICKS, 8217);
assert.ok(
  winFrames
    .slice(BROWSER_WIN_TICKS)
    .every(
      (frame) =>
        !Object.values(frame.actions).some(Boolean) &&
        !Object.values(frame.axes).some((value) => value !== 0) &&
        frame.look.dx === 0 &&
        frame.look.dy === 0 &&
        frame.pointer === null,
    ),
);
const plan = compileDomInput(winFrames.slice(0, BROWSER_WIN_TICKS), horrorBindings);
const caught = parseInputScript(CAUGHT_ROUTE);
assert.ok(caught.ok && caught.value);
const threatApproach = compileDomInput(caught.value.frames(3140), horrorBindings);
const powerInput = parseInputScript(POWER_ROUTE);
assert.ok(powerInput.ok && powerInput.value);
const powerApproach = compileDomInput(powerInput.value.frames(2379), horrorBindings);
type Transport = 'live' | 'static';
let temporary: string;
let dev: DevServer;
let files: Server;
let staticUrl: string;
let browser: LaunchedBrowser | undefined;

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aegis-horror-'));
  const game = (await pocGames()).find((entry) => entry.id === 'horror');
  const staticGame = (await pocStaticGames()).find((entry) => entry.id === 'horror');
  assert.ok(game && staticGame);
  dev = await startDevServer({
    port: 0,
    games: [
      {
        ...game,
        presentation: {
          ...game.presentation,
          manifest: { ...game.presentation.manifest, quality: HARDWARE ? 'high' : 'low' },
        },
      },
    ],
  });
  const site = exportStaticSite({
    games: [
      {
        ...staticGame,
        presentation: {
          ...staticGame.presentation,
          manifest: { ...staticGame.presentation.manifest, quality: HARDWARE ? 'high' : 'low' },
        },
      },
    ],
    modules: (await pocStaticModules()).filter(
      (module) => module.specifier === '@aegis/game-horror',
    ),
    outDir: join(temporary, 'site'),
    repoRoot: process.cwd(),
  });
  const table = new Map(
    site.files.map((file) => [
      `/review/${file.replaceAll('\\', '/')}`,
      join(site.outDir, ...file.split(/[\\/]/)),
    ]),
  );
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.glb': 'model/gltf-binary',
    '.ogg': 'audio/ogg',
  };
  files = createServer((request, response) => {
    let path = new URL(request.url ?? '/', 'http://local').pathname;
    if (path.endsWith('/')) path += 'index.html';
    const file = table.get(path);
    if (request.method !== 'GET' || file === undefined) {
      response.writeHead(404).end('Not part of the exported artifact');
      return;
    }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    files.once('error', reject);
    files.listen(0, '127.0.0.1', resolve);
  });
  const address = files.address();
  assert.ok(address !== null && typeof address !== 'string');
  staticUrl = `http://127.0.0.1:${address.port}/review`;
  expect((await fetch(`${dev.url}/play/horror/`)).status).toBe(200);
  expect((await fetch(`${staticUrl}/play/horror/`)).status).toBe(200);
}, 180_000);

beforeEach(async () => {
  browser = await launchBrowser({
    viewport: VIEWPORT,
    graphics: HARDWARE ? 'hardware' : 'software',
  });
});
afterEach(async () => {
  const owned = browser;
  browser = undefined;
  if (owned === undefined) return;
  try {
    await closeOwnedBrowser(owned);
  } finally {
    rmSync(owned.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
afterAll(async () => {
  stopExternalLagWitness();
  await dev?.close();
  if (files !== undefined) {
    files.closeAllConnections();
    await new Promise<void>((resolve) => files.close(() => resolve()));
  }
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

async function sync(page: CdpSession): Promise<void> {
  await evaluate(page, 'globalThis.aegis.sync().then(()=>null)');
}

async function clickUi(page: CdpSession, id: string): Promise<void> {
  const point = await evaluate<{ x: number; y: number }>(
    page,
    `(() => {
      const button=document.getElementById(${JSON.stringify(id)});
      if(!button?.checkVisibility())throw new Error('Required ending button is not visible');
      const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`,
  );
  await click(page, point.x, point.y);
}

async function diagnoseFailure(
  page: CdpSession,
  transport: Transport,
  route: string,
  error: unknown,
): Promise<void> {
  await reportHorrorFailure(error, {
    label: `${transport}: ${route}`,
    page,
    ...(transport === 'static'
      ? {}
      : {
          authoritative: () => {
            const session = dev.session('horror');
            if (session === undefined) throw new Error('The live horror session is unavailable.');
            return {
              snapshot: session.snapshot(),
              events: session.world.events.history(),
              observations: {
                tick: session.tick,
                paused: session.paused,
                hash: session.hash(),
              },
            };
          },
        }),
  });
}

async function capture(page: CdpSession, name: string): Promise<void> {
  if (ARTIFACTS === undefined) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  await sync(page);
  await evaluate(
    page,
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))',
  );
  const state = await evaluate(
    page,
    `(() => {
    const a=globalThis.aegis,canvas=document.getElementById('stage'),gl=canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {tick:a.tick(),world:a.world.snapshot(),presentation:a.presentation(),timings:a.timings?.(),canvas:[canvas.width,canvas.height],renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
  })()`,
  );
  writeFileSync(join(ARTIFACTS, `${name}.json`), JSON.stringify(state, null, 2));
  await screenshot(page, join(ARTIFACTS, `${name}.png`));
}

async function control(
  page: CdpSession,
  transport: Transport,
  command: 'pause' | 'resume' | 'restart' | 'step',
  ticks = 1,
): Promise<void> {
  if (transport === 'live') {
    const response = await fetch(`${dev.url}/api/horror/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, ticks }),
    });
    expect(response.ok).toBe(true);
  } else {
    await evaluate(
      page,
      `(() => {
      const code=${JSON.stringify(command === 'pause' || command === 'resume' ? 'KeyP' : command === 'restart' ? 'KeyR' : 'Period')};
      if (${JSON.stringify(command)}==='pause' && globalThis.aegis.paused()) return;
      if (${JSON.stringify(command)}==='resume' && !globalThis.aegis.paused()) return;
      for(let i=0;i<${command === 'step' ? ticks : 1};i++){
        window.dispatchEvent(new KeyboardEvent('keydown',{code,bubbles:true}));
        window.dispatchEvent(new KeyboardEvent('keyup',{code,bubbles:true}));
      }
    })()`,
    );
  }
  if (command !== 'step') await sync(page);
}

async function drive(
  page: CdpSession,
  transport: Transport,
  input: DomInputPlan,
  cursor: { x: number; y: number },
  shots: ReadonlyMap<number, string> = new Map(),
): Promise<void> {
  let lastMilestone = -1;
  for (const segment of input.segments) {
    // The world is paused: collect one complete hardware packet, then verify the prior
    // step's mirror before advancing. A second post-step paint barrier adds no coverage.
    const inputs: Promise<void>[] = [];
    for (const code of segment.keyUp) inputs.push(key(page, code, false));
    for (const code of segment.keyDown) inputs.push(key(page, code, true));
    if (segment.mouse !== undefined) {
      cursor.x += segment.mouse.dx;
      cursor.y += segment.mouse.dy;
      inputs.push(mouseMove(page, cursor.x, cursor.y));
    }
    await Promise.all(inputs);
    await sync(page);
    expect(await evaluate(page, 'globalThis.aegis.tick()')).toBe(segment.tick);
    const end = segment.tick + segment.ticks;
    const captures =
      ARTIFACTS === undefined
        ? []
        : [...shots.keys()].filter((tick) => tick > segment.tick && tick <= end);
    let current = segment.tick;
    for (const target of [...new Set([...captures, end])]) {
      await control(page, transport, 'step', target - current);
      current = target;
      if (ARTIFACTS !== undefined && shots.has(target))
        await capture(page, `${transport}-${shots.get(target)}`);
    }
    const milestone = Math.floor(end / 2000);
    if (milestone !== lastMilestone) {
      lastMilestone = milestone;
      console.info(`[horror ${transport}] tick ${end}`);
    }
  }
  await sync(page);
}

async function padSample(
  page: CdpSession,
  axes = [0, 0, 0, 0],
  buttons: number[] = [],
): Promise<void> {
  await setPad(page, axes, buttons);
  await gamepadFrames(page, 2);
  await sync(page);
}

async function controllerProof(page: CdpSession, cursor: { x: number; y: number }): Promise<void> {
  const player = "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='player').components";
  await installVirtualPad(page);
  await padSample(page, [0, 0, 0, 0], [3]);
  await control(page, 'static', 'restart');
  await control(page, 'static', 'resume');
  const started = await evaluate<number>(page, 'globalThis.aegis.tick()');
  await until<number>(page, 'globalThis.aegis.tick()', (tick) => tick >= started + 6);
  expect(await evaluate(page, `${player}.HorrorPlayer.flashlight`)).toBe(true);
  await padSample(page);
  await padSample(page, [0, 0, 0, 0], [3]);
  await until(page, `${player}.HorrorPlayer.flashlight`, (value) => value === false);
  await padSample(page);
  await padSample(page, [0, 0, 0, 0], [1]);
  await until(page, `${player}.FpsCamera.eyeHeight`, (value) => value === 1.05);
  await padSample(page);
  await until(page, `${player}.FpsCamera.eyeHeight`, (value) => value === 1.62);
  const before = await evaluate<number>(page, `${player}.Transform.position.z`);
  await padSample(page, [0, -1, 0, 0], [4]);
  await until(page, `${player}.FpsController.moveSpeed`, (value) => value === 3.8);
  await until<number>(page, `${player}.Transform.position.z`, (z) => z > before + 0.05);
  await padSample(page);
  await padSample(page, [0, 0, -0.5, 0]);
  await until<number>(page, `${player}.LookState.yawDeg`, (yaw) => yaw > 1);
  await padSample(page);
  await control(page, 'static', 'pause');
  await control(page, 'static', 'restart');

  // Controller gameplay is intentionally disabled during pause; reach the console with
  // exact keyboard steps, then test X selection and A hold in actual running simulation.
  await drive(page, 'static', powerApproach, cursor);
  await control(page, 'static', 'resume');
  await padSample(page);
  for (let press = 0; press < 2; press++) {
    await padSample(page, [0, 0, 0, 0], [2]);
    await padSample(page);
  }
  expect(
    await evaluate(
      page,
      "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='power-console').components.HorrorInteractable.selection",
    ),
  ).toBe(2);
  await padSample(page, [0, 0, 0, 0], [0]);
  await until(
    page,
    "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='mission').components.HorrorMission.power",
    (value) => value === true,
  );
  await padSample(page);
  await padSample(page, [0, 0, 0, 0], [9]);
  await padSample(page);
  await until(page, 'globalThis.aegis.paused()', (value) => value === true);
  await padSample(page, [0, 0, 0, 0], [8]);
  await padSample(page);
  await until(page, 'globalThis.aegis.tick()', (value) => value === 0);
  expect(await evaluate(page, 'globalThis.aegis.paused()')).toBe(true);
}

async function keyboardCrouchProof(page: CdpSession): Promise<void> {
  const player = "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='player').components";
  await key(page, 'KeyC', true);
  await key(page, 'KeyW', true);
  await until(page, `${player}.FpsController.moveSpeed`, (speed) => speed === 1.1);
  expect(await evaluate(page, `${player}.FpsCamera.eyeHeight`)).toBe(1.05);
  const crouchedAt = await evaluate<number>(page, `${player}.Transform.position.z`);
  await until<number>(page, `${player}.Transform.position.z`, (z) => z > crouchedAt + 0.1);
  await key(page, 'KeyC', false);
  await until(page, `${player}.FpsController.moveSpeed`, (speed) => speed === 2);
  expect(await evaluate(page, `${player}.FpsCamera.eyeHeight`)).toBe(1.62);
  const walkingAt = await evaluate<number>(page, `${player}.Transform.position.z`);
  await until<number>(page, `${player}.Transform.position.z`, (z) => z > walkingAt + 0.1);
  await key(page, 'KeyW', false);
  await sync(page);
  await evaluate(page, 'document.exitPointerLock(); null');
  await until(page, 'document.pointerLockElement === null', Boolean);
  await evaluate(page, "document.querySelector('#controls summary').focus(); null");
  expect(await evaluate(page, 'document.activeElement.tagName')).toBe('SUMMARY');
  const before = await evaluate<{ tick: number; position: object }>(
    page,
    `({tick:globalThis.aegis.tick(),position:${player}.Transform.position})`,
  );
  await key(page, 'KeyC', true);
  await key(page, 'KeyW', true);
  await until<number>(page, 'globalThis.aegis.tick()', (tick) => tick >= before.tick + 12);
  expect(await evaluate(page, `${player}.Transform.position`)).toEqual(before.position);
  expect(await evaluate(page, `${player}.HorrorPlayer.crouched`)).toBe(false);
  await key(page, 'KeyC', false);
  await key(page, 'KeyW', false);
  await click(page, 480, 350);
  await until(page, 'document.pointerLockElement !== null', Boolean);
  await mouseMove(page, 2000, 400);
  await sync(page);
}

describe('NULL MERIDIAN real browser mission', () => {
  for (const transport of ['live', 'static'] as const) {
    it(`${transport}: completes the exact DOM route and plays unpaused ambience and action cues`, async () => {
      assert.ok(browser);
      const page = await openPage(browser.port, 'about:blank', VIEWPORT);
      await page.send('Emulation.setDeviceMetricsOverride', {
        ...VIEWPORT,
        deviceScaleFactor: HARDWARE ? 1 : 0.5,
        mobile: false,
      });
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `globalThis.__horrorAudio=[];const original=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args){const result=original.apply(this,args);globalThis.__horrorAudio.push({loop:this.loop,duration:this.buffer?.duration});return result;};`,
      });
      let failed = false;
      try {
        await navigateAndWait(page, () =>
          page.send('Page.navigate', {
            url: `${transport === 'live' ? dev.url : staticUrl}/play/horror/`,
          }),
        );
        await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
        await control(page, transport, 'pause');
        await control(page, transport, 'restart');
        await until(
          page,
          'globalThis.aegis.presentation().input.capture.gameplayBlocked',
          (blocked) => blocked === false,
          5000,
        );
        await click(page, 480, 350);
        await mouseButton(page, false, 480, 350);
        await until(page, 'document.pointerLockElement !== null', (value) => value === true);
        let x = 2000;
        let y = 400;
        await mouseMove(page, x, y);
        await sync(page);
        await control(page, transport, 'restart');
        expect(await evaluate(page, 'globalThis.aegis.tick()')).toBe(0);
        const initial = await evaluate<{
          status: string;
          assets: { loadedFiles: number };
          audio: { status: string };
        }>(page, 'globalThis.aegis.presentation()');
        expect(initial.assets.loadedFiles).toBe(76);
        expect(initial.audio.status).not.toBe('unavailable');
        await control(page, transport, 'resume');
        await until(
          page,
          'globalThis.__horrorAudio.filter(source=>source.loop).length',
          (count) => Number(count) >= 2,
        );
        await key(page, 'KeyF', true);
        await sync(page);
        await key(page, 'KeyF', false);
        await key(page, 'KeyW', true);
        const movingSince = await evaluate<number>(page, 'globalThis.aegis.tick()');
        await until<number>(page, 'globalThis.aegis.tick()', (tick) => tick >= movingSince + 45);
        await key(page, 'KeyW', false);
        await sync(page);
        await until<number>(page, 'globalThis.__horrorAudio.length', (count) => count >= 4);
        await keyboardCrouchProof(page);
        await control(page, transport, 'pause');
        // Input delivery is not a presentation fence: live audio observes pause on the next frame.
        await until<number>(
          page,
          'globalThis.aegis.presentation().audio.voices',
          (voices) => voices === 0,
          5000,
        );
        expect(await evaluate(page, 'globalThis.aegis.presentation().audio.voices')).toBe(0);
        await control(page, transport, 'restart');
        await capture(page, `${transport}-spawn`);
        if (ARTIFACTS !== undefined) {
          x += 320;
          await mouseMove(page, x, y);
          await sync(page);
          await control(page, transport, 'step');
          await capture(page, `${transport}-spawn-side`);
          await control(page, transport, 'restart');
        }
        if (transport === 'static') {
          const cursor = { x, y };
          await controllerProof(page, cursor);
          x = cursor.x;
          y = cursor.y;
        }
        console.info(
          `[horror ${transport}] assets ready; starting ${plan.segments.length} exact input segments`,
        );
        await drive(page, transport, plan, { x, y }, SHOTS);
        await key(page, 'KeyE', false);
        await sync(page);
        expect(await evaluate(page, 'globalThis.aegis.tick()')).toBe(BROWSER_WIN_TICKS);
        const result = await evaluate<{
          hash: string;
          mission: { escaped: boolean; dead: boolean; completedTick: number };
          health: number;
          status: string;
          audio: object[];
          pipeline: { width: number; height: number };
          lossActive: boolean;
          winEnding: { active: boolean; phase: string; seconds: number };
          gameplayBlocked: boolean;
          modal: boolean;
          focused: string;
          pointerLocked: boolean;
        }>(
          page,
          `(() => {
          const a=globalThis.aegis,s=a.world.snapshot(),presentation=a.presentation();
          return {hash:a.world.hash(),mission:s.entities.find(e=>e.name==='mission').components.HorrorMission,health:s.entities.find(e=>e.name==='player').components.Health.current,status:presentation.status,audio:globalThis.__horrorAudio,pipeline:presentation.pipeline,lossActive:presentation.ending.active,winEnding:presentation.winEnding,gameplayBlocked:presentation.input.capture.gameplayBlocked,modal:document.getElementById('win-ending').open,focused:document.activeElement.id,pointerLocked:document.pointerLockElement!==null};
        })()`,
        );
        // Captured independently from unchanged headless framesFromPlan at8154, not this page.
        expect(result.hash).toBe('7fd891b93e339fd8');
        expect(result.mission).toMatchObject({
          arrived: true,
          fuse: true,
          service: true,
          busIsolated: true,
          power: true,
          visitorToken: true,
          recorder: true,
          coolant: true,
          uplink: true,
          escaped: true,
          dead: false,
          completedTick: 8153,
          evidence: 3,
        });
        expect(result.health).toBe(100);
        const events =
          transport === 'live'
            ? dev.session('horror')?.world.events.history()
            : await evaluate<{ type: string; tick: number }[]>(page, 'globalThis.aegis.events()');
        assert.ok(events);
        expect(
          events.filter((event) => event.type === 'level.completed').map((event) => event.tick),
        ).toEqual([8153]);
        expect(events.some((event) => event.type === 'player.died')).toBe(false);
        expect(result.status).toBe('ready');
        expect(result.lossActive).toBe(false);
        expect(result.audio.length).toBeGreaterThanOrEqual(4);
        expect(result.winEnding).toMatchObject({ active: true, phase: 'playing', seconds: 0 });
        expect(result.gameplayBlocked).toBe(true);
        expect(result.modal).toBe(true);
        expect(result.focused).toBe('win-skip');
        expect(result.pointerLocked).toBe(false);
        expect(result.pipeline.width * result.pipeline.height).toBeLessThanOrEqual(
          HARDWARE ? 3686400 : 921600,
        );
        expect(result.pipeline.width).toBe(HARDWARE ? 2560 : 480);
        expect(result.pipeline.height).toBe(HARDWARE ? 1440 : 270);

        for (const code of ['KeyW', 'KeyF', 'Period']) await key(page, code, true);
        for (const code of ['KeyW', 'KeyF', 'Period']) await key(page, code, false);
        await sync(page);
        expect(await evaluate(page, 'globalThis.aegis.tick()')).toBe(BROWSER_WIN_TICKS);
        expect(await evaluate(page, 'globalThis.aegis.world.hash()')).toBe(result.hash);

        await clickUi(page, 'win-skip');
        await until(
          page,
          'globalThis.aegis.presentation().winEnding.phase',
          (phase) => phase === 'shown',
          5000,
        );
        const finalCard = await evaluate<{
          title: string;
          titleVisible: boolean;
          restartVisible: boolean;
          focused: string;
          gameplayBlocked: boolean;
        }>(
          page,
          `(() => {
          const title=document.getElementById('win-title'),r=title.getBoundingClientRect();
          return {title:title.textContent,titleVisible:title.checkVisibility()&&r.top>=0&&r.bottom<=innerHeight,restartVisible:document.getElementById('win-restart').checkVisibility(),focused:document.activeElement.id,gameplayBlocked:globalThis.aegis.presentation().input.capture.gameplayBlocked};
        })()`,
        );
        expect(finalCard).toEqual({
          title: 'CLEAR OF NULL MERIDIAN',
          titleVisible: true,
          restartVisible: true,
          focused: 'win-restart',
          gameplayBlocked: true,
        });
        expect(await evaluate(page, 'globalThis.aegis.world.hash()')).toBe(result.hash);
        await clickUi(page, 'win-restart');
        await until(page, 'globalThis.aegis.tick()', (tick) => tick === 0, 10000);
        await until(
          page,
          'globalThis.aegis.presentation().winEnding.active',
          (active) => active === false,
          5000,
        );
        expect(
          await evaluate(page, 'globalThis.aegis.presentation().input.capture.gameplayBlocked'),
        ).toBe(false);
        expect(await evaluate(page, 'document.activeElement.id')).toBe('stage');
        expect(
          await evaluate(
            page,
            "globalThis.aegis.world.query({has:['HorrorMission']}).one().get('HorrorMission').escaped",
          ),
        ).toBe(false);
        expect(
          await evaluate(
            page,
            "globalThis.aegis.world.query({has:['Health']}).one().get('Health').current",
          ),
        ).toBe(100);
      } catch (error) {
        failed = true;
        await diagnoseFailure(page, transport, 'win route', error);
        throw error;
      } finally {
        await closeHorrorPage(page, failed);
      }
    }, 300_000);
  }

  for (const transport of ['live', 'static'] as const) {
    it(`${transport}: the visible responder catches the visitor and shows an accessible restart ending`, async () => {
      assert.ok(browser);
      const page = await openPage(browser.port, 'about:blank', VIEWPORT);
      let failed = false;
      try {
        await page.send('Emulation.setEmulatedMedia', {
          features: [
            {
              name: 'prefers-reduced-motion',
              value: transport === 'static' ? 'reduce' : 'no-preference',
            },
          ],
        });
        await page.send('Emulation.setDeviceMetricsOverride', {
          ...VIEWPORT,
          deviceScaleFactor: HARDWARE ? 1 : 0.5,
          mobile: false,
        });
        await navigateAndWait(page, () =>
          page.send('Page.navigate', {
            url: `${transport === 'live' ? dev.url : staticUrl}/play/horror/`,
          }),
        );
        await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
        await control(page, transport, 'pause');
        await control(page, transport, 'restart');
        await until(
          page,
          'globalThis.aegis.presentation().input.capture.gameplayBlocked',
          (blocked) => blocked === false,
          5000,
        );
        await click(page, 480, 350);
        await mouseButton(page, false, 480, 350);
        await until(page, 'document.pointerLockElement !== null', (value) => value === true);
        await mouseMove(page, 2000, 400);
        await sync(page);
        await control(page, transport, 'restart');
        await drive(page, transport, threatApproach, { x: 2000, y: 400 });
        const view = await evaluate<{
          hash: string;
          distance: number;
          screen: { x: number; y: number } | null;
          flashlight: boolean;
          visible: boolean;
          look: { yawDeg: number; pitchDeg: number };
        }>(
          page,
          `(() => {
        const a=globalThis.aegis,s=a.world.snapshot(),p=s.entities.find(e=>e.name==='player').components,t=s.entities.find(e=>e.name==='responder').components.Transform.position;
        const q=p.Transform.position;
        return {hash:a.world.hash(),distance:Math.hypot(q.x-t.x,q.z-t.z),screen:a.project(t.x,t.y+1.3,t.z),flashlight:p.HorrorPlayer.flashlight,visible:a.adapter.presentation.entity('responder').root.visible,look:p.LookState};
      })()`,
        );
        // Headless framesFromPlan prefix at 3140, pinned before this pass. Whole mouse pixels
        // quantize yaw to 90.02 degrees; the unquantized DSL has a different, valid hash.
        expect(view.hash).toBe('c6acff7586fa43ab');
        expect(view.distance).toBeGreaterThan(2);
        expect(view.distance).toBeLessThan(5);
        expect(view.flashlight).toBe(true);
        expect(view.visible).toBe(true);
        assert.ok(view.screen);
        expect(view.screen.x).toBeGreaterThan(VIEWPORT.width * 0.15);
        expect(view.screen.x).toBeLessThan(VIEWPORT.width * 0.85);
        expect(view.screen.y).toBeGreaterThan(0);
        expect(view.screen.y).toBeLessThan(VIEWPORT.height);
        await capture(page, `${transport}-responder-visible`);
        await key(page, 'KeyW', false);
        await sync(page);
        if (transport === 'live' && HARDWARE && ARTIFACTS !== undefined && MEASURE_PURSUIT) {
          await control(page, transport, 'resume');
          await key(page, 'ShiftLeft', true);
          await key(page, 'KeyS', true);
          await sync(page);
          const performance = await evaluate<{
            frames: number;
            elapsedMs: number;
            meanMs: number;
            p50Ms: number;
            p95Ms: number;
            p99Ms: number;
            startTick: number;
            endTick: number;
            health: number;
            startPosition: { x: number; y: number; z: number };
            endPosition: { x: number; y: number; z: number };
            backing: number[];
            renderer: string;
            status: string;
            presentation: object;
          }>(
            page,
            `new Promise(resolve=>{
          const a=globalThis.aegis,gaps=[],started=performance.now(),startTick=a.tick(),startPosition=a.world.snapshot().entities.find(e=>e.name==='player').components.Transform.position;
          let last=started,active=true;
          a.resetTimings();
          function frame(t){if(!active)return;gaps.push(t-last);last=t;requestAnimationFrame(frame)}
          requestAnimationFrame(frame);
          setTimeout(()=>{active=false;const elapsedMs=performance.now()-started,sorted=[...gaps].sort((x,y)=>x-y),at=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
            const canvas=document.getElementById('stage'),gl=canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
            const player=a.world.snapshot().entities.find(e=>e.name==='player').components;
            resolve({frames:gaps.length,elapsedMs,meanMs:gaps.reduce((x,y)=>x+y,0)/gaps.length,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),startTick,endTick:a.tick(),health:player.Health.current,startPosition,endPosition:player.Transform.position,backing:[canvas.width,canvas.height],renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),status:a.presentation().status,presentation:a.presentation()});
          },4000);
        })`,
          );
          await key(page, 'KeyS', false);
          await key(page, 'ShiftLeft', false);
          await control(page, transport, 'pause');
          expect(performance.frames).toBeGreaterThan(1);
          expect(Number.isFinite(performance.meanMs)).toBe(true);
          expect(performance.status).toBe('ready');
          expect(performance.renderer).not.toMatch(/swiftshader|llvmpipe|software/i);
          expect(performance.endTick).toBeGreaterThan(performance.startTick);
          expect(Math.abs(performance.endPosition.x - performance.startPosition.x)).toBeGreaterThan(
            1,
          );
          expect(performance.health).toBe(100);
          expect(performance.backing).toEqual([2560, 1440]);
          writeFileSync(
            join(ARTIFACTS, 'active-pursuit-performance.json'),
            JSON.stringify(performance, null, 2),
          );
        }
        await control(page, transport, 'step', 360);
        await sync(page);
        const end = await evaluate<{ dead: boolean; health: number; windup: number }>(
          page,
          `(() => {
        const s=globalThis.aegis.world.snapshot(),c=n=>s.entities.find(e=>e.name===n).components;
        return {dead:c('mission').HorrorMission.dead,health:c('player').Health.current,windup:c('responder').HorrorThreat.attackTicks};
      })()`,
        );
        expect(end).toEqual({ dead: true, health: 0, windup: 48 });
        await until(
          page,
          'globalThis.aegis.presentation().ending?.phase',
          (phase) => phase === 'shown',
          5000,
        );
        await until(page, 'document.pointerLockElement === null', Boolean, 5000);
        const ending = await evaluate<{
          active: boolean;
          phase: string;
          reducedMotion: boolean;
          fadeSeconds: number;
          open: boolean;
          modal: string;
          title: string;
          message: string;
          focused: string;
          restartVisible: boolean;
          opacity: number;
          transition: string;
          gameplayBlocked: boolean;
          look: { yawDeg: number; pitchDeg: number };
          eyeHeight: number;
          up: number[];
        }>(
          page,
          `(() => {
        const a=globalThis.aegis,p=a.world.snapshot().entities.find(e=>e.name==='player').components;
        const dialog=document.getElementById('loss-ending'),shade=getComputedStyle(document.getElementById('loss-shade'));
        return {...a.presentation().ending,open:dialog.open,modal:dialog.getAttribute('aria-modal'),title:document.getElementById('loss-title').textContent,message:document.getElementById('loss-message').textContent,focused:document.activeElement.id,restartVisible:document.getElementById('loss-restart').checkVisibility(),opacity:Number(shade.opacity),transition:shade.transitionDuration,gameplayBlocked:a.presentation().input.capture.gameplayBlocked,look:p.LookState,eyeHeight:p.FpsCamera.eyeHeight,up:a.adapter.camera.up.toArray()};
      })()`,
        );
        expect(ending.active).toBe(true);
        expect(ending.open).toBe(true);
        expect(ending.modal).toBe('true');
        expect(ending.title).toBe('YOU WERE CAUGHT');
        expect(ending.message).toBe('The responder caught you. Restart from the docking airlock.');
        expect(ending.focused).toBe('loss-restart');
        expect(ending.restartVisible).toBe(true);
        expect(ending.gameplayBlocked).toBe(true);
        expect(ending.opacity).toBeGreaterThanOrEqual(0.9);
        expect(ending.reducedMotion).toBe(transport === 'static');
        expect(ending.fadeSeconds).toBe(transport === 'static' ? 0 : 1);
        if (transport === 'static') expect(ending.transition).toBe('0s');
        expect(ending.look).toEqual(view.look);
        expect(ending.eyeHeight).toBe(1.62);
        expect(ending.up).toEqual([0, 1, 0]);
        await capture(page, `${transport}-caught-ending`);
        await key(page, 'Escape', true);
        await key(page, 'Escape', false);
        expect(await evaluate(page, "document.getElementById('loss-ending').open")).toBe(true);
        await key(page, 'KeyW', true);
        await key(page, 'KeyF', true);
        await sync(page);
        await control(page, transport, 'step', 10);
        await key(page, 'KeyW', false);
        await key(page, 'KeyF', false);
        await sync(page);
        expect(
          await evaluate(
            page,
            "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='player').components.LookState",
          ),
        ).toEqual(view.look);
        expect(
          await evaluate(
            page,
            "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='mission').components.HorrorMission.dead",
          ),
        ).toBe(true);
        if (transport === 'live') {
          await key(page, 'KeyR', true);
          await key(page, 'KeyR', false);
        } else {
          const button = await evaluate<{ x: number; y: number }>(
            page,
            "(()=>{const r=document.getElementById('loss-restart').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
          );
          await click(page, button.x, button.y);
        }
        await until(page, 'globalThis.aegis.tick()', (tick) => tick === 0, 10000);
        await until(
          page,
          'globalThis.aegis.presentation().ending.active',
          (active) => active === false,
          5000,
        );
        expect(await evaluate(page, "document.getElementById('loss-ending').open")).toBe(false);
        expect(
          await evaluate(page, 'globalThis.aegis.presentation().input.capture.gameplayBlocked'),
        ).toBe(false);
        expect(await evaluate(page, 'document.activeElement.id')).toBe('stage');
        expect(
          await evaluate(
            page,
            "globalThis.aegis.world.snapshot().entities.find(e=>e.name==='player').components.Health.current",
          ),
        ).toBe(100);
        expect(
          await evaluate(
            page,
            "document.getElementById('action-pause').getAttribute('aria-pressed')",
          ),
        ).toBe('true');
      } catch (error) {
        failed = true;
        await diagnoseFailure(page, transport, 'caught route', error);
        throw error;
      } finally {
        await closeHorrorPage(page, failed);
      }
    }, 240_000);
  }
});

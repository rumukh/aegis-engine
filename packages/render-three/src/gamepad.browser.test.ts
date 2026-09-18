/**
 * Virtual standard-mapping controllers on the actual live and exported play pages.
 * This exercises navigator polling and the normal input boundary, not physical Xbox hardware.
 */
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SceneFile } from '@aegis/content';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import { BINDINGS } from './bindings.js';
import { findRepoRoot } from './catalog.js';
import type { GameDefinition } from './catalog.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { engineModules, exportStaticSite, staticImportMap } from './static-site.js';
import {
  closeAllPages,
  evaluate,
  key,
  launchBrowser,
  openPage,
  until,
  waitForPaint,
} from './browser.js';
import type { CdpSession, LaunchedBrowser } from './browser.js';
import { FPS_SCENE, ISO_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';

const VIEWPORT = { width: 640, height: 360 };
const CHANGE_MS = 15_000;
const CASE_MS = 300_000;
const PREFIX = '/nested/controller/';
type Transport = 'live' | 'static';

// Keep the stock fixture's player/camera, but remove gaps so a slow frame cannot end the test.
const flatPlatformer: SceneFile = {
  ...PLATFORMER_SCENE,
  resources: {
    'platformer.tilemap': {
      aegis: 'tilemap/1',
      name: 'controller-floor',
      width: 32,
      height: 6,
      tileSize: 1,
      legend: { '#': { solid: true, sprite: 'ground' } },
      layers: [
        {
          name: 'collision',
          data: [...Array<string>(4).fill('.'.repeat(32)), '#'.repeat(32), '#'.repeat(32)],
        },
      ],
    },
  },
  entities: PLATFORMER_SCENE.entities.filter((entity) => ['player', 'camera'].includes(entity.id)),
};
const CASES = [
  {
    id: 'platformer',
    plugin: platformerPlugin,
    scene: flatPlatformer,
    exportName: 'platformerPlugin',
  },
  { id: 'fps', plugin: fpsPlugin, scene: FPS_SCENE, exportName: 'fpsPlugin' },
  { id: 'iso', plugin: isoPlugin, scene: ISO_SCENE, exportName: 'isoPlugin' },
] as const;

let artifacts: string;
let dev: DevServer;
let staticServer: Server;
let staticUrl: string;
let browser: LaunchedBrowser;

beforeAll(async () => {
  const repoRoot = findRepoRoot();
  const cache = join(repoRoot, '.cache');
  mkdirSync(cache, { recursive: true });
  artifacts = mkdtempSync(join(cache, 'gamepad-browser-'));
  const games: GameDefinition[] = CASES.map((entry) => ({
    id: entry.id,
    title: `Virtual controller ${entry.id}`,
    blurb: 'Standard-mapping API fixture; no physical controller.',
    objective: 'Drive the stock mode through ordinary browser input.',
    mode: entry.id,
    plugin: entry.plugin,
    scene: entry.scene,
    bindings: BINDINGS[entry.id],
  }));
  dev = await startDevServer({ games, port: 0, basePath: '/controller-live/' });
  const outDir = join(artifacts, 'site');
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
    })),
    outDir,
    repoRoot,
  });
  writeFileSync(
    join(outDir, 'consumer.html'),
    `<!doctype html>
    <meta charset="utf-8"><title>Input-only package consumer</title>
    <link rel="icon" href="data:,">
    <script type="importmap">${staticImportMap('./', engineModules(repoRoot))}</script>
    <script type="module">
      import { createGamepadInput, createInputBuffer, createLiveInput,
        createInputCollector, BINDINGS } from '@aegis/render-three/input';
      globalThis.consumer = {
        pad: createGamepadInput({ bindings: {
          sticks: [{ axes: [0, 1], x: 'MoveX', y: 'MoveY', deadZone: 0.2 }],
          buttons: [{ button: 0, action: 'Jump', label: 'A' }],
        } }),
        buffer: createInputBuffer(), live: createLiveInput(),
        collector: typeof createInputCollector, modes: Object.keys(BINDINGS).sort(),
      };
    </script>`,
  );
  // Like the Pages acceptance fixture, this server serves only exported files: no API or session.
  staticServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    if (request.method !== 'GET' || !path.startsWith(PREFIX)) {
      response.writeHead(404).end();
      return;
    }
    let relative = decodeURIComponent(path.slice(PREFIX.length));
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const target = resolve(outDir, relative);
    if (!target.startsWith(outDir + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      response.writeHead(404).end();
      return;
    }
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.json': 'application/json',
    };
    response.writeHead(200, {
      'content-type': mime[extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    staticServer.once('error', fail);
    staticServer.listen(0, '127.0.0.1', done);
  });
  const address = staticServer.address();
  if (address === null || typeof address === 'string')
    throw new Error('Static server did not bind');
  staticUrl = `http://127.0.0.1:${address.port}${PREFIX.slice(0, -1)}`;
  // Keep the launcher's short OS temp path: Chromium also creates Unix sockets beneath TMPDIR.
  browser = await launchBrowser({ viewport: VIEWPORT });
  const blank = await openPage(browser.port, 'about:blank', VIEWPORT);
  try {
    await waitForPaint(blank);
  } finally {
    await blank.close();
  }
}, 240_000);

afterAll(async () => {
  if (browser !== undefined) {
    await closeAllPages(browser.port).catch(() => undefined);
    browser.process.kill();
    await new Promise<void>((done) => {
      if (browser.process.exitCode !== null || browser.process.signalCode !== null) done();
      else browser.process.once('exit', () => done());
    });
    rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  await dev?.close();
  if (staticServer !== undefined) {
    staticServer.closeAllConnections();
    await new Promise<void>((done) => staticServer.close(() => done()));
  }
  if (artifacts !== undefined)
    rmSync(artifacts, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

async function installVirtualPad(cdp: CdpSession): Promise<void> {
  await evaluate(
    cdp,
    `(() => {
    globalThis.__padPolls = 0;
    globalThis.__padSamples = [];
    globalThis.__setVirtualPad = (axes = [0, 0, 0, 0], down = [], connected = true) => {
      globalThis.__virtualPad = connected ? Object.freeze({
        index: 0, id: 'Aegis virtual standard controller — not physical hardware',
        mapping: 'standard', connected: true,
        axes: Object.freeze([...axes]),
        buttons: Object.freeze(Array.from({length: 17}, (_, index) => Object.freeze({
          pressed: down.includes(index), touched: down.includes(index),
          value: down.includes(index) ? 1 : 0,
        }))),
      }) : null;
    };
    globalThis.__setVirtualPad();
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        globalThis.__padPolls++;
        globalThis.__padSamples.push({
          at: performance.now(), axes: globalThis.__virtualPad?.axes ?? [0, 0, 0, 0],
        });
        return Object.freeze([globalThis.__virtualPad]);
      },
    });
  })()`,
  );
}

async function frames(cdp: CdpSession, count = 3): Promise<void> {
  await evaluate(
    cdp,
    `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('controller frame wait stalled')), ${CHANGE_MS});
    let left = ${count};
    const step = () => {
      if (--left === 0) { clearTimeout(timeout); resolve(null); }
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`,
  );
}

async function closePage(cdp: CdpSession): Promise<void> {
  try {
    await cdp.send('Page.navigate', { url: 'about:blank' });
  } finally {
    cdp.close();
  }
}

async function setPad(
  cdp: CdpSession,
  axes = [0, 0, 0, 0],
  down: number[] = [],
  connected = true,
): Promise<void> {
  await evaluate(
    cdp,
    `globalThis.__setVirtualPad(${JSON.stringify(axes)}, ${JSON.stringify(down)}, ${connected})`,
  );
}

async function settle(cdp: CdpSession): Promise<void> {
  await frames(cdp);
  await evaluate(cdp, 'globalThis.aegis.sync().then(() => null)');
}

async function openGame(transport: Transport, id: string): Promise<CdpSession> {
  const base = transport === 'live' ? dev.url : staticUrl;
  const cdp = await openPage(browser.port, `${base}/play/${id}/`, VIEWPORT);
  try {
    await until<boolean>(
      cdp,
      'globalThis.aegis !== undefined && globalThis.aegis.tick() >= 1',
      Boolean,
    );
    await installVirtualPad(cdp);
    await settle(cdp);
    expect(await evaluate<number>(cdp, 'globalThis.__padPolls')).toBeGreaterThanOrEqual(2);
    return cdp;
  } catch (error) {
    await closePage(cdp);
    throw error;
  }
}

function component(name: string, id: string): string {
  return `globalThis.aegis.world.snapshot().entities.find(e => e.name === ${JSON.stringify(name)}).components.${id}`;
}

async function advance(cdp: CdpSession, ticks = 8): Promise<void> {
  const start = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
  await until<number>(cdp, 'globalThis.aegis.tick()', (tick) => tick >= start + ticks, CHANGE_MS);
}

async function eventCount(
  cdp: CdpSession,
  transport: Transport,
  id: string,
  type: string,
): Promise<number> {
  if (transport === 'live')
    return dev
      .session(id)!
      .world.events.history()
      .filter((event) => event.type === type).length;
  return evaluate<number>(
    cdp,
    `globalThis.aegis.events().filter(e => e.type === ${JSON.stringify(type)}).length`,
  );
}

async function expectStaticRequests(cdp: CdpSession): Promise<void> {
  const urls = await evaluate<string[]>(
    cdp,
    "performance.getEntriesByType('resource').map(e => e.name)",
  );
  expect(urls.length).toBeGreaterThan(2);
  expect(urls.filter((url) => !url.startsWith(`${staticUrl}/`) || url.includes('/api/'))).toEqual(
    [],
  );
}

describe('virtual controller on real play pages', () => {
  for (const transport of ['live', 'static'] as const) {
    it(
      `${transport}: platformer moves, releases/disconnects, merges Jump ownership and polls session commands while paused`,
      async () => {
        const cdp = await openGame(transport, 'platformer');
        const x = `${component('player', 'Transform')}.position.x`;
        const grounded = `${component('player', 'BodyState')}.grounded`;
        try {
          const start = await evaluate<number>(cdp, x);
          await advance(cdp);
          expect(await evaluate<number>(cdp, x)).toBe(start);
          for (const disconnect of [false, true]) {
            const before = await evaluate<number>(cdp, x);
            await setPad(cdp, [0.6, 0, 0, 0]);
            await until<number>(cdp, x, (value) => value > before + 0.3, CHANGE_MS);
            await setPad(cdp, [0, 0, 0, 0], [], !disconnect);
            await settle(cdp);
            const stopped = await evaluate<number>(cdp, x);
            await advance(cdp);
            expect(await evaluate<number>(cdp, x)).toBeCloseTo(stopped, 6);
          }
          await setPad(cdp);
          await settle(cdp);
          await setPad(cdp, [0, 0, 0, 0], [0]);
          await until<boolean>(cdp, grounded, (value) => !value, CHANGE_MS);
          await until<boolean>(cdp, grounded, Boolean, CHANGE_MS);
          expect(await eventCount(cdp, transport, 'platformer', 'player.jumped')).toBe(1);
          // A keyboard press during controller ownership must not create another logical edge.
          await key(cdp, 'Space', true);
          await settle(cdp);
          await advance(cdp);
          await setPad(cdp, [0, 0, 0, 0], [], false);
          await settle(cdp);
          await advance(cdp);
          expect(await eventCount(cdp, transport, 'platformer', 'player.jumped')).toBe(1);
          await key(cdp, 'Space', false);
          await settle(cdp);
          await key(cdp, 'Space', true);
          await until<boolean>(cdp, grounded, (value) => !value, CHANGE_MS);
          await key(cdp, 'Space', false);
          expect(await eventCount(cdp, transport, 'platformer', 'player.jumped')).toBe(2);

          await setPad(cdp);
          await settle(cdp);
          await setPad(cdp, [0, 0, 0, 0], [9]);
          const paused = `document.getElementById('action-pause').getAttribute('aria-pressed') === 'true'`;
          await until<boolean>(cdp, paused, Boolean, CHANGE_MS);
          const pausedTick = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
          const polls = await evaluate<number>(cdp, 'globalThis.__padPolls');
          await frames(cdp, 5);
          expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBe(pausedTick);
          expect(await evaluate<number>(cdp, 'globalThis.__padPolls')).toBeGreaterThan(polls);
          await setPad(cdp);
          await frames(cdp);
          await setPad(cdp, [0, 0, 0, 0], [8]);
          await until<number>(cdp, 'globalThis.aegis.tick()', (tick) => tick === 0, CHANGE_MS);
          expect(await evaluate<boolean>(cdp, paused)).toBe(true);
          expect(await evaluate<number>(cdp, x)).toBe(1.5);
          await setPad(cdp);
          await frames(cdp);
          await setPad(cdp, [0, 0, 0, 0], [9]);
          await until<boolean>(cdp, paused, (value) => !value, CHANGE_MS);
          await setPad(cdp);
          await advance(cdp);
          if (transport === 'static') await expectStaticRequests(cdp);
          expect(cdp.diagnostics).toEqual([]);
        } finally {
          await closePage(cdp);
        }
      },
      CASE_MS,
    );

    it(
      `${transport}: FPS sticks move screen-right/forward and integrate look once per elapsed frame`,
      async () => {
        const cdp = await openGame(transport, 'fps');
        const position = `${component('player', 'Transform')}.position`;
        const look = component('player', 'LookState');
        try {
          const initial = await evaluate<{ x: number; z: number }>(cdp, position);
          await advance(cdp);
          expect(await evaluate<number>(cdp, `${position}.x`)).toBe(initial.x);
          await setPad(cdp, [0.6, 0, 0, 0]);
          await until<number>(cdp, `${position}.x`, (x) => x < initial.x - 0.2, CHANGE_MS);
          await setPad(cdp);
          await settle(cdp);
          const forwardStart = await evaluate<number>(cdp, `${position}.z`);
          await setPad(cdp, [0, -0.6, 0, 0]);
          await until<number>(cdp, `${position}.z`, (z) => z > forwardStart + 0.2, CHANGE_MS);
          await setPad(cdp);
          await settle(cdp);
          const before = await evaluate<{ yawDeg: number; pitchDeg: number }>(cdp, look);
          expect(before).toEqual({ yawDeg: 0, pitchDeg: 0 });
          const landmark = await evaluate<{ x: number; z: number }>(
            cdp,
            `({x: ${position}.x, z: ${position}.z + 1})`,
          );
          const project = `globalThis.aegis.project(${landmark.x}, 1.6, ${landmark.z})`;
          const screenBefore = await evaluate<{ x: number; y: number }>(cdp, project);
          await evaluate(
            cdp,
            `new Promise(resolve => {
          globalThis.__padSamples = globalThis.__padSamples.slice(-1);
          globalThis.__setVirtualPad([0, 0, 0.6, 0.6]);
          const start = performance.now();
          const step = () => {
            if (performance.now() - start < 400) requestAnimationFrame(step);
            else { globalThis.__setVirtualPad(); resolve(null); }
          };
          requestAnimationFrame(step);
        })`,
          );
          await settle(cdp);
          const integrated = await evaluate<number>(
            cdp,
            `globalThis.__padSamples.reduce((sum, sample, index, all) =>
          sum + (index > 0 && sample.axes[2] > 0
            ? Math.min(0.25, (sample.at - all[index - 1].at) / 1000) : 0), 0)`,
          );
          expect(integrated).toBeGreaterThan(0);
          const after = await evaluate<{ yawDeg: number; pitchDeg: number }>(cdp, look);
          // Radial .2 deadzone on (.6,.6) gives .573223 on each axis; rates are 120/90 deg/s.
          const expectedYaw = integrated * 120 * 0.573223;
          const expectedPitch = integrated * 90 * 0.573223;
          expect(-after.yawDeg).toBeGreaterThan(expectedYaw * 0.7);
          expect(-after.yawDeg).toBeLessThan(expectedYaw * 1.3);
          expect(-after.pitchDeg).toBeGreaterThan(expectedPitch * 0.7);
          expect(-after.pitchDeg).toBeLessThan(expectedPitch * 1.3);
          const screenAfter = await evaluate<{ x: number; y: number }>(cdp, project);
          expect(screenAfter.x).toBeLessThan(screenBefore.x);
          expect(screenAfter.y).toBeLessThan(screenBefore.y);
          await advance(cdp);
          expect(await evaluate(cdp, look)).toEqual(after);
          if (transport === 'static') await expectStaticRequests(cdp);
          expect(cdp.diagnostics).toEqual([]);
        } finally {
          await closePage(cdp);
        }
      },
      CASE_MS,
    );

    it(
      `${transport}: iso's visible controller cursor orders one real picked-cell move`,
      async () => {
        const cdp = await openGame(transport, 'iso');
        const cell = component('operative', 'GridPosition');
        try {
          await advance(cdp);
          expect(await evaluate<number>(cdp, `${cell}.cellX`)).toBe(1);
          expect(await evaluate<number>(cdp, `${cell}.cellY`)).toBe(1);
          await setPad(cdp, [0.3, 0, 0, 0]);
          await until<boolean>(
            cdp,
            `(() => {
          const cursor = document.getElementById('gamepad-cursor');
          return cursor !== null && !cursor.hidden && getComputedStyle(cursor).display !== 'none';
        })()`,
            Boolean,
            CHANGE_MS,
          );
          await setPad(cdp);
          await frames(cdp);
          // Steer by physical axes only. The existing projection is an observer, not an input hook.
          await evaluate(
            cdp,
            `new Promise((resolve, reject) => {
          const target = globalThis.aegis.project(2, 0, 1);
          if (!target) { reject(new Error('target floor cell is off screen')); return; }
          const timeout = setTimeout(() => {
            globalThis.__setVirtualPad();
            reject(new Error('controller cursor did not reach projected floor cell'));
          }, ${CHANGE_MS});
          const step = () => {
            const rect = document.getElementById('gamepad-cursor').getBoundingClientRect();
            const dx = target.x - (rect.left + rect.width / 2);
            const dy = target.y - (rect.top + rect.height / 2);
            const distance = Math.hypot(dx, dy);
            if (distance < 2) {
              globalThis.__setVirtualPad();
              clearTimeout(timeout); resolve(null); return;
            }
            const magnitude = 0.2 + 0.8 * Math.min(0.8, distance / 250);
            globalThis.__setVirtualPad([dx / distance * magnitude, dy / distance * magnitude, 0, 0]);
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        })`,
          );
          await frames(cdp);
          expect(await eventCount(cdp, transport, 'iso', 'move.ordered')).toBe(0);
          await setPad(cdp, [0, 0, 0, 0], [0]);
          await until<boolean>(
            cdp,
            `${cell}.cellX === 2 && ${cell}.cellY === 1`,
            Boolean,
            CHANGE_MS,
          );
          await advance(cdp, 15);
          expect(await eventCount(cdp, transport, 'iso', 'move.ordered')).toBe(1);
          expect(await eventCount(cdp, transport, 'iso', 'cell.entered')).toBe(1);
          await setPad(cdp);
          await settle(cdp);
          if (transport === 'static') await expectStaticRequests(cdp);
          expect(cdp.diagnostics).toEqual([]);
        } finally {
          await closePage(cdp);
        }
      },
      CASE_MS,
    );
  }

  it(
    'loads the public input package in a renderer-free browser consumer',
    async () => {
      const cdp = await openPage(browser.port, `${staticUrl}/consumer.html`, VIEWPORT);
      try {
        await until<boolean>(cdp, 'globalThis.consumer !== undefined', Boolean);
        await installVirtualPad(cdp);
        await evaluate(cdp, 'globalThis.consumer.pad.sample()');
        await frames(cdp);
        await evaluate(cdp, 'globalThis.consumer.pad.sample()');
        await setPad(cdp, [0.6, 0, 0, 0], [0]);
        const result = await evaluate<{
          collector: string;
          modes: string[];
          held: string[];
          pressed: string[];
          axes: Record<string, number>;
          tick: number;
          canvas: number;
          engine: string;
        }>(
          cdp,
          `(() => {
        const c = globalThis.consumer;
        const sample = c.pad.sample();
        c.buffer.setSource('controller', sample);
        c.live.submit(c.buffer.take());
        const frame = c.live.frameFor(42);
        return { collector: c.collector, modes: c.modes, held: sample.held,
          pressed: frame.pressed, axes: frame.axes, tick: frame.tick,
          canvas: document.querySelectorAll('canvas').length, engine: typeof globalThis.aegis };
      })()`,
        );
        expect(result.collector).toBe('function');
        expect(result.modes).toEqual(['fps', 'iso', 'platformer']);
        expect(result.held).toEqual(['Jump']);
        expect(result.pressed).toEqual(['Jump']);
        expect(result.axes.MoveX).toBeCloseTo(0.5, 6);
        expect(result.axes.MoveY).toBe(0);
        expect(result.tick).toBe(42);
        expect(result.canvas).toBe(0);
        expect(result.engine).toBe('undefined');
        const urls = await evaluate<string[]>(
          cdp,
          "performance.getEntriesByType('resource').map(e => e.name)",
        );
        expect(urls.some((url) => url.endsWith('/dist/input.js'))).toBe(true);
        expect(
          urls.filter((url) =>
            /(?:\/vendor\/three\/|node:|\/api\/|\/(?:boot|static-boot|render|dev-server)\.js)/.test(
              url,
            ),
          ),
        ).toEqual([]);
        await expectStaticRequests(cdp);
        expect(cdp.diagnostics).toEqual([]);
        await evaluate(cdp, 'globalThis.consumer.pad.dispose()');
      } finally {
        await closePage(cdp);
      }
    },
    CASE_MS,
  );
});

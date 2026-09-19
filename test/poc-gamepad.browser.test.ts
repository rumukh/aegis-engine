import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pocGames, pocStaticGames, pocStaticModules } from '../poc/poc-games.mjs';
import {
  evaluate,
  launchBrowser,
  openPage,
  stopExternalLagWitness,
  until,
  waitForPaint,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import type { DevServer } from '../packages/render-three/src/dev-server.js';
import { exportStaticSite } from '../packages/render-three/src/static-site.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import {
  gamepadFrames,
  installVirtualPad,
  setPad,
} from '../packages/render-three/src/testing/gamepad-browser.js';

type Transport = 'live' | 'static';
type Game = 'platformer' | 'iso' | 'fps';
const VIEWPORT = { width: 640, height: 360 };
const PREFIX = '/demo-controllers/';
const CHANGE_MS = 15_000;
const CASE_MS = 240_000;
const PAUSED = `document.getElementById('action-pause').getAttribute('aria-pressed') === 'true'`;
let temporary: string;
let dev: DevServer;
let fileServer: Server;
let staticUrl: string;
let browser: LaunchedBrowser | undefined;

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aegis-poc-gamepad-'));
  dev = await startDevServer({ games: await pocGames(), port: 0 });
  const site = exportStaticSite({
    games: await pocStaticGames(),
    modules: await pocStaticModules(),
    repoRoot: process.cwd(),
    outDir: join(temporary, 'site'),
  });
  const files = new Map(
    site.files.map((file) => [
      `${PREFIX}${file.replaceAll('\\', '/')}`,
      join(site.outDir, ...file.split(/[\\/]/)),
    ]),
  );
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
  };
  fileServer = createServer((request, response) => {
    let path = new URL(request.url ?? '/', 'http://local').pathname;
    if (path.endsWith('/')) path += 'index.html';
    const file = files.get(path);
    if (request.method !== 'GET' || file === undefined) {
      response.writeHead(404).end(`Unexported request ${path}`);
      return;
    }
    response.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    fileServer.once('error', fail);
    fileServer.listen(0, '127.0.0.1', done);
  });
  const address = fileServer.address();
  assert.ok(address !== null && typeof address !== 'string');
  staticUrl = `http://127.0.0.1:${address.port}${PREFIX.slice(0, -1)}`;
  expect((await fetch(`${dev.url}/`)).status).toBe(200);
  expect((await fetch(`${staticUrl}/`)).status).toBe(200);
}, 180_000);

beforeEach(async () => {
  browser = await launchBrowser({ viewport: VIEWPORT });
  const blank = await openPage(browser.port, 'about:blank', VIEWPORT);
  try {
    await waitForPaint(blank);
  } finally {
    blank.close();
  }
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
  if (fileServer !== undefined) {
    fileServer.closeAllConnections();
    await new Promise<void>((done) => fileServer.close(() => done()));
  }
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

function component(name: string, id: string): string {
  return `globalThis.aegis.world.snapshot().entities.find(e => e.name === ${JSON.stringify(name)}).components.${id}`;
}

async function settle(cdp: CdpSession): Promise<void> {
  await gamepadFrames(cdp);
  await evaluate(cdp, 'globalThis.aegis.sync().then(() => null)');
}

async function advance(cdp: CdpSession, ticks = 8): Promise<void> {
  const start = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
  await until<number>(cdp, 'globalThis.aegis.tick()', (tick) => tick >= start + ticks, CHANGE_MS);
}

async function openGame(transport: Transport, id: Game): Promise<CdpSession> {
  assert.ok(browser);
  const base = transport === 'live' ? dev.url : staticUrl;
  const cdp = await openPage(browser.port, `${base}/play/${id}/`, VIEWPORT);
  await until<boolean>(
    cdp,
    `globalThis.aegis?.presentation().status === 'ready' && globalThis.aegis.tick() > 0`,
    Boolean,
  );
  await installVirtualPad(cdp);
  await settle(cdp);
  expect(
    await evaluate<string>(cdp, "document.getElementById('hud-controller').textContent"),
  ).toContain(': ready');
  const controls = await evaluate<string>(cdp, "document.getElementById('controls').textContent");
  expect(controls).toContain('controller:');
  expect(controls).toContain('Menu / View');
  return cdp;
}

async function eventTypes(cdp: CdpSession, transport: Transport, id: Game): Promise<string[]> {
  if (transport === 'live') {
    const session = dev.session(id);
    assert.ok(session);
    return session.world.events.history().map((event) => event.type);
  }
  return evaluate<string[]>(cdp, 'globalThis.aegis.events().map(e => e.type)');
}

async function press(cdp: CdpSession, button: number): Promise<void> {
  await setPad(cdp, [0, 0, 0, 0], [button]);
  await settle(cdp);
  await setPad(cdp);
  await settle(cdp);
}

async function sessionControls(cdp: CdpSession, transport: Transport, id: Game): Promise<void> {
  await press(cdp, 9);
  await until<boolean>(cdp, PAUSED, Boolean, CHANGE_MS);
  const tick = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
  const polls = await evaluate<number>(cdp, 'globalThis.__padPolls');
  await gamepadFrames(cdp, 5);
  expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBe(tick);
  expect(await evaluate<number>(cdp, 'globalThis.__padPolls')).toBeGreaterThan(polls);

  await press(cdp, 8);
  await until<number>(cdp, 'globalThis.aegis.tick()', (value) => value === 0, CHANGE_MS);
  expect(await evaluate<boolean>(cdp, PAUSED)).toBe(true);
  expect(await eventTypes(cdp, transport, id)).toEqual([]);
  await press(cdp, 9);
  await until<boolean>(cdp, PAUSED, (value) => !value, CHANGE_MS);
  await advance(cdp);
  expect(await eventTypes(cdp, transport, id)).not.toContain('weapon.fired');
  expect(await eventTypes(cdp, transport, id)).not.toContain('player.jumped');
}

async function expectHealthyPage(cdp: CdpSession, transport: Transport): Promise<void> {
  expect(cdp.diagnostics).toEqual([]);
  expect(await evaluate(cdp, 'globalThis.aegis.presentation().status')).toBe('ready');
  if (transport !== 'static') return;
  const urls = await evaluate<string[]>(
    cdp,
    "performance.getEntriesByType('resource').map(e => e.name)",
  );
  expect(urls.length).toBeGreaterThan(40);
  expect(urls.filter((url) => !url.startsWith(`${staticUrl}/`) || url.includes('/api/'))).toEqual(
    [],
  );
}

/** Steer the visible cursor with hardware axes; projection only observes the target. */
async function pointAtCell(cdp: CdpSession, x: number, y: number): Promise<void> {
  await evaluate(
    cdp,
    `new Promise((resolve, reject) => {
    const deadline = performance.now() + ${CHANGE_MS};
    const step = () => {
      const target = globalThis.aegis.project(${x}, 0, ${y});
      if (!target || performance.now() > deadline) {
        globalThis.__setVirtualPad();
        reject(new Error('Controller cursor could not reach cell (${x}, ${y})')); return;
      }
      const cursor = document.getElementById('gamepad-cursor');
      const rect = cursor.getBoundingClientRect();
      const dx = target.x - (rect.left + rect.width / 2);
      const dy = target.y - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      if (!cursor.hidden && distance < 2) {
        globalThis.__setVirtualPad(); resolve(null); return;
      }
      const speed = 0.2 + 0.8 * Math.min(0.7, distance / 250);
      globalThis.__setVirtualPad([dx / Math.max(distance, 1) * speed, dy / Math.max(distance, 1) * speed, 0, 0]);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`,
  );
  await settle(cdp);
}

/** Turn using the right stick, without pointer lock or writing LookState. */
async function aimAtPanel(cdp: CdpSession): Promise<void> {
  await evaluate(
    cdp,
    `new Promise((resolve, reject) => {
    const deadline = performance.now() + ${CHANGE_MS};
    let stable = 0;
    const step = () => {
      const error = 90 - ${component('player', 'LookState')}.yawDeg;
      if (performance.now() > deadline) {
        globalThis.__setVirtualPad(); reject(new Error('Right stick did not aim at the access panel')); return;
      }
      if (Math.abs(error) < 0.5) {
        globalThis.__setVirtualPad();
        if (++stable >= 6) { resolve(null); return; }
      } else {
        stable = 0;
        const speed = 0.2 + 0.8 * Math.min(0.7, Math.abs(error) / 90);
        globalThis.__setVirtualPad([0, 0, -Math.sign(error) * speed, 0]);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`,
  );
  await settle(cdp);
}

describe('standard controllers in the three shipped demos', () => {
  for (const transport of ['live', 'static'] as const) {
    it(
      `${transport}: Coyote Gap runs, jumps, stops on disconnect and supports Menu/View`,
      async () => {
        const cdp = await openGame(transport, 'platformer');
        const x = `${component('player', 'Transform')}.position.x`;
        try {
          const start = await evaluate<number>(cdp, x);
          await advance(cdp);
          expect(await evaluate<number>(cdp, x)).toBe(start);
          expect(await eventTypes(cdp, transport, 'platformer')).not.toContain('player.jumped');
          await press(cdp, 0);
          await advance(cdp, 40);
          expect(await eventTypes(cdp, transport, 'platformer')).toContain('player.jumped');
          expect(await evaluate(cdp, `${component('player', 'BodyState')}.grounded`)).toBe(true);

          await setPad(cdp, [0.5, 0, 0, 0]);
          await until<number>(cdp, x, (value) => value > start + 0.3, CHANGE_MS);
          await setPad(cdp, [0, 0, 0, 0], [], false);
          await settle(cdp);
          const stopped = await evaluate<number>(cdp, x);
          await advance(cdp);
          expect(await evaluate<number>(cdp, x)).toBeCloseTo(stopped, 6);
          await setPad(cdp);
          await settle(cdp);
          await setPad(cdp, [0, 0, 0, 0], [14]);
          await until<number>(cdp, x, (value) => value < stopped - 0.3, CHANGE_MS);
          await setPad(cdp);
          await settle(cdp);
          expect(await eventTypes(cdp, transport, 'platformer')).not.toContain('player.died');
          await sessionControls(cdp, transport, 'platformer');
          expect(await evaluate<number>(cdp, x)).toBe(2.5);
          await expectHealthyPage(cdp, transport);
        } finally {
          cdp.close();
        }
      },
      CASE_MS,
    );

    it(
      `${transport}: Server Vault picks real floor cells with the stick/A cursor and supports Menu/View`,
      async () => {
        const cdp = await openGame(transport, 'iso');
        const cell = component('operative', 'GridPosition');
        try {
          await advance(cdp);
          expect(await evaluate<number>(cdp, `${cell}.cellX`)).toBe(1);
          expect(await eventTypes(cdp, transport, 'iso')).not.toContain('move.ordered');
          await pointAtCell(cdp, 2, 1);
          expect(
            await evaluate<boolean>(cdp, "document.getElementById('gamepad-cursor').hidden"),
          ).toBe(false);
          expect(await eventTypes(cdp, transport, 'iso')).not.toContain('move.ordered');
          await press(cdp, 0);
          await until<boolean>(
            cdp,
            `${cell}.cellX === 2 && ${cell}.cellY === 1`,
            Boolean,
            CHANGE_MS,
          );
          expect(
            (await eventTypes(cdp, transport, 'iso')).filter((type) => type === 'move.ordered'),
          ).toHaveLength(1);
          expect(await eventTypes(cdp, transport, 'iso')).toContain('cell.entered');
          await sessionControls(cdp, transport, 'iso');
          expect(await evaluate<number>(cdp, `${cell}.cellX`)).toBe(1);
          expect(await evaluate<number>(cdp, `${cell}.cellY`)).toBe(1);
          await expectHealthyPage(cdp, transport);
        } finally {
          cdp.close();
        }
      },
      CASE_MS,
    );

    it(
      `${transport}: Sector Breach jumps, aims and opens the blast door with RT without pointer lock`,
      async () => {
        const cdp = await openGame(transport, 'fps');
        const position = `${component('player', 'Transform')}.position`;
        try {
          const start = await evaluate<number>(cdp, `${position}.z`);
          await advance(cdp);
          expect(await evaluate<number>(cdp, `${position}.z`)).toBe(start);
          expect(await eventTypes(cdp, transport, 'fps')).not.toContain('weapon.fired');
          expect(await evaluate<number>(cdp, `${position}.y`)).toBe(0);
          const peak = await evaluate<number>(
            cdp,
            `new Promise((resolve, reject) => {
            const deadline = performance.now() + ${CHANGE_MS};
            let peak = 0;
            globalThis.__setVirtualPad([0, 0, 0, 0], [0]);
            const step = () => {
              peak = Math.max(peak, ${position}.y);
              if (peak > 0 && ${component('player', 'CapsuleBody')}.grounded) {
                globalThis.__setVirtualPad(); resolve(peak); return;
              }
              if (performance.now() > deadline) {
                globalThis.__setVirtualPad(); reject(new Error('A did not jump and land')); return;
              }
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          })`,
          );
          expect(peak).toBeGreaterThan(0.5);
          expect(await evaluate<number>(cdp, `${position}.y`)).toBe(0);
          await settle(cdp);

          await aimAtPanel(cdp);
          await press(cdp, 7);
          await advance(cdp);
          expect(await eventTypes(cdp, transport, 'fps')).toContain('weapon.fired');
          expect(await eventTypes(cdp, transport, 'fps')).toContain('door.opened');
          expect(await evaluate<boolean>(cdp, 'document.pointerLockElement === null')).toBe(true);
          await sessionControls(cdp, transport, 'fps');
          await setPad(cdp, [0, -0.5, 0, 0]);
          await until<number>(cdp, `${position}.z`, (value) => value > start + 0.3, CHANGE_MS);
          await setPad(cdp);
          await settle(cdp);
          const stopped = await evaluate<number>(cdp, `${position}.z`);
          await advance(cdp);
          expect(await evaluate<number>(cdp, `${position}.z`)).toBeCloseTo(stopped, 6);
          expect(await eventTypes(cdp, transport, 'fps')).not.toContain('player.died');
          await expectHealthyPage(cdp, transport);
        } finally {
          cdp.close();
        }
      },
      CASE_MS,
    );
  }
});

/**
 * The deployed site, played in a real browser, from a server that can only hand out files.
 *
 * This is the case the whole change exists to make true. `test/pages-site.test.ts` proves the
 * artifact's module graph is closed and Node-free; that is a claim about bytes. It cannot
 * distinguish a site that plays from a site that loads, paints a HUD over a simulation that never
 * starts, and reads exactly like the first one in a screenshot. Only running it separates them.
 *
 * Three properties, and each is checked with a control that would fail if the check were vacuous:
 *
 * 1. **The simulation advances with no server.** The static file server below serves bytes and
 *    nothing else — it has no `/api/`, no POST handler, no session. If the page were still the dev
 *    server's client, every exchange would 404 and the tick would sit at 0. The tick is read from
 *    the page, twice, and required to move.
 * 2. **Human input reaches the simulation.** Real CDP key, mouse and pointer events — the same
 *    ones `capture.ts` uses — and the world state that results is read back out of the snapshot
 *    the renderer draws. Each game's control is "the same wait without the input", so a world that
 *    changes on its own can never be mistaken for a world responding.
 * 3. **Nothing is fetched that GitHub Pages would not serve.** Every request the page made is
 *    read out of `performance.getEntriesByType('resource')` — actual traffic, not a source scan —
 *    and required to sit under the project prefix.
 *
 * It is served under `/aegis-engine/` deliberately. That prefix is the one thing a local
 * `python -m http.server` at a domain root does not exercise, and root-relative URLs are the
 * classic way a static site works everywhere except where it is deployed.
 *
 * This file launches a browser, so `scripts/test-phases.mjs` puts it in the solo phase and
 * ADR-0010 excludes that phase from hosted `windows-latest`. It runs on `ubuntu-latest` in CI and
 * on a Windows workstation before landing.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_UNTIL_TIMEOUT_MS,
  FOCUS_TIMEOUT_MS,
  LAUNCH_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  PAINT_TIMEOUT_MS,
  click,
  closeAllPages,
  evaluate,
  key,
  launchBrowser,
  mouseMove,
  openPage,
  sleep,
  until,
  waitForPaint,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The prefix a GitHub **project** Pages site is served under. */
const BASE = '/aegis-engine/';

/** Viewport, in CSS pixels. Small on purpose: this rasterises in software. */
const VIEWPORT = { width: 640, height: 360 };

/**
 * Per-case budget, in milliseconds.
 *
 * Derived, not chosen, for the reason `browser-playability.test.ts` sets out at length: a vitest
 * budget smaller than the sum of the deadlines inside it means none of them can fire, and the case
 * dies with `Test timed out` and not one word about what it was waiting for.
 *
 *   openPage: navigation 30s + focus 10s              = 40s
 *   waitForPaint                                      = 90s   (only the first case pays it)
 *   until(booted)                                     = 60s
 *   in-test waits and interactions, generously        = 15s
 *                                                     ------
 *                                                      205s
 *
 * 240s leaves margin over that and is a bound on hanging, not a budget: a healthy case here is
 * measured at 5-12s on this workstation.
 */
const CASE_MS = 240_000;

/** How long to let a game run before reading its tick again, in milliseconds. */
const OBSERVE_MS = 1_200;

let siteDir: string;
let server: Server;
let origin: string;
let browser: LaunchedBrowser;

/** Content types for what a static site actually contains. */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * A file server, and **only** a file server.
 *
 * Deliberately not `startDevServer`. The point of the exercise is that nothing answers a request
 * the artifact does not contain, so this handler has no route table, no API prefix and no POST
 * path: anything that is not a file under the base prefix is a 404. If the page still needed the
 * dev server, that fact would show up here as a dead game rather than being papered over by a
 * server that happened to know how to answer.
 */
function startFileServer(root: string): Promise<{ server: Server; origin: string }> {
  const created = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let path = decodeURIComponent(url.pathname);
    if (request.method !== 'GET' || !path.startsWith(BASE)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end(`404 ${path}`);
      return;
    }
    path = path.slice(BASE.length);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const target = resolve(root, normalize(path));
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end(`404 ${path}`);
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(response);
  });
  return new Promise((done, fail) => {
    created.once('error', fail);
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ server: created, origin: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(
  async () => {
    siteDir = mkdtempSync(join(tmpdir(), 'aegis-pages-browser-'));
    execFileSync(process.execPath, [join('poc', 'build-site.mjs'), '--out', siteDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const started = await startFileServer(siteDir);
    server = started.server;
    origin = started.origin;
    browser = await launchBrowser({ viewport: VIEWPORT });
  },
  LAUNCH_TIMEOUT_MS + PAINT_TIMEOUT_MS + 60_000,
);

afterAll(async () => {
  if (browser !== undefined) {
    await closeAllPages(browser.port).catch(() => undefined);
    browser.process.kill();
    // Best effort, and it must not be able to fail the run. Chrome does not release its profile
    // directory the instant it is killed, so on Windows this throws `EPERM` — a cleanup failure
    // reported as a failed suite, over a temporary directory the OS will reclaim anyway. Measured:
    // all five cases passed and the file went red on this line. The other browser specs in this
    // repository do not delete their profiles at all; this one tries, and shrugs.
    try {
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS owns it now */
    }
  }
  await new Promise<void>((done) => {
    if (server === undefined) return done();
    server.closeAllConnections();
    server.close(() => done());
  });
  rmSync(siteDir, { recursive: true, force: true });
});

/** Open a play page and wait until its simulation is running. */
async function openGame(id: string): Promise<CdpSession> {
  const cdp = await openPage(browser.port, `${origin}${BASE}play/${id}/`, VIEWPORT);
  await waitForPaint(cdp);
  await until<boolean>(
    cdp,
    'globalThis.aegis !== undefined && globalThis.aegis.snapshot() !== null',
    (ready) => ready === true,
  );
  return cdp;
}

/** The named entity's components, out of the snapshot the renderer is drawing. */
async function entity(cdp: CdpSession, name: string): Promise<Record<string, any>> {
  return evaluate<Record<string, any>>(
    cdp,
    `(globalThis.aegis.snapshot().entities.find((e) => e.name === ${JSON.stringify(name)}) ?? {}).components`,
  );
}

/** Every event type the run has emitted so far. */
async function eventTypes(cdp: CdpSession): Promise<string[]> {
  return evaluate<string[]>(cdp, 'globalThis.aegis.events().map((e) => e.type)');
}

/** Every URL the page has actually fetched. */
async function requestedUrls(cdp: CdpSession): Promise<string[]> {
  return evaluate<string[]>(cdp, "performance.getEntriesByType('resource').map((e) => e.name)");
}

/** Assert the page needed nothing but files under the Pages prefix. */
async function expectNoBackend(cdp: CdpSession): Promise<void> {
  const urls = await requestedUrls(cdp);
  // Anti-vacuity: a page that fetched nothing would satisfy every filter below. It fetches its
  // whole module graph, so a small number here means the measurement, not the page, is broken.
  expect(
    urls.length,
    'the page fetched almost nothing — is this reading real traffic?',
  ).toBeGreaterThan(40);
  expect(urls.filter((url) => url.includes('/api/'))).toEqual([]);
  expect(
    urls.filter((url) => url.startsWith(origin) && !url.startsWith(`${origin}${BASE}`)),
  ).toEqual([]);
}

describe('the landing page', () => {
  it(
    'lists the three games and links each one relative to the Pages prefix',
    async () => {
      const cdp = await openPage(browser.port, `${origin}${BASE}`, VIEWPORT);
      try {
        const links = await evaluate<string[]>(
          cdp,
          "[...document.querySelectorAll('a.card')].map((a) => a.getAttribute('href'))",
        );
        expect(links).toEqual(['play/platformer/', 'play/iso/', 'play/fps/']);
        const resolved = await evaluate<string[]>(
          cdp,
          "[...document.querySelectorAll('a.card')].map((a) => a.href)",
        );
        for (const href of resolved) expect(href.startsWith(`${origin}${BASE}play/`)).toBe(true);
        expect(await evaluate<string>(cdp, 'document.title')).toContain('Aegis');
      } finally {
        await cdp.close();
      }
    },
    CASE_MS,
  );
});

describe('coyote gap (platformer) plays in the browser', () => {
  it(
    'advances without a server, runs on held input and stops when it is released',
    async () => {
      const cdp = await openGame('platformer');
      try {
        const first = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
        await sleep(OBSERVE_MS);
        const second = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
        expect(second, 'the tick did not advance — the simulation is not running').toBeGreaterThan(
          first,
        );

        const startX = (await entity(cdp, 'player')).Transform.position.x as number;
        await key(cdp, 'ArrowRight', true);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
        await sleep(OBSERVE_MS);
        const heldX = (await entity(cdp, 'player')).Transform.position.x as number;
        await key(cdp, 'ArrowRight', false);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
        await sleep(300);
        const releasedX = (await entity(cdp, 'player')).Transform.position.x as number;
        await sleep(OBSERVE_MS);
        const settledX = (await entity(cdp, 'player')).Transform.position.x as number;

        expect(heldX, 'holding Right did not move the player').toBeGreaterThan(startX + 1);
        // The control. Ticks keep running through this window — `settled` is read a full second
        // after the key came up — so a world that drifts on its own, or a page that replays a
        // recording, fails here while passing the assertion above.
        expect(settledX, 'the player kept moving after the key came up').toBeCloseTo(releasedX, 6);

        await expectNoBackend(cdp);
      } finally {
        await cdp.close();
      }
    },
    CASE_MS,
  );

  it(
    'jumps on a real Space press, and pause / step / restart work',
    async () => {
      const cdp = await openGame('platformer');
      try {
        expect(await eventTypes(cdp)).not.toContain('player.jumped');
        await key(cdp, 'Space', true);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
        await sleep(120);
        await key(cdp, 'Space', false);
        await until<string[]>(cdp, 'globalThis.aegis.events().map((e) => e.type)', (types) =>
          types.includes('player.jumped'),
        );

        // P pauses. Read twice, a second apart, so "paused" is a measurement and not a flag.
        await key(cdp, 'KeyP', true);
        await key(cdp, 'KeyP', false);
        await sleep(400);
        const pausedAt = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
        await sleep(OBSERVE_MS);
        expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBe(pausedAt);
        expect(await evaluate<boolean>(cdp, 'globalThis.aegis.paused()')).toBe(true);

        // `.` advances exactly one tick, which is the whole point of single-stepping.
        await key(cdp, 'Period', true);
        await key(cdp, 'Period', false);
        await sleep(400);
        expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBe(pausedAt + 1);

        // R returns to tick 0 and keeps the pause, exactly as the dev-server session does.
        await key(cdp, 'KeyR', true);
        await key(cdp, 'KeyR', false);
        await sleep(400);
        expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBeLessThan(pausedAt);
        expect(await eventTypes(cdp)).not.toContain('player.jumped');

        // ...and P resumes, so the pause assertions above are not satisfied by a dead page.
        await key(cdp, 'KeyP', true);
        await key(cdp, 'KeyP', false);
        const resumedAt = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
        await sleep(OBSERVE_MS);
        expect(await evaluate<number>(cdp, 'globalThis.aegis.tick()')).toBeGreaterThan(resumedAt);
      } finally {
        await cdp.close();
      }
    },
    CASE_MS,
  );
});

describe('the server vault (iso) plays in the browser', () => {
  it(
    'orders a move from a real click on a floor cell, and stays put without one',
    async () => {
      const cdp = await openGame('iso');
      try {
        const cellOf = async (): Promise<{ x: number; y: number }> => {
          const components = await entity(cdp, 'operative');
          return {
            x: components.GridPosition.cellX as number,
            y: components.GridPosition.cellY as number,
          };
        };
        // The control first: the operative is not going anywhere on its own. Iso is the mode where
        // this matters most — a patrolling guard means the world is visibly busy, and "something
        // moved" is not evidence that the click did it.
        const start = await cellOf();
        await sleep(OBSERVE_MS);
        expect(await cellOf(), 'the operative moved without being clicked anywhere').toEqual(start);

        // A grid cell maps to three.js `(cellX, 0, cellY)`; the page projects it for us, which is
        // the same route `capture.ts` uses to replay a scripted click as a real one.
        const at = await evaluate<{ x: number; y: number } | null>(
          cdp,
          'globalThis.aegis.project(1, 0, 5)',
        );
        expect(at, 'cell (1,5) is off screen, so it cannot be clicked').not.toBeNull();
        await click(cdp, (at as { x: number; y: number }).x, (at as { x: number; y: number }).y);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');

        await until<{ x: number; y: number }>(
          cdp,
          "(() => { const c = globalThis.aegis.snapshot().entities.find((e) => e.name === 'operative').components.GridPosition; return { x: c.cellX, y: c.cellY }; })()",
          (cell) => cell.y > start.y,
        );
        const moved = await cellOf();
        expect(moved.y).toBeGreaterThan(start.y);
        expect(await eventTypes(cdp)).toContain('cell.entered');

        await expectNoBackend(cdp);
      } finally {
        await cdp.close();
      }
    },
    CASE_MS,
  );
});

describe('sector breach (fps) plays in the browser', () => {
  it(
    'takes pointer lock, turns on mouse-look, fires on click and walks on W',
    async () => {
      const cdp = await openGame('fps');
      try {
        const look = async (): Promise<{ yawDeg: number; pitchDeg: number }> =>
          (await entity(cdp, 'player')).LookState as { yawDeg: number; pitchDeg: number };
        const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

        // The control for mouse-look: without pointer lock the collector ignores movement, so a
        // yaw change measured before the click would not be evidence of anything.
        const before = await look();
        await mouseMove(cdp, centre.x - 120, centre.y);
        await sleep(300);
        expect(
          (await look()).yawDeg,
          'the camera turned before pointer lock was taken',
        ).toBeCloseTo(before.yawDeg, 6);

        // A real click takes pointer lock and, under this mode's bindings, also fires.
        await click(cdp, centre.x, centre.y);
        await sleep(300);
        expect(
          await evaluate<boolean>(cdp, 'document.pointerLockElement !== null'),
          'pointer lock did not engage, so no mouse-look could reach the simulation',
        ).toBe(true);
        await until<string[]>(cdp, 'globalThis.aegis.events().map((e) => e.type)', (types) =>
          types.includes('weapon.fired'),
        );

        await mouseMove(cdp, centre.x - 120, centre.y);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
        await sleep(400);
        expect(
          Math.abs((await look()).yawDeg - before.yawDeg),
          'mouse movement under pointer lock did not turn the camera',
        ).toBeGreaterThan(1);

        // Walking. Read the axis the mode actually integrates rather than a distance, so a game
        // that happens to be sliding cannot satisfy it.
        const startZ = (await entity(cdp, 'player')).Transform.position.z as number;
        await key(cdp, 'KeyW', true);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
        await sleep(OBSERVE_MS);
        await key(cdp, 'KeyW', false);
        await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
        await sleep(300);
        const walkedTo = (await entity(cdp, 'player')).Transform.position as {
          x: number;
          z: number;
        };
        await sleep(OBSERVE_MS);
        const settled = (await entity(cdp, 'player')).Transform.position as {
          x: number;
          z: number;
        };
        const distance = Math.abs(walkedTo.x - 0) + Math.abs(walkedTo.z - startZ);
        expect(distance, 'holding W did not move the capsule').toBeGreaterThan(1);
        expect(settled.x, 'the capsule kept moving after W came up').toBeCloseTo(walkedTo.x, 6);
        expect(settled.z, 'the capsule kept moving after W came up').toBeCloseTo(walkedTo.z, 6);

        await expectNoBackend(cdp);
      } finally {
        await cdp.close();
      }
    },
    CASE_MS,
  );
});

void DEFAULT_UNTIL_TIMEOUT_MS;
void FOCUS_TIMEOUT_MS;
void NAVIGATION_TIMEOUT_MS;

/**
 * **The frame budget, and the freeze.** Measured in a real browser, on the real pages.
 *
 * `capture.test.ts` proves the screenshot rule; `script-input.test.ts` proves the input compiler.
 * Neither has an opinion about whether the page is *pleasant to play*, and 28fps against a 60Hz
 * simulation was a fact this repository could not state, let alone fail on.
 *
 * Two things are asserted here, both with numbers and both about quantities the page controls.
 *
 * **What is deliberately not asserted: an absolute frame rate.** These tests run headless against
 * SwiftShader, a software rasteriser, and the ceiling is the environment's, not the page's. The
 * control below measures it — a page doing *nothing* manages about 32fps on this machine, and the
 * fps game's own rate falls with viewport area (measured: 6.7fps at 1280x720, 26.0fps at 320x180,
 * strictly area-proportional). A threshold on that number would be a threshold on whoever's GPU
 * ran the suite. So the assertions below are on the page's own main-thread work, its draw-call
 * count and its per-frame payload — all machine-independent, all things a regression would move,
 * and all invisible to every other test in this package. The simulation's *real-time fidelity*,
 * which is what "slow and laggy" actually meant, is pinned deterministically in
 * `frame-pacing.test.ts`.
 *
 * This file needs a Chromium-family browser and **fails** without one rather than skipping. A
 * skip and a pass are the same colour, and the whole reason this file exists is that a green
 * suite was measuring the wrong loop.
 * @packageDocumentation
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { findRepoRoot } from './catalog.js';
import type { GameDefinition } from './catalog.js';
import { BINDINGS } from './bindings.js';
import { closeAllPages, evaluate, launchBrowser, openPage, sleep, until } from './browser.js';
import type { CdpSession, LaunchedBrowser } from './browser.js';
import {
  FPS_BUDGET_SCENE,
  ISO_BUDGET_SCENE,
  PLATFORMER_BUDGET_SCENE,
} from './testing/budget-scenes.js';

/** Viewport used for every measurement, in CSS pixels. */
const VIEWPORT = { width: 1280, height: 720 };

/** How long each page is left free-running before its timings are read, in milliseconds. */
const SAMPLE_MS = 2500;

/**
 * Milliseconds of **main-thread work** one displayed frame may cost the page: restoring the
 * snapshot, reconciling the scene graph, submitting the draw calls and updating the HUD.
 *
 * Half a 60Hz frame. Measured at shipped level scale: platformer 0.60ms, iso 1.00ms, fps 2.20ms,
 * so this is not
 * a tight fit around current behaviour — it is the point past which the page could not hold 60fps
 * even on a machine with an infinitely fast GPU, which is the only threshold that means anything
 * independent of hardware. Note what it excludes: the `/frame` round trip is not awaited by the
 * frame loop, so its latency is not part of this budget (it is reported, and the simulation's own
 * pacing is guarded in `frame-pacing.test.ts`).
 */
const FRAME_WORK_BUDGET_MS = 8;

/**
 * Draw calls one displayed frame may issue.
 *
 * The fps adapter draws one box per floorplan cell — a column for a solid cell, a floor slab
 * *and* a ceiling slab for a walkable one — so its draw-call count scales linearly with level
 * area. At the shipped 11x21 that is about 340 after frustum culling, and the measurement above
 * puts submission at 1.40ms for 337 calls: **4.2µs each** on this machine.
 *
 * The honest cost bound is therefore {@link FRAME_WORK_BUDGET_MS}, which measures that time
 * directly. This number exists to catch a change of *kind* rather than of degree — an extra
 * object per cell, a second pass over the level, a decoration on every tile — so it sits at
 * roughly twice the shipped-scale count: ordinary level growth does not trip it, a per-cell
 * multiplier does. Verified by mutation: three extra boxes per walkable cell takes it past 800.
 *
 * An earlier draft set this to 320 on a guessed 20-40µs per call. That was measured and found
 * wrong by an order of magnitude, and the number moved rather than the reasoning being kept. If a
 * level ever does need to be much bigger, the fix is instancing — one `InstancedMesh` per visual
 * role would take the whole floorplan to about five calls — not a larger number here.
 */
const DRAW_CALL_BUDGET = 700;

/**
 * Bytes of JSON one displayed frame may carry.
 *
 * The whole world crosses the wire every frame by design (the page holds a *different* world and
 * is structurally unable to write to the simulation's — see `protocol.ts`), and that design is
 * worth keeping. It is not worth keeping unmeasured: at 60fps, 24KB per frame is 1.4MB/s of JSON
 * to serialise, transfer, parse and garbage-collect. Measured today: platformer 10.0KB, iso
 * 2.6KB, fps 19.6KB — of which 17.5KB is the static extruded floorplan, re-sent every frame
 * because one door cell can change. That is the next thing to fix if this budget is ever hit.
 */
const PAYLOAD_BUDGET_BYTES = 24_000;

/** The three PoC-shaped games, built from the bare mode plugins the way the other tests do. */
const GAMES: GameDefinition[] = [
  {
    id: 'platformer',
    title: 'Test Platformer',
    blurb: 'a side-on test level',
    objective: 'reach the goal',
    mode: 'platformer',
    plugin: platformerPlugin,
    scene: PLATFORMER_BUDGET_SCENE,
    bindings: BINDINGS.platformer,
  },
  {
    id: 'iso',
    title: 'Test Vault',
    blurb: 'an isometric test level',
    objective: 'reach the exit',
    mode: 'iso',
    plugin: isoPlugin,
    scene: ISO_BUDGET_SCENE,
    bindings: BINDINGS.iso,
  },
  {
    id: 'fps',
    title: 'Test Sector',
    blurb: 'a first-person test corridor',
    objective: 'reach the exit',
    mode: 'fps',
    plugin: fpsPlugin,
    scene: FPS_BUDGET_SCENE,
    bindings: BINDINGS.fps,
  },
];

/** The shape `AegisDebugHandle.timings()` returns, as it crosses the CDP boundary. */
interface Timings {
  frames: number;
  snapshots: number;
  gap: number;
  meanGap: number;
  worstGap: number;
  restore: number;
  sync: number;
  render: number;
  hud: number;
  exchange: number;
  exchangeBytes: number;
  drawCalls: number;
  triangles: number;
  exchangeErrors: number;
  inFlight: boolean;
}

let server: DevServer;
let browser: LaunchedBrowser;

beforeAll(async () => {
  server = await startDevServer({ games: GAMES, port: 0, repoRoot: findRepoRoot() });
  browser = await launchBrowser({ port: 9335, viewport: VIEWPORT });
}, 60_000);

afterAll(async () => {
  browser?.process.kill();
  await server?.close();
});

/** Open a page, let it run, and return its recorded timings. */
async function sample(url: string): Promise<{ cdp: CdpSession; timings: Timings }> {
  await closeAllPages(browser.port);
  const cdp = await openPage(browser.port, url, VIEWPORT);
  await until<number>(cdp, 'globalThis.aegis ? globalThis.aegis.tick() : -1', (t) => t >= 0);
  await sleep(400);
  await evaluate<null>(cdp, 'globalThis.aegis.resetTimings(); null');
  await sleep(SAMPLE_MS);
  const timings = JSON.parse(
    await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())'),
  ) as Timings;
  return { cdp, timings };
}

describe('the frame budget, measured in a real browser', () => {
  it('gives the probe a ceiling to measure against', async () => {
    // Anti-vacuity for every test below: if a page doing nothing cannot animate, the numbers this
    // file reads mean nothing, and "no budget exceeded" would be indistinguishable from "the
    // browser never drew". This also documents the environment's own ceiling, which is why an
    // absolute frame-rate threshold is not asserted anywhere in this file.
    await closeAllPages(browser.port);
    const cdp = await openPage(browser.port, 'about:blank', VIEWPORT);
    await evaluate<null>(
      cdp,
      `globalThis.__n = 0;
       const tick = () => { globalThis.__n++; globalThis.requestAnimationFrame(tick); };
       globalThis.requestAnimationFrame(tick);
       null`,
    );
    await sleep(1000);
    const frames = await evaluate<number>(cdp, 'globalThis.__n');
    cdp.close();
    expect(frames).toBeGreaterThan(10);
  });

  for (const game of GAMES) {
    it(`${game.id}: holds the per-frame budget`, async () => {
      const { cdp, timings } = await sample(`${server.url}/play/${game.id}`);
      cdp.close();

      // Preconditions. Each one distinguishes "measured and fine" from "never measured": a page
      // that booted and then stopped, or one whose counters were never written, would otherwise
      // satisfy every budget below by reporting zero.
      expect(timings.frames, 'the page must have drawn frames').toBeGreaterThan(10);
      expect(timings.snapshots, 'the page must have fetched snapshots').toBeGreaterThan(3);
      expect(timings.drawCalls, 'the renderer must have drawn something').toBeGreaterThan(0);
      expect(timings.exchangeBytes, 'a snapshot must have crossed the wire').toBeGreaterThan(0);
      expect(timings.exchangeErrors, 'no exchange may have failed').toBe(0);

      const work = timings.restore + timings.sync + timings.render + timings.hud;
      expect(
        work,
        `main-thread work per frame: restore ${timings.restore.toFixed(2)}ms + sync ` +
          `${timings.sync.toFixed(2)}ms + render ${timings.render.toFixed(2)}ms + hud ` +
          `${timings.hud.toFixed(2)}ms`,
      ).toBeLessThanOrEqual(FRAME_WORK_BUDGET_MS);
      expect(timings.drawCalls).toBeLessThanOrEqual(DRAW_CALL_BUDGET);
      expect(timings.exchangeBytes).toBeLessThanOrEqual(PAYLOAD_BUDGET_BYTES);
    }, 60_000);
  }
});

/**
 * A pass-through proxy that can be told to swallow the next `/frame` request whole.
 *
 * The page's `inFlight` guard allows one exchange at a time, and `fetch` has no default timeout,
 * so a request that never settles never clears the guard: the page keeps animating the snapshot
 * it already has and silently stops talking to the server, forever, with no exception and nothing
 * in the console. That is indistinguishable from a frozen game, and it is the only way the guard
 * can latch. Serving the page *through* the proxy means its relative `/api/...` calls go through
 * it too, so this reproduces the failure exactly rather than approximating it.
 */
function stallingProxy(target: string): {
  server: Server;
  url: Promise<string>;
  stallNext(): void;
  stalled(): number;
} {
  let stall = false;
  let stalledCount = 0;
  const held: ServerResponse[] = [];

  const proxy = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (stall && (request.url ?? '').endsWith('/frame')) {
        stall = false;
        stalledCount++;
        // Held open and never answered: exactly the shape that latches the guard.
        held.push(response);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${target}${request.url ?? '/'}`, {
        method: request.method ?? 'GET',
        headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
        ...(body !== undefined && request.method === 'POST' ? { body } : {}),
      });
      const text = await upstream.text();
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'text/plain',
        'cache-control': 'no-store',
      });
      response.end(text);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  const url = new Promise<string>((done) => {
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done(`http://127.0.0.1:${port}`);
    });
  });

  return {
    server: proxy,
    url,
    stallNext(): void {
      stall = true;
    },
    stalled(): number {
      return stalledCount;
    },
  };
}

describe('a stalled frame request must not freeze the game', () => {
  it('recovers on its own after a request that never answers', async () => {
    const proxy = stallingProxy(server.url);
    const proxyUrl = await proxy.url;
    try {
      await closeAllPages(browser.port);
      const cdp = await openPage(browser.port, `${proxyUrl}/play/platformer`, VIEWPORT);
      await until<number>(cdp, 'globalThis.aegis ? globalThis.aegis.tick() : -1', (t) => t >= 0);
      await sleep(300);

      const read = async (): Promise<Timings> =>
        JSON.parse(await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())')) as
          Timings;

      const healthy = await read();
      // Precondition: the page is talking through the proxy at all. Without this, a page that
      // failed to boot would "recover" trivially.
      expect(healthy.snapshots).toBeGreaterThan(0);

      proxy.stallNext();
      // Give the page long enough to send the doomed request and sit on it. The page's own
      // timeout is 2s, so the stall is real and visible in between.
      await sleep(900);
      expect(proxy.stalled(), 'the proxy must actually have swallowed a request').toBe(1);
      const frozen = await read();
      expect(frozen.inFlight, 'the page must be waiting on the swallowed request').toBe(true);
      const frozenSnapshots = frozen.snapshots;

      // The whole assertion: the page comes back by itself, without a reload, without a click.
      const recovered = await until<number>(
        cdp,
        'globalThis.aegis.timings().snapshots',
        (count) => count > frozenSnapshots,
        15_000,
      );
      expect(recovered).toBeGreaterThan(frozenSnapshots);
      const after = await read();
      // And it recorded the failure rather than swallowing it: an instrument that recovered
      // silently would leave nobody able to tell a stall from a slow frame.
      expect(after.exchangeErrors).toBeGreaterThan(0);
      cdp.close();
    } finally {
      proxy.server.closeAllConnections();
      proxy.server.close();
    }
  }, 90_000);
});

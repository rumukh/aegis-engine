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

/**
 * Viewport used for every measurement, in CSS pixels.
 *
 * Deliberately **not** the capture's 1280x720. This browser rasterises in software, and the fps
 * page's frame rate there is strictly proportional to viewport area — measured 6.7fps at
 * 1280x720 and 26.0fps at 320x180, a 4x change for 4x the pixels. At the capture's size the
 * measurement below would be a measurement of SwiftShader's fill rate. At this size the page's
 * own per-frame work, which is what the assertions are about, is the part that varies.
 */
const VIEWPORT = { width: 640, height: 360 };

/**
 * How many displayed frames each measurement must collect before it is judged.
 *
 * Sampling for a fixed *duration* made this test's own preconditions flaky: on a loaded machine
 * one run collected 4 frames in 2.5s, and a p95 over four samples is not a p95. Sampling to a
 * fixed frame count instead keeps the statistic meaningful whatever the host is doing, and turns
 * "the page is impossibly slow" into an explicit timeout with a message rather than a percentile
 * computed from noise.
 */
const SAMPLE_FRAMES = 40;

/** How long to wait for {@link SAMPLE_FRAMES}, in milliseconds. */
const SAMPLE_TIMEOUT_MS = 30_000;

/**
 * How many frame exchanges each measurement must also see complete.
 *
 * Uncapped, the platformer page draws its 40 frames before two round trips have finished, so a
 * frame-count-only window would leave the "is it still talking to the server?" precondition
 * failing on the fastest page rather than the slowest.
 */
const SAMPLE_EXCHANGES = 5;

/**
 * Milliseconds of the page's **own bookkeeping** the slowest 5% of displayed frames may cost:
 * restoring the snapshot into the mirror world, reconciling the scene graph, updating the HUD.
 *
 * Stated at p95 rather than as a mean because the frames a human notices are the tail, not the
 * middle — a page averaging 2ms with one 40ms frame a second reads as a stutter, and a mean hides
 * it completely. That is not hypothetical: the fps page's mean work is 2.0ms and its p95 is
 * 39.6ms, and only the percentile sees it.
 *
 * **`renderer.render` is deliberately excluded, and the reason was measured.** Splitting the p95
 * by phase attributes that 39.6ms as `render 38.90` against `restore 0.30, sync 0.60, hud 0.10`
 * — and under this browser's software rasteriser `render` blocks on rasterisation, so it is a
 * measurement of SwiftShader and of how busy the machine is (one sample recorded a 953ms render
 * call). Asserting on it would produce exactly the coin-flip red that cannot attribute anything.
 * It is measured and printed instead.
 *
 * What remains — restore, sync, hud — is the page's own work. **The tight bound on it lives in
 * `frame-pacing.test.ts`**, which measures `restore + adapter.sync` at shipped level scale in
 * Node with no browser, no compositor and no GPU, and holds it to a 2ms median. That is the
 * machine-independent guard; this one is its counterpart in the real page, where a *page-loop*
 * regression the Node test cannot see — the frame callback doing its work more than once, say —
 * would show up.
 *
 * So the number here is deliberately loose: **25ms**. Measured p95 at shipped level scale is
 * 0.30-1.10ms on a quiet machine, but this is a browser on a box shared with other agents, and a
 * `verify` run where vitest itself reported 440s of setup produced **18.3ms for a phase that
 * costs 0.5ms in Node**. A bound tight enough to be satisfying would go red for machine load,
 * which is a red nobody can attribute — the exact failure mode this file exists to avoid. The
 * mutation that proves it is still a guard produces 75ms, so a 25ms ceiling keeps three times the
 * margin over the noise and still catches the regression class.
 *
 * Watched red by syncing the adapter forty times per displayed frame: 75.00ms, and the failure
 * message names the phase that spent it (`sync 74.80`) rather than restating the total.
 */
const PAGE_WORK_P95_BUDGET_MS = 25;

/**
 * Milliseconds between animation frames that the slowest 5% take — the number a human actually
 * feels, and the one the reported symptom was quoted in ("28.4fps, p95 40.4ms").
 *
 * **Measured and printed on every run; deliberately not asserted.** Two measurements say why, and
 * both are in this file's own harness rather than reasoned about:
 *
 * - Capped, headless Chrome paces a *blank* page at 30.0fps with a p95 gap of 60.1ms on this
 *   machine. A threshold under that cap would be a threshold on Chrome's virtual display.
 * - Uncapped (which is how this harness runs), a blank page reaches ~508fps with a p95 of 10.9ms
 *   — but the fps game's gap is then dominated by *software rasterisation*: 6.7fps at 1280x720
 *   against 26.0fps at 320x180, strictly proportional to pixel count. On one loaded run the fps
 *   page produced four frames in two and a half seconds.
 *
 * So a gap threshold here would be a threshold on SwiftShader and on how busy the machine is,
 * and it would go red for reasons no player would ever meet — the exact "coin-flip red that
 * cannot attribute anything" this project has already lost days to. The quantity underneath it
 * that the page *does* control is {@link FRAME_WORK_P95_BUDGET_MS}, which is asserted, and the
 * simulation's real-time fidelity is pinned exactly on a fake clock in `frame-pacing.test.ts`.
 *
 * This constant is the bound a run is compared against **in the printed report**, so the number
 * is visible and its trend is legible, without a red that nobody could act on. If this suite ever
 * runs on hardware with a real GPU, promoting this to an assertion is a one-line change and the
 * right one.
 */
const FRAME_GAP_P95_REPORTING_MS = 33.4;

/**
 * Draw calls one displayed frame may issue — **reported and bounded loosely, not a real guard.**
 *
 * The fps adapter draws one box per floorplan cell — a column for a solid cell, a floor slab
 * *and* a ceiling slab for a walkable one — so its draw-call count scales linearly with level
 * area. At the shipped 11x21 that is 337, and the measurement above puts submission at 1.40ms for
 * those 337 calls: **4.2µs each** on this machine.
 *
 * An earlier draft set this to 320 and justified it with a *guessed* 20-40µs per call, which
 * would have made draw calls the dominant frame cost. Measured, the guess was wrong by an order
 * of magnitude, and the guard it justified could not be made to fail: tripling the boxes drawn
 * per walkable cell — a rebuilt page, not just a rebuilt test — still holds every budget in this
 * file. A bound nobody can drive red is not a guard, so this one is deliberately loose and its
 * job is only to catch an order-of-magnitude accident.
 *
 * The load-bearing budget is {@link FRAME_WORK_BUDGET_MS}, which measures the time these calls
 * actually cost instead of counting them. If a level ever does need to be much bigger, the fix is
 * instancing — one `InstancedMesh` per visual role would take the whole floorplan to about five
 * calls — not a larger number here.
 */
const DRAW_CALL_BUDGET = 2000;

/**
 * Bytes of JSON one displayed frame may carry.
 *
 * The whole world crosses the wire every frame by design (the page holds a *different* world and
 * is structurally unable to write to the simulation's — see `protocol.ts`), and that design is
 * worth keeping. It is not worth keeping unmeasured: at 60fps, 24KB per frame is 1.4MB/s of JSON
 * to serialise, transfer, parse and garbage-collect. Measured at shipped level scale: platformer
 * 10.0KB, iso 2.6KB, fps 19.6KB — of which 17.5KB is the static extruded floorplan, re-sent every
 * frame because one door cell can change. That is the next thing to fix if this budget is hit.
 *
 * Watched red by making `POST /frame` carry a second copy of the world state: 37,320 bytes
 * against the 24,000 allowed.
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

/** The rolling per-frame sample window, as it crosses the CDP boundary. */
interface Samples {
  gaps: number[];
  work: number[];
  restore: number[];
  sync: number[];
  render: number[];
  hud: number[];
}

/** The `p`th percentile of `values`, or 0 for an empty list. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[at] as number;
}

/** One line of measured evidence per game, so a pass says how much headroom it just spent. */
function report(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`      ${line}`);
}

let server: DevServer;
let browser: LaunchedBrowser;
/** The environment's own frame pacing, measured once on a page that does nothing. */
let controlGapP95 = Number.NaN;
/** The raw control gaps, kept so the control test can assert the measurement happened. */
let controlGaps: number[] = [];

beforeAll(async () => {
  server = await startDevServer({ games: GAMES, port: 0, repoRoot: findRepoRoot() });
  browser = await launchBrowser({ port: 9335, viewport: VIEWPORT, uncapFrameRate: true });

  // Measured here rather than inside a test so every report below can print it, including when
  // the suite is run with a `-t` filter that would skip the control test itself. A number that
  // silently becomes NaN because a test did not run is the same shape of defect this file exists
  // to prevent, one level down.
  await closeAllPages(browser.port);
  const cdp = await openPage(browser.port, 'about:blank', VIEWPORT);
  await evaluate<null>(
    cdp,
    `globalThis.__gaps = [];
     globalThis.__last = 0;
     const tick = () => {
       const now = performance.now();
       if (globalThis.__last !== 0) globalThis.__gaps.push(now - globalThis.__last);
       globalThis.__last = now;
       globalThis.requestAnimationFrame(tick);
     };
     globalThis.requestAnimationFrame(tick);
     null`,
  );
  await sleep(3000);
  controlGaps = JSON.parse(
    await evaluate<string>(cdp, 'JSON.stringify(globalThis.__gaps)'),
  ) as number[];
  controlGapP95 = percentile(controlGaps, 95);
  cdp.close();
}, 90_000);

afterAll(async () => {
  browser?.process.kill();
  await server?.close();
});

/** Open a page, collect a fixed number of displayed frames, and return the measurements. */
async function sample(url: string): Promise<{
  cdp: CdpSession;
  timings: Timings;
  samples: Samples;
}> {
  await closeAllPages(browser.port);
  const cdp = await openPage(browser.port, url, VIEWPORT);
  await until<number>(cdp, 'globalThis.aegis ? globalThis.aegis.tick() : -1', (t) => t >= 0);
  await sleep(400);
  await evaluate<null>(cdp, 'globalThis.aegis.resetTimings(); null');
  const startedSnapshots = (
    JSON.parse(await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())')) as Timings
  ).snapshots;
  // Wait for *both*: enough frames for a percentile to mean something, and enough exchanges that
  // the page is demonstrably still talking to the server. Uncapped, the platformer page draws 40
  // frames before two round trips have completed, so a frame-count-only wait made the exchange
  // precondition below fail for a reason that had nothing to do with the page.
  await until<string>(
    cdp,
    'JSON.stringify([globalThis.aegis.samples().work.length, globalThis.aegis.timings().snapshots])',
    (value) => {
      const [frames, snapshots] = JSON.parse(value) as [number, number];
      return frames >= SAMPLE_FRAMES && snapshots >= startedSnapshots + SAMPLE_EXCHANGES;
    },
    SAMPLE_TIMEOUT_MS,
  );
  const timings = JSON.parse(
    await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())'),
  ) as Timings;
  const samples = JSON.parse(
    await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.samples())'),
  ) as Samples;
  return { cdp, timings, samples };
}

describe('the frame budget, measured in a real browser', () => {
  it('gives the probe a ceiling to measure against', () => {
    // Anti-vacuity for every test below: if a page doing nothing cannot animate, the numbers this
    // file reads mean nothing, and "no budget exceeded" would be indistinguishable from "the
    // browser never drew". It also records the environment's own pacing, which is what every
    // frame-gap number below has to be read against. Measured in `beforeAll` so the number is
    // available even when this test is filtered out.
    report(
      `control (blank page): ${(controlGaps.length / 3).toFixed(0)} fps, ` +
        `median gap ${percentile(controlGaps, 50).toFixed(1)}ms, p95 ${controlGapP95.toFixed(1)}ms`,
    );
    expect(controlGaps.length).toBeGreaterThan(10);
    // The measurements below are only meaningful if the host is not itself the limit. Capped,
    // this machine gives a blank page 30fps and a p95 gap of 60ms — a budget measured under that
    // would be a budget on Chrome's virtual display. Uncapped it is ~500fps and ~11ms.
    expect(controlGapP95).toBeLessThan(FRAME_GAP_P95_REPORTING_MS);
  });

  for (const game of GAMES) {
    it(`${game.id}: holds the per-frame budget`, async () => {
      const { cdp, timings, samples } = await sample(`${server.url}/play/${game.id}`);
      cdp.close();

      // Preconditions. Each one distinguishes "measured and fine" from "never measured": a page
      // that booted and then stopped, or one whose counters were never written, would otherwise
      // satisfy every budget below by reporting zero.
      expect(timings.frames, 'the page must have drawn frames').toBeGreaterThan(10);
      expect(timings.snapshots, 'the page must have fetched snapshots').toBeGreaterThanOrEqual(
        SAMPLE_EXCHANGES,
      );
      expect(timings.drawCalls, 'the renderer must have drawn something').toBeGreaterThan(0);
      expect(timings.exchangeBytes, 'a snapshot must have crossed the wire').toBeGreaterThan(0);
      // Not zero errors: the page abandons an exchange that takes longer than its own 2s timeout,
      // and on a loaded machine a legitimate fps exchange has been measured at 1.1s. One abandoned
      // request costs one frame and the loop retries — that is the timeout doing its job, not a
      // broken page. What would invalidate the measurement is a page failing *most* of its
      // exchanges, so the precondition is a ratio.
      expect(
        timings.snapshots,
        `snapshots must dominate failures (saw ${timings.exchangeErrors} errors)`,
      ).toBeGreaterThan(timings.exchangeErrors * 5);
      // A percentile over a handful of samples is not a percentile. sample waits for this
      // count, so falling short means the page could not produce 40 frames in 30 seconds --
      // which is a frame-budget failure in its own right and should be read as one.
      expect(
        samples.work.length,
        'the page must have produced enough frames for a percentile to mean anything',
      ).toBeGreaterThanOrEqual(SAMPLE_FRAMES);

      // The page's own bookkeeping, excluding the GPU-bound submit. See the constant's docblock.
      const pageWork = samples.restore.map(
        (value, at) => value + (samples.sync[at] ?? 0) + (samples.hud[at] ?? 0),
      );
      const pageWorkP95 = percentile(pageWork, 95);
      const phases =
        `restore ${percentile(samples.restore, 95).toFixed(2)} + sync ` +
        `${percentile(samples.sync, 95).toFixed(2)} + hud ` +
        `${percentile(samples.hud, 95).toFixed(2)}`;
      // Printed unconditionally, pass or fail. A threshold test that prints nothing tells the
      // next person nothing about how much headroom they just spent.
      report(
        `${game.id.padEnd(11)} page work p95 ${pageWorkP95.toFixed(2)}ms (${phases}) · ` +
          `render p95 ${percentile(samples.render, 95).toFixed(2)}ms [GPU-bound, reporting only]` +
          ` · gap p95 ${percentile(samples.gaps, 95).toFixed(1)}ms [reporting only; control ` +
          `${controlGapP95.toFixed(1)}ms, bound ${FRAME_GAP_P95_REPORTING_MS}ms] · ` +
          `${timings.drawCalls} draws · ${timings.exchangeBytes}B · ` +
          `exchange ${timings.exchange.toFixed(1)}ms`,
      );

      expect(pageWorkP95, `page bookkeeping p95: ${phases}`).toBeLessThanOrEqual(
        PAGE_WORK_P95_BUDGET_MS,
      );
      expect(timings.drawCalls).toBeLessThanOrEqual(DRAW_CALL_BUDGET);
      expect(timings.exchangeBytes).toBeLessThanOrEqual(PAYLOAD_BUDGET_BYTES);
    }, 90_000);
  }
});

describe('the simulation must still be advancing when the human looks away', () => {
  for (const game of GAMES) {
    it(`${game.id}: is still ticking after ${SAMPLE_FRAMES} displayed frames`, async () => {
      await closeAllPages(browser.port);
      const cdp = await openPage(browser.port, `${server.url}/play/${game.id}`, VIEWPORT);
      await until<number>(cdp, 'globalThis.aegis ? globalThis.aegis.tick() : -1', (t) => t >= 0);
      const before = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
      const started = Date.now();
      await evaluate<null>(cdp, 'globalThis.aegis.resetTimings(); null');
      // Wait on *exchanges*, not only on frames: this test's claim is about the exchange loop, and
      // a window of 40 frames can contain a single round trip on a fast page or on a loaded box.
      // Asserting that the tick moved over a window that contained one exchange is a coin flip;
      // over a window that contained several it is the property.
      await until<string>(
        cdp,
        'JSON.stringify([globalThis.aegis.samples().work.length, globalThis.aegis.timings().snapshots])',
        (value) => {
          const [frames, snapshots] = JSON.parse(value) as [number, number];
          return frames >= SAMPLE_FRAMES && snapshots >= SAMPLE_EXCHANGES;
        },
        SAMPLE_TIMEOUT_MS,
      );
      const after = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
      const timings = JSON.parse(
        await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())'),
      ) as Timings;
      cdp.close();
      const seconds = (Date.now() - started) / 1000;
      report(
        `${game.id.padEnd(11)} ${after - before} ticks over ${seconds.toFixed(1)}s ` +
          `(${((after - before) / seconds).toFixed(1)}/s), ${timings.snapshots} snapshots`,
      );
      // The claim, exactly as the acceptance definition asks it: after a run of stated length,
      // the exchange is still going round and the world the human is watching has moved.
      expect(after).toBeGreaterThan(before);
      expect(timings.snapshots).toBeGreaterThan(0);
      // Same ratio reasoning as the budget test: an abandoned slow request is the timeout working.
      expect(timings.snapshots).toBeGreaterThan(timings.exchangeErrors * 5);
      // Deliberately no *rate* assertion. Ticks per wall-clock second here is a function of how
      // fast this software rasteriser can paint — the printed line shows it, and
      // `frame-pacing.test.ts` pins the accumulator's real-time fidelity exactly, on a fake
      // clock, where a loaded machine cannot turn a real property into a coin flip.
    }, 90_000);
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
  rejectNext(count: number): void;
  stalled(): number;
  rejected(): number;
} {
  let stall = false;
  let rejectsLeft = 0;
  let stalledCount = 0;
  let rejectedCount = 0;
  const held: ServerResponse[] = [];

  const proxy = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const isFrame = (request.url ?? '').endsWith('/frame');
      if (stall && isFrame) {
        stall = false;
        stalledCount++;
        // Held open and never answered: exactly the shape that latches the guard.
        held.push(response);
        return;
      }
      if (rejectsLeft > 0 && isFrame) {
        rejectsLeft--;
        rejectedCount++;
        // A settled *failure*, which is the other half of the guard's contract: `.finally` must
        // clear `inFlight` on the error path too, or one bad response freezes the game for good.
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":"injected"}');
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
    rejectNext(count: number): void {
      rejectsLeft = count;
    },
    stalled(): number {
      return stalledCount;
    },
    rejected(): number {
      return rejectedCount;
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
        JSON.parse(
          await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())'),
        ) as Timings;

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

  it('resumes after a run of exchanges that are refused outright', async () => {
    // The other half of the guard's contract, and the cheaper failure to cause: a *settled*
    // rejection. `exchange()` is chained `.catch(...).finally(...)`, so this path is supposed to
    // clear `inFlight` — but "supposed to" is what the whole reopened criterion is about. A
    // server restart, a dropped wifi connection or a 5xx from a proxy all look like this, and if
    // the loop did not resume the game would be dead until the human reloaded.
    const proxy = stallingProxy(server.url);
    const proxyUrl = await proxy.url;
    try {
      await closeAllPages(browser.port);
      const cdp = await openPage(browser.port, `${proxyUrl}/play/iso`, VIEWPORT);
      await until<number>(cdp, 'globalThis.aegis ? globalThis.aegis.tick() : -1', (t) => t >= 0);
      await sleep(300);

      const read = async (): Promise<Timings> =>
        JSON.parse(
          await evaluate<string>(cdp, 'JSON.stringify(globalThis.aegis.timings())'),
        ) as Timings;

      const healthy = await read();
      expect(
        healthy.snapshots,
        'the page must be exchanging before anything is broken',
      ).toBeGreaterThan(0);
      const tickBefore = await evaluate<number>(cdp, 'globalThis.aegis.tick()');

      proxy.rejectNext(25);
      await until<number>(cdp, 'globalThis.aegis.timings().exchangeErrors', (n) => n >= 5, 15_000);
      // Precondition: the failures were real and were seen. Without this, a proxy that never
      // refused anything would make "the page recovered" a statement about nothing.
      expect(proxy.rejected(), 'the proxy must actually have refused requests').toBeGreaterThan(4);

      const failing = await read();
      const snapshotsAtFailure = failing.snapshots;

      const recovered = await until<number>(
        cdp,
        'globalThis.aegis.timings().snapshots',
        (count) => count > snapshotsAtFailure,
        15_000,
      );
      const tickAfter = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
      report(
        `refused ${proxy.rejected()} exchanges; page recovered to ${recovered} snapshots, ` +
          `tick ${tickBefore} -> ${tickAfter}`,
      );
      expect(recovered).toBeGreaterThan(snapshotsAtFailure);
      // Liveness, not just plumbing: the simulation is advancing again, which is what a human
      // would check. A page that resumed fetching but never advanced would pass the line above.
      expect(tickAfter).toBeGreaterThan(tickBefore);
      cdp.close();
    } finally {
      proxy.server.closeAllConnections();
      proxy.server.close();
    }
  }, 90_000);
});

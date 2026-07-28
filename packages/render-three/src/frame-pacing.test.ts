/**
 * **Frame pacing: does a slow picture make a slow game?**
 *
 * The human's report was "all 3 are very slow and laggy". Frame rate alone cannot explain that —
 * the simulation is supposed to keep true wall-clock time no matter how rarely the page draws.
 * It did not, and the reason was two constants that disagreed:
 *
 * - `dev-server.ts` hands the accumulator up to `MAX_FRAME_SECONDS` (0.25s) of elapsed time;
 * - `loop.ts` defaulted to **8** steps per frame, which at 60Hz is 0.133s, and *discards* the
 *   remainder rather than carrying it (`if (accumulator >= dt) accumulator = 0`).
 *
 * So every displayed frame slower than 133ms threw away the difference, silently, with no error
 * and no event. Measured on `/play/fps` in a headless browser at ~6.5fps: **42.5 simulated ticks
 * per wall-clock second against a 60Hz simulation** — the game played at 71% speed and got slower
 * the worse the frame rate got, which is exactly the compounding "laggy" a human describes.
 *
 * These tests drive the real server through a *fake* clock, so the pacing is asserted exactly
 * rather than raced. They are the deterministic half of the frame budget; the browser-facing half
 * is `browser-playability.test.ts`.
 * @packageDocumentation
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, hashString } from '@aegis/core';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin, LookState } from '@aegis/mode-fps';
import { createRenderAdapter } from './adapters/index.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { MAX_CATCHUP_SECONDS, maxStepsFor } from './loop.js';
import { createLiveSession } from './session.js';
import { BINDINGS } from './bindings.js';
import type { GameDefinition } from './catalog.js';
import { FPS_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';
import {
  FPS_BUDGET_SCENE,
  ISO_BUDGET_SCENE,
  PLATFORMER_BUDGET_SCENE,
} from './testing/budget-scenes.js';

/** Fixed ticks per second every PoC runs at. */
const TICK_RATE = 60;

/**
 * The longest displayed-frame gap the simulation must still keep true time across, in seconds.
 *
 * This is the number the two constants have to agree on. It is `dev-server.ts`'s
 * `MAX_FRAME_SECONDS`; beyond it, dropping time is the deliberate anti-spiral behaviour and the
 * final test below pins how much gets dropped.
 */
const CLAMP_SECONDS = MAX_CATCHUP_SECONDS;

/** A catalogue of one platformer game, served with an injectable clock. */
const GAME: GameDefinition = {
  id: 'platformer',
  title: 'Test Platformer',
  blurb: 'a side-on test level',
  objective: 'reach the goal',
  mode: 'platformer',
  plugin: platformerPlugin,
  scene: PLATFORMER_SCENE,
  bindings: BINDINGS.platformer,
};

let server: DevServer | undefined;
let now = 0;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Start the server on an ephemeral port with a clock this file drives. */
async function start(): Promise<DevServer> {
  now = 0;
  server = await startDevServer({ games: [GAME], port: 0, clock: () => now });
  return server;
}

/** Advance the fake clock by `seconds` and post one frame, as a displayed frame would. */
async function displayedFrame(url: string, seconds: number, seq: number): Promise<void> {
  now += seconds;
  const response = await fetch(`${url}/api/platformer/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { seq } }),
  });
  expect(response.status).toBe(200);
  await response.json();
}

/**
 * The first request is what creates the session, and the server stamps `lastFrameAt` at that
 * moment — so it can never earn any ticks and would otherwise skew every count below by one
 * frame's worth of clock.
 */
async function prime(url: string): Promise<void> {
  await displayedFrame(url, 0, 1);
}

describe('a slow picture must not make a slow game', () => {
  it('loses no simulated time across displayed frames slower than the old 8-step cap', async () => {
    const live = await start();
    await prime(live.url);
    // Gaps chosen to straddle the old cap (8 ticks = 133ms) while staying inside the server's own
    // 250ms clamp: a pattern like this is what a 6-8fps page produces. Fixed, not random, so a
    // failure is reproducible.
    const gaps = [0.14, 0.2, 0.16, 0.24, 0.15, 0.22, 0.18, 0.135, 0.21, 0.17];

    // Anti-vacuity: this test is worthless unless the gaps actually exceed the old cap. If a
    // future edit tames them, say so here rather than reporting a pass nobody can interpret.
    const oldCapSeconds = 8 / TICK_RATE;
    expect(gaps.every((gap) => gap > oldCapSeconds)).toBe(true);
    expect(gaps.every((gap) => gap <= CLAMP_SECONDS)).toBe(true);

    let seq = 1;
    for (const gap of gaps) await displayedFrame(live.url, gap, ++seq);

    const elapsed = gaps.reduce((total, gap) => total + gap, 0);
    const session = live.session('platformer');
    expect(session).toBeDefined();
    // Whole ticks only; the accumulator carries the remainder, so the shortfall is under one tick.
    const expected = Math.floor(elapsed * TICK_RATE);
    expect(session?.tick).toBeGreaterThanOrEqual(expected);
    expect(session?.tick).toBeLessThanOrEqual(expected + 1);
  });

  it('drops time only beyond the clamp, and drops exactly what the clamp says', async () => {
    const live = await start();
    await prime(live.url);
    // One frame far slower than the clamp. Dropping here is deliberate — the alternative is the
    // page freezing while it catches up — so the test pins *how much*, which is the part that
    // must not drift.
    await displayedFrame(live.url, 2, 2);
    const session = live.session('platformer');
    expect(session?.tick).toBe(Math.round(CLAMP_SECONDS * TICK_RATE));
  });

  it('sizes the accumulator cap from the clamp, so the two cannot disagree again', () => {
    // The defect was two independently chosen constants. This is the arithmetic that makes the
    // first test above true for *any* tick rate, asserted directly so a future edit to either
    // number is caught here with an explanation rather than as a mysterious slow-motion bug.
    expect(maxStepsFor(TICK_RATE)).toBeGreaterThanOrEqual(CLAMP_SECONDS * TICK_RATE);
    expect(maxStepsFor(120)).toBeGreaterThanOrEqual(CLAMP_SECONDS * 120);
    expect(maxStepsFor(1)).toBeGreaterThanOrEqual(1);
  });
});

describe('one displayed frame of rendering work, without a browser', () => {
  /**
   * Milliseconds the *median* frame spends rebuilding the mirror world and reconciling the scene
   * graph — the two halves of a displayed frame that are pure computation.
   *
   * **Reported, not asserted.** This number was the assertion until it was measured properly. An
   * absolute wall-clock bound in a shared 16-way-parallel Node process is a bound on how busy the
   * box is, and this package has now had five reds that were about the machine: the browser
   * page-work budget read 17.7ms then 40.1ms for a phase that costs 0.5ms, and a 12ms p95 ceiling
   * here went red twice during a full `verify`. Measured medians at shipped level scale:
   * platformer 0.23ms, iso 0.18ms, fps 0.56ms — an eighth of a 60Hz frame at worst.
   *
   * The guard is now the ratio against {@link machineSpeedControl}, because only a ratio means
   * the same thing on a 2-vCPU runner as it does here. Kept as a printed number because the
   * absolute cost is what a reader actually wants to know.
   */
  const FRAME_COST_MEDIAN_BUDGET_MS = 2;
  /**
   * And a much looser bound on the tail — **reported, not asserted.**
   *
   * The tail here is garbage collection, not computation: every iteration rebuilds a whole
   * `World` from a snapshot and reconciles a few hundred meshes, and this loop does it as fast as
   * the machine allows rather than once per animation frame. Measured p95 across many runs:
   * 0.30, 0.34, 0.53, 0.95, 2.02, 2.98, 4.17, 4.89, 5.20, 6.68, 7.02, 7.61 — and **12.46 and
   * 17.26 during a full 62-file `verify`**, which is where a 12ms ceiling went red twice for
   * reasons that were about the machine and not the adapter.
   *
   * By the standard this package already applied to its draw-call budget: a bound nobody can
   * drive red *independently* is not a guard. Every mutation that moves this tail moves the
   * median too, and the median is asserted. So this is a printed number with a reference line,
   * and the guard is {@link FRAME_COST_MEDIAN_BUDGET_MS} — which held in every run above,
   * including the ones where the tail did not.
   *
   * The allocation churn behind it is the same finding the payload budget records, and it has the
   * same fix: the page rebuilds the entire world every frame because the whole world is what
   * crosses the wire.
   */
  const FRAME_COST_P95_REFERENCE_MS = 12;
  /** Iterations per case. Enough that one descheduled sample cannot move the percentile. */
  const ITERATIONS = 200;

  /**
   * A fixed unit of pure computation, interleaved with the measurement above.
   *
   * It exists to give the frame cost a denominator. An absolute millisecond bound asserted in a
   * shared Node process is a bound on how fast the machine is that day; a ratio against a
   * workload measured in the same loop cancels the machine out — which is the only form that
   * means the same thing on a 2-vCPU runner as on this box.
   *
   * `hashString` is core's frozen FNV-1a: no allocation, no I/O, no dependency on anything in
   * this package, so nothing a change to `restore` or `sync` does can move it.
   *
   * Measured across three baseline runs on the same box — twice alone, once inside a 67-file
   * `vitest run` — and then against the frame loop doing its work 2×, 3× and 4× per frame:
   *
   * | mode       | baseline (3 runs) | 2×   | 3×       | 4×       | bound | headroom |
   * | ---------- | ----------------- | ---- | -------- | -------- | ----- | -------- |
   * | platformer | 0.19 0.21 0.24    | 0.30 | 0.42     | **0.57** | 0.45  | 1.9×     |
   * | iso        | 0.15 0.15 0.18    | 0.23 | 0.28     | **0.34** | 0.32  | 1.8×     |
   * | fps        | 0.43 0.47 0.53    | 0.94 | **1.40** | **1.66** | 0.95  | 1.8×     |
   *
   * Bold is a red. So this catches a 3× regression on fps and a 4× one on the other two, and it
   * does **not** catch a doubling. That is a weaker guarantee than the one I first wrote here,
   * and the reason is worth keeping: **running `restore` and `sync` twice per frame does not cost
   * twice as much.** It costs +25% (platformer), +28% (iso) and +77% (fps), because the second
   * pass finds the world already built and the scene graph already correct. "Walks the world
   * twice" is not a 2× regression in the measurement, so a bound that caught 2× would not have
   * been catching that defect either — it would just have been tighter.
   *
   * The bound is squeezed from both sides and they nearly meet, which is why it is stated rather
   * than chosen. Below ~1.8× it reds on noise: the third baseline run came in 13–20% above the
   * first with no code change. Above ~2× it stops seeing anything. A window that narrow is only
   * affordable because the machine is cancelled out — the same window in milliseconds would be a
   * coin flip on a 2-vCPU runner, which is how the 12ms ceiling that used to live here went red
   * twice for reasons that had nothing to do with the adapter.
   */
  function machineSpeedControl(): void {
    for (let i = 0; i < 200; i++) hashString(`aegis-frame-pacing-control-${i}`);
  }

  const CASES = [
    { mode: 'platformer', plugin: platformerPlugin, scene: PLATFORMER_BUDGET_SCENE, ratio: 0.45 },
    { mode: 'iso', plugin: isoPlugin, scene: ISO_BUDGET_SCENE, ratio: 0.32 },
    { mode: 'fps', plugin: fpsPlugin, scene: FPS_BUDGET_SCENE, ratio: 0.95 },
  ] as const;

  for (const testCase of CASES) {
    it(`${testCase.mode}: restoring and reconciling a shipped-size level stays inside budget`, () => {
      const session = createLiveSession({ scene: testCase.scene, plugin: testCase.plugin });
      for (let i = 0; i < 60; i++) session.step();
      const snapshot = session.snapshot();
      const mirror = createWorld({ seed: 0 });
      mirror.restore(snapshot);
      const adapter = createRenderAdapter(testCase.mode);
      adapter.mount(mirror);

      // Warm up: the first pass allocates every mesh in the level, which is not a frame cost.
      for (let i = 0; i < 40; i++) {
        mirror.restore(snapshot);
        adapter.sync(mirror);
      }

      const samples: number[] = [];
      const controls: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const started = performance.now();
        mirror.restore(snapshot);
        adapter.sync(mirror);
        samples.push(performance.now() - started);
        // Interleaved in the same loop, the same process and the same run: a fixed workload
        // that depends on the machine and on nothing in this package. Its only job is to give
        // the number above a denominator.
        const controlStarted = performance.now();
        machineSpeedControl();
        controls.push(performance.now() - controlStarted);
      }
      // Read the scene before disposing it: `dispose` clears the scene, so an assertion about
      // what was drawn has to happen while it is still there.
      const drawn = adapter.scene.children.length;
      adapter.dispose();

      // Anti-vacuity: an empty snapshot, or an adapter that built nothing, would sail through the
      // budget below while measuring nothing at all. Deliberately mode-agnostic — iso actors
      // carry `GridPosition` and no `Transform`, so a check for one component would silently
      // hold for the wrong reason on one of the three.
      expect(samples).toHaveLength(ITERATIONS);
      expect(snapshot.entities.length).toBeGreaterThan(0);
      expect(mirror.snapshot().entities.length).toBe(snapshot.entities.length);
      expect(drawn).toBeGreaterThan(0);

      const sorted = [...samples].sort((a, b) => a - b);
      const controlSorted = [...controls].sort((a, b) => a - b);
      const controlMedian = controlSorted[Math.floor(controlSorted.length * 0.5)] as number;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] as number;
      const median = sorted[Math.floor(sorted.length * 0.5)] as number;

      console.log(
        `      ${testCase.mode.padEnd(11)} restore+sync median ${median.toFixed(3)}ms, ` +
          `p95 ${p95.toFixed(3)}ms [reporting only; reference ${FRAME_COST_P95_REFERENCE_MS}ms], ` +
          `control ${controlMedian.toFixed(3)}ms, ratio ${(median / controlMedian).toFixed(2)}x ` +
          `[asserted <= ${String(testCase.ratio)}x; absolute reference ${FRAME_COST_MEDIAN_BUDGET_MS}ms] over ${ITERATIONS} frames`,
      );
      expect(median).toBeLessThanOrEqual(testCase.ratio * controlMedian);
      // Reported, not asserted: the absolute figure the ratio is derived from, so a reader can
      // see the real cost without recomputing it, and so the historical numbers in
      // FRAME_COST_MEDIAN_BUDGET_MS stay comparable.
      expect(median).toBeGreaterThan(0);
    });
  }
});

describe('one displayed frame of mouse motion belongs to every tick it covers', () => {
  it('spreads an accumulated look delta evenly across the batch instead of lurching', () => {
    const session = createLiveSession({ scene: FPS_SCENE, plugin: fpsPlugin });
    const view = () =>
      session.world
        .query({ has: [LookState] })
        .one()
        .get(LookState);

    // One displayed frame's worth of mouse motion: 30 degrees of yaw, arriving as one packet.
    session.input.submit({ seq: 1, look: { dx: 30, dy: 0 } });
    const before = view().yawDeg;
    // Ten ticks of wall-clock earned by that frame.
    const steps = session.advance(10 / TICK_RATE);
    expect(steps).toBe(10);
    expect(view().yawDeg - before).toBeCloseTo(30, 6);

    // The total is only half the claim. The point is that the rotation happened *gradually*: run
    // it again a tick at a time and check the camera is a tenth of the way round after one tick,
    // not all the way. Without that, dumping the lot on tick 0 would pass the line above.
    const fresh = createLiveSession({ scene: FPS_SCENE, plugin: fpsPlugin });
    const freshLook = () =>
      fresh.world
        .query({ has: [LookState] })
        .one()
        .get(LookState);
    fresh.input.submit({ seq: 1, look: { dx: 30, dy: 0 } });
    fresh.input.spreadLookOver(10);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      fresh.step();
      samples.push(freshLook().yawDeg);
    }
    expect(samples[0]).toBeCloseTo(3, 6);
    expect(samples[4]).toBeCloseTo(15, 6);
    expect(samples[9]).toBeCloseTo(30, 6);
  });

  it('leaves the single-tick path the screenshot capture drives exactly as it was', () => {
    // `LiveSession.step` never spreads: the capture pauses the session and steps it explicitly,
    // one tick per input change, so a scripted playthrough must reach the same state as before.
    const session = createLiveSession({ scene: FPS_SCENE, plugin: fpsPlugin });
    const look = () =>
      session.world
        .query({ has: [LookState] })
        .one()
        .get(LookState);
    session.input.submit({ seq: 1, look: { dx: 90, dy: 0 } });
    session.step();
    expect(look().yawDeg).toBeCloseTo(90, 6);
  });
});

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
import { platformerPlugin } from '@aegis/mode-platformer';
import { fpsPlugin, LookState } from '@aegis/mode-fps';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { MAX_CATCHUP_SECONDS, maxStepsFor } from './loop.js';
import { createLiveSession } from './session.js';
import { BINDINGS } from './bindings.js';
import type { GameDefinition } from './catalog.js';
import { FPS_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';

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

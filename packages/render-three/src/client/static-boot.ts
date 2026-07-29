/**
 * The **static** page entry point: run the simulation in the browser, with no server behind it.
 *
 * `./boot.ts` is the dev-server client. It owns no simulation at all — every displayed frame it
 * posts the human's input to `POST /api/<id>/frame` and renders the `WorldSnapshot` that comes
 * back. That is the right shape for `npm run play`, and it is unshippable to GitHub Pages, which
 * serves files and runs nothing. A page built from `./pages.ts` and uploaded unchanged would
 * *look* deployed: it would load, paint its HUD, and then fail every exchange forever.
 *
 * So this module moves the session into the page. Nothing else moves with it:
 *
 * - the simulation is the same {@link createLiveSession} the dev server runs — same base component
 *   registry, same `instantiateScene`, same `plugin.init()` before tick 0, same schedule from
 *   `plugin.systems()`, same fixed-step accumulator;
 * - input takes the same path a human's keyboard already takes — {@link createInputCollector}
 *   emits {@link InputPacket}s and {@link LiveInput} turns them into the very `InputFrame`s the
 *   `.input` DSL compiles to. There is still no second, privileged input route;
 * - **the renderer still cannot reach the simulation's world.** Every frame the page takes
 *   `session.snapshot()` — plain JSON, CHARTER principle 4 — and restores it into a separate,
 *   throwaway mirror `World` that the adapter draws. The adapter is handed the mirror and never
 *   the live world, exactly as when the two lived in different processes. Co-locating them in one
 *   realm does not weaken ADR-0005's boundary, because the boundary was never the process
 *   boundary; it was the snapshot.
 *
 * What genuinely changes is that the wall clock is now read in the page rather than in the server,
 * and a frame costs a `snapshot()` + `restore()` instead of a round trip. Neither is visible to
 * the simulation: it still only ever sees `dt = 1 / tickRate`.
 * @packageDocumentation
 */
import { Vector3, WebGLRenderer } from 'three';
import { createWorld } from '@aegis/core';
import type { GameEvent, GameMode, World, WorldSnapshot } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import type { ModePlugin } from '@aegis/harness';
import { createRenderAdapter } from '../adapters/index.js';
import type { RenderAdapter } from '../adapter.js';
import { BINDINGS } from '../bindings.js';
import { systemClock, MAX_CATCHUP_SECONDS } from '../loop.js';
import type { Clock } from '../loop.js';
import { createLiveSession } from '../session.js';
import type { LiveSession } from '../session.js';
import type { EventLine } from '../protocol.js';
import { createInputCollector } from './input.js';
import { createHud } from './hud.js';

/** Everything the static page needs to start a game. Assembled by the generated play page. */
export interface StaticBootConfig {
  /** URL slug of the game, e.g. `"iso"`. Used only for diagnostics. */
  gameId: string;
  /** The mode whose adapter draws it and whose bindings drive it. */
  mode: GameMode;
  /** The **composed** plugin: the mode's systems plus the game's own. */
  plugin: ModePlugin;
  /** The parsed scene document, embedded in the page. */
  scene: SceneFile;
  /** Seed override. Defaults to the scene's. */
  seed?: number | string;
  /** Fixed ticks per second. Defaults to `60`. */
  tickRate?: number;
  /** The canvas to draw into. Defaults to `#stage`. */
  canvas?: HTMLCanvasElement;
  /** Wall clock, in seconds. Injectable so a test can drive frames without a real clock. */
  clock?: Clock;
}

/**
 * The read-only introspection handle the page hangs on `globalThis.aegis`.
 *
 * Deliberately narrower than `./boot.ts`'s: it exposes the **mirror** and the last snapshot, and
 * has no accessor for the `LiveSession` or its `World`. That is not shyness about a debug surface
 * — it is the same boundary the renderer obeys, applied to everything that observes the page. A
 * test that could reach the live world could also write to it, and an automated check that can
 * perturb the thing it measures is worth less than one that cannot.
 */
export interface StaticDebugHandle {
  /** The mirror world the renderer draws; a copy, never the simulation's world. */
  readonly world: World;
  /** The live adapter. */
  readonly adapter: RenderAdapter;
  /** The tick the mirror world currently represents. */
  tick(): number;
  /** Fixed simulation steps taken since boot (or since the last restart). */
  steps(): number;
  /** Animation frames rendered since boot. */
  frames(): number;
  /** Whether the session is paused. */
  paused(): boolean;
  /** The last snapshot applied to the mirror — the world as plain JSON. */
  snapshot(): WorldSnapshot | null;
  /** Every event the run has emitted, oldest first. */
  events(): readonly EventLine[];
  /** Project a world point to canvas pixels, or `null` when it is behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /**
   * Resolve once input **collected after this call** has been submitted to the session.
   *
   * The same contract `./boot.ts` offers, for the same reason: automation that wants tick-exact
   * input has to know its key events landed before it asks the simulation to advance. Here the
   * submission is synchronous, so the waiter settles on the next animation frame — but it must
   * still be the *next* one, never the frame whose packet was drained before the events arrived.
   */
  sync(): Promise<void>;
}

/** The wall-clock ceiling one displayed frame may convert into simulation. */
const MAX_FRAME_SECONDS = MAX_CATCHUP_SECONDS;

/** Flatten recorded events into the HUD feed shape. */
function toEventLines(events: readonly GameEvent[]): EventLine[] {
  return events.map((event) => ({ type: event.type, tick: event.tick }));
}

/**
 * Boot a self-contained game page. Returns the same handle it publishes as `globalThis.aegis`.
 *
 * Returning it as well as publishing it is what lets `static-site.test.ts` drive this module under
 * vitest without a browser: the global is a convenience for a human at a devtools prompt, not the
 * only way to reach the page's state.
 */
export function bootStatic(config: StaticBootConfig): StaticDebugHandle {
  const canvas =
    config.canvas ?? (document.getElementById('stage') as HTMLCanvasElement | null) ?? null;
  if (canvas === null) throw new Error('[aegis:render-three] missing <canvas id="stage">');

  const mode = config.mode;
  const clock = config.clock ?? systemClock;
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

  const adapter: RenderAdapter = createRenderAdapter(mode);
  // The renderer's own copy of the world, rebuilt from JSON every frame. Never the session's.
  const mirror: World = createWorld({ seed: 0 });
  const hud = createHud();

  const session: LiveSession = createLiveSession({
    scene: config.scene,
    plugin: config.plugin,
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.tickRate !== undefined ? { tickRate: config.tickRate } : {}),
  });

  let mounted = false;
  let lastTick = -1;
  let steps = 0;
  let frames = 0;
  let lastFrameAt = clock();
  let eventCursor = 0;
  let lastSnapshot: WorldSnapshot | null = null;
  let framesThisSecond = 0;
  let fps = 0;
  let fpsWindowStart = clock();
  /** Waiters registered by {@link StaticDebugHandle.sync}, settled by the next frame's drain. */
  let syncWaiters: (() => void)[] = [];

  const resize = (): void => {
    const width = canvas.clientWidth || globalThis.innerWidth;
    const height = canvas.clientHeight || globalThis.innerHeight;
    renderer.setSize(width, height, false);
    adapter.resize(width, height);
  };

  const collector = createInputCollector({
    canvas,
    bindings: BINDINGS[mode],
    pick: (x, y) => {
      // Aim the camera at the mirror's current state before unprojecting through it. See the
      // long note on the same call in `./boot.ts`: the iso camera follows an integer cell, and a
      // click resolved through a camera one tick stale lands on a different cell entirely.
      if (mounted) adapter.sync(mirror);
      return adapter.pick(x, y);
    },
    onCommand: (command) => {
      if (command === 'pause') session.paused = !session.paused;
      else if (command === 'step') {
        // `step()` advances regardless of `paused`, which is what single-stepping means.
        session.step();
        steps++;
      } else if (command === 'restart') {
        session.restart();
        steps = 0;
        eventCursor = 0;
        hud.pushEvents([]);
      }
      lastFrameAt = clock();
    },
  });

  const applySnapshot = (snapshot: WorldSnapshot): void => {
    mirror.restore(snapshot);
    lastSnapshot = snapshot;
    if (!mounted) {
      adapter.mount(mirror);
      mounted = true;
      resize();
    }
    lastTick = snapshot.tick;
  };

  /** Drain the events the session has emitted since the last frame, for the HUD feed. */
  const drainEvents = (): EventLine[] => {
    const history = session.world.events.history();
    const fresh = history.slice(eventCursor);
    eventCursor = history.length;
    return toEventLines(fresh);
  };

  const frame = (): void => {
    globalThis.requestAnimationFrame(frame);
    frames++;

    // Claim the waiters registered before this collection: their events are in this packet.
    const settling = syncWaiters;
    syncWaiters = [];
    session.input.submit(collector.take());
    for (const resolve of settling) resolve();

    // Wall-clock in, whole fixed ticks out. The simulation never sees a variable dt. The clamp is
    // the dev server's, derived from the accumulator's own budget so the two cannot disagree.
    const now = clock();
    const elapsed = Math.min(Math.max(now - lastFrameAt, 0), MAX_FRAME_SECONDS);
    lastFrameAt = now;
    steps += session.advance(elapsed);

    applySnapshot(session.snapshot());
    hud.pushEvents(drainEvents());

    adapter.sync(mirror);
    renderer.render(adapter.scene, adapter.camera);

    framesThisSecond++;
    if (now - fpsWindowStart >= 0.5) {
      fps = framesThisSecond / (now - fpsWindowStart);
      framesThisSecond = 0;
      fpsWindowStart = now;
    }
    hud.setStatus(lastTick, session.paused, fps);
    hud.setStats(mode, mirror);
  };

  globalThis.addEventListener('resize', resize);
  globalThis.addEventListener('beforeunload', () => {
    collector.dispose();
    adapter.dispose();
    renderer.dispose();
  });

  const debug: StaticDebugHandle = {
    world: mirror,
    adapter,
    tick: () => lastTick,
    steps: () => steps,
    frames: () => frames,
    paused: () => session.paused,
    snapshot: () => lastSnapshot,
    events: () => toEventLines(session.world.events.history()),
    project(x: number, y: number, z: number): { x: number; y: number } | null {
      if (mounted) adapter.sync(mirror);
      const ndc = new Vector3(x, y, z).project(adapter.camera);
      if (ndc.z > 1) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + ((ndc.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      };
    },
    sync(): Promise<void> {
      return new Promise<void>((resolve) => syncWaiters.push(resolve));
    },
  };
  (globalThis as unknown as { aegis: StaticDebugHandle }).aegis = debug;

  resize();
  globalThis.requestAnimationFrame(frame);
  return debug;
}

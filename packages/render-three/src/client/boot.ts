/**
 * The page entry point: render the simulation a human is playing.
 *
 * The loop is deliberately one-way. Every displayed frame the page posts the human's input and
 * receives a `WorldSnapshot`; it rebuilds a **local, throwaway** `World` from that JSON and hands
 * it to the render adapter. The simulation lives in the dev-server process and is stepped there
 * on a fixed timestep — the page cannot reach it, and the renderer cannot write to it.
 *
 * Frame pacing and network latency therefore change *how often* the picture updates and nothing
 * else: the tick rate, the ordering and the state hash are identical to a headless run.
 * @packageDocumentation
 */
import { Vector3, WebGLRenderer } from 'three';
import { createWorld } from '@aegis/core';
import type { GameMode, World, WorldSnapshot } from '@aegis/core';
import { createRenderAdapter } from '../adapters/index.js';
import type { RenderAdapter } from '../adapter.js';
import { BINDINGS } from '../bindings.js';
import type { BootConfig, ControlCommand, FrameResponse } from '../protocol.js';
import { createInputCollector } from './input.js';
import type { SessionCommand } from './input.js';
import { createHud } from './hud.js';

/**
 * Where a displayed frame's wall-clock went, in milliseconds.
 *
 * The page used to report only its frame rate, which is an *outcome*: 28fps against a 60Hz
 * simulation is a fact nothing could attribute, so nobody could act on it. These are the
 * quantities underneath it, each measured around the call that incurs it, so a budget failure
 * names the phase that blew it instead of restating the frame rate.
 *
 * `gap` is the interval between consecutive animation frames — the number a human actually feels.
 * The others are pieces of the work done inside one; `exchange` is wall-clock the *network* took
 * and is deliberately not part of the frame's own budget, because the exchange is not awaited.
 */
export interface FrameTimings {
  /** Animation frames observed since boot. */
  frames: number;
  /** Snapshots applied since boot. Fewer than `frames` once render and exchange are decoupled. */
  snapshots: number;
  /** Milliseconds between the last two animation frames. */
  gap: number;
  /** Mean `gap` over the whole sampling window. */
  meanGap: number;
  /** Worst `gap` seen since the last {@link AegisDebugHandle.resetTimings}. */
  worstGap: number;
  /** Last `mirror.restore(snapshot)`. */
  restore: number;
  /** Last `adapter.sync(mirror)`. */
  sync: number;
  /** Last `renderer.render(scene, camera)`. */
  render: number;
  /** Last HUD update. */
  hud: number;
  /** Last full `POST /frame` round trip, including `response.json()`. */
  exchange: number;
  /** Bytes of JSON in the last frame response. */
  exchangeBytes: number;
  /** Draw calls issued by the last `renderer.render`. */
  drawCalls: number;
  /** Triangles submitted by the last `renderer.render`. */
  triangles: number;
  /** Exchanges that failed since boot. A latched loop shows up here, or as a stalled `snapshots`. */
  exchangeErrors: number;
  /** Whether an exchange is outstanding right now. */
  inFlight: boolean;
}

/**
 * A rolling window of per-frame samples, newest last.
 *
 * `FrameTimings` reports the *last* frame, which cannot answer "how bad does it get?". A budget
 * has to be stated at a percentile or it says nothing about the frames a human notices — those are
 * the tail, not the median. Ten seconds at 60Hz is 600 frames, which is enough for a p95 to mean
 * something and small enough to keep in a page that must not allocate per frame.
 */
export interface FrameSamples {
  /** Milliseconds between consecutive animation frames. */
  gaps: readonly number[];
  /** Milliseconds of main-thread work inside each of those frames. */
  work: readonly number[];
  /** The `restore` component of each entry in `work`. */
  restore: readonly number[];
  /** The `sync` component of each entry in `work`. */
  sync: readonly number[];
  /** The `render` component of each entry in `work`. */
  render: readonly number[];
  /** The `hud` component of each entry in `work`. */
  hud: readonly number[];
}

/**
 * The debug handle the page hangs on `globalThis`. It is read-only introspection over what is
 * already on screen — the adapter's scene/camera and the renderer's mirror world — so a human (or
 * an automated capture run) can ask "where is that on screen?" without a devtools breakpoint.
 */
export interface AegisDebugHandle {
  /** The mirror world the renderer draws; a copy, never the simulation's world. */
  readonly world: World;
  /** The live adapter. */
  readonly adapter: RenderAdapter;
  /** The tick the mirror world currently represents. */
  tick(): number;
  /** Per-phase frame costs. See {@link FrameTimings}. */
  timings(): FrameTimings;
  /** The rolling window of per-frame samples. See {@link FrameSamples}. */
  samples(): FrameSamples;
  /** Start a fresh sampling window for {@link FrameTimings.meanGap} and `worstGap`. */
  resetTimings(): void;
  /** Project a world point to canvas pixels, or `null` when it is behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /**
   * Resolve once an input packet **collected after this call** has been accepted by the server.
   *
   * Automation that wants tick-exact input needs to know its key events actually landed before it
   * asks the simulation to step. Polling a counter cannot answer that — a packet already in
   * flight was collected *before* the events. So the waiter is registered here and only settled
   * by an exchange whose `collector.take()` ran strictly afterwards.
   */
  sync(): Promise<void>;
}

/** Map a keyboard session command onto the wire command. */
const COMMANDS: Readonly<Record<SessionCommand, ControlCommand>> = {
  pause: 'toggle',
  step: 'step',
  restart: 'restart',
};

/**
 * How long one frame exchange may take before the page abandons it, in milliseconds.
 *
 * The frame loop guards `exchange()` with an `inFlight` flag so only one request is outstanding.
 * `fetch` has **no default timeout**, so a request that never settles never clears that flag: the
 * page keeps animating the last snapshot it received and silently stops talking to the server,
 * forever, with no exception and nothing in the console. That is indistinguishable from a frozen
 * game, and it is the only way the guard can latch. Abandoning the request restores the loop on
 * the very next animation frame.
 *
 * 2000ms is far longer than any healthy exchange (measured: 8-80ms locally, worst case a whole
 * `MAX_FRAME_SECONDS` catch-up batch) and far shorter than a human's patience.
 */
const FRAME_TIMEOUT_MS = 2000;

/** Post JSON and parse the JSON response, abandoning the request if it stalls. */
async function postJson<T>(url: string, body: unknown): Promise<{ value: T; bytes: number }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  // Read the text rather than `response.json()` so the payload size is a measured fact: the
  // whole world crosses this wire every frame, and nothing else in the page can see how big it is.
  const text = await response.text();
  return { value: JSON.parse(text) as T, bytes: text.length };
}

/** Boot the renderer for one game. Called by the served page. */
export function boot(config: BootConfig): void {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  if (canvas === null) throw new Error('[aegis:render-three] missing <canvas id="stage">');

  const mode = config.mode as GameMode;
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

  const adapter: RenderAdapter = createRenderAdapter(mode);
  // The renderer's own copy of the world, rebuilt from JSON every frame.
  const mirror: World = createWorld({ seed: 0 });
  const hud = createHud();

  let mounted = false;
  let lastTick = -1;
  let paused = false;
  let inFlight = false;
  let framesThisSecond = 0;
  let fps = 0;
  let fpsWindowStart = performance.now();
  /** Waiters registered by {@link AegisDebugHandle.sync}, settled by the next exchange. */
  let syncWaiters: (() => void)[] = [];

  /** Mutable accumulator behind {@link AegisDebugHandle.timings}. */
  const timings: FrameTimings = {
    frames: 0,
    snapshots: 0,
    gap: 0,
    meanGap: 0,
    worstGap: 0,
    restore: 0,
    sync: 0,
    render: 0,
    hud: 0,
    exchange: 0,
    exchangeBytes: 0,
    drawCalls: 0,
    triangles: 0,
    exchangeErrors: 0,
    inFlight: false,
  };
  let lastFrameAt = 0;
  let windowStart = performance.now();
  let windowFrames = 0;
  /** How many frames the rolling sample window holds: ten seconds at 60Hz. */
  const SAMPLE_WINDOW = 600;
  const gapSamples: number[] = [];
  const workSamples: number[] = [];
  const restoreSamples: number[] = [];
  const syncSamples: number[] = [];
  const renderSamples: number[] = [];
  const hudSamples: number[] = [];
  /** Append to a bounded ring, dropping the oldest. Never allocates a new array. */
  const record = (into: number[], value: number): void => {
    into.push(value);
    if (into.length > SAMPLE_WINDOW) into.shift();
  };

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
      // Aim the camera at the mirror's current state before unprojecting through it — the same
      // freshness `AegisDebugHandle.project` needs, in the opposite direction. `applySnapshot`
      // runs in the exchange's continuation and updates the mirror *without* syncing, so between
      // a snapshot arriving and the next animation frame the camera is one world behind. A click
      // in that window is unprojected through a camera aimed at a world that no longer exists.
      //
      // Measured in a live page while the operative walked the map: over 60 samples the camera
      // was identical before and after a forced sync (0.0000 world units), so this window is
      // narrow and was never observed to bite — the iso camera follows an *integer* cell, so it
      // only moves when the actor crosses a cell boundary. The hole is structural rather than
      // observed, and it is closed here because the cost is one sync per click: `pick` is invoked
      // only from the collector's mousedown handler, never on pointer movement.
      if (mounted) adapter.sync(mirror);
      return adapter.pick(x, y);
    },
    onCommand: (command) => {
      void postJson(`${config.api}/control`, { command: COMMANDS[command] }).catch(() => undefined);
    },
  });

  const applySnapshot = (snapshot: WorldSnapshot): void => {
    const t0 = performance.now();
    mirror.restore(snapshot);
    timings.restore = performance.now() - t0;
    timings.snapshots++;
    if (!mounted) {
      adapter.mount(mirror);
      mounted = true;
      resize();
    }
    lastTick = snapshot.tick;
  };

  const exchange = async (): Promise<void> => {
    // Claim the waiters registered before this collection: their events are in this packet.
    const settling = syncWaiters;
    syncWaiters = [];
    const started = performance.now();
    try {
      const { value: response, bytes } = await postJson<FrameResponse>(`${config.api}/frame`, {
        input: collector.take(),
      });
      timings.exchange = performance.now() - started;
      timings.exchangeBytes = bytes;
      paused = response.paused;
      applySnapshot(response.snapshot);
      hud.pushEvents(response.events);
      for (const resolve of settling) resolve();
    } catch (error) {
      timings.exchange = performance.now() - started;
      timings.exchangeErrors++;
      // A failed exchange never delivered the input, so put the waiters back rather than
      // resolving them — otherwise automation would step on input the server never saw.
      syncWaiters.push(...settling);
      throw error;
    }
  };

  const frame = (): void => {
    globalThis.requestAnimationFrame(frame);
    const frameStart = performance.now();
    if (lastFrameAt !== 0) {
      timings.gap = frameStart - lastFrameAt;
      if (timings.gap > timings.worstGap) timings.worstGap = timings.gap;
      record(gapSamples, timings.gap);
    }
    lastFrameAt = frameStart;
    timings.frames++;
    windowFrames++;
    timings.meanGap = windowFrames > 1 ? (frameStart - windowStart) / (windowFrames - 1) : 0;

    if (!inFlight) {
      inFlight = true;
      timings.inFlight = true;
      void exchange()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
          timings.inFlight = false;
        });
    }
    if (!mounted) return;

    const t1 = performance.now();
    adapter.sync(mirror);
    const t2 = performance.now();
    renderer.render(adapter.scene, adapter.camera);
    const t3 = performance.now();
    timings.sync = t2 - t1;
    timings.render = t3 - t2;
    timings.drawCalls = renderer.info.render.calls;
    timings.triangles = renderer.info.render.triangles;

    framesThisSecond++;
    const now = performance.now();
    if (now - fpsWindowStart >= 500) {
      fps = (framesThisSecond * 1000) / (now - fpsWindowStart);
      framesThisSecond = 0;
      fpsWindowStart = now;
    }
    hud.setStatus(lastTick, paused, fps);
    hud.setStats(mode, mirror);
    timings.hud = performance.now() - t3;
    // The frame's own cost: everything between the snapshot arriving and the HUD being written.
    // `restore` happens in the exchange continuation rather than here, so it is added rather than
    // measured across this span — leaving it out would understate the frames that carry one.
    record(workSamples, timings.restore + timings.sync + timings.render + timings.hud);
    record(restoreSamples, timings.restore);
    record(syncSamples, timings.sync);
    record(renderSamples, timings.render);
    record(hudSamples, timings.hud);
  };

  globalThis.addEventListener('resize', resize);
  globalThis.addEventListener('beforeunload', () => {
    collector.dispose();
    adapter.dispose();
    renderer.dispose();
  });

  const debug: AegisDebugHandle = {
    world: mirror,
    adapter,
    tick: () => lastTick,
    timings: () => ({ ...timings }),
    samples: () => ({
      gaps: [...gapSamples],
      work: [...workSamples],
      restore: [...restoreSamples],
      sync: [...syncSamples],
      render: [...renderSamples],
      hud: [...hudSamples],
    }),
    resetTimings(): void {
      windowStart = performance.now();
      windowFrames = 0;
      timings.worstGap = 0;
      timings.meanGap = 0;
      for (const list of [
        gapSamples,
        workSamples,
        restoreSamples,
        syncSamples,
        renderSamples,
        hudSamples,
      ]) {
        list.length = 0;
      }
    },
    project(x: number, y: number, z: number): { x: number; y: number } | null {
      // Aim the camera at the mirror's current state before measuring against it. The frame loop
      // does this once per animation frame; under load those frames are scarce, and a caller
      // asking `where is that cell on screen?` must not be answered from a camera aimed at an
      // older world. Measured: 7 of 14 scripted clicks projected to a different pixel without it.
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
  (globalThis as unknown as { aegis: AegisDebugHandle }).aegis = debug;

  resize();
  globalThis.requestAnimationFrame(frame);
}

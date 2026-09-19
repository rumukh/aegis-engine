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
import { Vector3 } from 'three';
import { createWorld } from '@aegis/core';
import type { GameMode, World, WorldSnapshot } from '@aegis/core';
import type { RenderAdapter } from '../adapter.js';
import { BINDINGS } from '../bindings.js';
import type { BootConfig, ControlCommand, FrameResponse } from '../protocol.js';
import { assertEventHistory } from '../protocol.js';
import { createInputCollector } from '../input.js';
import type { SessionCommand } from './input.js';
import { gamepadCursor, gamepadStatus } from './gamepad-cursor.js';
import { PresentationHost } from './presentation-host.js';

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
  /** Resolves only after real assets and the first world snapshot have mounted. */
  readonly ready: Promise<void>;
  presentation(): object;
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
  if (!response.ok)
    throw new Error(
      `${url} responded ${response.status}: ${(await response.text()).slice(0, 600)}`,
    );
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
  const host = new PresentationHost({
    canvas,
    mode,
    objective: config.objective,
    ...(config.presentation === undefined ? {} : { presentation: config.presentation }),
    ...(config.tickRate === undefined ? {} : { tickRate: config.tickRate }),
    onCommand: sendCommand,
    onGameplayBlocked: (blocked) => collector.setGameplayBlocked(blocked),
  });
  const renderer = host.renderer;
  let adapter: RenderAdapter;
  // The renderer's own copy of the world, rebuilt from JSON every frame.
  const mirror: World = createWorld({ seed: 0 });
  const hud = host.hud;

  let mounted = false;
  let lastTick = -1;
  let paused = false;
  const clientId =
    typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : [...globalThis.crypto.getRandomValues(new Uint32Array(4))]
          .map((value) => value.toString(16).padStart(8, '0'))
          .join('-');
  let inputGeneration: number | null = null;
  let claimInput = false;
  let inFlight = false;
  let frameExchange: Promise<void> | undefined;
  let pauseBarrier: Promise<void> | undefined;
  let generation = 0;
  let hydratedGeneration: number | null = null;
  let stopped = false;
  let animationFrame = 0;
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
  let renderedGeneration = -1;
  const hudSamples: number[] = [];
  const exchangeSamples: number[] = [];
  /** Append to a bounded ring, dropping the oldest. Never allocates a new array. */
  const record = (into: number[], value: number): void => {
    into.push(value);
    if (into.length > SAMPLE_WINDOW) into.shift();
  };

  const resize = (): void => {
    const width = canvas.clientWidth || globalThis.innerWidth;
    const height = canvas.clientHeight || globalThis.innerHeight;
    host.resize(width, height);
  };

  function sendCommand(command: SessionCommand): void {
    // Keep the current loading/failure explanation intact until a real world exists.
    if (!mounted) return;
    const send = async (): Promise<void> => {
      if (stopped) return;
      const responseGeneration = generation + (command === 'restart' ? 1 : 0);
      const { value: response } = await postJson<FrameResponse>(`${config.api}/control`, {
        command: COMMANDS[command],
      });
      acceptResponse(response, responseGeneration, 'control');
    };
    if (command !== 'pause' && pauseBarrier === undefined) {
      void send().catch((error: unknown) => host.connection(error));
      return;
    }
    // A paused key tap must not arrive after the server resumes, even if its acknowledgement
    // is delayed. Drain the preceding frame first, then hold new exchanges behind this boundary.
    collector.clear();
    const preceding = pauseBarrier ?? frameExchange;
    const pending = (preceding === undefined ? send() : preceding.then(send))
      .catch((error: unknown) => host.connection(error))
      .finally(() => {
        if (pauseBarrier !== pending) return;
        collector.clear();
        pauseBarrier = undefined;
      });
    pauseBarrier = pending;
  }

  const collector = createInputCollector({
    canvas,
    bindings: config.bindings ?? BINDINGS[mode],
    pick: (x, y) => {
      // Aim the camera at the mirror's current state before unprojecting through it — the same
      // freshness `AegisDebugHandle.project` needs, in the opposite direction. `applySnapshot`
      // runs in the exchange's continuation and updates the mirror *without* syncing, so between
      // a snapshot arriving and the next animation frame the camera is one world behind. A click
      // in that window is unprojected through a camera aimed at a world that no longer exists.
      //
      // Measured, by forcing the condition rather than sampling for it (see
      // iso-pick.test.ts). The iso camera follows an *integer* cell, so it does not drift -- it
      // jumps a whole world unit when the actor crosses a boundary, and it does that on only 2
      // of 240 ticks in the test vault. On the ticks it does NOT move, a stale camera is exactly
      // the fresh one. On the ticks it does, a camera one tick behind resolved 357 of 361 screen
      // points to a DIFFERENT cell, displaced by up to 3 cells.
      //
      // An earlier note here said this window was "never observed to bite", on the strength of 60
      // live samples that found 0.0000 world units of camera displacement. Those samples were
      // right and the conclusion was wrong: at 2 moving ticks in 240 a 60-sample sweep expects to
      // miss the condition, so it measured how rare the window is and not what happens inside it.
      // Sampling an outcome cannot establish its absence.
      //
      // The cost of closing it is one sync per click: `pick` is invoked only from the
      // collector's mousedown handler, never on pointer movement.
      if (!mounted) return null;
      adapter.sync(mirror);
      return adapter.pick(x, y);
    },
    onCommand: sendCommand,
    onControlIntent: (claim) => {
      claimInput = claim;
    },
    onCaptureState: (state) => host.captureInput(state),
    onGamepadPointer: gamepadCursor(canvas),
    onGamepadSample: gamepadStatus(),
  });

  const applySnapshot = (snapshot: WorldSnapshot): void => {
    const t0 = performance.now();
    try {
      mirror.restore(snapshot);
      timings.restore = performance.now() - t0;
      timings.snapshots++;
      if (!mounted) {
        host.validateWorld(mirror);
        adapter.mount(mirror);
        mounted = true;
        resize();
      }
      lastTick = snapshot.tick;
    } catch (error) {
      stopped = true;
      globalThis.cancelAnimationFrame(animationFrame);
      host.fail(error);
      throw error;
    }
  };

  const acceptResponse = (
    response: FrameResponse,
    fallbackGeneration: number,
    source: 'frame' | 'control',
  ): boolean => {
    const incomingGeneration = response.generation ?? fallbackGeneration;
    if (stopped || incomingGeneration < generation) return false;
    const needsHistory =
      config.presentation !== undefined && hydratedGeneration !== incomingGeneration;
    let history: FrameResponse['eventHistory'];
    if (source === 'frame' && needsHistory) {
      if (response.eventHistory === undefined)
        throw new Error(
          '[aegis] The frame omitted required presentation history; retrying hydration.',
        );
      if (response.tick !== response.snapshot.tick)
        throw new Error('[aegis] Presentation history and snapshot ticks disagree.');
      assertEventHistory(response.eventHistory, response.tick);
      let boundary = response.eventHistory.length;
      if (hydratedGeneration !== null && response.events.length > 0) {
        const first = response.events[0]!.sequence;
        if (
          first === undefined ||
          !Number.isSafeInteger(first) ||
          first < 0 ||
          first > boundary ||
          response.events.length !== boundary - first ||
          response.events.some((event, index) => event.sequence !== first + index)
        )
          throw new Error('[aegis] Fresh events do not match the presentation history suffix.');
        // A cold page is silent; a continuing page retains new-generation live feedback.
        boundary = first;
      }
      history = response.eventHistory.slice(0, boundary);
    }
    if (incomingGeneration > generation) {
      generation = incomingGeneration;
      collector.clear();
      host.reset(generation);
      claimInput = false;
      lastTick = -1;
    }
    // Control and frame replies can arrive in either order within the same generation.
    if (response.tick >= lastTick) {
      paused = response.paused;
      collector.setPaused(paused);
      applySnapshot(response.snapshot);
    }
    inputGeneration = generation;
    if (response.inputStatus !== undefined) host.inputStatus(response.inputStatus);
    if (history !== undefined) {
      adapter.sync(mirror);
      host.hydrate(history, generation, lastTick);
      hydratedGeneration = generation;
    }
    // An older frame can still carry events that a newer non-draining control reply omitted.
    host.receive(response.events, generation);
    if (config.presentation === undefined || hydratedGeneration === generation) {
      host.mounted();
      host.connection();
    }
    return true;
  };

  const exchange = async (): Promise<void> => {
    // Claim the waiters registered before this collection: their events are in this packet.
    const settling = syncWaiters;
    syncWaiters = [];
    const started = performance.now();
    const requestGeneration = generation;
    const claim = claimInput;
    claimInput = false;
    try {
      const { value: response, bytes } = await postJson<FrameResponse>(`${config.api}/frame`, {
        input: collector.take(),
        client: { id: clientId, claim, generation: inputGeneration },
        ...(config.presentation === undefined
          ? {}
          : { presentationGeneration: hydratedGeneration }),
      });
      if (stopped) return;
      timings.exchange = performance.now() - started;
      record(exchangeSamples, timings.exchange);
      timings.exchangeBytes = bytes;
      if (!acceptResponse(response, requestGeneration, 'frame')) {
        syncWaiters.push(...settling);
        return;
      }
      for (const resolve of settling) resolve();
    } catch (error) {
      timings.exchange = performance.now() - started;
      timings.exchangeErrors++;
      host.connection(error);
      // A failed exchange never delivered the input, so put the waiters back rather than
      // resolving them — otherwise automation would step on input the server never saw.
      syncWaiters.push(...settling);
      throw error;
    }
  };

  const frame = (): void => {
    if (stopped) return;
    animationFrame = globalThis.requestAnimationFrame(frame);
    const frameStart = performance.now();
    if (lastFrameAt !== 0) {
      timings.gap = frameStart - lastFrameAt;
      if (timings.gap > timings.worstGap) timings.worstGap = timings.gap;
      record(gapSamples, timings.gap);
    }
    collector.poll(lastFrameAt === 0 ? 0 : (frameStart - lastFrameAt) / 1000);
    lastFrameAt = frameStart;
    timings.frames++;
    windowFrames++;
    timings.meanGap = windowFrames > 1 ? (frameStart - windowStart) / (windowFrames - 1) : 0;

    // A cold cinematic draw can compile many shaders synchronously. Do not arm a network
    // deadline immediately before that draw blocks the main thread.
    const coldCinematic =
      config.presentation?.manifest.pipeline !== undefined &&
      mounted &&
      hydratedGeneration === generation &&
      renderedGeneration !== generation;
    if (!inFlight && pauseBarrier === undefined && !coldCinematic) {
      inFlight = true;
      timings.inFlight = true;
      frameExchange = exchange()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
          timings.inFlight = false;
          frameExchange = undefined;
        });
    }
    if (!mounted || (config.presentation !== undefined && hydratedGeneration !== generation))
      return;

    const t1 = performance.now();
    try {
      adapter.sync(mirror);
      host.present(lastTick, paused);
    } catch (error) {
      stopped = true;
      globalThis.cancelAnimationFrame(animationFrame);
      host.fail(error);
      return;
    }
    const t2 = performance.now();
    try {
      host.render();
      renderedGeneration = generation;
    } catch (error) {
      stopped = true;
      globalThis.cancelAnimationFrame(animationFrame);
      host.fail(error);
      return;
    }
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
    stopped = true;
    globalThis.cancelAnimationFrame(animationFrame);
    globalThis.removeEventListener('resize', resize);
    collector.dispose();
    host.dispose();
  });

  const debug: AegisDebugHandle = {
    ready: host.ready,
    presentation: () => host.stats(),
    world: mirror,
    get adapter() {
      return host.adapter;
    },
    tick: () => lastTick,
    timings: () => ({ ...timings }),
    samples: () => ({
      gaps: [...gapSamples],
      work: [...workSamples],
      restore: [...restoreSamples],
      sync: [...syncSamples],
      render: [...renderSamples],
      hud: [...hudSamples],
      exchange: [...exchangeSamples],
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
        exchangeSamples,
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

  host.start(() => {
    adapter = host.adapter;
    resize();
    animationFrame = globalThis.requestAnimationFrame(frame);
  });
}

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
  /** First failed exchange, retained across recovery so a zero-error assertion has a cause. */
  firstExchangeFailure?: {
    stage: 'request' | 'body' | 'parse' | 'response';
    responseStatus?: number;
    message: string;
    name: string;
    elapsedMs: number;
    requestSequence?: number;
    requestGeneration: number;
    generation: number;
    tick: number;
    renderedGeneration: number;
    lastRenderMs: number;
    longestRenderWhilePendingMs: number;
  };
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
   * Resolve after a subsequent input receipt, or presentation for a passive observer.
   *
   * Automation that wants tick-exact input needs to know its key events actually landed before it
   * asks the simulation to step. Polling a counter cannot answer that — a packet already in
   * flight was collected *before* the events. So the waiter is registered here and only settled
   * by an exchange whose `collector.take()` ran strictly afterwards. Passive observers can
   * synchronize snapshots without claiming control. Rejected, cancelled or delivery-ambiguous
   * fresh or held input rejects the barrier; it is never replayed under a new sequence.
   * Active held input settles at its receipt, not after drawing could expire its lease.
   * Neutral observer/restart snapshots pass through adapter.sync and host.present, including UI resets.
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
async function postJson<T>(
  url: string,
  body: unknown,
  progress?: (stage: 'body' | 'parse', status: number) => void,
): Promise<{ value: T; bytes: number }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
  });
  progress?.('body', response.status);
  if (!response.ok)
    throw new Error(
      `${url} responded ${response.status}: ${(await response.text()).slice(0, 600)}`,
    );
  // Read the text rather than `response.json()` so the payload size is a measured fact: the
  // whole world crosses this wire every frame, and nothing else in the page can see how big it is.
  const text = await response.text();
  progress?.('parse', response.status);
  return { value: JSON.parse(text) as T, bytes: text.length };
}

/** Boot the renderer for one game. Called by the served page. */
export function boot(config: BootConfig): void {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  if (canvas === null) throw new Error('[aegis:render-three] missing <canvas id="stage">');

  const mode = config.mode as GameMode;
  let presentationInputReset = false;
  const host = new PresentationHost({
    canvas,
    mode,
    objective: config.objective,
    ...(config.presentation === undefined ? {} : { presentation: config.presentation }),
    ...(config.tickRate === undefined ? {} : { tickRate: config.tickRate }),
    onCommand: sendCommand,
    onGameplayBlocked: (blocked) => {
      presentationInputReset = true;
      try {
        collector.setGameplayBlocked(blocked);
      } finally {
        presentationInputReset = false;
      }
    },
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
  let exchangeTask: ReturnType<typeof globalThis.setTimeout> | undefined;
  const cancelExchangeTask = (): void => {
    if (exchangeTask === undefined) return;
    globalThis.clearTimeout(exchangeTask);
    exchangeTask = undefined;
  };
  let frameExchange: Promise<void> | undefined;
  let pendingExchangeProfile: { longestRenderMs: number } | undefined;
  let pauseBarrier: Promise<void> | undefined;
  let generation = 0;
  let hydratedGeneration: number | null = null;
  let stopped = false;
  let animationFrame = 0;
  let framesThisSecond = 0;
  let fps = 0;
  let fpsWindowStart = performance.now();
  /** Waiters registered by {@link AegisDebugHandle.sync}, settled by the next exchange. */
  type SyncWaiter = {
    resolve(): void;
    reject(error: unknown): void;
    needsInput: boolean;
  };
  let syncWaiters: SyncWaiter[] = [];
  let presentationWaiters: {
    waiter: SyncWaiter;
    generation: number;
    tick: number;
  }[] = [];
  let inputEpoch = 0;
  let intentRevision = 0;
  let acceptedRevision = 0;
  let inputFailure: Error | undefined;
  let previousLevels = '';
  const rejectSync = (error: unknown): void => {
    cancelExchangeTask();
    const pending = syncWaiters;
    syncWaiters = [];
    for (const waiter of pending) waiter.reject(error);
    const presented = presentationWaiters;
    presentationWaiters = [];
    for (const { waiter } of presented) waiter.reject(error);
  };

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
      if (claim) {
        intentRevision++;
        return;
      }
      cancelExchangeTask();
      inputEpoch++;
      intentRevision = acceptedRevision = 0;
      inputFailure = undefined;
      previousLevels = '';
      const pending = syncWaiters;
      syncWaiters = [];
      for (const waiter of pending) {
        if (waiter.needsInput)
          waiter.reject(new Error('[aegis] Input synchronization cancelled by an input reset.'));
        else syncWaiters.push(waiter);
      }
      if (!presentationInputReset) {
        const accepted = presentationWaiters;
        presentationWaiters = [];
        for (const entry of accepted) {
          if (entry.waiter.needsInput)
            entry.waiter.reject(
              new Error('[aegis] Input synchronization cancelled by an input reset.'),
            );
          else presentationWaiters.push(entry);
        }
      }
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
    const requestEpoch = inputEpoch;
    const collectedRevision = intentRevision;
    const claim = claimInput;
    let freshInput = claim;
    let activeLevels = false;
    claimInput = false;
    let requestSequence: number | undefined;
    let stage: 'request' | 'body' | 'parse' | 'response' = 'request';
    let responseStatus: number | undefined;
    const profile = { longestRenderMs: 0 };
    pendingExchangeProfile = profile;
    try {
      const packet = collector.take();
      requestSequence = packet.seq;
      activeLevels =
        (packet.held?.length ?? 0) > 0 ||
        Object.values(packet.axes ?? {}).some((value) => value !== 0);
      const levels = JSON.stringify({ held: packet.held ?? [], axes: packet.axes ?? {} });
      freshInput ||=
        (packet.look?.dx ?? 0) !== 0 ||
        (packet.look?.dy ?? 0) !== 0 ||
        packet.pointer != null ||
        (packet.reset !== true &&
          ((packet.pressed?.length ?? 0) > 0 ||
            (packet.released?.length ?? 0) > 0 ||
            (previousLevels !== '' && levels !== previousLevels)));
      previousLevels = levels;
      for (const waiter of settling) waiter.needsInput ||= freshInput || activeLevels;
      const { value: response, bytes } = await postJson<FrameResponse>(
        `${config.api}/frame`,
        {
          input: packet,
          client: { id: clientId, claim, generation: inputGeneration },
          ...(config.presentation === undefined
            ? {}
            : { presentationGeneration: hydratedGeneration }),
        },
        (nextStage, status) => {
          stage = nextStage;
          responseStatus = status;
        },
      );
      stage = 'response';
      if (stopped) throw new Error('[aegis] Input synchronization cancelled by page disposal.');
      timings.exchange = performance.now() - started;
      record(exchangeSamples, timings.exchange);
      timings.exchangeBytes = bytes;
      const resetBeforeReply = requestEpoch !== inputEpoch;
      const acceptedInput =
        !resetBeforeReply &&
        requestGeneration === generation &&
        (response.generation ?? requestGeneration) === requestGeneration &&
        response.inputStatus?.accepted === true &&
        response.inputStatus.lastSeq === requestSequence;
      const current = acceptResponse(response, requestGeneration, 'frame');
      if ((freshInput || activeLevels) && resetBeforeReply) {
        // A proven lifecycle reset cancels the barrier, not the successful HTTP exchange.
        for (const waiter of settling)
          waiter.reject(new Error('[aegis] Input synchronization cancelled by an input reset.'));
        return;
      }
      if ((freshInput || activeLevels) && (!current || !acceptedInput)) {
        throw new Error(
          `[aegis] Input packet ${requestSequence} was not accepted in its input context ` +
            `(${response.inputStatus?.reason ?? 'missing acceptance status'}). ` +
            'Fresh input was not replayed; reset the input context before synchronizing again.',
        );
      }
      if (!current) {
        syncWaiters.push(...settling);
        return;
      }
      if (freshInput && requestEpoch === inputEpoch)
        acceptedRevision = Math.max(acceptedRevision, collectedRevision);
      if (inputFailure !== undefined) host.connection(inputFailure);
      for (const waiter of settling) {
        if (inputFailure !== undefined) waiter.reject(inputFailure);
        else if (activeLevels) waiter.resolve();
        else presentationWaiters.push({ waiter, generation, tick: lastTick });
      }
    } catch (error) {
      timings.exchange = performance.now() - started;
      timings.exchangeErrors++;
      timings.firstExchangeFailure ??= {
        stage,
        ...(responseStatus === undefined ? {} : { responseStatus }),
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : typeof error,
        elapsedMs: timings.exchange,
        ...(requestSequence === undefined ? {} : { requestSequence }),
        requestGeneration,
        generation,
        tick: lastTick,
        renderedGeneration,
        lastRenderMs: timings.render,
        longestRenderWhilePendingMs: profile.longestRenderMs,
      };
      host.connection(error);
      if (freshInput || activeLevels) {
        const failure = new Error(
          `[aegis] Input synchronization failed for packet ${requestSequence}: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            'Delivery may already have occurred; the packet will not be replayed.',
          { cause: error },
        );
        for (const waiter of settling) waiter.reject(failure);
        if (requestEpoch === inputEpoch) {
          inputFailure = failure;
          rejectSync(failure);
        }
      } else if (stopped) {
        for (const waiter of settling) waiter.reject(error);
      } else {
        // A passive snapshot barrier may wait for recovery; it promises no gameplay delivery.
        syncWaiters.push(...settling);
      }
      throw error;
    } finally {
      if (pendingExchangeProfile === profile) pendingExchangeProfile = undefined;
    }
  };

  const startExchange = (): void => {
    if (stopped || inFlight || pauseBarrier !== undefined) return;
    inFlight = true;
    timings.inFlight = true;
    frameExchange = exchange()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        timings.inFlight = false;
        frameExchange = undefined;
      });
  };

  const scheduleExchange = (): void => {
    if (stopped || inFlight || pauseBarrier !== undefined || exchangeTask !== undefined) return;
    const task = globalThis.setTimeout(() => {
      if (exchangeTask !== task) return;
      exchangeTask = undefined;
      startExchange();
    }, 0);
    exchangeTask = task;
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

    if (!mounted || (config.presentation !== undefined && hydratedGeneration !== generation)) {
      startExchange();
      return;
    }

    const t1 = performance.now();
    try {
      adapter.sync(mirror);
      host.present(lastTick, paused);
    } catch (error) {
      stopped = true;
      globalThis.cancelAnimationFrame(animationFrame);
      host.fail(error);
      rejectSync(error);
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
      rejectSync(error);
      return;
    }
    const t3 = performance.now();
    timings.sync = t2 - t1;
    timings.render = t3 - t2;
    if (pendingExchangeProfile !== undefined)
      pendingExchangeProfile.longestRenderMs = Math.max(
        pendingExchangeProfile.longestRenderMs,
        timings.render,
      );
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
    const presented = presentationWaiters;
    presentationWaiters = [];
    for (const entry of presented) {
      if (entry.generation === generation && entry.tick <= lastTick) entry.waiter.resolve();
      else if (entry.generation < generation) {
        if (entry.waiter.needsInput)
          entry.waiter.reject(
            new Error('[aegis] Input synchronization cancelled by a generation reset.'),
          );
        else syncWaiters.push(entry.waiter);
      } else presentationWaiters.push(entry);
    }
    // A real task boundary lets input queued during a blocking draw update the collector first.
    // Collect in that task, not here; microtasks cannot dispatch queued browser input.
    scheduleExchange();
  };

  globalThis.addEventListener('resize', resize);
  globalThis.addEventListener('beforeunload', () => {
    stopped = true;
    globalThis.cancelAnimationFrame(animationFrame);
    globalThis.removeEventListener('resize', resize);
    collector.dispose();
    host.dispose();
    rejectSync(new Error('[aegis] Input synchronization cancelled by page disposal.'));
  });

  const debug: AegisDebugHandle = {
    ready: host.ready,
    presentation: () => host.stats(),
    world: mirror,
    get adapter() {
      return host.adapter;
    },
    tick: () => lastTick,
    timings: () => ({
      ...timings,
      ...(timings.firstExchangeFailure === undefined
        ? {}
        : {
            firstExchangeFailure: { ...timings.firstExchangeFailure },
          }),
    }),
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
      if (stopped) return Promise.reject(new Error('[aegis] The live client has stopped.'));
      if (inputFailure !== undefined) return Promise.reject(inputFailure);
      return new Promise<void>((resolve, reject) =>
        syncWaiters.push({ resolve, reject, needsInput: intentRevision > acceptedRevision }),
      );
    },
  };
  (globalThis as unknown as { aegis: AegisDebugHandle }).aegis = debug;

  host.start(() => {
    adapter = host.adapter;
    resize();
    animationFrame = globalThis.requestAnimationFrame(frame);
  });
}

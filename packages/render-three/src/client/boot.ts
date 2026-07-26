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

/** Post JSON and parse the JSON response. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return (await response.json()) as T;
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

  const resize = (): void => {
    const width = canvas.clientWidth || globalThis.innerWidth;
    const height = canvas.clientHeight || globalThis.innerHeight;
    renderer.setSize(width, height, false);
    adapter.resize(width, height);
  };

  const collector = createInputCollector({
    canvas,
    bindings: BINDINGS[mode],
    pick: (x, y) => adapter.pick(x, y),
    onCommand: (command) => {
      void postJson(`${config.api}/control`, { command: COMMANDS[command] }).catch(() => undefined);
    },
  });

  const applySnapshot = (snapshot: WorldSnapshot): void => {
    mirror.restore(snapshot);
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
    try {
      const response = await postJson<FrameResponse>(`${config.api}/frame`, {
        input: collector.take(),
      });
      paused = response.paused;
      applySnapshot(response.snapshot);
      hud.pushEvents(response.events);
      for (const resolve of settling) resolve();
    } catch (error) {
      // A failed exchange never delivered the input, so put the waiters back rather than
      // resolving them — otherwise automation would step on input the server never saw.
      syncWaiters.push(...settling);
      throw error;
    }
  };

  const frame = (): void => {
    globalThis.requestAnimationFrame(frame);
    if (!inFlight) {
      inFlight = true;
      void exchange()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }
    if (!mounted) return;

    adapter.sync(mirror);
    renderer.render(adapter.scene, adapter.camera);

    framesThisSecond++;
    const now = performance.now();
    if (now - fpsWindowStart >= 500) {
      fps = (framesThisSecond * 1000) / (now - fpsWindowStart);
      framesThisSecond = 0;
      fpsWindowStart = now;
    }
    hud.setStatus(lastTick, paused, fps);
    hud.setStats(mode, mirror);
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
    project(x: number, y: number, z: number): { x: number; y: number } | null {
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

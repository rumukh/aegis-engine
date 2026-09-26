import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { FrameClients } from '../../packages/render-three/src/frame-clients.js';
import type { FrameInputStatus } from '../../packages/render-three/src/frame-clients.js';
import type { InputPacket } from '../../packages/render-three/src/live-input.js';
import type { AegisDebugHandle } from '../../packages/render-three/src/client/boot.js';
import type { PresentationHost } from '../../packages/render-three/src/client/presentation-host.js';
import type { CdpSession } from '../../packages/render-three/src/browser.js';
import { evaluate } from '../../packages/render-three/src/browser.js';

/** Serializable, self-contained so the same bounded recorder can run inside the page. */
export function traceWindow<T>(lastLimit = 64, peakLimit = 6, beforeLimit = 6) {
  let total = 0;
  const last: T[] = [];
  const peaks: { score: number; before: T[]; row: T }[] = [];
  return {
    add(row: T, score = 0): void {
      total++;
      if (score > 0 && (peaks.length < peakLimit || score > peaks[peaks.length - 1]!.score)) {
        peaks.push({ score, before: last.slice(-beforeLimit), row });
        peaks.sort((a, b) => b.score - a.score);
        if (peaks.length > peakLimit) peaks.pop();
      }
      last.push(row);
      if (last.length > lastLimit) last.shift();
    },
    snapshot: () => ({
      total,
      retained: last.length,
      omitted: total - last.length,
      last: [...last],
      peaks: [...peaks],
    }),
  };
}

function packetFields(packet: InputPacket) {
  const list = (value: readonly string[] | undefined) =>
    value === undefined
      ? null
      : { total: value.length, values: value.slice(0, 16).map((s) => s.slice(0, 64)) };
  const axes = Object.entries(packet.axes ?? {});
  return {
    seq: packet.seq,
    reset: packet.reset ?? null,
    held: list(packet.held),
    pressed: list(packet.pressed),
    released: list(packet.released),
    axes: packet.axes === undefined ? null : Object.fromEntries(axes.slice(0, 8)),
    axesOmitted: Math.max(0, axes.length - 8),
    look: packet.look === undefined ? null : { ...packet.look },
    pointer:
      packet.pointer == null
        ? null
        : {
            screen: { ...packet.pointer.screen },
            world: packet.pointer.world === null ? null : { ...packet.pointer.world },
            buttons: packet.pointer.buttons.slice(0, 8),
          },
  };
}

export function startHorrorInputTrace(tick: () => number | null) {
  const packets = traceWindow<object>(96);
  const loop = traceWindow<object>(48);
  const controls = traceWindow<object>(48);
  const started = performance.now();
  let lastPacketAt: number | undefined;
  let lastControlReceipt: { client: string; generation: number; at: number } | undefined;
  let lastLoopAt = started;
  let lastCpu = process.cpuUsage();
  let stopped = false;
  const original = FrameClients.prototype.submit;
  const spy = vi.spyOn(FrameClients.prototype, 'submit').mockImplementation(function (
    this: FrameClients,
    ...args
  ) {
    const atMs = performance.now();
    const [, , metadata, packet, generation, hostClockSeconds] = args;
    const fields = packetFields(packet);
    let ack: FrameInputStatus | undefined;
    let thrown: unknown;
    try {
      ack = original.apply(this, args);
      return ack;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const atEndMs = performance.now();
      const packetGapMs = lastPacketAt === undefined ? null : atMs - lastPacketAt;
      const sinceControllingAckMs =
        lastControlReceipt?.client === metadata.id && lastControlReceipt.generation === generation
          ? atMs - lastControlReceipt.at
          : null;
      packets.add(
        {
          atMs,
          atEndMs,
          tick: tick(),
          hostClockSeconds,
          packetGapMs,
          sinceControllingAckMs,
          client: metadata.id.slice(0, 64),
          observedGeneration: metadata.generation,
          generation,
          claim: metadata.claim,
          input: fields,
          ack: ack === undefined ? null : { ...ack },
          error: thrown === undefined ? null : String(thrown).slice(0, 600),
        },
        Math.max(packetGapMs ?? 0, sinceControllingAckMs ?? 0, ack?.accepted === false ? 2000 : 0),
      );
      lastPacketAt = atMs;
      if (ack?.accepted && ack.role === 'controlling')
        lastControlReceipt = { client: metadata.id, generation, at: atMs };
    }
  });
  const sample = () => {
    const atMs = performance.now();
    const currentCpu = process.cpuUsage();
    const elapsedMs = atMs - lastLoopAt;
    const userMs = (currentCpu.user - lastCpu.user) / 1000;
    const systemMs = (currentCpu.system - lastCpu.system) / 1000;
    loop.add(
      {
        atMs,
        fromMs: lastLoopAt,
        elapsedMs,
        timerDelayMs: Math.max(0, elapsedMs - 100),
        userMs,
        systemMs,
        cpuMsPerWallMs: elapsedMs > 0 ? (userMs + systemMs) / elapsedMs : null,
      },
      elapsedMs,
    );
    lastLoopAt = atMs;
    lastCpu = currentCpu;
  };
  const timer = setInterval(sample, 100);
  timer.unref();
  return {
    control(command: string, ticks: number, atMs: number, error?: unknown): void {
      const endMs = performance.now();
      controls.add(
        {
          command,
          ticks,
          atMs,
          endMs,
          wallMs: endMs - atMs,
          error: error === undefined ? null : String(error).slice(0, 600),
        },
        endMs - atMs,
      );
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      sample();
      spy.mockRestore();
    },
    snapshot: () => ({
      timeOrigin: performance.timeOrigin,
      startedMs: started,
      endedMs: performance.now(),
      pid: process.pid,
      packets: packets.snapshot(),
      nodeLoop: loop.snapshot(),
      controls: controls.snapshot(),
    }),
  };
}

/** Public methods only; no world writes, driver stepping, clock overrides or response-body reads. */
export function installBrowserInputTrace(
  windowFactory: typeof traceWindow,
  hostPrototype: Pick<PresentationHost, 'render'>,
) {
  const target = globalThis as typeof globalThis & {
    aegis: Omit<AegisDebugHandle, 'timings'> & Partial<Pick<AegisDebugHandle, 'timings'>>;
    __horrorInputTrace?: { stop(): object };
  };
  if (target.__horrorInputTrace !== undefined) throw new Error('Input trace already installed');
  const frames = windowFactory<object>(48);
  const mainLoop = windowFactory<object>(48);
  const syncs = windowFactory<object>(48);
  const renders = windowFactory<object>(48);
  const programs = windowFactory<object>(32);
  const hardware = windowFactory<object>(64);
  const requests = windowFactory<object>(64);
  const adapter = target.aegis.adapter;
  const originalSync = adapter.sync;
  const originalRender = hostPrototype.render;
  const originalFetch = globalThis.fetch;
  const started = performance.now();
  let previousFrame = started;
  let previousTimer = started;
  let frameId = 0;
  let stopped = false;
  let maxFrameGapMs = 0;
  let maxRenderMs = 0;
  let maxAdapterSyncMs = 0;
  let maxTimerGapMs = 0;
  const capture = () => ({
    tick: target.aegis.tick(),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    pointerLocked: document.pointerLockElement !== null,
  });
  const liveTimings = () =>
    typeof target.aegis.timings === 'function'
      ? { available: true, value: target.aegis.timings() }
      : { available: false, value: null };
  adapter.sync = function (...args) {
    const atMs = performance.now();
    try {
      return originalSync.apply(this, args);
    } finally {
      const durationMs = performance.now() - atMs;
      maxAdapterSyncMs = Math.max(maxAdapterSyncMs, durationMs);
      syncs.add({ atMs, durationMs, tick: target.aegis.tick() }, durationMs);
    }
  };
  hostPrototype.render = function (this: PresentationHost, ...args) {
    const atMs = performance.now();
    const before = new Set((this.renderer.info.programs ?? []).map((program) => program.id));
    const responder = adapter.presentation?.entity('responder')?.root;
    const drawn = new Set<string>();
    const meshes: {
      name: string;
      skinned: boolean;
      visible: boolean;
      castShadow: boolean;
      receiveShadow: boolean;
    }[] = [];
    const restore: (() => void)[] = [];
    responder?.traverse((node) => {
      if (!('isMesh' in node) || node.isMesh !== true) return;
      meshes.push({
        name: node.name,
        skinned: 'isSkinnedMesh' in node && node.isSkinnedMesh === true,
        visible: node.visible,
        castShadow: node.castShadow,
        receiveShadow: node.receiveShadow,
      });
      const original = node.onBeforeRender;
      node.onBeforeRender = (...parameters) => {
        drawn.add(node.name);
        original.apply(node, parameters);
      };
      restore.push(() => {
        node.onBeforeRender = original;
      });
    });
    try {
      return originalRender.apply(this, args);
    } finally {
      for (const undo of restore) undo();
      const durationMs = performance.now() - atMs;
      maxRenderMs = Math.max(maxRenderMs, durationMs);
      const added = (this.renderer.info.programs ?? [])
        .filter((program) => !before.has(program.id))
        .map((program) => ({ id: program.id, name: program.name, cacheKey: program.cacheKey }));
      const row = {
        atMs,
        durationMs,
        tick: target.aegis.tick(),
        programsBefore: before.size,
        programsAfter: this.renderer.info.programs?.length ?? 0,
        addedPrograms: added,
        responder: {
          visible: responder?.visible ?? null,
          meshes: meshes.slice(0, 8),
          meshCount: meshes.length,
          drawn: [...drawn].slice(0, 8),
        },
      };
      renders.add(row, durationMs);
      if (added.length > 0) programs.add(row, durationMs);
    }
  };
  globalThis.fetch = function (...args) {
    const atMs = performance.now();
    const result = originalFetch.apply(this, args);
    const [url, options] = args;
    if (String(url).endsWith('/api/horror/frame') && typeof options?.body === 'string') {
      let seq: number | null = null;
      try {
        const body = JSON.parse(options.body) as { input?: { seq?: number }; client?: object };
        seq = body.input?.seq ?? null;
        requests.add({ phase: 'send', atMs, tick: target.aegis.tick(), seq, client: body.client });
      } catch (error) {
        requests.add({ phase: 'trace-read-error', atMs, error: String(error).slice(0, 600) }, 2000);
      }
      void result.then(
        (response) => {
          if (!stopped)
            requests.add(
              {
                phase: 'headers',
                atMs: performance.now(),
                sentMs: atMs,
                seq,
                status: response.status,
                elapsedMs: performance.now() - atMs,
              },
              performance.now() - atMs,
            );
        },
        (error: unknown) => {
          if (!stopped)
            requests.add(
              {
                phase: 'fetch-error',
                atMs: performance.now(),
                sentMs: atMs,
                seq,
                error: String(error).slice(0, 600),
              },
              2000,
            );
        },
      );
    }
    return result;
  };
  const onKey = (event: KeyboardEvent) =>
    hardware.add({
      type: event.type,
      atMs: performance.now(),
      code: event.code,
      repeat: event.repeat,
      trusted: event.isTrusted,
    });
  const onMouse = (event: MouseEvent) => {
    if (event.movementX !== 0 || event.movementY !== 0)
      hardware.add({
        type: event.type,
        atMs: performance.now(),
        dx: event.movementX,
        dy: event.movementY,
      });
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('mousemove', onMouse, true);
  const sampleFrame = () => {
    const atMs = performance.now();
    const gapMs = atMs - previousFrame;
    previousFrame = atMs;
    maxFrameGapMs = Math.max(maxFrameGapMs, gapMs);
    const timing = liveTimings();
    frames.add(
      {
        atMs,
        gapMs,
        ...capture(),
        liveTimingsAvailable: timing.available,
        bootFrames: timing.value?.frames ?? null,
        bootGapMs: timing.value?.gap ?? null,
        bootRenderMs: timing.value?.render ?? null,
        bootSyncMs: timing.value?.sync ?? null,
        inFlight: timing.value?.inFlight ?? null,
        exchangeErrors: timing.value?.exchangeErrors ?? null,
      },
      gapMs,
    );
    frameId = requestAnimationFrame(sampleFrame);
  };
  const timer = setInterval(() => {
    const atMs = performance.now();
    const gapMs = atMs - previousTimer;
    previousTimer = atMs;
    maxTimerGapMs = Math.max(maxTimerGapMs, gapMs);
    mainLoop.add({ atMs, gapMs, timerDelayMs: Math.max(0, gapMs - 100), ...capture() }, gapMs);
  }, 100);
  frameId = requestAnimationFrame(sampleFrame);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    cancelAnimationFrame(frameId);
    adapter.sync = originalSync;
    hostPrototype.render = originalRender;
    globalThis.fetch = originalFetch;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('mousemove', onMouse, true);
    delete target.__horrorInputTrace;
    return {
      timeOrigin: performance.timeOrigin,
      startedMs: started,
      endedMs: performance.now(),
      maxFrameGapMs,
      maxTimerGapMs,
      maxRenderMs,
      maxAdapterSyncMs,
      frames: frames.snapshot(),
      mainLoop: mainLoop.snapshot(),
      syncs: syncs.snapshot(),
      renders: renders.snapshot(),
      programs: programs.snapshot(),
      hardware: hardware.snapshot(),
      requests: requests.snapshot(),
      finalTimings: liveTimings(),
      note: 'render duration is public host.render wall time, not GPU elapsed time; fetch headers do not imply body completion',
    };
  };
  target.__horrorInputTrace = { stop };
  return { installedAtMs: started, timeOrigin: performance.timeOrigin };
}

export async function traceHorrorPage(page: CdpSession): Promise<void> {
  await evaluate(
    page,
    `(async()=>{
    const map=JSON.parse(document.querySelector('script[type="importmap"]').textContent).imports;
    const boot=map['@aegis/render-three/client/boot']??map['@aegis/render-three/client/static-boot'];
    if(!boot)throw new Error('Missing mapped browser boot URL for trace');
    const {PresentationHost}=await import(new URL('presentation-host.js',new URL(boot,document.baseURI)).href);
    return (${installBrowserInputTrace.toString()})(${traceWindow.toString()},PresentationHost.prototype);
  })()`,
  );
}

export async function finishHorrorInputTrace(
  trace: ReturnType<typeof startHorrorInputTrace>,
  page: CdpSession,
  label: string,
  directory: string,
): Promise<void> {
  trace.stop();
  let browser: { value: unknown } | { error: string };
  try {
    browser = {
      value: await evaluate(
        page,
        `(() => {
      if(!globalThis.__horrorInputTrace)throw new Error('Browser input trace was not installed or lost its context');
      return globalThis.__horrorInputTrace.stop();
    })()`,
      ),
    };
  } catch (error) {
    browser = { error: String(error).slice(0, 1200) };
  }
  const report = { kind: 'horror-input-trace/1', label, node: trace.snapshot(), browser };
  const text = JSON.stringify(report);
  console.info(`[horror-input-trace] ${text}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${label.replace(/[^a-z0-9-]/gi, '-')}.json`), `${text}\n`);
}

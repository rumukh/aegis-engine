import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameClients } from '../packages/render-three/src/frame-clients.js';
import { createLiveInput } from '../packages/render-three/src/live-input.js';
import {
  installBrowserInputTrace,
  startHorrorInputTrace,
  traceWindow,
} from './support/horror-input-trace.js';

afterEach(() => vi.restoreAllMocks());

describe('bounded Horror diagnostic instrumentation', () => {
  it('keeps independent bounded last/peak windows with precursor rows after overflow', () => {
    const window = traceWindow<{ id: number }>(3, 2, 2);
    for (let id = 0; id < 100; id++) window.add({ id }, id === 3 ? 500 : id === 2 ? 300 : 0);
    expect(window.snapshot()).toEqual({
      total: 100,
      retained: 3,
      omitted: 97,
      last: [{ id: 97 }, { id: 98 }, { id: 99 }],
      peaks: [
        { score: 500, before: [{ id: 1 }, { id: 2 }], row: { id: 3 } },
        { score: 300, before: [{ id: 0 }, { id: 1 }], row: { id: 2 } },
      ],
    });
  });

  it('preserves broker this, argument identity, return identity and throws, recording real inputs and ACKs', () => {
    const implementation = FrameClients.prototype.submit;
    const delegated = vi.fn(implementation);
    const originalSpy = vi.spyOn(FrameClients.prototype, 'submit').mockImplementation(delegated);
    const trace = startHorrorInputTrace(() => 2482);
    try {
      const broker = new FrameClients();
      const input = createLiveInput();
      const client = broker.client('page', 0, input)!;
      const metadata = { id: 'page', claim: true, generation: 6 };
      const packet = { seq: 9, axes: { Forward: 1 }, look: { dx: 90.02, dy: 0 } };
      const ack = broker.submit(input, client, metadata, packet, 6, 0);
      expect(delegated.mock.contexts[0]).toBe(broker);
      expect(delegated.mock.calls[0]).toEqual([input, client, metadata, packet, 6, 0]);
      expect(delegated.mock.calls[0]![3]).toBe(packet);
      expect(ack).toBe(delegated.mock.results[0]!.value);
      expect(input.frameFor(2482)).toMatchObject({
        axes: { Forward: 1 },
        look: { dx: 90.02, dy: 0 },
      });
      const traceRow = trace.snapshot().packets.last[0];
      expect(traceRow).toMatchObject({
        tick: 2482,
        claim: true,
        generation: 6,
        observedGeneration: 6,
        input: { seq: 9, axes: { Forward: 1 }, look: { dx: 90.02, dy: 0 } },
        ack: { accepted: true, role: 'controlling', lastSeq: 9 },
        error: null,
      });
      const error = new Error('Original submit failure');
      delegated.mockImplementationOnce(() => {
        throw error;
      });
      expect(() => broker.submit(input, client, metadata, { seq: 10 }, 6, 0)).toThrow(error);
      expect(trace.snapshot().packets.last[1]).toMatchObject({
        ack: null,
        error: 'Error: Original submit failure',
      });
    } finally {
      trace.stop();
      trace.stop();
      originalSpy.mockRestore();
    }
    expect(FrameClients.prototype.submit).toBe(implementation);
  });

  it('bounds authored packet fields and restores the spy after stop', () => {
    const original = FrameClients.prototype.submit;
    const trace = startHorrorInputTrace(() => null);
    try {
      const broker = new FrameClients();
      const input = createLiveInput();
      const client = broker.client('page', 0, input)!;
      broker.submit(
        input,
        client,
        { id: 'page', claim: true, generation: 1 },
        {
          seq: 1,
          held: Array.from({ length: 40 }, () => 'x'.repeat(100)),
          axes: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), i])),
        },
        1,
        0,
      );
      expect(trace.snapshot().packets.last[0]).toMatchObject({
        input: { held: { total: 40, values: Array(16).fill('x'.repeat(64)) }, axesOmitted: 12 },
      });
    } finally {
      trace.stop();
    }
    expect(FrameClients.prototype.submit).toBe(original);
    expect(trace.snapshot().nodeLoop.total).toBe(1);
  });

  it('distinguishes absent wire fields from explicit neutral values', () => {
    const trace = startHorrorInputTrace(() => 0);
    try {
      const broker = new FrameClients();
      const input = createLiveInput();
      const client = broker.client('page', 0, input)!;
      const metadata = { id: 'page', claim: false, generation: 0 };
      broker.submit(input, client, metadata, { seq: 1 }, 0, 0);
      broker.submit(input, client, metadata, { seq: 2, axes: {}, reset: false }, 0, 0);
      expect(trace.snapshot().packets.last[0]).toMatchObject({
        input: { axes: null, reset: null, held: null, look: null },
      });

      expect(trace.snapshot().packets.last[1]).toMatchObject({
        input: { axes: {}, reset: false },
      });
    } finally {
      trace.stop();
    }
  });

  it('records control header timing and unconsumed response bodies without retaining them strongly', async () => {
    const trace = startHorrorInputTrace(() => 0);
    const response = new Response('bounded control response');
    try {
      const at = performance.now();
      trace.control('headers-only', 1, at, undefined, response, at);
      expect(trace.snapshot().controls.last[0]).toMatchObject({
        responseBodyUsed: false,
        unconsumedLiveResponses: 1,
        responseCount: 1,
      });
      await response.arrayBuffer();
      trace.control('drained', 1, at, undefined, response, performance.now());
      expect(trace.snapshot().controls.last[1]).toMatchObject({
        responseBodyUsed: true,
        unconsumedLiveResponses: 0,
        responseCount: 2,
      });
    } finally {
      trace.stop();
    }
  });

  it.each([true, false])(
    'runs the serialized browser recorder with live timings available=%s',
    async (live) => {
      let clock = 10;
      const frames = new Map<number, () => void>();
      const timers = new Map<number, () => void>();
      let id = 0;
      const adapter = {
        sync: vi.fn(function (this: unknown, value: unknown) {
          expect(this).toBe(adapter);
          clock += 7;
          return value;
        }),
      };
      const programs: { id: number; name: string; cacheKey: string }[] = [];
      const renderer = {
        renderer: { info: { programs } },
        render: vi.fn(function (this: unknown) {
          expect(this).toBe(renderer);
          clock += 11;
          programs.push({ id: 7, name: 'measured-material', cacheKey: 'measured-program-key' });
        }),
      };
      const fetchResult = Promise.resolve({ status: 200 });
      const fetch = vi.fn((_input: unknown, _options?: unknown) => fetchResult);
      const context = {
        performance: { now: () => clock, timeOrigin: 1000 },
        document: { visibilityState: 'visible', hasFocus: () => true, pointerLockElement: null },
        window: new EventTarget(),
        fetch,
        aegis: {
          adapter,
          tick: () => 2482,
          ...(live
            ? {
                timings: () => ({
                  frames: 1,
                  gap: 16,
                  render: 11,
                  sync: 7,
                  inFlight: false,
                  exchangeErrors: 0,
                }),
              }
            : {}),
        },
        requestAnimationFrame: (fn: () => void) => {
          frames.set(++id, fn);
          return id;
        },
        cancelAnimationFrame: (key: number) => frames.delete(key),
        setInterval: (fn: () => void) => {
          timers.set(++id, fn);
          return id;
        },
        clearInterval: (key: number) => timers.delete(key),
        host: renderer,
      };
      const originalSync = adapter.sync;
      const originalRender = renderer.render;
      runInNewContext(
        `(${installBrowserInputTrace.toString()})(${traceWindow.toString()},host)`,
        context,
      );
      const marker = {};
      expect(adapter.sync(marker)).toBe(marker);
      renderer.render();
      if (live)
        expect(
          context.fetch('/api/horror/frame', {
            method: 'POST',
            body: '{"input":{"seq":42},"client":{"claim":false}}',
          }),
        ).toBe(fetchResult);
      await fetchResult;
      clock += 2300;
      const frame = frames.entries().next().value!;
      frames.delete(frame[0]);
      frame[1]();
      timers.values().next().value!();
      const report = runInNewContext('globalThis.__horrorInputTrace.stop()', context);
      expect(report).toMatchObject({
        maxFrameGapMs: 2318,
        maxTimerGapMs: 2318,
        maxRenderMs: 11,
        maxAdapterSyncMs: 7,
        requests: { total: live ? 2 : 0 },
        syncs: { total: 1 },
        renders: { total: 1 },
        programs: { total: 1 },
        frames: { total: 1 },
        mainLoop: { total: 1 },
        finalTimings: live
          ? { available: true, value: { frames: 1 } }
          : { available: false, value: null },
      });
      expect(report.renders.last[0]).toMatchObject({
        programsBefore: 0,
        programsAfter: 1,
        addedPrograms: [{ id: 7, name: 'measured-material', cacheKey: 'measured-program-key' }],
        responder: { visible: null, meshes: [], meshCount: 0, drawn: [] },
      });
      if (!live)
        expect(report.frames.last[0]).toMatchObject({
          liveTimingsAvailable: false,
          bootFrames: null,
          bootGapMs: null,
          bootRenderMs: null,
          bootSyncMs: null,
          inFlight: null,
          exchangeErrors: null,
        });
      expect(adapter.sync).toBe(originalSync);
      expect(renderer.render).toBe(originalRender);
      expect(context.fetch).toBe(fetch);
      expect(frames.size).toBe(0);
      expect(timers.size).toBe(0);
    },
  );
});

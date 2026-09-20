import { setImmediate as settle } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { fpsPlugin, LookState } from '@aegis/mode-fps';
import { FrameClients } from '../frame-clients.js';
import type { FrameRequest, FrameResponse } from '../protocol.js';
import type { PresentationManifest } from '../presentation/schema.js';
import { createLiveSession } from '../session.js';
import type { LiveSession } from '../session.js';
import { FPS_SCENE } from '../testing/scenes.js';
import { installFakeDom, keyEvent } from '../testing/dom.js';
import type { FakeDom } from '../testing/dom.js';
import { boot } from './boot.js';
import type { AegisDebugHandle } from './boot.js';

const hooks = vi.hoisted(() => ({ host: vi.fn() }));
vi.mock('./presentation-host.js', () => ({
  PresentationHost: function (): object {
    return hooks.host();
  },
}));

// Real boot, collector, broker and paused FPS simulation; only presentation and delivery are controlled.
const TURN = 90.02000000000001; // The actual 643-pixel mouse packet, not an unquantized DSL aim.
const STALL_MS = 3115.8;
interface Request {
  body: FrameRequest;
  signal: AbortSignal;
  resolve(response: Response): void;
  reject(error: unknown): void;
}
let dom: FakeDom;
let events: EventTarget;
let session: LiveSession;
let clients: FrameClients;
let generation: number;
let frameId: number;
let now: number;
let frames: Map<number, FrameRequestCallback>;
let requests: Request[];
let expiry: { at: number; controller: AbortController }[];
let renderWork: () => void;
let chronology: string[];
let host: ReturnType<typeof makeHost>;

function makeHost() {
  let ready!: () => void;
  const promise = new Promise<void>((done) => {
    ready = done;
  });
  return {
    renderer: { info: { render: { calls: 1, triangles: 12 } } },
    ready: promise,
    adapter: {
      camera: new PerspectiveCamera(),
      scene: new Scene(),
      mount: vi.fn(),
      sync: vi.fn(),
      pick: () => null,
    },
    hud: { setStatus: vi.fn(), setStats: vi.fn() },
    start: (run: () => void) => run(),
    resize: vi.fn(),
    validateWorld: vi.fn(),
    hydrate: vi.fn(),
    receive: vi.fn(),
    present: vi.fn(),
    reset: vi.fn(),
    connection: vi.fn(),
    fail: vi.fn(),
    captureInput: vi.fn(),
    inputStatus: vi.fn(),
    dispose: vi.fn(),
    mounted: ready,
    stats: () => ({}),
    render: () => {
      chronology.push('render');
      renderWork();
    },
  };
}
function debug(): AegisDebugHandle {
  return (globalThis as typeof globalThis & { aegis: AegisDebugHandle }).aegis;
}
function takeRequest(): Request {
  const request = requests.shift();
  if (request === undefined) throw new Error('Expected a frame packet from the real boot.');
  return request;
}
function serverReply(request: Request): FrameResponse {
  const metadata = request.body.client!;
  const client = clients.client(metadata.id, now / 1000, session.input)!;
  const inputStatus = clients.submit(
    session.input,
    client,
    metadata,
    request.body.input,
    generation,
    now / 1000,
  );
  expect(session.advance(0.016)).toBe(0);
  return {
    tick: session.tick,
    snapshot: session.snapshot(),
    steps: 0,
    paused: true,
    generation,
    inputStatus,
    events: [],
    ...(request.body.presentationGeneration === generation ? {} : { eventHistory: [] }),
  };
}
async function acknowledge(request = takeRequest()): Promise<FrameResponse> {
  const reply = serverReply(request);
  request.resolve(new Response(JSON.stringify(reply)));
  await settle();
  return reply;
}
function elapse(ms: number): void {
  now += ms;
  for (const entry of expiry)
    if (!entry.controller.signal.aborted && now >= entry.at)
      entry.controller.abort(new DOMException('Controlled 2000ms deadline', 'TimeoutError'));
}
async function display(): Promise<void> {
  const next = frames.entries().next().value;
  if (next === undefined) throw new Error('Expected a scheduled display callback.');
  frames.delete(next[0]);
  next[1](now);
  await settle();
}
async function start(
  profile: PresentationManifest | null = { aegis: 'presentation/1' },
): Promise<void> {
  boot({
    gameId: 'proof',
    mode: 'fps',
    title: 'Delivery regression',
    objective: '',
    api: '/api/proof',
    ...(profile === null ? {} : { presentation: { manifest: profile, baseUrl: '/assets/' } }),
  });
  await display();
  expect((await acknowledge()).inputStatus).toMatchObject({
    accepted: false,
    reason: 'generation',
  });
  await debug().ready;
  await display();
  await acknowledge();
  chronology.length = 0;
}
function turnAndWalk(): void {
  dom.dispatch('keydown', keyEvent('KeyW'));
  dom.dispatch('mousemove', { movementX: -643, movementY: 0 });
}
function yaw(): number {
  return session.world
    .query({ has: [LookState] })
    .one()
    .get(LookState).yawDeg;
}
function barrier() {
  const resolved = vi.fn();
  const rejected = vi.fn<(error: unknown) => void>();
  const done = debug().sync().then(resolved, rejected);
  return { resolved, rejected, done };
}
function bodyAborts(request: Request): void {
  const response = new Response(null, { status: 200 });
  vi.spyOn(response, 'text').mockImplementation(
    () =>
      new Promise<string>((_resolve, reject) => {
        const abort = () => reject(new DOMException('The user aborted a request.', 'AbortError'));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      }),
  );
  request.resolve(response);
}

beforeEach(() => {
  generation = 6;
  now = 100;
  frameId = 0;
  frames = new Map();
  requests = [];
  expiry = [];
  chronology = [];
  renderWork = () => {};
  session = createLiveSession({ scene: FPS_SCENE, plugin: fpsPlugin });
  session.paused = true;
  clients = new FrameClients();
  dom = installFakeDom();
  events = new EventTarget();
  host = makeHost();
  hooks.host.mockReturnValue(host);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('document', {
    baseURI: 'http://proof.test/play/proof/',
    pointerLockElement: dom.canvas,
    getElementById: (id: string) => (id === 'stage' ? dom.canvas : null),
  });
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    expect(delay).toBe(2000);
    const controller = new AbortController();
    expiry.push({ at: now + delay, controller });
    return controller.signal;
  });
  vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
    chronology.push('collect+arm-fetch');
    return new Promise<Response>((resolve, reject) =>
      requests.push({
        body: JSON.parse(options.body as string) as FrameRequest,
        signal: options.signal!,
        resolve,
        reject,
      }),
    );
  });
  vi.stubGlobal('aegis', undefined);
});
afterEach(() => {
  events.dispatchEvent(new Event('beforeunload'));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  dom.restore();
});

describe('accepted live input delivery', () => {
  it('rejects fresh cold-bootstrap input and does not carry it into the discovered generation', async () => {
    boot({ gameId: 'proof', mode: 'fps', title: '', objective: '', api: '/api/proof' });
    turnAndWalk();
    const synced = barrier();
    await display();
    const request = takeRequest();
    expect(request.body.client?.generation).toBeNull();
    expect((await acknowledge(request)).inputStatus?.reason).toBe('generation');
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    const observer = barrier();
    await display();
    await acknowledge();
    await observer.done;
    expect(observer.resolved).toHaveBeenCalledOnce();
    expect(session.input.frameFor(0)).toMatchObject({ axes: {}, look: { dx: 0, dy: 0 } });
  });

  it('bootstraps and synchronizes a passive observer, then applies a fresh turn exactly once', async () => {
    await start();
    const observed = barrier();
    await display();
    expect((await acknowledge()).inputStatus?.reason).toBe('observing');
    await observed.done;
    expect(observed.resolved).toHaveBeenCalledOnce();
    turnAndWalk();
    const synced = barrier();
    await display();
    const request = takeRequest();
    expect(request.body.input).toMatchObject({ axes: { Forward: 1 }, look: { dx: TURN, dy: 0 } });
    expect((await acknowledge(request)).inputStatus?.accepted).toBe(true);
    await synced.done;
    expect(synced.resolved).toHaveBeenCalledOnce();
    session.step();
    expect(yaw()).toBe(TURN);
    session.step();
    expect(yaw()).toBe(TURN);
    expect(debug().timings().exchangeErrors).toBe(0);
  });

  it.each([1999, STALL_MS])(
    'preserves separately collected look then fresh same-owner Forward across a %sms gap',
    async (gap) => {
      await start();
      dom.dispatch('mousemove', { movementX: -643, movementY: 0 });
      await display();
      expect((await acknowledge()).inputStatus?.accepted).toBe(true);
      elapse(gap);
      dom.dispatch('keydown', keyEvent('KeyW'));
      const synced = barrier();
      await display();
      const second = takeRequest();
      expect(second.body.client?.claim).toBe(true);
      expect(second.body.input).toMatchObject({ axes: { Forward: 1 }, look: { dx: 0, dy: 0 } });
      expect((await acknowledge(second)).inputStatus?.accepted).toBe(true);
      await synced.done;
      expect(synced.resolved).toHaveBeenCalledOnce();
      expect(session.input.frameFor(2481)).toMatchObject({
        axes: { Forward: 1 },
        look: { dx: TURN, dy: 0 },
      });
      expect(session.input.frameFor(2482).look.dx).toBe(0);
      expect(debug().timings().exchangeErrors).toBe(0);
    },
  );

  it('preserves acknowledged paused look after expiry while refusing held movement resends', async () => {
    await start();
    turnAndWalk();
    const synced = barrier();
    await display();
    await acknowledge();
    await synced.done;
    expect(synced.resolved).toHaveBeenCalledOnce();
    elapse(STALL_MS);
    await display();
    expect((await acknowledge()).inputStatus?.reason).toBe('observing');
    expect(session.input.frameFor(0)).toMatchObject({ axes: {}, look: { dx: TURN, dy: 0 } });
    expect(session.input.frameFor(1).look.dx).toBe(0);
  });

  it('allows the former owner focus-loss reset to cancel pending look after expiry', async () => {
    await start();
    turnAndWalk();
    await display();
    await acknowledge();
    elapse(STALL_MS);
    dom.dispatch('blur', {});
    await display();
    const reset = takeRequest();
    expect(reset.body.input.reset).toBe(true);
    expect((await acknowledge(reset)).inputStatus?.reason).toBe('observing');
    expect(session.input.frameFor(0)).toMatchObject({
      axes: {},
      look: { dx: 0, dy: 0 },
      pressed: [],
    });
  });

  it.each(['generation', 'observing', 'missing-status', 'wrong-sequence'] as const)(
    'rejects a fresh input barrier on %s feedback instead of succeeding on a neutral retry',
    async (reason) => {
      await start();
      turnAndWalk();
      const synced = barrier();
      await display();
      const request = takeRequest();
      if (reason === 'generation') {
        generation++;
        session.restart();
        clients.reset();
      }
      if (reason === 'observing') request.body.client!.claim = false;
      const reply = serverReply(request);
      if (reason === 'missing-status') delete reply.inputStatus;
      if (reason === 'wrong-sequence') reply.inputStatus!.lastSeq++;
      request.resolve(new Response(JSON.stringify(reply)));
      await settle();
      await synced.done;
      expect(synced.resolved).not.toHaveBeenCalled();
      expect(synced.rejected).toHaveBeenCalledOnce();
      expect(String(synced.rejected.mock.calls[0]![0])).toContain('not accepted');
      expect(debug().timings().exchangeErrors).toBe(1);
      if (reason !== 'generation') {
        const later = barrier();
        await later.done;
        expect(later.rejected).toHaveBeenCalledOnce();
        await display();
        await acknowledge();
        expect(host.connection).toHaveBeenLastCalledWith(expect.any(Error));
      }
    },
  );

  it('does not mask a collected fresh packet failure when sync is called while it is in flight', async () => {
    await start();
    turnAndWalk();
    await display();
    const failed = takeRequest();
    const synced = barrier();
    failed.reject(new DOMException('Genuine timeout', 'TimeoutError'));
    await settle();
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    expect(synced.resolved).not.toHaveBeenCalled();
    expect(debug().timings().firstExchangeFailure).toMatchObject({
      stage: 'request',
      name: 'TimeoutError',
    });
  });

  it('requires acceptance for a changed held axis even without a new claim', async () => {
    await start();
    turnAndWalk();
    await display();
    await acknowledge();
    dom.dispatch('keyup', keyEvent('KeyW'));
    const synced = barrier();
    await display();
    const request = takeRequest();
    expect(request.body.client?.claim).toBe(false);
    const intruder = clients.client('new-owner', now / 1000, session.input)!;
    clients.submit(
      session.input,
      intruder,
      { id: 'new-owner', claim: true, generation },
      { seq: 1, axes: { Strafe: 1 } },
      generation,
      now / 1000,
    );
    expect((await acknowledge(request)).inputStatus?.reason).toBe('observing');
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    expect(session.input.frameFor(0).axes).toEqual({ Strafe: 1 });
  });

  it('does not carry a delayed old-generation failure into new passive synchronization', async () => {
    await start();
    turnAndWalk();
    const old = barrier();
    await display();
    const request = takeRequest();
    generation++;
    session.restart();
    clients.reset();
    request.resolve(new Response(JSON.stringify(serverReply(request))));
    await settle();
    await old.done;
    expect(old.rejected).toHaveBeenCalledOnce();
    const current = barrier();
    await display();
    await acknowledge();
    await current.done;
    expect(current.resolved).toHaveBeenCalledOnce();
    expect(session.input.frameFor(0).look.dx).toBe(0);
  });

  it.each([false, true])(
    'fails closed for the same HTTP200 body abort with server accepted=%s, without replay',
    async (accepted) => {
      await start();
      turnAndWalk();
      const synced = barrier();
      await display();
      const request = takeRequest();
      if (!accepted) request.body.client!.generation = generation - 1;
      expect(serverReply(request).inputStatus?.accepted).toBe(accepted);
      bodyAborts(request);
      await settle();
      renderWork = () => elapse(STALL_MS);
      await display();
      await synced.done;
      expect(synced.rejected).toHaveBeenCalledOnce();
      expect(synced.resolved).not.toHaveBeenCalled();
      expect(debug().timings()).toMatchObject({
        exchangeErrors: 1,
        firstExchangeFailure: {
          stage: 'body',
          responseStatus: 200,
          name: 'AbortError',
          elapsedMs: STALL_MS,
          longestRenderWhilePendingMs: STALL_MS,
        },
      });
      renderWork = () => {};
      await display();
      const next = takeRequest();
      expect(next.body.input.look?.dx).toBe(0);
      expect(next.body.client?.claim).toBe(false);
      await acknowledge(next);
      session.step();
      expect(yaw()).toBe(accepted ? TURN : 0);
      session.step();
      expect(yaw()).toBe(accepted ? TURN : 0);
      const latched = barrier();
      await latched.done;
      expect(latched.rejected).toHaveBeenCalledOnce();
      dom.dispatch('blur', {});
      dom.dispatch('focus', {});
      const observer = barrier();
      await display();
      await acknowledge();
      await observer.done;
      expect(observer.resolved).toHaveBeenCalledOnce();
      expect(debug().timings().exchangeErrors).toBe(1);
    },
  );

  it('does not double a turn already consumed before its HTTP200 body abort', async () => {
    await start();
    turnAndWalk();
    await display();
    const request = takeRequest();
    expect(serverReply(request).inputStatus?.accepted).toBe(true);
    session.step();
    expect(yaw()).toBe(TURN);
    bodyAborts(request);
    await settle();
    elapse(STALL_MS);
    await settle();
    await display();
    await acknowledge();
    session.step();
    expect(yaw()).toBe(TURN);
    expect(debug().timings().exchangeErrors).toBe(1);
  });

  it('lets a passive observer barrier wait for recovery from a real failed neutral exchange', async () => {
    await start();
    const synced = barrier();
    await display();
    takeRequest().reject(new DOMException('Neutral timeout', 'TimeoutError'));
    await settle();
    expect(synced.resolved).not.toHaveBeenCalled();
    expect(synced.rejected).not.toHaveBeenCalled();
    await display();
    expect((await acknowledge()).inputStatus?.reason).toBe('observing');
    await synced.done;
    expect(synced.resolved).toHaveBeenCalledOnce();
    expect(debug().timings().exchangeErrors).toBe(1);
  });

  it('cancels fresh synchronization on focus loss before collection and preserves neutral barriers', async () => {
    await start();
    turnAndWalk();
    const synced = barrier();
    dom.dispatch('blur', {});
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    const passive = barrier();
    await display();
    await acknowledge();
    await passive.done;
    expect(passive.resolved).toHaveBeenCalledOnce();
  });

  it('cancels a known focus reset during a successfully accepted in-flight request without inventing a transport error', async () => {
    await start();
    turnAndWalk();
    const synced = barrier();
    await display();
    const pending = takeRequest();
    const reply = serverReply(pending);
    expect(reply.inputStatus?.accepted).toBe(true);
    dom.dispatch('blur', {});
    pending.resolve(new Response(JSON.stringify(reply)));
    await settle();
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    expect(synced.resolved).not.toHaveBeenCalled();
    expect(String(synced.rejected.mock.calls[0]![0])).toContain('cancelled');
    expect(debug().timings().exchangeErrors).toBe(0);
    await display();
    await acknowledge();
    expect(session.input.frameFor(0)).toMatchObject({ axes: {}, look: { dx: 0, dy: 0 } });
  });

  it('still counts a real failed request across a known lifecycle reset', async () => {
    await start();
    turnAndWalk();
    const synced = barrier();
    await display();
    const pending = takeRequest();
    dom.dispatch('blur', {});
    pending.reject(new DOMException('A real timeout after focus loss', 'TimeoutError'));
    await settle();
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    expect(debug().timings()).toMatchObject({
      exchangeErrors: 1,
      firstExchangeFailure: { stage: 'request', name: 'TimeoutError' },
    });
    const observer = barrier();
    await display();
    await acknowledge();
    await observer.done;
    expect(observer.resolved).toHaveBeenCalledOnce();
  });
});

describe('frame drawing and request deadlines', () => {
  it.each([
    null,
    { aegis: 'presentation/1' },
    { aegis: 'presentation/1', pipeline: { toneMapping: 'aces' } },
  ] satisfies (PresentationManifest | null)[])(
    'draws before collecting and arming the next exchange for profile %j',
    async (profile) => {
      await start(profile);
      turnAndWalk();
      renderWork = () => {
        expect(requests).toHaveLength(0);
        elapse(STALL_MS);
      };
      await display();
      expect(chronology).toEqual(['render', 'collect+arm-fetch']);
      const request = takeRequest();
      expect(request.signal.aborted).toBe(false);
      await acknowledge(request);
      expect(debug().timings().exchangeErrors).toBe(0);
    },
  );

  it('does not start a new exchange after drawing fails', async () => {
    await start();
    turnAndWalk();
    const synced = barrier();
    renderWork = () => {
      throw new Error('Controlled draw failure');
    };
    await display();
    expect(requests).toHaveLength(0);
    expect(host.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Controlled draw failure' }),
    );
    expect(debug().timings().exchangeErrors).toBe(0);
    await synced.done;
    expect(synced.rejected).toHaveBeenCalledOnce();
    const stopped = barrier();
    await stopped.done;
    expect(stopped.rejected).toHaveBeenCalledOnce();
  });
});

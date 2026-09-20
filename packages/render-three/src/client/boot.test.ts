import { setImmediate as settle } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformerPlugin } from '@aegis/mode-platformer';
import type { EventLine, FrameResponse } from '../protocol.js';
import type { PresentationManifest, ResolvedPresentation } from '../presentation/schema.js';
import type { AssetLoadOptions } from '../presentation/assets.js';
import { runtimeLoaders, runtimeManifest } from '../presentation/runtime-test-utils.js';
import { installFakeDom, keyEvent } from '../testing/dom.js';
import type { FakeDom } from '../testing/dom.js';
import { PLATFORMER_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';
import { boot } from './boot.js';
import type { AegisDebugHandle } from './boot.js';
import type { InputPacket } from '../live-input.js';
import { virtualGamepad } from '../testing/gamepad.js';
import { createLiveSession } from '../session.js';

const cinematic = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../presentation/pipeline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presentation/pipeline.js')>()),
  CinematicPipeline: class {
    render = cinematic.render;
    resize(): void {}
    setQuality(): void {}
    stats(): object {
      return {};
    }
    dispose(): void {}
  },
}));

// Keep the real boot, input, mirror, HUD and presentation runtime; only GPU drawing is absent.
vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal<typeof import('three')>()),
  WebGLRenderer: class {
    info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio(): void {}
    forceContextLoss(): void {}
    setSize(): void {}
    render(): void {}
    dispose(): void {}
  },
}));
vi.mock('../presentation/assets.js', async (importOriginal) => {
  const assets = await importOriginal<typeof import('../presentation/assets.js')>();
  return {
    ...assets,
    loadPresentationAssets: (config: ResolvedPresentation, options?: AssetLoadOptions) =>
      assets.loadPresentationAssets(config, {
        ...options,
        loaders: options?.loaders ?? runtimeLoaders(),
      }),
  };
});

class HudElement extends EventTarget {
  textContent = '';
  hidden = false;
  disabled = false;
  readonly attributes = new Map<string, string>();
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

interface PendingRequest {
  url: string;
  body: string | undefined;
  resolve(response: Response): void;
  reject(error: unknown): void;
}

const manifest: PresentationManifest = {
  aegis: 'presentation/1',
  objects: [{ id: 'gate', visual: { kind: 'primitive', shape: 'box' } }],
  effects: [{ event: 'opened', kind: 'pulse', target: { object: 'gate' }, durationTicks: 20 }],
  hud: {
    playerName: 'player',
    winEvent: 'completed',
    loseEvents: ['failed'],
    steps: [{ id: 'gate', label: 'Open the gate', event: 'opened' }],
  },
};

let dom: FakeDom;
let globalEvents: EventTarget;
let elements: Map<string, HudElement>;
let animationFrames: Map<number, FrameRequestCallback>;
let collectionTasks: Map<number, () => void>;
let nextTask = 0;
let requests: PendingRequest[];
let nextFrame = 0;

beforeEach(() => {
  cinematic.render.mockReset();
  dom = installFakeDom();
  globalEvents = new EventTarget();
  elements = new Map(
    [
      'hud-progress',
      'hud-outcome',
      'hud-step-0',
      'hud-status',
      'action-pause',
      'hud-events',
      'loading-message',
    ].map((id) => [id, new HudElement()]),
  );
  animationFrames = new Map();
  collectionTasks = new Map();
  nextTask = 0;
  requests = [];
  nextFrame = 0;
  vi.stubGlobal('document', {
    baseURI: 'http://aegis.test/play/demo/',
    pointerLockElement: dom.canvas,
    getElementById: (id: string) => (id === 'stage' ? dom.canvas : (elements.get(id) ?? null)),
  });
  vi.stubGlobal('addEventListener', globalEvents.addEventListener.bind(globalEvents));
  vi.stubGlobal('removeEventListener', globalEvents.removeEventListener.bind(globalEvents));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => animationFrames.delete(id));
  vi.stubGlobal('setTimeout', (callback: () => void, delay: number) => {
    expect(delay).toBe(0);
    collectionTasks.set(++nextTask, callback);
    return nextTask;
  });
  vi.stubGlobal('clearTimeout', (id: number) => collectionTasks.delete(id));
  vi.stubGlobal(
    'fetch',
    (url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({
          url,
          body: typeof init?.body === 'string' ? init.body : undefined,
          resolve,
          reject,
        });
      }),
  );
  vi.stubGlobal('aegis', undefined);
});

afterEach(() => {
  globalEvents.dispatchEvent(new Event('beforeunload'));
  vi.unstubAllGlobals();
  dom.restore();
});

function debug(): AegisDebugHandle {
  return (globalThis as typeof globalThis & { aegis: AegisDebugHandle }).aegis;
}

function response(
  tick: number,
  generation: number | undefined,
  events: readonly EventLine[] = [],
  paused = false,
  eventHistory: readonly EventLine[] | undefined = generation === undefined ? undefined : events,
): FrameResponse {
  const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
  return {
    tick,
    generation,
    paused,
    events,
    eventHistory,
    steps: 0,
    snapshot: { ...world.snapshot(), tick },
  };
}

function takeRequest(endpoint: string): PendingRequest {
  const index = requests.findIndex((request) => request.url.endsWith(`/${endpoint}`));
  expect(index, `No pending ${endpoint} request`).toBeGreaterThanOrEqual(0);
  return requests.splice(index, 1)[0]!;
}

async function answer(request: PendingRequest, value: FrameResponse): Promise<void> {
  request.resolve(new Response(JSON.stringify(value)));
  await settle();
}

async function display(collect = true): Promise<void> {
  const next = animationFrames.entries().next().value;
  if (next === undefined) throw new Error('The real boot did not schedule a display frame.');
  animationFrames.delete(next[0]);
  next[1](0);
  await settle();
  if (collect) {
    const task = collectionTasks.entries().next().value;
    if (task !== undefined) {
      collectionTasks.delete(task[0]);
      task[1]();
      await settle();
    }
  }
}

async function launch(profile: PresentationManifest | undefined): Promise<void> {
  boot({
    gameId: 'demo',
    mode: 'platformer',
    title: 'Response ordering',
    objective: 'Open the gate',
    api: '../../api/demo',
    ...(profile === undefined
      ? {}
      : { presentation: { manifest: profile, baseUrl: '../../assets/demo/' } }),
  });
  await settle();
}

async function start(
  presentation = true,
  initial = response(0, presentation ? 0 : undefined),
  profile = manifest,
): Promise<void> {
  await launch(presentation ? profile : undefined);
  await display();
  const request = takeRequest('frame');
  expect(JSON.parse(request.body!).presentationGeneration).toBe(presentation ? null : undefined);
  await answer(request, initial);
  await debug().ready;
}

function lossProfile(): PresentationManifest {
  class Node extends HudElement {
    dataset: Record<string, string> = {};
    style = { setProperty: vi.fn() };
    getBoundingClientRect = () => ({});
    focus(): void {
      Object.defineProperty(document, 'activeElement', { value: this, configurable: true });
    }
  }
  class Dialog extends Node {
    open = false;
    showModal(): void {
      this.open = true;
    }
    close(): void {
      this.open = false;
    }
  }
  class Button extends Node {}
  vi.stubGlobal('HTMLDialogElement', Dialog);
  vi.stubGlobal('HTMLButtonElement', Button);
  elements.set('loss-ending', new Dialog());
  elements.set('loss-restart', new Button());
  elements.set('loss-shade', new Node());
  elements.set('loss-error', new Node());
  Object.assign(document, {
    addEventListener: globalEvents.addEventListener.bind(globalEvents),
    removeEventListener: globalEvents.removeEventListener.bind(globalEvents),
    exitPointerLock: () =>
      Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true }),
  });
  Object.assign(dom.canvas, { focus: vi.fn() });
  return { ...manifest, ui: { lossEnding: { fadeSeconds: 0 } } };
}

describe('live receipts across real presentation lifecycle callbacks', () => {
  it('drops a queued old-generation collection when restart arrives before the task', async () => {
    await start();
    dom.dispatch('keydown', keyEvent('Space'));
    const rejected = vi.fn();
    const waiting = debug().sync().then(vi.fn(), rejected);
    await display(false);
    expect(requests).toHaveLength(0);
    expect(collectionTasks.size).toBe(1);
    dom.dispatch('keydown', keyEvent('KeyR'));
    await answer(takeRequest('control'), response(0, 1));
    await waiting;
    expect(rejected).toHaveBeenCalledOnce();
    expect(collectionTasks.size).toBe(0);
    expect(requests).toHaveLength(0);
    await display();
    const fresh = takeRequest('frame');
    expect(JSON.parse(fresh.body!)).toMatchObject({
      client: { generation: 1, claim: false },
      input: { held: [], pressed: [], look: { dx: 0, dy: 0 } },
    });
    await answer(fresh, response(0, 1));
  });

  it('keeps accepted action delivery valid when that reply opens the loss dialog, without leaking intent into restart', async () => {
    await start(true, response(0, 0), lossProfile());
    dom.dispatch('keydown', keyEvent('Space'));
    dom.dispatch('keyup', keyEvent('Space'));
    const synced = vi.fn();
    const rejected = vi.fn();
    const pending = debug().sync().then(synced, rejected);
    await display();
    const request = takeRequest('frame');
    const packet = JSON.parse(request.body!) as { input: InputPacket };
    expect(packet.input).toMatchObject({ held: [], pressed: ['Jump'], released: ['Jump'] });
    await answer(request, {
      ...response(1, 0, [{ type: 'failed', tick: 0, sequence: 0 }]),
      inputStatus: {
        accepted: true,
        reason: 'accepted',
        role: 'controlling',
        lastSeq: packet.input.seq,
      },
    });
    expect(debug().presentation()).toMatchObject({
      ending: { active: true },
      input: { capture: { gameplayBlocked: true } },
    });
    expect(rejected).not.toHaveBeenCalled();
    expect(synced).not.toHaveBeenCalled();
    await display();
    await pending;
    expect(synced).toHaveBeenCalledOnce();
    expect(debug().timings().exchangeErrors).toBe(0);
    await answer(takeRequest('frame'), response(1, 0));
    dom.dispatch('keyup', keyEvent('Space'));
    dom.dispatch('keydown', keyEvent('KeyR'));
    await answer(takeRequest('control'), response(0, 1));
    await display();
    await answer(takeRequest('frame'), response(0, 1));
    await display();
    await answer(takeRequest('frame'), response(0, 1));
    expect(debug().presentation()).toMatchObject({ ending: { active: false } });
    dom.dispatch('keydown', keyEvent('Space'));
    const nextRejected = vi.fn();
    const next = debug().sync().then(vi.fn(), nextRejected);
    dom.dispatch('blur', {});
    await next;
    expect(nextRejected).toHaveBeenCalledOnce();
  });

  it.each(['cold-dead', 'shared-dead'] as const)(
    'does not resolve a %s restart observer before the real deferred ending reset is presented',
    async (initial) => {
      const profile = lossProfile();
      const oldGeneration = initial === 'cold-dead' ? 4 : 0;
      if (initial === 'cold-dead') {
        await start(
          true,
          response(5, oldGeneration, [], true, [{ type: 'failed', tick: 3, sequence: 0 }]),
          profile,
        );
        await display();
        await answer(takeRequest('frame'), response(5, oldGeneration, [], true));
      } else {
        await start(true, response(0, oldGeneration, [], true), profile);
        await display();
        await answer(
          takeRequest('frame'),
          response(1, oldGeneration, [{ type: 'failed', tick: 0, sequence: 0 }], true),
        );
      }
      expect(debug().presentation()).toMatchObject({
        ending: { active: true },
        input: { capture: { gameplayBlocked: true } },
      });
      dom.dispatch('keydown', keyEvent('KeyR'));
      await answer(takeRequest('control'), response(0, oldGeneration + 1, [], true));
      const synced = vi.fn();
      const rejected = vi.fn();
      const pending = debug().sync().then(synced, rejected);
      await display();
      await answer(takeRequest('frame'), response(0, oldGeneration + 1, [], true));
      expect(debug().tick()).toBe(0);
      expect(debug().presentation()).toMatchObject({ ending: { active: true } });
      expect(synced).not.toHaveBeenCalled();
      await display();
      await pending;
      expect(rejected).not.toHaveBeenCalled();
      expect(synced).toHaveBeenCalledOnce();
      expect(debug().presentation()).toMatchObject({
        ending: { active: false },
        input: { capture: { gameplayBlocked: false } },
      });
      expect(debug().timings().exchangeErrors).toBe(0);
    },
  );

  it('rejects an accepted action superseded by restart before presentation instead of confirming it in a new generation', async () => {
    await start();
    dom.dispatch('keydown', keyEvent('Space'));
    dom.dispatch('keyup', keyEvent('Space'));
    const synced = vi.fn();
    const rejected = vi.fn();
    const pending = debug().sync().then(synced, rejected);
    await display();
    const request = takeRequest('frame');
    const { input } = JSON.parse(request.body!) as { input: InputPacket };
    expect(input).toMatchObject({ held: [], pressed: ['Jump'], released: ['Jump'] });
    await answer(request, {
      ...response(0, 0),
      inputStatus: { accepted: true, role: 'controlling', reason: 'accepted', lastSeq: input.seq },
    });
    expect(synced).not.toHaveBeenCalled();
    dom.dispatch('keydown', keyEvent('KeyR'));
    await answer(takeRequest('control'), response(0, 1));
    await pending;
    expect(rejected).toHaveBeenCalledOnce();
    expect(synced).not.toHaveBeenCalled();
    await display();
    await answer(takeRequest('frame'), response(0, 1));
    await display();
    expect(synced).not.toHaveBeenCalled();
    expect(debug().tick()).toBe(0);
    expect(debug().timings().exchangeErrors).toBe(0);
  });
});

describe('dev-client controller polling', () => {
  it.each([
    { presentation: false, paused: true },
    { presentation: true, paused: true },
    { presentation: false, paused: false },
    { presentation: true, paused: false },
  ])(
    'keeps View restart pause state before another display frame: %j',
    async ({ presentation, paused }) => {
      const pad = virtualGamepad();
      vi.stubGlobal('navigator', { getGamepads: () => [pad] });
      const initialGeneration = presentation ? 0 : undefined;
      await start(presentation, response(12, initialGeneration, [], paused));
      await display();
      await answer(takeRequest('frame'), response(12, initialGeneration, [], paused));
      const button = elements.get('action-pause');
      expect(button?.getAttribute('aria-pressed')).toBe(String(paused));
      pad.buttons[8]!.value = 1;
      await display();
      const oldFrame = takeRequest('frame');
      const restart = takeRequest('control');
      expect(JSON.parse(restart.body!)).toEqual({ command: 'restart' });
      await answer(restart, response(0, presentation ? 1 : undefined, [], paused));
      // No display() here: restart publishes tick 0 before the next animation frame.
      expect(debug().tick()).toBe(0);
      expect(button?.getAttribute('aria-pressed')).toBe(String(paused));
      expect(button?.textContent).toBe(paused ? 'Resume' : 'Pause');
      pad.buttons[8]!.value = 0;
      await answer(oldFrame, response(13, initialGeneration, [], paused));
      expect(debug().tick()).toBe(0);
      expect(button?.getAttribute('aria-pressed')).toBe(String(paused));
      await display();
      expect(button?.getAttribute('aria-pressed')).toBe(String(paused));
    },
  );

  it('draws a cold cinematic generation before arming another HTTP deadline', async () => {
    await start(true, response(0, 0), {
      ...manifest,
      quality: 'high',
      pipeline: { toneMapping: 'aces' },
    });
    cinematic.render.mockImplementation(() => expect(requests).toHaveLength(0));
    await display();
    expect(cinematic.render).toHaveBeenCalledOnce();
    cinematic.render.mockImplementation(() => undefined);
    await display();
    expect(requests).toHaveLength(1);
    await answer(takeRequest('frame'), response(0, 1));
    cinematic.render.mockImplementation(() => expect(requests).toHaveLength(0));
    await display();
    cinematic.render.mockImplementation(() => undefined);
    await display();
    expect(requests).toHaveLength(1);
  });

  it('captures a press/release between exchanges while the preceding HTTP frame is in flight', async () => {
    const pad = virtualGamepad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    await start();
    await display();
    const inFlight = takeRequest('frame');
    pad.buttons[0]!.value = 1;
    await display();
    pad.buttons[0]!.value = 0;
    await display();
    expect(requests).toHaveLength(0);
    await answer(inFlight, response(1, 0));
    await display();
    const packet: { input: InputPacket } = JSON.parse(takeRequest('frame').body!);
    expect(packet.input).toMatchObject({ held: [], pressed: ['Jump'], released: ['Jump'] });
  });

  it('receives controller pause/resume commands without forwarding paused actions', async () => {
    const pad = virtualGamepad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    await start();
    pad.buttons[9]!.value = 1;
    await display();
    const pause = takeRequest('control');
    expect(JSON.parse(pause.body!)).toEqual({ command: 'toggle' });
    expect(requests).toHaveLength(0);
    await answer(pause, response(1, 0, [], true));
    pad.buttons[9]!.value = 0;
    await display();
    await answer(takeRequest('frame'), response(1, 0, [], true));
    pad.buttons[0]!.value = 1;
    await display();
    const pausedFrame = takeRequest('frame');
    const packet: { input: InputPacket } = JSON.parse(pausedFrame.body!);
    expect(packet.input.held).toEqual([]);
    expect(packet.input.pressed).toEqual([]);
    await answer(pausedFrame, response(1, 0, [], true));
    pad.buttons[9]!.value = 1;
    await display();
    const resume = takeRequest('control');
    expect(JSON.parse(resume.body!)).toEqual({ command: 'toggle' });
    expect(requests).toHaveLength(0);
    await answer(resume, response(1, 0, [], false));
    await display();
    const resumed: { input: InputPacket } = JSON.parse(takeRequest('frame').body!);
    expect(resumed.input).toMatchObject({ held: [], pressed: [] });
  });
});

describe('dev-client synchronization', () => {
  it('distinguishes body-read cancellation after HTTP 200 from request and validation errors', async () => {
    await start();
    await display();
    const reply = new Response('{}', { status: 200 });
    vi.spyOn(reply, 'text').mockRejectedValue(
      new DOMException('The user aborted a request.', 'AbortError'),
    );
    takeRequest('frame').resolve(reply);
    await settle();
    expect(debug().timings()).toMatchObject({
      exchangeErrors: 1,
      firstExchangeFailure: {
        stage: 'body',
        responseStatus: 200,
        name: 'AbortError',
        message: 'The user aborted a request.',
      },
    });
  });

  it('keeps genuine request failures counted and retains their first cause through recovery', async () => {
    await start();
    await display();
    const failed = takeRequest('frame');
    const seq = (JSON.parse(failed.body!) as { input: InputPacket }).input.seq;
    failed.reject(new DOMException('Timed out at the unchanged deadline', 'TimeoutError'));
    await settle();
    expect(debug().timings()).toMatchObject({
      exchangeErrors: 1,
      firstExchangeFailure: {
        stage: 'request',
        message: 'Timed out at the unchanged deadline',
        name: 'TimeoutError',
        requestSequence: seq,
        requestGeneration: 0,
        generation: 0,
      },
    });
    const first = debug().timings().firstExchangeFailure!;
    first.message = 'caller mutation';
    expect(debug().timings().firstExchangeFailure?.message).not.toBe('caller mutation');
    await display();
    await answer(takeRequest('frame'), response(1, 0));
    expect(debug().timings().exchangeErrors).toBe(1);
    expect(debug().timings().firstExchangeFailure?.message).toBe(
      'Timed out at the unchanged deadline',
    );
    await display();
    const refused = takeRequest('frame');
    refused.resolve(new Response('bad input is still an error', { status: 400 }));
    await settle();
    expect(debug().timings().exchangeErrors).toBe(2);
    expect(elements.get('loading-message')?.textContent).toContain('responded 400');
    expect(debug().timings().firstExchangeFailure?.message).toBe(
      'Timed out at the unchanged deadline',
    );
  });

  it('cannot execute paused key taps while the resume acknowledgement is delayed', async () => {
    await start(true, response(0, 0, [], true));
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    session.step();
    dom.dispatch('keydown', keyEvent('Space'));
    dom.dispatch('keyup', keyEvent('Space'));
    dom.dispatch('keydown', keyEvent('KeyP'));
    const resume = takeRequest('control');
    // The server has resumed, but the client has not received its acknowledgement.
    dom.dispatch('keydown', keyEvent('Space'));
    dom.dispatch('keyup', keyEvent('Space'));
    await display();
    await display();
    expect(requests).toHaveLength(0);
    await answer(resume, response(0, 0, [], false));
    await display();
    const request = takeRequest('frame');
    const packet: { input: InputPacket } = JSON.parse(request.body!);
    session.input.submit(packet.input);
    session.step();
    expect(
      session.world.events.history().filter((event) => event.type === 'player.jumped'),
    ).toHaveLength(0);
    expect(packet.input).toMatchObject({ held: [], pressed: [] });
    await answer(request, response(1, 0));
    dom.dispatch('keydown', keyEvent('Space'));
    await display();
    const fresh: { input: InputPacket } = JSON.parse(takeRequest('frame').body!);
    session.input.submit(fresh.input);
    session.step();
    expect(
      session.world.events.history().filter((event) => event.type === 'player.jumped'),
    ).toHaveLength(1);
  });

  it('orders an outstanding paused frame before resume and blocks new exchanges until acknowledgement', async () => {
    await start(true, response(0, 0, [], true));
    dom.dispatch('keydown', keyEvent('Space'));
    dom.dispatch('keyup', keyEvent('Space'));
    await display();
    const oldFrame = takeRequest('frame');
    dom.dispatch('keydown', keyEvent('KeyP'));
    await display();
    expect(requests).toHaveLength(0);
    await answer(oldFrame, response(0, 0, [], true));
    const resume = takeRequest('control');
    await display();
    expect(requests).toHaveLength(0);
    await answer(resume, response(0, 0, [], false));
    await display();
    const fresh: { input: InputPacket } = JSON.parse(takeRequest('frame').body!);
    expect(fresh.input).toMatchObject({ held: [], pressed: [], reset: true });
  });

  it('does not let a delayed restart acknowledgement erase a newer same-generation frame', async () => {
    await start();
    dom.dispatch('keydown', keyEvent('KeyR'));
    const restart = takeRequest('control');
    expect(JSON.parse(restart.body!)).toEqual({ command: 'restart' });

    await display();
    await answer(takeRequest('frame'), response(1, 1, [{ type: 'opened', tick: 0, sequence: 0 }]));
    await display();
    expect(debug().tick()).toBe(1);
    expect(elements.get('hud-progress')?.textContent).toBe('1 / 1 complete');
    expect(debug().adapter.presentation?.stats().effects.active).toBe(1);

    dom.dispatch('keydown', keyEvent('Space'));
    await answer(restart, response(0, 1, [], true));
    expect(debug().tick()).toBe(1);
    expect(elements.get('hud-progress')?.textContent).toBe('1 / 1 complete');
    await display();
    expect(debug().adapter.presentation?.stats().effects.active).toBe(1);
    expect(elements.get('hud-status')?.textContent).not.toBe('paused');
    await answer(takeRequest('frame'), response(2, 1));
    await display();
    expect(JSON.parse(takeRequest('frame').body!).input.pressed).toContain('Jump');
  });

  describe('dev-client history hydration', () => {
    it('restores a cold client at the current snapshot without replaying historical audio or transient effects', async () => {
      const profile = runtimeManifest({
        objects: [{ id: 'gate', visual: { kind: 'model', mesh: 'rig' } }],
        effects: [
          {
            event: 'opened',
            kind: 'clip',
            target: { object: 'gate' },
            clip: 'lift',
            durationTicks: 30,
            holdLast: true,
          },
          { event: 'ping', kind: 'burst', target: { object: 'gate' }, count: 3, durationTicks: 20 },
        ],
        audio: {
          cues: [
            { event: 'opened', asset: 'tone' },
            { event: 'ping', asset: 'tone' },
          ],
        },
        hud: manifest.hud,
      });
      const history = [
        { type: 'opened', tick: 10, sequence: 0 },
        { type: 'ping', tick: 11, sequence: 1 },
        { type: 'completed', tick: 40, sequence: 2 },
      ];
      const initial = response(41, 3, [], false, history);
      await start(true, initial, profile);
      const runtime = debug().adapter.presentation!;
      const fin = runtime.object('gate')!.object.getObjectByName('fin')!;
      expect(elements.get('hud-progress')?.textContent).toBe('1 / 1 complete');
      expect(elements.get('hud-outcome')?.textContent).toBe('Objective complete');
      expect(fin.position.y).toBeCloseTo(2.1);
      expect(debug().world.snapshot()).toEqual(initial.snapshot);
      expect(runtime.stats().effects.active).toBe(0);
      expect(debug().presentation()).toMatchObject({ audio: { dropped: 0, voices: 0 } });

      await display();
      const next = takeRequest('frame');
      expect(JSON.parse(next.body!).presentationGeneration).toBe(3);
      await answer(next, response(42, 3, [...history, { type: 'ping', tick: 41, sequence: 3 }]));
      await display();
      expect(fin.position.y).toBeCloseTo(2.1);
      expect(runtime.stats().effects.active).toBe(3);
      expect(debug().presentation()).toMatchObject({ audio: { dropped: 1, voices: 0 } });
      expect(elements.get('hud-events')?.textContent.match(/opened/g)).toHaveLength(1);
    });

    it('does not announce readiness for missing or inconsistent history and retries the same hydration request', async () => {
      await launch(manifest);
      const ready = vi.fn();
      void debug().ready.then(ready);
      const missing = response(0, 0);
      delete missing.eventHistory;
      const badFrames = [
        missing,
        response(0, 0, [], false, [{ type: 'opened', tick: 0, sequence: 1 }]),
        response(0, 0, [], false, [{ type: 'opened', tick: 1, sequence: 0 }]),
        { ...response(0, 0), tick: 1 },
      ];
      for (const [index, invalid] of badFrames.entries()) {
        await display();
        const request = takeRequest('frame');
        expect(JSON.parse(request.body!).presentationGeneration).toBeNull();
        await answer(request, invalid);
        expect(ready).not.toHaveBeenCalled();
        expect(debug().tick()).toBe(-1);
        expect(debug().timings().exchangeErrors).toBe(index + 1);
        expect(debug().timings().firstExchangeFailure).toMatchObject({
          stage: 'response',
          name: 'Error',
          requestGeneration: 0,
          tick: -1,
        });
        expect(elements.get('loading-message')?.textContent).toMatch(/history.*retry/i);
      }
      await display();
      await answer(takeRequest('frame'), response(0, 0));
      await debug().ready;
      expect(ready).toHaveBeenCalledTimes(1);
      expect(debug().tick()).toBe(0);
    });

    it('ignores stale-generation hydration after a newer restart and rehydrates only the accepted generation', async () => {
      await start();
      await display();
      const stale = takeRequest('frame');
      dom.dispatch('keydown', keyEvent('KeyR'));
      await answer(takeRequest('control'), response(0, 2));
      await answer(
        stale,
        response(50, 1, [], false, [
          { type: 'opened', tick: 0, sequence: 0 },
          { type: 'completed', tick: 1, sequence: 1 },
        ]),
      );
      expect(debug().tick()).toBe(0);
      expect(elements.get('hud-progress')?.textContent).toBe('0 / 1 complete');
      expect(elements.get('hud-outcome')?.textContent).toBe('');
      await display();
      const current = takeRequest('frame');
      expect(JSON.parse(current.body!).presentationGeneration).toBe(0);
      await answer(current, response(2, 2));
      expect(debug().tick()).toBe(2);
      expect(debug().presentation()).toMatchObject({ generation: 2 });
      await display();
      expect(JSON.parse(takeRequest('frame').body!).presentationGeneration).toBe(2);
    });
  });

  it('resets once when the restart response arrives first and ignores an earlier generation', async () => {
    await start();
    await display();
    await answer(
      takeRequest('frame'),
      response(30, 0, [{ type: 'opened', tick: 29, sequence: 0 }]),
    );
    const synced = vi.fn();
    void debug().sync().then(synced);
    await display();
    const oldFrame = takeRequest('frame');
    dom.dispatch('keydown', keyEvent('KeyR'));
    await answer(takeRequest('control'), response(0, 1));
    expect(debug().tick()).toBe(0);
    expect(elements.get('hud-progress')?.textContent).toBe('0 / 1 complete');
    expect(debug().adapter.presentation?.stats().effects.active).toBe(0);

    await answer(oldFrame, response(31, 0, [{ type: 'completed', tick: 30, sequence: 1 }]));
    expect(debug().tick()).toBe(0);
    expect(elements.get('hud-outcome')?.textContent).toBe('');
    expect(synced).not.toHaveBeenCalled();
    await display();
    await answer(takeRequest('frame'), response(1, 1, [{ type: 'opened', tick: 0, sequence: 0 }]));
    expect(synced).not.toHaveBeenCalled();
    await display();
    expect(synced).toHaveBeenCalledTimes(1);
    expect(elements.get('hud-progress')?.textContent).toBe('1 / 1 complete');
  });

  it('rejects a delayed older restart after two newer generations without clearing fresh input', async () => {
    await start();
    dom.dispatch('keydown', keyEvent('KeyR'));
    const firstRestart = takeRequest('control');
    await display();
    await answer(takeRequest('frame'), response(1, 1));
    dom.dispatch('keydown', keyEvent('KeyR'));
    const secondRestart = takeRequest('control');
    await display();
    await answer(takeRequest('frame'), response(1, 2, [{ type: 'opened', tick: 0, sequence: 0 }]));
    dom.dispatch('keydown', keyEvent('Space'));
    await answer(firstRestart, response(0, 1, [], true));
    await answer(secondRestart, response(0, 2, [], true));
    expect(debug().tick()).toBe(1);
    expect(debug().presentation()).toMatchObject({ generation: 2 });
    expect(elements.get('hud-progress')?.textContent).toBe('1 / 1 complete');
    await display();
    expect(JSON.parse(takeRequest('frame').body!).input.pressed).toContain('Jump');
    expect(elements.get('hud-status')?.textContent).not.toBe('paused');
  });

  it('keeps events from an older same-generation frame without rolling back a newer control snapshot', async () => {
    await start();
    await display();
    const oldFrame = takeRequest('frame');
    dom.dispatch('keydown', keyEvent('Period'));
    await answer(takeRequest('control'), response(5, 0, [], true));
    await answer(oldFrame, response(2, 0, [{ type: 'opened', tick: 1, sequence: 0 }]));
    expect(debug().tick()).toBe(5);
    expect(elements.get('hud-progress')?.textContent).toBe('1 / 1 complete');
    await display();
    expect(elements.get('hud-status')?.textContent).toBe('paused');
    expect(debug().adapter.presentation?.stats().effects.active).toBe(1);
  });

  it('keeps the restart path working for legacy responses without generation metadata', async () => {
    await start(false);
    await display();
    await answer(takeRequest('frame'), response(30, undefined));
    await display();
    const oldFrame = takeRequest('frame');
    dom.dispatch('keydown', keyEvent('KeyR'));
    await answer(takeRequest('control'), response(0, undefined));
    await answer(oldFrame, response(31, undefined));
    expect(debug().tick()).toBe(0);
    await display();
    await answer(takeRequest('frame'), response(1, undefined));
    expect(debug().tick()).toBe(1);
  });
});

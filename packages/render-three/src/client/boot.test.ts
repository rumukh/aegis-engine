import { setImmediate as settle } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformerPlugin } from '@aegis/mode-platformer';
import type { EventLine, FrameResponse } from '../protocol.js';
import type { PresentationManifest } from '../presentation/schema.js';
import { installFakeDom, keyEvent } from '../testing/dom.js';
import type { FakeDom } from '../testing/dom.js';
import { PLATFORMER_SCENE } from '../testing/scenes.js';
import { buildTestWorld } from '../testing/world.js';
import { boot } from './boot.js';
import type { AegisDebugHandle } from './boot.js';

// Keep the real boot, input, mirror, HUD and presentation runtime; only GPU drawing is absent.
vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal<typeof import('three')>()),
  WebGLRenderer: class {
    info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio(): void {}
    setSize(): void {}
    render(): void {}
    dispose(): void {}
  },
}));

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
let requests: PendingRequest[];
let nextFrame = 0;

beforeEach(() => {
  dom = installFakeDom();
  globalEvents = new EventTarget();
  elements = new Map(
    ['hud-progress', 'hud-outcome', 'hud-step-0', 'hud-status', 'hud-events'].map((id) => [
      id,
      new HudElement(),
    ]),
  );
  animationFrames = new Map();
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
  vi.stubGlobal(
    'fetch',
    (url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({
          url,
          body: typeof init?.body === 'string' ? init.body : undefined,
          resolve,
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
): FrameResponse {
  const world = buildTestWorld(PLATFORMER_SCENE, platformerPlugin);
  return {
    tick,
    generation,
    paused,
    events,
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

async function display(): Promise<void> {
  const next = animationFrames.entries().next().value;
  if (next === undefined) throw new Error('The real boot did not schedule a display frame.');
  animationFrames.delete(next[0]);
  next[1](0);
  await settle();
}

async function start(presentation = true): Promise<void> {
  boot({
    gameId: 'demo',
    mode: 'platformer',
    title: 'Response ordering',
    objective: 'Open the gate',
    api: '../../api/demo',
    ...(presentation ? { presentation: { manifest, baseUrl: '../../assets/demo/' } } : {}),
  });
  await settle();
  await display();
  await answer(takeRequest('frame'), response(0, presentation ? 0 : undefined));
  await debug().ready;
}

describe('dev-client response ordering', () => {
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

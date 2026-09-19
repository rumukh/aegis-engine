import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { createSchedule, defineComponent, Name, Transform } from '@aegis/core';
import type { GameMode, ResourceType, World } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import type { ModePlugin } from '@aegis/harness';
import { platformerPlugin } from '@aegis/mode-platformer';
import type { RenderAdapter } from '../adapter.js';
import type { EventLine } from '../protocol.js';
import type { LiveSession, LiveSessionOptions } from '../session.js';
import { createLiveSession } from '../session.js';
import { buttonEvent, installFakeDom, keyEvent } from '../testing/dom.js';
import type { FakeDom } from '../testing/dom.js';
import type { PresentationHostOptions } from './presentation-host.js';
import { bootStatic } from './static-boot.js';
import { virtualGamepad } from '../testing/gamepad.js';

const hooks = vi.hoisted(() => {
  const sessions: LiveSession[] = [];
  return { sessions, host: vi.fn<(options: PresentationHostOptions) => object>() };
});
vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>();
  return {
    ...actual,
    createLiveSession(options: LiveSessionOptions): LiveSession {
      const session = actual.createLiveSession(options);
      hooks.sessions.push(session);
      return session;
    },
  };
});
vi.mock('./presentation-host.js', () => ({
  PresentationHost: function (options: PresentationHostOptions): object {
    return hooks.host(options);
  },
}));

interface ProbeData {
  nested: { value: number };
  samples: number[];
  jumps: number;
}
const Probe = defineComponent<ProbeData>({
  id: 'StaticProbe',
  defaults: () => ({ nested: { value: 0 }, samples: [], jumps: 0 }),
});
const Resource: ResourceType<{ nested: { value: number }; samples: number[] }> = {
  id: 'static.probe',
  create: () => ({ nested: { value: 0 }, samples: [] }),
};
const DT = 1 / 32;

function resource(world: World): ReturnType<typeof Resource.create> {
  const value = world.getResource(Resource);
  if (value === undefined) throw new Error('Missing static-client fixture resource.');
  return value;
}
function body(world: World): ProbeData {
  return world
    .query({ has: [Probe] })
    .one()
    .get(Probe);
}
function fixture(mode: GameMode = 'platformer'): LiveSessionOptions {
  const scene: SceneFile = {
    aegis: 'scene/1',
    name: 'static observation fixture',
    mode,
    seed: 'static-observation',
    resources: { [Resource.id]: { nested: { value: 17 }, samples: [19, 23] } },
    entities: [
      {
        id: 'player',
        components: {
          Transform: { position: { x: 1, y: 2, z: 3 } },
          StaticProbe: { nested: { value: 7 }, samples: [11, 13], jumps: 0 },
        },
      },
      { id: 'other', components: { Transform: { position: { x: 4, y: 5, z: 6 } } } },
    ],
  };
  const plugin: ModePlugin = {
    mode,
    components: () => [Probe],
    resources: () => [Resource],
    init(world): void {
      world.despawn(world.spawn(Name({ value: 'free-slot' })));
      world.events.emit('probe.started', { nested: { value: 29 } });
    },
    systems: () =>
      createSchedule().add({
        name: 'static.probe',
        phase: 'update',
        run({ world, input }): void {
          const value = body(world);
          value.nested.value++;
          value.samples.push(world.random.nextUint32());
          if (input.pressed.includes('Jump')) value.jumps++;
          resource(world).nested.value += 2;
          const transient = world.spawn(Name({ value: 'simulation-transient' }));
          world.despawn(transient);
          world.events.emit('probe.stepped', { nested: { value: value.nested.value } });
        },
      }),
    view: platformerPlugin.view,
  };
  return { scene, plugin, tickRate: 32 };
}

function makeHost() {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const camera = new PerspectiveCamera();
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const adapter = {
    mode: 'platformer',
    scene: new Scene(),
    camera,
    mount: vi.fn<(world: World) => void>(),
    sync: vi.fn<(world: World) => void>(),
    resize: vi.fn<(width: number, height: number) => void>(),
    pick: vi.fn(() => ({ x: 3, y: 0, z: 4 })),
    dispose: vi.fn(),
  } satisfies RenderAdapter;
  const renderer = { setSize: vi.fn(), render: vi.fn() };
  return {
    ready,
    adapter,
    renderer,
    captureInput: vi.fn(),
    resize: (width: number, height: number) => {
      renderer.setSize(width, height, false);
      adapter.resize(width, height);
    },
    render: () => renderer.render(adapter.scene, adapter.camera),
    hud: { setStatus: vi.fn(), setStats: vi.fn() },
    start: vi.fn((start: () => void) => start()),
    mounted: vi.fn(() => resolveReady()),
    validateWorld: vi.fn<(world: World) => void>(),
    receive: vi.fn<(events: readonly EventLine[], generation: number) => void>(),
    present: vi.fn<(tick: number, paused: boolean) => void>(),
    reset: vi.fn<(generation: number) => void>(),
    stats: () => ({}),
    fail: vi.fn(),
    dispose: vi.fn(),
  };
}

let dom: FakeDom;
let host: ReturnType<typeof makeHost>;
let now: number;
let nextFrame: number;
const pendingFrames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  vi.clearAllMocks();
  hooks.sessions.length = 0;
  host = makeHost();
  hooks.host.mockReturnValue(host);
  dom = installFakeDom({ viewport: { width: 640, height: 360 } });
  vi.stubGlobal('addEventListener', window.addEventListener);
  vi.stubGlobal('removeEventListener', window.removeEventListener);
  vi.stubGlobal('aegis', undefined);
  now = 0;
  nextFrame = 0;
  pendingFrames.clear();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => pendingFrames.delete(id)),
  );
});
afterEach(() => {
  dom.dispatch('beforeunload', {});
  dom.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pendingFrames.clear();
});

function display(elapsed = 0): void {
  now += elapsed;
  expect(pendingFrames.size, 'the real client must have queued exactly one frame').toBe(1);
  const queued = pendingFrames.entries().next().value;
  if (queued === undefined) throw new Error('The client stopped scheduling frames.');
  pendingFrames.delete(queued[0]);
  queued[1](now * 1000);
}
function command(code: 'KeyP' | 'Period' | 'KeyR'): void {
  dom.dispatch('keydown', keyEvent(code));
}
function boot(mode: GameMode = 'platformer') {
  const options = fixture(mode);
  const sessionIndex = hooks.sessions.length;
  const debug = bootStatic({
    ...options,
    mode,
    gameId: 'probe',
    canvas: dom.canvas,
    clock: () => now,
    presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './' },
  });
  const session = hooks.sessions[sessionIndex];
  if (session === undefined) throw new Error('bootStatic did not create a real LiveSession.');
  return {
    debug,
    session,
    snapshot: vi.spyOn(session, 'snapshot'),
    restore: vi.spyOn(debug.world, 'restore'),
    advance: vi.spyOn(session, 'advance'),
    submit: vi.spyOn(session.input, 'submit'),
  };
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a fixture data object.');
  }
  return value as Record<string, unknown>;
}
function evidence(world: World) {
  return {
    snapshot: world.snapshot(),
    history: world.events.history(),
    currentEvents: world.events.thisTick(),
    eventDigest: world.events.digest(),
  };
}
function expectUnchangedAuthority(actual: World, independent: World): void {
  expect(evidence(actual)).toEqual(evidence(independent));
}

describe('static-client controller polling', () => {
  it('does not spend pre-restart elapsed time on the newly restarted world', () => {
    const pad = virtualGamepad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const run = boot();
    display();
    display(3 * DT);
    expect(run.debug.tick()).toBe(3);
    pad.buttons[8]!.value = 1;
    display(4 * DT);
    expect(run.debug.tick()).toBe(0);
    expect(run.debug.steps()).toBe(0);
    expect(body(run.session.world).jumps).toBe(0);
  });

  it('buffers a sub-tick controller tap until simulation and consumes its edge once', () => {
    const pad = virtualGamepad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const run = boot();
    display();
    pad.buttons[0]!.value = 1;
    display(DT / 4);
    pad.buttons[0]!.value = 0;
    display(DT / 4);
    expect(run.debug.tick()).toBe(0);
    display(3.5 * DT);
    expect(run.debug.tick()).toBe(4);
    expect(body(run.session.world).jumps).toBe(1);
    expect(run.submit.mock.calls.some(([packet]) => packet.released?.includes('Jump'))).toBe(true);
    display(DT);
    expect(body(run.session.world).jumps).toBe(1);
  });

  it('samples Menu while paused, then prevents held Jump from leaking through resume', () => {
    const pad = virtualGamepad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const run = boot();
    display();
    pad.buttons[9]!.value = 1;
    display(DT);
    expect(run.debug.paused()).toBe(true);
    pad.buttons[9]!.value = 0;
    display(DT);
    pad.buttons[0]!.value = 1;
    display(DT);
    expect(run.debug.tick()).toBe(0);
    pad.buttons[9]!.value = 1;
    display(DT);
    expect(run.debug.paused()).toBe(false);
    display(DT);
    expect(body(run.session.world).jumps).toBe(0);
    pad.buttons[9]!.value = 0;
    pad.buttons[0]!.value = 0;
    display(DT);
    pad.buttons[0]!.value = 1;
    display(2 * DT);
    expect(body(run.session.world).jumps).toBe(1);
  });
});

describe('bootStatic observes revisions, not displayed frames', () => {
  it('captures first mount, then keeps input and presentation running without paused copies', async () => {
    const run = boot();
    expect(run.debug.tick()).toBe(-1);
    expect(run.debug.snapshot()).toBeNull();
    display();
    await run.debug.ready;
    expect(run.snapshot).toHaveBeenCalledTimes(1);
    expect(run.restore).toHaveBeenCalledTimes(1);
    expect(host.adapter.mount).toHaveBeenCalledExactlyOnceWith(run.debug.world);
    command('KeyP');
    for (let i = 0; i < 12; i++) display(DT);
    expect(run.debug.tick()).toBe(0);
    expect(run.debug.steps()).toBe(0);
    expect(run.debug.frames()).toBe(13);
    expect(run.snapshot).toHaveBeenCalledTimes(1);
    expect(run.restore).toHaveBeenCalledTimes(1);
    expect(run.submit).toHaveBeenCalledTimes(13);
    expect(run.session.input.lastSeq).toBe(13);
    expect(run.advance).toHaveBeenCalledTimes(13);
    expect(host.receive).toHaveBeenCalledTimes(13);
    expect(
      host.receive.mock.calls.flatMap(([events]) => events.map((event) => event.type)),
    ).toEqual(['probe.started']);
    expect(host.adapter.sync).toHaveBeenCalledTimes(13);
    expect(host.present).toHaveBeenCalledTimes(13);
    expect(host.present).toHaveBeenLastCalledWith(0, true);
    expect(host.renderer.render).toHaveBeenCalledTimes(13);
    expect(host.hud.setStats).toHaveBeenCalledTimes(13);
    expect(host.hud.setStatus).toHaveBeenCalledTimes(13);
  });

  it('copies once per observed revision across zero, sub-tick and multi-tick frames', () => {
    const run = boot();
    display();
    display();
    display(DT / 2);
    expect(run.snapshot).toHaveBeenCalledTimes(1);
    display(DT / 2);
    expect(run.debug.tick()).toBe(1);
    expect(run.snapshot).toHaveBeenCalledTimes(2);
    display(3 * DT);
    expect(run.debug.tick()).toBe(4);
    expect(run.debug.steps()).toBe(4);
    expect(run.snapshot).toHaveBeenCalledTimes(3);
    expect(run.restore).toHaveBeenCalledTimes(3);
    expect(host.adapter.sync).toHaveBeenCalledTimes(5);
    expect(run.debug.snapshot()).toEqual(run.session.world.snapshot());
  });

  it('refreshes a paused single-step and coalesces several steps before one display', () => {
    const run = boot();
    display();
    command('KeyP');
    display(1);
    command('Period');
    expect(run.session.tick).toBe(1);
    expect(run.debug.tick()).toBe(0);
    display();
    for (let i = 0; i < 3; i++) command('Period');
    display();
    display(DT);
    expect(run.debug.tick()).toBe(4);
    expect(run.snapshot).toHaveBeenCalledTimes(3);
    expect(run.restore).toHaveBeenCalledTimes(3);
    expect(host.present).toHaveBeenLastCalledWith(4, true);
  });

  it('refreshes a restart at the same paused tick zero without remounting the adapter', () => {
    const run = boot();
    display();
    command('KeyP');
    const before = run.debug.snapshot();
    command('KeyR');
    display();
    expect(run.debug.tick()).toBe(0);
    expect(run.debug.snapshot()).toEqual(before);
    expect(run.snapshot).toHaveBeenCalledTimes(2);
    expect(run.restore).toHaveBeenCalledTimes(2);
    expect(host.reset).toHaveBeenCalledExactlyOnceWith(1);
    expect(host.receive.mock.calls[1]).toEqual([
      [{ type: 'probe.started', tick: 0, data: { nested: { value: 29 } }, sequence: 0 }],
      1,
    ]);
    display(DT);
    expect(run.snapshot).toHaveBeenCalledTimes(2);
    expect(host.adapter.mount).toHaveBeenCalledTimes(1);
  });

  it('refreshes a restarted world that catches up to the old nonzero tick before observation', () => {
    const run = boot();
    display(2 * DT);
    const before = run.debug.snapshot();
    command('KeyR');
    display(2 * DT);
    expect(run.debug.tick()).toBe(2);
    expect(run.debug.steps()).toBe(2);
    expect(run.debug.snapshot()).toEqual(before);
    expect(run.snapshot).toHaveBeenCalledTimes(2);
    expect(run.restore).toHaveBeenCalledTimes(2);
    expect(host.present).toHaveBeenLastCalledWith(2, false);
  });

  it('settles input waiters on no-copy frames and preserves pending edges until a paused step', async () => {
    const run = boot();
    display();
    command('KeyP');
    const settled = vi.fn();
    const waiter = run.debug.sync().then(settled);
    dom.dispatch('keydown', keyEvent('Space'));
    dom.dispatch('keyup', keyEvent('Space'));
    expect(settled).not.toHaveBeenCalled();
    display();
    await waiter;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(run.snapshot).toHaveBeenCalledTimes(1);
    expect(body(run.session.world).jumps).toBe(0);
    command('Period');
    display();
    expect(body(run.session.world).jumps).toBe(1);
    command('Period');
    display();
    expect(body(run.session.world).jumps).toBe(1);
    dom.dispatch('keydown', keyEvent('Space'));
    display();
    command('KeyR');
    display();
    command('Period');
    display();
    expect(body(run.session.world).jumps).toBe(0);
  });

  it('keeps pointer picking, projection and resizing live between observation copies', () => {
    const run = boot('iso');
    display();
    command('KeyP');
    host.adapter.sync.mockClear();
    dom.dispatch('mousedown', { ...buttonEvent(), clientX: 320, clientY: 90 });
    expect(host.adapter.sync).toHaveBeenCalledExactlyOnceWith(run.debug.world);
    expect(host.adapter.pick).toHaveBeenCalledExactlyOnceWith(0, 0.5);
    expect(host.adapter.sync.mock.invocationCallOrder[0]).toBeLessThan(
      host.adapter.pick.mock.invocationCallOrder[0]!,
    );
    expect(run.debug.project(0, 0, 0)).toEqual({ x: 320, y: 180 });
    expect(host.adapter.sync).toHaveBeenCalledTimes(2);
    dom.dispatch('resize', {});
    expect(host.renderer.setSize).toHaveBeenLastCalledWith(640, 360, false);
    expect(host.adapter.resize).toHaveBeenLastCalledWith(640, 360);
    display();
    expect(run.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pointer: expect.objectContaining({ world: { x: 3, y: 0, z: 4 } }),
      }),
    );
    expect(run.snapshot).toHaveBeenCalledTimes(1);
    expect(run.restore).toHaveBeenCalledTimes(1);
  });

  it('returns defensive snapshots without adding frame-path copies or exposing the cached tree', () => {
    const run = boot();
    display();
    command('KeyP');
    const original = run.debug.snapshot();
    const copy = run.debug.snapshot();
    if (original === null || copy === null) throw new Error('First frame did not capture state.');
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    record(record(copy.entities[0]!.components[Probe.id]).nested).value = 999;
    record(record(copy.resources[Resource.id]).nested).value = 999;
    Reflect.set(copy.prng.s, 0, 0);
    Reflect.set(copy.allocator.slots, 0, 99);
    Reflect.set(copy.allocator.free, 0, 99);
    Reflect.set(copy, 'tick', 999);
    expect(run.debug.snapshot()).toEqual(original);
    expect(run.debug.world.snapshot()).toEqual(original);
    expect(run.session.world.snapshot()).toEqual(original);
    display(DT);
    expect(run.debug.snapshot()).toEqual(original);
    expect(run.snapshot).toHaveBeenCalledTimes(1);
    expect(run.restore).toHaveBeenCalledTimes(1);
  });

  it('repairs unsupported mirror writes on the next revision, not every paused display', () => {
    const run = boot();
    display();
    command('KeyP');
    body(run.debug.world).nested.value = 999;
    resource(run.debug.world).nested.value = 999;
    display(DT);
    expect(body(run.debug.world).nested.value).toBe(999);
    expect(body(run.session.world).nested.value).toBe(7);
    expect(resource(run.session.world).nested.value).toBe(17);
    expect(run.debug.snapshot()).toEqual(run.session.world.snapshot());
    command('Period');
    display();
    expect(run.debug.world.snapshot()).toEqual(run.session.world.snapshot());
    expect(body(run.debug.world).nested.value).toBe(8);
  });

  it.each(['snapshot', 'restore'] as const)(
    'surfaces a changed-revision %s failure without publishing it or continuing presentation',
    (operation) => {
      const run = boot();
      display();
      const before = run.debug.snapshot();
      const error = new Error(`${operation} failed`);
      run[operation].mockImplementationOnce(() => {
        throw error;
      });
      display(DT);
      expect(run.session.tick).toBe(1);
      expect(host.fail).toHaveBeenCalledExactlyOnceWith(error);
      expect(run.debug.tick()).toBe(0);
      expect(run.debug.snapshot()).toEqual(before);
      expect(host.present).toHaveBeenCalledTimes(1);
      expect(host.renderer.render).toHaveBeenCalledTimes(1);
      expect(pendingFrames.size).toBe(0);
    },
  );

  it('does not publish first observation until validation and mounting have succeeded', () => {
    const run = boot();
    const error = new Error('invalid presentation world');
    host.validateWorld.mockImplementationOnce(() => {
      throw error;
    });
    display();
    expect(host.fail).toHaveBeenCalledExactlyOnceWith(error);
    expect(run.debug.tick()).toBe(-1);
    expect(run.debug.snapshot()).toBeNull();
    expect(host.adapter.mount).not.toHaveBeenCalled();
    expect(host.mounted).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
  });
});

const ATTACKS = [
  {
    name: 'nested components',
    run(world: World): void {
      body(world).nested.value += 1000;
      body(world).samples.push(999);
      world
        .query({ has: [Probe, Transform] })
        .one()
        .get(Transform).position.x += 1000;
    },
  },
  {
    name: 'nested resources',
    run(world: World): void {
      resource(world).nested.value += 1000;
      resource(world).samples.push(999);
    },
  },
  {
    name: 'PRNG state',
    run(world: World): void {
      world.random.nextUint32();
    },
  },
  {
    name: 'allocator generations and free-slot reuse',
    run(world: World): void {
      const first = world.spawn(Name({ value: 'observer' }));
      world.despawn(first);
      const second = world.spawn(Name({ value: 'observer-reused' }));
      expect(second).not.toBe(first);
      world.despawn(second);
    },
  },
  {
    name: 'event state',
    run(world: World): void {
      world.events.emit('observer.wrote', { nested: { value: 999 } });
    },
  },
];

describe('bootStatic isolates hostile mirror observers at runtime', () => {
  it.each(ATTACKS)('isolates $name through pause, steps, continuation and restart', (attack) => {
    const run = boot();
    const independent = createLiveSession(fixture());
    expect(independent.world.snapshot().allocator).toEqual({ slots: [1, 1, 2], free: [2] });
    expect(independent.world.events.history()).toHaveLength(1);
    const observe = (world: World): void => {
      const before = evidence(world);
      attack.run(world);
      expect(evidence(world), 'the hostile observer must actually change its target').not.toEqual(
        before,
      );
    };
    host.adapter.mount.mockImplementation(observe);
    host.adapter.sync.mockImplementation(observe);

    display();
    expectUnchangedAuthority(run.session.world, independent.world);
    command('KeyP');
    independent.paused = true;
    for (let i = 0; i < 3; i++) display(DT);
    expectUnchangedAuthority(run.session.world, independent.world);
    command('Period');
    independent.step();
    display();
    expectUnchangedAuthority(run.session.world, independent.world);
    command('KeyP');
    independent.paused = false;
    for (let i = 0; i < 5; i++) {
      independent.advance(2 * DT);
      display(2 * DT);
      expectUnchangedAuthority(run.session.world, independent.world);
    }
    command('KeyP');
    independent.paused = true;
    command('KeyR');
    independent.restart();
    display();
    expectUnchangedAuthority(run.session.world, independent.world);
    command('Period');
    independent.step();
    display();
    expectUnchangedAuthority(run.session.world, independent.world);
    expect(host.fail).not.toHaveBeenCalled();
    expect(host.adapter.sync).toHaveBeenCalledTimes(12);
  });

  it.each(ATTACKS)('rejects a deliberate live-World substitution for $name', (attack) => {
    const run = boot();
    const independent = createLiveSession(fixture());
    host.adapter.sync.mockImplementation(() => attack.run(run.session.world));
    display();
    expect(host.fail).not.toHaveBeenCalled();
    expect(() => expectUnchangedAuthority(run.session.world, independent.world)).toThrow();
  });

  it('does not let presentation or debug event consumers rewrite authoritative event data', () => {
    const run = boot();
    const independent = createLiveSession(fixture());
    host.receive.mockImplementation((events) => {
      for (const event of events) {
        const nested = record(record(event.data).nested);
        expect(() => {
          nested.value = 999;
        }).toThrow(TypeError);
      }
    });
    for (let tick = 0; tick < 3; tick++) {
      independent.advance(DT);
      display(DT);
      const events = run.debug.events();
      expect(events.length).toBeGreaterThan(0);
      Reflect.set(events[0]!, 'type', 'forged');
      expect(() => {
        record(record(events[0]!.data).nested).value = 999;
      }).toThrow(TypeError);
      expect(run.debug.events()[0]!.type).toBe('probe.started');
      expectUnchangedAuthority(run.session.world, independent.world);
    }
    command('KeyP');
    independent.paused = true;
    command('KeyR');
    independent.restart();
    display();
    expectUnchangedAuthority(run.session.world, independent.world);
    expect(run.debug.events()).toHaveLength(1);
    expect(host.fail).not.toHaveBeenCalled();
  });
});

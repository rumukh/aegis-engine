import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioSpec, QualityTier, StateCondition, Vec3 } from '../presentation/schema.js';
import type { EventLine } from '../protocol.js';
import { createAudio } from './audio.js';
import type { AudioController, AudioOptions } from './audio.js';

class FakeParam {
  events: { kind: 'set' | 'ramp'; value: number; time: number }[] = [];
  constructor(public value = 0) {}
  cancelScheduledValues = vi.fn((time: number) => {
    this.events = this.events.filter((event) => event.time < time);
    return this;
  });
  setValueAtTime = vi.fn((value: number, time: number) => {
    this.events.push({ kind: 'set', value, time });
    return this;
  });
  linearRampToValueAtTime = vi.fn((value: number, time: number) => {
    this.events.push({ kind: 'ramp', value, time });
    return this;
  });
  at(time: number): number {
    let value = this.value;
    let previousTime = 0;
    for (const event of this.events) {
      if (event.time > time)
        return event.kind === 'set'
          ? value
          : value + ((event.value - value) * (time - previousTime)) / (event.time - previousTime);
      value = event.value;
      previousTime = event.time;
    }
    return value;
  }
}

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakePanner extends FakeNode {
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  panningModel = 'equalpower';
  distanceModel = 'linear';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
}
class FakeListener {
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  forwardX = new FakeParam();
  forwardY = new FakeParam();
  forwardZ = new FakeParam(-1);
  upX = new FakeParam();
  upY = new FakeParam(1);
  upZ = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  start = vi.fn();
  stopAt: number | undefined;
  stop = vi.fn((time = 0) => {
    this.stopAt = time;
  });
}
class FakeContext {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  destination = {};
  listener = new FakeListener();
  onstatechange: (() => void) | null = null;
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  panners: FakePanner[] = [];
  decoded = { duration: 2, numberOfChannels: 1 } as AudioBuffer;
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer): Promise<AudioBuffer> => this.decoded);
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createGain = vi.fn((): GainNode => {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  });
  createPanner = vi.fn((): PannerNode => {
    const panner = new FakePanner();
    this.panners.push(panner);
    return panner as unknown as PannerNode;
  });
  createBufferSource = vi.fn((): AudioBufferSourceNode => {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const source of this.sources)
      if (source.stopAt !== undefined && source.stopAt <= this.currentTime) source.onended?.();
  }
}

const controllers: AudioController[] = [];
const CONDITION: StateCondition = {
  entity: 'generator',
  component: 'Generator',
  field: 'powered',
  equals: true,
};
const FIXED = { target: { position: [2, 3, 4] as Vec3 } };
const MOVING = { target: { entity: 'generator' } };
const CAPTION = { text: 'Generator started', speaker: 'Control', durationTicks: 90 };
const event = (tick: number, sequence: number, data?: unknown): EventLine => ({
  type: 'generator.changed',
  tick,
  sequence,
  ...(data === undefined ? {} : { data }),
});

function setup(spec: AudioSpec, additions: Partial<AudioOptions> = {}) {
  const context = new FakeContext();
  const readBuffer = vi.fn((_id: string) => new Uint8Array([1, 2]).buffer);
  const contextFactory = vi.fn(() => context as unknown as AudioContext);
  const onCaption = vi.fn();
  const onState = vi.fn();
  const controller = createAudio({
    spec,
    readBuffer,
    contextFactory,
    onCaption,
    onState,
    ...additions,
  });
  controllers.push(controller);
  return { controller, context, readBuffer, contextFactory, onCaption, onState };
}
function spatial() {
  return {
    listener: vi.fn(() => ({
      position: [0, 1, 0] as Vec3,
      forward: [0, 0, -1] as Vec3,
      up: [0, 1, 0] as Vec3,
    })),
    position: vi.fn((_entity: string): Vec3 => [3, 2, 1]),
    matches: vi.fn((_condition: StateCondition) => true),
  };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
});

describe('spatial audio graph and frame synchronization', () => {
  it('keeps legacy audio stereo-capable without consulting any spatial callback', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      {
        ambient: { asset: 'score' },
        cues: [{ event: 'generator.changed', asset: 'click' }],
      },
      { spatial: callbacks },
    );
    context.decoded = { duration: 2, numberOfChannels: 2 } as AudioBuffer;
    controller.sync();
    await controller.unlock();
    controller.consume([event(1, 0)], 0, 1);
    controller.sync();
    expect(callbacks.listener).not.toHaveBeenCalled();
    expect(callbacks.position).not.toHaveBeenCalled();
    expect(callbacks.matches).not.toHaveBeenCalled();
    expect(context.createPanner).not.toHaveBeenCalled();
    expect(controller.state().voices).toBe(2);
  });

  it('supports fixed mono sources without callbacks and configures the complete inverse HRTF graph', async () => {
    const { controller, context } = setup({
      volume: 0.8,
      headroom: 0.5,
      cues: [{ event: 'generator.changed', asset: 'hum', spatial: FIXED, volume: 0.3 }],
    });
    await controller.unlock();
    controller.consume([event(1, 0)], 0, 1);
    const panner = context.panners[0]!;
    expect(panner).toMatchObject({
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 1.5,
      maxDistance: 22,
      rolloffFactor: 1,
      positionX: { value: 2 },
      positionY: { value: 3 },
      positionZ: { value: 4 },
    });
    expect(context.gains[0]?.gain.value).toBe(0.4);
    expect(context.sources[0]?.connect).toHaveBeenCalledWith(context.gains[1]);
    expect(context.gains[1]?.gain.value).toBe(0.3);
    expect(context.gains[1]?.connect).toHaveBeenCalledWith(panner);
    expect(panner.connect).toHaveBeenCalledWith(context.gains[0]);
    controller.setMuted(true);
    expect(panner.disconnect).toHaveBeenCalledOnce();
    controller.setMuted(false);
    expect(context.gains[0]?.gain.value).toBe(0.4);
  });

  it('tracks translated and rotated listeners and moving entities without restarting voices', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      {
        layers: [
          {
            id: 'machine',
            asset: 'hum',
            spatial: {
              ...MOVING,
              refDistance: 2,
              maxDistance: 40,
              rolloffFactor: 0.7,
            },
          },
        ],
      },
      { spatial: callbacks },
    );
    await controller.unlock();
    expect(callbacks.position).toHaveBeenCalledWith('generator');
    expect(context.panners[0]).toMatchObject({
      refDistance: 2,
      maxDistance: 40,
      rolloffFactor: 0.7,
      positionX: { value: 3 },
      positionY: { value: 2 },
      positionZ: { value: 1 },
    });
    callbacks.listener.mockReturnValue({
      position: [4, 5, 6],
      forward: [1, 0, 0],
      up: [0, 0, 1],
    });
    callbacks.position.mockReturnValue([-3, 7, 9]);
    controller.sync();
    expect(context.listener).toMatchObject({
      positionX: { value: 4 },
      positionY: { value: 5 },
      positionZ: { value: 6 },
      forwardX: { value: 1 },
      forwardY: { value: 0 },
      forwardZ: { value: 0 },
      upX: { value: 0 },
      upY: { value: 0 },
      upZ: { value: 1 },
    });
    expect(context.panners[0]).toMatchObject({
      positionX: { value: -3 },
      positionY: { value: 7 },
      positionZ: { value: 9 },
    });
    expect(context.sources).toHaveLength(1);
  });

  it('rejects every positional stereo asset at decode, even a currently disabled layer', async () => {
    const { controller, context, onState } = setup(
      {
        layers: [{ id: 'machine', asset: 'stereo-hum', spatial: FIXED, enabledWhen: CONDITION }],
      },
      { spatial: { ...spatial(), matches: () => false } },
    );
    context.decoded = { duration: 2, numberOfChannels: 2 } as AudioBuffer;
    await expect(controller.unlock()).rejects.toThrow(
      'Audio asset "stereo-hum" could not decode: Spatial audio must be mono; decoded 2 channels.',
    );
    expect(context.sources).toHaveLength(0);
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error', voices: 0 }),
    );
  });

  it('requires moving-target and condition callbacks explicitly, without allocating a context on sync', () => {
    const moving = setup({
      cues: [{ event: 'generator.changed', asset: 'hum', spatial: MOVING }],
    });
    expect(() => moving.controller.sync()).toThrow(
      'Audio spatial target "generator" requires a spatial.position callback.',
    );
    expect(moving.contextFactory).not.toHaveBeenCalled();
    const conditional = setup({
      layers: [{ id: 'machine', asset: 'hum', enabledWhen: CONDITION }],
    });
    expect(() => conditional.controller.sync()).toThrow('spatial.matches callback');
    expect(conditional.controller.state().status).toBe('error');
  });

  it('propagates invalid moving state and releases the graph rather than retaining stale positions', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      {
        layers: [{ id: 'machine', asset: 'hum', spatial: MOVING }],
      },
      { spatial: callbacks },
    );
    await controller.unlock();
    callbacks.position.mockImplementation(() => {
      throw new Error('generator has no Transform');
    });
    expect(() => controller.sync()).toThrow('generator has no Transform');
    expect(controller.state()).toMatchObject({ status: 'error', voices: 0 });
    expect(context.panners[0]?.disconnect).toHaveBeenCalledOnce();
    expect(context.sources[0]?.buffer).toBeNull();
  });

  it('releases partially connected panners when their connection fails', async () => {
    const { controller, context } = setup({
      cues: [{ event: 'generator.changed', asset: 'hum', spatial: FIXED }],
    });
    await controller.unlock();
    const panner = new FakePanner();
    panner.connect.mockImplementation(() => {
      throw new Error('panner refused connection');
    });
    context.createPanner.mockReturnValueOnce(panner as unknown as PannerNode);
    expect(() => controller.consume([event(1, 0)], 0, 1)).toThrow('panner refused connection');
    expect(panner.disconnect).toHaveBeenCalledOnce();
    expect(context.gains[1]?.disconnect).toHaveBeenCalledOnce();
    expect(context.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ status: 'error', voices: 0 });
  });
});

describe('stateful layer fades and voice budgets', () => {
  it('restarts only legacy ambience until the first new-world frame after reset', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      {
        ambient: { asset: 'score' },
        layers: [{ id: 'machine', asset: 'hum', spatial: MOVING, enabledWhen: CONDITION }],
      },
      { spatial: callbacks },
    );
    await controller.unlock();
    expect(controller.state().voices).toBe(2);
    callbacks.listener.mockClear();
    callbacks.position.mockClear();
    callbacks.matches.mockClear();

    controller.reset(1);
    expect(controller.state().voices).toBe(1);
    expect(context.sources).toHaveLength(3);
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(context.sources[1]?.stop).toHaveBeenCalledOnce();
    controller.setPaused(true);
    controller.setPaused(false);
    controller.setMuted(true);
    controller.setMuted(false);
    await controller.unlock();
    expect(callbacks.listener).not.toHaveBeenCalled();
    expect(callbacks.position).not.toHaveBeenCalled();
    expect(callbacks.matches).not.toHaveBeenCalled();
    expect(context.panners).toHaveLength(1);
    expect(controller.state().voices).toBe(1);

    callbacks.matches.mockReturnValue(false);
    controller.sync();
    expect(callbacks.matches).toHaveBeenCalledExactlyOnceWith(CONDITION);
    expect(controller.state().voices).toBe(1);
    callbacks.matches.mockReturnValue(true);
    callbacks.position.mockReturnValue([7, 8, 9]);
    controller.sync();
    expect(controller.state().voices).toBe(2);
    expect(context.panners[1]).toMatchObject({
      positionX: { value: 7 },
      positionY: { value: 8 },
      positionZ: { value: 9 },
    });
  });

  it('defers layers across a generation change detected by consume until a frame sync', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      { layers: [{ id: 'machine', asset: 'hum', enabledWhen: CONDITION }] },
      { spatial: callbacks },
    );
    await controller.unlock();
    callbacks.matches.mockClear();
    controller.consume([], 1, 0);
    controller.consume([], 1, 1);
    expect(controller.state().voices).toBe(0);
    expect(context.sources).toHaveLength(1);
    expect(callbacks.matches).not.toHaveBeenCalled();
    controller.sync();
    expect(callbacks.matches).toHaveBeenCalledExactlyOnceWith(CONDITION);
    expect(controller.state().voices).toBe(1);
    expect(context.sources).toHaveLength(2);
  });

  it('does not start stale conditional layers when an in-flight unlock resolves after reset', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      { layers: [{ id: 'machine', asset: 'hum', enabledWhen: CONDITION }] },
      { spatial: callbacks },
    );
    let finish!: (buffer: AudioBuffer) => void;
    context.decodeAudioData.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const unlocking = controller.unlock();
    controller.reset(1);
    finish(context.decoded);
    await unlocking;
    expect(context.sources).toHaveLength(0);
    expect(callbacks.matches).not.toHaveBeenCalled();
    controller.sync();
    expect(context.sources).toHaveLength(1);
    expect(callbacks.matches).toHaveBeenCalledExactlyOnceWith(CONDITION);
  });

  it('gates layers and schedules attack/release ramps from the current envelope without wall timers', async () => {
    const callbacks = spatial();
    callbacks.matches.mockReturnValue(false);
    const { controller, context } = setup(
      {
        layers: [
          { id: 'machine', asset: 'hum', volume: 0.8, enabledWhen: CONDITION, fadeSeconds: 1 },
        ],
      },
      { spatial: callbacks },
    );
    await controller.unlock();
    expect(context.sources).toHaveLength(0);
    callbacks.matches.mockReturnValue(true);
    controller.sync();
    controller.sync();
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.loop).toBe(true);
    expect(callbacks.matches).toHaveBeenCalledWith(CONDITION);
    expect(context.gains[1]?.gain.events).toEqual([
      { kind: 'set', value: 0, time: 0 },
      { kind: 'ramp', value: 0.8, time: 1 },
    ]);
    context.advance(0.25);
    callbacks.matches.mockReturnValue(false);
    controller.sync();
    controller.sync();
    expect(context.sources[0]?.stop).toHaveBeenCalledExactlyOnceWith(1.25);
    expect(context.gains[1]?.gain.setValueAtTime).toHaveBeenLastCalledWith(0.2, 0.25);
    expect(context.gains[1]?.gain.at(0.75)).toBeCloseTo(0.1);
    context.advance(1);
    expect(controller.state().voices).toBe(0);
    expect(context.gains[1]?.disconnect).toHaveBeenCalledOnce();
    expect(context.sources[0]?.buffer).toBeNull();
    controller.sync();
    expect(context.sources).toHaveLength(1);
  });

  it('re-enables fading layers once and ignores an obsolete onended callback', async () => {
    const callbacks = spatial();
    const { controller, context } = setup(
      {
        layers: [{ id: 'machine', asset: 'hum', enabledWhen: CONDITION, fadeSeconds: 1 }],
      },
      { spatial: callbacks },
    );
    await controller.unlock();
    callbacks.matches.mockReturnValue(false);
    controller.sync();
    const obsoleteEnd = context.sources[0]!.onended!;
    context.advance(0.5);
    callbacks.matches.mockReturnValue(true);
    controller.sync();
    controller.sync();
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]?.stop.mock.calls).toEqual([[1], []]);
    obsoleteEnd();
    expect(controller.state().voices).toBe(1);
    expect(context.sources[0]?.disconnect).toHaveBeenCalledOnce();
    context.advance(1);
    expect(controller.state().voices).toBe(1);
  });

  it.each(['mute', 'pause', 'dispose'] as const)(
    'immediately releases fading spatial layers on %s with no delayed restart',
    async (action) => {
      const callbacks = spatial();
      const { controller, context } = setup(
        {
          layers: [
            {
              id: 'machine',
              asset: 'hum',
              spatial: MOVING,
              enabledWhen: CONDITION,
              fadeSeconds: 2,
            },
          ],
        },
        { spatial: callbacks },
      );
      await controller.unlock();
      callbacks.matches.mockReturnValue(false);
      controller.sync();
      const obsoleteEnd = context.sources[0]!.onended!;
      if (action === 'mute') controller.setMuted(true);
      else if (action === 'pause') controller.setPaused(true);
      else controller.dispose();
      expect(controller.state().voices).toBe(0);
      expect(context.sources[0]?.stop.mock.calls).toEqual([[2], []]);
      expect(context.panners[0]?.disconnect).toHaveBeenCalledOnce();
      context.advance(3);
      obsoleteEnd();
      callbacks.matches.mockReturnValue(true);
      controller.sync();
      expect(context.sources).toHaveLength(1);
    },
  );

  it('reserves room for effects with eight enabled layers and never steals an effect to restart a loop', async () => {
    const { controller, context } = setup(
      {
        ambient: { asset: 'score' },
        layers: Array.from({ length: 8 }, (_, id) => ({ id: `layer-${id}`, asset: 'hum' })),
        cues: [{ event: 'generator.changed', asset: 'hit', maxVoices: 2 }],
      },
      { quality: 'low' },
    );
    await controller.unlock();
    expect(controller.state().voices).toBe(7);
    controller.consume([event(1, 0), event(1, 1)], 0, 1);
    expect(controller.state()).toMatchObject({ voices: 8, dropped: 1 });
    const effect = context.sources.at(-1)!;
    controller.sync();
    expect(effect.stop).not.toHaveBeenCalled();
    expect(controller.state().voices).toBe(8);
    expect(context.sources).toHaveLength(9);
  });

  it.each([
    ['standard', 16],
    ['high', 24],
    ['photo', 32],
  ] as const)(
    'enforces the %s global budget (%s) before and after a quality reduction',
    async (quality: QualityTier, limit: number) => {
      const { controller, context } = setup(
        {
          cues: [{ event: 'generator.changed', asset: 'hit', maxVoices: 32 }],
        },
        { quality },
      );
      await controller.unlock();
      controller.consume(
        Array.from({ length: 40 }, (_, id) => event(1, id)),
        0,
        1,
      );
      expect(controller.state()).toMatchObject({ voices: limit, dropped: 40 - limit });
      controller.setQuality('low');
      expect(controller.state()).toMatchObject({ voices: 8, dropped: 32 });
      expect(context.sources.filter((source) => source.buffer !== null)).toHaveLength(8);
    },
  );

  it('caps new-style cues at four by default and independently caps each authored cue', async () => {
    const modern = setup({
      cues: [{ event: 'generator.changed', asset: 'hum', spatial: FIXED }],
    });
    await modern.controller.unlock();
    modern.controller.consume(
      Array.from({ length: 9 }, (_, id) => event(1, id)),
      0,
      1,
    );
    expect(modern.controller.state()).toMatchObject({ voices: 4, dropped: 5 });
    const bounded = setup({
      cues: [
        { event: 'generator.changed', asset: 'hum', maxVoices: 2, caption: CAPTION },
        { event: 'other', asset: 'hum', maxVoices: 1 },
      ],
    });
    await bounded.controller.unlock();
    bounded.controller.consume(
      [
        ...Array.from({ length: 3 }, (_, id) => event(1, id)),
        { type: 'other', tick: 1, sequence: 3 },
      ],
      0,
      1,
    );
    expect(bounded.controller.state()).toMatchObject({ voices: 3, dropped: 1 });
    expect(bounded.context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(bounded.context.sources[1]?.stop).not.toHaveBeenCalled();
    expect(bounded.onCaption).toHaveBeenCalledTimes(3);
  });

  it('limits a cue attack to half the clip instead of fading past the end of a short effect', async () => {
    const { controller, context } = setup({
      cues: [{ event: 'generator.changed', asset: 'hit', volume: 0.6, fadeSeconds: 4 }],
    });
    await controller.unlock();
    controller.consume([event(1, 0)], 0, 1);
    expect(context.gains[1]?.gain.events).toEqual([
      { kind: 'set', value: 0, time: 0 },
      { kind: 'ramp', value: 0.6, time: 1 },
    ]);
    expect(context.gains[1]?.gain.at(0.5)).toBeCloseTo(0.3);
  });

  it('replaces speech across cue indices while preserving ambience, other groups and ungrouped effects', async () => {
    const { controller, context, onCaption } = setup({
      ambient: { asset: 'room' },
      cues: [
        { event: 'hit', asset: 'click' },
        { event: 'radio', asset: 'static', voiceGroup: 'radio' },
        {
          event: 'generator.changed',
          asset: 'intro',
          voiceGroup: 'dialogue',
          spatial: FIXED,
          caption: CAPTION,
        },
        {
          event: 'reply',
          asset: 'outro',
          voiceGroup: 'dialogue',
          caption: { text: 'Acknowledged' },
        },
      ],
    });
    await controller.unlock();
    controller.consume(
      [{ type: 'hit', tick: 1, sequence: 0 }, { type: 'radio', tick: 1, sequence: 1 }, event(1, 2)],
      0,
      1,
    );
    const oldEnd = context.sources[3]!.onended!;
    const reply = { type: 'reply', tick: 2, sequence: 3 };
    controller.consume([reply], 0, 2);
    controller.consume([reply], 0, 2);
    oldEnd();
    expect(controller.state()).toMatchObject({ voices: 4, dropped: 1 });
    expect(context.sources).toHaveLength(5);
    expect(context.sources[3]?.stop).toHaveBeenCalledOnce();
    expect(context.sources[3]?.disconnect).toHaveBeenCalledOnce();
    expect(context.sources[3]?.buffer).toBeNull();
    expect(context.gains[4]?.disconnect).toHaveBeenCalledOnce();
    expect(context.panners[0]?.disconnect).toHaveBeenCalledOnce();
    for (const index of [0, 1, 2, 4]) expect(context.sources[index]?.stop).not.toHaveBeenCalled();
    expect(onCaption.mock.calls).toEqual([
      [CAPTION, 1],
      [{ text: 'Acknowledged' }, 2],
    ]);

    controller.consume([event(3, 4)], 0, 3);
    expect(context.sources[4]?.stop).toHaveBeenCalledOnce();
    expect(context.sources[4]?.disconnect).toHaveBeenCalledOnce();
    expect(context.gains[5]?.disconnect).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ voices: 4, dropped: 2 });
  });

  it('does not interrupt a group for caption-only, duplicate, predicate-mismatched or cooled-down cues', async () => {
    const { controller, context, onCaption } = setup({
      cues: [
        { event: 'generator.changed', asset: 'intro', voiceGroup: 'dialogue', cooldownTicks: 5 },
        {
          event: 'reply',
          asset: 'outro',
          voiceGroup: 'dialogue',
          when: { field: 'active', equals: true },
        },
        { event: 'caption', caption: CAPTION, voiceGroup: 'dialogue' },
      ],
    });
    await controller.unlock();
    controller.consume([event(1, 0)], 0, 1);
    controller.consume(
      [
        event(1, 0),
        event(2, 1),
        { type: 'reply', tick: 2, sequence: 2, data: { active: false } },
        { type: 'caption', tick: 2, sequence: 3 },
      ],
      0,
      2,
    );
    expect(controller.state()).toMatchObject({ voices: 1, dropped: 1 });
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.stop).not.toHaveBeenCalled();
    expect(onCaption).toHaveBeenCalledExactlyOnceWith(CAPTION, 2);
    controller.consume([{ type: 'reply', tick: 3, sequence: 4, data: { active: true } }], 0, 3);
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ voices: 1, dropped: 2 });
  });

  it('forgets ended and reset group members without stopping or disconnecting them twice', async () => {
    const { controller, context } = setup({
      cues: [
        { event: 'generator.changed', asset: 'intro', voiceGroup: 'dialogue' },
        { event: 'reply', asset: 'outro', voiceGroup: 'dialogue' },
      ],
    });
    await controller.unlock();
    controller.consume([event(1, 0)], 0, 1);
    context.sources[0]!.onended!();
    controller.consume([{ type: 'reply', tick: 2, sequence: 1 }], 0, 2);
    expect(context.sources[0]?.stop).not.toHaveBeenCalled();
    expect(context.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ voices: 1, dropped: 0 });
    controller.reset(1);
    controller.consume([event(1, 0)], 1, 1);
    expect(context.sources[1]?.stop).toHaveBeenCalledOnce();
    expect(context.sources[1]?.disconnect).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ voices: 1, dropped: 0 });
  });
});

describe('predicate-selected cues and independent captions', () => {
  it('selects scalar variants through own dot paths and deduplicates both audio and captions', async () => {
    const { controller, context, onCaption } = setup({
      cues: [
        {
          event: 'generator.changed',
          asset: 'on',
          volume: 0.2,
          when: { field: 'state.power', equals: true },
          caption: CAPTION,
        },
        {
          event: 'generator.changed',
          asset: 'off',
          volume: 0.7,
          when: { field: 'state.power', equals: false },
          caption: { text: 'Power lost' },
        },
      ],
    });
    await controller.unlock();
    const packet = [
      event(1, 0, { state: { power: true } }),
      event(1, 1, { state: { power: false } }),
      event(1, 2, { state: { power: 'true' } }),
    ];
    controller.consume(packet, 0, 1);
    controller.consume(packet, 0, 1);
    expect(context.sources).toHaveLength(2);
    expect(context.gains[1]?.gain.value).toBe(0.2);
    expect(context.gains[2]?.gain.value).toBe(0.7);
    expect(onCaption.mock.calls).toEqual([
      [CAPTION, 1],
      [{ text: 'Power lost' }, 1],
    ]);
  });

  it.each([
    undefined,
    null,
    {},
    { state: {} },
    { state: { power: {} } },
    { state: { power: NaN } },
    { state: { power: Infinity } },
    { state: Object.create({ power: true }) as unknown },
  ])('reports a missing or invalid authored event predicate while locked: %j', (data) => {
    const { controller, contextFactory, onCaption } = setup({
      cues: [
        {
          event: 'generator.changed',
          when: { field: 'state.power', equals: true },
          caption: CAPTION,
        },
      ],
    });
    expect(() => controller.consume([event(1, 0, data)], 0, 1)).toThrow(
      'Audio cue "generator.changed" predicate "state.power" must resolve to a finite scalar',
    );
    expect(controller.state().status).toBe('error');
    expect(contextFactory).not.toHaveBeenCalled();
    expect(onCaption).not.toHaveBeenCalled();
  });

  it('delivers caption-only cues without reading assets, creating a context or requiring unlock', () => {
    const { controller, readBuffer, contextFactory, onCaption } = setup({
      cues: [{ event: 'generator.changed', caption: CAPTION }],
    });
    controller.setMuted(true);
    controller.consume([event(1, 0)], 0, 1);
    controller.setPaused(true);
    controller.consume([event(2, 1)], 0, 2);
    controller.setPaused(false);
    controller.setMuted(false);
    controller.consume([event(2, 1)], 0, 2);
    expect(onCaption.mock.calls).toEqual([
      [CAPTION, 1],
      [CAPTION, 2],
    ]);
    expect(readBuffer).not.toHaveBeenCalled();
    expect(contextFactory).not.toHaveBeenCalled();
    expect(controller.state()).toMatchObject({ status: 'unavailable', voices: 0, dropped: 0 });
  });

  it('applies caption cooldowns even while locked or muted and never catches up on unlock or resume', async () => {
    const { controller, context, onCaption } = setup({
      cues: [{ event: 'generator.changed', asset: 'hum', caption: CAPTION, cooldownTicks: 4 }],
    });
    controller.consume([event(1, 0)], 0, 1);
    expect(onCaption).toHaveBeenCalledExactlyOnceWith(CAPTION, 1);
    await controller.unlock();
    controller.consume([event(1, 0), event(4, 1)], 0, 4);
    expect(context.sources).toHaveLength(0);
    controller.consume([event(5, 2)], 0, 5);
    controller.setMuted(true);
    controller.consume([event(9, 3)], 0, 9);
    controller.setMuted(false);
    controller.consume([event(9, 3), event(10, 4)], 0, 10);
    controller.setPaused(true);
    controller.consume([event(13, 5)], 0, 13);
    controller.setPaused(false);
    controller.consume([event(13, 5)], 0, 13);
    expect(context.sources).toHaveLength(1);
    expect(onCaption.mock.calls.map(([, tick]) => tick)).toEqual([1, 5, 9, 13]);
  });

  it('delivers captions after an unavailable Web Audio failure without retrying audio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const onCaption = vi.fn();
    const controller = createAudio({
      spec: { cues: [{ event: 'generator.changed', asset: 'hum', caption: CAPTION }] },
      readBuffer: vi.fn(),
      onCaption,
      onState: vi.fn(),
    });
    controllers.push(controller);
    await expect(controller.unlock()).rejects.toThrow('Web Audio is unavailable');
    controller.consume([event(1, 0)], 0, 1);
    expect(onCaption).toHaveBeenCalledExactlyOnceWith(CAPTION, 1);
    expect(controller.state().status).toBe('unavailable');
  });

  it('decodes only defined assets when captions and sounds are mixed', async () => {
    const { controller, readBuffer } = setup({
      cues: [
        { event: 'generator.changed', caption: CAPTION },
        { event: 'other', asset: 'hum' },
      ],
      layers: [{ id: 'machine', asset: 'hum' }],
    });
    await controller.unlock();
    expect(readBuffer).toHaveBeenCalledExactlyOnceWith('hum');
  });

  it('ignores stale packets and old generations but permits new same-tick occurrences and restarted events', () => {
    const { controller, onCaption } = setup({
      cues: [{ event: 'generator.changed', caption: CAPTION }],
    });
    controller.consume([event(1, 0)], 0, 2);
    controller.consume([event(1, 0), event(1, 1)], 0, 2);
    controller.consume([], 0, 20);
    controller.consume([event(10, 2)], 0, 21);
    controller.reset(1);
    controller.consume([event(22, 3)], 0, 22);
    controller.consume([event(1, 0)], 1, 1);
    controller.consume([event(1, 0)], 1, 1);
    expect(onCaption.mock.calls.map(([, tick]) => tick)).toEqual([1, 1, 1]);
  });

  it('preserves legacy unsequenced occurrence counts for caption variants', () => {
    const { controller, onCaption } = setup({
      cues: [
        { event: 'generator.changed', caption: CAPTION, when: { field: 'powered', equals: true } },
      ],
    });
    const packet = [
      { type: 'generator.changed', tick: 1, data: { powered: true } },
      { type: 'generator.changed', tick: 1, data: { powered: false } },
      { type: 'generator.changed', tick: 1, data: { powered: true } },
    ];
    controller.consume(packet, 0, 1);
    controller.consume(structuredClone(packet), 0, 1);
    expect(onCaption).toHaveBeenCalledTimes(2);
  });

  it.each(['mute', 'pause'] as const)(
    'does not show captions from a delayed packet at the same frame tick after %s',
    (action) => {
      const { controller, onCaption } = setup({
        cues: [{ event: 'generator.changed', caption: CAPTION }],
      });
      if (action === 'mute') controller.setMuted(true);
      else controller.setPaused(true);
      controller.consume([], 0, 20);
      if (action === 'mute') controller.setMuted(false);
      else controller.setPaused(false);
      controller.consume([event(10, 0), event(20, 1)], 0, 20);
      expect(onCaption).toHaveBeenCalledExactlyOnceWith(CAPTION, 20);
    },
  );

  it.each(['dispose', 'restart'] as const)(
    'abandons a consumed packet if a caption callback requests %s',
    async (action) => {
      const { controller, context, onCaption } = setup({
        cues: [{ event: 'generator.changed', asset: 'hum', caption: CAPTION }],
      });
      await controller.unlock();
      onCaption.mockImplementationOnce(() => {
        if (action === 'dispose') controller.dispose();
        else controller.reset(1);
      });
      controller.consume([event(1, 0), event(2, 1)], 0, 2);
      expect(onCaption).toHaveBeenCalledExactlyOnceWith(CAPTION, 1);
      expect(context.sources).toHaveLength(0);
      expect(controller.state().voices).toBe(0);
    },
  );
});

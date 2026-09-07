import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioSpec } from '../presentation/schema.js';
import type { EventLine } from '../protocol.js';
import { createAudio } from './audio.js';
import type { AudioController } from './audio.js';

class FakeGain {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();

  end(): void {
    this.onended?.();
  }
}

class FakeContext {
  state: AudioContextState = 'suspended';
  destination = {};
  onstatechange: (() => void) | null = null;
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  decoded = { duration: 1 } as AudioBuffer;
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer): Promise<AudioBuffer> => this.decoded);
  resume = vi.fn(async () => this.changeState('running'));
  suspend = vi.fn(async () => this.changeState('suspended'));
  close = vi.fn(async () => this.changeState('closed'));
  createGain = vi.fn((): GainNode => {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  });
  createBufferSource = vi.fn((): AudioBufferSourceNode => {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });

  changeState(state: AudioContextState): void {
    this.state = state;
    this.onstatechange?.();
  }
}

const SPEC: AudioSpec = { cues: [{ event: 'tool.used', asset: 'click' }] };
const AMBIENT: AudioSpec = {
  ...SPEC,
  volume: 0.7,
  ambient: { asset: 'room', volume: 0.25 },
};
const cue = (tick: number, sequence: number): EventLine => ({
  type: 'tool.used',
  tick,
  sequence,
});
let audio: AudioController | undefined;

function setup(spec: AudioSpec = SPEC) {
  const context = new FakeContext();
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const readBuffer = vi.fn(() => bytes);
  const contextFactory = vi.fn(() => context as unknown as AudioContext);
  const onState = vi.fn();
  const controller = createAudio({ spec, readBuffer, contextFactory, onState });
  audio = controller;
  return { context, bytes, readBuffer, contextFactory, onState, controller };
}

afterEach(() => {
  audio?.dispose();
  audio = undefined;
  vi.unstubAllGlobals();
});

describe('gesture-gated shared audio', () => {
  it('never creates a context, reads bytes or queues cues before an explicit unlock', async () => {
    const { controller, contextFactory, readBuffer, context } = setup();
    expect(controller.state()).toEqual({
      status: 'locked',
      muted: false,
      voices: 0,
      dropped: 0,
    });
    controller.consume([cue(1, 0)], 0, 1);
    controller.setMuted(true);
    controller.setMuted(false);
    controller.setPaused(true);
    controller.setPaused(false);
    controller.setQuality('low');
    expect(contextFactory).not.toHaveBeenCalled();
    expect(readBuffer).not.toHaveBeenCalled();
    expect(controller.state().dropped).toBe(1);

    await controller.unlock();
    controller.consume([cue(1, 0)], 0, 1);
    expect(context.sources).toHaveLength(0);
    controller.consume([cue(2, 1)], 0, 2);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.start).toHaveBeenCalledOnce();
  });

  it('resumes synchronously in the gesture, shares one unlock and caches copied decoded buffers', async () => {
    const { controller, context, contextFactory, bytes, readBuffer } = setup({
      ...AMBIENT,
      cues: [
        { event: 'tool.used', asset: 'room', volume: 0.5 },
        { event: 'other', asset: 'room' },
      ],
    });
    context.decodeAudioData.mockImplementation(async (input) => {
      structuredClone(input, { transfer: [input] });
      return context.decoded;
    });
    const first = controller.unlock();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(controller.unlock()).toBe(first);
    await first;
    await controller.unlock();
    expect(contextFactory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
    expect(readBuffer).toHaveBeenCalledExactlyOnceWith('room');
    expect(bytes.byteLength).toBe(4);
    expect(context.decodeAudioData.mock.calls[0]?.[0]).not.toBe(bytes);
    expect(context.gains[0]?.gain.value).toBe(0.7);
    expect(context.gains[0]?.connect).toHaveBeenCalledWith(context.destination);
    expect(context.sources[0]?.loop).toBe(true);
    expect(context.gains[1]?.gain.value).toBe(0.25);
    controller.consume([cue(1, 0)], 0, 1);
    expect(context.sources[1]?.buffer).toBe(context.decoded);
    expect(context.sources[1]?.loop).toBe(false);
    expect(context.gains[2]?.gain.value).toBe(0.5);
    expect(context.gains[2]?.connect).toHaveBeenCalledWith(context.gains[0]);
  });

  it('reports unavailable Web Audio and rejects unlock without requiring a Node audio implementation', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const onState = vi.fn();
    audio = createAudio({ spec: SPEC, readBuffer: vi.fn(), onState });
    await expect(audio.unlock()).rejects.toThrow('Web Audio is unavailable');
    expect(onState).toHaveBeenLastCalledWith({
      status: 'unavailable',
      muted: false,
      voices: 0,
      dropped: 0,
      error: 'Web Audio is unavailable in this browser.',
    });
  });

  it('does not allocate an empty audio graph for a game without an audio spec', async () => {
    const contextFactory = vi.fn();
    audio = createAudio({ readBuffer: vi.fn(), contextFactory });
    expect(audio.state().status).toBe('unavailable');
    await expect(audio.unlock()).rejects.toThrow('No audio is configured');
    expect(contextFactory).not.toHaveBeenCalled();
  });

  it('stops every voice on mute/pause and resumes only ambient, never old cues or the context', async () => {
    const { controller, context } = setup(AMBIENT);
    await controller.unlock();
    controller.consume([cue(1, 0)], 0, 1);
    controller.setMuted(true);
    expect(controller.state().voices).toBe(0);
    expect(context.gains[0]?.gain.value).toBe(0);
    for (const source of context.sources) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.buffer).toBeNull();
    }
    controller.consume([cue(2, 1)], 0, 2);
    controller.setMuted(false);
    controller.consume([cue(2, 1)], 0, 2);
    expect(context.sources).toHaveLength(3);
    expect(controller.state().voices).toBe(1);
    expect(context.gains[0]?.gain.value).toBe(0.7);
    controller.consume([cue(3, 2)], 0, 3);
    expect(controller.state().voices).toBe(2);

    controller.setPaused(true);
    controller.consume([cue(4, 3)], 0, 4);
    controller.setMuted(true);
    controller.setMuted(false);
    expect(controller.state().voices).toBe(0);
    controller.setPaused(false);
    controller.consume([cue(4, 3)], 0, 4);
    expect(context.sources).toHaveLength(5);
    expect(controller.state()).toMatchObject({ voices: 1, dropped: 2 });
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.suspend).not.toHaveBeenCalled();
  });

  it('does not start ambient when unlocking while muted or paused', async () => {
    const { controller, context } = setup(AMBIENT);
    controller.setMuted(true);
    controller.setPaused(true);
    controller.consume([cue(1, 0)], 0, 1);
    await controller.unlock();
    controller.setMuted(false);
    expect(context.sources).toHaveLength(0);
    controller.setPaused(false);
    controller.consume([cue(1, 0)], 0, 1);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.loop).toBe(true);
  });

  it('discards late pre-unlock and pre-unmute events while accepting new events at the current tick', async () => {
    const { controller, context } = setup();
    controller.consume([], 0, 20);
    await controller.unlock();
    controller.consume([cue(10, 0), cue(20, 1)], 0, 21);
    expect(context.sources).toHaveLength(1);
    expect(controller.state().dropped).toBe(1);
    controller.setMuted(true);
    controller.consume([], 0, 30);
    controller.setMuted(false);
    controller.consume([cue(25, 2), cue(30, 3)], 0, 31);
    expect(context.sources).toHaveLength(2);
    expect(controller.state().dropped).toBe(2);
  });
});

describe('audio event identity, tick timing and bounds', () => {
  it('plays distinct same-tick occurrences once, including repeated and reordered packet reads', async () => {
    const { controller, context } = setup();
    await controller.unlock();
    controller.consume([cue(2, 1), cue(2, 0), cue(2, 0)], 0, 3);
    expect(context.sources).toHaveLength(2);
    controller.consume([cue(2, 0), cue(2, 1)], 0, 3);
    expect(context.sources).toHaveLength(2);
    controller.consume([cue(2, 2)], 0, 3);
    expect(context.sources).toHaveLength(3);
    expect(controller.state().dropped).toBe(0);
  });

  it('preserves occurrence counts in legacy unsequenced batches without replaying a batch', async () => {
    const { controller, context } = setup();
    await controller.unlock();
    const events = [
      { type: 'tool.used', tick: 2 },
      { type: 'tool.used', tick: 2 },
    ];
    controller.consume(events, 0, 3);
    controller.consume(structuredClone(events), 0, 3);
    expect(context.sources).toHaveLength(2);
    controller.consume([{ type: 'tool.used', tick: 3 }], 0, 4);
    expect(context.sources).toHaveLength(3);
  });

  it('uses event ticks for per-cue cooldowns and resets them at a generation change', async () => {
    const { controller, context } = setup({
      cues: [{ event: 'tool.used', asset: 'click', cooldownTicks: 4 }],
    });
    await controller.unlock();
    controller.consume([cue(1, 0), cue(4, 1), cue(5, 2), cue(6, 3)], 0, 100);
    expect(context.sources).toHaveLength(2);
    expect(controller.state().dropped).toBe(2);
    controller.consume([cue(0, 0)], 1, 1);
    expect(context.sources).toHaveLength(3);
    expect(controller.state().dropped).toBe(0);
    controller.consume([cue(101, 4)], 0, 101);
    controller.consume([cue(0, 1)], 1, 0);
    expect(context.sources).toHaveLength(3);
  });

  it('does not consume a future event early', async () => {
    const { controller, context } = setup();
    await controller.unlock();
    controller.consume([cue(4, 0)], 0, 3);
    expect(context.sources).toHaveLength(0);
    controller.consume([cue(4, 0)], 0, 4);
    expect(context.sources).toHaveLength(1);
  });

  it('bounds all voices including ambient, evicts oldest cues, and applies a lower tier immediately', async () => {
    const { controller, context } = setup(AMBIENT);
    await controller.unlock();
    controller.consume(
      Array.from({ length: 20 }, (_, i) => cue(1, i)),
      0,
      2,
    );
    expect(controller.state()).toMatchObject({ voices: 16, dropped: 5 });
    expect(context.sources.filter((source) => source.stop.mock.calls.length > 0)).toHaveLength(5);
    expect(context.sources[0]?.stop).not.toHaveBeenCalled();
    controller.setQuality('low');
    expect(controller.state()).toMatchObject({ voices: 8, dropped: 13 });
    expect(context.sources.filter((source) => source.stop.mock.calls.length > 0)).toHaveLength(13);
    expect(context.sources[0]?.stop).not.toHaveBeenCalled();
    controller.setQuality('standard');
    expect(controller.state().voices).toBe(8);
    expect(context.sources).toHaveLength(21);
  });

  it('disconnects naturally ended voices and does not stop or dispose them twice', async () => {
    const { controller, context } = setup();
    await controller.unlock();
    controller.consume([cue(1, 0)], 0, 1);
    const source = context.sources[0]!;
    source.end();
    expect(controller.state().voices).toBe(0);
    expect(source.buffer).toBeNull();
    expect(source.onended).toBeNull();
    controller.dispose();
    controller.dispose();
    expect(source.stop).not.toHaveBeenCalled();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(context.gains[1]?.disconnect).toHaveBeenCalledOnce();
    expect(context.gains[0]?.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('restarts from cached buffers without duplicate ambience or stale-generation cues', async () => {
    const { controller, context, readBuffer } = setup(AMBIENT);
    await controller.unlock();
    controller.consume([cue(1, 0)], 0, 1);
    controller.reset(1);
    expect(controller.state()).toMatchObject({ voices: 1, dropped: 0 });
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(context.sources[1]?.stop).toHaveBeenCalledOnce();
    controller.consume([cue(1, 0)], 0, 2);
    controller.consume([cue(1, 0)], 1, 1);
    expect(controller.state().voices).toBe(2);
    expect(readBuffer).toHaveBeenCalledTimes(2);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    controller.setPaused(true);
    controller.reset();
    expect(controller.state().voices).toBe(0);
    controller.setPaused(false);
    expect(controller.state().voices).toBe(1);
  });
});

describe('audio failures and asynchronous disposal', () => {
  it('propagates a missing preloaded buffer with its asset ID', async () => {
    const { controller, readBuffer } = setup();
    readBuffer.mockImplementation(() => {
      throw new Error('not in the asset library');
    });
    await expect(controller.unlock()).rejects.toThrow(
      'Audio asset "click" could not decode: not in the asset library',
    );
    expect(controller.state()).toMatchObject({ status: 'error', voices: 0 });
  });

  it('releases failed output setup and retries the graph without allocating another context', async () => {
    const { controller, context, contextFactory } = setup(AMBIENT);
    const failedOutput = new FakeGain();
    failedOutput.connect.mockImplementation(() => {
      throw new Error('output connection failed');
    });
    context.createGain.mockReturnValueOnce(failedOutput as unknown as GainNode);
    await expect(controller.unlock()).rejects.toThrow('Audio output could not connect');
    expect(failedOutput.disconnect).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('output connection failed'),
    });
    await controller.unlock();
    expect(contextFactory).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({ status: 'ready', voices: 1 });
    expect(context.gains[0]?.connect).toHaveBeenCalledWith(context.destination);
  });

  it('rejects decode failures with the asset ID and supports explicit retry in the same context', async () => {
    const { controller, context, contextFactory, onState } = setup();
    context.decodeAudioData.mockRejectedValueOnce(new Error('invalid WAV'));
    await expect(controller.unlock()).rejects.toThrow(
      'Audio asset "click" could not decode: invalid WAV',
    );
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'error',
        voices: 0,
        error: expect.stringContaining('invalid WAV'),
      }),
    );
    await controller.unlock();
    expect(controller.state()).toEqual({ status: 'ready', voices: 0, muted: false, dropped: 0 });
    expect(contextFactory).toHaveBeenCalledOnce();
    controller.consume([cue(1, 0)], 0, 1);
    expect(context.sources).toHaveLength(1);
  });

  it('rejects resume refusal, surfaces it, and can retry from another gesture', async () => {
    const { controller, context, contextFactory } = setup(AMBIENT);
    context.resume.mockRejectedValueOnce(new Error('user activation required'));
    await expect(controller.unlock()).rejects.toThrow('user activation required');
    expect(controller.state()).toMatchObject({ status: 'error', voices: 0 });
    expect(context.sources).toHaveLength(0);
    await controller.unlock();
    expect(controller.state()).toMatchObject({ status: 'ready', voices: 1 });
    expect(contextFactory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it('stops interrupted audio and requires unlock rather than resuming from a frame or unmute', async () => {
    const { controller, context } = setup(AMBIENT);
    await controller.unlock();
    context.changeState('suspended');
    expect(controller.state()).toMatchObject({ status: 'locked', voices: 0 });
    controller.consume([cue(1, 0)], 0, 1);
    controller.setMuted(true);
    controller.setMuted(false);
    controller.setPaused(true);
    controller.setPaused(false);
    expect(context.resume).toHaveBeenCalledOnce();
    await controller.unlock();
    controller.consume([cue(1, 0)], 0, 1);
    expect(controller.state().voices).toBe(1);
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it('rejects a late unlock after disposal and never creates a late voice or ready callback', async () => {
    const { controller, context, onState } = setup(AMBIENT);
    let finish!: (value: AudioBuffer) => void;
    const decode = new Promise<AudioBuffer>((resolve) => {
      finish = resolve;
    });
    context.decodeAudioData.mockReturnValue(decode);
    const unlock = controller.unlock();
    controller.dispose();
    finish(context.decoded);
    await expect(unlock).rejects.toThrow('disposed during unlock');
    expect(context.sources).toHaveLength(0);
    expect(context.close).toHaveBeenCalledOnce();
    expect(onState.mock.calls.some(([state]) => state.status === 'ready')).toBe(false);
    controller.reset();
    controller.setMuted(false);
    controller.setPaused(false);
    controller.consume([cue(1, 0)], 1, 1);
    expect(controller.state().voices).toBe(0);
    await expect(controller.unlock()).rejects.toThrow('disposed');
  });

  it('surfaces start failures synchronously and releases partially constructed nodes', async () => {
    const { controller, context } = setup();
    await controller.unlock();
    const source = new FakeSource();
    source.start.mockImplementation(() => {
      throw new Error('source refused to start');
    });
    context.createBufferSource.mockReturnValueOnce(source as unknown as AudioBufferSourceNode);
    expect(() => controller.consume([cue(1, 0)], 0, 1)).toThrow('source refused to start');
    expect(controller.state()).toMatchObject({ status: 'error', voices: 0 });
    expect(source.buffer).toBeNull();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(context.gains[1]?.disconnect).toHaveBeenCalledOnce();
  });

  it('cleans up every voice even when stopping one fails, and reports the failure', async () => {
    const { controller, context } = setup(AMBIENT);
    await controller.unlock();
    controller.consume([cue(1, 0)], 0, 1);
    context.sources[0]!.stop.mockImplementation(() => {
      throw new Error('stop failed');
    });
    expect(() => controller.setPaused(true)).toThrow('Audio resource cleanup failed');
    expect(controller.state()).toMatchObject({
      status: 'error',
      voices: 0,
      error: expect.stringContaining('stop failed'),
    });
    for (const source of context.sources) expect(source.disconnect).toHaveBeenCalledOnce();
  });

  it('surfaces an asynchronous close failure rather than swallowing the rejection', async () => {
    const { controller, context, onState } = setup();
    await controller.unlock();
    context.close.mockRejectedValue(new Error('device close failed'));
    controller.dispose();
    await expect(context.close.mock.results[0]?.value).rejects.toThrow('device close failed');
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error', voices: 0, error: 'device close failed' }),
    );
  });

  it('publishes changes only and returns independent state snapshots', () => {
    const { controller, onState } = setup();
    controller.consume([], 0, 0);
    controller.setMuted(false);
    controller.setPaused(false);
    controller.setQuality('standard');
    expect(onState).toHaveBeenCalledOnce();
    controller.state().muted = true;
    onState.mock.calls[0]![0].muted = true;
    expect(controller.state().muted).toBe(false);
    controller.setMuted(true);
    expect(onState).toHaveBeenCalledTimes(2);
  });
});

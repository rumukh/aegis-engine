import { describe, expect, it } from 'vitest';
import { createNarration } from './narration.js';
import type { AudioPack, NarrationEvent, NarrationOptions } from './narration.js';

/** A controllable stand-in for the subset of Web Audio the narration service uses. */
class FakeParam {
  value = 1;
  cancelScheduledValues(): void {}
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}
class FakeNode {
  connected = 0;
  connect(): void {
    this.connected++;
  }
  disconnect(): void {
    this.connected = 0;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  startedAt?: { when: number; offset: number };
  stopped = false;
  onended: (() => void) | null = null;
  constructor(private readonly owner: FakeContext) {
    super();
  }
  start(when: number, offset: number): void {
    this.startedAt = { when, offset };
    this.owner.sources.push(this);
  }
  stop(): void {
    this.stopped = true;
  }
}
class FakeContext {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  sampleRate = 48_000;
  baseLatency = 0;
  outputLatency = 0;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  onstatechange: (() => void) | null = null;
  outputStamp?: { contextTime: number; performanceTime: number };
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBufferSource(): FakeSource {
    return new FakeSource(this);
  }
  async decodeAudioData(data: ArrayBuffer): Promise<unknown> {
    const duration = new DataView(data).getFloat32(0, true);
    if (!(duration > 0)) throw new Error('undecodable');
    return { duration, length: Math.round(duration * 1000), numberOfChannels: 1 };
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  getOutputTimestamp(): { contextTime?: number; performanceTime?: number } {
    return this.outputStamp ?? {};
  }
  interrupt(): void {
    this.state = 'suspended';
    this.onstatechange?.();
  }
  /** Ends the most recent source as if it had played to its end. */
  finish(): void {
    this.sources.at(-1)!.onended?.();
  }
}

function bytes(duration: number): ArrayBuffer {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat32(0, duration, true);
  return buffer;
}

const durations: Record<string, number> = {
  'a.wav': 2,
  'b.wav': 3,
  'label.wav': 0.8,
  'fx.wav': 0.3,
};
const PACK: AudioPack = {
  id: 'case',
  revision: 'r1',
  assets: [
    { id: 'a', src: 'a.wav' },
    { id: 'b', src: 'b.wav' },
    { id: 'label', src: 'label.wav' },
    { id: 'fx', src: 'fx.wav' },
    { id: 'broken', src: 'broken.wav' },
  ],
  lines: [
    {
      id: 'one',
      asset: 'a',
      caption: 'Первая',
      speaker: 'watsoni',
      cues: 'cues.one',
      meta: { emotion: 'calm', take: 2, final: true },
    },
    { id: 'two', asset: 'b', caption: 'Вторая' },
    { id: 'ok', asset: 'label', caption: 'Готово', kind: 'label' },
  ],
};

function setup(extra: Partial<NarrationOptions> = {}) {
  const context = new FakeContext();
  const fetched: string[] = [];
  const captions: (string | null)[] = [];
  const completions: string[] = [];
  const events: NarrationEvent[] = [];
  let clock = 1000;
  const narration = createNarration({
    baseUrl: 'https://example.test/game/',
    contextFactory: () => context as unknown as AudioContext,
    fetch: (async (input: string) => {
      const name = input.split('/').at(-1)!;
      fetched.push(name);
      return new Response(name === 'broken.wav' ? new ArrayBuffer(8) : bytes(durations[name]!));
    }) as unknown as typeof fetch,
    now: () => clock,
    onState: () => {},
    onCaption: (line) => captions.push(line?.id ?? null),
    onComplete: (id) => completions.push(id),
    ...extra,
  });
  narration.registerPack(PACK);
  narration.subscribe((event) => events.push(event));
  return {
    context,
    narration,
    fetched,
    captions,
    completions,
    events,
    advance(seconds: number) {
      context.currentTime += seconds;
      clock += seconds * 1000;
    },
    summary: () => events.map((e) => `${e.type}:${e.lineId}${e.reason ? `:${e.reason}` : ''}`),
  };
}

describe('narration playback clock (AUDIO-07)', () => {
  it('reports position through play, pause, resume, replay and completion', async () => {
    const t = setup();
    await t.narration.unlock();
    await t.narration.playLine('case', 'one');
    expect(t.narration.clock()).toMatchObject({
      lineId: 'one',
      packId: 'case',
      kind: 'line',
      status: 'playing',
      position: 0,
      duration: 2,
    });
    t.advance(0.5);
    expect(t.narration.clock().position).toBeCloseTo(0.5, 9);
    t.narration.pause();
    t.advance(3);
    expect(t.narration.clock()).toMatchObject({ status: 'paused' });
    expect(t.narration.clock().position).toBeCloseTo(0.5, 9);
    await t.narration.resume();
    expect(t.context.sources.at(-1)!.startedAt!.offset).toBeCloseTo(0.5, 9);
    t.advance(0.25);
    expect(t.narration.clock().position).toBeCloseTo(0.75, 9);
    const before = t.narration.clock().serial;
    await t.narration.replay();
    expect(t.narration.clock().serial).toBe(before + 1);
    expect(t.narration.clock().position).toBe(0);
    t.advance(5);
    // Never beyond the decoded duration, even before the ended callback arrives.
    expect(t.narration.clock().position).toBe(2);
    t.context.finish();
    expect(t.narration.clock()).toMatchObject({ status: 'completed', position: 2 });
    expect(t.summary()).toEqual([
      'start:one',
      'pause:one',
      'resume:one',
      'stop:one:replaced',
      'start:one',
      'complete:one',
    ]);
    expect(t.completions).toEqual(['one']);
  });

  it('compensates output latency so the audible position lags the scheduled one', async () => {
    const t = setup();
    t.context.outputLatency = 0.04;
    await t.narration.unlock();
    await t.narration.playLine('case', 'one');
    t.advance(0.02);
    expect(t.narration.clock().position).toBe(0);
    t.advance(0.48);
    expect(t.narration.clock().position).toBeCloseTo(0.46, 9);
    // An output timestamp takes precedence and is extrapolated with the frame clock.
    t.context.outputStamp = { contextTime: 0.45, performanceTime: 1500 };
    t.advance(0.01);
    expect(t.narration.clock().position).toBeCloseTo(0.46, 9);
    // It never runs ahead of the scheduled context time.
    t.context.outputStamp = { contextTime: 0.6, performanceTime: 1000 };
    expect(t.narration.clock().position).toBeCloseTo(0.51, 9);
  });

  it('recovers the same request at its offset after an interruption and a gesture', async () => {
    const t = setup();
    await t.narration.unlock();
    await t.narration.playLine('case', 'two');
    t.advance(1.2);
    t.context.interrupt();
    expect(t.narration.clock()).toMatchObject({ status: 'blocked', lineId: 'two' });
    expect(t.narration.clock().position).toBeCloseTo(1.2, 9);
    await t.narration.unlock();
    expect(t.context.sources.at(-1)!.startedAt!.offset).toBeCloseTo(1.2, 9);
    expect(t.summary()).toEqual(['start:two', 'block:two', 'resume:two']);
  });

  it('exposes line metadata and refuses malformed metadata at registration', async () => {
    const t = setup();
    expect(t.narration.line('case', 'one')).toEqual(PACK.lines[0]);
    const copy = t.narration.line('case', 'one')!;
    (copy.meta as Record<string, unknown>)['emotion'] = 'changed';
    expect(t.narration.line('case', 'one')!.meta!['emotion']).toBe('calm');
    expect(t.narration.line('case', 'none')).toBeUndefined();
    const bad = (line: object) => () =>
      t.narration.registerPack({ id: 'bad', revision: 'r1', assets: [], lines: [line as never] });
    expect(bad({ id: 'x', asset: 'a', caption: '', cues: 'not valid id!' })).toThrow(/cues/);
    expect(bad({ id: 'x', asset: 'a', caption: '', kind: 'shout' })).toThrow(/kind/);
    expect(bad({ id: 'x', asset: 'a', caption: '', meta: { a: {} } })).toThrow(/metadata/);
    expect(
      bad({
        id: 'x',
        asset: 'a',
        caption: '',
        meta: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])),
      }),
    ).toThrow(/too many/);
  });

  it('isolates a throwing listener from narration state', async () => {
    const t = setup();
    const errors: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task) => {
      try {
        task();
      } catch (cause) {
        errors.push(cause);
      }
    };
    try {
      t.narration.subscribe(() => {
        throw new Error('consumer bug');
      });
      await t.narration.unlock();
      await t.narration.playLine('case', 'one');
    } finally {
      globalThis.queueMicrotask = original;
    }
    expect(t.narration.clock().status).toBe('playing');
    expect(errors).toHaveLength(1);
  });
});

describe('label speech (AUDIO-07, Q29)', () => {
  it('replace: stops the active line, keeps its caption and does not resume it', async () => {
    const t = setup();
    await t.narration.unlock();
    await t.narration.playLine('case', 'one');
    t.advance(0.3);
    await t.narration.speakLabel('case', 'ok');
    expect(t.narration.clock()).toMatchObject({ lineId: 'ok', kind: 'label', status: 'playing' });
    t.context.finish();
    expect(t.narration.clock()).toMatchObject({ lineId: 'ok', status: 'completed' });
    expect(t.captions).toEqual(['one']);
    expect(t.completions).toEqual([]);
    expect(t.summary()).toEqual(['start:one', 'stop:one:label', 'start:ok', 'complete:ok']);
  });

  it('queue: plays after the active line completes and replaces an older queued label', async () => {
    const t = setup();
    await t.narration.unlock();
    await t.narration.playLine('case', 'one');
    let first = false;
    let second = false;
    void t.narration.speakLabel('case', 'ok', { policy: 'queue' }).then(() => (first = true));
    const later = t.narration
      .speakLabel('case', 'ok', { policy: 'queue' })
      .then(() => (second = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first).toBe(true);
    expect(t.narration.clock().lineId).toBe('one');
    t.context.finish();
    await later;
    expect(second).toBe(true);
    expect(t.narration.clock()).toMatchObject({ lineId: 'ok', kind: 'label', status: 'playing' });
    expect(t.completions).toEqual(['one']);
    expect(t.summary()).toEqual(['start:one', 'complete:one', 'start:ok']);
  });

  it('queue: plays at once when nothing is active, and is dropped when the line is stopped', async () => {
    const t = setup();
    await t.narration.unlock();
    await t.narration.speakLabel('case', 'ok', { policy: 'queue' });
    expect(t.narration.clock()).toMatchObject({ lineId: 'ok', status: 'playing' });
    await t.narration.playLine('case', 'two');
    const dropped = t.narration.speakLabel('case', 'ok', { policy: 'queue' });
    t.narration.stop();
    await dropped;
    expect(t.narration.clock()).toMatchObject({ status: 'idle' });
    expect(t.narration.clock().lineId).toBeUndefined();
    await expect(t.narration.speakLabel('case', 'missing')).rejects.toMatchObject({
      code: 'asset',
    });
    await expect(
      t.narration.speakLabel('case', 'ok', { policy: 'loud' as never }),
    ).rejects.toMatchObject({ code: 'invalid-data' });
  });
});

describe('effects and preloading (issue #13)', () => {
  it('preloads before unlock without decoding, then plays without refetching', async () => {
    const t = setup();
    const result = await t.narration.preload('case', ['fx', 'broken', 'fx', 'unknown']);
    expect(result.loaded).toEqual(['fx', 'broken']);
    expect(result.failed.map((f) => [f.assetId, f.error.code])).toEqual([['unknown', 'asset']]);
    expect(t.narration.context()).toEqual({ state: 'none' });
    await t.narration.unlock();
    expect(t.narration.context()).toEqual({ state: 'running', sampleRate: 48_000 });
    await t.narration.playEffect('case', 'fx', { gain: 0.5 });
    expect(t.fetched.filter((name) => name === 'fx.wav')).toHaveLength(1);
    expect(t.narration.state().voices).toBe(1);
    const decoded = await t.narration.preload('case', ['b']);
    expect(decoded.loaded).toEqual(['b']);
    expect(t.narration.state().decodedBytes).toBeGreaterThan(0);
  });

  it('applies per-call gain and keeps effect failures out of narration status', async () => {
    const gains: FakeGain[] = [];
    const t = setup();
    await t.narration.unlock();
    const create = t.context.createGain.bind(t.context);
    t.context.createGain = () => {
      const node = create();
      gains.push(node);
      return node;
    };
    await t.narration.playLine('case', 'one');
    await t.narration.playEffect('case', 'fx', { gain: 0.25 });
    expect(gains.at(-1)!.gain.value).toBe(0.25);
    await expect(t.narration.playEffect('case', 'broken')).rejects.toBeDefined();
    expect(t.narration.state().status).toBe('playing');
    expect(t.narration.state().effectError).toBeDefined();
    expect(t.narration.state().error).toBeUndefined();
    await expect(t.narration.playEffect('case', 'fx', { gain: 9 })).rejects.toMatchObject({
      code: 'invalid-data',
    });
    await t.narration.playEffect('case', 'fx');
    expect(t.narration.state().effectError).toBeUndefined();
    expect(t.summary()).toEqual(['start:one']);
  });

  it('sets atmosphere loop points and validates them', async () => {
    const t = setup();
    await t.narration.unlock();
    await t.narration.setAtmosphere({ packId: 'case', asset: 'b', loopStart: 0.01, loopEnd: 2.9 });
    const music = t.context.sources.at(-1)!;
    expect([music.loop, music.loopStart, music.loopEnd]).toEqual([true, 0.01, 2.9]);
    await expect(
      t.narration.setAtmosphere({ packId: 'case', asset: 'b', loopStart: 2, loopEnd: 1 }),
    ).rejects.toMatchObject({ code: 'invalid-data' });
    await expect(
      t.narration.setAtmosphere({ packId: 'case', asset: 'a', loopEnd: 9, fadeSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'invalid-data' });
  });
});

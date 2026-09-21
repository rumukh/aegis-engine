import { BrowserServiceError, browserError, requireId, requireInteger } from '../errors.js';
import { localAssetUrl, readBoundedResponse, RequestPool } from '../io.js';
import { rampAudioGain, releaseAudioVoice } from './nodes.js';
import type { GainRamp, OwnedAudioVoice } from './nodes.js';

export type AudioBus = 'narration' | 'music' | 'effects';
export interface NarrationLine {
  id: string;
  asset: string;
  caption: string;
}
export interface AudioAsset {
  id: string;
  src: string;
}
export interface AudioPack {
  id: string;
  revision: string;
  assets: readonly AudioAsset[];
  lines: readonly NarrationLine[];
}
export interface Atmosphere {
  packId: string;
  asset: string;
  fadeSeconds?: number;
}
export interface NarrationState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'completed' | 'blocked' | 'failed';
  line?: NarrationLine;
  offset: number;
  voices: number;
  decodedBytes: number;
  error?: BrowserServiceError;
}
export interface NarrationOptions {
  baseUrl: string;
  contextFactory?(): AudioContext;
  fetch?: typeof fetch;
  maxRequests?: number;
  maxVoices?: number;
  maxFileBytes?: number;
  maxDecodedBytes?: number;
  unlockTimeoutMs?: number;
  duckGain?: number;
  onState(state: NarrationState): void;
  onCaption?(line: NarrationLine | undefined): void;
  onComplete?(lineId: string): void;
}
interface Pack {
  manifest: AudioPack;
  buffers: Map<string, AudioBuffer>;
  requests: Map<string, Promise<AudioBuffer>>;
  abort: AbortController;
}
interface Voice extends OwnedAudioVoice {
  packId: string;
  bus: AudioBus;
  ramp?: GainRamp;
}
interface LineRequest {
  token: number;
  packId: string;
  line: NarrationLine;
  offset: number;
  startedAt: number;
  voice?: Voice;
  completed: boolean;
}

/** Web Audio offsets use the context clock, not wall-clock time or story ticks. */
export function createNarration(options: NarrationOptions) {
  const packs = new Map<string, Pack>();
  const voices = new Set<Voice>();
  const pool = new RequestPool(options.maxRequests ?? 4);
  const maxVoices = options.maxVoices ?? 16;
  const maxFile = options.maxFileBytes ?? 32 * 1024 * 1024;
  const maxDecoded = options.maxDecodedBytes ?? 64 * 1024 * 1024;
  const duck = options.duckGain ?? 0.35;
  const unlockTimeout = options.unlockTimeoutMs ?? 3000;
  requireInteger(maxVoices, 3, 'maxVoices');
  requireInteger(maxFile, 1, 'maxFileBytes');
  requireInteger(maxDecoded, 1, 'maxDecodedBytes');
  requireInteger(unlockTimeout, 1, 'unlockTimeoutMs');
  if (!Number.isFinite(duck) || duck < 0 || duck > 1)
    throw new BrowserServiceError('invalid-data', 'Invalid duck gain.');
  const volumes: Record<AudioBus, number> = { narration: 1, music: 1, effects: 1 };
  const buses: Partial<Record<AudioBus, GainNode>> = {};
  let context: AudioContext | undefined;
  let unlocked: Promise<void> | undefined;
  let unlockTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeReady: (() => void) | undefined;
  let resumeFailed: ((cause: unknown) => void) | undefined;
  let disposed = false;
  let paused = false;
  let serial = 0;
  let effectsGeneration = 0;
  let atmosphereGeneration = 0;
  let atmosphere: Atmosphere | undefined;
  let currentMusic: Voice | undefined;
  let current: LineRequest | undefined;
  let status: NarrationState['status'] = 'idle';
  let error: BrowserServiceError | undefined;
  let decodedBytes = 0;

  const offset = (): number =>
    current?.voice && context
      ? current.offset + Math.max(0, context.currentTime - current.startedAt)
      : (current?.offset ?? 0);
  const state = (): NarrationState => ({
    status,
    offset: offset(),
    voices: voices.size,
    decodedBytes,
    ...(current ? { line: { ...current.line } } : {}),
    ...(error ? { error } : {}),
  });
  const publish = (): void => options.onState(state());
  const alive = (): void => {
    if (disposed) throw new BrowserServiceError('disposed', 'Narration is disposed.');
  };
  const gains = (): void => {
    for (const name of ['narration', 'music', 'effects'] as const) {
      const bus = buses[name];
      if (bus)
        bus.gain.value = volumes[name] * (name === 'music' && status === 'playing' ? duck : 1);
    }
  };
  const release = (voice: Voice, stop = true): void => {
    voices.delete(voice);
    const failures = releaseAudioVoice(voice, stop);
    if (failures.length)
      throw new BrowserServiceError('audio', 'Audio voice cleanup failed.', {
        cause: new AggregateError(failures),
      });
  };
  const fail = (cause: unknown): BrowserServiceError => {
    error = browserError(cause, 'audio');
    status = error.code === 'blocked' ? 'blocked' : 'failed';
    gains();
    publish();
    return error;
  };
  const stopVoices = (): void => {
    const errors: unknown[] = [];
    for (const voice of [...voices]) {
      try {
        release(voice);
      } catch (cause) {
        errors.push(cause);
      }
    }
    currentMusic = undefined;
    if (errors.length)
      throw new BrowserServiceError('audio', 'Stopping owned audio failed.', {
        cause: new AggregateError(errors),
      });
  };
  const detachLine = (): void => {
    if (current?.voice) {
      current.offset = offset();
      const voice = current.voice;
      current.voice = undefined;
      release(voice);
    }
  };
  const getPack = (id: string): Pack => {
    const pack = packs.get(id);
    if (!pack) throw new BrowserServiceError('asset', 'Audio pack is not registered.');
    return pack;
  };
  const buffer = (packId: string, id: string): Promise<AudioBuffer> => {
    const pack = getPack(packId);
    const cached = pack.buffers.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = pack.requests.get(id);
    if (pending) return pending;
    const asset = pack.manifest.assets.find((item) => item.id === id);
    if (!asset)
      return Promise.reject(
        new BrowserServiceError('asset', 'Audio mapping is missing from the active pack.'),
      );
    const operation = pool
      .run(async () => {
        alive();
        if (pack.abort.signal.aborted)
          throw new BrowserServiceError('cancelled', 'Audio pack was released.');
        if (!context) throw new BrowserServiceError('blocked', 'Audio requires a user gesture.');
        const url = localAssetUrl(asset.src, options.baseUrl);
        const response = await (options.fetch ?? globalThis.fetch)(url.href, {
          signal: pack.abort.signal,
          redirect: 'error',
          credentials: 'same-origin',
        });
        const data = await readBoundedResponse(response, maxFile);
        const result = await context.decodeAudioData(data);
        const bytes = result.length * result.numberOfChannels * 4;
        if (!Number.isSafeInteger(bytes) || bytes < 1 || decodedBytes + bytes > maxDecoded)
          throw new BrowserServiceError('limit', 'Decoded PCM budget exceeded.');
        alive();
        if (pack.abort.signal.aborted || packs.get(packId) !== pack)
          throw new BrowserServiceError('cancelled', 'Audio pack changed during decode.');
        pack.buffers.set(id, result);
        decodedBytes += bytes;
        return result;
      })
      .finally(() => {
        pack.requests.delete(id);
      });
    pack.requests.set(id, operation);
    return operation;
  };
  const createVoice = (
    packId: string,
    data: AudioBuffer,
    bus: AudioBus,
    loop: boolean,
    at: number,
    gain = 1,
  ): Voice => {
    if (!context || context.state !== 'running')
      throw new BrowserServiceError('blocked', 'Audio requires a resume gesture.');
    if (voices.size >= maxVoices)
      throw new BrowserServiceError('limit', 'Active voice limit reached.');
    const voice: Voice = { source: context.createBufferSource(), started: false, packId, bus };
    voices.add(voice);
    try {
      voice.gain = context.createGain();
      voice.gain.gain.value = gain;
      voice.source.buffer = data;
      voice.source.loop = loop;
      voice.source.connect(voice.gain);
      voice.gain.connect(buses[bus]!);
      voice.source.start(0, at);
      voice.started = true;
      voice.source.onended = () => {
        if (!voices.has(voice)) return;
        try {
          release(voice, false);
          publish();
        } catch (cause) {
          fail(cause);
        }
      };
      return voice;
    } catch (cause) {
      try {
        release(voice);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup]);
      }
      throw cause;
    }
  };
  const complete = (request: LineRequest): void => {
    if (current !== request || request.completed) return;
    request.completed = true;
    status = 'completed';
    gains();
    publish();
    if (current === request && !disposed) options.onComplete?.(request.line.id);
  };
  const startLine = async (request: LineRequest): Promise<void> => {
    if (request.completed || request.voice || current !== request) return;
    if (paused) {
      status = 'paused';
      publish();
      return;
    }
    if (!context || context.state !== 'running') {
      fail(new BrowserServiceError('blocked', 'Enable narration with a user gesture.'));
      return;
    }
    status = 'loading';
    publish();
    try {
      const data = await buffer(request.packId, request.line.asset);
      if (disposed || current !== request || request.voice || request.completed) return;
      if (paused) {
        status = 'paused';
        publish();
        return;
      }
      if (request.offset >= data.duration) {
        complete(request);
        return;
      }
      const voice = createVoice(request.packId, data, 'narration', false, request.offset);
      request.voice = voice;
      request.startedAt = context.currentTime;
      voice.source.onended = () => {
        if (current !== request || request.voice !== voice || !voices.has(voice)) return;
        request.voice = undefined;
        request.offset = data.duration;
        try {
          release(voice, false);
          complete(request);
        } catch (cause) {
          fail(cause);
        }
      };
      status = 'playing';
      error = undefined;
      gains();
      publish();
    } catch (cause) {
      if (!disposed && current === request) throw fail(cause);
    }
  };
  const startAtmosphere = async (generation: number): Promise<void> => {
    const selection = atmosphere;
    if (!selection || paused || currentMusic) return;
    if (!context || context.state !== 'running') {
      fail(
        new BrowserServiceError('blocked', 'Enable the selected atmosphere with a user gesture.'),
      );
      return;
    }
    try {
      const data = await buffer(selection.packId, selection.asset);
      if (
        disposed ||
        generation !== atmosphereGeneration ||
        atmosphere !== selection ||
        paused ||
        currentMusic
      )
        return;
      const fade = selection.fadeSeconds ?? 0.3;
      const voice = createVoice(selection.packId, data, 'music', true, 0, fade ? 0 : 1);
      currentMusic = voice;
      if (fade && voice.gain)
        voice.ramp = rampAudioGain(voice.gain.gain, undefined, context.currentTime, 1, fade);
      gains();
      publish();
    } catch (cause) {
      if (!disposed && generation === atmosphereGeneration) throw fail(cause);
    }
  };
  const unlock = (): Promise<void> => {
    alive();
    if (unlocked) {
      if (context && context.state !== 'running') {
        try {
          void context.resume().then(
            () => resumeReady?.(),
            (cause: unknown) => resumeFailed?.(cause),
          );
        } catch (cause) {
          resumeFailed?.(cause);
        }
      }
      return unlocked;
    }
    try {
      if (!context) {
        if (!options.contextFactory && typeof globalThis.AudioContext !== 'function')
          throw new BrowserServiceError('unavailable', 'Web Audio is unavailable.');
        context = options.contextFactory ? options.contextFactory() : new AudioContext();
        for (const name of ['narration', 'music', 'effects'] as const) {
          const node = context.createGain();
          node.connect(context.destination);
          buses[name] = node;
        }
        context.onstatechange = () => {
          if (disposed || context?.state === 'running') return;
          effectsGeneration++;
          const interrupted =
            !paused &&
            (voices.size > 0 ||
              atmosphere !== undefined ||
              (current !== undefined && !current.completed));
          try {
            detachLine();
            stopVoices();
            if (interrupted)
              fail(
                new BrowserServiceError(
                  'blocked',
                  'Audio output was interrupted; resume with a gesture.',
                ),
              );
            else publish();
          } catch (cause) {
            fail(cause);
          }
        };
      }
      // Invoke resume in the trusted gesture's stack, before any asynchronous work.
      const resume = context.state === 'running' ? Promise.resolve() : context.resume();
      const ready = new Promise<void>((resolve, reject) => {
        resumeReady = resolve;
        resumeFailed = reject;
        unlockTimer = setTimeout(
          () =>
            reject(
              new BrowserServiceError(
                'blocked',
                'Audio resume timed out; retry with a user gesture.',
              ),
            ),
          unlockTimeout,
        );
        void resume.then(resolve, reject);
      });
      unlocked = ready
        .then(async () => {
          alive();
          if (context?.state !== 'running')
            throw new BrowserServiceError('blocked', 'Audio is still suspended.');
          error = undefined;
          if (status === 'blocked' && (!current || current.completed))
            status = current?.completed ? 'completed' : 'idle';
          gains();
          await Promise.all([
            current ? startLine(current) : Promise.resolve(),
            startAtmosphere(atmosphereGeneration),
          ]);
          publish();
        })
        .catch((cause: unknown) => {
          if (!disposed)
            throw fail(
              context?.state === 'suspended'
                ? new BrowserServiceError('blocked', 'Audio requires another user gesture.', {
                    cause,
                  })
                : cause,
            );
          throw cause;
        })
        .finally(() => {
          clearTimeout(unlockTimer);
          unlockTimer = undefined;
          resumeReady = undefined;
          resumeFailed = undefined;
          unlocked = undefined;
        });
      return unlocked;
    } catch (cause) {
      return Promise.reject(fail(cause));
    }
  };
  const stop = (): void => {
    alive();
    serial++;
    detachLine();
    current = undefined;
    status = 'idle';
    error = undefined;
    gains();
    options.onCaption?.(undefined);
    publish();
  };
  const clear = (): void => {
    stop();
    effectsGeneration++;
    atmosphereGeneration++;
    atmosphere = undefined;
    stopVoices();
    publish();
  };
  const playLine = async (packId: string, lineId: string): Promise<void> => {
    alive();
    detachLine();
    current = undefined;
    const token = ++serial;
    try {
      const line = getPack(packId).manifest.lines.find((item) => item.id === lineId);
      if (!line) {
        options.onCaption?.(undefined);
        throw new BrowserServiceError('asset', 'Narration line is missing from the pack.');
      }
      current = { token, packId, line: { ...line }, offset: 0, startedAt: 0, completed: false };
      error = undefined;
      options.onCaption?.({ ...line });
      if (serial === token) await startLine(current);
    } catch (cause) {
      if (serial === token) throw fail(cause);
    }
  };
  return {
    state,
    unlock,
    playLine,
    stop,
    /** Restore/handoff boundary: removes captions and all pending/playing one-shots and loops. */
    clear,
    registerPack(manifest: AudioPack): void {
      alive();
      requireId(manifest.id);
      requireId(manifest.revision);
      if (packs.size >= 32 || manifest.assets.length > 4096 || manifest.lines.length > 4096)
        throw new BrowserServiceError('limit', 'Audio pack declaration budget exceeded.');
      if (packs.has(manifest.id))
        throw new BrowserServiceError(
          'conflict',
          'Release the old audio pack before replacing it.',
        );
      const assets = new Set<string>();
      for (const asset of manifest.assets) {
        requireId(asset.id);
        localAssetUrl(asset.src, options.baseUrl);
        if (assets.has(asset.id))
          throw new BrowserServiceError('asset', 'Duplicate audio asset ID.');
        assets.add(asset.id);
      }
      const lines = new Set<string>();
      for (const line of manifest.lines) {
        requireId(line.id);
        requireId(line.asset);
        if (lines.has(line.id) || typeof line.caption !== 'string' || line.caption.length > 16_384)
          throw new BrowserServiceError('asset', 'Duplicate line or invalid caption.');
        lines.add(line.id);
      }
      packs.set(manifest.id, {
        manifest: structuredClone(manifest),
        buffers: new Map(),
        requests: new Map(),
        abort: new AbortController(),
      });
    },
    pause(): void {
      alive();
      if (paused) return;
      paused = true;
      effectsGeneration++;
      detachLine();
      stopVoices();
      if (current && !current.completed) status = 'paused';
      gains();
      publish();
    },
    async resume(): Promise<void> {
      alive();
      paused = false;
      if ((atmosphere || (current && !current.completed)) && context?.state !== 'running')
        throw fail(new BrowserServiceError('blocked', 'Resume audio with a user gesture.'));
      await Promise.all([
        current ? startLine(current) : Promise.resolve(),
        startAtmosphere(atmosphereGeneration),
      ]);
    },
    replay(): Promise<void> {
      alive();
      if (!current) return Promise.reject(new BrowserServiceError('blocked', 'No line to replay.'));
      return playLine(current.packId, current.line.id);
    },
    setVolume(bus: AudioBus, value: number): void {
      alive();
      if (
        !['narration', 'music', 'effects'].includes(bus) ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      )
        throw new BrowserServiceError(
          'invalid-data',
          'Audio bus volume must be between zero and one.',
        );
      volumes[bus] = value;
      gains();
      publish();
    },
    async playEffect(packId: string, assetId: string): Promise<void> {
      alive();
      if (paused || !context || context.state !== 'running')
        throw fail(new BrowserServiceError('blocked', 'Effects require running audio.'));
      const generation = effectsGeneration;
      try {
        const data = await buffer(packId, assetId);
        if (disposed || generation !== effectsGeneration || paused) return;
        createVoice(packId, data, 'effects', false, 0);
        publish();
      } catch (cause) {
        if (!disposed && generation === effectsGeneration) throw fail(cause);
      }
    },
    async setAtmosphere(next: Atmosphere | null): Promise<void> {
      alive();
      const fade = next?.fadeSeconds ?? 0.3;
      if (!Number.isFinite(fade) || fade < 0 || fade > 5)
        throw new BrowserServiceError(
          'invalid-data',
          'Crossfade must be between zero and five seconds.',
        );
      if (
        next &&
        atmosphere?.packId === next.packId &&
        atmosphere.asset === next.asset &&
        currentMusic
      )
        return;
      const generation = ++atmosphereGeneration;
      atmosphere = next ? { ...next } : undefined;
      for (const voice of [...voices]) {
        if (voice.bus !== 'music') continue;
        if (next && voice === currentMusic && fade && context && voice.gain) {
          voice.ramp = rampAudioGain(voice.gain.gain, voice.ramp, context.currentTime, 0, fade);
          voice.source.stop(context.currentTime + fade);
        } else release(voice);
      }
      currentMusic = undefined;
      if (!next && status === 'blocked' && (!current || current.completed)) {
        status = current?.completed ? 'completed' : 'idle';
        error = undefined;
      }
      await startAtmosphere(generation);
      publish();
    },
    releasePack(id: string): void {
      alive();
      const pack = getPack(id);
      effectsGeneration++;
      if (current?.packId === id) stop();
      if (atmosphere?.packId === id) {
        atmosphere = undefined;
        atmosphereGeneration++;
        currentMusic = undefined;
      }
      for (const voice of [...voices]) if (voice.packId === id) release(voice);
      pack.abort.abort();
      for (const data of pack.buffers.values())
        decodedBytes -= data.length * data.numberOfChannels * 4;
      pack.buffers.clear();
      packs.delete(id);
      publish();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      clear();
      disposed = true;
      resumeFailed?.(new BrowserServiceError('disposed', 'Narration was disposed during unlock.'));
      clearTimeout(unlockTimer);
      atmosphereGeneration++;
      for (const pack of packs.values()) pack.abort.abort();
      packs.clear();
      decodedBytes = 0;
      stopVoices();
      for (const node of Object.values(buses)) node.disconnect();
      if (context) {
        context.onstatechange = null;
        if (context.state !== 'closed') await context.close();
      }
    },
  };
}

export type NarrationController = ReturnType<typeof createNarration>;

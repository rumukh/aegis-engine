import {
  BrowserServiceError,
  browserError,
  isRecord,
  requireId,
  requireInteger,
} from '../errors.js';
import { checkSchemes, localAssetUrl, readBoundedResponse, RequestPool } from '../io.js';
import { rampAudioGain, releaseAudioVoice } from './nodes.js';
import type { GainRamp, OwnedAudioVoice } from './nodes.js';

export type AudioBus = 'narration' | 'music' | 'effects';
export type NarrationLineKind = 'line' | 'label';
export type LineMetaValue = string | number | boolean;
export interface NarrationLine {
  id: string;
  asset: string;
  caption: string;
  /** Optional speaker or cast role, for example the puppet that lip-syncs this line. */
  speaker?: string;
  /** Optional asset ID of the line's mouth-cue track (`aegis-cues/1`), resolved by the consumer. */
  cues?: string;
  /** Optional consumer metadata: at most 32 JSON scalar entries. */
  meta?: Readonly<Record<string, LineMetaValue>>;
  /** `label` marks spoken interface labels played with `speakLabel`. Defaults to `line`. */
  kind?: NarrationLineKind;
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
  /** Optional loop region in seconds, e.g. to trim decoder padding (issue #13). */
  loopStart?: number;
  loopEnd?: number;
}
export type NarrationStatus =
  'idle' | 'loading' | 'playing' | 'paused' | 'completed' | 'blocked' | 'failed';
export interface NarrationState {
  status: NarrationStatus;
  line?: NarrationLine;
  offset: number;
  voices: number;
  decodedBytes: number;
  error?: BrowserServiceError;
  /** The most recent sound-effect failure. Effect failures never change `status`. */
  effectError?: BrowserServiceError;
}
/** Per-frame view of the active request. `position` is the audible media position in seconds. */
export interface NarrationClock {
  serial: number;
  packId?: string;
  lineId?: string;
  kind?: NarrationLineKind;
  status: NarrationStatus;
  position: number;
  duration?: number;
}
export type NarrationEventType =
  'start' | 'resume' | 'pause' | 'stop' | 'complete' | 'fail' | 'block';
export type NarrationStopReason = 'replaced' | 'stopped' | 'label' | 'cleared' | 'released';
export interface NarrationEvent {
  type: NarrationEventType;
  serial: number;
  packId: string;
  lineId: string;
  kind: NarrationLineKind;
  position: number;
  reason?: NarrationStopReason;
}
export interface AudioContextStatus {
  state: 'none' | AudioContextState | 'interrupted';
  sampleRate?: number;
}
export interface EffectOptions {
  /** Per-call gain multiplied with the effects bus volume, 0..4. Defaults to 1. */
  gain?: number;
}
export interface PreloadResult {
  loaded: readonly string[];
  failed: readonly { assetId: string; error: BrowserServiceError }[];
}
export interface LabelOptions {
  /** `replace` (default) stops the active request; `queue` waits for the active line to end. */
  policy?: 'replace' | 'queue';
}
export interface NarrationOptions {
  baseUrl: string;
  contextFactory?(): AudioContext;
  fetch?: typeof fetch;
  /**
   * Secure custom application schemes allowed for the base URL, e.g. ['app:'] for an Electron
   * protocol.handle('app', ...) page. HTTP(S) needs no declaration.
   */
  schemes?: readonly string[];
  /** Millisecond clock comparable with `AudioTimestamp.performanceTime`. Defaults to `performance.now`. */
  now?(): number;
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
  /** Bytes fetched by `preload` before the audio context existed; decoded on first use. */
  raw: Map<string, ArrayBuffer>;
  prefetches: Map<string, Promise<void>>;
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
  kind: NarrationLineKind;
  offset: number;
  startedAt: number;
  duration?: number;
  voice?: Voice;
  completed: boolean;
  started: boolean;
  ended: boolean;
}
interface QueuedLabel {
  packId: string;
  lineId: string;
  settle(): void;
  fail(cause: unknown): void;
}
const META_LIMIT = 32;

function copyLine(line: NarrationLine): NarrationLine {
  return { ...line, ...(line.meta ? { meta: { ...line.meta } } : {}) };
}

function validateLineExtras(line: NarrationLine): void {
  // Unknown fields stay tolerated, as before AUDIO-07, so existing packs keep registering.
  if (line.speaker !== undefined) requireId(line.speaker, 'speaker');
  if (line.cues !== undefined) requireId(line.cues, 'cues');
  if (line.kind !== undefined && line.kind !== 'line' && line.kind !== 'label')
    throw new BrowserServiceError('asset', 'Narration line kind must be "line" or "label".');
  if (line.meta !== undefined) {
    if (!isRecord(line.meta))
      throw new BrowserServiceError('asset', 'Narration line metadata must be an object.');
    const entries = Object.entries(line.meta);
    if (entries.length > META_LIMIT)
      throw new BrowserServiceError('limit', 'Narration line metadata has too many entries.');
    for (const [key, value] of entries) {
      requireId(key, 'metadata key');
      if (!(
        (typeof value === 'string' && value.length <= 1024) ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ))
        throw new BrowserServiceError(
          'asset',
          'Narration line metadata values must be bounded strings, finite numbers or booleans.',
        );
    }
  }
}

/** Web Audio offsets use the context clock, not wall-clock time or story ticks. */
export function createNarration(options: NarrationOptions) {
  const schemes = checkSchemes(options.schemes);
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
  let rawBytes = 0;
  let effectError: BrowserServiceError | undefined;
  let queued: QueuedLabel | undefined;
  const listeners = new Set<(event: NarrationEvent) => void>();
  const now = options.now ?? (() => globalThis.performance.now());

  const offset = (): number =>
    current?.voice && context
      ? current.offset + Math.max(0, context.currentTime - current.startedAt)
      : (current?.offset ?? 0);
  /** Context time of the sample currently leaving the output device. */
  const audibleTime = (ctx: AudioContext): number => {
    const scheduled = ctx.currentTime;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : {};
    const { contextTime, performanceTime } = stamp;
    if (
      typeof contextTime === 'number' &&
      typeof performanceTime === 'number' &&
      Number.isFinite(contextTime) &&
      Number.isFinite(performanceTime) &&
      performanceTime > 0 &&
      contextTime > 0
    ) {
      const extrapolated = contextTime + Math.max(0, (now() - performanceTime) / 1000);
      return Math.min(scheduled, extrapolated);
    }
    const latency = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    const delay = Number.isFinite(latency)
      ? latency!
      : Number.isFinite(ctx.baseLatency)
        ? ctx.baseLatency
        : 0;
    return scheduled - Math.max(0, delay);
  };
  const position = (request: LineRequest | undefined): number => {
    if (!request) return 0;
    const value =
      request.voice && context
        ? request.offset + Math.max(0, audibleTime(context) - request.startedAt)
        : request.offset;
    return request.duration === undefined ? value : Math.min(value, request.duration);
  };
  const emit = (
    request: LineRequest,
    type: NarrationEventType,
    reason?: NarrationStopReason,
  ): void => {
    if (!listeners.size) return;
    const event: NarrationEvent = {
      type,
      serial: request.token,
      packId: request.packId,
      lineId: request.line.id,
      kind: request.kind,
      position: position(request),
      ...(reason ? { reason } : {}),
    };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (cause) {
        // A consumer listener must not corrupt narration state; surface it asynchronously.
        queueMicrotask(() => {
          throw cause;
        });
      }
    }
  };
  /** Ends the current request once, with a stop event, and drops any queued label. */
  const endCurrent = (reason: NarrationStopReason): void => {
    const request = current;
    if (request && !request.ended && !request.completed) {
      request.ended = true;
      emit(request, 'stop', reason);
    }
  };
  const dropQueued = (): void => {
    const pending = queued;
    queued = undefined;
    pending?.settle();
  };
  const state = (): NarrationState => ({
    status,
    offset: offset(),
    voices: voices.size,
    decodedBytes,
    ...(current ? { line: copyLine(current.line) } : {}),
    ...(error ? { error } : {}),
    ...(effectError ? { effectError } : {}),
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
    if (current && !current.completed && !current.ended) {
      const request = current;
      emit(request, status === 'blocked' ? 'block' : 'fail');
      if (status === 'failed' && queued && current === request) startQueued();
    }
    return error;
  };
  const failEffect = (cause: unknown): BrowserServiceError => {
    effectError = browserError(cause, 'audio');
    publish();
    return effectError;
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
  /** Fetch bytes without decoding; used before an audio context exists. */
  const prefetch = (pack: Pack, id: string): Promise<void> => {
    if (pack.buffers.has(id) || pack.raw.has(id)) return Promise.resolve();
    const pending = pack.prefetches.get(id);
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
        const url = localAssetUrl(asset.src, options.baseUrl, schemes);
        const response = await (options.fetch ?? globalThis.fetch)(url.href, {
          signal: pack.abort.signal,
          redirect: 'error',
          credentials: 'same-origin',
        });
        const data = await readBoundedResponse(response, maxFile);
        alive();
        if (pack.abort.signal.aborted || pack.buffers.has(id) || pack.raw.has(id)) return;
        if (decodedBytes + rawBytes + data.byteLength > maxDecoded)
          throw new BrowserServiceError('limit', 'Preloaded audio budget exceeded.');
        pack.raw.set(id, data);
        rawBytes += data.byteLength;
      })
      .finally(() => {
        pack.prefetches.delete(id);
      });
    pack.prefetches.set(id, operation);
    return operation;
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
        let data = pack.raw.get(id);
        if (data) {
          pack.raw.delete(id);
          rawBytes -= data.byteLength;
        } else {
          const url = localAssetUrl(asset.src, options.baseUrl, schemes);
          const response = await (options.fetch ?? globalThis.fetch)(url.href, {
            signal: pack.abort.signal,
            redirect: 'error',
            credentials: 'same-origin',
          });
          data = await readBoundedResponse(response, maxFile);
        }
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
    loopRegion?: { start?: number; end?: number },
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
      if (loop && loopRegion) {
        const start = loopRegion.start ?? 0;
        const end = loopRegion.end ?? data.duration;
        if (!(start >= 0 && end > start && end <= data.duration + 1e-6))
          throw new BrowserServiceError(
            'invalid-data',
            'Loop points lie outside the decoded audio.',
          );
        voice.source.loopStart = start;
        voice.source.loopEnd = Math.min(end, data.duration);
      }
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
    if (!request.ended) {
      request.ended = true;
      emit(request, 'complete');
    }
    if (current === request && !disposed && request.kind === 'line')
      options.onComplete?.(request.line.id);
    if (current === request && !disposed && queued) startQueued();
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
      request.duration = data.duration;
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
      emit(request, request.started ? 'resume' : 'start');
      request.started = true;
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
      const voice = createVoice(selection.packId, data, 'music', true, 0, fade ? 0 : 1, {
        ...(selection.loopStart !== undefined ? { start: selection.loopStart } : {}),
        ...(selection.loopEnd !== undefined ? { end: selection.loopEnd } : {}),
      });
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
  const stopWith = (reason: NarrationStopReason): void => {
    alive();
    endCurrent(reason);
    dropQueued();
    serial++;
    detachLine();
    current = undefined;
    status = 'idle';
    error = undefined;
    gains();
    options.onCaption?.(undefined);
    publish();
  };
  const stop = (): void => stopWith('stopped');
  const clear = (): void => {
    stopWith('cleared');
    effectsGeneration++;
    atmosphereGeneration++;
    atmosphere = undefined;
    stopVoices();
    publish();
  };
  const findLine = (packId: string, lineId: string): NarrationLine | undefined =>
    getPack(packId).manifest.lines.find((item) => item.id === lineId);
  const begin = async (
    packId: string,
    lineId: string,
    kind: NarrationLineKind,
    reason: NarrationStopReason,
  ): Promise<void> => {
    alive();
    endCurrent(reason);
    detachLine();
    current = undefined;
    const token = ++serial;
    try {
      const line = findLine(packId, lineId);
      if (!line) {
        if (kind === 'line') options.onCaption?.(undefined);
        throw new BrowserServiceError('asset', 'Narration line is missing from the pack.');
      }
      current = {
        token,
        packId,
        line: copyLine(line),
        kind,
        offset: 0,
        startedAt: 0,
        completed: false,
        started: false,
        ended: false,
      };
      error = undefined;
      if (kind === 'line') options.onCaption?.(copyLine(line));
      if (serial === token) await startLine(current);
    } catch (cause) {
      if (serial === token) throw fail(cause);
    }
  };
  function startQueued(): void {
    const next = queued;
    queued = undefined;
    if (!next || disposed) {
      next?.settle();
      return;
    }
    begin(next.packId, next.lineId, 'label', 'label').then(next.settle, next.fail);
  }
  const playLine = async (packId: string, lineId: string): Promise<void> => {
    alive();
    dropQueued();
    return begin(packId, lineId, 'line', 'replaced');
  };
  const speakLabel = async (
    packId: string,
    lineId: string,
    labelOptions: LabelOptions = {},
  ): Promise<void> => {
    alive();
    const policy = labelOptions.policy ?? 'replace';
    if (policy !== 'replace' && policy !== 'queue')
      throw new BrowserServiceError('invalid-data', 'Label policy must be "replace" or "queue".');
    if (!findLine(packId, lineId))
      throw new BrowserServiceError('asset', 'Label line is missing from the pack.');
    dropQueued();
    if (
      policy === 'queue' &&
      current &&
      !current.completed &&
      !current.ended &&
      status !== 'failed'
    )
      return new Promise<void>((resolve, reject) => {
        queued = { packId, lineId, settle: resolve, fail: reject };
      });
    return begin(packId, lineId, 'label', 'label');
  };
  return {
    state,
    unlock,
    playLine,
    speakLabel,
    stop,
    /** Restore/handoff boundary: removes captions and all pending/playing one-shots and loops. */
    clear,
    /** Allocation-light snapshot of the active request, suitable for per-frame sampling. */
    clock(): NarrationClock {
      const request = current;
      return {
        serial: request?.token ?? serial,
        status,
        position: position(request),
        ...(request ? { packId: request.packId, lineId: request.line.id, kind: request.kind } : {}),
        ...(request?.duration !== undefined ? { duration: request.duration } : {}),
      };
    },
    /** Start/pause/resume/stop/complete/fail/block notifications for every request. */
    subscribe(listener: (event: NarrationEvent) => void): () => void {
      alive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The registered line with its metadata, or undefined. */
    line(packId: string, lineId: string): NarrationLine | undefined {
      alive();
      const line = findLine(packId, lineId);
      return line ? copyLine(line) : undefined;
    },
    context(): AudioContextStatus {
      if (!context) return { state: 'none' };
      return { state: context.state, sampleRate: context.sampleRate };
    },
    /**
     * Fetch (and, once audio is unlocked, decode) assets ahead of their first use. Before the
     * first `unlock` the bytes are fetched and kept; they are decoded on first use. Individual
     * failures are reported in the result and never change narration status.
     */
    async preload(packId: string, assetIds?: readonly string[]): Promise<PreloadResult> {
      alive();
      const pack = getPack(packId);
      const ids = assetIds ? [...new Set(assetIds)] : pack.manifest.assets.map((item) => item.id);
      const loaded: string[] = [];
      const failed: { assetId: string; error: BrowserServiceError }[] = [];
      await Promise.all(
        ids.map(async (assetId) => {
          try {
            if (context) await buffer(packId, assetId);
            else await prefetch(pack, assetId);
            loaded.push(assetId);
          } catch (cause) {
            failed.push({ assetId, error: browserError(cause, 'asset') });
          }
        }),
      );
      const order = new Map(ids.map((id, index) => [id, index]));
      loaded.sort((a, b) => order.get(a)! - order.get(b)!);
      failed.sort((a, b) => order.get(a.assetId)! - order.get(b.assetId)!);
      return { loaded, failed };
    },
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
        localAssetUrl(asset.src, options.baseUrl, schemes);
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
        validateLineExtras(line);
        lines.add(line.id);
      }
      packs.set(manifest.id, {
        manifest: structuredClone(manifest),
        buffers: new Map(),
        requests: new Map(),
        raw: new Map(),
        prefetches: new Map(),
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
      if (current && !current.completed) {
        status = 'paused';
        if (!current.ended && current.started) emit(current, 'pause');
      }
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
      dropQueued();
      return begin(current.packId, current.line.id, current.kind, 'replaced');
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
    /** Effect failures reject and are reported as `effectError`; narration status is untouched. */
    async playEffect(packId: string, assetId: string, effect: EffectOptions = {}): Promise<void> {
      alive();
      const gain = effect.gain ?? 1;
      if (!Number.isFinite(gain) || gain < 0 || gain > 4)
        throw failEffect(
          new BrowserServiceError('invalid-data', 'Effect gain must be between zero and four.'),
        );
      if (paused || !context || context.state !== 'running')
        throw failEffect(new BrowserServiceError('blocked', 'Effects require running audio.'));
      const generation = effectsGeneration;
      try {
        const data = await buffer(packId, assetId);
        if (disposed || generation !== effectsGeneration || paused) return;
        createVoice(packId, data, 'effects', false, 0, gain);
        effectError = undefined;
        publish();
      } catch (cause) {
        if (!disposed && generation === effectsGeneration) throw failEffect(cause);
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
        ((next.loopStart !== undefined &&
          (!Number.isFinite(next.loopStart) || next.loopStart < 0)) ||
          (next.loopEnd !== undefined &&
            (!Number.isFinite(next.loopEnd) || next.loopEnd <= (next.loopStart ?? 0))))
      )
        throw new BrowserServiceError(
          'invalid-data',
          'Loop points must be finite, non-negative and ordered.',
        );
      if (
        next &&
        atmosphere?.packId === next.packId &&
        atmosphere.asset === next.asset &&
        atmosphere.loopStart === next.loopStart &&
        atmosphere.loopEnd === next.loopEnd &&
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
      if (current?.packId === id) stopWith('released');
      if (queued?.packId === id) dropQueued();
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
      for (const data of pack.raw.values()) rawBytes -= data.byteLength;
      pack.raw.clear();
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
      rawBytes = 0;
      listeners.clear();
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

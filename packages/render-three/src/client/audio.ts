import type { EventLine } from '../protocol.js';
import { QUALITY } from '../presentation/schema.js';
import type { AudioSpec, QualityTier } from '../presentation/schema.js';

export interface AudioState {
  status: 'locked' | 'ready' | 'unavailable' | 'error';
  muted: boolean;
  voices: number;
  /** Suppressed cues and voices evicted by the quality budget, since the last reset. */
  dropped: number;
  error?: string;
}

export interface AudioOptions {
  spec?: AudioSpec;
  readBuffer(id: string): ArrayBuffer;
  quality?: QualityTier;
  onState?(state: AudioState): void;
  contextFactory?(): AudioContext;
}

export interface AudioController {
  /** Call directly from a trusted gesture. No other method creates or resumes a context. */
  unlock(): Promise<void>;
  setMuted(muted: boolean): void;
  setPaused(paused: boolean): void;
  setQuality(quality: QualityTier): void;
  consume(events: readonly EventLine[], generation: number, tick: number): void;
  reset(generation?: number): void;
  state(): AudioState;
  dispose(): void;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain?: GainNode;
  ambient: boolean;
  started: boolean;
}

function message(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(message).join('; ')}`;
  return error instanceof Error ? error.message : String(error);
}

/** Audio is a consumer of delivered events, never a source of simulation timing. */
export function createAudio(options: AudioOptions): AudioController {
  const spec = options.spec;
  const cues = spec?.cues ?? [];
  const assetIds = new Set(cues.map((cue) => cue.asset));
  if (spec?.ambient !== undefined) assetIds.add(spec.ambient.asset);
  const buffers = new Map<string, AudioBuffer>();
  const voices = new Set<Voice>();
  const cooldowns = new Map<number, number>();
  let quality = options.quality ?? 'standard';
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let pending: Promise<void> | undefined;
  let attempt = 0;
  let disposed = false;
  let paused = false;
  let muted = false;
  let status: AudioState['status'] = assetIds.size === 0 ? 'unavailable' : 'locked';
  let error: string | undefined;
  let dropped = 0;
  let generation = 0;
  let lastTick = -1;
  // A delayed packet must not turn an unlock/unmute into an audible history catch-up.
  let audibleFromTick = -1;
  let lastSequence = -1;
  let legacyTick = -1;
  const legacyCounts = new Map<string, number>();
  let published: AudioState | undefined;

  const state = (): AudioState => ({
    status,
    muted,
    voices: voices.size,
    dropped,
    ...(error === undefined ? {} : { error }),
  });
  const publish = (): void => {
    const next = state();
    if (
      published?.status === next.status &&
      published.muted === next.muted &&
      published.voices === next.voices &&
      published.dropped === next.dropped &&
      published.error === next.error
    )
      return;
    published = next;
    options.onState?.({ ...next });
  };

  const cleanup = (actions: readonly (() => void)[]): unknown[] => {
    const errors: unknown[] = [];
    for (const action of actions) {
      try {
        action();
      } catch (cause) {
        errors.push(cause);
      }
    }
    return errors;
  };
  const release = (voice: Voice, stop = true): unknown[] => {
    voices.delete(voice);
    voice.source.onended = null;
    return cleanup([
      () => {
        if (stop && voice.started) voice.source.stop();
      },
      () => voice.source.disconnect(),
      () => voice.gain?.disconnect(),
      () => {
        voice.source.buffer = null;
      },
    ]);
  };
  const stopAll = (): unknown[] => [...voices].flatMap((voice) => release(voice));
  const checkCleanup = (errors: readonly unknown[]): void => {
    if (errors.length !== 0) throw new AggregateError(errors, 'Audio resource cleanup failed');
  };
  const fail = (cause: unknown, nextStatus: AudioState['status'] = 'error'): unknown => {
    const errors = stopAll();
    const failure =
      errors.length === 0
        ? cause
        : new AggregateError([cause, ...errors], 'Audio playback and cleanup failed');
    status = nextStatus;
    error = message(failure);
    publish();
    return failure;
  };
  const reportAsync = (cause: unknown): void => {
    const failure = fail(cause);
    // Void lifecycle methods cannot return the close/onended rejection to their caller.
    if (options.onState === undefined) console.error('[aegis:audio]', failure);
  };
  const guard = (action: () => void): void => {
    if (disposed) return;
    try {
      action();
      publish();
    } catch (cause) {
      throw fail(cause);
    }
  };
  const playable = (): boolean =>
    !disposed && !muted && !paused && status === 'ready' && context?.state === 'running';

  const evict = (): void => {
    const oldest = [...voices].find((voice) => !voice.ambient) ?? voices.values().next().value;
    if (oldest === undefined) return;
    dropped++;
    checkCleanup(release(oldest));
  };
  const play = (asset: string, volume: number, ambient: boolean): void => {
    if (!playable() || context === undefined || master === undefined) return;
    const buffer = buffers.get(asset);
    if (buffer === undefined) throw new Error(`Audio asset "${asset}" is not decoded.`);
    while (voices.size >= QUALITY[quality].voices) evict();
    const voice: Voice = { source: context.createBufferSource(), ambient, started: false };
    voices.add(voice);
    try {
      voice.gain = context.createGain();
      voice.gain.gain.value = volume;
      voice.source.buffer = buffer;
      voice.source.loop = ambient;
      voice.source.connect(voice.gain);
      voice.gain.connect(master);
      voice.source.onended = () => {
        const errors = release(voice, false);
        if (errors.length !== 0)
          reportAsync(new AggregateError(errors, 'Audio voice cleanup failed'));
        else publish();
      };
      voice.source.start();
      voice.started = true;
    } catch (cause) {
      const errors = release(voice);
      if (errors.length !== 0)
        throw new AggregateError([cause, ...errors], `Audio asset "${asset}" could not start`);
      throw cause;
    }
  };
  const ambient = (): void => {
    if (spec?.ambient !== undefined && ![...voices].some((voice) => voice.ambient))
      play(spec.ambient.asset, spec.ambient.volume ?? 1, true);
  };
  const reset = (nextGeneration = generation + 1): void => {
    guard(() => {
      generation = nextGeneration;
      lastTick = audibleFromTick = lastSequence = legacyTick = -1;
      legacyCounts.clear();
      cooldowns.clear();
      dropped = 0;
      checkCleanup(stopAll());
      ambient();
    });
  };

  const unlock = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('Audio controller is disposed.'));
    if (pending !== undefined) return pending;
    const token = ++attempt;
    const start = async (): Promise<void> => {
      try {
        if (assetIds.size === 0) {
          status = 'unavailable';
          throw new Error('No audio is configured for this game.');
        }
        if (context === undefined) {
          if (
            options.contextFactory === undefined &&
            typeof globalThis.AudioContext !== 'function'
          ) {
            status = 'unavailable';
            throw new Error('Web Audio is unavailable in this browser.');
          }
          context =
            options.contextFactory === undefined ? new AudioContext() : options.contextFactory();
          context.onstatechange = () => {
            if (disposed || status !== 'ready' || context?.state === 'running') return;
            status = context?.state === 'closed' ? 'unavailable' : 'locked';
            if (status === 'unavailable') error = 'The audio context was closed.';
            const errors = stopAll();
            if (errors.length !== 0)
              reportAsync(new AggregateError(errors, 'Interrupted audio cleanup failed'));
            else publish();
          };
        }
        if (context.state === 'closed') {
          status = 'unavailable';
          throw new Error('The audio context was closed.');
        }
        if (master === undefined) {
          const output = context.createGain();
          try {
            output.gain.value = muted ? 0 : (spec?.volume ?? 1);
            output.connect(context.destination);
            master = output;
          } catch (cause) {
            const errors = cleanup([() => output.disconnect()]);
            throw new AggregateError([cause, ...errors], 'Audio output could not connect');
          }
        }
        // Resume before the first await: transient browser user activation must still be live.
        const resume = context.state === 'running' ? Promise.resolve() : context.resume();
        const audioContext = context;
        const decode = [...assetIds].map(async (id) => {
          if (buffers.has(id)) return;
          try {
            // decodeAudioData may detach its argument; asset-library bytes remain reusable.
            const decoded = await audioContext.decodeAudioData(options.readBuffer(id).slice(0));
            if (!disposed && token === attempt) buffers.set(id, decoded);
          } catch (cause) {
            throw new Error(`Audio asset "${id}" could not decode: ${message(cause)}`, {
              cause,
            });
          }
        });
        await Promise.all([resume, ...decode]);
        if (disposed) throw new Error('Audio controller was disposed during unlock.');
        if (context.state !== 'running')
          throw new Error('Audio did not start. Enable sound with another user gesture.');
        if (status !== 'ready') audibleFromTick = lastTick;
        status = 'ready';
        error = undefined;
        ambient();
        publish();
      } catch (cause) {
        if (disposed) throw cause;
        throw fail(cause, status === 'unavailable' ? 'unavailable' : 'error');
      }
    };
    pending = start().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  publish();
  return {
    unlock,
    state,
    reset,
    setMuted(value): void {
      guard(() => {
        if (muted === value) return;
        muted = value;
        if (master !== undefined) master.gain.value = muted ? 0 : (spec?.volume ?? 1);
        if (muted) checkCleanup(stopAll());
        else {
          audibleFromTick = lastTick;
          ambient();
        }
      });
    },
    setPaused(value): void {
      guard(() => {
        if (paused === value) return;
        paused = value;
        if (paused) checkCleanup(stopAll());
        else {
          audibleFromTick = lastTick;
          ambient();
        }
      });
    },
    setQuality(value): void {
      guard(() => {
        quality = value;
        while (voices.size > QUALITY[quality].voices) evict();
      });
    },
    consume(events, nextGeneration, tick): void {
      if (disposed || nextGeneration < generation) return;
      if (nextGeneration !== generation) reset(nextGeneration);
      if (tick < lastTick) return;
      lastTick = tick;
      guard(() => {
        const previousSequence = lastSequence;
        const batchSequences = new Set<number>();
        const batchCounts = new Map<string, number>();
        for (const event of [...events].sort((a, b) => a.tick - b.tick)) {
          if (event.tick > tick) continue;
          if (event.sequence !== undefined) {
            if (event.sequence <= previousSequence || batchSequences.has(event.sequence)) continue;
            batchSequences.add(event.sequence);
            lastSequence = Math.max(lastSequence, event.sequence);
          } else {
            // Legacy packets have no identity. Preserve occurrence counts within a tick; new
            // producers must supply sequence to distinguish identical incremental packets.
            if (event.tick < legacyTick) continue;
            if (event.tick > legacyTick) {
              legacyTick = event.tick;
              legacyCounts.clear();
              batchCounts.clear();
            }
            const count = (batchCounts.get(event.type) ?? 0) + 1;
            batchCounts.set(event.type, count);
            if (count <= (legacyCounts.get(event.type) ?? 0)) continue;
            legacyCounts.set(event.type, count);
          }
          for (const [index, cue] of cues.entries()) {
            if (cue.event !== event.type) continue;
            const last = cooldowns.get(index);
            if (
              !playable() ||
              event.tick < audibleFromTick ||
              (last !== undefined && event.tick - last < (cue.cooldownTicks ?? 0))
            ) {
              dropped++;
              continue;
            }
            play(cue.asset, cue.volume ?? 1, false);
            cooldowns.set(index, event.tick);
          }
        }
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      attempt++;
      buffers.clear();
      legacyCounts.clear();
      cooldowns.clear();
      const errors = stopAll();
      errors.push(...cleanup([() => master?.disconnect()]));
      if (context !== undefined) {
        context.onstatechange = null;
        if (context.state !== 'closed') {
          try {
            void context.close().catch(reportAsync);
          } catch (cause) {
            errors.push(cause);
          }
        }
      }
      master = undefined;
      context = undefined;
      status = 'unavailable';
      error = undefined;
      publish();
      if (errors.length !== 0) throw fail(new AggregateError(errors, 'Audio disposal failed'));
    },
  };
}

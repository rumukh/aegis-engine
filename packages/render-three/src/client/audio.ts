import type { EventLine } from '../protocol.js';
import { cleanupAudioActions, rampAudioGain, releaseAudioVoice } from '@aegis/browser/audio/nodes';
import { QUALITY } from '../presentation/schema.js';
import type {
  AudioCue,
  AudioSpec,
  CaptionSpec,
  QualityTier,
  SpatialAudioSpec,
  StateCondition,
  Vec3,
} from '../presentation/schema.js';
import { readDataPath } from '../presentation/state.js';

export interface AudioState {
  status: 'locked' | 'ready' | 'unavailable' | 'error';
  muted: boolean;
  voices: number;
  /** Suppressed cues and voices evicted by cue, group or quality limits, since the last reset. */
  dropped: number;
  error?: string;
}

export interface AudioOptions {
  spec?: AudioSpec;
  readBuffer(id: string): ArrayBuffer;
  quality?: QualityTier;
  onState?(state: AudioState): void;
  onCaption?(caption: CaptionSpec, tick: number): void;
  spatial?: {
    listener(): { position: Vec3; forward: Vec3; up: Vec3 };
    position?(entity: string): Vec3;
    matches?(condition: StateCondition): boolean;
  };
  contextFactory?(): AudioContext;
}

export interface AudioController {
  /** Call directly from a trusted gesture. No other method creates or resumes a context. */
  unlock(): Promise<void>;
  setMuted(muted: boolean): void;
  setPaused(paused: boolean): void;
  setQuality(quality: QualityTier): void;
  /** Synchronize listener, moving emitters and stateful layers before consuming frame events. */
  sync(): void;
  consume(events: readonly EventLine[], generation: number, tick: number): void;
  /** New layers await the next frame sync; only legacy ambience restarts immediately. */
  reset(generation?: number): void;
  state(): AudioState;
  dispose(): void;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain?: GainNode;
  panner?: PannerNode;
  spatial?: SpatialAudioSpec;
  cue?: number;
  voiceGroup?: string;
  layer?: number;
  ramp?: { from: number; to: number; start: number; end: number };
  stopAt?: number;
  ambient: boolean;
  started: boolean;
}

interface Clip {
  asset: string;
  volume?: number;
  spatial?: SpatialAudioSpec;
  fadeSeconds?: number;
}

function matchesCue(cue: AudioCue, event: EventLine): boolean {
  if (cue.when === undefined) return true;
  const value = readDataPath(event.data, cue.when.field);
  if (
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))
  )
    throw new Error(
      `Audio cue "${cue.event}" predicate "${cue.when.field}" must resolve to a finite scalar in event.data.`,
    );
  return value === cue.when.equals;
}

function writeVector(x: AudioParam, y: AudioParam, z: AudioParam, value: Vec3): void {
  if (value.length !== 3 || !value.every(Number.isFinite))
    throw new Error('Audio spatial coordinates must contain three finite numbers.');
  x.value = value[0];
  y.value = value[1];
  z.value = value[2];
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
  const layers = spec?.layers ?? [];
  const clips = [...cues, ...layers];
  const spatialClips = clips.filter((clip) => clip.spatial !== undefined);
  const spatialAssets = new Set(spatialClips.map((clip) => clip.asset));
  const assetIds = new Set(clips.flatMap((clip) => (clip.asset === undefined ? [] : [clip.asset])));
  if (spec?.ambient !== undefined) assetIds.add(spec.ambient.asset);
  const masterVolume = (spec?.volume ?? 1) * (spec?.headroom ?? 1);
  const hasEffects = cues.some((cue) => cue.asset !== undefined);
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
  let awaitingFrame = false;
  let status: AudioState['status'] = assetIds.size === 0 ? 'unavailable' : 'locked';
  let error: string | undefined;
  let dropped = 0;
  let generation = 0;
  let lastTick = -1;
  // A delayed packet must not turn an unlock/unmute into an audible history catch-up.
  let audibleFromTick = -1;
  let captionFromTick = -1;
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

  const cleanup = cleanupAudioActions;
  const release = (voice: Voice, stop = true): unknown[] => {
    voices.delete(voice);
    return releaseAudioVoice(voice, stop);
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

  const position = (spatial: SpatialAudioSpec): Vec3 => {
    if ('position' in spatial.target) return spatial.target.position;
    if (options.spatial?.position === undefined)
      throw new Error(
        `Audio spatial target "${spatial.target.entity}" requires a spatial.position callback.`,
      );
    return options.spatial.position(spatial.target.entity);
  };
  const move = (voice: Voice): void => {
    if (voice.panner === undefined || voice.spatial === undefined) return;
    writeVector(
      voice.panner.positionX,
      voice.panner.positionY,
      voice.panner.positionZ,
      position(voice.spatial),
    );
  };
  const ramp = (voice: Voice, volume: number, seconds: number): void => {
    if (context === undefined || voice.gain === undefined) return;
    const now = context.currentTime;
    voice.ramp = rampAudioGain(voice.gain.gain, voice.ramp, now, volume, seconds);
  };
  const evict = (): void => {
    const oldest = [...voices].find((voice) => !voice.ambient) ?? voices.values().next().value;
    if (oldest === undefined) return;
    dropped++;
    checkCleanup(release(oldest));
  };
  const loopLimit = (): number => QUALITY[quality].voices - (hasEffects ? 1 : 0);
  const boundLoops = (): void => {
    const loops = [...voices].filter((voice) => voice.ambient);
    while (loops.length > loopLimit()) {
      const voice = loops.pop()!;
      dropped++;
      checkCleanup(release(voice));
    }
  };
  const play = (
    clip: Clip,
    ambient: boolean,
    identity?: { cue?: number; layer?: number; voiceGroup?: string },
  ): void => {
    if (!playable() || context === undefined || master === undefined) return;
    const { asset, spatial } = clip;
    const buffer = buffers.get(asset);
    if (buffer === undefined) throw new Error(`Audio asset "${asset}" is not decoded.`);
    // Loops never evict effects, and leave an effect slot even at the lowest quality.
    if (
      ambient &&
      (voices.size >= QUALITY[quality].voices ||
        [...voices].filter((voice) => voice.ambient).length >= loopLimit())
    )
      return;
    if (identity?.voiceGroup !== undefined) {
      for (const voice of voices) {
        if (voice.voiceGroup !== identity.voiceGroup) continue;
        dropped++;
        checkCleanup(release(voice));
      }
    }
    while (voices.size >= QUALITY[quality].voices) evict();
    const voice: Voice = {
      source: context.createBufferSource(),
      ambient,
      started: false,
      ...identity,
      ...(spatial === undefined ? {} : { spatial }),
    };
    voices.add(voice);
    try {
      voice.gain = context.createGain();
      const fade = ambient
        ? (clip.fadeSeconds ?? 0)
        : Math.min(clip.fadeSeconds ?? 0, buffer.duration / 2);
      voice.gain.gain.value = fade > 0 ? 0 : (clip.volume ?? 1);
      if (fade > 0) ramp(voice, clip.volume ?? 1, fade);
      voice.source.buffer = buffer;
      voice.source.loop = ambient;
      voice.source.connect(voice.gain);
      if (spatial === undefined) voice.gain.connect(master);
      else {
        voice.panner = context.createPanner();
        voice.panner.panningModel = 'HRTF';
        voice.panner.distanceModel = 'inverse';
        voice.panner.refDistance = spatial.refDistance ?? 1.5;
        voice.panner.maxDistance = spatial.maxDistance ?? 22;
        voice.panner.rolloffFactor = spatial.rolloffFactor ?? 1;
        move(voice);
        voice.gain.connect(voice.panner);
        voice.panner.connect(master);
      }
      voice.source.onended = () => {
        if (!voices.has(voice)) return;
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
    if (!playable()) return;
    if (
      spec?.ambient !== undefined &&
      ![...voices].some((voice) => voice.ambient && voice.layer === undefined)
    )
      play(spec.ambient, true);
    if (awaitingFrame) return;
    for (const [index, layer] of layers.entries()) {
      let voice = [...voices].find((candidate) => candidate.layer === index);
      const enabled =
        layer.enabledWhen === undefined || options.spatial!.matches!(layer.enabledWhen);
      if (enabled) {
        if (voice?.stopAt !== undefined) {
          // A scheduled source.stop cannot be cancelled; replace a re-enabled fading layer.
          checkCleanup(release(voice));
          voice = undefined;
        }
        if (voice === undefined) play(layer, true, { layer: index });
      } else if (voice !== undefined && voice.stopAt === undefined) {
        const fade = layer.fadeSeconds ?? 0;
        if (fade === 0) checkCleanup(release(voice));
        else {
          ramp(voice, 0, fade);
          voice.stopAt = context!.currentTime + fade;
          voice.source.stop(voice.stopAt);
        }
      }
    }
  };
  const sync = (): void => {
    for (const clip of spatialClips) {
      if (
        clip.spatial !== undefined &&
        'entity' in clip.spatial.target &&
        options.spatial?.position === undefined
      )
        throw new Error(
          `Audio spatial target "${clip.spatial.target.entity}" requires a spatial.position callback.`,
        );
    }
    if (
      layers.some((layer) => layer.enabledWhen !== undefined) &&
      options.spatial?.matches === undefined
    )
      throw new Error('Conditional audio layers require a spatial.matches callback.');
    if (!playable() || context === undefined) return;
    if (awaitingFrame) {
      ambient();
      return;
    }
    if (spatialClips.length !== 0 && options.spatial !== undefined) {
      const at = options.spatial.listener();
      const listener = context.listener;
      writeVector(listener.positionX, listener.positionY, listener.positionZ, at.position);
      writeVector(listener.forwardX, listener.forwardY, listener.forwardZ, at.forward);
      writeVector(listener.upX, listener.upY, listener.upZ, at.up);
    }
    for (const voice of voices) {
      if (voice.stopAt !== undefined && voice.stopAt <= context.currentTime)
        checkCleanup(release(voice));
      else move(voice);
    }
    ambient();
  };
  const reset = (nextGeneration = generation + 1): void => {
    guard(() => {
      generation = nextGeneration;
      lastTick = audibleFromTick = captionFromTick = lastSequence = legacyTick = -1;
      legacyCounts.clear();
      cooldowns.clear();
      dropped = 0;
      awaitingFrame = true;
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
            output.gain.value = muted ? 0 : masterVolume;
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
            if (spatialAssets.has(id) && decoded.numberOfChannels !== 1)
              throw new Error(
                `Spatial audio must be mono; decoded ${decoded.numberOfChannels} channels.`,
              );
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
        if (status !== 'ready') {
          audibleFromTick = lastTick;
          captionFromTick = Math.max(captionFromTick, lastTick);
        }
        status = 'ready';
        error = undefined;
        sync();
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
    sync: () =>
      guard(() => {
        awaitingFrame = false;
        sync();
      }),
    setMuted(value): void {
      guard(() => {
        if (muted === value) return;
        muted = value;
        if (master !== undefined) master.gain.value = muted ? 0 : masterVolume;
        if (muted) checkCleanup(stopAll());
        else {
          audibleFromTick = lastTick;
          captionFromTick = Math.max(captionFromTick, lastTick);
          sync();
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
          captionFromTick = Math.max(captionFromTick, lastTick);
          sync();
        }
      });
    },
    setQuality(value): void {
      guard(() => {
        quality = value;
        boundLoops();
        while (voices.size > QUALITY[quality].voices) evict();
      });
    },
    consume(events, nextGeneration, tick): void {
      if (disposed || nextGeneration < generation) return;
      if (nextGeneration !== generation) reset(nextGeneration);
      if (tick < lastTick) return;
      if (tick > lastTick) captionFromTick = Math.max(captionFromTick, lastTick);
      lastTick = tick;
      guard(() => {
        const previousSequence = lastSequence;
        const batchSequences = new Set<number>();
        const batchCounts = new Map<string, number>();
        for (const event of [...events].sort((a, b) => a.tick - b.tick)) {
          if (disposed || generation !== nextGeneration) return;
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
            if (cue.event !== event.type || !matchesCue(cue, event)) continue;
            const last = cooldowns.get(index);
            if (last !== undefined && event.tick - last < (cue.cooldownTicks ?? 0)) {
              dropped++;
              continue;
            }
            if (cue.caption !== undefined && event.tick >= captionFromTick) {
              cooldowns.set(index, event.tick);
              options.onCaption?.(cue.caption, event.tick);
              if (disposed || generation !== nextGeneration) return;
            }
            if (cue.asset === undefined) continue;
            if (!playable() || event.tick < audibleFromTick) {
              dropped++;
              continue;
            }
            // Legacy manifests retain the global limit. New cue features default to four
            // simultaneous instances; an authored maxVoices always takes precedence.
            const modern =
              cue.when !== undefined ||
              cue.caption !== undefined ||
              cue.spatial !== undefined ||
              cue.voiceGroup !== undefined ||
              cue.fadeSeconds !== undefined;
            const limit = cue.maxVoices ?? (modern ? 4 : QUALITY[quality].voices);
            const instances = [...voices].filter((voice) => voice.cue === index);
            while (instances.length >= limit) {
              dropped++;
              checkCleanup(release(instances.shift()!));
            }
            play({ ...cue, asset: cue.asset }, false, {
              cue: index,
              ...(cue.voiceGroup === undefined ? {} : { voiceGroup: cue.voiceGroup }),
            });
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

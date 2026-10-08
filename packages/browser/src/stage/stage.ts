import { BrowserServiceError } from '../errors.js';
import { localAssetUrl } from '../io.js';
import { logicalPoint } from '../ui/coordinates.js';
import type { LogicalSize, Point } from '../ui/coordinates.js';
import type { NarrationController } from '../audio/narration.js';
import { CutscenePlayer } from '../animation/cutscene.js';
import type {
  CutsceneEvent,
  CutsceneHost,
  LineHandle,
  LineOutcome,
} from '../animation/cutscene.js';
import { ease } from '../animation/easing.js';
import { sampleCues } from '../animation/mouth.js';
import { PuppetModel } from '../animation/puppet.js';
import type { Behaviours, DrawItem, PlayOptions } from '../animation/puppet.js';
import { createPresentationRandom } from '../animation/random.js';
import { compose, multiply } from '../animation/sample.js';
import type { Matrix } from '../animation/sample.js';
import type {
  AnimationDiagnostic,
  AtlasFile,
  AvatarComposition,
  CameraTarget,
  ClipFile,
  CueTrackFile,
  CutsceneFile,
  Easing,
  MouthShape,
  Placement,
  RigFile,
  Vec2,
} from '../animation/types.js';
import { parseFrameRef, validateBundle, validateCueTrack } from '../animation/validate.js';
import { Canvas2DRenderer } from './canvas.js';
import type { Grade, StageRenderer, StageTexture } from './renderer.js';
import { WebGlRenderer } from './webgl.js';

export type StageLayer = 'background' | 'midground' | 'characters' | 'foreground' | 'effects';
const LAYERS: readonly StageLayer[] = [
  'background',
  'midground',
  'characters',
  'foreground',
  'effects',
];

/** The narration surface the stage uses (a `createNarration` controller satisfies it). */
export type StageNarration = Pick<
  NarrationController,
  'clock' | 'subscribe' | 'playLine' | 'stop' | 'line' | 'setAtmosphere' | 'playEffect'
>;

export interface EffectDefinition {
  /** `atlas#frame` of the particle image (its atlas must be loaded). */
  frame: string;
  count?: number;
  /** Seconds each particle lives. */
  life?: number;
  /** Horizontal spread and rise in logical pixels. */
  spread?: number;
  rise?: number;
  scale?: number;
}
export interface ComfortTreatment {
  brightness?: number;
  warmth?: number;
}
export interface StageOptions {
  host: HTMLElement;
  /** Logical scene size; defaults to 2560x1600. */
  logical?: LogicalSize;
  /** Base URL for asset paths returned by `resolve`. */
  baseUrl: string;
  /** Maps an asset ID (offline-pack resource ID) to a same-origin path or URL. */
  resolve(assetId: string): string;
  fetch?: typeof fetch;
  /** Owned decoded image memory budget (width x height x 4 per image). Default 96 MiB. */
  memoryBudgetBytes?: number;
  renderer?: 'auto' | 'webgl' | 'canvas';
  cameraPresets?: Readonly<Record<string, CameraTarget>>;
  reducedMotion?: boolean | 'system';
  comfort?: ComfortTreatment & { enabled?: boolean };
  seed?: string;
  clearColor?: string;
  effects?: Readonly<Record<string, EffectDefinition>>;
  maxDevicePixelRatio?: number;
  narration?: StageNarration;
  /** Audio pack used for lines, music and effects in cutscenes. */
  audioPackId?: string;
  /** Start the animation-frame loop at once (default true). Tests may drive `renderFrame`. */
  autoStart?: boolean;
  /** Optional overrides for cutscene audio steps. */
  audio?: {
    music?(asset: string | null, fade: number): void;
    atmosphere?(asset: string | null, fade: number): void;
    sfx?(asset: string, gain: number): void;
  };
}

export interface LoadRequest {
  /** Asset IDs of JSON documents (atlases, rigs, clips) to fetch. */
  documents?: readonly string[];
  /** Already-parsed documents, e.g. bundled with the consumer. */
  values?: readonly unknown[];
  /** Plain images (backgrounds, props) by asset ID. */
  images?: readonly string[];
}
export interface LoadResult {
  ok: boolean;
  diagnostics: AnimationDiagnostic[];
}

export interface SpeechState {
  packId?: string;
  lineId?: string;
  mode: 'rest' | 'cues' | 'talk-loop' | 'unheard';
  /** True only while the mouth follows a validated cue track at the narration clock. */
  synchronized: boolean;
  shape: MouthShape;
}
export interface SpeakOptions {
  /** Start the line on the narration service as well (default true). */
  play?: boolean;
  /** When narration is blocked or failed: keep the mouth neutral (default) or a subtle loop. */
  unheard?: 'neutral' | 'subtle';
  /** Upper bound for the subtle loop, seconds (default 4). */
  maxSubtleSeconds?: number;
}

export interface StagePuppet {
  readonly id: string;
  readonly model: PuppetModel;
  play(clip: string, options?: Partial<PlayOptions>): number;
  behave(behaviours: Behaviours): void;
  setExpression(name: string | undefined): void;
  emote(name: string): number;
  hop(options?: { height?: number; duration?: number }): number;
  moveTo(
    target: Vec2 | readonly Vec2[],
    options?: { duration?: number; speed?: number; ease?: Easing; walk?: boolean },
  ): number;
  face(direction: 'left' | 'right'): void;
  setPosition(point: Vec2): void;
  setVisible(visible: boolean): void;
  /** Bind lip-sync to a narration line; with `play` (default) also starts the line. */
  speak(line: { packId: string; lineId: string }, options?: SpeakOptions): Promise<void>;
  silence(): void;
  speech(): SpeechState;
  remove(): void;
}
export interface PuppetSpec extends AvatarComposition {
  id?: string;
  at?: Vec2;
  scale?: number;
  facing?: 'left' | 'right';
  layer?: StageLayer;
  /** Private visuals are hidden during handoff/private projections. */
  private?: boolean;
  seed?: string;
  behaviours?: Behaviours;
}
export interface SpriteSpec {
  id?: string;
  layer: Exclude<StageLayer, 'characters'>;
  /** An image asset ID, or an `atlas#frame` reference. */
  image: string;
  at: Vec2;
  scale?: number;
  opacity?: number;
  private?: boolean;
}
export interface CutsceneController {
  readonly player: CutscenePlayer;
  play(options?: { from?: string }): void;
  next(): boolean;
  skip(): void;
  replay(): void;
  pause(reason: string): void;
  resume(reason: string): void;
  status(): ReturnType<CutscenePlayer['status']>;
  dispose(): void;
}
export interface StageStats {
  renderer: 'webgl' | 'canvas';
  frames: number;
  drawCalls: number;
  quads: number;
  /** Mean JS time of the last 60 rendered frames, ms. */
  frameMs: number;
  ownedBytes: number;
  textures: number;
  puppets: number;
  listeners: number;
  time: number;
  paused: boolean;
}

interface LoadedImage {
  id: string;
  url: string;
  texture: StageTexture;
  refs: number;
}
interface Speech {
  packId: string;
  lineId: string;
  cues?: CueTrackFile;
  cueState: 'loading' | 'ready' | 'missing' | 'invalid';
  options: SpeakOptions;
  seen: boolean;
  unheardAt?: number;
  mode: SpeechState['mode'];
  shape: MouthShape;
}
interface PuppetEntry {
  id: string;
  model: PuppetModel;
  layer: StageLayer;
  visible: boolean;
  private: boolean;
  fade?: { from: number; to: number; start: number; duration: number; hideAfter: boolean };
  speech?: Speech;
  cutscene?: boolean;
}
interface SpriteEntry {
  id: string;
  spec: SpriteSpec;
  cutscene?: boolean;
}
interface Particle {
  frame: string;
  start: number;
  life: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  scale: number;
}
interface Tween<T> {
  from: T;
  to: T;
  start: number;
  duration: number;
  ease?: Easing;
}

const DEFAULT_LOGICAL: LogicalSize = { width: 2560, height: 1600 };
const TALK_LOOP: readonly MouthShape[] = ['B', 'C', 'D', 'C', 'B', 'A', 'E', 'B', 'D', 'A'];
const SUBTLE_LOOP: readonly MouthShape[] = ['B', 'A', 'B', 'X'];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Browser 2D stage (ANIM-01). It draws inside `host` on one canvas; accessible DOM controls stay
 * outside the drawing surface. Presentation time is its own clock and never touches runtime state.
 */
export function createStage(options: StageOptions) {
  const host = options.host;
  const document = host.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new BrowserServiceError('unavailable', 'The stage host is not in a window.');
  const logical = options.logical ?? DEFAULT_LOGICAL;
  if (!(logical.width > 0 && logical.height > 0))
    throw new BrowserServiceError('invalid-data', 'Stage logical size must be positive.');
  const budget = options.memoryBudgetBytes ?? 96 * 1024 * 1024;
  const clearColor = options.clearColor ?? '#101418';
  const presets: Record<string, CameraTarget> = {
    wide: { x: logical.width / 2, y: logical.height / 2, zoom: 1 },
    ...(options.cameraPresets ?? {}),
  };
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset['aegisStage'] = 'true';
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
  if (view.getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.prepend(canvas);
  let renderer: StageRenderer;
  const choice = options.renderer ?? 'auto';
  try {
    renderer = choice === 'canvas' ? new Canvas2DRenderer(canvas) : new WebGlRenderer(canvas);
  } catch (cause) {
    if (choice === 'webgl') {
      canvas.remove();
      throw cause;
    }
    renderer = new Canvas2DRenderer(canvas);
  }

  // ---------------------------------------------------------------- state
  const atlases = new Map<string, AtlasFile>();
  const rigs = new Map<string, RigFile>();
  const clips = new Map<string, ClipFile>();
  const images = new Map<string, LoadedImage>();
  const atlasImage = new Map<string, string>();
  const cueCache = new Map<string, Promise<CueTrackFile | undefined>>();
  const puppets = new Map<string, PuppetEntry>();
  const sprites = new Map<string, SpriteEntry>();
  const particles: Particle[] = [];
  const cutscenes = new Set<CutsceneController>();
  const listeners: (() => void)[] = [];
  const pauseReasons = new Set<string>();
  let now = 0;
  let frame = 0;
  let last: number | undefined;
  let disposed = false;
  let running = false;
  let lastStats = { drawCalls: 0, quads: 0 };
  const frameTimes: number[] = [];
  let serial = 0;
  let comfort = options.comfort?.enabled ?? false;
  let privacy = false;
  let systemReduced = false;
  let reducedSetting = options.reducedMotion ?? 'system';
  const random = createPresentationRandom(`stage:${options.seed ?? 'aegis'}`);
  let background: { current?: string; previous?: string; fade?: Tween<number> } = {};
  let camera: CameraTarget = { ...presets['wide']! };
  let cameraTween: Tween<CameraTarget> | undefined;
  let overlay: { color: string; tween: Tween<number>; shape: 'dip' | 'hold' } | undefined;

  const reduced = (): boolean => (reducedSetting === 'system' ? systemReduced : reducedSetting);
  const alive = (): void => {
    if (disposed) throw new BrowserServiceError('disposed', 'The stage is disposed.');
  };
  const listen = (target: EventTarget, type: string, handler: EventListener): void => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };
  const media = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (media) {
    systemReduced = media.matches;
    listen(media, 'change', () => {
      systemReduced = media.matches;
      applyReduced();
    });
  }
  const applyReduced = (): void => {
    for (const entry of puppets.values()) entry.model.reducedMotion = reduced();
  };

  // ---------------------------------------------------------------- assets
  const url = (assetId: string): string =>
    localAssetUrl(options.resolve(assetId), options.baseUrl).href;
  const fetchJson = async (assetId: string): Promise<unknown> => {
    const response = await (options.fetch ?? globalThis.fetch)(url(assetId), {
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok) throw new BrowserServiceError('asset', `Asset "${assetId}" is unavailable.`);
    return (await response.json()) as unknown;
  };
  const ownedBytes = (): number => {
    let total = 0;
    for (const image of images.values()) total += image.texture.bytes;
    if (renderer instanceof Canvas2DRenderer) total += renderer.cacheBytes();
    return total;
  };
  /**
   * Images load through `<img>` from their same-origin URL (served from the offline cache when
   * installed), so a strict `img-src 'self'` CSP needs no `blob:` exception.
   */
  const decode = async (assetId: string): Promise<HTMLImageElement> => {
    const image = new Image();
    image.decoding = 'async';
    image.src = url(assetId);
    try {
      await image.decode();
    } catch (cause) {
      throw new BrowserServiceError('asset', `Image "${assetId}" is unavailable or undecodable.`, {
        cause,
      });
    }
    return image;
  };
  const loadImage = async (
    assetId: string,
    expected?: { width: number; height: number },
  ): Promise<AnimationDiagnostic | undefined> => {
    const existing = images.get(assetId);
    if (existing) {
      existing.refs++;
      return undefined;
    }
    if (expected && ownedBytes() + expected.width * expected.height * 4 > budget)
      return {
        code: 'AEG-ANIM-0023',
        severity: 'error',
        message: `Loading "${assetId}" (${String(expected.width)}x${String(expected.height)}) would exceed the ${String(budget)} byte image budget.`,
        path: '$',
        source: assetId,
      };
    const image = await decode(assetId);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (expected && (width !== expected.width || height !== expected.height))
      return {
        code: 'AEG-ANIM-0022',
        severity: 'error',
        message: `Image "${assetId}" decodes to ${String(width)}x${String(height)}, not the declared ${String(expected.width)}x${String(expected.height)}.`,
        path: '$',
        source: assetId,
      };
    if (width > 4096 || height > 4096)
      return {
        code: 'AEG-ANIM-0020',
        severity: 'error',
        message: `Image "${assetId}" exceeds 4096 px.`,
        path: '$',
        source: assetId,
      };
    if (ownedBytes() + width * height * 4 > budget)
      return {
        code: 'AEG-ANIM-0023',
        severity: 'error',
        message: `Image "${assetId}" would exceed the ${String(budget)} byte image budget.`,
        path: '$',
        source: assetId,
      };
    alive();
    const texture = renderer.createTexture(image);
    if (renderer.kind === 'webgl') image.src = '';
    images.set(assetId, { id: assetId, url: url(assetId), texture, refs: 1 });
    return undefined;
  };
  const releaseImage = (assetId: string, force = false): void => {
    const image = images.get(assetId);
    if (!image) return;
    image.refs--;
    if (image.refs > 0 && !force) return;
    renderer.deleteTexture(image.texture);
    images.delete(assetId);
  };

  const frameSource = (
    ref: string,
  ):
    | {
        texture: StageTexture;
        sx: number;
        sy: number;
        sw: number;
        sh: number;
        ox: number;
        oy: number;
      }
    | undefined => {
    const parsed = parseFrameRef(ref);
    if (!parsed) {
      const image = images.get(ref);
      return image
        ? {
            texture: image.texture,
            sx: 0,
            sy: 0,
            sw: image.texture.width,
            sh: image.texture.height,
            ox: 0,
            oy: 0,
          }
        : undefined;
    }
    const atlas = atlases.get(parsed.atlas);
    const frame = atlas?.frames[parsed.frame];
    const imageId = atlasImage.get(parsed.atlas);
    const image = imageId ? images.get(imageId) : undefined;
    if (!atlas || !frame || !image) return undefined;
    return {
      texture: image.texture,
      sx: frame.x,
      sy: frame.y,
      sw: frame.w,
      sh: frame.h,
      ox: frame.offset?.x ?? 0,
      oy: frame.offset?.y ?? 0,
    };
  };

  // ---------------------------------------------------------------- camera and layout
  const clampCamera = (target: CameraTarget): CameraTarget => {
    const zoom = Math.max(1, Math.min(8, target.zoom));
    const hw = logical.width / (2 * zoom);
    const hh = logical.height / (2 * zoom);
    return {
      x: Math.min(logical.width - hw, Math.max(hw, target.x)),
      y: Math.min(logical.height - hh, Math.max(hh, target.y)),
      zoom,
    };
  };
  const cameraAt = (time: number): CameraTarget => {
    if (!cameraTween) return camera;
    const u = cameraTween.duration > 0 ? (time - cameraTween.start) / cameraTween.duration : 1;
    if (u >= 1) {
      camera = cameraTween.to;
      cameraTween = undefined;
      return camera;
    }
    const k = ease(cameraTween.ease ?? 'easeInOutSine', Math.max(0, u));
    return {
      x: lerp(cameraTween.from.x, cameraTween.to.x, k),
      y: lerp(cameraTween.from.y, cameraTween.to.y, k),
      zoom: lerp(cameraTween.from.zoom, cameraTween.to.zoom, k),
    };
  };
  const layout = (): {
    width: number;
    height: number;
    scale: number;
    ox: number;
    oy: number;
    dpr: number;
  } => {
    const dpr = Math.min(options.maxDevicePixelRatio ?? 2, view.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    const scale = Math.min(width / logical.width, height / logical.height);
    return {
      width,
      height,
      scale,
      ox: (width - logical.width * scale) / 2,
      oy: (height - logical.height * scale) / 2,
      dpr,
    };
  };
  /** Scene coordinates to device pixels for the current camera. */
  const viewMatrix = (box: ReturnType<typeof layout>, cam: CameraTarget): Matrix =>
    multiply(
      [box.scale, 0, 0, box.scale, box.ox, box.oy],
      multiply(compose(logical.width / 2, logical.height / 2, 0, cam.zoom, cam.zoom), [
        1,
        0,
        0,
        1,
        -cam.x,
        -cam.y,
      ]),
    );

  // ---------------------------------------------------------------- speech
  const loadCues = (packId: string, lineId: string): Promise<CueTrackFile | undefined> => {
    const key = `${packId}\u0000${lineId}`;
    const cached = cueCache.get(key);
    if (cached) return cached;
    const line = options.narration?.line(packId, lineId);
    const pending = !line?.cues
      ? Promise.resolve(undefined)
      : fetchJson(line.cues).then(
          (value) => {
            const result = validateCueTrack(value, { source: line.cues! });
            if (!result.value)
              throw new BrowserServiceError(
                'invalid-data',
                `Cue track "${line.cues!}" is invalid.`,
              );
            return result.value;
          },
          (cause: unknown) => {
            cueCache.delete(key);
            throw cause;
          },
        );
    cueCache.set(key, pending);
    return pending;
  };
  const updateSpeech = (entry: PuppetEntry): void => {
    const speech = entry.speech;
    if (!speech) return;
    const clock = options.narration?.clock();
    const ours = clock && clock.packId === speech.packId && clock.lineId === speech.lineId;
    if (clock && !ours && speech.seen) {
      entry.speech = undefined;
      entry.model.setMouth(undefined);
      return;
    }
    let shape: MouthShape = 'X';
    let mode: SpeechState['mode'] = 'rest';
    if (!clock || !ours) {
      // Nothing is (or will be) heard for this binding: treat as unheard.
      if (!clock) {
        speech.unheardAt ??= now;
        mode = 'unheard';
      }
    } else {
      speech.seen = true;
      if (clock.status === 'playing' || clock.status === 'paused') {
        if (speech.cueState === 'ready' && speech.cues) {
          shape = sampleCues(speech.cues, clock.position).s;
          mode = 'cues';
        } else if (speech.cueState !== 'loading' || clock.status === 'playing') {
          const index = Math.floor(clock.position / 0.09) % TALK_LOOP.length;
          shape =
            clock.duration !== undefined && clock.position >= clock.duration
              ? 'X'
              : TALK_LOOP[index]!;
          mode = 'talk-loop';
        }
        speech.unheardAt = undefined;
      } else if (clock.status === 'blocked' || clock.status === 'failed') {
        speech.unheardAt ??= now;
        mode = 'unheard';
      } else if (clock.status === 'completed' || clock.status === 'idle') {
        entry.speech = undefined;
        entry.model.setMouth(undefined);
        return;
      }
    }
    if (mode === 'unheard' && speech.options.unheard === 'subtle') {
      const elapsed = now - (speech.unheardAt ?? now);
      if (elapsed < (speech.options.maxSubtleSeconds ?? 4))
        shape = SUBTLE_LOOP[Math.floor(elapsed / 0.16) % SUBTLE_LOOP.length]!;
    }
    speech.mode = mode;
    speech.shape = shape;
    entry.model.setMouth(shape === 'X' ? undefined : shape);
  };

  // ---------------------------------------------------------------- puppets
  const createPuppet = (spec: PuppetSpec, cutscene = false): StagePuppet => {
    alive();
    const id = spec.id ?? `puppet-${String(++serial)}`;
    if (puppets.has(id)) throw new BrowserServiceError('conflict', `Puppet "${id}" exists.`);
    const scales = new Map<string, number>();
    for (const atlas of atlases.values()) scales.set(atlas.id, atlas.scale ?? 1);
    const model = new PuppetModel({
      rigs,
      clips,
      composition: spec,
      atlasScales: scales,
      ...(spec.at ? { at: spec.at } : {}),
      ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
      ...(spec.facing ? { facing: spec.facing } : {}),
      seed: spec.seed ?? `${options.seed ?? 'aegis'}:${id}`,
      reducedMotion: reduced(),
    });
    const missing = model.frames().filter((ref) => !frameSource(ref));
    if (missing.length)
      throw new BrowserServiceError(
        'asset',
        `Load the atlases first; missing frames: ${missing.slice(0, 5).join(', ')}.`,
      );
    if (spec.behaviours) model.behave(spec.behaviours);
    const entry: PuppetEntry = {
      id,
      model,
      layer: spec.layer ?? 'characters',
      visible: true,
      private: spec.private ?? false,
      ...(cutscene ? { cutscene } : {}),
    };
    puppets.set(id, entry);
    return handle(entry);
  };
  const handle = (entry: PuppetEntry): StagePuppet => ({
    id: entry.id,
    model: entry.model,
    play: (clip, play = {}) => {
      entry.model.play(clip, { at: now, ...play });
      return entry.model.clipDuration(clip);
    },
    behave: (behaviours) => entry.model.behave(behaviours),
    setExpression: (name) => entry.model.setExpression(name),
    emote: (name) => emote(entry, name),
    hop: (hop = {}) => entry.model.hop(now, hop),
    moveTo: (target, move = {}) =>
      entry.model.move(Array.isArray(target) ? target : [target as Vec2], now, move),
    face: (direction) => {
      entry.model.facing = direction;
    },
    setPosition: (point) => entry.model.setPosition(point),
    setVisible: (visible) => {
      entry.visible = visible;
      entry.fade = undefined;
    },
    speak: async (line, speak = {}) => {
      alive();
      entry.speech = {
        packId: line.packId,
        lineId: line.lineId,
        cueState: 'loading',
        options: speak,
        seen: false,
        mode: 'rest',
        shape: 'X',
      };
      const speech = entry.speech;
      void loadCues(line.packId, line.lineId).then(
        (cues) => {
          if (cues) {
            speech.cues = cues;
            speech.cueState = 'ready';
          } else speech.cueState = 'missing';
        },
        () => {
          speech.cueState = 'invalid';
        },
      );
      if (speak.play !== false && options.narration)
        await options.narration.playLine(line.packId, line.lineId);
    },
    silence: () => {
      entry.speech = undefined;
      entry.model.setMouth(undefined);
    },
    speech: () => ({
      ...(entry.speech ? { packId: entry.speech.packId, lineId: entry.speech.lineId } : {}),
      mode: entry.speech?.mode ?? 'rest',
      synchronized: entry.speech?.mode === 'cues',
      shape: entry.speech?.shape ?? 'X',
    }),
    remove: () => {
      puppets.delete(entry.id);
    },
  });
  const emote = (entry: PuppetEntry, name: string): number => {
    const definition = entry.model.base.emotes?.[name];
    if (!definition)
      throw new BrowserServiceError(
        'asset',
        `Rig "${entry.model.base.id}" has no emote "${name}".`,
      );
    if (definition.expression) entry.model.setExpression(definition.expression);
    let duration = 0.5;
    if (definition.clip && entry.model.hasClip(definition.clip)) {
      entry.model.play(definition.clip, { at: now, layer: 'emote' });
      duration = entry.model.clipDuration(definition.clip);
    }
    if (definition.effect && options.effects?.[definition.effect]) {
      const at = entry.model.positionAt(now);
      spawnEffect(
        definition.effect,
        { x: at.x, y: at.y - (entry.model.base.bounds?.height ?? 600) },
        1,
      );
    }
    return duration;
  };

  // ---------------------------------------------------------------- effects
  const spawnEffect = (name: string, at: Vec2, duration: number): number => {
    const definition = options.effects?.[name];
    if (!definition) throw new BrowserServiceError('asset', `Unknown effect "${name}".`);
    const calm = reduced();
    const count = Math.max(1, Math.round((definition.count ?? 16) * (calm ? 0.5 : 1)));
    const life = definition.life ?? 1.2;
    for (let i = 0; i < count && particles.length < 2000; i++)
      particles.push({
        frame: definition.frame,
        start: now + random.range(0, Math.max(0, duration - life)),
        life,
        x: at.x + random.range(-1, 1) * (definition.spread ?? 120),
        y: at.y + random.range(-0.3, 0.3) * (definition.spread ?? 120),
        dx: calm ? 0 : random.range(-30, 30),
        dy: calm ? 0 : -(definition.rise ?? 80) * random.range(0.5, 1),
        scale: (definition.scale ?? 1) * random.range(0.6, 1.1),
      });
    return duration;
  };

  // ---------------------------------------------------------------- rendering
  const grade = (): Grade => ({
    brightness: comfort ? (options.comfort?.brightness ?? 1.12) : 1,
    warmth: comfort ? (options.comfort?.warmth ?? 0.6) : 0,
  });
  const drawRef = (
    ref: string,
    matrix: Matrix,
    opacity: number,
    tint?: string,
    mask?: string,
  ): void => {
    const source = frameSource(ref);
    if (!source) return;
    const local: Matrix =
      source.ox || source.oy ? multiply(matrix, [1, 0, 0, 1, source.ox, source.oy]) : matrix;
    const maskSource = mask ? frameSource(mask) : undefined;
    renderer.draw({
      texture: source.texture,
      sx: source.sx,
      sy: source.sy,
      sw: source.sw,
      sh: source.sh,
      matrix: local,
      opacity,
      ...(tint ? { tint } : {}),
      ...(maskSource
        ? { mask: { texture: maskSource.texture, sx: maskSource.sx, sy: maskSource.sy } }
        : {}),
    });
  };
  const render = (): void => {
    const box = layout();
    renderer.resize(box.width, box.height);
    const cam = cameraAt(now);
    const viewM = viewMatrix(box, cam);
    renderer.begin(clearColor, grade());
    // Background with crossfade.
    const bgFade = background.fade;
    const k = bgFade ? Math.min(1, Math.max(0, (now - bgFade.start) / (bgFade.duration || 1))) : 1;
    if (bgFade && k >= 1) {
      background.fade = undefined;
      background.previous = undefined;
    }
    if (background.previous && k < 1) drawRef(background.previous, viewM, 1);
    if (background.current) drawRef(background.current, viewM, background.previous ? k : 1);
    const spriteLayer = (layer: StageLayer): void => {
      for (const { spec } of sprites.values()) {
        if (spec.layer !== layer || (privacy && spec.private)) continue;
        const source = frameSource(spec.image);
        if (!source) continue;
        const s = spec.scale ?? 1;
        drawRef(
          spec.image,
          multiply(viewM, [s, 0, 0, s, spec.at.x - (source.sw * s) / 2, spec.at.y - source.sh * s]),
          spec.opacity ?? 1,
        );
      }
    };
    spriteLayer('midground');
    const items: { y: number; draws: DrawItem[]; opacity: number }[] = [];
    for (const entry of puppets.values()) {
      if (privacy && entry.private) continue;
      updateSpeech(entry);
      let opacity = entry.visible ? 1 : 0;
      if (entry.fade) {
        const u = Math.min(1, Math.max(0, (now - entry.fade.start) / (entry.fade.duration || 1)));
        opacity = lerp(entry.fade.from, entry.fade.to, u);
        if (u >= 1) {
          entry.visible = entry.fade.to > 0 && !entry.fade.hideAfter;
          entry.fade = undefined;
        }
      }
      if (opacity <= 0) continue;
      items.push({ y: entry.model.positionAt(now).y, draws: entry.model.pose(now), opacity });
    }
    items.sort((a, b) => a.y - b.y);
    for (const item of items)
      for (const draw of item.draws)
        drawRef(
          draw.frame,
          multiply(viewM, draw.matrix),
          draw.opacity * item.opacity,
          draw.tint,
          draw.mask,
        );
    spriteLayer('foreground');
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      const u = (now - p.start) / p.life;
      if (u >= 1) {
        particles.splice(i, 1);
        continue;
      }
      if (u < 0) continue;
      const source = frameSource(p.frame);
      if (!source) continue;
      // Gentle fade in/out: no flashing.
      const alpha = Math.min(1, u * 4, (1 - u) * 3);
      const x = p.x + p.dx * u;
      const y = p.y + p.dy * u;
      drawRef(
        p.frame,
        multiply(viewM, [
          p.scale,
          0,
          0,
          p.scale,
          x - (source.sw * p.scale) / 2,
          y - (source.sh * p.scale) / 2,
        ]),
        alpha,
      );
    }
    spriteLayer('effects');
    if (overlay) {
      const t = overlay.tween;
      const u = Math.min(1, Math.max(0, (now - t.start) / (t.duration || 1)));
      const alpha =
        overlay.shape === 'dip'
          ? lerp(t.from, t.to, 1 - Math.abs(2 * u - 1))
          : lerp(t.from, t.to, u);
      renderer.fill(0, 0, box.width, box.height, overlay.color, alpha);
      if (u >= 1 && overlay.shape === 'dip') overlay = undefined;
    }
    // Letterbox bars keep the logical frame exact (matches `logicalPoint`).
    if (box.ox > 0.5) {
      renderer.fill(0, 0, box.ox, box.height, clearColor, 1);
      renderer.fill(box.width - box.ox, 0, box.ox, box.height, clearColor, 1);
    }
    if (box.oy > 0.5) {
      renderer.fill(0, 0, box.width, box.oy, clearColor, 1);
      renderer.fill(0, box.height - box.oy, box.width, box.oy, clearColor, 1);
    }
    lastStats = renderer.end();
  };
  const renderFrame = (): void => {
    if (disposed) return;
    const start = view.performance.now();
    for (const controller of cutscenes) controller.player.update(now);
    render();
    frame++;
    frameTimes.push(view.performance.now() - start);
    if (frameTimes.length > 60) frameTimes.shift();
  };
  let request: number | undefined;
  const loop = (timestamp: number): void => {
    request = undefined;
    if (disposed || !running) return;
    if (last !== undefined && !pauseReasons.size)
      now += Math.min(0.1, Math.max(0, (timestamp - last) / 1000));
    last = timestamp;
    renderFrame();
    request = view.requestAnimationFrame(loop);
  };
  const start = (): void => {
    if (running || disposed) return;
    running = true;
    last = undefined;
    if (!document.hidden) request = view.requestAnimationFrame(loop);
  };
  const stop = (): void => {
    running = false;
    if (request !== undefined) view.cancelAnimationFrame(request);
    request = undefined;
  };
  // Hidden documents do no animation-frame work.
  listen(document, 'visibilitychange', () => {
    if (document.hidden) {
      if (request !== undefined) view.cancelAnimationFrame(request);
      request = undefined;
    } else if (running && request === undefined) {
      last = undefined;
      request = view.requestAnimationFrame(loop);
    }
  });

  // ---------------------------------------------------------------- cutscene host
  const placement = (value: Placement, y: number, entry: PuppetEntry): Vec2 => {
    if (typeof value !== 'string') return value;
    const width = entry.model.base.bounds?.width ?? 400;
    return { x: value === 'left' ? -width : logical.width + width, y };
  };
  const createHost = (
    cutscene: CutsceneFile,
    config: { avatar?: AvatarComposition; packId?: string },
  ): CutsceneHost => {
    const actor = (name: string): PuppetEntry => {
      const id = `${cutscene.id}:${name}`;
      const existing = puppets.get(id);
      if (existing) return existing;
      const cast = cutscene.cast[name];
      if (!cast) throw new BrowserServiceError('invalid-data', `Unknown cast member "${name}".`);
      const composition: AvatarComposition | undefined =
        cast.role === 'avatar'
          ? config.avatar
          : {
              rig: cast.rig!,
              ...(cast.accessories ? { accessories: cast.accessories } : {}),
              ...(cast.tints ? { tints: cast.tints } : {}),
            };
      if (!composition)
        throw new BrowserServiceError('invalid-data', 'Bind the player avatar before playing.');
      createPuppet(
        {
          ...composition,
          id,
          at: { x: logical.width / 2, y: logical.height * 0.875 },
          behaviours: { breathe: {}, blink: {} },
        },
        true,
      );
      const entry = puppets.get(id)!;
      entry.visible = false;
      return entry;
    };
    const packId = config.packId ?? options.audioPackId;
    let activeLine: { packId: string; lineId: string } | undefined;
    return {
      reset() {
        for (const [id, entry] of puppets)
          if (entry.cutscene && id.startsWith(`${cutscene.id}:`)) puppets.delete(id);
        background = {};
        camera = clampCamera(presets['wide']!);
        cameraTween = undefined;
        overlay = undefined;
        particles.length = 0;
      },
      background(asset, transition, step) {
        if (step.instant || transition.type === 'cut' || !background.current) {
          background = { current: asset };
          return 0;
        }
        background = {
          previous: background.current,
          current: asset,
          fade: { from: 0, to: 1, start: now, duration: transition.duration },
        };
        return transition.duration;
      },
      camera(target, motion, step) {
        const preset = typeof target === 'string' ? presets[target] : target;
        if (!preset)
          throw new BrowserServiceError(
            'invalid-data',
            `Unknown camera preset "${String(target)}".`,
          );
        const to = clampCamera(preset);
        if (step.instant || motion.cut || motion.duration <= 0) {
          camera = to;
          cameraTween = undefined;
          return 0;
        }
        if (reduced()) {
          // Reduced motion: a cut softened by a gentle dip, never a pan.
          camera = to;
          cameraTween = undefined;
          overlay = {
            color: clearColor,
            shape: 'dip',
            tween: { from: 0, to: 0.35, start: now, duration: 0.4 },
          };
          return 0.4;
        }
        cameraTween = {
          from: cameraAt(now),
          to,
          start: now,
          duration: motion.duration,
          ...(motion.ease ? { ease: motion.ease } : {}),
        };
        return motion.duration;
      },
      enter(name, from, to, motion, step) {
        const entry = actor(name);
        entry.visible = true;
        entry.fade = undefined;
        if (step.instant) {
          entry.model.setPosition(to);
          return 0;
        }
        if (reduced()) {
          entry.model.setPosition(to);
          entry.fade = { from: 0, to: 1, start: now, duration: 0.4, hideAfter: false };
          return 0.4;
        }
        entry.model.setPosition(placement(from, to.y, entry));
        return entry.model.move([to], now, { ...motion });
      },
      exit(name, to, motion, step) {
        const entry = actor(name);
        if (step.instant) {
          entry.visible = false;
          entry.model.setPosition(placement(to, entry.model.positionAt(now).y, entry));
          return 0;
        }
        if (reduced()) {
          entry.fade = { from: 1, to: 0, start: now, duration: 0.4, hideAfter: true };
          return 0.4;
        }
        const duration = entry.model.move(
          [placement(to, entry.model.positionAt(now).y, entry)],
          now,
          { ...motion },
        );
        entry.fade = { from: 1, to: 1, start: now, duration, hideAfter: true };
        return duration;
      },
      move(name, path, motion, step) {
        const entry = actor(name);
        if (step.instant) {
          entry.model.setPosition(path.at(-1)!);
          return 0;
        }
        return entry.model.move(path, now, { ...motion });
      },
      pose(name, pose, step) {
        const entry = actor(name);
        if (pose.expression) entry.model.setExpression(pose.expression);
        if (pose.face) entry.model.facing = pose.face;
        if (pose.clip && !step.instant) {
          entry.model.play(pose.clip, { at: now, layer: 'gesture' });
          return entry.model.clipDuration(pose.clip);
        }
        return 0;
      },
      emote(name, value, step) {
        const entry = actor(name);
        if (step.instant) {
          const expression = entry.model.base.emotes?.[value]?.expression;
          if (expression) entry.model.setExpression(expression);
          return 0;
        }
        return emote(entry, value);
      },
      line(name, lineId): LineHandle {
        const narration = options.narration;
        let outcome: LineOutcome = 'pending';
        if (!narration || !packId) return { outcome: () => 'failed' };
        const entry = name ? actor(name) : undefined;
        activeLine = { packId, lineId };
        let serial: number | undefined;
        const unsubscribe = narration.subscribe((event) => {
          if (event.lineId !== lineId || event.packId !== packId) return;
          if (event.type === 'start') serial ??= event.serial;
          if (serial !== undefined && event.serial !== serial) return;
          if (event.type === 'complete') outcome = 'completed';
          else if (event.type === 'fail' || event.type === 'block' || event.type === 'stop')
            outcome = 'failed';
          if (outcome !== 'pending') unsubscribe();
        });
        const speaking = entry
          ? handle(entry).speak({ packId, lineId })
          : narration.playLine(packId, lineId);
        speaking.catch(() => {
          outcome = 'failed';
          unsubscribe();
        });
        return { outcome: () => outcome };
      },
      stopLine() {
        if (activeLine && options.narration) {
          const clock = options.narration.clock();
          if (clock.lineId === activeLine.lineId && clock.packId === activeLine.packId)
            options.narration.stop();
        }
        activeLine = undefined;
        for (const entry of puppets.values()) if (entry.cutscene) entry.speech = undefined;
      },
      music(asset, fade, step) {
        if (options.audio?.music) options.audio.music(asset, step.instant ? 0 : fade);
        else if (options.narration && packId)
          void options.narration
            .setAtmosphere(asset ? { packId, asset, fadeSeconds: step.instant ? 0 : fade } : null)
            .catch(() => undefined);
      },
      atmosphere(asset, fade, step) {
        options.audio?.atmosphere?.(asset, step.instant ? 0 : fade);
      },
      sfx(asset, gain) {
        if (options.audio?.sfx) options.audio.sfx(asset, gain);
        else if (options.narration && packId)
          void options.narration.playEffect(packId, asset, { gain }).catch(() => undefined);
      },
      effect(name, at, duration, step) {
        if (step.instant) return 0;
        return spawnEffect(name, at ?? { x: logical.width / 2, y: logical.height / 2 }, duration);
      },
      transition(type, duration, color, step) {
        if (step.instant) return 0;
        // Never flash: a full fade takes at least half a second.
        const length = Math.max(0.5, duration);
        overlay = {
          color,
          shape: 'dip',
          tween: { from: 0, to: type === 'fade' ? 1 : 0.5, start: now, duration: length },
        };
        return length;
      },
      settle() {
        for (const entry of puppets.values()) {
          entry.model.settle(now);
          if (entry.fade) {
            entry.visible = entry.fade.to > 0 && !entry.fade.hideAfter;
            entry.fade = undefined;
          }
        }
        if (cameraTween) camera = cameraTween.to;
        cameraTween = undefined;
        background.fade = undefined;
        background.previous = undefined;
        overlay = undefined;
        particles.length = 0;
      },
    };
  };

  // ---------------------------------------------------------------- public API
  const stage = {
    canvas,
    logical,
    get renderer(): 'webgl' | 'canvas' {
      return renderer.kind;
    },
    /** Presentation time in seconds. */
    now: (): number => now,
    async load(request: LoadRequest): Promise<LoadResult> {
      alive();
      const fetched = await Promise.all(
        (request.documents ?? []).map(async (id) => ({ source: id, value: await fetchJson(id) })),
      );
      const documents = [
        ...fetched,
        ...(request.values ?? []).map((value, i) => ({ source: `values[${String(i)}]`, value })),
      ];
      // Validate together with already-loaded documents so cross-references resolve.
      const known = [...atlases.values(), ...rigs.values(), ...clips.values()].map((value) => ({
        source: `loaded:${value.id}`,
        value,
      }));
      const result = validateBundle({ documents: [...known, ...documents] });
      const diagnostics = result.diagnostics.filter(
        (d) => !d.source?.startsWith('loaded:') || d.severity === 'error',
      );
      if (!result.ok) return { ok: false, diagnostics };
      const newAtlases = documents
        .map((d) => d.value as AtlasFile)
        .filter((v) => v.format === 'aegis-atlas/1' && !atlases.has(v.id));
      for (const atlas of newAtlases) {
        const problem = await loadImage(atlas.image, { width: atlas.width, height: atlas.height });
        if (problem) return { ok: false, diagnostics: [...diagnostics, problem] };
        atlases.set(atlas.id, atlas);
        atlasImage.set(atlas.id, atlas.image);
      }
      for (const { value } of documents) {
        const doc = value as RigFile | ClipFile;
        if (doc.format === 'aegis-rig/1') rigs.set(doc.id, doc as RigFile);
        if (doc.format === 'aegis-clip/1') clips.set(doc.id, doc as ClipFile);
      }
      for (const image of request.images ?? []) {
        const problem = await loadImage(image);
        if (problem) return { ok: false, diagnostics: [...diagnostics, problem] };
      }
      return { ok: true, diagnostics };
    },
    /** Release images, atlases and documents no longer needed (scene change). */
    release(ids: {
      atlases?: readonly string[];
      images?: readonly string[];
      rigs?: readonly string[];
      clips?: readonly string[];
    }): void {
      alive();
      for (const id of ids.atlases ?? []) {
        const image = atlasImage.get(id);
        if (image) releaseImage(image, true);
        atlasImage.delete(id);
        atlases.delete(id);
      }
      for (const id of ids.images ?? []) releaseImage(id, true);
      for (const id of ids.rigs ?? []) rigs.delete(id);
      for (const id of ids.clips ?? []) clips.delete(id);
    },
    /** Remove every puppet, sprite, particle and background (keeps loaded assets). */
    clearScene(): void {
      alive();
      for (const controller of [...cutscenes]) controller.dispose();
      puppets.clear();
      sprites.clear();
      particles.length = 0;
      background = {};
      overlay = undefined;
      camera = clampCamera(presets['wide']!);
      cameraTween = undefined;
    },
    setBackground(
      assetId: string,
      transition: { type: 'cut' | 'crossfade'; duration?: number } = { type: 'cut' },
    ): void {
      alive();
      if (!frameSource(assetId)) throw new BrowserServiceError('asset', `Load "${assetId}" first.`);
      background =
        transition.type === 'cut' || !background.current
          ? { current: assetId }
          : {
              previous: background.current,
              current: assetId,
              fade: { from: 0, to: 1, start: now, duration: transition.duration ?? 0.6 },
            };
    },
    addSprite(spec: SpriteSpec): string {
      alive();
      if (!LAYERS.includes(spec.layer) || spec.layer === ('characters' as StageLayer))
        throw new BrowserServiceError(
          'invalid-data',
          'Sprites use background-free layers other than characters.',
        );
      const id = spec.id ?? `sprite-${String(++serial)}`;
      sprites.set(id, { id, spec: { ...spec } });
      return id;
    },
    removeSprite(id: string): void {
      sprites.delete(id);
    },
    puppet: (spec: PuppetSpec): StagePuppet => createPuppet(spec),
    getPuppet(id: string): StagePuppet | undefined {
      const entry = puppets.get(id);
      return entry ? handle(entry) : undefined;
    },
    effect(name: string, at: Vec2, duration = 1.2): void {
      alive();
      spawnEffect(name, at, duration);
    },
    camera(): CameraTarget {
      return { ...cameraAt(now) };
    },
    setCamera(
      target: CameraTarget | string,
      motion: { duration?: number; ease?: Easing } = {},
    ): number {
      alive();
      const preset = typeof target === 'string' ? presets[target] : target;
      if (!preset)
        throw new BrowserServiceError('invalid-data', `Unknown camera preset "${String(target)}".`);
      const to = clampCamera(preset);
      if (!motion.duration || reduced()) {
        camera = to;
        cameraTween = undefined;
        return 0;
      }
      cameraTween = {
        from: cameraAt(now),
        to,
        start: now,
        duration: motion.duration,
        ...(motion.ease ? { ease: motion.ease } : {}),
      };
      return motion.duration;
    },
    cutscene(
      file: CutsceneFile,
      config: {
        avatar?: AvatarComposition;
        packId?: string;
        onEvent?(event: CutsceneEvent): void;
      } = {},
    ): CutsceneController {
      alive();
      const player = new CutscenePlayer(file, createHost(file, config), {
        ...(config.onEvent ? { onEvent: config.onEvent } : {}),
        comfort: () => comfort,
      });
      const controller: CutsceneController = {
        player,
        play: (play = {}) => player.play(now, play),
        next: () => player.next(now),
        skip: () => player.skip(now),
        replay: () => player.replay(now),
        pause: (reason) => player.pause(reason),
        resume: (reason) => player.resume(reason),
        status: () => player.status(),
        dispose: () => {
          cutscenes.delete(controller);
        },
      };
      cutscenes.add(controller);
      return controller;
    },
    setComfort(enabled: boolean): void {
      comfort = enabled;
    },
    comfort: (): boolean => comfort,
    setReducedMotion(value: boolean | 'system'): void {
      reducedSetting = value;
      applyReduced();
    },
    reducedMotion: (): boolean => reduced(),
    /** Handoff/private projection: hide private visuals and stop a private puppet's narration. */
    setPrivacy(hidden: boolean): void {
      privacy = hidden;
      if (!hidden) return;
      for (const entry of puppets.values())
        if (entry.private && entry.speech) {
          const clock = options.narration?.clock();
          if (clock?.lineId === entry.speech.lineId) options.narration?.stop();
          entry.speech = undefined;
          entry.model.setMouth(undefined);
        }
    },
    /** Composes with runtime pause reasons and `bindVisibilityPause`: presentation time stops. */
    pause(reason: string): void {
      pauseReasons.add(reason);
      for (const controller of cutscenes) controller.pause(reason);
    },
    resume(reason: string): void {
      pauseReasons.delete(reason);
      for (const controller of cutscenes) controller.resume(reason);
    },
    paused: (): boolean => pauseReasons.size > 0,
    /** Screen client point to logical frame coordinates (camera ignored), like `logicalPoint`. */
    toLogical(client: Point): Point | undefined {
      return logicalPoint(client, canvas.getBoundingClientRect(), logical);
    },
    /** Screen client point to scene coordinates through the current camera (for hotspots). */
    toScene(client: Point): Point | undefined {
      const point = logicalPoint(client, canvas.getBoundingClientRect(), logical);
      if (!point) return undefined;
      const cam = cameraAt(now);
      return {
        x: cam.x + (point.x - logical.width / 2) / cam.zoom,
        y: cam.y + (point.y - logical.height / 2) / cam.zoom,
      };
    },
    /** Scene coordinates to client (CSS) coordinates through the current camera. */
    toClient(scene: Point): Point {
      const rect = canvas.getBoundingClientRect();
      const cam = cameraAt(now);
      const scale = Math.min(rect.width / logical.width, rect.height / logical.height);
      const x = (scene.x - cam.x) * cam.zoom + logical.width / 2;
      const y = (scene.y - cam.y) * cam.zoom + logical.height / 2;
      return {
        x: rect.left + (rect.width - logical.width * scale) / 2 + x * scale,
        y: rect.top + (rect.height - logical.height * scale) / 2 + y * scale,
      };
    },
    start,
    stop,
    /** Advance presentation time and render one frame (tests and manual loops). */
    renderFrame(advanceSeconds = 0): void {
      alive();
      if (!pauseReasons.size) now += Math.max(0, advanceSeconds);
      renderFrame();
    },
    stats(): StageStats {
      const mean = frameTimes.length
        ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
        : 0;
      return {
        renderer: renderer.kind,
        frames: frame,
        drawCalls: lastStats.drawCalls,
        quads: lastStats.quads,
        frameMs: mean,
        ownedBytes: ownedBytes(),
        textures: images.size,
        puppets: puppets.size,
        listeners: listeners.length,
        time: now,
        paused: pauseReasons.size > 0,
      };
    },
    /** Releases owned images, atlases, listeners, the frame loop and the canvas. */
    async dispose(): Promise<void> {
      if (disposed) return;
      stop();
      for (const controller of [...cutscenes]) controller.dispose();
      for (const remove of listeners.splice(0)) remove();
      for (const id of [...images.keys()]) releaseImage(id, true);
      puppets.clear();
      sprites.clear();
      particles.length = 0;
      renderer.dispose();
      canvas.remove();
      disposed = true;
    },
  };
  if (options.autoStart !== false) start();
  return stage;
}

export type Stage = ReturnType<typeof createStage>;

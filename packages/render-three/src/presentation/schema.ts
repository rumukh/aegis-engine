import type { VisualRole } from '../appearance.js';

export type Vec3 = readonly [number, number, number];
export type QualityTier = 'low' | 'standard' | 'high' | 'photo';
export interface StateField {
  entity: string;
  component: string;
  /** Dot-separated own-property path, never an expression. */
  field: string;
}
export interface StateCondition extends StateField {
  equals: boolean | number | string;
}
export interface PipelineSpec {
  toneMapping: 'aces';
  exposure?: number;
  saturation?: number;
  bloom?: { strength: number; radius: number; threshold: number };
  ambientOcclusion?: { radius: number; minDistance: number; maxDistance: number };
}
export interface SpotSpec {
  id: string;
  color: string;
  intensity: number;
  position: Vec3;
  target: Vec3;
  distance: number;
  /** Cone half-angle in degrees. */
  angle: number;
  penumbra?: number;
  decay?: number;
  anchor?: 'world' | 'camera' | { entity: string };
  enabledWhen?: StateCondition;
  shadow?: { mapSize?: 512 | 1024 | 2048; bias?: number; normalBias?: number };
}
export interface Provenance {
  author: string;
  license: string;
  source: string;
}
export interface AssetBase {
  id: string;
  src: string;
  provenance: Provenance;
}
export type AssetSpec =
  | (AssetBase & {
      kind: 'texture';
      colorSpace?: 'srgb' | 'linear';
      filter?: 'linear' | 'nearest';
      /** Normalized rectangles in top-left image coordinates. */
      frames?: Readonly<Record<string, readonly [number, number, number, number]>>;
    })
  | (AssetBase & { kind: 'gltf' | 'audio' });
export interface MaterialSpec {
  id: string;
  shading: 'standard' | 'unlit';
  color?: string;
  map?: string;
  normalMap?: string;
  roughnessMap?: string;
  metalnessMap?: string;
  aoMap?: string;
  emissiveMap?: string;
  normalScale?: number;
  aoIntensity?: number;
  envMapIntensity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  alphaTest?: number;
  doubleSided?: boolean;
  repeat?: readonly [number, number];
}
export type SpriteState = 'idle' | 'move' | 'rise' | 'fall' | 'dead';
export interface SpriteSequence {
  frames: readonly string[];
  frameTicks: number;
}
export type VisualSpec =
  | { kind: 'primitive'; shape: 'box' | 'plane'; material?: string }
  | {
      kind: 'sprite';
      texture: string;
      frame?: string;
      material?: string;
      animations?: Readonly<Partial<Record<SpriteState, SpriteSequence>>>;
    }
  | {
      kind: 'model';
      mesh: string;
      material?: string;
      clip?: string;
      animations?: Readonly<Partial<Record<SpriteState, string>>>;
      /** First matching condition selects a looping clip; event effects still take priority. */
      stateClips?: readonly { when: StateCondition; clip: string; timeScale?: number }[];
    };
export interface Pose {
  position?: Vec3;
  /** Euler angles in degrees, XYZ order. */
  rotation?: Vec3;
  scale?: Vec3;
}
export interface Motion {
  kind: 'bob' | 'spin' | 'pulse';
  axis: 'x' | 'y' | 'z';
  amplitude: number;
  periodTicks: number;
}
export interface Decoration {
  id: string;
  visual: VisualSpec;
  anchor?: 'world' | 'camera' | { entity: string };
  pose?: Pose;
  parallax?: number;
  motion?: Motion;
  instances?: readonly Pose[];
  visibleWhen?: StateCondition;
}
export interface EventEffect {
  event: string;
  kind: 'burst' | 'pulse' | 'recoil' | 'clip' | 'frames';
  target: ({ entity: string } | { object: string }) & { node?: string };
  durationTicks: number;
  color?: string;
  count?: number;
  amount?: number;
  clip?: string;
  holdLast?: boolean;
  frames?: readonly string[];
  frameTicks?: number;
}
export interface SpatialAudioSpec {
  target: { entity: string } | { position: Vec3 };
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
}
export interface CaptionSpec {
  text: string;
  speaker?: string;
  durationTicks?: number;
}
export interface AudioLayer {
  id: string;
  asset: string;
  volume?: number;
  spatial?: SpatialAudioSpec;
  enabledWhen?: StateCondition;
  fadeSeconds?: number;
}
export interface AudioCue {
  event: string;
  when?: { field: string; equals: boolean | number | string };
  asset?: string;
  volume?: number;
  cooldownTicks?: number;
  maxVoices?: number;
  /** Named monophonic group shared across cues; a new voice replaces the previous one. */
  voiceGroup?: string;
  fadeSeconds?: number;
  spatial?: SpatialAudioSpec;
  caption?: CaptionSpec;
}
export interface AudioSpec {
  volume?: number;
  headroom?: number;
  ambient?: { asset: string; volume?: number };
  layers?: readonly AudioLayer[];
  cues?: readonly AudioCue[];
}
export interface HudSpec {
  playerName: string;
  winEvent: string;
  loseEvents: readonly string[];
  steps?: readonly { id: string; label: string; event: string }[];
  bindings?: Partial<
    Record<'objective' | 'prompt' | 'subtitle' | 'subtitleUntil' | 'status', StateField>
  >;
}
export interface LossEndingSpec {
  title?: string;
  message?: string;
  fadeSeconds?: number;
}
export interface PresentationManifest {
  aegis: 'presentation/1';
  assets?: readonly AssetSpec[];
  materials?: readonly MaterialSpec[];
  surfaces?: Readonly<Partial<Record<VisualRole, string>>>;
  entities?: readonly {
    target: { name: string } | { role: VisualRole };
    visual: VisualSpec;
    pose?: Pose;
    fit?: 'bounds' | 'authored';
  }[];
  objects?: readonly Decoration[];
  effects?: readonly EventEffect[];
  environment?: {
    background?: string;
    ambient?: { color: string; intensity: number };
    directional?: { color: string; intensity: number; position: Vec3 };
    points?: readonly {
      color: string;
      intensity: number;
      position: Vec3;
      distance: number;
    }[];
    spots?: readonly SpotSpec[];
    reflections?: { texture: string; intensity?: number };
    fog?: { color: string; near: number; far: number };
  };
  audio?: AudioSpec;
  hud?: HudSpec;
  /** Iso-only framing override; omission retains the authoritative camera's follow behavior. */
  camera?: {
    framing: 'follow' | 'level';
    /** Nonnegative world-unit margin around the level; used only for level framing. */
    padding?: number;
  };
  ui?: {
    accent?: string;
    eyebrow?: string;
    cover?: string;
    layout?: 'standard' | 'cinematic';
    lossEnding?: LossEndingSpec;
  };
  quality?: QualityTier;
  /** Omission keeps the original direct rendering path. */
  pipeline?: PipelineSpec;
  /** Explicit replacement only; collision geometry remains available in diagnostic view. */
  legacy?: { level?: boolean; triggers?: boolean };
}
export interface PresentationSource {
  manifest: PresentationManifest;
  /** Absolute host directory. Never serialize this into a page. */
  assetRoot?: string;
}
export interface ResolvedPresentation {
  manifest: PresentationManifest;
  /** Page-relative directory URL. */
  baseUrl: string;
  /** Prepared local dependency closure, relative to baseUrl. */
  files?: readonly string[];
}
export const PRESENTATION_LIMITS = {
  assets: 256,
  objects: 256,
  instances: 4096,
  pointLights: 8,
  spotLights: 8,
  shadowLights: 4,
  audioLayers: 8,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  loadConcurrency: 4,
} as const;
export const QUALITY = {
  low: { pixelRatio: 1, effects: 32, voices: 8 },
  standard: { pixelRatio: 2, effects: 128, voices: 16 },
  high: { pixelRatio: 2, effects: 128, voices: 24 },
  photo: { pixelRatio: 3, effects: 128, voices: 32 },
} as const;

export const CINEMATIC_QUALITY = {
  low: { pixels: 1280 * 720, shadowMap: 512, ao: false, bloom: false },
  standard: { pixels: 1920 * 1080, shadowMap: 1024, ao: true, bloom: true },
  high: { pixels: 2560 * 1440, shadowMap: 1024, ao: true, bloom: true },
  photo: { pixels: 3840 * 2160, shadowMap: 2048, ao: true, bloom: true },
} as const;

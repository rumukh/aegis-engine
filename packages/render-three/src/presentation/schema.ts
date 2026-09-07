import type { VisualRole } from '../appearance.js';

export type Vec3 = readonly [number, number, number];
export type QualityTier = 'low' | 'standard';
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
export interface AudioSpec {
  volume?: number;
  ambient?: { asset: string; volume?: number };
  cues?: readonly {
    event: string;
    asset: string;
    volume?: number;
    cooldownTicks?: number;
  }[];
}
export interface HudSpec {
  playerName: string;
  winEvent: string;
  loseEvents: readonly string[];
  steps?: readonly { id: string; label: string; event: string }[];
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
    fog?: { color: string; near: number; far: number };
  };
  audio?: AudioSpec;
  hud?: HudSpec;
  ui?: { accent?: string; eyebrow?: string; cover?: string };
  quality?: QualityTier;
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
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  loadConcurrency: 4,
} as const;
export const QUALITY = {
  low: { pixelRatio: 1, effects: 32, voices: 8 },
  standard: { pixelRatio: 2, effects: 128, voices: 16 },
} as const;

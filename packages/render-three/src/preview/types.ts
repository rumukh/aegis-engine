import type { Diagnostic } from '@aegis/core';
import type { PresentationAssetStats } from '../presentation/assets.js';
import type {
  PipelineSpec,
  Provenance,
  QualityTier,
  ResolvedPresentation,
  Vec3,
} from '../presentation/schema.js';

export const PREVIEW_VIEWS = ['three-quarter', 'front', 'back', 'left', 'right', 'top'] as const;
export const PREVIEW_LIGHTS = ['studio', 'neutral', 'warm'] as const;
export const PREVIEW_PROJECTIONS = ['perspective', 'orthographic'] as const;
export const PREVIEW_SHAPES = ['sphere', 'cube', 'plane'] as const;
export type PreviewKind = 'model' | 'texture' | 'material';
export type PreviewView = (typeof PREVIEW_VIEWS)[number];
export type PreviewLighting = (typeof PREVIEW_LIGHTS)[number];

export interface PreviewSelection {
  kind: PreviewKind;
  id: string;
  /** A declared material override for a model, not a glTF-internal material name. */
  material?: string;
  /** A declared atlas frame for a texture. */
  frame?: string;
}

export interface PreviewSettings {
  view?: PreviewView;
  projection?: (typeof PREVIEW_PROJECTIONS)[number];
  background?: string;
  lighting?: PreviewLighting;
  /** null selects the authored rest pose. Playback is paused by default. */
  clip?: string | null;
  time?: number;
  playing?: boolean;
  shape?: (typeof PREVIEW_SHAPES)[number];
  /** Explicit camera coordinates take precedence over a named view. */
  camera?: { position: Vec3; target: Vec3; zoom?: number; orthographicHeight?: number };
}

export interface PreviewCamera {
  projection: 'perspective' | 'orthographic';
  position: Vec3;
  target: Vec3;
  up: Vec3;
  near: number;
  far: number;
  fov: number | null;
  orthographicHeight: number | null;
  zoom: number;
}

export interface PreviewRecipe {
  selection: PreviewSelection;
  view: PreviewView;
  camera: PreviewCamera;
  lighting: PreviewLighting;
  background: string;
  clip: string | null;
  time: number;
  shape: (typeof PREVIEW_SHAPES)[number];
  pipeline?: {
    quality: QualityTier;
    settings: PipelineSpec;
    reflections?: { texture: string; intensity?: number };
  };
}

export interface PreviewBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export interface PreviewStats {
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  /** Hash of bounded, evenly sampled posed vertices in asset coordinates, not a world hash. */
  poseSampleHash: string;
  /** Rendered geometry, including sampled animation, rather than the source's accessor bounds. */
  bounds: PreviewBounds;
  clips: readonly { name: string; duration: number; tracks: number }[];
  materialNames: readonly string[];
  library: PresentationAssetStats;
  gpu: { geometries: number; textures: number };
  pipeline?: object;
}

export type PreviewProvenance =
  | { status: 'declared'; value: Provenance }
  | { status: 'user-supplied'; author: null; license: null; source: null };

export interface PreviewChoice {
  kind: PreviewKind;
  id: string;
  frames?: readonly string[];
}

export interface PreviewFingerprint {
  path: string;
  bytes: number;
  sha256: string;
  provenance: PreviewProvenance;
}

/** Host paths are deliberately absent from browser-facing state. */
export interface PreviewDocument {
  revision: number;
  fingerprint: string;
  source: { name: string; format: 'direct' | 'presentation/1'; bytes: number; sha256: string };
  dependencies: readonly PreviewFingerprint[];
  selection: PreviewSelection;
  choices: readonly PreviewChoice[];
  presentation: ResolvedPresentation;
  prepareMs: number;
}

export interface PreviewServerState {
  aegis: 'asset-preview-state/1';
  revision: number;
  status: 'preparing' | 'prepared' | 'failed' | 'closed';
  lastPreparedRevision: number | null;
  document: PreviewDocument | null;
  diagnostics: readonly Diagnostic[];
}

export interface PreviewStudioState {
  revision: number;
  status: 'loading' | 'ready' | 'failed' | 'disposed';
  lastGoodRevision: number | null;
  fingerprint: string | null;
  diagnostics: readonly Diagnostic[];
  recipe: PreviewRecipe | null;
  stats: PreviewStats | null;
  loadMs: number | null;
  playing: boolean;
  /** A valid new model awaits an explicit replacement for its invalid retained clip/time. */
  recovery: { clips: PreviewStats['clips'] } | null;
}

export interface PreviewCaptureRequest {
  filename: string;
  /** Required on HTTP requests. Local API calls default to the currently prepared revision. */
  revision?: number;
  width?: number;
  height?: number;
  settings?: PreviewSettings;
}

/** The browser has encoded pixels but has not claimed that the host source is still current. */
export interface PreviewFrame {
  revision: number;
  fingerprint: string;
  width: number;
  height: number;
  dataUrl: string;
  recipe: PreviewRecipe;
  stats: PreviewStats;
  loadMs: number;
  renderMs: number;
  encodeMs: number;
}

export interface PreviewCaptureReport {
  aegis: 'asset-preview-capture/1';
  revision: number;
  fingerprint: string;
  source: PreviewDocument['source'] & { path: string };
  dependencies: readonly PreviewFingerprint[];
  freshness: { matchesSource: true; checkedAt: string; policy: 'checked-before-and-after-capture' };
  rendered: PreviewSelection;
  recipe: PreviewRecipe;
  stats: PreviewStats;
  output: {
    path: string;
    sidecar: string;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
  };
  timings: {
    sessionColdStartMs: number;
    browserStartMs: number | null;
    prepareMs: number;
    loadMs: number;
    renderMs: number;
    encodeMs: number;
    captureMs: number;
    /** PNG publication only; the sidecar containing this measurement is written afterwards. */
    pngWriteMs: number;
    /** Through PNG publication. Callers can additionally time the complete API invocation. */
    totalMs: number;
    lastReloadMs: number | null;
  };
  host: { platform: string; arch: string; node: string; browser: string; renderer: string };
  scope: 'asset-only; no gameplay validation';
  pixelDeterminism: 'not-guaranteed-across-GPUs';
}

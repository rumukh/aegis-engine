/** Authored 2D animation formats (docs/api/animation.md). All coordinates are logical pixels, y down. */

export interface Vec2 {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Placement of the stored rectangle inside the untrimmed frame. */
  offset?: Vec2;
  /** Untrimmed frame size; defaults to `w`x`h`. */
  source?: { w: number; h: number };
}
export interface AtlasFile {
  format: 'aegis-atlas/1';
  id: string;
  image: string;
  width: number;
  height: number;
  /** Logical pixels per atlas pixel. Defaults to 1. */
  scale?: number;
  frames: Readonly<Record<string, AtlasFrame>>;
}

export interface RigPart {
  id: string;
  parent?: string;
  frame?: string;
  variants?: Readonly<Record<string, string>>;
  variant?: string;
  pivot: Vec2;
  position: Vec2;
  rotation?: number;
  scale?: Vec2;
  opacity?: number;
  z: number;
  tint?: { channel: string; mask?: string };
}
export interface RigSlot {
  parent?: string;
  position: Vec2;
  z: number;
}
export interface RigAnchor {
  part: string;
  x: number;
  y: number;
}
export interface RigRoles {
  mouth?: string;
  eyes?: string;
  brows?: string;
  head?: string;
  lookAt?: string;
  body?: string;
}
export interface RigEmote {
  expression?: string;
  clip?: string;
  effect?: string;
}
export interface RigFile {
  format: 'aegis-rig/1';
  id: string;
  revision: string;
  atlases: readonly string[];
  origin?: Vec2;
  bounds?: Rect;
  parts: readonly RigPart[];
  roles?: RigRoles;
  expressions?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  slots?: Readonly<Record<string, RigSlot>>;
  anchors?: Readonly<Record<string, RigAnchor>>;
  tints?: Readonly<Record<string, { default: string }>>;
  emotes?: Readonly<Record<string, RigEmote>>;
}

export type EasingName =
  | 'linear'
  | 'step'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInSine'
  | 'easeOutSine'
  | 'easeInOutSine'
  | 'easeInBack'
  | 'easeOutBack'
  | 'easeInOutBack';
export type Easing = EasingName | readonly [number, number, number, number];

export type NumericProperty = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity';
export type ClipProperty = NumericProperty | 'variant' | 'expression';
export interface ClipKey<V = number | string> {
  t: number;
  v: V;
  ease?: Easing;
}
export interface ClipTrack {
  /** Omitted only for `expression` tracks. */
  part?: string;
  property: ClipProperty;
  keys: readonly ClipKey[];
}
export interface ClipEvent {
  t: number;
  name: string;
  data?: Readonly<Record<string, string | number | boolean>>;
}
export interface ClipFile {
  format: 'aegis-clip/1';
  id: string;
  duration: number;
  loop?: boolean;
  blend?: 'override' | 'additive';
  tracks: readonly ClipTrack[];
  events?: readonly ClipEvent[];
}

export const MOUTH_SHAPES = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export type MouthShape = (typeof MOUTH_SHAPES)[number];
export interface Cue {
  t: number;
  s: MouthShape;
  a?: number;
}
export interface CueTrackFile {
  format: 'aegis-cues/1';
  line: string;
  revision?: string;
  duration: number;
  cues: readonly Cue[];
}

export type Placement = Vec2 | 'left' | 'right';
export interface CameraTarget {
  x: number;
  y: number;
  zoom: number;
}
interface StepBase {
  wait?: boolean;
  /** Field replacements applied while comfort presentation is on. */
  comfort?: Readonly<Record<string, unknown>>;
}
export type CutsceneStep = StepBase &
  (
    | {
        op: 'background';
        asset: string;
        transition?: { type: 'cut' | 'crossfade'; duration?: number };
      }
    | {
        op: 'camera';
        preset?: string;
        to?: CameraTarget;
        duration?: number;
        ease?: Easing;
        cut?: boolean;
      }
    | {
        op: 'enter';
        actor: string;
        from: Placement;
        to: Vec2;
        duration?: number;
        walk?: boolean;
        ease?: Easing;
      }
    | {
        op: 'exit';
        actor: string;
        to: Placement;
        duration?: number;
        walk?: boolean;
        ease?: Easing;
      }
    | {
        op: 'move';
        actor: string;
        to?: Vec2;
        path?: readonly Vec2[];
        duration?: number;
        speed?: number;
        walk?: boolean;
        ease?: Easing;
      }
    | { op: 'pose'; actor: string; expression?: string; clip?: string; face?: 'left' | 'right' }
    | { op: 'emote'; actor: string; emote: string }
    | { op: 'line'; actor?: string; line: string; advance?: 'input' | 'auto' }
    | { op: 'music'; asset: string | null; fade?: number }
    | { op: 'atmosphere'; asset: string | null; fade?: number }
    | { op: 'sfx'; asset: string; gain?: number }
    | { op: 'effect'; effect: string; at?: Vec2; duration?: number }
    | { op: 'transition'; type: 'fade' | 'crossfade'; duration?: number; color?: string }
    | { op: 'wait'; seconds?: number; for?: 'input' }
    | { op: 'marker'; id: string }
    | { op: 'join' }
  );
export type CutsceneOp = CutsceneStep['op'];
export interface AccessoryBinding {
  /** Base-rig slot; omit when attaching to an `anchor`. */
  slot?: string;
  anchor?: string;
  rig: string;
  /** Selects this variant on every accessory part that declares it. */
  variant?: string;
}
export interface CastEntry {
  rig?: string;
  role?: 'avatar';
  accessories?: readonly AccessoryBinding[];
  tints?: Readonly<Record<string, string>>;
}
export interface CutsceneFile {
  format: 'aegis-cutscene/1';
  id: string;
  revision: string;
  advance?: 'input' | 'auto';
  cast: Readonly<Record<string, CastEntry>>;
  steps: readonly CutsceneStep[];
}

/** A composed avatar: species base plus accessories and tint colours (ANIM-02). */
export interface AvatarComposition {
  rig: string;
  accessories?: readonly AccessoryBinding[];
  tints?: Readonly<Record<string, string>>;
}

export interface AnimationDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path: string;
  /** Source file or document ID, when known. */
  source?: string;
}

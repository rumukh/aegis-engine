/**
 * The FPS {@link ViewProvider}: how an agent "sees" a 3D world without a GPU (CHARTER principle 7).
 *
 * There is no meaningful ASCII raster of a perspective 3D view, so for this mode the
 * {@link SemanticFrame} is the **primary** way an agent perceives the world. It therefore invests
 * in being informative: for every entity in front of the camera it reports where it is in the
 * world, where it lands on screen, how far away it is, how big it looks, whether a wall hides it
 * (`occluded` / `visibleFraction`), and a glyph. An agent debugging "why did my shot miss?" can
 * read the frame and see the target sitting off-centre, or behind a wall, without a single pixel.
 *
 * A coarse ASCII raycast raster is also provided as a secondary, at-a-glance picture of the walls
 * and visible entities directly ahead.
 * @packageDocumentation
 */
import { Name, Transform } from '@aegis/core';
import type { Entity, GameMode, Quat, Vec3, World } from '@aegis/core';
import {
  atan2,
  cos,
  cross3,
  dot3,
  floor,
  length3,
  lengthSq3,
  min,
  normalize3,
  round,
  sub3,
  tan,
  DEG2RAD,
} from '@aegis/core/math';
import type {
  AsciiView,
  CameraSnapshot,
  SemanticFrame,
  VisibleEntity,
  ViewOptions,
  ViewProvider,
  Viewport,
} from '@aegis/harness';
import { FpsCamera, HitBox, LookState } from './components.js';
import { FPS_COLLISION, forwardFromLook, raycastGrid, rightFromYaw } from './geometry.js';
import type { CollisionGrid } from './geometry.js';

/** Default semantic-frame viewport (16:9). */
const DEFAULT_VIEWPORT: Viewport = { width: 320, height: 180 };
/** Default ASCII raster size. */
const DEFAULT_ASCII = { width: 48, height: 18 };

/**
 * Squared length below which `worldUp × forward` is treated as collapsed. At pitch ±90° the two
 * vectors are parallel and the cross product is pure rounding noise (`|cos(90°)| ≈ 6.1e-17`),
 * whose sign would otherwise decide the handedness of the whole basis. Anything above this bound
 * normalises meaningfully — pitch has to be within ~6e-8° of a pole to fall below it.
 */
const DEGENERATE_BASIS_SQ = 1e-18;

/** The camera's orthonormal basis and eye position, derived from the player's look state. */
interface CameraRig {
  entity: Entity;
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  fovDegrees: number;
  near: number;
  far: number;
  rotation: Quat;
  yawDeg: number;
}

/** Locate the camera entity and build its view basis, or `undefined` if there is no camera. */
function cameraRig(world: World): CameraRig | undefined {
  const view = world.query({ has: [FpsCamera, Transform, LookState] }).first();
  if (view === undefined) return undefined;
  const cam = view.get(FpsCamera);
  const tf = view.get(Transform);
  const look = view.get(LookState);
  const eye: Vec3 = { x: tf.position.x, y: tf.position.y + cam.eyeHeight, z: tf.position.z };
  const forward = forwardFromLook(look.yawDeg, look.pitchDeg);
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  // Looking straight up or down, `forward` is parallel to world up and this cross product carries
  // no direction — it is pure rounding noise, and its *sign* is what decides whether the frame
  // comes out mirrored. `normalize3` returns `(0,0,0)` outright if it ever reaches exactly zero,
  // which would project every entity to the dead centre of the screen with zero bounds. Measured
  // on `@aegis/core/math`, `cos(±90°)` is `+6.12e-17`, so today the noise happens to point the
  // right way; the frame is how an agent sees in fps and should not rest on that. Below the noise
  // floor, fall back to the yaw-only right vector — which is exactly what the cross product
  // converges to away from the poles, so nothing off the degenerate case changes.
  const crossRight = cross3(worldUp, forward);
  const right =
    lengthSq3(crossRight) > DEGENERATE_BASIS_SQ
      ? normalize3(crossRight)
      : rightFromYaw(look.yawDeg);
  const up = cross3(forward, right);
  return {
    entity: view.entity,
    eye,
    forward,
    right,
    up,
    fovDegrees: cam.fovDegrees,
    near: cam.near,
    far: cam.far,
    rotation: tf.rotation,
    yawDeg: look.yawDeg,
  };
}

/** Marker (tag) ids among a component set: components whose stored value has no own keys. */
function tagsFromComponents(components: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(components).filter((id) => {
    const v = components[id];
    return typeof v === 'object' && v !== null && Object.keys(v as object).length === 0;
  });
}

/** Choose a single-character glyph for an entity from its tags/name. */
function glyphFor(tags: readonly string[], name: string | undefined): string {
  if (tags.includes('Player')) return '@';
  if (tags.includes('Enemy')) return 'E';
  if (name && name.length > 0) return name[0]!.toUpperCase();
  return '?';
}

/** A horizontal-fov widening factor so the raster isn't unnaturally narrow for a wide viewport. */
function horizontalFov(fovDegrees: number, width: number, height: number): number {
  const a = width / height;
  return fovDegrees * (a > 1 ? min(a, 2.2) : 1);
}

/** Clamp to `[0, 1]`. */
function clampUnit(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Project the world into a {@link SemanticFrame}. Entities behind the near plane (or off-screen)
 * are dropped unless `includeOffscreen` is set; the rest are sorted ascending by depth (ties by
 * entity), as the frozen contract requires.
 */
function buildSemanticFrame(world: World, options?: ViewOptions): SemanticFrame {
  const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
  const includeOffscreen = options?.includeOffscreen ?? false;
  const rig = cameraRig(world);

  const camera: CameraSnapshot = {
    mode: 'fps',
    position: rig ? { ...rig.eye } : { x: 0, y: 0, z: 0 },
    rotation: rig ? { ...rig.rotation } : { x: 0, y: 0, z: 0, w: 1 },
    projection: 'perspective',
    fovDegrees: rig ? rig.fovDegrees : 75,
    viewport,
  };
  if (rig === undefined) {
    return { tick: world.tick, mode: 'fps', camera, viewport, entities: [] };
  }

  const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
  const aspect = viewport.width / viewport.height;
  const f = 1 / tan((rig.fovDegrees * DEG2RAD) / 2);

  // Marker components are only discoverable from a snapshot (a tag has no typed accessor), but the
  // entity *handle* is not: taking it from the query view keeps it the branded `Entity` the frozen
  // `VisibleEntity` asks for, all the way through. Deriving it as `Number(ent.id)` off the snapshot
  // produced a raw `number` that only reached the contract through an `as unknown as` — a cast that
  // asserts a conversion the compiler had refused rather than fixing it. Same shape as
  // `IsoViewProvider`, which needs no cast for exactly this reason.
  const tagsByEntity = new Map<number, string[]>();
  for (const ent of world.snapshot().entities) {
    tagsByEntity.set(Number(ent.id), tagsFromComponents(ent.components));
  }

  const entities: VisibleEntity[] = [];
  for (const view of world.query({ has: [Transform] }).views()) {
    const entity = view.entity;
    if (entity === rig.entity) continue; // never see yourself in first person
    const worldPos = view.get(Transform).position;

    const rel = sub3(worldPos, rig.eye);
    const camZ = dot3(rel, rig.forward);
    const camX = dot3(rel, rig.right);
    const camY = dot3(rel, rig.up);
    const onFront = camZ > rig.near;
    if (!onFront && !includeOffscreen) continue;

    const ndcX = onFront ? (camX / camZ) * (f / aspect) : 0;
    const ndcY = onFront ? (camY / camZ) * f : 0;
    const screen = {
      x: (ndcX * 0.5 + 0.5) * viewport.width,
      y: (0.5 - ndcY * 0.5) * viewport.height,
    };
    const onScreen =
      onFront &&
      screen.x >= 0 &&
      screen.x <= viewport.width &&
      screen.y >= 0 &&
      screen.y <= viewport.height;
    if (!onScreen && !includeOffscreen) continue;

    const name = world.get(entity, Name)?.value;
    const tags = tagsByEntity.get(entity) ?? [];

    const box = world.get(entity, HitBox);
    const halfX = box ? box.half.x : 0.5;
    const halfY = box ? box.half.y : 0.5;
    const bounds =
      onFront && camZ > 0
        ? {
            width: (halfX * (f / aspect) * viewport.width) / camZ,
            height: (halfY * f * viewport.height) / camZ,
          }
        : { width: 0, height: 0 };

    // Occlusion: cast a ray to the entity; a nearer wall hides it.
    let occluded = false;
    let visibleFraction = 1;
    const dist = length3(rel);
    if (grid !== undefined && dist > 1e-6) {
      const dir = normalize3(rel);
      const wall = raycastGrid(grid, rig.eye, dir, dist);
      if (wall !== undefined && wall.distance < dist - 1e-6) {
        occluded = true;
        visibleFraction = 0;
      }
    }

    entities.push({
      entity,
      ...(typeof name === 'string' ? { name } : {}),
      tags,
      world: { ...worldPos },
      screen,
      depth: camZ,
      bounds,
      layer: 0,
      occluded,
      visibleFraction,
      glyph: glyphFor(tags, name),
    });
  }

  entities.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.entity - b.entity));
  return { tick: world.tick, mode: 'fps', camera, viewport, entities };
}

/** Shade a wall column by distance: nearer walls are denser. */
function wallGlyph(distance: number, far: number): string {
  const t = distance / far;
  if (t < 0.08) return '#';
  if (t < 0.18) return '+';
  if (t < 0.35) return ':';
  if (t < 0.6) return '.';
  return '`';
}

/**
 * A coarse first-person raycast raster. Each column casts a level ray across the horizontal field
 * of view and draws a wall bar whose height falls off with distance; visible entities are stamped
 * as glyphs at their projected column. Secondary to the semantic frame; handy for a quick look.
 */
function buildAsciiView(world: World, options?: ViewOptions): AsciiView {
  const size = options?.ascii ?? DEFAULT_ASCII;
  const { width, height } = size;
  const rig = cameraRig(world);
  const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
  const rows: string[][] = [];
  for (let y = 0; y < height; y++) rows.push(new Array<string>(width).fill(' '));

  if (rig !== undefined && grid !== undefined) {
    const hFov = horizontalFov(rig.fovDegrees, width, height);
    for (let c = 0; c < width; c++) {
      const frac = width === 1 ? 0.5 : c / (width - 1);
      const rayYaw = rig.yawDeg + (frac - 0.5) * hFov;
      const dir = forwardFromLook(rayYaw, 0);
      const hit = raycastGrid(grid, rig.eye, dir, rig.far);
      if (hit === undefined) continue;
      const perp = hit.distance * cos((rayYaw - rig.yawDeg) * DEG2RAD); // de-fish-eye
      const barFrac = clampUnit(1.5 / (perp <= 0.0001 ? 0.0001 : perp));
      const bar = round(barFrac * height);
      const top = round((height - bar) / 2);
      const glyph = wallGlyph(hit.distance, rig.far);
      for (let y = top; y < top + bar && y < height; y++) {
        if (y >= 0) rows[y]![c] = glyph;
      }
    }

    const frame = buildSemanticFrame(world, { viewport: { width, height } });
    const rowY = floor(height / 2);
    for (const e of frame.entities) {
      if (e.occluded === true) continue;
      const rel = sub3(e.world, rig.eye);
      const camZ = dot3(rel, rig.forward);
      if (camZ <= rig.near) continue;
      const camX = dot3(rel, rig.right);
      const angle = atan2(camX, camZ) / DEG2RAD;
      const col = round((angle / hFov + 0.5) * (width - 1));
      if (col >= 0 && col < width && rowY >= 0 && rowY < height) {
        rows[rowY]![col] = e.glyph ?? '?';
      }
    }
  }

  return {
    tick: world.tick,
    width,
    height,
    rows: rows.map((r) => r.join('')),
    legend: {
      '#': 'wall (very near)',
      '+': 'wall (near)',
      ':': 'wall (mid)',
      '.': 'wall (far)',
      '`': 'wall (distant)',
      '@': 'player',
      E: 'enemy',
      ' ': 'open / floor / sky',
    },
  };
}

/**
 * Perspective projection producing the semantic frame (primary) and a coarse ASCII raycast raster
 * (secondary).
 */
export class FpsViewProvider implements ViewProvider {
  readonly mode: GameMode = 'fps';
  semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
    return buildSemanticFrame(world, options);
  }
  asciiView(world: World, options?: ViewOptions): AsciiView | undefined {
    return buildAsciiView(world, options);
  }
}

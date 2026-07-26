/**
 * The FPS system pipeline: look integration, movement intake, 3D gravity, capsule-vs-world
 * collision, hitscan resolution, and camera orientation. Every system is a pure function of the
 * world plus the tick's {@link InputFrame}; all float math routes through `@aegis/core/math` so a
 * run is bit-reproducible (CHARTER principle 3, ADR-0001).
 *
 * Execution order within a tick (see {@link FPS_SYSTEMS}):
 * `fps.look` → `fps.intake` (input) → `fps.gravity` (update) → `fps.integrate` → `fps.hitscan`
 * (physics) → `fps.camera` (postUpdate).
 * @packageDocumentation
 */
import { Name, Transform } from '@aegis/core';
import type { Entity, System, Vec3, World } from '@aegis/core';
import { clamp, quatFromEuler, DEG2RAD } from '@aegis/core/math';
import { Health } from '@aegis/content';
import {
  CapsuleBody,
  FpsCamera,
  FpsController,
  Hitscan,
  HitBox,
  LookState,
} from './components.js';
import {
  FPS_COLLISION,
  ceilHeightAt,
  circleHitsSolid,
  floorHeightAt,
  forwardFromLook,
  forwardHorizFromYaw,
  raycastGrid,
  rayBox,
  rightFromYaw,
} from './geometry.js';
import type { CollisionGrid } from './geometry.js';

/** `weapon.fired` payload. */
export interface WeaponFiredEvent {
  tick: number;
}
/** `hitscan.hit` payload. */
export interface HitscanHitEvent {
  /** `Name` of the struck entity, or `"wall"` for level geometry. */
  target: string;
  /** World distance from the eye to the hit point. */
  distance: number;
  tick: number;
}
/** `hitscan.miss` payload. */
export interface HitscanMissEvent {
  tick: number;
}

/** Generic weapon-fired event type (mode altitude). */
export const WEAPON_FIRED = 'weapon.fired';
/** Generic hitscan-hit event type (mode altitude). */
export const HITSCAN_HIT = 'hitscan.hit';
/** Generic hitscan-miss event type (mode altitude). */
export const HITSCAN_MISS = 'hitscan.miss';

/**
 * Integrate the tick's look delta (degrees) into {@link LookState}. Yaw accumulates freely; pitch
 * is clamped to `±maxPitchDeg`. The delta is applied 1:1 — the harness `aim`/`look` DSL already
 * emits degree deltas, so there is deliberately no sensitivity multiplier.
 */
export const lookSystem: System = {
  name: 'fps.look',
  phase: 'input',
  run({ world, input }) {
    for (const view of world.query({ has: [LookState, FpsController] }).views()) {
      const look = view.get(LookState);
      const ctrl = view.get(FpsController);
      look.yawDeg += input.look.dx;
      look.pitchDeg = clamp(look.pitchDeg + input.look.dy, -ctrl.maxPitchDeg, ctrl.maxPitchDeg);
    }
  },
};

/**
 * Translate the movement axes (`Forward`, `Strafe`) into a horizontal velocity oriented by yaw,
 * and latch a jump. Velocity is set directly each tick (no ground momentum): releasing the axis
 * stops the actor. `velocity.y` is owned by gravity/jump and left untouched here except on a jump.
 */
export const intakeSystem: System = {
  name: 'fps.intake',
  phase: 'input',
  after: ['fps.look'],
  run({ world, input }) {
    for (const view of world.query({ has: [CapsuleBody, FpsController, LookState] }).views()) {
      const body = view.get(CapsuleBody);
      const ctrl = view.get(FpsController);
      const look = view.get(LookState);
      const forward = input.axes['Forward'] ?? 0;
      const strafe = input.axes['Strafe'] ?? 0;
      const fwd = forwardHorizFromYaw(look.yawDeg);
      const right = rightFromYaw(look.yawDeg);
      body.velocity.x = (fwd.x * forward + right.x * strafe) * ctrl.moveSpeed;
      body.velocity.z = (fwd.z * forward + right.z * strafe) * ctrl.moveSpeed;
      if (input.pressed.includes('Jump') && body.grounded) {
        body.velocity.y = ctrl.jumpSpeed;
        body.grounded = false;
      }
    }
  },
};

/** Apply gravity to `velocity.y`. */
export const gravitySystem: System = {
  name: 'fps.gravity',
  phase: 'update',
  run({ world, dt }) {
    for (const view of world.query({ has: [CapsuleBody, FpsController] }).views()) {
      const body = view.get(CapsuleBody);
      const ctrl = view.get(FpsController);
      body.velocity.y -= ctrl.gravity * dt;
    }
  },
};

/**
 * Sweep the capsule against the extruded world. Horizontal motion is resolved axis-separated so
 * the capsule slides along walls instead of sticking; vertical motion clamps to the per-tile floor
 * height (setting `grounded`) and to the ceiling.
 */
export const integrateSystem: System = {
  name: 'fps.integrate',
  phase: 'physics',
  after: ['fps.gravity'],
  run({ world, dt }) {
    const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
    if (grid === undefined) return;
    for (const view of world.query({ has: [CapsuleBody, Transform] }).views()) {
      const body = view.get(CapsuleBody);
      const tf = view.get(Transform);
      const pos = tf.position;
      const r = body.radius;

      // Horizontal, axis-separated for wall sliding.
      const nextX = pos.x + body.velocity.x * dt;
      if (!circleHitsSolid(grid, nextX, pos.z, r)) {
        pos.x = nextX;
      } else {
        body.velocity.x = 0;
      }
      const nextZ = pos.z + body.velocity.z * dt;
      if (!circleHitsSolid(grid, pos.x, nextZ, r)) {
        pos.z = nextZ;
      } else {
        body.velocity.z = 0;
      }

      // Vertical: clamp to floor (ground) and ceiling.
      const ground = floorHeightAt(grid, pos.x, pos.z);
      let nextY = pos.y + body.velocity.y * dt;
      if (nextY <= ground) {
        nextY = ground;
        if (body.velocity.y < 0) body.velocity.y = 0;
        body.grounded = true;
      } else {
        body.grounded = false;
        const ceil = ceilHeightAt(grid, pos.x, pos.z);
        const head = nextY + body.height;
        if (head > ceil && body.velocity.y > 0) {
          nextY = ceil - body.height;
          body.velocity.y = 0;
        }
      }
      pos.y = nextY;
    }
  },
};

/** Nearest hit found while resolving a shot: an entity name or the wall sentinel. */
interface ShotResult {
  target: string;
  distance: number;
  entity: Entity | undefined;
}

/**
 * Resolve a fired ray against both level geometry and entity {@link HitBox}es, returning the
 * nearest hit (or `undefined` for a clean miss within range).
 */
function resolveShot(world: World, eye: Vec3, dir: Vec3, range: number): ShotResult | undefined {
  const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
  let best: ShotResult | undefined;
  if (grid !== undefined) {
    const wall = raycastGrid(grid, eye, dir, range);
    if (wall !== undefined) best = { target: 'wall', distance: wall.distance, entity: undefined };
  }
  for (const view of world.query({ has: [HitBox, Transform] }).views()) {
    const box = view.get(HitBox);
    const tf = view.get(Transform);
    const center: Vec3 = {
      x: tf.position.x + box.offset.x,
      y: tf.position.y + box.offset.y,
      z: tf.position.z + box.offset.z,
    };
    const t = rayBox(eye, dir, center, box.half);
    if (t === undefined || t > range) continue;
    if (best === undefined || t < best.distance) {
      const name = world.get(view.entity, Name);
      best = { target: name?.value ?? String(view.entity), distance: t, entity: view.entity };
    }
  }
  return best;
}

/**
 * Cast a ray from the camera eye along the look direction on a `Fire` press (once the cooldown
 * elapses), applying `Hitscan.damage` to the first entity with `Health`, and emitting
 * `weapon.fired` then `hitscan.hit` / `hitscan.miss`.
 */
export const hitscanSystem: System = {
  name: 'fps.hitscan',
  phase: 'physics',
  after: ['fps.integrate'],
  run({ world, input, tick }) {
    for (const view of world.query({ has: [Hitscan, LookState, Transform, FpsCamera] }).views()) {
      const weapon = view.get(Hitscan);
      if (weapon.cooldownRemaining > 0) weapon.cooldownRemaining -= 1;
      if (!input.pressed.includes('Fire')) continue;
      if (weapon.cooldownRemaining > 0) continue;

      const look = view.get(LookState);
      const tf = view.get(Transform);
      const cam = view.get(FpsCamera);
      const eye: Vec3 = { x: tf.position.x, y: tf.position.y + cam.eyeHeight, z: tf.position.z };
      const dir = forwardFromLook(look.yawDeg, look.pitchDeg);
      weapon.cooldownRemaining = weapon.cooldownTicks;
      world.events.emit<WeaponFiredEvent>(WEAPON_FIRED, { tick });

      const hit = resolveShot(world, eye, dir, weapon.range);
      if (hit === undefined) {
        world.events.emit<HitscanMissEvent>(HITSCAN_MISS, { tick });
        continue;
      }
      world.events.emit<HitscanHitEvent>(HITSCAN_HIT, {
        target: hit.target,
        distance: hit.distance,
        tick,
      });
      if (hit.entity !== undefined) {
        const hp = world.get(hit.entity, Health);
        if (hp !== undefined) hp.current -= weapon.damage;
      }
    }
  },
};

/** Place the camera orientation into `Transform.rotation` from the look angles. */
export const cameraSystem: System = {
  name: 'fps.camera',
  phase: 'postUpdate',
  run({ world }) {
    for (const view of world.query({ has: [FpsCamera, LookState, Transform] }).views()) {
      const look = view.get(LookState);
      const tf = view.get(Transform);
      tf.rotation = quatFromEuler(look.yawDeg * DEG2RAD, look.pitchDeg * DEG2RAD, 0);
    }
  },
};

/** The FPS systems in intended order (the schedule also encodes phase + `after`). */
export const FPS_SYSTEMS: readonly System[] = [
  lookSystem,
  intakeSystem,
  gravitySystem,
  integrateSystem,
  hitscanSystem,
  cameraSystem,
];

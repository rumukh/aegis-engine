/**
 * The platformer mode's system pipeline: input intake, gravity with coyote-time and
 * jump-buffering, kinematic-platform motion with rider carry, AABB-vs-tilemap integration, and a
 * dead-zone follow camera. Every system is a pure function of world state + tick — no wall-clock,
 * no `Math.random`, only `@aegis/core/math` — so a run is byte-for-byte reproducible.
 * @packageDocumentation
 */
import { abs, floor, max, Name, Transform } from '@aegis/core';
import type { Entity, System, TickContext, World } from '@aegis/core';
import {
  BodyState,
  KinematicPlatform,
  PlatformerCamera,
  PlatformerController,
  TileCollider,
  Velocity,
} from './components.js';
import type { KinematicPlatformData } from './components.js';
import {
  emptyGrid,
  PlatformerCollision,
  resolveX,
  resolveY,
  restingOn,
  tileBoxesNear,
} from './level.js';
import type { SolidBox } from './level.js';

/** Emitted the tick a jump actually launches (from the ground, a coyote window, or a buffer). */
export const PLAYER_JUMPED = 'player.jumped';
/** Emitted the tick a body transitions airborne → grounded. */
export const PLAYER_LANDED = 'player.landed';
/** Emitted the tick a body first begins riding a kinematic platform. */
export const PLATFORM_BOARDED = 'platform.boarded';

/** Tolerance for "feet resting exactly on a surface" tests. */
const REST_EPS = 1e-4;

/** The deterministic centre coordinate of a platform along its axis at a given tick. */
export function platformAxisPos(p: KinematicPlatformData, tick: number, dt: number): number {
  const range = p.max - p.min;
  if (range <= 0) return p.min;
  const cycle = 2 * range;
  const dist = p.speed * dt * tick + p.phase * cycle;
  const d = dist - floor(dist / cycle) * cycle;
  const tri = d <= range ? d : cycle - d;
  return p.min + tri;
}

/** Solid box of a platform whose axis centre is `pos` (the other axis comes from `anchor`). */
function platformBoxAt(
  p: KinematicPlatformData,
  pos: number,
  anchorX: number,
  anchorY: number,
): SolidBox {
  const cx = p.axis === 'x' ? pos : anchorX;
  const cy = p.axis === 'y' ? pos : anchorY;
  return {
    left: cx - p.halfWidth,
    right: cx + p.halfWidth,
    bottom: cy - p.halfHeight,
    top: cy + p.halfHeight,
  };
}

/**
 * Input intake: translate this tick's actions into horizontal velocity and a buffered jump
 * request. Reads generic action names from the compiled {@link TickContext.input} (ADR-0004).
 */
const intakeSystem: System = {
  name: 'platformer.intake',
  phase: 'input',
  run({ world, input }: TickContext): void {
    for (const view of world.query({ has: [PlatformerController, Velocity, BodyState] }).views()) {
      const ctrl = view.get(PlatformerController);
      const vel = view.get(Velocity);
      const body = view.get(BodyState);

      const axis = input.axes['MoveX'];
      let dir = 0;
      if (axis !== undefined && axis !== 0) {
        dir = axis;
      } else {
        if (input.actions['Right'] === true) dir += 1;
        if (input.actions['Left'] === true) dir -= 1;
      }
      vel.dx = dir * ctrl.moveSpeed;
      if (dir > 0) body.facing = 1;
      else if (dir < 0) body.facing = -1;

      if (input.pressed.includes('Jump')) body.jumpBufferRemaining = ctrl.jumpBufferTicks;
    }
  },
};

/**
 * Gravity + the two timing windows. Coyote time is refreshed while grounded and counted down
 * once airborne; a buffered jump launches when grounded **or** still inside the coyote window.
 * A launching tick skips gravity for a clean take-off; otherwise gravity integrates and clamps to
 * terminal velocity. `grounded` here reflects the previous tick's integration (physics runs after
 * this phase), which is exactly the one-tick grace both windows are defined against.
 */
const gravitySystem: System = {
  name: 'platformer.gravity',
  phase: 'update',
  run({ world, dt, tick }: TickContext): void {
    for (const view of world.query({ has: [PlatformerController, Velocity, BodyState] }).views()) {
      const ctrl = view.get(PlatformerController);
      const vel = view.get(Velocity);
      const body = view.get(BodyState);

      if (body.grounded) body.coyoteRemaining = ctrl.coyoteTicks;

      const canJump = body.grounded || body.coyoteRemaining > 0;
      if (body.jumpBufferRemaining > 0 && canJump) {
        const fromGround = body.grounded;
        vel.dy = ctrl.jumpSpeed;
        body.jumpBufferRemaining = 0;
        body.coyoteRemaining = 0;
        body.grounded = false;
        world.events.emit(PLAYER_JUMPED, { tick, fromGround });
      } else {
        vel.dy -= ctrl.gravity * dt;
        if (vel.dy < -ctrl.maxFallSpeed) vel.dy = -ctrl.maxFallSpeed;
        // Count down the windows on airborne ticks, after the jump check so the full
        // `coyoteTicks`/`jumpBufferTicks` are honoured (not consumed by this tick's own test).
        if (!body.grounded && body.coyoteRemaining > 0) body.coyoteRemaining -= 1;
        if (body.jumpBufferRemaining > 0) body.jumpBufferRemaining -= 1;
      }
    }
  },
};

/**
 * Move kinematic platforms along their deterministic track and carry any body resting on one.
 * Runs before integration so the rider's carried displacement is in place when collision resolves;
 * the carry is a position delta (the platform's per-tick movement), added on top of the rider's own
 * input-driven velocity. Emits {@link PLATFORM_BOARDED} on the boarding edge.
 */
const platformSystem: System = {
  name: 'platformer.platform',
  phase: 'physics',
  run({ world, dt, tick }: TickContext): void {
    const riders = world.query({ has: [Transform, Velocity, TileCollider, BodyState] }).views();

    for (const pv of world.query({ has: [KinematicPlatform, Transform] }).views()) {
      const plat = pv.get(KinematicPlatform);
      const pt = pv.get(Transform);
      const anchorX = pt.position.x;
      const anchorY = pt.position.y;

      const curPos = platformAxisPos(plat, tick, dt);
      const prevPos = tick === 0 ? curPos : platformAxisPos(plat, tick - 1, dt);
      const delta = curPos - prevPos;

      const prevBox = platformBoxAt(plat, prevPos, anchorX, anchorY);

      // Move the platform to its position for this tick.
      if (plat.axis === 'x') pt.position.x = curPos;
      else pt.position.y = curPos;

      const platName = world.get(pv.entity, Name)?.value ?? '';

      for (const rv of riders) {
        const rt = rv.get(Transform);
        const col = rv.get(TileCollider);
        const body = rv.get(BodyState);
        const cx = rt.position.x + col.offsetX;
        const cy = rt.position.y + col.offsetY;
        const feet = cy - col.halfHeight;

        const overlapX =
          prevBox.right > cx - col.halfWidth + REST_EPS &&
          prevBox.left < cx + col.halfWidth - REST_EPS;
        const onTop = abs(prevBox.top - feet) <= REST_EPS;

        if (overlapX && onTop) {
          if (plat.axis === 'x') rt.position.x += delta;
          else rt.position.y += delta;
          if (body.carriedBy !== pv.entity) {
            body.carriedBy = pv.entity;
            world.events.emit(PLATFORM_BOARDED, { name: platName });
          }
        } else if (body.carriedBy === pv.entity) {
          body.carriedBy = -1;
        }
      }
    }
  },
};

/** Collect the solid boxes (tiles + platforms) a body could collide with this tick. */
function solidBoxesFor(
  world: World,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  pad: number,
): SolidBox[] {
  const grid = world.getResource(PlatformerCollision) ?? emptyGrid();
  const boxes = tileBoxesNear(grid, cx, cy, hw, hh, pad);
  for (const pv of world.query({ has: [KinematicPlatform, Transform] }).views()) {
    const plat = pv.get(KinematicPlatform);
    const pt = pv.get(Transform);
    boxes.push({
      left: pt.position.x - plat.halfWidth,
      right: pt.position.x + plat.halfWidth,
      bottom: pt.position.y - plat.halfHeight,
      top: pt.position.y + plat.halfHeight,
    });
  }
  return boxes;
}

/**
 * Integrate velocity into position and resolve against solid geometry one axis at a time
 * (horizontal, then vertical), updating `grounded`/`airborneTicks` and emitting
 * {@link PLAYER_LANDED} on the airborne → grounded edge.
 */
const integrateSystem: System = {
  name: 'platformer.integrate',
  phase: 'physics',
  after: ['platformer.platform'],
  run({ world, dt, tick }: TickContext): void {
    for (const view of world
      .query({ has: [Transform, Velocity, TileCollider, BodyState] })
      .views()) {
      const t = view.get(Transform);
      const vel = view.get(Velocity);
      const col = view.get(TileCollider);
      const body = view.get(BodyState);

      const hw = col.halfWidth;
      const hh = col.halfHeight;
      let cx = t.position.x + col.offsetX;
      let cy = t.position.y + col.offsetY;
      const dx = vel.dx * dt;
      const dy = vel.dy * dt;

      const pad = 1 + max(abs(dx), abs(dy));
      const boxes = solidBoxesFor(world, cx, cy, hw, hh, pad);

      const rx = resolveX(boxes, cx, cy, hw, hh, dx);
      cx = rx.cx;
      const ry = resolveY(boxes, cx, cy, hw, hh, dy);
      cy = ry.cy;
      if (ry.grounded && vel.dy < 0) vel.dy = 0;
      if (ry.ceiling && vel.dy > 0) vel.dy = 0;

      const grounded = ry.grounded || restingOn(boxes, cx, cy, hw, hh, REST_EPS);
      const wasGrounded = body.grounded;
      body.grounded = grounded;
      if (grounded) body.airborneTicks = 0;
      else body.airborneTicks += 1;
      if (grounded && !wasGrounded) world.events.emit(PLAYER_LANDED, { tick });

      t.position.x = cx - col.offsetX;
      t.position.y = cy - col.offsetY;
    }
  },
};

/**
 * Dead-zone follow camera: the camera holds still while the target stays inside a dead-zone box,
 * then tracks the target's edge once it leaves — the standard side-scroller rig.
 */
const cameraSystem: System = {
  name: 'platformer.camera',
  phase: 'postUpdate',
  run({ world }: TickContext): void {
    for (const cv of world.query({ has: [PlatformerCamera, Transform] }).views()) {
      const cam = cv.get(PlatformerCamera);
      const ct = cv.get(Transform);
      if (cam.target === '') continue;

      let target: Entity | undefined;
      for (const tv of world.query({ has: [Name, Transform] }).views()) {
        if (tv.get(Name).value === cam.target) {
          target = tv.entity;
          break;
        }
      }
      if (target === undefined) continue;
      const tp = world.get(target, Transform);
      if (tp === undefined) continue;

      const dxErr = tp.position.x - ct.position.x;
      if (dxErr > cam.deadzoneX) ct.position.x = tp.position.x - cam.deadzoneX;
      else if (dxErr < -cam.deadzoneX) ct.position.x = tp.position.x + cam.deadzoneX;

      const dyErr = tp.position.y - ct.position.y;
      if (dyErr > cam.deadzoneY) ct.position.y = tp.position.y - cam.deadzoneY;
      else if (dyErr < -cam.deadzoneY) ct.position.y = tp.position.y + cam.deadzoneY;
    }
  },
};

/** All platformer systems, in registration order (the scheduler resolves final order). */
export const PLATFORMER_SYSTEM_LIST: readonly System[] = [
  intakeSystem,
  gravitySystem,
  platformSystem,
  integrateSystem,
  cameraSystem,
];

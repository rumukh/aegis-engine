import { describe, it, expect } from 'vitest';
import { createWorld, Name, QUAT_IDENTITY, Transform } from '@aegis/core';
import type { World } from '@aegis/core';
import { FpsCamera, LookState } from './components.js';
import { FPS_COLLISION, extrudeFloorplan } from './geometry.js';
import type { FloorplanSpec } from './geometry.js';
import { FpsViewProvider } from './view.js';

/** An open floor `n × n` of `.` tiles (floor 0, ceil 4), origin at the SW corner cell. */
function openFloor(n: number): FloorplanSpec {
  return {
    width: n,
    height: n,
    tileSize: 1,
    origin: { x: 0, z: 0 },
    rows: Array.from({ length: n }, () => '.'.repeat(n)),
    legend: { '.': { solid: false, floor: 0, ceil: 4 } },
  };
}

/**
 * A camera at `(4, 0, 4)` with the given look angles, plus a named beacon entity. The beacon sits
 * one unit east of the camera and well above it, so it is in front of a camera looking up.
 */
function scene(yawDeg: number, pitchDeg: number, beacon: { x: number; y: number; z: number }) {
  const world: World = createWorld({ seed: 'view' });
  world.setResource(FPS_COLLISION, extrudeFloorplan(openFloor(9)));
  world.spawn(
    Transform({ position: { x: 4, y: 0, z: 4 }, rotation: { ...QUAT_IDENTITY } }),
    LookState({ yawDeg, pitchDeg }),
    FpsCamera(),
  );
  world.spawn(
    Name({ value: 'beacon' }),
    Transform({ position: { ...beacon }, rotation: { ...QUAT_IDENTITY } }),
  );
  const frame = new FpsViewProvider().semanticFrame(world);
  return { world, frame, beacon: frame.entities.find((e) => e.name === 'beacon') };
}

describe('FpsViewProvider.semanticFrame — camera basis', () => {
  it('puts an entity to the east on the right half of the screen at level pitch', () => {
    const { frame, beacon } = scene(0, 0, { x: 5, y: 1.6, z: 8 });
    expect(beacon).toBeDefined();
    expect(beacon!.screen.x).toBeGreaterThan(frame.viewport.width / 2);
  });

  // m14 — an invariant pin, **not** a pre-fix regression test, and deliberately labelled as such.
  //
  // The audit reported that at pitch ±90° `worldUp × forward` collapses and `normalize3` returns
  // `(0,0,0)`, projecting every entity to the dead centre of the screen. Measured on `main`, that
  // does not happen: `@aegis/core/math`'s `cos(90°)` is `+6.12e-17`, not `0`, so the cross product
  // is a *positive* speck and `normalize3` recovers `rightFromYaw` bit-for-bit. These assertions
  // therefore pass before the fix as well. They are here because the basis is one rounding sign
  // away from being mirrored (and one underflow away from collapsing) and nothing pinned the
  // property; `cameraRig` now falls back to the yaw-only right vector below the noise floor, so
  // the frame no longer depends on the sign of a 1e-17 artefact.
  it('does not mirror the frame when the camera looks straight up (pitch 90°)', () => {
    const { frame, beacon } = scene(0, 90, { x: 5, y: 10, z: 4 });
    expect(beacon).toBeDefined();
    // The beacon is one unit east; east must stay on the right, exactly as at level pitch.
    expect(beacon!.screen.x).toBeGreaterThan(frame.viewport.width / 2);
    // ...and it must have a real on-screen size, not the zero bounds of a collapsed basis.
    expect(beacon!.bounds!.width).toBeGreaterThan(0);
    expect(beacon!.bounds!.height).toBeGreaterThan(0);
  });

  it('does not mirror the frame when the camera looks straight down (pitch -90°)', () => {
    const { frame, beacon } = scene(0, -90, { x: 5, y: -10, z: 4 });
    expect(beacon).toBeDefined();
    expect(beacon!.screen.x).toBeGreaterThan(frame.viewport.width / 2);
  });

  it('keeps the pole consistent with a pitch just short of it', () => {
    const nearPole = scene(0, 89.9, { x: 5, y: 10, z: 4 });
    const atPole = scene(0, 90, { x: 5, y: 10, z: 4 });
    const centre = nearPole.frame.viewport.width / 2;
    // Both sides of the degenerate boundary must agree about which way is right.
    expect(nearPole.beacon!.screen.x > centre).toBe(atPole.beacon!.screen.x > centre);
  });
});

// m13 — also an invariant pin rather than a pre-fix regression test. `VisibleEntity.entity` is the
// branded `Entity` handle; the fps frame used to derive a raw `number` from the snapshot and force
// it into the frozen contract with `as unknown as`. Numerically the two agree, so no runtime
// assertion can separate them — the defect was that the compiler had *refused* the conversion and
// the author overrode it. The frame now carries the handle straight off the query view, and these
// assertions pin the property the cast was papering over: what the frame reports is a handle the
// world will accept back.
describe('FpsViewProvider.semanticFrame — entity handles', () => {
  it('reports handles the world resolves back to the same entity', () => {
    const { world, beacon } = scene(0, 0, { x: 5, y: 1.6, z: 8 });
    expect(beacon).toBeDefined();
    expect(world.isAlive(beacon!.entity)).toBe(true);
    expect(world.get(beacon!.entity, Name)?.value).toBe('beacon');
  });

  it('omits the camera entity itself (first person sees no self)', () => {
    const { frame } = scene(0, 0, { x: 5, y: 1.6, z: 8 });
    expect(frame.entities.every((e) => e.name === 'beacon')).toBe(true);
  });
});

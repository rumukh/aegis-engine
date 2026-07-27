/**
 * **The screen the human is looking at.** What their hands do must match what their eyes see.
 *
 * Every other test in this package compares one derivation of the input path against another one:
 * `script-input.test.ts` compiles a script through the binding table, replays it back through the
 * same table, and asserts the two reach the same state hash. That is a closed loop. A mirrored
 * look axis is applied identically on both sides of it, so it is invisible **by construction** —
 * which is exactly how the fps mode shipped with a camera that turned left when the mouse moved
 * right, past a green suite, into a human's hands.
 *
 * What was outside every loop was the *screen*. So this file puts it inside one. It drives the
 * real {@link createInputCollector} with the fields a browser actually delivers (`movementX`,
 * `movementY`, `KeyboardEvent.code`), feeds the resulting packet to a real {@link LiveSession}
 * running the real mode systems, syncs the real render adapter, and then **projects a world point
 * through the real three.js camera** to ask where it landed on screen.
 *
 * Every expectation below is derived from what the words mean to a person, not from a recorded
 * value:
 *
 * - *Turning right* means the world slides **left** across your view. A landmark dead ahead ends
 *   up on the left of the screen. This is true of every first-person camera ever built and owes
 *   nothing to this engine's conventions, its handedness, or three.js.
 * - *Looking down* means things at eye level rise in your view — up the screen, i.e. toward
 *   smaller canvas `y`.
 * - *Strafing right* means you end up to the right of where you were, as seen from where you
 *   were standing.
 *
 * ## Why those are facts and not preferences
 *
 * A camera with forward `f` and up `u` has right `r = cross(f, u)` — that is what makes the basis
 * right-handed, and it is the same rule three.js applies (its cameras look down local `-Z`, so
 * `cross(-Z, +Y) = +X`, the local axis NDC `x` increases along). "Turn right" means rotate so `f`
 * sweeps *toward* `r`. A landmark that was on the old `f` is therefore, after the turn, on the
 * side of the new `f` **away** from `r` — i.e. at negative NDC `x`. So:
 *
 * > **turning right ⇒ a fixed landmark ahead moves leftward in NDC.**
 *
 * Nothing in that sentence mentions this engine. Substitute any convention you like for `f` and
 * `u` and it still holds, because the two appearances of `r` cancel. The same argument about the
 * camera's up axis gives *looking down ⇒ a landmark at eye level moves upward in NDC*, and about
 * `r` itself gives *strafing right ⇒ your new position projects to positive NDC x from where you
 * stood*. A reader can check all three without running anything, which is the point: an
 * expectation re-recorded from current behaviour would have pinned the defect instead of catching
 * it, and that is exactly how this criterion passed review the first time.
 *
 * Concretely, and this is what the fps mode got wrong: `mode-fps` defines yaw 0 as `f = (0,0,1)`
 * with its own right vector at `+X` (`geometry.ts` `rightFromYaw`). But `cross((0,0,1),(0,1,0))`
 * is `(-1,0,0)`. The mode's right and the camera's right are opposite vectors, so a mouse move
 * the mode read as "turn right" rendered as a turn to the left. The fix is a sign on the human's
 * input, in this package's binding layer; see `SCREEN_HANDEDNESS` in `bindings.ts`.
 *
 * Pinning a recorded NDC value instead would have pinned the bug. There are no goldens here.
 * @packageDocumentation
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Transform } from '@aegis/core';
import type { World } from '@aegis/core';
import { FpsCamera, LookState, fpsPlugin, rightFromYaw } from '@aegis/mode-fps';
import { BINDINGS } from './bindings.js';
import { createLiveSession } from './session.js';
import type { LiveSession } from './session.js';
import { createInputCollector } from './client/input.js';
import type { InputCollector } from './client/input.js';
import { createFpsAdapter } from './adapters/fps.js';
import type { FpsAdapter } from './adapters/fps.js';
import { FPS_SCENE } from './testing/scenes.js';
import { installFakeDom, keyEvent } from './testing/dom.js';
import type { FakeDom } from './testing/dom.js';

/** Canvas size the rig pretends to render at. Only ratios matter; these are the capture's. */
const VIEWPORT = { width: 1280, height: 720 };

/** A mouse move big enough that no rounding could account for the result. */
const NUDGE_PIXELS = 100;

/**
 * The smallest on-screen movement the assertions accept, in pixels.
 *
 * A sign error moves the landmark by the full turn (>100px at this sensitivity), so this only has
 * to be clear of zero and of any rounding. It is deliberately not tight: this file asserts a
 * *direction*, and a test that also pinned the magnitude would fail on a sensitivity change that
 * broke nothing a human cares about.
 */
const CLEARLY = 20;

/** Everything one first-person rig needs: hardware in, pixels out. */
interface FpsRig {
  session: LiveSession;
  adapter: FpsAdapter;
  collector: InputCollector;
  dom: FakeDom;
  /** Push the collector's packet into the session and advance `ticks` fixed steps. */
  play(ticks: number): void;
  /** Where a world point lands on the canvas, or `null` when it is behind the camera. */
  screenOf(x: number, y: number, z: number): { x: number; y: number } | null;
  /** The player's eye position and look state, read from the live world. */
  eye(): { x: number; y: number; z: number; yawDeg: number; pitchDeg: number };
  dispose(): void;
}

/** Build a first-person rig over the shared fps test scene. */
function fpsRig(): FpsRig {
  const dom = installFakeDom();
  const session = createLiveSession({ scene: FPS_SCENE, plugin: fpsPlugin });
  const adapter = createFpsAdapter({ aspect: VIEWPORT.width / VIEWPORT.height });
  adapter.mount(session.world);
  const collector = createInputCollector({
    canvas: dom.canvas,
    bindings: BINDINGS.fps,
    pick: () => null,
    onCommand: () => undefined,
  });

  const rigView = (world: World) => world.query({ has: [FpsCamera, LookState, Transform] }).one();

  return {
    session,
    adapter,
    collector,
    dom,
    play(ticks: number): void {
      session.input.submit(collector.take());
      for (let i = 0; i < ticks; i++) session.step();
      adapter.sync(session.world);
    },
    screenOf(x: number, y: number, z: number): { x: number; y: number } | null {
      const ndc = new Vector3(x, y, z).project(adapter.camera);
      if (ndc.z > 1) return null;
      return {
        x: ((ndc.x + 1) / 2) * VIEWPORT.width,
        y: ((1 - ndc.y) / 2) * VIEWPORT.height,
      };
    },
    eye() {
      const view = rigView(session.world);
      const position = view.get(Transform).position;
      const look = view.get(LookState);
      return {
        x: position.x,
        y: position.y + view.get(FpsCamera).eyeHeight,
        z: position.z,
        yawDeg: look.yawDeg,
        pitchDeg: look.pitchDeg,
      };
    },
    dispose(): void {
      collector.dispose();
      adapter.dispose();
      dom.restore();
    },
  };
}

/** A world point six units straight ahead of the eye, at eye height. */
function landmarkAhead(rig: FpsRig): { x: number; y: number; z: number } {
  const eye = rig.eye();
  const yaw = (eye.yawDeg * Math.PI) / 180;
  return { x: eye.x + 6 * Math.sin(yaw), y: eye.y, z: eye.z + 6 * Math.cos(yaw) };
}

describe('what the human sees when they move their hands', () => {
  let rig: FpsRig | undefined;
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
  });

  /**
   * Aim the rig, verify the landmark really is dead ahead, move the mouse, and report where the
   * landmark went. Every caller depends on the precondition: an assertion about which way a
   * landmark moved is worthless if it never started in the middle of the screen, or if the mouse
   * event never reached the simulation.
   */
  function nudge(
    movementX: number,
    movementY: number,
  ): {
    before: { x: number; y: number };
    after: { x: number; y: number };
    lookBefore: { yawDeg: number; pitchDeg: number };
    lookAfter: { yawDeg: number; pitchDeg: number };
  } {
    const active = rig as FpsRig;
    active.play(1);
    const landmark = landmarkAhead(active);
    const before = active.screenOf(landmark.x, landmark.y, landmark.z);
    expect(before, 'the landmark must be on screen before the mouse moves').not.toBeNull();
    // Precondition: it is dead ahead, so "moved left" and "moved right" both have room to happen.
    expect(before?.x).toBeCloseTo(VIEWPORT.width / 2, 0);
    expect(before?.y).toBeCloseTo(VIEWPORT.height / 2, 0);
    const lookBefore = { ...active.eye() };

    active.dom.dispatch('mousemove', { movementX, movementY });
    active.play(1);

    const after = active.screenOf(landmark.x, landmark.y, landmark.z);
    expect(after, 'the landmark must still be on screen after a 100px nudge').not.toBeNull();
    const lookAfter = { ...active.eye() };
    // Precondition: the mouse event reached the simulation at all. Without this, a collector that
    // dropped every event would satisfy nothing and fail nothing.
    const moved =
      lookAfter.yawDeg !== lookBefore.yawDeg || lookAfter.pitchDeg !== lookBefore.pitchDeg;
    expect(moved, 'the mouse move must have changed the look state').toBe(true);

    return {
      before: before as { x: number; y: number },
      after: after as { x: number; y: number },
      lookBefore,
      lookAfter,
    };
  }

  it('turns the view right when the mouse moves right', () => {
    rig = fpsRig();
    const { before, after } = nudge(NUDGE_PIXELS, 0);
    // Turning right slides the world left: a landmark that was dead ahead ends up on the left.
    expect(after.x).toBeLessThan(before.x - CLEARLY);
  });

  it("the rendered camera's right vector is the opposite of the mode's own", () => {
    // The prose above argues from `r = cross(f, u)`. This is that argument as an executable
    // statement, so the premise every other test here rests on is checked rather than asserted
    // in a comment — and so the mirror itself is on the record, not only its consequences.
    rig = fpsRig();
    rig.play(1);

    // The camera's local +X in world space: the axis NDC `x` increases along.
    const cameraRight = new Vector3(1, 0, 0).applyQuaternion(rig.adapter.camera.quaternion);
    // Its view direction, i.e. local -Z.
    const forward = new Vector3(0, 0, -1).applyQuaternion(rig.adapter.camera.quaternion);

    // Premise: the camera basis really is right-handed in the stated sense, `r = cross(f, u)`.
    const derived = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
    expect(derived.x).toBeCloseTo(cameraRight.x, 6);
    expect(derived.z).toBeCloseTo(cameraRight.z, 6);

    // The mode's own right vector at this yaw, taken from the mode rather than re-derived here.
    const modeRight = rightFromYaw(rig.eye().yawDeg);
    // Anti-vacuity: a zero vector would satisfy the dot-product test below trivially.
    expect(Math.hypot(modeRight.x, modeRight.z)).toBeCloseTo(1, 6);
    // And they point opposite ways. That single fact is the whole defect: anything a human
    // expresses in screen terms has to be negated on the way into a frame that disagrees with
    // the screen about which way right is.
    expect(cameraRight.x * modeRight.x + cameraRight.z * modeRight.z).toBeLessThan(-0.99);
  });

  it('turns the view left when the mouse moves left', () => {
    rig = fpsRig();
    const { before, after } = nudge(-NUDGE_PIXELS, 0);
    expect(after.x).toBeGreaterThan(before.x + CLEARLY);
  });

  it('looks down when the mouse moves down', () => {
    rig = fpsRig();
    const { before, after, lookAfter } = nudge(0, NUDGE_PIXELS);
    // Tilt your head down and things at eye level rise in your view; canvas y grows downward.
    expect(after.y).toBeLessThan(before.y - CLEARLY);
    // And the simulation agrees about which way is down, so the semantic frame and the picture
    // cannot disagree about pitch even though they disagree about handedness.
    expect(lookAfter.pitchDeg).toBeLessThan(0);
  });

  it('looks up when the mouse moves up', () => {
    rig = fpsRig();
    const { before, after, lookAfter } = nudge(0, -NUDGE_PIXELS);
    expect(after.y).toBeGreaterThan(before.y + CLEARLY);
    expect(lookAfter.pitchDeg).toBeGreaterThan(0);
  });

  it('does not move the view at all when the mouse does not move', () => {
    // The negative control. Without it, a rig whose camera drifted on its own — or one whose
    // "movement" came from the simulation rather than the mouse — would pass every test above.
    rig = fpsRig();
    rig.play(1);
    const landmark = landmarkAhead(rig);
    const before = rig.screenOf(landmark.x, landmark.y, landmark.z);
    rig.play(1);
    const after = rig.screenOf(landmark.x, landmark.y, landmark.z);
    expect(before).not.toBeNull();
    expect(after?.x).toBeCloseTo((before as { x: number }).x, 6);
    expect(after?.y).toBeCloseTo((before as { y: number }).y, 6);
  });

  /**
   * Where does a strafe key put you, as seen from where you were standing?
   *
   * The camera travels with the player, so the question has to be asked from the old viewpoint.
   * Hold the key, then hold the opposite key for the same number of ticks: the player returns to
   * the start (the mode sets velocity directly from the axis, so the two cancel exactly) and the
   * camera with it.
   *
   * The displacement is then carried out to the landmark six units ahead and projected there.
   * Projecting the reached *position* instead would put the point on the camera's own plane —
   * depth zero, NDC infinite — where the sign happens to survive but the number means nothing.
   * Offsetting it to something the camera is actually looking at keeps the measurement finite and
   * asks the human question directly: which side of my view did that step take me toward?
   *
   * Six ticks is 0.6 world units at this scene's `moveSpeed`, comfortably short of the corridor
   * wall — a strafe that ran into it would stop early in one direction and not the other, and the
   * `returned` precondition below is what catches that rather than letting it skew the answer.
   */
  function strafe(code: string): { screenX: number; travelled: number; returned: number } {
    const active = rig as FpsRig;
    active.play(1);
    const start = active.eye();
    const landmark = landmarkAhead(active);

    active.dom.dispatch('keydown', keyEvent(code));
    active.play(6);
    const far = active.eye();

    const opposite = code === 'KeyD' ? 'KeyA' : 'KeyD';
    active.dom.dispatch('keyup', keyEvent(code));
    active.dom.dispatch('keydown', keyEvent(opposite));
    active.play(6);
    active.dom.dispatch('keyup', keyEvent(opposite));
    active.play(1);
    const back = active.eye();

    const travelled = Math.hypot(far.x - start.x, far.z - start.z);
    const returned = Math.hypot(back.x - start.x, back.z - start.z);
    const at = active.screenOf(
      landmark.x + (far.x - start.x),
      landmark.y,
      landmark.z + (far.z - start.z),
    );
    expect(at, 'the displaced landmark must be on screen').not.toBeNull();
    expect(Number.isFinite((at as { x: number }).x)).toBe(true);
    return { screenX: (at as { x: number }).x, travelled, returned };
  }

  it('strafes toward the right of the screen when D is held', () => {
    rig = fpsRig();
    const { screenX, travelled, returned } = strafe('KeyD');
    // Preconditions: the key actually moved the player, and the opposite key brought them back,
    // so the projection below is taken from the same viewpoint the strafe started at.
    expect(travelled).toBeGreaterThan(0.4);
    expect(returned).toBeLessThan(1e-6);
    expect(screenX).toBeGreaterThan(VIEWPORT.width / 2 + CLEARLY);
  });

  it('strafes toward the left of the screen when A is held', () => {
    rig = fpsRig();
    const { screenX, travelled, returned } = strafe('KeyA');
    expect(travelled).toBeGreaterThan(0.4);
    expect(returned).toBeLessThan(1e-6);
    expect(screenX).toBeLessThan(VIEWPORT.width / 2 - CLEARLY);
  });

  it('walks toward what is in the middle of the screen when W is held', () => {
    // Forward is the axis nobody suspected, which is the reason to check it: a mirrored basis
    // "fixed" on the forward axis too would fail here and nowhere else.
    rig = fpsRig();
    rig.play(1);
    const start = rig.eye();
    const landmark = landmarkAhead(rig);
    const before = rig.screenOf(landmark.x, landmark.y, landmark.z);
    expect(before?.x).toBeCloseTo(VIEWPORT.width / 2, 0);
    const distanceBefore = Math.hypot(landmark.x - start.x, landmark.z - start.z);

    rig.dom.dispatch('keydown', keyEvent('KeyW'));
    rig.play(6);
    rig.dom.dispatch('keyup', keyEvent('KeyW'));
    const far = rig.eye();

    expect(Math.hypot(far.x - start.x, far.z - start.z)).toBeGreaterThan(0.4);
    // "Forward" means toward the thing in the centre of the view: it stays centred and gets
    // closer. Either half alone would pass for a sideways or backwards walk.
    const after = rig.screenOf(landmark.x, landmark.y, landmark.z);
    expect(after).not.toBeNull();
    expect(after?.x).toBeCloseTo(VIEWPORT.width / 2, 0);
    expect(Math.hypot(landmark.x - far.x, landmark.z - far.z)).toBeLessThan(distanceBefore - 0.4);
  });
});

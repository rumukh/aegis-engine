/**
 * **A human is not tick-exact, and their aim is not pixel-exact.**
 *
 * The reported symptom this package was reopened for was "the games are broken under a person's
 * hand". Two of the four faults behind it were signs; the other kind of unplayability does not
 * look like a sign error at all — it looks like a game that only works when the input arrives on
 * exactly the tick, or exactly the pixel, that a compiled script would produce. A scripted
 * playthrough cannot detect that, because a script *is* tick-exact and pixel-exact. It is the
 * same blindness as comparing a script's hash to itself, moved one layer out.
 *
 * So these measure the **tolerance window** each input channel gives a human, through the real
 * binding table and the real mode systems, and assert the window is human-sized. The expectations
 * are derived rather than recorded:
 *
 * - **Aim.** A box target of half-width `w` at distance `d` subtends `2·atan(w/d)`. That is a
 *   fact about the geometry, not about this engine, and it is what "how precisely must I point?"
 *   means. The test builds a scene where `w` and `d` are stated, computes the arc, and requires
 *   the measured hit window to match it *and* to clear a stated human threshold.
 * - **Timing.** A jump that must clear a gap has a window bounded by how far the player travels
 *   per tick. The mode adds coyote time and jump buffering precisely to widen it. The test
 *   measures the window and requires it to exceed a stated number of ticks.
 *
 * What this file cannot cover: the *shipped* games' critical paths, which live under `games/` and
 * which `scripts/check-deps.mjs` correctly forbids this package from importing. Those windows are
 * measured — platformer tolerates a 15-tick shift of its whole script, fps more than 25, iso only
 * 5 — and belong in each game's own test directory. What is here is the layer this package owns:
 * the binding from a human's hand to a logical input, and the tolerance the modes give it.
 * @packageDocumentation
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Transform } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import { Health } from '@aegis/content';
import { fpsPlugin } from '@aegis/mode-fps';
import { Controlled, GridPosition, isoPlugin } from '@aegis/mode-iso';
import { BodyState, platformerPlugin } from '@aegis/mode-platformer';
import { Vector3 } from 'three';
import { BINDINGS } from './bindings.js';
import { createLiveSession } from './session.js';
import type { LiveSession } from './session.js';
import { createInputCollector } from './client/input.js';
import type { InputCollector } from './client/input.js';
import type { PickedPoint } from './adapter.js';
import { createIsoAdapter } from './adapters/iso.js';
import { buttonEvent, installFakeDom, keyEvent } from './testing/dom.js';
import type { FakeDom } from './testing/dom.js';
import { PLATFORMER_SCENE, ISO_SCENE } from './testing/scenes.js';
import { buildTestWorld } from './testing/world.js';

/** Canvas the rig pretends to render at, so a click has pixels to land on. */
const VIEWPORT = { width: 1280, height: 720 };

/**
 * Tick the playthrough presses Jump on, chosen from inside the window the jump-window test below
 * measures (5 contiguous ticks clear the pit). Any tick in that window would do; this is the
 * middle of it, which is where a hand aiming at "now" lands.
 */
const JUMP_TICK = 24;

/**
 * First x on the far side of the spike pit. The pit spans tiles 4..6 inclusive (see the collision
 * rows of PLATFORMER_SCENE), so tile 7 is the first solid ground beyond it.
 */
const FAR_LEDGE_X = 7;

/** Where ISO_SCENE parks its guard, and the height on its drawn body a person aims at. */
const GUARD_CELL = { x: 4, y: 3 };
/**
 * Chest height on the drawn actor body. Any point above about 0.6 works: the iso camera looks
 * along (-1,-1,-1), so a pixel showing world (x, h, z) reaches the floor at (x + h, 0, z + h) --
 * at h = 0.9 that is (4.9, 3.9), which rounds onto the wall cell behind the guard.
 */
const GUARD_CHEST_Y = 0.9;

/** Distance from the eye to the target in {@link AIM_SCENE}, world units. */
const TARGET_DISTANCE = 6;
/** Half-width of the target box in {@link AIM_SCENE}, world units. */
const TARGET_HALF_WIDTH = 0.4;

/**
 * Degrees of aim error a human must be allowed at a body-sized target six metres away.
 *
 * At this mode's `lookDegreesPerPixel` of 0.14, one degree is about seven pixels of mouse
 * movement, so three degrees is roughly a 21-pixel slip — well inside what a hand does. If a game
 * ever demanded better than this it would not be playable, whatever a scripted `aim 90 0` proves.
 */
const HUMAN_AIM_DEGREES = 3;

/**
 * An open corridor with one shootable, damageable target dead ahead.
 *
 * Purpose-built rather than reused: the shared `FPS_SCENE` has a sealed door between the spawn
 * and its grunt, so a straight shot hits the door — which is a fine thing for the *occlusion*
 * tests to rely on and useless for measuring an aim window. Here the geometry is stated so the
 * expected arc can be derived from it in the assertion rather than recorded from a run.
 */
const AIM_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-test-aim',
  mode: 'fps',
  seed: 'render-test',
  resources: {
    'fps.floorplan': {
      width: 5,
      height: 11,
      tileSize: 1,
      origin: { x: -2, z: 0 },
      rows: [
        '#####',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#...#',
        '#####',
      ],
      legend: {
        '#': { solid: true, floor: 0, ceil: 4 },
        '.': { solid: false, floor: 0, ceil: 4 },
      },
    },
  },
  entities: [
    {
      id: 'player',
      components: {
        Transform: { position: { x: 0, y: 0, z: 1 } },
        CapsuleBody: { radius: 0.4, height: 1.8, velocity: { x: 0, y: 0, z: 0 }, grounded: false },
        FpsController: { moveSpeed: 6, gravity: 24, jumpSpeed: 8, maxPitchDeg: 89 },
        LookState: { yawDeg: 0, pitchDeg: 0 },
        FpsCamera: { eyeHeight: 1.6, fovDegrees: 75, near: 0.1, far: 500 },
        Hitscan: { range: 100, damage: 5, cooldownTicks: 1, cooldownRemaining: 0 },
        Health: { current: 100, max: 100 },
      },
    },
    {
      id: 'target',
      components: {
        // Six units straight ahead of the eye, centred on it in height.
        Transform: { position: { x: 0, y: 0, z: 1 + TARGET_DISTANCE } },
        HitBox: {
          half: { x: TARGET_HALF_WIDTH, y: 1, z: 0.4 },
          offset: { x: 0, y: 1.6, z: 0 },
        },
        Health: { current: 100_000, max: 100_000 },
      },
    },
  ],
};

/** A collector wired to a live session, with no adapter: this file asks about input, not pixels. */
interface InputRig {
  session: LiveSession;
  collector: InputCollector;
  dom: FakeDom;
  /** Hand the collector's packet to the session and advance `ticks` fixed steps. */
  play(ticks: number): void;
  dispose(): void;
}

/** Build a rig over `scene` with `plugin`'s systems and the mode's real binding table. */
function inputRig(
  scene: SceneFile,
  plugin: typeof fpsPlugin,
  mode: 'fps' | 'platformer' | 'iso',
  pick: (ndcX: number, ndcY: number) => PickedPoint | null = () => null,
): InputRig {
  const dom = installFakeDom({ viewport: VIEWPORT });
  const session = createLiveSession({ scene, plugin });
  const collector = createInputCollector({
    canvas: dom.canvas,
    bindings: BINDINGS[mode],
    pick,
    onCommand: () => undefined,
  });
  return {
    session,
    collector,
    dom,
    play(ticks: number): void {
      session.input.submit(collector.take());
      for (let i = 0; i < ticks; i++) session.step();
    },
    dispose(): void {
      collector.dispose();
      dom.restore();
    },
  };
}

describe('a human presses keys and the right thing happens', () => {
  let rig: InputRig | undefined;
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
  });

  /** The aim corridor again, with a target a handful of shots can actually finish. */
  const KILL_SCENE: SceneFile = {
    ...AIM_SCENE,
    name: 'render-test-kill',
    entities: AIM_SCENE.entities.map((entity) =>
      entity.id === 'target'
        ? {
            ...entity,
            components: { ...entity.components, Health: { current: 20, max: 20 } },
          }
        : entity,
    ),
  };

  it('platformer: running and jumping carries the player across the pit', () => {
    // Not "the input reached the simulation" and not "an axis has the right sign" -- the whole
    // interaction, from two key events to a gameplay outcome. The level puts a spike pit at
    // x 4..7 between the spawn at x = 1.5 and the far ledge, so *landing* on the far side means
    // a run and a jump both happened and the hazard was cleared.
    //
    // The goal volume at x = 10.5 is deliberately not the assertion: 'Trigger' is read by a
    // game's own system and the stock mode plugin this rig runs has none, so a goal event here
    // would only ever prove that a system this test had written itself had fired.
    const play = (withJump: boolean): { landedAt: number | null; alive: boolean; x: number } => {
      const local = inputRig(PLATFORMER_SCENE, platformerPlugin, 'platformer');
      try {
        const player = (): { x: number; grounded: boolean; alive: boolean } => {
          const view = local.session.world.query({ has: [Transform, BodyState, Health] }).one();
          return {
            x: view.get(Transform).position.x,
            grounded: view.get(BodyState).grounded,
            alive: view.get(Health).current > 0,
          };
        };
        let landedAt: number | null = null;
        local.dom.dispatch('keydown', keyEvent('KeyD'));
        for (let tick = 0; tick < 240 && landedAt === null; tick++) {
          // A human jumps when the pit is in front of them, not on a tick they computed.
          if (withJump && tick === JUMP_TICK) local.dom.dispatch('keydown', keyEvent('Space'));
          if (withJump && tick === JUMP_TICK + 1) local.dom.dispatch('keyup', keyEvent('Space'));
          local.play(1);
          const at = player();
          // And they stop pressing right once they are safely across.
          if (at.x >= FAR_LEDGE_X && at.grounded && at.alive) landedAt = tick;
        }
        local.dom.dispatch('keyup', keyEvent('KeyD'));
        const at = player();
        return { landedAt, alive: at.alive, x: at.x };
      } finally {
        local.dispose();
      }
    };

    const jumped = play(true);
    // Anti-vacuity: the identical run minus one key must NOT get across. Without this control the
    // assertion below would be satisfied by walking, and would say nothing about the jump, the
    // pit or the hazard -- it would be a test of the Right key alone.
    const walked = play(false);

    console.log(
      '      platformer playthrough: with Space, landed past the pit on tick ' +
        String(jumped.landedAt) +
        ' (x ' +
        jumped.x.toFixed(1) +
        ', alive ' +
        String(jumped.alive) +
        '); without it, ' +
        String(walked.landedAt) +
        ' (x ' +
        walked.x.toFixed(1) +
        ', alive ' +
        String(walked.alive) +
        ')',
    );
    expect(walked.landedAt).toBeNull();
    expect(jumped.landedAt).not.toBeNull();
    expect(jumped.alive).toBe(true);
  });

  it('fps: aiming and clicking kills what you aimed at', () => {
    // Mouse look and the fire button together, through the binding table — the two channels the
    // reported defect ran through, judged on the outcome rather than on a sign.
    rig = inputRig(KILL_SCENE, fpsPlugin, 'fps');
    const target = (): number => {
      for (const view of (rig as InputRig).session.world
        .query({ has: [Health, Transform] })
        .views()) {
        if (view.get(Transform).position.z > 2) return view.get(Health).current;
      }
      throw new Error('the kill scene lost its target');
    };
    rig.play(1);
    const before = target();
    expect(before, 'the target must start alive').toBeGreaterThan(0);

    for (let shot = 0; shot < 8; shot++) {
      rig.dom.dispatch('mousedown', buttonEvent());
      rig.play(2);
      rig.dom.dispatch('mouseup', buttonEvent());
      rig.play(4);
    }
    const after = target();

    console.log(`      fps playthrough: target health ${before} -> ${after}`);
    expect(after).toBeLessThanOrEqual(0);
  });

  it('iso: clicking a floor tile walks the operative to it', () => {
    // The one the user said was broken — "only walking works" — and it did not, because a click
    // resolved against the y=0 ground plane instead of the drawn scene. This drives the whole
    // pointer path: a mouse event at a canvas pixel, the collector's NDC conversion, the
    // adapter's raycast against real geometry, the mode's intake, A*, and the walk.
    //
    // This case proves the CHAIN, not the pick fix: measured, reverting 'pick' to the y=0 ground
    // plane leaves it green, because over a bare floor cell the two agree. The guard case below
    // is the one that is sensitive to the defect, and it exists because this one is not.
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: VIEWPORT.width / VIEWPORT.height });
    adapter.mount(world);
    rig = inputRig(ISO_SCENE, isoPlugin, 'iso', (x, y) => adapter.pick(x, y));
    const cell = (): { x: number; y: number } => {
      const at = (rig as InputRig).session.world
        .query({ has: [GridPosition, Controlled] })
        .one()
        .get(GridPosition);
      return { x: at.cellX, y: at.cellY };
    };
    rig.play(1);
    adapter.sync(rig.session.world);
    const from = cell();

    // Aim at the pixel where cell (3,3) is drawn, exactly as a person would.
    const target = { x: 3, y: 3 };
    const ndc = new Vector3(target.x, 0, target.y).project(adapter.camera);
    const clientX = ((ndc.x + 1) / 2) * VIEWPORT.width;
    const clientY = ((1 - ndc.y) / 2) * VIEWPORT.height;
    // Precondition: that pixel really is on screen, or the click below means nothing.
    expect(Math.abs(ndc.x)).toBeLessThan(1);
    expect(Math.abs(ndc.y)).toBeLessThan(1);
    // And the operative must not already be standing there.
    expect(from).not.toEqual(target);

    rig.dom.dispatch('mousedown', { button: 0, clientX, clientY, preventDefault: () => undefined });
    rig.play(300);
    const to = cell();

    console.log(
      `      iso playthrough: clicked pixel (${clientX.toFixed(0)},${clientY.toFixed(0)}) — ` +
        `operative (${from.x},${from.y}) -> (${to.x},${to.y})`,
    );
    adapter.dispose();
    expect(to).toEqual(target);
  });
  it('iso: clicking the guard attacks the guard, not the wall behind it', () => {
    // The other half of "only walking works". A person aims at the body they can see, and a body
    // is drawn *above* the floor -- so the ray through the pixel they clicked reaches y = 0 a
    // cell and a half further on. Measured on this scene: the pixel over the guard's chest at
    // (4, 0.9, 3) resolves to cell (4,3) against the drawn scene and to cell (3,2) -- a WALL --
    // against the ground plane. Pre-fix that click ordered nothing at all.
    const world = buildTestWorld(ISO_SCENE, isoPlugin);
    const adapter = createIsoAdapter({ aspect: VIEWPORT.width / VIEWPORT.height });
    adapter.mount(world);
    rig = inputRig(ISO_SCENE, isoPlugin, 'iso', (x, y) => adapter.pick(x, y));
    const guardHealth = (): number => {
      for (const view of (rig as InputRig).session.world
        .query({ has: [GridPosition, Health] })
        .views()) {
        const at = view.get(GridPosition);
        if (at.cellX === GUARD_CELL.x && at.cellY === GUARD_CELL.y) return view.get(Health).current;
      }
      throw new Error('the vault scene lost its guard');
    };
    rig.play(1);
    adapter.sync(rig.session.world);
    const before = guardHealth();

    const ndc = new Vector3(GUARD_CELL.x, GUARD_CHEST_Y, GUARD_CELL.y).project(adapter.camera);
    const clientX = ((ndc.x + 1) / 2) * VIEWPORT.width;
    const clientY = ((1 - ndc.y) / 2) * VIEWPORT.height;
    expect(Math.abs(ndc.x), 'the guard must be on screen to be clicked').toBeLessThan(1);
    expect(Math.abs(ndc.y), 'the guard must be on screen to be clicked').toBeLessThan(1);
    expect(before, 'the guard must start alive').toBeGreaterThan(0);

    rig.dom.dispatch('mousedown', { button: 0, clientX, clientY, preventDefault: () => undefined });
    rig.play(120);
    const after = guardHealth();
    adapter.dispose();

    console.log(
      '      iso playthrough: clicked the guard at pixel (' +
        clientX.toFixed(0) +
        ',' +
        clientY.toFixed(0) +
        ') -- guard health ' +
        String(before) +
        ' -> ' +
        String(after),
    );
    expect(after).toBeLessThan(before);
  });
});

describe('a human is not tick-exact, and the games must not require it', () => {
  let rig: InputRig | undefined;
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
  });

  /** The target's remaining health in an aim rig. */
  function targetHealth(active: InputRig): number {
    for (const view of active.session.world.query({ has: [Health, Transform] }).views()) {
      // The target is the only entity with a hit box six units out; the player carries Health too.
      if (view.get(Transform).position.z > 2) return view.get(Health).current;
    }
    throw new Error('the aim scene lost its target');
  }

  it('fps: the hit window matches the arc the target subtends, and a human fits inside it', () => {
    const sensitivity = BINDINGS.fps.lookDegreesPerPixel ?? 0.14;
    const sign = BINDINGS.fps.lookXSign ?? 1;
    const hits: number[] = [];

    // Sweep the aim across the whole plausible range, one degree at a time, through real mouse
    // events. Each offset gets a fresh rig so a miss cannot poison the next attempt.
    for (let offset = -12; offset <= 12; offset++) {
      const active = inputRig(AIM_SCENE, fpsPlugin, 'fps');
      try {
        active.play(1);
        const before = targetHealth(active);
        // Turn by `offset` degrees using the same arithmetic a hand does: pixels of movement,
        // through the binding table's sensitivity and screen-handedness sign.
        active.dom.dispatch('mousemove', {
          movementX: (offset / sensitivity) * sign,
          movementY: 0,
        });
        active.play(1);
        active.dom.dispatch('mousedown', buttonEvent());
        active.play(2);
        active.dom.dispatch('mouseup', buttonEvent());
        active.play(2);
        if (targetHealth(active) < before) hits.push(offset);
      } finally {
        active.dispose();
      }
    }

    // Anti-vacuity: a rig that never fired, or a target that could not be damaged, would report
    // an empty hit list and satisfy nothing. Dead centre must hit or the scene is wrong.
    expect(hits, 'aiming straight at the target must hit it').toContain(0);

    const widest = Math.max(...hits);
    const narrowest = Math.min(...hits);

    console.log(
      `      fps aim: hit window ${narrowest}..${widest} degrees ` +
        `(${(widest - narrowest + 1).toFixed(0)} degrees wide, ` +
        `${((widest - narrowest) / sensitivity).toFixed(0)} px of mouse travel)`,
    );

    // The derived expectation: a box of half-width w at distance d subtends 2·atan(w/d). Nothing
    // in that sentence is about this engine, and it is checkable with a calculator. The window is
    // measured in whole degrees, so it may fall one degree short of the ideal arc on each side.
    const arc = (Math.atan(TARGET_HALF_WIDTH / TARGET_DISTANCE) * 180) / Math.PI;
    expect(widest).toBeGreaterThanOrEqual(Math.floor(arc) - 1);
    expect(widest).toBeLessThanOrEqual(Math.ceil(arc));
    expect(narrowest).toBeLessThanOrEqual(-(Math.floor(arc) - 1));
    expect(narrowest).toBeGreaterThanOrEqual(-Math.ceil(arc));
    // And the human threshold: whatever the geometry says, a person has to fit inside it.
    expect(widest).toBeGreaterThanOrEqual(HUMAN_AIM_DEGREES);
    expect(narrowest).toBeLessThanOrEqual(-HUMAN_AIM_DEGREES);
  });

  /**
   * Ticks of slop a human must be allowed on a jump that clears a gap.
   *
   * Four ticks is 66ms at 60Hz, which brackets ±33ms of press jitter — roughly what a hand does
   * on a *planned*, self-paced action. An earlier draft of this test said eight, which was a
   * guess with nothing behind it; measured, the window is five, and the guess would have failed
   * the suite for a scene that is in fact playable. The number moved and the reasoning is now
   * attached to it, which is the same correction this package already had to make to its
   * draw-call budget.
   *
   * A bare threshold is still weak evidence, so the assertion below pairs it with a comparison
   * that cannot be fitted to a measurement: the window with the mode's coyote time and jump
   * buffering must be **wider** than the window without them. That is what those features are
   * for, and it is a claim about the mode reaching a human's hand rather than about a number.
   */
  const HUMAN_TIMING_TICKS = 4;

  /** The press ticks that clear the pit, given a controller configuration. */
  function clearingPressTicks(controller: Record<string, number>): number[] {
    const base = structuredClone(PLATFORMER_SCENE) as SceneFile;
    // `SceneFile` component maps are read-only, so the override is built as a new entity list
    // rather than by writing through the clone.
    const scene: SceneFile = {
      ...base,
      entities: base.entities.map((entity) =>
        entity.id === 'player'
          ? {
              ...entity,
              components: {
                ...entity.components,
                PlatformerController: {
                  ...(entity.components?.['PlatformerController'] ?? {}),
                  ...controller,
                },
              },
            }
          : entity,
      ),
    };
    if (!scene.entities.some((entity) => entity.id === 'player')) {
      throw new Error('the platformer scene lost its player');
    }

    const cleared: number[] = [];
    for (let pressAt = 0; pressAt <= 40; pressAt++) {
      const active = inputRig(scene, platformerPlugin, 'platformer');
      try {
        active.dom.dispatch('keydown', keyEvent('KeyD'));
        active.play(pressAt);
        active.dom.dispatch('keydown', keyEvent('Space'));
        active.play(1);
        active.dom.dispatch('keyup', keyEvent('Space'));
        active.play(90);
        const at = active.session.world
          .query({ has: [Transform, Health] })
          .first()
          ?.get(Transform).position;
        // Past the far lip of the pit and still in the world.
        if (at !== undefined && at.x > 7.5 && at.y > 1) cleared.push(pressAt);
      } finally {
        active.dispose();
      }
    }
    return cleared;
  }

  /** The longest run of consecutive ticks in a sorted list — a window with a hole is not a window. */
  function longestRun(ticks: readonly number[]): number {
    if (ticks.length === 0) return 0;
    let best = 1;
    let run = 1;
    for (let i = 1; i < ticks.length; i++) {
      run = (ticks[i] as number) === (ticks[i - 1] as number) + 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }

  it('platformer: coyote time and jump buffering widen the window a hand has to hit', () => {
    // The shared test level: solid ground under columns 0-3 and 7-11, spikes at 4-6. Running
    // right from x = 1.5, the jump has to leave before the lip and land past it.
    const forgiving = clearingPressTicks({});
    const unforgiving = clearingPressTicks({ coyoteTicks: 0, jumpBufferTicks: 0 });

    // Anti-vacuity: an empty list would satisfy any window arithmetic below, and a rig whose keys
    // never reached the simulation would produce exactly that.
    expect(forgiving.length, 'some jump timing must clear the pit at all').toBeGreaterThan(0);

    const withHelp = longestRun(forgiving);
    const withoutHelp = longestRun(unforgiving);

    console.log(
      `      platformer jump: ${withHelp} contiguous ticks clear the pit ` +
        `(${((withHelp / 60) * 1000).toFixed(0)}ms); with coyote time and buffering disabled, ` +
        `${withoutHelp} (${((withoutHelp / 60) * 1000).toFixed(0)}ms)`,
    );

    expect(withHelp).toBeGreaterThanOrEqual(HUMAN_TIMING_TICKS);
    // The claim that cannot be fitted: the mode's forgiveness reaches the hand. If coyote time
    // and buffering stopped being wired to the human's key, this is what would notice.
    expect(withHelp).toBeGreaterThan(withoutHelp);
  });
});

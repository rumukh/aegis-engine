/**
 * Click-to-move: the iso mode's defining mechanic (CHARTER §4.1), driven end to end from a
 * **compiled** input script rather than a hand-written {@link InputFrame}.
 *
 * Two gaps close here.
 *
 * 1. `intakeSystem` reads `input.pointer`, and until now no unit test anywhere in `mode-iso`
 *    constructed a pointer, a button or an input frame at all. The pointer path was exercised
 *    only through the game acceptance test, so its coverage depended on that game's script
 *    happening to click, and a regression surfaced as a changed state hash rather than as a
 *    failing assertion that names the mechanic.
 * 2. Both mode test suites *fabricate* frames by hand. That is how `mode-fps`'s fixture carried a
 *    malformed `InputFrame` (no `released`, no `pointer`) for the life of the project — latent
 *    rather than live, because no fps system reads those fields, and invisible until test files
 *    were type-checked for the first time. The consequence is that the mode↔harness input seam
 *    had no test from either side: the harness asserts what `parseInputScript(...).frames()`
 *    emits, the modes assert against frames someone typed, and nobody asserted the two agree.
 *
 * So every frame in this file comes out of the real DSL compiler, served through a real
 * {@link InputSource} — the same path {@link runScene} uses. A frame the mode cannot drive, or a
 * compiler that stops emitting a field the mode reads, fails here.
 */
import { describe, it, expect } from 'vitest';
import {
  createSchedule,
  createSimulation,
  createWorld,
  EMPTY_INPUT_FRAME,
  Name,
} from '@aegis/core';
import type { InputFrame, InputSource, World } from '@aegis/core';
import { Health } from '@aegis/content';
import { parseInputScript } from '@aegis/harness';
import {
  AttackOrder,
  Attacker,
  Blocking,
  Controlled,
  GridPosition,
  IsoActor,
  MoveOrder,
  NavGrid,
} from './components.js';
import type { IsoGridConfig } from './components.js';
import { buildNavGrid } from './grid.js';
import { isoSystems } from './plugin.js';
import { ATTACK_ORDERED, CELL_ENTERED, MOVE_ORDERED, PATH_BLOCKED } from './events.js';

const TICK_RATE = 60;

/** An open grid of the given size with no static walls. */
function openGrid(width: number, height: number): IsoGridConfig {
  return {
    width,
    height,
    tileSize: 1,
    walls: Array.from({ length: height }, () => '.'.repeat(width)),
  };
}

/**
 * Compile `text` through the real input DSL and return both the frames and an {@link InputSource}
 * that serves them, padding out-of-range ticks with an idle frame — the same contract
 * `@aegis/harness`'s runner uses internally.
 *
 * A parse failure throws with the compiler's own structured diagnostics rather than a bare
 * `undefined`, so a typo in a script here reads as a diagnosable error instead of a null deref
 * three frames later.
 */
function compiled(
  text: string,
  ticks: number,
): { frames: readonly InputFrame[]; source: InputSource } {
  const parsed = parseInputScript(text);
  if (!parsed.ok || parsed.value === undefined) {
    const detail = parsed.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ');
    throw new Error(`input script failed to compile: ${detail}`);
  }
  const frames = parsed.value.frames(ticks);
  return {
    frames,
    source: {
      frameFor: (tick: number): InputFrame => frames[tick] ?? { ...EMPTY_INPUT_FRAME, tick },
    },
  };
}

/** A world with a baked nav grid and event recording on. */
function makeWorld(config: IsoGridConfig): World {
  const world = createWorld({ seed: 'iso-pointer', recordEvents: true });
  world.setResource(NavGrid, buildNavGrid(config));
  return world;
}

/** Spawn the controlled operative at a cell. */
function spawnOperative(world: World, cellX: number, cellY: number) {
  return world.spawn(
    GridPosition({ cellX, cellY }),
    IsoActor({ speed: 4 }),
    Health({ current: 30, max: 30 }),
    Controlled(),
    Name({ value: 'operative' }),
  );
}

/** Run the full iso pipeline for `ticks` ticks, fed by a compiled script. */
function run(world: World, source: InputSource, ticks: number): void {
  const sim = createSimulation({
    world,
    schedule: createSchedule().addAll(isoSystems()),
    tickRate: TICK_RATE,
    input: source,
  });
  sim.run(ticks);
}

/** The payloads (in order) of every event of `type`. */
function payloads<T>(world: World, type: string): T[] {
  return world.events
    .history()
    .filter((e) => e.type === type)
    .map((e) => e.data as T);
}

describe('compiled input frames satisfy the contract the mode reads', () => {
  it('emits every InputFrame field, not just the ones a mode happens to use', () => {
    // The structural half. `mode-fps` shipped a fixture missing `released` and `pointer` for the
    // life of the project because no fps system read them; nothing compared a fabricated frame
    // against the real thing. Compare the compiler's output against the canonical idle frame, so
    // a field that stops being emitted fails here rather than in whichever mode reads it next.
    const { frames } = compiled('click 4,7 @0', 3);
    expect(frames).toHaveLength(3); // guard: the loop below must not pass vacuously
    for (const frame of frames) {
      expect(Object.keys(frame).sort()).toEqual(Object.keys(EMPTY_INPUT_FRAME).sort());
    }
    // And the contract is not empty — if `EMPTY_INPUT_FRAME` itself lost a field, comparing the
    // two key sets would still agree, so pin the count the mode was written against.
    expect(Object.keys(EMPTY_INPUT_FRAME)).toHaveLength(7);
  });

  it('compiles `click x,y @t` into a primary-button pointer on exactly that tick', () => {
    const { frames } = compiled('click 4,7 @1', 3);
    expect(frames[0]!.pointer).toBeNull();
    expect(frames[2]!.pointer).toBeNull(); // a click is a one-tick edge, not a held state
    const pointer = frames[1]!.pointer;
    expect(pointer).not.toBeNull();
    expect(pointer!.buttons).toEqual(['primary']);
    // `intakeSystem` rounds `pointer.world` to a cell, so the world projection must be present.
    expect(pointer!.world).toEqual({ x: 4, y: 7, z: 0 });
  });

  it('compiles `point x,y @t` into a pointer with no buttons', () => {
    const { frames } = compiled('point 4,7 @0', 2);
    expect(frames[0]!.pointer).not.toBeNull();
    expect(frames[0]!.pointer!.buttons).toEqual([]);
  });
});

describe('click-to-move driven by a compiled input script', () => {
  it('turns a compiled click into a MoveOrder for the clicked cell', () => {
    const world = makeWorld(openGrid(8, 8));
    const actor = spawnOperative(world, 1, 1);
    const { source } = compiled('click 4,7 @0', 4);

    run(world, source, 1);

    expect(world.has(actor, MoveOrder)).toBe(true);
    const order = world.getOrThrow(actor, MoveOrder);
    expect(order.target).toEqual({ x: 4, y: 7 });
    expect(order.resolved).toBe(true);
    const ordered = payloads<{ target: { x: number; y: number } }>(world, MOVE_ORDERED);
    expect(ordered).toHaveLength(1);
    expect(ordered[0]!.target).toEqual({ x: 4, y: 7 });
  });

  it('walks the operative to the clicked cell and drops the order on arrival', () => {
    const world = makeWorld(openGrid(8, 8));
    const actor = spawnOperative(world, 1, 1);
    const { source } = compiled('click 4,7 @0', 4);

    // Manhattan distance 9 at speed 4 (dt = 1/60) is 15 ticks per cell; 150 is comfortably past.
    run(world, source, 150);

    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 4, y: 7 });
    expect(world.has(actor, MoveOrder)).toBe(false); // arrived, order cleared
    expect(world.events.count(CELL_ENTERED)).toBe(9); // one per cell of the path, no repeats
  });

  it('ignores a pointer with no primary button — `point` must not move the operative', () => {
    const world = makeWorld(openGrid(8, 8));
    const actor = spawnOperative(world, 1, 1);
    const { source } = compiled('point 4,7 @0', 4);

    run(world, source, 30);

    expect(world.has(actor, MoveOrder)).toBe(false);
    expect(world.events.contains(MOVE_ORDERED)).toBe(false);
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 1, y: 1 }); // never left
  });

  it('issues no order on the idle ticks around the click', () => {
    const world = makeWorld(openGrid(8, 8));
    spawnOperative(world, 1, 1);
    const { source } = compiled('click 3,1 @2', 6);

    run(world, source, 6);

    // Exactly one order, and it lands on the tick the script says — not on every tick the
    // pointer's *position* would still be under the cursor in a live adapter.
    const ticks = world.events
      .history()
      .filter((e) => e.type === MOVE_ORDERED)
      .map((e) => e.tick);
    expect(ticks).toEqual([2]);
  });

  it('retargets cleanly when a second click arrives mid-walk', () => {
    const world = makeWorld(openGrid(8, 8));
    const actor = spawnOperative(world, 1, 1);
    const { source } = compiled('click 6,1 @0\nclick 1,4 @30', 40);

    run(world, source, 200);

    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 1, y: 4 }); // the second click wins
    expect(world.events.count(MOVE_ORDERED)).toBe(2);
  });
});

describe('click-to-attack driven by a compiled input script', () => {
  it('turns a click on a living actor into an AttackOrder, not a MoveOrder', () => {
    const world = makeWorld(openGrid(8, 8));
    const actor = spawnOperative(world, 1, 1);
    const guard = world.spawn(
      GridPosition({ cellX: 4, cellY: 1 }),
      IsoActor({ speed: 4 }),
      Health({ current: 20, max: 20 }),
      Name({ value: 'guard' }),
    );

    const { source } = compiled('click 4,1 @0', 4);
    run(world, source, 1);

    expect(world.has(actor, AttackOrder)).toBe(true);
    expect(world.has(actor, MoveOrder)).toBe(false);
    expect(world.getOrThrow(actor, AttackOrder).target).toBe(guard);
    expect(world.events.count(ATTACK_ORDERED)).toBe(1);
    expect(world.events.contains(MOVE_ORDERED)).toBe(false);
  });

  it('treats a click on a dead actor as ground, not as a target', () => {
    const world = makeWorld(openGrid(8, 8));
    const actor = spawnOperative(world, 1, 1);
    world.spawn(
      GridPosition({ cellX: 4, cellY: 1 }),
      IsoActor({ speed: 4 }),
      Health({ current: 0, max: 20 }), // a corpse
      Name({ value: 'corpse' }),
    );

    const { source } = compiled('click 4,1 @0', 4);
    run(world, source, 1);

    expect(world.has(actor, MoveOrder)).toBe(true);
    expect(world.has(actor, AttackOrder)).toBe(false);
  });

  it('reports path.blocked — and issues no order — for a click inside a wall', () => {
    // A wall column at x = 3 with the target cell (4,1) sealed off behind it.
    const world = makeWorld({
      width: 5,
      height: 3,
      tileSize: 1,
      walls: ['#####', '#.#.#', '#####'],
    });
    const actor = spawnOperative(world, 1, 1);

    const { source } = compiled('click 2,1 @0', 4);
    run(world, source, 5);

    expect(world.events.contains(PATH_BLOCKED)).toBe(true);
    expect(world.has(actor, MoveOrder)).toBe(false); // dropped, never a silent half-move
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 1, y: 1 });
  });
});

/**
 * An unreachable click must not cost the player the order they already had.
 *
 * `intakeSystem` used to cancel the current order and install the new one unconditionally, and
 * `iso.pathfind` then discovered a phase later that the destination was unreachable and dropped
 * it — so a misclick on a sealed door left the actor with **no order and no movement**, reported
 * only by a `path.blocked` event no player can see. The shipped Server Vault playthrough cleared
 * that by two ticks: delay its switch click by ten and the operative stalls one cell short of the
 * objective for the remaining 600+ ticks, emits neither death nor completion, and the run still
 * exits 0.
 *
 * Each case is a pair. "The actor kept its order" is satisfied just as well by an intake that
 * ignores every click, so each refusal is followed by the same geometry with the obstruction
 * removed; that positive control is what gives the refusal its meaning.
 */
describe('an unsatisfiable click is refused, not swapped in', () => {
  /** A 5x5 room whose right column is sealed off by a full wall column at x = 2. */
  const SEALED: IsoGridConfig = {
    width: 5,
    height: 5,
    tileSize: 1,
    walls: ['#####', '#.#.#', '#.#.#', '#.#.#', '#####'],
  };

  /** The same room with the wall cell at (2,3) knocked out, joining the two halves. */
  const JOINED: IsoGridConfig = {
    width: 5,
    height: 5,
    tileSize: 1,
    walls: ['#####', '#.#.#', '#.#.#', '#...#', '#####'],
  };

  it('keeps the in-flight order when the new target is unreachable', () => {
    const world = makeWorld(SEALED);
    const actor = spawnOperative(world, 1, 1);
    // Walk down the left column to (1,3); at t2, mid-walk, click the sealed right column.
    const { source } = compiled('click 1,3 @0\nclick 3,1 @2', 8);

    run(world, source, 120);

    // The refusal is reported…
    expect(world.events.count(PATH_BLOCKED)).toBe(1);
    // …the second click never became an order…
    expect(world.events.count(MOVE_ORDERED)).toBe(1);
    // …and the first one was carried out to completion regardless.
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 1, y: 3 });
  });

  it('positive control: the same click retargets once that cell is reachable', () => {
    const world = makeWorld(JOINED);
    const actor = spawnOperative(world, 1, 1);
    const { source } = compiled('click 1,3 @0\nclick 3,1 @2', 8);

    run(world, source, 300);

    expect(world.events.contains(PATH_BLOCKED)).toBe(false);
    expect(world.events.count(MOVE_ORDERED)).toBe(2);
    // The second click wins — a reachable retarget must still replace the order.
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 3, y: 1 });
  });

  it('keeps the in-flight order when an unreachable enemy is clicked', () => {
    const world = makeWorld(SEALED);
    const actor = spawnOperative(world, 1, 1);
    // The shipped operative carries a weapon; without one the pathfinder ignores attack orders
    // outright and there is no reachability question to ask.
    world.add(actor, Attacker, { rangeCells: 3, damage: 10, cooldownTicks: 30 });
    world.spawn(
      GridPosition({ cellX: 3, cellY: 1 }),
      IsoActor({ speed: 4 }),
      Health({ current: 20, max: 20 }),
      Name({ value: 'sealed-in guard' }),
    );
    const { source } = compiled('click 1,3 @0\nclick 3,1 @2', 8);

    run(world, source, 120);

    expect(world.events.count(PATH_BLOCKED)).toBe(1);
    expect(world.events.contains(ATTACK_ORDERED)).toBe(false);
    expect(world.has(actor, AttackOrder)).toBe(false);
    const gp = world.getOrThrow(actor, GridPosition);
    expect({ x: gp.cellX, y: gp.cellY }).toEqual({ x: 1, y: 3 });
  });

  it('an order sealed off *after* it was issued is still dropped, not preserved', () => {
    // The deliberate asymmetry, pinned so nobody "fixes" it into symmetry later. Refusing a
    // replacement protects an order that still works; it says nothing about an order whose
    // destination genuinely stopped existing. A door that slams across the only remaining route
    // leaves nothing to fall back to, so stopping — and saying so — is the honest outcome.
    const world = makeWorld(openGrid(3, 3));
    const actor = spawnOperative(world, 1, 0);
    const { source } = compiled('click 1,2 @0', 4);

    const sim = createSimulation({
      world,
      schedule: createSchedule().addAll(isoSystems()),
      tickRate: TICK_RATE,
      input: source,
    });
    sim.step(); // issued and resolved against an open grid
    expect(world.has(actor, MoveOrder)).toBe(true);
    expect(world.events.count(MOVE_ORDERED)).toBe(1);

    // Now seal every route to the goal: row 1 becomes impassable.
    for (const x of [0, 1, 2]) world.spawn(GridPosition({ cellX: x, cellY: 1 }), Blocking());
    for (let t = 1; t < 20; t++) sim.step();

    expect(world.events.count(PATH_BLOCKED)).toBe(1);
    expect(world.has(actor, MoveOrder)).toBe(false);
  });
});

/**
 * The security grunt's targeting rules, asserted directly: a wall stops it firing, and so does
 * being out of its lane.
 *
 * ## Why this file exists
 * Both rules were unpinned. Deleting the `raycastGrid` occlusion probe — so the grunt shoots
 * straight through the facility's walls — and widening the lane tolerance ninefold both survived
 * the entire suite: the scripted playthrough simply never walks anywhere that would notice. That
 * is the difference between a rule the game *has* and a rule the game is *known* to have.
 *
 * Each case is a pair. "The grunt did not fire" is satisfied by a grunt that can never fire at
 * all, so every negative below is followed by the same geometry with the one blocking condition
 * removed, and that positive is what gives the negative its meaning.
 *
 * Coordinates follow the mode's convention: +X east, +Y up, +Z north; floorplan row 0 is the
 * northmost row, and with `origin` at (0, 0) the cell at column `c`, row `r` of a 7-row plan sits
 * at world (x = c, z = 6 - r).
 */
import { describe, expect, it } from 'vitest';
import { createSchedule, createSimulation, createWorld, Name, Transform } from '@aegis/core';
import type { World } from '@aegis/core';
import { Health } from '@aegis/content';
import { FPS_COLLISION, FPS_SYSTEMS, extrudeFloorplan } from '@aegis/mode-fps';
import type { FloorplanSpec } from '@aegis/mode-fps';
import { Enemy, GruntAi, Player } from '../src/components.js';
import { DAMAGE_TAKEN, gruntAiSystem } from '../src/systems.js';

/** Legend shared by every plan here: `#` a full-height wall, `.` an open floor tile. */
const LEGEND = {
  '#': { solid: true, floor: 0, ceil: 3 },
  '.': { solid: false, floor: 0, ceil: 3 },
} as const;

/** A world whose collision grid is the given 5x7 floorplan rows. */
function facility(rows: readonly string[]): World {
  const spec: FloorplanSpec = {
    width: 5,
    height: 7,
    tileSize: 1,
    origin: { x: 0, z: 0 },
    rows,
    legend: LEGEND,
  };
  const world = createWorld({ seed: 'grunt-ai', recordEvents: true });
  world.setResource(FPS_COLLISION, extrudeFloorplan(spec));
  return world;
}

/**
 * Put a player at `player` and a south-facing grunt at `grunt`, run one tick of the real pipeline,
 * and report whether the grunt landed a shot.
 */
function gruntFires(
  rows: readonly string[],
  grunt: { x: number; z: number },
  player: { x: number; z: number },
): boolean {
  const world = facility(rows);
  world.spawn(
    Name({ value: 'operative' }),
    Player(),
    Transform({ position: { x: player.x, y: 0, z: player.z } }),
    Health({ current: 100, max: 100 }),
  );
  world.spawn(
    Name({ value: 'grunt' }),
    Enemy(),
    Transform({ position: { x: grunt.x, y: 0, z: grunt.z } }),
    Health({ current: 30, max: 30 }),
    // Facing -Z: the player is always south of the grunt in these plans, so "in front" is never
    // what decides the outcome.
    GruntAi({ range: 6, damage: 10, fireInterval: 60, cooldownRemaining: 0 }),
  );

  const schedule = createSchedule().addAll([...FPS_SYSTEMS, gruntAiSystem]);
  createSimulation({ world, schedule, tickRate: 60 }).run(1);
  return world.events.count(DAMAGE_TAKEN) > 0;
}

/** An open room: only the outer shell is wall. */
const OPEN_ROOM = ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#####'];
/** The same room with a full-width partition across z = 4, between the two actors. */
const PARTITIONED = ['#####', '#...#', '#####', '#...#', '#...#', '#...#', '#####'];

describe('the grunt cannot shoot through a wall', () => {
  it('holds its fire when a partition stands between it and the player', () => {
    // Grunt (1, z=5) and player (1, z=3) are two units apart and perfectly in line; the only
    // thing between them is the wall tile at (1, z=4).
    expect(gruntFires(PARTITIONED, { x: 1, z: 5 }, { x: 1, z: 3 })).toBe(false);
  });

  it('positive control: the same two positions in an open room draw fire', () => {
    expect(gruntFires(OPEN_ROOM, { x: 1, z: 5 }, { x: 1, z: 3 })).toBe(true);
  });
});

describe('the grunt only engages down its own lane', () => {
  it('ignores a player two columns off its lane', () => {
    // Distance 2.83 (inside its range of 6), in front of it, and with clear line of sight — so
    // the lane tolerance of 1.5 is the only rule that can be refusing this shot.
    expect(gruntFires(OPEN_ROOM, { x: 1, z: 5 }, { x: 3, z: 3 })).toBe(false);
  });

  it('positive control: the same player one column off the lane is engaged', () => {
    expect(gruntFires(OPEN_ROOM, { x: 1, z: 5 }, { x: 2, z: 3 })).toBe(true);
  });
});

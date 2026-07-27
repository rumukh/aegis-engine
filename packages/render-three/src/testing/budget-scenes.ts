/**
 * Scenes sized like the games that actually ship, for measuring what a human's frame costs.
 *
 * `./scenes.ts` holds deliberately small levels: they exercise the adapters' *behaviour*, and a
 * 6x5 grid is the clearest way to assert that a wall column appears where a blocked cell is. A
 * **budget** is a different question, and a small scene answers it wrongly — the first version of
 * `browser-playability.test.ts` asserted a 320-draw-call ceiling against a 5x7 floorplan that
 * could not have reached it however badly the adapter regressed. Adding three extra boxes per
 * cell to the fps adapter did not move it enough to fail. An instrument that cannot reach its own
 * threshold is not measuring anything.
 *
 * So these are built at the dimensions of the shipped PoC levels, read off them once and written
 * down here (the engine may not import `games/**` — `scripts/check-deps.mjs` forbids it, and
 * rightly):
 *
 * | game       | resource             | size  | notes                                      |
 * | ---------- | -------------------- | ----- | ------------------------------------------ |
 * | platformer | `platformer.tilemap` | 46x12 | `games/platformer/levels/coyote-gap`        |
 * | iso        | `IsoGrid`            | 12x9  | `games/iso/levels/server-vault`             |
 * | fps        | `fps.floorplan`      | 11x21 | `games/fps/levels/sector-breach`, 126 solid |
 *
 * The wall density matters as much as the size for the fps adapter, which draws a column per
 * solid cell and a floor *plus* a ceiling slab per walkable one — so the layouts below reproduce
 * roughly the shipped ratio rather than being open rooms, which would be heavier than anything
 * that ships and would fail the budget for a reason no player would ever meet.
 *
 * If a shipped level grows past these, the budget stops covering it. That is a real limitation of
 * writing the numbers down instead of importing the levels; it is also the only option the
 * dependency rule leaves, and a stale row here is at least visible.
 * @packageDocumentation
 */
import type { SceneFile } from '@aegis/content';

/** Build `height` rows of `width` characters from a per-cell predicate. */
function rows(width: number, height: number, solid: (x: number, y: number) => boolean): string[] {
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += solid(x, y) ? '#' : '.';
    out.push(row);
  }
  return out;
}

/** A border ring plus a pillar lattice — a facility floorplan, not an open room. */
function facility(width: number, height: number): string[] {
  return rows(width, height, (x, y) => {
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
    return x % 2 === 0 && y % 3 === 0;
  });
}

/** 11x21 first-person floorplan, the size of `sector-breach`. */
export const FPS_BUDGET_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-budget-fps',
  mode: 'fps',
  seed: 'render-budget',
  resources: {
    'fps.floorplan': {
      width: 11,
      height: 21,
      tileSize: 1,
      origin: { x: -5, z: 0 },
      rows: facility(11, 21),
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
        Transform: { position: { x: -3, y: 0, z: 1 } },
        CapsuleBody: { radius: 0.4, height: 1.8, velocity: { x: 0, y: 0, z: 0 }, grounded: false },
        FpsController: { moveSpeed: 6, gravity: 24, jumpSpeed: 8, maxPitchDeg: 89 },
        LookState: { yawDeg: 0, pitchDeg: 0 },
        FpsCamera: { eyeHeight: 1.6, fovDegrees: 75, near: 0.1, far: 500 },
        Hitscan: { range: 100, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 },
        Health: { current: 100, max: 100 },
      },
    },
    {
      id: 'grunt',
      components: {
        Transform: { position: { x: -3, y: 0, z: 9 } },
        HitBox: { half: { x: 0.4, y: 1, z: 0.5 }, offset: { x: 0, y: 1, z: 0 } },
        Health: { current: 50, max: 50 },
      },
    },
    {
      id: 'exit',
      components: {
        Transform: { position: { x: -3, y: 0, z: 17 } },
        Trigger: { kind: 'goal', shape: 'box', half: { x: 1, y: 1.5, z: 0.5 }, radius: 1 },
      },
    },
  ],
};

/** 12x9 isometric grid, the size of `server-vault`. */
export const ISO_BUDGET_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-budget-iso',
  mode: 'iso',
  seed: 'render-budget',
  resources: {
    IsoGrid: { width: 12, height: 9, tileSize: 1, walls: facility(12, 9) },
  },
  entities: [
    {
      id: 'operative',
      tags: ['Controlled'],
      components: {
        GridPosition: { cellX: 1, cellY: 1, progress: 0 },
        IsoActor: { speed: 4, moveMode: 'realtime' },
        Health: { current: 30, max: 30 },
        Attacker: { rangeCells: 3, damage: 10, cooldownTicks: 30, cooldownRemaining: 0 },
      },
    },
    {
      id: 'guard',
      components: {
        GridPosition: { cellX: 9, cellY: 5, progress: 0 },
        IsoActor: { speed: 4, moveMode: 'realtime' },
        Health: { current: 20, max: 20 },
      },
    },
    { id: 'iso-camera', components: { IsoCamera: { target: 'operative', viewHeight: 14 } } },
  ],
};

/** 46x12 side-on tilemap, the size of `coyote-gap`. */
export const PLATFORMER_BUDGET_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-budget-platformer',
  mode: 'platformer',
  seed: 'render-budget',
  resources: {
    'platformer.tilemap': {
      aegis: 'tilemap/1',
      name: 'render-budget',
      width: 46,
      height: 12,
      tileSize: 1,
      legend: { '#': { solid: true, sprite: 'ground' } },
      layers: [
        {
          name: 'collision',
          // Two ground rows plus a scattering of ledges: a level with something in it, at the
          // width the shipped one runs to.
          data: rows(46, 12, (x, y) => y >= 10 || (y === 6 && x % 5 === 0) || (y === 3 && x % 7 === 0)),
        },
      ],
    },
  },
  entities: [
    {
      id: 'player',
      tags: ['Player'],
      components: {
        Transform: { position: { x: 1.5, y: 2.5, z: 0 } },
        Velocity: { dx: 0, dy: 0 },
        PlatformerController: {},
        BodyState: {},
        TileCollider: { halfWidth: 0.4, halfHeight: 0.5 },
        Health: { current: 1, max: 1 },
      },
    },
    {
      id: 'camera',
      components: {
        Transform: { position: { x: 1.5, y: 3, z: 10 } },
        PlatformerCamera: { target: 'player', deadzoneX: 2, deadzoneY: 1.5, viewHeight: 14 },
      },
    },
  ],
};

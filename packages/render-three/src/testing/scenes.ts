/**
 * Hand-authored scenes used by the adapter tests.
 *
 * They deliberately use the bare `@aegis/mode-*` plugins rather than the PoC games: the games are
 * not consumable by a package (see `../games.ts`), and the adapters read *mode* vocabulary, so a
 * small scene per mode exercises exactly the surface under test — tilemap, nav grid, extruded
 * floorplan, camera rigs, actors, triggers — with no game logic in the way.
 * @packageDocumentation
 */
import type { SceneFile } from '@aegis/content';

/**
 * A side-on level with a spike pit, a moving platform, a critter, a goal volume and the mode's
 * follow camera.
 */
export const PLATFORMER_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-test-platformer',
  mode: 'platformer',
  seed: 'render-test',
  resources: {
    'platformer.tilemap': {
      aegis: 'tilemap/1',
      name: 'render-test',
      width: 12,
      height: 6,
      tileSize: 1,
      legend: {
        '#': { solid: true, sprite: 'ground' },
        '^': { solid: false, sprite: 'spikes', data: { hazard: true } },
      },
      layers: [
        {
          name: 'collision',
          data: [
            '............',
            '............',
            '............',
            '............',
            '####...#####',
            '####^^^#####',
          ],
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
      id: 'critter',
      components: {
        Transform: { position: { x: 9.5, y: 2.4, z: 0 } },
        TileCollider: { halfWidth: 0.4, halfHeight: 0.4 },
        Health: { current: 1, max: 1 },
      },
    },
    {
      id: 'lift',
      components: {
        Transform: { position: { x: 5.5, y: 2, z: 0 } },
        KinematicPlatform: {
          axis: 'x',
          min: 5,
          max: 6,
          speed: 2,
          phase: 0,
          halfWidth: 1,
          halfHeight: 0.5,
        },
      },
    },
    {
      id: 'camera',
      components: {
        Transform: { position: { x: 1.5, y: 3, z: 10 } },
        PlatformerCamera: { target: 'player', deadzoneX: 2, deadzoneY: 1.5, viewHeight: 10 },
      },
    },
    {
      id: 'goal',
      components: {
        Transform: { position: { x: 10.5, y: 2.5, z: 0 } },
        Trigger: { kind: 'goal', shape: 'box', half: { x: 0.5, y: 1, z: 1 }, once: true },
      },
    },
  ],
};

/** A small vault: walls, an operative, a guard, a sealed door, a switch and an exit. */
export const ISO_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-test-iso',
  mode: 'iso',
  seed: 'render-test',
  resources: {
    IsoGrid: {
      width: 6,
      height: 5,
      tileSize: 1,
      walls: ['######', '#....#', '#.##.#', '#....#', '######'],
    },
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
        GridPosition: { cellX: 4, cellY: 3, progress: 0 },
        IsoActor: { speed: 4, moveMode: 'realtime' },
        Health: { current: 20, max: 20 },
      },
    },
    {
      id: 'vault-door',
      tags: ['Blocking'],
      components: { GridPosition: { cellX: 4, cellY: 1, progress: 0 } },
    },
    {
      id: 'security-switch',
      components: {
        Transform: { position: { x: 1, y: 3, z: 0 } },
        Trigger: { kind: 'switch', shape: 'box', once: true, half: { x: 0.5, y: 0.5, z: 0.5 } },
      },
    },
    {
      id: 'vault-exit',
      components: {
        Transform: { position: { x: 3, y: 3, z: 0 } },
        Trigger: { kind: 'exit', shape: 'box', once: true, half: { x: 0.5, y: 0.5, z: 0.5 } },
      },
    },
    { id: 'iso-camera', components: { IsoCamera: { target: 'operative', viewHeight: 12 } } },
  ],
};

/** A corridor with a door tile, a pit tile, a shootable panel, a grunt and an exit volume. */
export const FPS_SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'render-test-fps',
  mode: 'fps',
  seed: 'render-test',
  resources: {
    'fps.floorplan': {
      width: 5,
      height: 7,
      tileSize: 1,
      origin: { x: -2, z: 0 },
      rows: ['#####', '#...#', '#.T.#', '#.=.#', '#...#', '#...#', '#####'],
      legend: {
        '#': { solid: true, floor: 0, ceil: 4 },
        '.': { solid: false, floor: 0, ceil: 4 },
        '=': { solid: true, floor: 0, ceil: 4, door: true },
        T: { solid: false, floor: -3, ceil: 4, hazard: true },
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
        Hitscan: { range: 100, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 },
        Health: { current: 100, max: 100 },
      },
    },
    {
      id: 'panel',
      components: {
        Transform: { position: { x: 1, y: 0, z: 1 } },
        HitBox: { half: { x: 0.3, y: 0.5, z: 0.5 }, offset: { x: 0, y: 1.5, z: 0 } },
      },
    },
    {
      id: 'grunt',
      components: {
        Transform: { position: { x: 0, y: 0, z: 5 } },
        HitBox: { half: { x: 0.4, y: 1, z: 0.5 }, offset: { x: 0, y: 1, z: 0 } },
        Health: { current: 50, max: 50 },
      },
    },
    {
      id: 'exit',
      components: {
        Transform: { position: { x: 0, y: 0, z: 5.5 } },
        Trigger: { kind: 'goal', shape: 'box', half: { x: 1, y: 1.5, z: 0.5 }, radius: 1 },
      },
    },
  ],
};

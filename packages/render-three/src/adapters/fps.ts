/**
 * The first-person render adapter: a perspective view from the player's eye.
 *
 * Draws, all read straight from world state:
 * - the extruded `FPS_COLLISION` floorplan — every solid cell as a column from its `floor` to its
 *   `ceil`, so per-tile heights show up as real geometry; door cells in orange (the blast door
 *   simply stops being drawn the tick the game flips `solid` to `false`); walkable cells get a
 *   ground slab at their own floor height, which is what makes the coolant pit read as a hole you
 *   can fall into, and a dim ceiling slab overhead;
 * - shootable `HitBox` entities — the security grunt in hostile red, the wall panel in switch
 *   yellow — sized and offset exactly as the hitscan resolves them, so what you aim at is what
 *   you hit;
 * - `Trigger` volumes: the exit in cyan, the coolant hazard in red, both translucent.
 *
 * The camera is the mode's `FpsCamera` rig at `Transform.position + eyeHeight`, oriented by
 * `LookState` through the mode's own `forwardFromLook`, so the picture agrees with the semantic
 * frame and with where a hitscan ray actually goes.
 * @packageDocumentation
 */
import { AmbientLight, Group, HemisphereLight, PerspectiveCamera, PointLight, Scene } from 'three';
import type { Mesh } from 'three';
import { Transform } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import { Health, Model, Trigger } from '@aegis/content';
import type { TriggerData } from '@aegis/content';
import {
  FPS_COLLISION,
  FpsCamera,
  HitBox,
  LookState,
  cellCenterWorld,
  forwardFromLook,
} from '@aegis/mode-fps';
import type { CollisionGrid } from '@aegis/mode-fps';
import { BaseAdapter, ObjectPool, aspectOf, createModeScene } from '../adapter.js';
import type { RenderAdapterOptions } from '../adapter.js';
import { resolveAppearance } from '../appearance.js';
import type { VisualRole } from '../appearance.js';
import { Primitives } from '../primitives.js';

/** Thickness of the ground slab under a walkable cell, world units. */
const GROUND_THICKNESS = 0.5;
/** Thickness of the ceiling slab over a walkable cell, world units. */
const CEILING_THICKNESS = 0.2;
/** Field of view used when a scene authored no `FpsCamera`. */
const FALLBACK_FOV = 75;

/** The visual role of a trigger volume, by its authored `kind`. */
function triggerRole(kind: string): VisualRole {
  if (kind === 'hazard') return 'hazard';
  if (kind === 'switch') return 'switch';
  return 'goal';
}

/** The perspective first-person adapter for `@aegis/mode-fps`. */
export class FpsAdapter extends BaseAdapter {
  readonly mode: GameMode = 'fps';
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  readonly #primitives = new Primitives();
  readonly #level = new Group();
  readonly #entities = new Group();
  readonly #cells: ObjectPool;
  readonly #pool: ObjectPool;
  readonly #eyeLight = new PointLight(0xffe9c8, 3.2, 22, 1.4);

  constructor(options: RenderAdapterOptions = {}) {
    super();
    this.scene = createModeScene('fps', options.background);
    this.#level.name = 'level';
    this.#entities.name = 'entities';
    this.scene.add(this.#level, this.#entities);
    this.#cells = new ObjectPool(this.#level);
    this.#pool = new ObjectPool(this.#entities);
    this.camera = new PerspectiveCamera(FALLBACK_FOV, options.aspect ?? 16 / 9, 0.1, 1000);
    this.camera.name = 'camera';
  }

  mount(world: World): void {
    const ambient = new AmbientLight(0xffffff, 0.85);
    ambient.name = 'light:ambient';
    const sky = new HemisphereLight(0x9fb6ff, 0x1b2030, 0.7);
    sky.name = 'light:hemisphere';
    this.#eyeLight.name = 'light:eye';
    this.scene.add(ambient, sky, this.#eyeLight);
    this.sync(world);
  }

  sync(world: World): void {
    this.#syncLevel(world);
    this.#pool.begin();
    this.#syncHitBoxes(world);
    this.#syncTriggers(world);
    this.#pool.sweep();
    this.#syncCamera(world);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = aspectOf(width, height);
    this.camera.updateProjectionMatrix();
  }

  override dispose(): void {
    this.#cells.clear();
    this.#pool.clear();
    this.#primitives.dispose();
    super.dispose();
  }

  /**
   * Reconcile the extruded floorplan every frame. Cell `solid` flags are live simulation state
   * (the blast door opens by flipping one), so this is a read of the world, not a one-off bake.
   */
  #syncLevel(world: World): void {
    const grid = world.getResource(FPS_COLLISION);
    this.#cells.begin();
    if (grid !== undefined && grid.width > 0) {
      for (let row = 0; row < grid.height; row++) {
        for (let col = 0; col < grid.width; col++) {
          this.#syncCell(grid, col, row);
        }
      }
    }
    this.#cells.sweep();
  }

  /** One floorplan cell: a solid column, or a ground slab plus a ceiling slab. */
  #syncCell(grid: CollisionGrid, col: number, row: number): void {
    const cell = grid.cells[row * grid.width + col];
    if (cell === undefined) return;
    const centre = cellCenterWorld(grid, col, row);
    const size = grid.tileSize;

    if (cell.solid) {
      const height = Math.max(cell.ceil - cell.floor, 0.1);
      const role: VisualRole = cell.door ? 'door' : 'wall';
      const wall = this.#cells.claim(`wall:${col}:${row}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role })),
      ) as Mesh;
      wall.scale.set(size, height, size);
      wall.position.set(centre.x, cell.floor + height / 2, centre.z);
      return;
    }

    const role: VisualRole = cell.hazard ? 'pit' : 'floor';
    const ground = this.#cells.claim(`ground:${col}:${row}`, () =>
      this.#primitives.boxMesh(resolveAppearance({ role })),
    ) as Mesh;
    ground.scale.set(size, GROUND_THICKNESS, size);
    ground.position.set(centre.x, cell.floor - GROUND_THICKNESS / 2, centre.z);

    const ceiling = this.#cells.claim(`ceiling:${col}:${row}`, () =>
      this.#primitives.boxMesh(resolveAppearance({ role: 'ceiling' })),
    ) as Mesh;
    ceiling.scale.set(size, CEILING_THICKNESS, size);
    ceiling.position.set(centre.x, cell.ceil + CEILING_THICKNESS / 2, centre.z);
  }

  /** Everything you can shoot, drawn exactly where the hitscan resolves it. */
  #syncHitBoxes(world: World): void {
    for (const view of world.query({ has: [HitBox, Transform] }).views()) {
      const box = view.get(HitBox);
      const position = view.get(Transform).position;
      const role: VisualRole = view.has(Health) ? 'enemy' : 'switch';
      const mesh = this.#pool.claim(`hitbox:${view.entity}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role, model: view.tryGet(Model) })),
      ) as Mesh;
      mesh.scale.set(box.half.x * 2, box.half.y * 2, box.half.z * 2);
      mesh.position.set(
        position.x + box.offset.x,
        position.y + box.offset.y,
        position.z + box.offset.z,
      );
      // A dead grunt keeps its hit box; the corpse should stop looking like a live threat.
      const health = view.tryGet(Health);
      const dead = health !== undefined && health.current <= 0;
      mesh.material = this.#primitives.roleMaterial(dead ? 'dead' : role);
    }
  }

  /** Goal and hazard volumes, translucent so the level reads through them. */
  #syncTriggers(world: World): void {
    for (const view of world.query({ has: [Trigger, Transform] }).views()) {
      const trigger = view.get(Trigger) as TriggerData;
      const position = view.get(Transform).position;
      const role = triggerRole(trigger.kind);
      const mesh = this.#pool.claim(`trigger:${view.entity}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role, opacity: 0.28 }), 'flat'),
      ) as Mesh;
      const half =
        trigger.shape === 'sphere'
          ? { x: trigger.radius, y: trigger.radius, z: trigger.radius }
          : trigger.half;
      mesh.scale.set(half.x * 2, half.y * 2, half.z * 2);
      mesh.position.set(position.x, position.y, position.z);
    }
  }

  /** Place the perspective camera at the eye and orient it by the look state. */
  #syncCamera(world: World): void {
    const rig = world.query({ has: [FpsCamera, Transform, LookState] }).first();
    if (rig === undefined) return;
    const config = rig.get(FpsCamera);
    const look = rig.get(LookState);
    const position = rig.get(Transform).position;
    const forward = forwardFromLook(look.yawDeg, look.pitchDeg);
    const eyeY = position.y + config.eyeHeight;

    this.camera.fov = config.fovDegrees > 0 ? config.fovDegrees : FALLBACK_FOV;
    this.camera.near = config.near;
    this.camera.far = config.far;
    this.camera.position.set(position.x, eyeY, position.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(position.x + forward.x, eyeY + forward.y, position.z + forward.z);
    this.camera.updateProjectionMatrix();
    // `lookAt` writes the quaternion; `matrixWorld` (and its inverse, which is what a projection
    // reads) is only refreshed by a render. Anything that projects between `sync` and the next
    // `renderer.render` — `aegis.project`, and every test in this package — would otherwise
    // measure against the previous frame's camera. Same staleness the iso adapter already guards.
    this.camera.updateMatrixWorld(true);
    this.#eyeLight.position.set(position.x, eyeY, position.z);
  }
}

/** Create the first-person adapter. */
export function createFpsAdapter(options?: RenderAdapterOptions): FpsAdapter {
  return new FpsAdapter(options);
}

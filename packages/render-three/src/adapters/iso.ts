/**
 * The isometric render adapter: a classic 3/4 view of the grid world.
 *
 * Draws, all read straight from world state:
 * - the baked `NavGrid` — passable cells as low floor plates, blocked cells as full-height walls,
 *   so the corridors read instantly;
 * - actors on their `GridPosition`, interpolated along the current `MoveOrder`/`AttackOrder` path
 *   by `GridPosition.progress` so movement is smooth without the simulation leaving the grid;
 * - the controlled operative in the player colour, everything else hostile-red, each with a
 *   camera-facing health bar (health is the whole tactical read of "The Server Vault");
 * - the sealed door (a `Blocking` grid entity) — when the switch removes `Blocking`, the door
 *   simply stops being claimed during reconciliation and disappears;
 * - `switch` and `exit` trigger volumes as coloured floor pads.
 *
 * The camera is the mode's `IsoCamera` rig: it follows the named target, spans `viewHeight` world
 * units and looks along the authored `yawDegrees` at the classic isometric elevation.
 * @packageDocumentation
 */
import {
  AmbientLight,
  DirectionalLight,
  Group,
  OrthographicCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import type { Mesh } from 'three';
import { DEG2RAD, Name, Transform, cos, sin } from '@aegis/core';
import type { Entity, GameMode, World } from '@aegis/core';
import { Health, Sprite, Trigger } from '@aegis/content';
import type { TriggerData } from '@aegis/content';
import {
  AttackOrder,
  Blocking,
  Controlled,
  GridPosition,
  IsoCamera,
  MoveOrder,
  NavGrid,
} from '@aegis/mode-iso';
import type { Cell } from '@aegis/mode-iso';
import { BaseAdapter, ObjectPool, aspectOf, createModeScene } from '../adapter.js';
import type { PickedPoint, RenderAdapterOptions } from '../adapter.js';
import { resolveAppearance } from '../appearance.js';
import type { VisualRole } from '../appearance.js';
import { Primitives } from '../primitives.js';

/** Elevation of a true 2:1 isometric camera, in degrees (`atan(1/sqrt(2))`). */
const ISO_ELEVATION_DEG = 35.264389682754654;
/** How far back along the view direction the orthographic camera sits. */
const CAMERA_DISTANCE = 60;
/** Orthographic height used when a scene authored no `IsoCamera`. */
const FALLBACK_VIEW_HEIGHT = 16;
/** Height of a wall column, world units. */
const WALL_HEIGHT = 1.6;

/** The ground plane the pointer is projected onto. */
const GROUND = new Plane(new Vector3(0, 1, 0), 0);

/** The visual role of a trigger volume, by its authored `kind`. */
function triggerRole(kind: string): VisualRole {
  if (kind === 'switch') return 'switch';
  if (kind === 'hazard') return 'hazard';
  return 'goal';
}

/**
 * World position of a grid cell. The mode's semantic frame places cell `(cx, cy)` at world
 * `(cx, 0, cy)`; the adapter uses the same mapping so pixels and semantic frames agree.
 */
export function cellToWorld(cellX: number, cellY: number): { x: number; z: number } {
  return { x: cellX, z: cellY };
}

/** The next cell of an actor's resolved path, if it has one. */
function nextPathCell(world: World, entity: Entity): Cell | undefined {
  const move = world.get(entity, MoveOrder);
  if (move !== undefined && move.path.length > 0) return move.path[0];
  const attack = world.get(entity, AttackOrder);
  if (attack !== undefined && attack.path.length > 0) return attack.path[0];
  return undefined;
}

/** The isometric adapter for `@aegis/mode-iso`. */
export class IsoAdapter extends BaseAdapter {
  readonly mode: GameMode = 'iso';
  readonly scene: Scene;
  readonly camera: OrthographicCamera;

  readonly #primitives = new Primitives();
  readonly #level = new Group();
  readonly #entities = new Group();
  readonly #pool: ObjectPool;
  readonly #raycaster = new Raycaster();
  #aspect: number;
  #levelBuilt = false;

  constructor(options: RenderAdapterOptions = {}) {
    super();
    this.#aspect = options.aspect ?? 16 / 9;
    this.scene = createModeScene('iso', options.background);
    this.#level.name = 'level';
    this.#entities.name = 'entities';
    this.scene.add(this.#level, this.#entities);
    this.#pool = new ObjectPool(this.#entities);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camera.name = 'camera';
    this.#applyFrustum(FALLBACK_VIEW_HEIGHT);
  }

  mount(world: World): void {
    const ambient = new AmbientLight(0xffffff, 1.1);
    ambient.name = 'light:ambient';
    const key = new DirectionalLight(0xffffff, 1.4);
    key.name = 'light:key';
    key.position.set(1, 2, 0.6);
    this.scene.add(ambient, key);
    this.#buildLevel(world);
    this.sync(world);
  }

  sync(world: World): void {
    if (!this.#levelBuilt) this.#buildLevel(world);
    this.#syncCamera(world);
    this.#pool.begin();
    this.#syncTriggers(world);
    this.#syncDoors(world);
    this.#syncActors(world);
    this.#pool.sweep();
  }

  resize(width: number, height: number): void {
    this.#aspect = aspectOf(width, height);
    this.#applyFrustum(this.camera.top - this.camera.bottom);
  }

  /** Project a viewport pointer onto the ground plane and snap it to a grid cell. */
  override pick(ndcX: number, ndcY: number): PickedPoint | null {
    this.#raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const hit = this.#raycaster.ray.intersectPlane(GROUND, new Vector3());
    if (hit === null) return null;
    // `iso.intake` reads `pointer.world.x/.y` as *cell* coordinates (see mode-iso/systems.ts).
    return { x: Math.round(hit.x), y: Math.round(hit.z), z: 0 };
  }

  override dispose(): void {
    this.#pool.clear();
    this.#primitives.dispose();
    super.dispose();
  }

  /** Floor plates and wall columns from the baked nav grid. Static for the run. */
  #buildLevel(world: World): void {
    const nav = world.getResource(NavGrid);
    if (nav === undefined || nav.width === 0) return;
    for (let y = 0; y < nav.height; y++) {
      for (let x = 0; x < nav.width; x++) {
        const blocked = nav.blocked[y * nav.width + x] === true;
        const at = cellToWorld(x, y);
        if (blocked) {
          const wall = this.#primitives.boxMesh(resolveAppearance({ role: 'wall' }));
          wall.name = `wall:${x}:${y}`;
          wall.scale.set(nav.tileSize, WALL_HEIGHT, nav.tileSize);
          wall.position.set(at.x, WALL_HEIGHT / 2, at.z);
          this.#level.add(wall);
        } else {
          const floor = this.#primitives.boxMesh(resolveAppearance({ role: 'floor' }));
          floor.name = `floor:${x}:${y}`;
          floor.scale.set(nav.tileSize * 0.94, 0.08, nav.tileSize * 0.94);
          floor.position.set(at.x, -0.04, at.z);
          this.#level.add(floor);
        }
      }
    }
    this.#levelBuilt = true;
  }

  /** Switch / exit pads, drawn flat on the floor. */
  #syncTriggers(world: World): void {
    for (const view of world.query({ has: [Trigger, Transform] }).views()) {
      const trigger = view.get(Trigger) as TriggerData;
      const position = view.get(Transform).position;
      const role = triggerRole(trigger.kind);
      const pad = this.#pool.claim(`trigger:${view.entity}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role, opacity: 0.85 }), 'flat'),
      ) as Mesh;
      // Iso `Transform` positions are authored in grid coordinates: x = cellX, y = cellY.
      const at = cellToWorld(position.x, position.y);
      pad.scale.set(0.8, 0.12, 0.8);
      pad.position.set(at.x, 0.06, at.z);
    }
  }

  /** The sealed door: a `Blocking` grid entity. Vanishes the tick its tag is removed. */
  #syncDoors(world: World): void {
    for (const view of world.query({ has: [Blocking, GridPosition] }).views()) {
      const grid = view.get(GridPosition);
      const at = cellToWorld(grid.cellX, grid.cellY);
      const door = this.#pool.claim(`door:${view.entity}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role: 'door', sprite: view.tryGet(Sprite) })),
      ) as Mesh;
      door.scale.set(0.94, WALL_HEIGHT * 0.9, 0.94);
      door.position.set(at.x, (WALL_HEIGHT * 0.9) / 2, at.z);
    }
  }

  /** Actors, interpolated along their path, with a camera-facing health bar. */
  #syncActors(world: World): void {
    for (const view of world.query({ has: [GridPosition, Health] }).views()) {
      const grid = view.get(GridPosition);
      const health = view.get(Health);
      const controlled = view.has(Controlled);
      const role: VisualRole = controlled ? 'player' : 'enemy';

      const group = this.#pool.claim(`actor:${view.entity}`, () => {
        const container = new Group();
        const body = this.#primitives.boxMesh(
          resolveAppearance({ role, sprite: view.tryGet(Sprite) }),
        );
        body.name = 'body';
        body.scale.set(0.5, 1.1, 0.5);
        body.position.y = 0.55;
        const barBack = this.#primitives.boxMesh(resolveAppearance({ role: 'dead' }), 'flat');
        barBack.name = 'bar:back';
        barBack.scale.set(0.9, 0.12, 0.02);
        barBack.position.y = 1.45;
        const barFill = this.#primitives.boxMesh(resolveAppearance({ role }), 'flat');
        barFill.name = 'bar:fill';
        barFill.position.y = 1.45;
        container.add(body, barBack, barFill);
        return container;
      }) as Group;

      // Sub-cell interpolation toward the next path cell: smooth pixels, integer simulation.
      const from = cellToWorld(grid.cellX, grid.cellY);
      const next = nextPathCell(world, view.entity);
      const to = next === undefined ? from : cellToWorld(next.x, next.y);
      const t = next === undefined ? 0 : Math.min(Math.max(grid.progress, 0), 1);
      group.position.set(from.x + (to.x - from.x) * t, 0, from.z + (to.z - from.z) * t);

      const fraction = health.max > 0 ? Math.min(Math.max(health.current / health.max, 0), 1) : 0;
      // A corpse stops looking like a live threat: it goes grey and lies down.
      const body = group.getObjectByName('body') as Mesh;
      body.material = this.#primitives.roleMaterial(fraction > 0 ? role : 'dead');
      body.scale.set(0.5, fraction > 0 ? 1.1 : 0.35, 0.5);
      body.position.y = fraction > 0 ? 0.55 : 0.18;

      const fill = group.getObjectByName('bar:fill') as Mesh;
      fill.scale.set(0.86 * fraction, 0.08, 0.03);
      fill.position.x = -0.43 * (1 - fraction);
      fill.visible = fraction > 0;
      // Billboard the bars so they stay readable under the fixed isometric camera.
      const back = group.getObjectByName('bar:back') as Mesh;
      back.quaternion.copy(this.camera.quaternion);
      fill.quaternion.copy(this.camera.quaternion);
    }
  }

  /** Follow the `IsoCamera` target along the authored isometric direction. */
  #syncCamera(world: World): void {
    const rig = world.query({ has: [IsoCamera] }).first();
    const config = rig?.get(IsoCamera);
    const focus = this.#focusOf(world, config?.target ?? '');
    this.#applyFrustum(config?.viewHeight ?? FALLBACK_VIEW_HEIGHT);

    const yaw = (config?.yawDegrees ?? 45) * DEG2RAD;
    const elevation = ISO_ELEVATION_DEG * DEG2RAD;
    const horizontal = cos(elevation);
    const offset = {
      x: sin(yaw) * horizontal,
      y: sin(elevation),
      z: cos(yaw) * horizontal,
    };
    this.camera.position.set(
      focus.x + offset.x * CAMERA_DISTANCE,
      offset.y * CAMERA_DISTANCE,
      focus.z + offset.z * CAMERA_DISTANCE,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(focus.x, 0, focus.z);
    this.camera.updateMatrixWorld();
  }

  /** World position of the named follow target, falling back to the grid centre. */
  #focusOf(world: World, target: string): { x: number; z: number } {
    if (target !== '') {
      for (const view of world.query({ has: [GridPosition] }).views()) {
        if (world.get(view.entity, Name)?.value !== target) continue;
        const grid = view.get(GridPosition);
        return cellToWorld(grid.cellX, grid.cellY);
      }
    }
    const nav = world.getResource(NavGrid);
    if (nav === undefined || nav.width === 0) return { x: 0, z: 0 };
    return cellToWorld((nav.width - 1) / 2, (nav.height - 1) / 2);
  }

  /** Set the orthographic frustum so the viewport spans `viewHeight` world units vertically. */
  #applyFrustum(viewHeight: number): void {
    const height = viewHeight > 0 ? viewHeight : FALLBACK_VIEW_HEIGHT;
    const halfHeight = height / 2;
    const halfWidth = halfHeight * this.#aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }
}

/** Create the isometric adapter. */
export function createIsoAdapter(options?: RenderAdapterOptions): IsoAdapter {
  return new IsoAdapter(options);
}

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
  Box3,
  DirectionalLight,
  Group,
  OrthographicCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import type { Mesh, Object3D } from 'three';
import { DEG2RAD, Name, Transform, atan2, cos, sin } from '@aegis/core';
import type { Entity, GameMode, Quat, World } from '@aegis/core';
import { Health, Model, Sprite, Trigger } from '@aegis/content';
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
import type { SpriteState } from '../presentation/schema.js';

/** Elevation of a true 2:1 isometric camera, in degrees (`atan(1/sqrt(2))`). */
const ISO_ELEVATION_DEG = 35.264389682754654;
/** How far back along the view direction the orthographic camera sits. */
const CAMERA_DISTANCE = 60;
/** Orthographic height used when a scene authored no `IsoCamera`. */
const FALLBACK_VIEW_HEIGHT = 16;
/**
 * Height of a wall column, world units — and the number that decides whether the game is
 * playable at all.
 *
 * The camera looks along `(-1,-1,-1)` (that is what a 45° yaw at `atan(1/√2)` elevation is), so
 * the pixel showing floor point `(x, 0, z)` also shows every point `(x+t, t, z+t)`. A wall on the
 * cell **diagonally in front** spans `t ∈ [0.5, 1.5]` at that pixel, so any wall taller than
 * `0.5` hides the centre of the cell behind it completely — and with it every way a human has of
 * clicking that cell.
 *
 * At the old height of `1.6` that was most of the level. Measured on "The Server Vault" (12x9,
 * 46 passable cells): a click on the guard's body resolved to a cell one step behind it, a click
 * on the operative's own tile resolved to `wall:2:2`, and **the exit pad at (4,7) could not be
 * clicked at any pixel** — the whole bottom corridor sits behind the outer wall ring. Only the
 * handful of cells with an open diagonal neighbour could be ordered to, which is exactly the
 * reported symptom: in isometry, only walking works.
 *
 * `0.45` is the largest value under that `0.5` bound with room for floating point, so **every**
 * passable cell is reachable by a click regardless of the level's shape. `iso-pick.test.ts`
 * asserts that over the whole grid rather than trusting the arithmetic here. Actors stay 1.1
 * tall and now read *above* the walls, which is what a tactical view wants anyway.
 */
const WALL_HEIGHT = 0.45;

/** The ground plane the pointer is projected onto. */
const GROUND = new Plane(new Vector3(0, 1, 0), 0);
const STEP_BLEND_TICKS = 8;

interface ActorPose {
  cellX: number;
  cellY: number;
  tick: number;
  movedAt: number;
  from: Vector3;
  position: Vector3;
  orientation: Quat;
  state: SpriteState;
  next?: Cell;
  target?: number;
  directionX: number;
  directionZ: number;
}

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
  readonly #actorPoses = new Map<number, ActorPose>();
  readonly #pickCells = new Map<Object3D, PickedPoint>();
  readonly #pickProxies = new Set<Object3D>();
  #aspect: number;
  #levelBuilt = false;
  #levelBounds?: Box3;
  #overview?: { yaw: number; width: number; height: number; center: Vector3 };

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
    this.configurePresentation(options);
    this.presentation?.bindLevel(this.#level);
  }

  mount(world: World): void {
    this.prepareMount();
    this.#pool.clear();
    this.#level.clear();
    this.#actorPoses.clear();
    this.#pickCells.clear();
    this.#pickProxies.clear();
    this.#levelBuilt = false;
    this.#levelBounds = undefined;
    this.#overview = undefined;
    if (this.defaultLighting) {
      const ambient = new AmbientLight(0xffffff, 1.1);
      ambient.name = 'light:ambient';
      const key = new DirectionalLight(0xffffff, 1.4);
      key.name = 'light:key';
      key.position.set(1, 2, 0.6);
      this.scene.add(ambient, key);
    }
    this.#buildLevel(world);
    this.sync(world);
  }

  sync(world: World): void {
    this.presentation?.beginSync();
    this.#pickCells.clear();
    this.#pickProxies.clear();
    if (!this.#levelBuilt) this.#buildLevel(world);
    this.#updateActorPoses(world);
    this.#syncCamera(world);
    this.#pool.begin();
    this.#syncTriggers(world);
    this.#syncDoors(world);
    this.#syncActors(world);
    this.#pool.sweep();
    this.#syncOtherAnchors(world);
    this.finishPresentationSync(world);
  }

  resize(width: number, height: number): void {
    this.#aspect = aspectOf(width, height);
    this.#applyFrustum(this.camera.top - this.camera.bottom);
  }

  /**
   * Resolve a viewport pointer to the grid cell a human aimed at.
   *
   * The pointer must be resolved against **what is drawn**, not against the ground plane. Actors
   * are 1.1 units tall and walls 1.6, and in a 3/4 view a solid body hides the very floor tile it
   * stands on — so the only part of the guard a human can click is its body, and a ray through
   * that body reaches the ground several cells further away. Measured on "The Server Vault" with
   * the guard on cell (2,5): a click on the ground under it resolved to (2,5), but a click on its
   * body centre resolved to **(1,4)**, its head to (1,4), and a click on the top face of the wall
   * at (0,0) resolved to (-2,-2), off the grid entirely. Every click that landed on something
   * with height went to the wrong cell — which is why the guard could not be attacked and the
   * switch could not be reached by anything but bare floor, while walking looked fine.
   *
   * So: intersect the real scene graph, take the nearest hit, and read the cell off the object
   * that owns it (walls, floor plates, doors, pads and actor groups are all positioned on their
   * own cell). Only when the ray leaves the level entirely does it fall back to the ground plane,
   * which keeps a click on empty background resolving to something rather than nothing.
   */
  override pick(ndcX: number, ndcY: number): PickedPoint | null {
    // A raycast reads every object's `matrixWorld`, and `position.set` only marks it dirty. In a
    // browser the renderer refreshes them once a frame so this happens to work; anywhere else —
    // a test, a headless probe, or a click that lands between a `sync` and the next render — the
    // ray would be cast against the previous frame's scene, or against objects still stacked at
    // the origin. Clicks are rare; refreshing here costs nothing and removes the assumption.
    this.scene.updateMatrixWorld(true);
    this.#raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const hits = this.#raycaster.intersectObjects(
      [this.#level, this.#entities, ...(this.presentation?.pickingRoots() ?? [])],
      true,
    );
    for (const hit of hits) {
      if (!this.#pickVisible(hit.object)) continue;
      for (let node: Object3D | null = hit.object; node !== null; node = node.parent) {
        const cell = this.#pickCells.get(node);
        if (cell !== undefined) return { ...cell };
      }
      const visualOwner = this.presentation?.pickOwner(hit.object);
      if (visualOwner !== undefined)
        return { x: Math.round(visualOwner.x), y: Math.round(visualOwner.z), z: 0 };
      const owner = this.#ownerOf(hit.object);
      if (owner === null) continue;
      const at = owner.getWorldPosition(new Vector3());
      // `iso.intake` reads `pointer.world.x/.y` as *cell* coordinates (see mode-iso/systems.ts).
      return { x: Math.round(at.x), y: Math.round(at.z), z: 0 };
    }
    const ground = this.#raycaster.ray.intersectPlane(GROUND, new Vector3());
    if (ground === null) return null;
    return { x: Math.round(ground.x), y: Math.round(ground.z), z: 0 };
  }

  #pickVisible(object: Object3D): boolean {
    for (let node: Object3D | null = object; node !== null; node = node.parent) {
      // Explicit replacement levels retain their collision proxies for logical cell picking.
      if (node === this.#level) return true;
      if (!node.visible && !this.#pickProxies.has(node)) return false;
    }
    return true;
  }

  #bindPickCell(world: World, entity: Entity, x: number, y: number, legacy?: Object3D): void {
    const cell = { x: Math.round(x), y: Math.round(y), z: 0 };
    if (legacy !== undefined) this.#pickCells.set(legacy, cell);
    const name = world.get(entity, Name)?.value ?? String(entity);
    const visual = this.presentation?.entity(name);
    if (visual !== undefined) this.#pickCells.set(visual.root, cell);
  }

  /**
   * The object that owns a hit surface: the direct child of the level or entity group. A hit on an
   * actor's health bar or body must resolve to the actor's group, whose position is the cell.
   */
  #ownerOf(hit: Object3D): Object3D | null {
    let node: Object3D | null = hit;
    while (node !== null) {
      const parent: Object3D | null = node.parent;
      if (parent === this.#level || parent === this.#entities) return node;
      node = parent;
    }
    return null;
  }

  override dispose(): void {
    if (this.disposed) return;
    this.#pool.clear();
    this.#actorPoses.clear();
    this.#pickCells.clear();
    this.#pickProxies.clear();
    this.#primitives.dispose();
    super.dispose();
  }

  override resetPresentation(): void {
    this.#actorPoses.clear();
    super.resetPresentation();
  }

  /** Smooth only observed adjacent cell steps; never predict a patrol or change its logical cell. */
  #updateActorPoses(world: World): void {
    const claimed = new Set<number>();
    for (const view of world.query({ has: [GridPosition, Health] }).views()) {
      const grid = view.get(GridPosition);
      const alive = view.get(Health).current > 0;
      const next = nextPathCell(world, view.entity);
      const progress = next === undefined ? 0 : Math.min(Math.max(grid.progress, 0), 1);
      const x = grid.cellX + ((next?.x ?? grid.cellX) - grid.cellX) * progress;
      const z = grid.cellY + ((next?.y ?? grid.cellY) - grid.cellY) * progress;
      let pose = this.#actorPoses.get(view.entity);
      if (pose === undefined || world.tick < pose.tick) {
        pose = {
          cellX: grid.cellX,
          cellY: grid.cellY,
          tick: world.tick,
          movedAt: -Infinity,
          from: new Vector3(x, 0, z),
          position: new Vector3(x, 0, z),
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          state: 'idle',
          directionX: 0,
          directionZ: 0,
        };
        this.#actorPoses.set(view.entity, pose);
      } else if (grid.cellX !== pose.cellX || grid.cellY !== pose.cellY) {
        const dx = grid.cellX - pose.cellX;
        const dz = grid.cellY - pose.cellY;
        const adjacent = Math.abs(dx) + Math.abs(dz) === 1;
        const stepped =
          this.presentation !== undefined &&
          alive &&
          adjacent &&
          next === undefined &&
          pose.next === undefined &&
          world.tick > pose.tick &&
          world.tick - pose.tick <= STEP_BLEND_TICKS;
        pose.from.copy(pose.position);
        pose.movedAt = stepped ? world.tick : -Infinity;
        pose.directionX = dx;
        pose.directionZ = dz;
        pose.cellX = grid.cellX;
        pose.cellY = grid.cellY;
      }
      pose.tick = world.tick;
      pose.next = next;
      pose.target = view.tryGet(AttackOrder)?.target;
      const blending = alive && next === undefined && world.tick - pose.movedAt < STEP_BLEND_TICKS;
      pose.position.set(x, 0, z);
      if (blending) {
        const amount = Math.max(0, (world.tick - pose.movedAt) / STEP_BLEND_TICKS);
        pose.position.lerpVectors(pose.from, pose.position, amount);
      }
      pose.state = !alive ? 'dead' : next !== undefined || blending ? 'move' : 'idle';
      claimed.add(view.entity);
    }
    for (const id of this.#actorPoses.keys()) if (!claimed.has(id)) this.#actorPoses.delete(id);
    for (const pose of this.#actorPoses.values()) {
      if (pose.state === 'dead') continue;
      const target = pose.target === undefined ? undefined : this.#actorPoses.get(pose.target);
      const dx =
        pose.next !== undefined
          ? pose.next.x - pose.cellX
          : target !== undefined
            ? target.cellX - pose.cellX
            : pose.directionX;
      const dz =
        pose.next !== undefined
          ? pose.next.y - pose.cellY
          : target !== undefined
            ? target.cellY - pose.cellY
            : pose.directionZ;
      if (dx === 0 && dz === 0) continue;
      const yaw = atan2(dx, dz);
      pose.orientation.y = sin(yaw / 2);
      pose.orientation.w = cos(yaw / 2);
    }
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
          wall.material = this.presentation?.surface('wall', wall.material) ?? wall.material;
          wall.name = `wall:${x}:${y}`;
          wall.scale.set(nav.tileSize, WALL_HEIGHT, nav.tileSize);
          wall.position.set(at.x, WALL_HEIGHT / 2, at.z);
          this.#level.add(wall);
        } else {
          const floor = this.#primitives.boxMesh(resolveAppearance({ role: 'floor' }));
          floor.material = this.presentation?.surface('floor', floor.material) ?? floor.material;
          floor.name = `floor:${x}:${y}`;
          floor.scale.set(nav.tileSize * 0.94, 0.08, nav.tileSize * 0.94);
          floor.position.set(at.x, -0.04, at.z);
          this.#level.add(floor);
        }
      }
    }
    if (this.presentation?.manifest.camera?.framing === 'level') {
      const half = nav.tileSize / 2;
      this.#levelBounds = new Box3(
        new Vector3(-half, -0.08, -half),
        new Vector3(nav.width - 1 + half, 1.5, nav.height - 1 + half),
      );
      for (const spec of this.presentation.manifest.objects ?? []) {
        if (spec.anchor !== undefined && spec.anchor !== 'world') continue;
        if (spec.motion !== undefined || spec.parallax !== undefined) continue;
        const object = this.presentation.object(spec.id);
        if (object !== undefined) this.#levelBounds.union(new Box3().setFromObject(object.root));
      }
    }
    this.#levelBuilt = true;
  }

  /** Switch / exit pads, drawn flat on the floor. */
  #syncTriggers(world: World): void {
    for (const view of world.query({ has: [Trigger, Transform] }).views()) {
      const trigger = view.get(Trigger) as TriggerData;
      const transform = view.get(Transform);
      const position = transform.position;
      const role = triggerRole(trigger.kind);
      const pad = this.#pool.claim(`trigger:${view.entity}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role, opacity: 0.85 }), 'flat'),
      ) as Mesh;
      // Iso `Transform` positions are authored in grid coordinates: x = cellX, y = cellY.
      const at = cellToWorld(position.x, position.y);
      pad.scale.set(0.8, 0.12, 0.8);
      pad.position.set(at.x, 0.06, at.z);
      const appearance = resolveAppearance({
        role,
        sprite: view.tryGet(Sprite),
        model: view.tryGet(Model),
        opacity: 0.85,
      });
      pad.material = this.#primitives.material(appearance, 'flat');
      pad.visible = appearance.visible;
      pad.renderOrder = view.tryGet(Sprite)?.z ?? 0;
      this.presentation?.bindEntity(world, view.entity, {
        key: `trigger:${view.entity}`,
        role,
        origin: { x: at.x, y: position.z, z: at.z },
        bounds: { center: pad.position, size: pad.scale },
        orientation: transform.rotation,
        scale: transform.scale,
        legacy: [pad],
        trigger: true,
      });
      this.#bindPickCell(world, view.entity, position.x, position.y, pad);
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
      const appearance = resolveAppearance({
        role: 'door',
        sprite: view.tryGet(Sprite),
        model: view.tryGet(Model),
      });
      door.material = this.#primitives.material(appearance);
      door.visible = appearance.visible;
      door.renderOrder = view.tryGet(Sprite)?.z ?? 0;
      this.presentation?.bindEntity(world, view.entity, {
        key: `door:${view.entity}`,
        role: 'door',
        origin: { x: at.x, y: 0, z: at.z },
        bounds: { center: door.position, size: door.scale },
        legacy: [door],
      });
      this.#bindPickCell(world, view.entity, grid.cellX, grid.cellY, door);
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
        const meter = new Group();
        meter.name = 'health-meter';
        meter.position.y = 1.45;
        const barBack = this.#primitives.boxMesh(resolveAppearance({ role: 'dead' }), 'flat');
        barBack.name = 'bar:back';
        barBack.scale.set(0.76, 0.09, 0.02);
        const barFill = this.#primitives.boxMesh(resolveAppearance({ role }), 'flat');
        barFill.name = 'bar:fill';
        barFill.position.z = 0.015;
        meter.add(barBack, barFill);
        container.add(body, meter);
        return container;
      }) as Group;

      const pose = this.#actorPoses.get(view.entity)!;
      group.position.copy(pose.position);

      const fraction = health.max > 0 ? Math.min(Math.max(health.current / health.max, 0), 1) : 0;
      // A corpse stops looking like a live threat: it goes grey and lies down.
      const body = group.getObjectByName('body') as Mesh;
      // A narrow model limb must not punch a hole in the actor's logical click target.
      this.#pickProxies.add(body);
      const appearance = resolveAppearance({
        role: fraction > 0 ? role : 'dead',
        sprite: view.tryGet(Sprite),
        model: view.tryGet(Model),
      });
      body.material = this.#primitives.material(appearance);
      body.visible = appearance.visible;
      body.renderOrder = view.tryGet(Sprite)?.z ?? 0;
      group.visible = appearance.visible;
      body.scale.set(0.5, fraction > 0 ? 1.1 : 0.35, 0.5);
      body.position.y = fraction > 0 ? 0.55 : 0.18;

      const fill = group.getObjectByName('bar:fill') as Mesh;
      fill.scale.set(0.7 * fraction, 0.05, 0.02);
      fill.position.x = -0.35 * (1 - fraction);
      fill.material =
        this.presentation?.surface(role, this.#primitives.roleMaterial(role, 'flat')) ??
        this.#primitives.roleMaterial(role, 'flat');
      fill.visible = fraction > 0;
      const meter = group.getObjectByName('health-meter')!;
      meter.quaternion.copy(this.camera.quaternion);
      meter.visible = fraction > 0;
      this.presentation?.bindEntity(world, view.entity, {
        key: `actor:${view.entity}`,
        role,
        origin: group.position,
        bounds: {
          center: { x: group.position.x, y: 0.55, z: group.position.z },
          size: { x: 0.5, y: 1.1, z: 0.5 },
        },
        legacy: [body],
        state: pose.state,
        orientation: view.tryGet(Transform)?.rotation ?? pose.orientation,
        scale: view.tryGet(Transform)?.scale,
      });
      this.#bindPickCell(world, view.entity, grid.cellX, grid.cellY, group);
    }
  }

  /** Grid entities without a drawn collider still provide named attachment/replacement origins. */
  #syncOtherAnchors(world: World): void {
    if (this.presentation === undefined) return;
    for (const view of world.query({ has: [GridPosition], none: [Health, Blocking] }).views()) {
      const grid = view.get(GridPosition);
      const from = cellToWorld(grid.cellX, grid.cellY);
      const next = nextPathCell(world, view.entity);
      const to = next === undefined ? from : cellToWorld(next.x, next.y);
      const progress = next === undefined ? 0 : Math.min(Math.max(grid.progress, 0), 1);
      const origin = {
        x: from.x + (to.x - from.x) * progress,
        y: 0,
        z: from.z + (to.z - from.z) * progress,
      };
      this.presentation.bindEntity(world, view.entity, {
        key: `entity:${view.entity}`,
        role: 'neutral',
        origin,
        bounds: {
          center: { ...origin, y: 0.5 },
          size: { x: 1, y: 1, z: 1 },
        },
        state: next === undefined ? 'idle' : 'move',
      });
      this.#bindPickCell(world, view.entity, grid.cellX, grid.cellY);
    }
  }

  /** Framing is view-only; the authoritative camera and world are never edited. */
  #syncCamera(world: World): void {
    const rig = world.query({ has: [IsoCamera] }).first();
    const config = rig?.get(IsoCamera);
    const yaw = (config?.yawDegrees ?? 45) * DEG2RAD;
    const elevation = ISO_ELEVATION_DEG * DEG2RAD;
    const horizontal = cos(elevation);
    let focus: { x: number; z: number } = this.#focusOf(world, config?.target ?? '');
    let focusY = 0;
    let viewHeight = config?.viewHeight ?? FALLBACK_VIEW_HEIGHT;
    const framing = this.presentation?.manifest.camera;
    if (framing?.framing === 'level') {
      if (this.#levelBounds === undefined)
        throw new Error('[aegis] Isometric level framing requires a nonempty navigation grid.');
      if (this.#overview?.yaw !== yaw) {
        const size = this.#levelBounds.getSize(new Vector3());
        this.#overview = {
          yaw,
          center: this.#levelBounds.getCenter(new Vector3()),
          width: Math.abs(cos(yaw)) * size.x + Math.abs(sin(yaw)) * size.z,
          height:
            Math.abs(sin(elevation) * sin(yaw)) * size.x +
            horizontal * size.y +
            Math.abs(sin(elevation) * cos(yaw)) * size.z,
        };
      }
      const overview = this.#overview;
      const padding = framing.padding ?? 0.75;
      if (
        ![
          overview.center.x,
          overview.center.y,
          overview.center.z,
          overview.width,
          overview.height,
          this.#aspect,
        ].every(Number.isFinite) ||
        this.#aspect <= 0
      )
        throw new Error(
          '[aegis] Isometric level framing needs finite bounds and a positive viewport aspect.',
        );
      focus = overview.center;
      focusY = overview.center.y;
      viewHeight = Math.max(
        overview.height + 2 * padding,
        (overview.width + 2 * padding) / this.#aspect,
      );
      if (!Number.isFinite(viewHeight) || viewHeight <= 0)
        throw new Error('[aegis] Isometric level framing produced an invalid view extent.');
    }
    this.#applyFrustum(viewHeight);
    const offset = {
      x: sin(yaw) * horizontal,
      y: sin(elevation),
      z: cos(yaw) * horizontal,
    };
    this.camera.position.set(
      focus.x + offset.x * CAMERA_DISTANCE,
      focusY + offset.y * CAMERA_DISTANCE,
      focus.z + offset.z * CAMERA_DISTANCE,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(focus.x, focusY, focus.z);
    this.camera.updateMatrixWorld();
  }

  /** World position of the named follow target, falling back to the grid centre. */
  #focusOf(world: World, target: string): { x: number; z: number } {
    if (target !== '') {
      for (const view of world.query({ has: [GridPosition] }).views()) {
        if (world.get(view.entity, Name)?.value !== target) continue;
        const pose = this.#actorPoses.get(view.entity);
        if (pose !== undefined) return pose.position;
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

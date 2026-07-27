/**
 * The platformer render adapter: an orthographic, side-on view of the 2D world.
 *
 * Draws, all read straight from world state:
 * - the baked `PlatformerCollision` tilemap — solid tiles as grey blocks, hazard tiles (spikes,
 *   lava) as low red blocks so you can tell "wall" from "don't touch" at a glance;
 * - the player (`PlatformerController`), sized from its `TileCollider`, with a facing pip driven
 *   by `BodyState.facing`;
 * - other damageable bodies (the critter) in the enemy colour;
 * - `KinematicPlatform` solids at their current `Transform`, sized from their half-extents;
 * - `Trigger` volumes: goal in cyan, hazard in red, drawn translucent so you can see through them.
 *
 * The camera is the mode's own rig: the `PlatformerCamera` entity's `Transform` is the focus and
 * its `viewHeight` is the orthographic zoom, so what a human sees is exactly what the mode's
 * semantic frame describes.
 * @packageDocumentation
 */
import { AmbientLight, DirectionalLight, Group, OrthographicCamera, Scene } from 'three';
import type { Mesh } from 'three';
import { Transform } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import { Health, Sprite, Trigger } from '@aegis/content';
import type { TriggerData } from '@aegis/content';
import {
  BodyState,
  KinematicPlatform,
  PlatformerCamera,
  PlatformerCollision,
  PlatformerController,
  TileCollider,
} from '@aegis/mode-platformer';
import { BaseAdapter, ObjectPool, aspectOf, createModeScene } from '../adapter.js';
import type { RenderAdapterOptions } from '../adapter.js';
import { resolveAppearance } from '../appearance.js';
import type { VisualRole } from '../appearance.js';
import { Primitives } from '../primitives.js';

/** Default orthographic height used when a scene authored no camera rig. */
const FALLBACK_VIEW_HEIGHT = 12;
/** How far in front of the level the camera sits. 2D depth is cosmetic. */
const CAMERA_Z = 20;

/** The visual role of a trigger volume, by its authored `kind`. */
function triggerRole(kind: string): VisualRole {
  if (kind === 'hazard') return 'hazard';
  if (kind === 'switch') return 'switch';
  return 'goal';
}

/** The orthographic side-on adapter for `@aegis/mode-platformer`. */
export class PlatformerAdapter extends BaseAdapter {
  readonly mode: GameMode = 'platformer';
  readonly scene: Scene;
  readonly camera: OrthographicCamera;

  readonly #primitives = new Primitives();
  readonly #level = new Group();
  readonly #entities = new Group();
  readonly #pool: ObjectPool;
  #aspect: number;
  #levelBuilt = false;

  constructor(options: RenderAdapterOptions = {}) {
    super();
    this.#aspect = options.aspect ?? 16 / 9;
    this.scene = createModeScene('platformer', options.background);
    this.#level.name = 'level';
    this.#entities.name = 'entities';
    this.scene.add(this.#level, this.#entities);
    this.#pool = new ObjectPool(this.#entities);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.camera.name = 'camera';
    this.#applyFrustum(FALLBACK_VIEW_HEIGHT);
  }

  mount(world: World): void {
    const ambient = new AmbientLight(0xffffff, 1.6);
    ambient.name = 'light:ambient';
    const key = new DirectionalLight(0xffffff, 1.1);
    key.name = 'light:key';
    key.position.set(0.4, 0.8, 1);
    this.scene.add(ambient, key);
    this.#buildLevel(world);
    this.sync(world);
  }

  sync(world: World): void {
    if (!this.#levelBuilt) this.#buildLevel(world);
    this.#pool.begin();
    this.#syncPlatforms(world);
    this.#syncActors(world);
    this.#syncTriggers(world);
    this.#pool.sweep();
    this.#syncCamera(world);
  }

  resize(width: number, height: number): void {
    this.#aspect = aspectOf(width, height);
    this.#applyFrustum(this.camera.top - this.camera.bottom);
  }

  override dispose(): void {
    this.#pool.clear();
    this.#primitives.dispose();
    super.dispose();
  }

  /** Extrude the baked collision grid into blocks. Static: the grid never changes at runtime. */
  #buildLevel(world: World): void {
    const grid = world.getResource(PlatformerCollision);
    if (grid === undefined || grid.width === 0) return;
    const size = grid.tileSize;
    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const index = row * grid.width + col;
        const hazard = grid.hazard[index] === true;
        const solid = grid.solid[index] === true;
        if (!hazard && !solid) continue;
        const mesh = this.#primitives.boxMesh(
          resolveAppearance({ role: hazard ? 'hazard' : 'wall' }),
        );
        mesh.name = `tile:${col}:${row}`;
        // A tile at (col, row) spans x in [col, col+1] and y in [H-1-row, H-row] (mode convention).
        const bottom = grid.height - 1 - row;
        const height = hazard ? size * 0.35 : size;
        mesh.scale.set(size, height, size);
        mesh.position.set(col * size + size / 2, bottom * size + height / 2, 0);
        this.#level.add(mesh);
      }
    }
    this.#levelBuilt = true;
  }

  /** Moving solids, sized from their authored half-extents. */
  #syncPlatforms(world: World): void {
    for (const view of world.query({ has: [KinematicPlatform, Transform] }).views()) {
      const platform = view.get(KinematicPlatform);
      const position = view.get(Transform).position;
      const mesh = this.#pool.claim(`platform:${view.entity}`, () =>
        this.#primitives.boxMesh(
          resolveAppearance({ role: 'platform', sprite: view.tryGet(Sprite) }),
        ),
      ) as Mesh;
      mesh.scale.set(platform.halfWidth * 2, platform.halfHeight * 2, 1);
      mesh.position.set(position.x, position.y, position.z);
    }
  }

  /** The player and any other damageable body, sized from its collider. */
  #syncActors(world: World): void {
    for (const view of world
      .query({ has: [Transform, TileCollider], none: [KinematicPlatform] })
      .views()) {
      const collider = view.get(TileCollider);
      const position = view.get(Transform).position;
      const isPlayer = view.has(PlatformerController);
      const role: VisualRole = isPlayer ? 'player' : view.has(Health) ? 'enemy' : 'neutral';
      const group = this.#pool.claim(`actor:${view.entity}`, () => {
        const container = new Group();
        const body = this.#primitives.boxMesh(
          resolveAppearance({ role, sprite: view.tryGet(Sprite) }),
        );
        body.name = 'body';
        const pip = this.#primitives.boxMesh(resolveAppearance({ role: 'ceiling' }));
        pip.name = 'facing';
        container.add(body, pip);
        return container;
      }) as Group;

      const width = collider.halfWidth * 2;
      const height = collider.halfHeight * 2;
      const body = group.getObjectByName('body') as Mesh;
      body.scale.set(width, height, width);
      const pip = group.getObjectByName('facing') as Mesh;
      const facing = view.tryGet(BodyState)?.facing ?? 1;
      pip.scale.set(width * 0.28, height * 0.28, width * 1.05);
      pip.position.set(facing * collider.halfWidth * 0.55, collider.halfHeight * 0.3, 0);
      group.position.set(
        position.x + collider.offsetX,
        position.y + collider.offsetY,
        position.z + 0.5,
      );
    }
  }

  /** Goal and hazard volumes, translucent so the level reads through them. */
  #syncTriggers(world: World): void {
    for (const view of world.query({ has: [Trigger, Transform] }).views()) {
      const trigger = view.get(Trigger) as TriggerData;
      const position = view.get(Transform).position;
      const role = triggerRole(trigger.kind);
      const mesh = this.#pool.claim(`trigger:${view.entity}`, () =>
        this.#primitives.boxMesh(resolveAppearance({ role, opacity: 0.3 }), 'flat'),
      ) as Mesh;
      const half =
        trigger.shape === 'sphere' ? { x: trigger.radius, y: trigger.radius } : trigger.half;
      mesh.scale.set(half.x * 2, half.y * 2, 0.6);
      mesh.position.set(position.x, position.y, position.z + 1);
    }
  }

  /** Drive the orthographic camera from the mode's `PlatformerCamera` rig. */
  #syncCamera(world: World): void {
    const rig = world.query({ has: [PlatformerCamera, Transform] }).first();
    if (rig !== undefined) {
      const focus = rig.get(Transform).position;
      this.#applyFrustum(rig.get(PlatformerCamera).viewHeight);
      this.#aimAt(focus.x, focus.y);
      return;
    }
    const player = world.query({ has: [PlatformerController, Transform] }).first();
    const focus = player?.get(Transform).position ?? { x: 0, y: 0 };
    this.#applyFrustum(FALLBACK_VIEW_HEIGHT);
    this.#aimAt(focus.x, focus.y);
  }

  /**
   * Point the camera at a world position and refresh the matrix a projection reads.
   *
   * `lookAt` writes the quaternion; `matrixWorld` and its inverse are only refreshed by a render.
   * Anything projecting between `sync` and the next `renderer.render` — `aegis.project`, and this
   * package's tests — would otherwise measure against the previous frame's camera.
   */
  #aimAt(x: number, y: number): void {
    this.camera.position.set(x, y, CAMERA_Z);
    this.camera.lookAt(x, y, 0);
    this.camera.updateMatrixWorld(true);
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

/** Create the platformer adapter. */
export function createPlatformerAdapter(options?: RenderAdapterOptions): PlatformerAdapter {
  return new PlatformerAdapter(options);
}

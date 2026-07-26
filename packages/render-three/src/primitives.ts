/**
 * Small shared drawing primitives: cached unit geometries and materials.
 *
 * Every adapter draws the same handful of crude shapes — a box, a flat quad — scaled and tinted.
 * Sharing one unit geometry and de-duplicating materials by colour keeps object churn (and the
 * amount of rendering code in this package) close to nothing, which is what the charter's
 * "rendering is a thin adapter" anti-goal asks for.
 * @packageDocumentation
 */
import { BoxGeometry, Mesh, PlaneGeometry } from 'three';
import type { BufferGeometry, Material } from 'three';
import { flatMaterial, litMaterial, resolveAppearance } from './appearance.js';
import type { Appearance, VisualRole } from './appearance.js';

/** How a surface reacts to light. */
export type Shading = 'lit' | 'flat';

/**
 * A per-adapter cache of unit geometries and materials keyed by appearance, so the whole scene
 * shares a handful of GPU resources no matter how many boxes it draws.
 */
export class Primitives {
  /** A 1x1x1 box centred on the origin. Scale it to size. */
  readonly box: BoxGeometry = new BoxGeometry(1, 1, 1);
  /** A 1x1 quad in the XY plane, centred on the origin. */
  readonly plane: PlaneGeometry = new PlaneGeometry(1, 1);
  readonly #materials = new Map<string, Material>();

  /** A cached material for `appearance` under `shading`. */
  material(appearance: Appearance, shading: Shading = 'lit'): Material {
    const key = `${shading}|${appearance.color}|${appearance.opacity}`;
    const cached = this.#materials.get(key);
    if (cached !== undefined) return cached;
    const created = shading === 'flat' ? flatMaterial(appearance) : litMaterial(appearance);
    this.#materials.set(key, created);
    return created;
  }

  /** A cached material for a {@link VisualRole}, at `opacity`. */
  roleMaterial(role: VisualRole, shading: Shading = 'lit', opacity = 1): Material {
    return this.material(resolveAppearance({ role, opacity }), shading);
  }

  /** A unit box mesh using the cached geometry and a cached material. */
  boxMesh(appearance: Appearance, shading: Shading = 'lit'): Mesh {
    return new Mesh(this.box, this.material(appearance, shading));
  }

  /** A unit quad mesh using the cached geometry and a cached material. */
  planeMesh(appearance: Appearance, shading: Shading = 'flat'): Mesh {
    return new Mesh(this.plane, this.material(appearance, shading));
  }

  /** Release the cached geometries and materials. */
  dispose(): void {
    this.box.dispose();
    this.plane.dispose();
    for (const material of this.#materials.values()) material.dispose();
    this.#materials.clear();
  }
}

/** Set a mesh's scale from world-space extents. */
export function sizeMesh(
  mesh: Mesh<BufferGeometry, Material>,
  x: number,
  y: number,
  z: number,
): void {
  mesh.scale.set(x, y, z);
}

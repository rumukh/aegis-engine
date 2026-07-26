/**
 * Entity identity.
 *
 * An {@link Entity} is a branded integer packing a slot **index** and a **generation**.
 * When an entity is despawned its slot can be reused; the generation is bumped so a stale
 * handle to the old occupant compares unequal and {@link isEntityStale}-detectable. This
 * makes handles cheap (a number), serialisable, and safe against use-after-despawn.
 *
 * The packing layout is a stable contract: `index` in the low 32 bits, `generation` in the
 * high bits. Serialised snapshots use the decimal string of the whole id.
 * @packageDocumentation
 */

/** Opaque handle to an entity. Compare with `===`; never do arithmetic on it. */
export type Entity = number & { readonly __brand: 'Entity' };

/** The null entity — never alive, returned where "no entity" is meaningful. */
export const NULL_ENTITY = 0 as Entity;

/** Number of low bits used for the slot index. */
export const ENTITY_INDEX_BITS = 32;

/**
 * Largest generation an {@link Entity} handle can encode **exactly**.
 *
 * A handle is a float64, which holds 53 exact integer bits. With 32 bits spent on the index
 * that leaves 21 for the generation, so `2^21 - 1` recycles of a single slot is the hard
 * ceiling: past it `generation * 2^32 + index` rounds, and two distinct entities on an odd slot
 * pack to the same handle — an entity that is alive but unaddressable. `World.despawn` throws
 * rather than crossing it. At 60 Hz, a pool that despawns and respawns one entity every tick
 * reaches this in roughly ten hours, so it is reachable, not theoretical.
 */
export const MAX_ENTITY_GENERATION = 2097151; // 2 ** 21 - 1

/** Extract the slot index from an entity handle. */
export function entityIndex(entity: Entity): number {
  return entity % 2 ** ENTITY_INDEX_BITS;
}

/** Extract the generation counter from an entity handle. */
export function entityGeneration(entity: Entity): number {
  return Math.floor(entity / 2 ** ENTITY_INDEX_BITS);
}

/** Pack an index and generation into an {@link Entity} handle. */
export function makeEntity(index: number, generation: number): Entity {
  if (generation > MAX_ENTITY_GENERATION) {
    throw new RangeError(
      `[aegis] makeEntity: generation ${generation} exceeds MAX_ENTITY_GENERATION ` +
        `(${MAX_ENTITY_GENERATION}); the handle could not be represented exactly.`,
    );
  }
  return (generation * 2 ** ENTITY_INDEX_BITS + index) as Entity;
}

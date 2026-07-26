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
  return (generation * 2 ** ENTITY_INDEX_BITS + index) as Entity;
}

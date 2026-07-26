/**
 * The component registry: resolves the string component ids used in content documents to
 * the runtime {@link ComponentType}s that own their data shape and defaults.
 *
 * Components are defined across several packages (`@aegis/core`, each `@aegis/mode-*`, and
 * this package's visual components). A scene loader needs one lookup table spanning all of
 * them; a mode contributes its component types to the registry when it is activated.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { ComponentType } from '@aegis/core';

/** A lookup from component id to {@link ComponentType}. */
export interface ComponentRegistry {
  /** Register one component type. Throws on a duplicate id with a different type. */
  register(type: ComponentType<unknown>): this;
  /** Register many component types. */
  registerAll(types: Iterable<ComponentType<unknown>>): this;
  /** Resolve a component id, or `undefined` if unregistered. */
  get(id: string): ComponentType<unknown> | undefined;
  /** Whether an id is registered. */
  has(id: string): boolean;
  /** All registered ids, sorted, for diagnostics/tab-completion. */
  ids(): readonly string[];
}

/** Create a registry, optionally seeded with an initial set of component types. */
export function createRegistry(...types: ComponentType<unknown>[]): ComponentRegistry {
  return notImplemented(`createRegistry(${types.length} types)`);
}

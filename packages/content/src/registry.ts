/**
 * The component registry: resolves the string component ids used in content documents to
 * the runtime {@link ComponentType}s that own their data shape and defaults.
 *
 * Components are defined across several packages (`@aegis/core`, each `@aegis/mode-*`, and
 * this package's visual components). A scene loader needs one lookup table spanning all of
 * them; a mode contributes its component types to the registry when it is activated.
 *
 * The same problem exists one level up for **resources** — a scene's `resources` block is
 * addressed by string id too, and a typo there (`platformer.tilemp`) is exactly as silent as
 * a typo'd component id was. {@link ResourceRegistry} is the matching lookup table; supply
 * one through `ValidateOptions.resources` to have those ids checked.
 * @packageDocumentation
 */
import { canonicalStringify } from '@aegis/core';
import type { ComponentType, ResourceType } from '@aegis/core';
import type { ValueSchema } from './value-schema.js';

/** Existing type/string registrations stay ID-only; a plugin can also declare the value shape. */
export type ResourceDeclaration =
  string | ResourceType<unknown> | { readonly id: string; readonly schema: ValueSchema };

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
  const map = new Map<string, ComponentType<unknown>>();

  const registry: ComponentRegistry = {
    register(type: ComponentType<unknown>): ComponentRegistry {
      const existing = map.get(type.id);
      if (existing !== undefined && existing !== type) {
        throw new Error(
          `[aegis] ComponentRegistry: id "${type.id}" is already registered to a different component type`,
        );
      }
      map.set(type.id, type);
      return registry;
    },
    registerAll(list: Iterable<ComponentType<unknown>>): ComponentRegistry {
      for (const t of list) registry.register(t);
      return registry;
    },
    get(id: string): ComponentType<unknown> | undefined {
      return map.get(id);
    },
    has(id: string): boolean {
      return map.has(id);
    },
    ids(): readonly string[] {
      return [...map.keys()].sort();
    },
  };
  registry.registerAll(types);
  return registry;
}

/**
 * A lookup of the singleton resources a scene may set. Resources are applied wholesale
 * (no merge over defaults). Value constraints come only from explicit schemas.
 *
 * The shared harness bootstrap builds this from `ModePlugin.resources()` plus any explicit
 * caller registry. Headless runs, CLI validation and live sessions therefore reject unknown
 * authored IDs consistently. A legacy plugin that omits resources() declares no authored IDs;
 * migrate it by listing the resources it accepts, not by inferring them from the scene.
 *
 * Low-level content-only validation remains opt-in via `ValidateOptions.resources`. Runtime
 * resources set by systems are separate: the registry constrains authoring, not World storage.
 */
export interface ResourceRegistry {
  /** Register a resource by type, or by bare id when the type is not to hand. */
  register(resource: ResourceDeclaration): this;
  /** Register many resources. */
  registerAll(resources: Iterable<ResourceDeclaration>): this;
  /** A missing schema (including an older ID-only registry) supplies no value constraints. */
  schema?(id: string): ValueSchema | undefined;
  /** Whether an id is registered. */
  has(id: string): boolean;
  /** All registered ids, sorted, for diagnostics/tab-completion. */
  ids(): readonly string[];
}

/** Create a resource registry, optionally seeded with resource types or bare ids. */
export function createResourceRegistry(...resources: ResourceDeclaration[]): ResourceRegistry {
  const known = new Map<string, ValueSchema | undefined>();

  const registry: ResourceRegistry = {
    register(resource: ResourceDeclaration): ResourceRegistry {
      const id = typeof resource === 'string' ? resource : resource.id;
      if (typeof resource === 'object' && 'schema' in resource) {
        const previous = known.get(id);
        if (
          previous !== undefined &&
          previous !== resource.schema &&
          canonicalStringify(previous) !== canonicalStringify(resource.schema)
        )
          throw new Error(`[aegis] ResourceRegistry: conflicting schemas for "${id}".`);
        known.set(id, resource.schema);
      } else if (!known.has(id)) known.set(id, undefined);
      return registry;
    },
    registerAll(list: Iterable<ResourceDeclaration>): ResourceRegistry {
      for (const r of list) registry.register(r);
      return registry;
    },
    has(id: string): boolean {
      return known.has(id);
    },
    ids(): readonly string[] {
      return [...known.keys()].sort();
    },
    schema: (id) => known.get(id),
  };
  registry.registerAll(resources);
  return registry;
}

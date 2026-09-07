/**
 * Capability discovery reflects the same content context a run uses, without creating a world.
 * Defaults describe authoring shape, not gameplay correctness or undisclosed runtime rules.
 * @packageDocumentation
 */
import { canonicalStringify, SYSTEM_PHASES } from '@aegis/core';
import type { ComponentType, GameMode } from '@aegis/core';
import { componentFields, componentSchema, isDescribedId } from '@aegis/content';
import type { ComponentSchema, FieldKind } from '@aegis/content';
import { createSceneContext } from '@aegis/harness';
import { GLOBAL_FLAGS } from './args.js';
import type { Command } from './command.js';
import { AegisCliError, CliCode } from './errors.js';
import { formatFields } from './format.js';
import { describePluginSource } from './plugin.js';
import type { ResolvedPlugin } from './plugin.js';

/** Facts enforced by content/schema.ts, not a claim to be a complete JSON Schema. */
export interface ValueFacts {
  kind: FieldKind | 'any';
  finite?: true;
  fields?: Readonly<Record<string, ValueFacts>>;
  requiredKeys?: readonly string[];
  additionalFields?: boolean;
  items?: 'serialisable';
}

/** One accepted top-level component field. All top-level fields may be omitted. */
export interface ComponentFieldFacts {
  name: string;
  source: 'default' | 'optional-declaration';
  required: false;
  value: ValueFacts;
  /** Enums are checked only for authored strings, exactly as in content/schema.ts. */
  stringEnum?: readonly string[];
}

/** The selected registry's component identity and its authoring facts. */
export interface ComponentCapabilities {
  id: string;
  defaults: unknown;
  fields: readonly ComponentFieldFacts[];
  additionalFields: boolean;
  schema: ComponentSchema | null;
  schemaStatus: 'declared' | 'defaults-only' | 'identity-mismatch';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function declaredFacts(kind: FieldKind): ValueFacts {
  if (kind === 'number') return { kind, finite: true };
  if (kind === 'array') return { kind, items: 'serialisable' };
  if (kind === 'object') return { kind, additionalFields: true };
  return { kind };
}

function defaultFacts(value: unknown): ValueFacts {
  // A null default has no type information; a declared optional null, in contrast, accepts null.
  if (value === null || value === undefined) return { kind: 'any' };
  if (Array.isArray(value)) return declaredFacts('array');
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return {
      kind: 'object',
      fields: Object.fromEntries(keys.map((key) => [key, defaultFacts(value[key])])),
      requiredKeys: keys,
      additionalFields: keys.length === 0,
    };
  }
  const kind = typeof value;
  if (kind === 'number' || kind === 'string' || kind === 'boolean') {
    return declaredFacts(kind);
  }
  throw new AegisCliError(CliCode.PluginInvalid, 'Component defaults are not JSON data.', {
    fix: 'Return serialisable defaults from the component factory.',
  });
}

function describeComponentType(type: ComponentType<unknown>): ComponentCapabilities {
  const defaults = type.create();
  const shape = isObject(defaults) ? defaults : undefined;
  const schema = componentSchema(type);
  const fields = componentFields(type).map((name): ComponentFieldFacts => {
    const hasDefault = shape !== undefined && owns(shape, name);
    const optional = schema?.optional;
    const kind = optional !== undefined && owns(optional, name) ? optional[name] : undefined;
    let value: ValueFacts;
    if (hasDefault) {
      value = defaultFacts(shape[name]);
    } else if (kind !== undefined) {
      value = declaredFacts(kind);
    } else {
      throw new AegisCliError(
        CliCode.PluginInvalid,
        `Component "${type.id}" changed its field declarations during discovery.`,
        { fix: 'Make component defaults and schema declarations stable between calls.' },
      );
    }
    const enums = schema?.enums;
    const values = enums !== undefined && owns(enums, name) ? enums[name] : undefined;
    return {
      name,
      source: hasDefault ? 'default' : 'optional-declaration',
      required: false,
      value,
      ...(values !== undefined ? { stringEnum: values } : {}),
    };
  });
  return {
    id: type.id,
    defaults,
    fields,
    additionalFields: shape === undefined,
    schema: schema ?? null,
    schemaStatus:
      schema !== undefined
        ? 'declared'
        : isDescribedId(type.id)
          ? 'identity-mismatch'
          : 'defaults-only',
  };
}

const LIMITS = [
  'Defaults are authoring hints, not evidence that gameplay is correct.',
  'These are content validation facts, not a complete JSON Schema. Undeclared ranges, string unions, references and runtime requirements cannot be inferred.',
  'Component data must be an object and all authored values must be serialisable. Array elements, empty nested default objects and optional object/array contents have no shape constraints beyond serialisability.',
  'Top-level component fields may be omitted. Authored nonempty nested default objects must contain every declared key; they replace the default object rather than deep-merging.',
  'Resource declarations constrain IDs, not value schemas. Mode initialization may impose additional requirements.',
  'Prefab catalog entries are declarations, not expanded or validated instances. Describing a scene selects its plugin; it does not validate that scene.',
  'Plugin modules and declaration/default factories are executed. No world is created; init, system run functions and view providers are not called.',
  'Available input actions, emitted events and scene-specific view availability are not declared by ModePlugin and are not inferred from source code.',
] as const;

/** Build deterministic, versioned discovery data from a real selected plugin and CLI registry. */
export function describeCapabilities(
  resolved: ResolvedPlugin,
  commands: readonly Command[],
  modes: readonly GameMode[],
  scene: string | null = null,
) {
  const { plugin } = resolved;
  const context = createSceneContext(plugin);
  const components = context.registry.ids().map((id) => {
    const type = context.registry.get(id);
    if (type === undefined) {
      throw new AegisCliError(CliCode.PluginInvalid, `Registered component "${id}" is missing.`);
    }
    return describeComponentType(type);
  });
  const schedule = plugin.systems();
  const order = schedule.resolved().map((system, index) => ({
    index,
    name: system.name,
    phase: system.phase ?? 'update',
    before: system.before ?? [],
    after: system.after ?? [],
  }));
  const catalog = [...(plugin.prefabs?.() ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((declared) => {
      const prefab = context.prefabs.resolve(declared.name);
      if (prefab === undefined) {
        throw new AegisCliError(
          CliCode.PluginInvalid,
          `Prefab "${declared.name}" changed during discovery.`,
          { fix: 'Return a stable catalog from plugin.prefabs().' },
        );
      }
      return prefab;
    });

  return {
    aegis: 'capabilities/1' as const,
    scene,
    plugin: {
      spec: resolved.spec,
      source: resolved.source,
      mode: plugin.mode,
      ...(resolved.configFile !== undefined ? { configFile: resolved.configFile } : {}),
    },
    components,
    resources: {
      ids: context.resources.ids(),
      declared: plugin.resources !== undefined,
      valueSchemas: null,
    },
    prefabs: { declared: plugin.prefabs !== undefined, expanded: false, catalog },
    systems: {
      phases: SYSTEM_PHASES,
      order,
      unresolved: schedule.unresolved(),
      constraints: 'within-phase; cross-phase constraints do not override the fixed phase order',
    },
    operations: {
      modes: [...modes].sort(),
      commands: [...commands]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((command) => ({
          name: command.name,
          summary: command.summary,
          usage: command.usage,
          flags: { ...GLOBAL_FLAGS, ...command.flags },
          choices: command.choices ?? null,
          formats: command.formats ?? null,
        })),
    },
    limits: LIMITS,
  };
}

/** The capabilities/1 JSON document emitted by `aegis describe --json`. */
export type CapabilityDescription = ReturnType<typeof describeCapabilities>;

/** Greppable discovery output, retaining the same provenance and limitations as JSON. */
export function formatCapabilities(
  description: CapabilityDescription,
  resolved: ResolvedPlugin,
): string {
  const lines = [
    formatFields([
      ['format', description.aegis],
      ['plugin', describePluginSource(resolved)],
      ['mode', description.plugin.mode],
      ['scene', description.scene ?? '(no scene; declarations only)'],
    ]),
    `components: ${description.components.length}`,
  ];
  for (const component of description.components) {
    const fields = component.fields.map(
      (field) =>
        `${field.name}${field.source === 'optional-declaration' ? '?' : ''}:${field.value.kind}` +
        (field.stringEnum === undefined ? '' : `[${field.stringEnum.join('|')}]`),
    );
    lines.push(`  ${component.id}: ${fields.join(', ') || '(no declared fields)'}`);
    lines.push(`    defaults: ${canonicalStringify(component.defaults)}`);
    if (component.schemaStatus === 'identity-mismatch') {
      lines.push('    warning: schema declared for a different component identity; defaults only');
    }
  }
  lines.push(
    `resources: ${description.resources.ids.length} registered ID(s); value schemas unavailable`,
    ...description.resources.ids.map((id) => `  ${id}`),
    `prefabs: ${description.prefabs.catalog.length} catalog declaration(s); not expanded`,
    ...description.prefabs.catalog.map((prefab) => `  ${canonicalStringify(prefab)}`),
    `systems: ${description.systems.order.length} in resolved execution order`,
    ...description.systems.order.map(
      (system) =>
        `  ${system.index} ${system.phase} ${system.name}` +
        ` after=[${system.after.join(', ')}] before=[${system.before.join(', ')}]`,
    ),
    `unresolved constraints: ${description.systems.unresolved.length} (not applied)`,
    ...description.systems.unresolved.map(
      (constraint) => `  ${constraint.system} ${constraint.kind}: ${constraint.name}`,
    ),
    'commands:',
  );
  for (const command of description.operations.commands) {
    lines.push(`  ${command.name}: ${command.summary}`);
    lines.push(
      '    ' +
        Object.entries(command.flags)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([flag, kind]) => `--${flag}${kind === 'value' ? ' <value>' : ''}`)
          .join(' '),
    );
  }
  lines.push('limits:', ...description.limits.map((limit) => `  ${limit}`));
  return lines.join('\n');
}

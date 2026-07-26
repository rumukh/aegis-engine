/**
 * Parsing, validation and instantiation of content documents.
 *
 * The pipeline is: **text → parse → validate → instantiate**. Parsing and validation never
 * throw for content problems — they return a {@link Validated} carrying structured
 * {@link Diagnostic}s (CHARTER principle 8). Only truly exceptional conditions (a caller
 * passing a non-string) throw. Instantiation writes entities/components/resources into a
 * live {@link World} and reports what it created.
 *
 * Validation has two altitudes. *Structural* checks (`parseScene`) need only the document:
 * required fields, JSON types, tilemap geometry. *Semantic* checks (`validateScene`) need the
 * {@link ComponentRegistry}: that every component id resolves, and — via `schema.ts` — that
 * each component's authored data matches that component's own shape, field by field. The
 * second half is what stops a level from loading clean and being unwinnable.
 * @packageDocumentation
 */
import { defineTag, isGameMode, Name, Transform } from '@aegis/core';
import type {
  ComponentType,
  Diagnostic,
  Entity,
  ResourceType,
  Validated,
  Vec3,
  World,
} from '@aegis/core';
import { ContentCode, diagnostic } from './diagnostics.js';
import { suggestName, validateComponentData } from './schema.js';
import type { ComponentData, EntityDecl, PrefabFile, SceneFile, TilemapFile } from './scene.js';
import type { ComponentRegistry, ResourceRegistry } from './registry.js';

/** Resolves a prefab name to its {@link PrefabFile}. */
export interface PrefabResolver {
  /** Resolve a prefab by name, or `undefined` if unknown. */
  resolve(name: string): PrefabFile | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse JSON text into an object, or return an InvalidJson diagnostic. */
function parseJson(
  text: string,
  file?: string,
): { value?: Record<string, unknown>; diagnostic?: Diagnostic } {
  if (typeof text !== 'string') {
    throw new TypeError('[aegis] parse: expected a string of document text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      diagnostic: diagnostic(
        ContentCode.InvalidJson,
        `Document is not valid JSON: ${(err as Error).message}`,
        {
          location: file ? { file } : undefined,
          fix: 'Fix the JSON syntax; content documents must be strict JSON.',
        },
      ),
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      diagnostic: diagnostic(ContentCode.TypeMismatch, 'Document root must be a JSON object.', {
        location: file ? { file } : undefined,
      }),
    };
  }
  return { value: parsed };
}

/** Assert a field is a string; push a diagnostic and return undefined otherwise. */
function expectString(
  obj: Record<string, unknown>,
  key: string,
  diags: Diagnostic[],
  file: string | undefined,
  required = true,
): string | undefined {
  const v = obj[key];
  if (v === undefined) {
    if (required) {
      diags.push(
        diagnostic(ContentCode.MissingField, `Required field "${key}" is missing.`, {
          location: { file, path: key },
          fix: `Add a "${key}" string field.`,
        }),
      );
    }
    return undefined;
  }
  if (typeof v !== 'string') {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `Field "${key}" must be a string.`, {
        location: { file, path: key },
        data: { expected: 'string', received: typeof v },
      }),
    );
    return undefined;
  }
  return v;
}

/** Validate the structural shape of an entity declaration (recursively). */
function validateEntityShape(
  decl: unknown,
  path: string,
  diags: Diagnostic[],
  file: string | undefined,
): void {
  if (!isPlainObject(decl)) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `Entity at "${path}" must be an object.`, {
        location: { file, path },
      }),
    );
    return;
  }
  expectString(decl, 'id', diags, file);
  if (decl['id'] !== undefined) {
    // rewrite location path to include id for nested reads (best-effort)
  }
  if (decl['tags'] !== undefined && !Array.isArray(decl['tags'])) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `"${path}.tags" must be an array of strings.`, {
        location: { file, path: `${path}.tags` },
      }),
    );
  }
  if (decl['components'] !== undefined && !isPlainObject(decl['components'])) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `"${path}.components" must be an object.`, {
        location: { file, path: `${path}.components` },
      }),
    );
  } else if (isPlainObject(decl['components'])) {
    for (const [cid, cdata] of Object.entries(decl['components'])) {
      if (!isPlainObject(cdata)) {
        diags.push(
          diagnostic(
            ContentCode.InvalidComponentData,
            `Component "${cid}" data at "${path}.components.${cid}" must be an object.`,
            { location: { file, path: `${path}.components.${cid}` } },
          ),
        );
      }
    }
  }
  const children = decl['children'];
  if (children !== undefined) {
    if (!Array.isArray(children)) {
      diags.push(
        diagnostic(ContentCode.TypeMismatch, `"${path}.children" must be an array.`, {
          location: { file, path: `${path}.children` },
        }),
      );
    } else {
      children.forEach((c, i) => validateEntityShape(c, `${path}.children[${i}]`, diags, file));
    }
  }
}

/** Parse and validate a scene document from raw text. `file` is used in diagnostics only. */
export function parseScene(text: string, file?: string): Validated<SceneFile> {
  const parsed = parseJson(text, file);
  if (parsed.diagnostic) return { ok: false, diagnostics: [parsed.diagnostic] };
  const obj = parsed.value as Record<string, unknown>;
  const diags: Diagnostic[] = [];

  if (obj['aegis'] !== 'scene/1') {
    diags.push(
      diagnostic(
        ContentCode.UnknownFormat,
        `Expected "aegis": "scene/1", got ${JSON.stringify(obj['aegis'])}.`,
        {
          location: { file, path: 'aegis' },
          fix: 'Set the "aegis" discriminator to "scene/1".',
        },
      ),
    );
    return { ok: false, diagnostics: diags };
  }
  expectString(obj, 'name', diags, file);
  expectString(obj, 'mode', diags, file);
  const entities = obj['entities'];
  if (entities === undefined) {
    diags.push(
      diagnostic(ContentCode.MissingField, 'Required field "entities" is missing.', {
        location: { file, path: 'entities' },
        fix: 'Add an "entities" array (may be empty).',
      }),
    );
  } else if (!Array.isArray(entities)) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, '"entities" must be an array.', {
        location: { file, path: 'entities' },
      }),
    );
  } else {
    entities.forEach((e, i) => validateEntityShape(e, `entities[${i}]`, diags, file));
  }

  const ok = diags.every((d) => d.severity !== 'error');
  return ok
    ? { ok, value: obj as unknown as SceneFile, diagnostics: diags }
    : { ok, diagnostics: diags };
}

/** Parse and validate a prefab document from raw text. */
export function parsePrefab(text: string, file?: string): Validated<PrefabFile> {
  const parsed = parseJson(text, file);
  if (parsed.diagnostic) return { ok: false, diagnostics: [parsed.diagnostic] };
  const obj = parsed.value as Record<string, unknown>;
  const diags: Diagnostic[] = [];

  if (obj['aegis'] !== 'prefab/1') {
    diags.push(
      diagnostic(
        ContentCode.UnknownFormat,
        `Expected "aegis": "prefab/1", got ${JSON.stringify(obj['aegis'])}.`,
        {
          location: { file, path: 'aegis' },
          fix: 'Set the "aegis" discriminator to "prefab/1".',
        },
      ),
    );
    return { ok: false, diagnostics: diags };
  }
  expectString(obj, 'name', diags, file);
  if (obj['components'] !== undefined && !isPlainObject(obj['components'])) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, '"components" must be an object.', {
        location: { file, path: 'components' },
      }),
    );
  }
  const children = obj['children'];
  if (children !== undefined && Array.isArray(children)) {
    children.forEach((c, i) => validateEntityShape(c, `children[${i}]`, diags, file));
  }

  const ok = diags.every((d) => d.severity !== 'error');
  return ok
    ? { ok, value: obj as unknown as PrefabFile, diagnostics: diags }
    : { ok, diagnostics: diags };
}

/** Parse and validate a tilemap document from raw text. */
export function parseTilemap(text: string, file?: string): Validated<TilemapFile> {
  const parsed = parseJson(text, file);
  if (parsed.diagnostic) return { ok: false, diagnostics: [parsed.diagnostic] };
  const obj = parsed.value as Record<string, unknown>;
  const diags: Diagnostic[] = [];

  if (obj['aegis'] !== 'tilemap/1') {
    diags.push(
      diagnostic(
        ContentCode.UnknownFormat,
        `Expected "aegis": "tilemap/1", got ${JSON.stringify(obj['aegis'])}.`,
        {
          location: { file, path: 'aegis' },
          fix: 'Set the "aegis" discriminator to "tilemap/1".',
        },
      ),
    );
    return { ok: false, diagnostics: diags };
  }
  expectString(obj, 'name', diags, file);
  const width = obj['width'];
  const height = obj['height'];
  for (const [key, val] of [
    ['width', width],
    ['height', height],
    ['tileSize', obj['tileSize']],
  ] as const) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      diags.push(
        diagnostic(ContentCode.TypeMismatch, `"${key}" must be a finite number.`, {
          location: { file, path: key },
        }),
      );
    }
  }
  const legend = obj['legend'];
  if (!isPlainObject(legend)) {
    diags.push(
      diagnostic(
        ContentCode.MissingField,
        '"legend" must be an object mapping keys to tile defs.',
        {
          location: { file, path: 'legend' },
        },
      ),
    );
  }
  const layers = obj['layers'];
  if (!Array.isArray(layers)) {
    diags.push(
      diagnostic(ContentCode.MissingField, '"layers" must be an array of layers.', {
        location: { file, path: 'layers' },
      }),
    );
  } else if (typeof width === 'number' && typeof height === 'number') {
    const legendKeys = isPlainObject(legend) ? new Set(Object.keys(legend)) : new Set<string>();
    layers.forEach((layer, li) => {
      if (!isPlainObject(layer) || !Array.isArray(layer['data'])) {
        diags.push(
          diagnostic(ContentCode.TypeMismatch, `layers[${li}] must have a "data" array of rows.`, {
            location: { file, path: `layers[${li}]` },
          }),
        );
        return;
      }
      const rows = layer['data'] as unknown[];
      if (rows.length !== height) {
        diags.push(
          diagnostic(
            ContentCode.TilemapShapeMismatch,
            `layers[${li}] has ${rows.length} rows but height is ${height}.`,
            {
              location: { file, path: `layers[${li}].data` },
              data: { expected: height, received: rows.length },
            },
          ),
        );
      }
      rows.forEach((row, ri) => {
        if (typeof row !== 'string') {
          diags.push(
            diagnostic(ContentCode.TypeMismatch, `layers[${li}].data[${ri}] must be a string.`, {
              location: { file, path: `layers[${li}].data[${ri}]` },
            }),
          );
          return;
        }
        if (row.length !== width) {
          diags.push(
            diagnostic(
              ContentCode.TilemapShapeMismatch,
              `layers[${li}].data[${ri}] has length ${row.length} but width is ${width}.`,
              {
                location: { file, path: `layers[${li}].data[${ri}]` },
                data: { expected: width, received: row.length },
              },
            ),
          );
        }
        for (let ci = 0; ci < row.length; ci++) {
          const ch = row[ci] as string;
          if (ch === '.' || ch === ' ') continue; // empty
          if (!legendKeys.has(ch)) {
            diags.push(
              diagnostic(
                ContentCode.UnknownTile,
                `Unknown tile key "${ch}" at layers[${li}].data[${ri}][${ci}].`,
                {
                  location: { file, path: `layers[${li}].data[${ri}]`, column: ci + 1 },
                  data: { key: ch, legend: [...legendKeys].sort() },
                },
              ),
            );
          }
        }
      });
    });
  }

  const ok = diags.every((d) => d.severity !== 'error');
  return ok
    ? { ok, value: obj as unknown as TilemapFile, diagnostics: diags }
    : { ok, diagnostics: diags };
}

/** Options shared by validation and instantiation. */
export interface ValidateOptions {
  /** Registry used to resolve component ids. */
  registry: ComponentRegistry;
  /** Optional prefab resolver; required if any entity uses `prefab`. */
  prefabs?: PrefabResolver;
  /**
   * Optional registry of known resource ids. When supplied, a scene setting an id that is not
   * registered is an error (with a did-you-mean); when omitted, resource ids are **not
   * checked at all**, because there is no way to tell an unknown id from one belonging to a
   * package the caller did not mention.
   *
   * Note that `runScene` does not supply one today, so this is inert in the shipped run path
   * — see {@link ResourceRegistry} for the two changes that activate it (a `ModePlugin`
   * contract addition plus the three modes declaring their resources), deferred to v2.
   */
  resources?: ResourceRegistry;
  /**
   * Source file, echoed into every diagnostic location. Supply it when the scene came from
   * disk so diagnostics carry file **and** JSON path (CHARTER principle 8).
   */
  file?: string;
}

function collectEntityIds(
  decls: readonly EntityDecl[],
  path: string,
  diags: Diagnostic[],
  seen: Set<string>,
  file?: string,
): void {
  decls.forEach((decl, i) => {
    const p = `${path}[${i}]`;
    if (typeof decl.id === 'string') {
      if (seen.has(decl.id)) {
        diags.push(
          diagnostic(ContentCode.DuplicateId, `Duplicate entity id "${decl.id}".`, {
            location: { file, path: p },
            fix: 'Give each entity a unique id within the document.',
          }),
        );
      } else {
        seen.add(decl.id);
      }
    }
    if (decl.children) collectEntityIds(decl.children, `${p}.children`, diags, seen, file);
  });
}

/** State threaded through the semantic pass (registry lookups, prefab expansion, diagnostics). */
interface SemanticContext {
  options: ValidateOptions;
  diags: Diagnostic[];
  file: string | undefined;
  /** Prefabs whose own component data has already been checked, so a prefab used by twenty
   * entities reports its problems once. */
  checkedPrefabs: Set<string>;
}

/** Where a `componentId -> data` map lives, and who owns it. */
interface ComponentMapScope {
  /** JSON path of the components object itself. */
  path: string;
  /** Names the owner in the unknown-component message ("Entity \"hero\""). */
  subject: string;
  /**
   * The document the map really lives in. `undefined` for a prefab, because a
   * {@link PrefabResolver} hands back a {@link PrefabFile} with no path — and naming the
   * *scene* would send an agent to edit a file that does not contain the defect.
   */
  file: string | undefined;
  /**
   * Set when the map came from a prefab. Field-level diagnostics are stamped with it, because
   * "Component Velocity has no field speed" is useless on its own when forty entities share
   * one prefab: you need to know which document authored it and where to see it go wrong.
   */
  prefab?: { name: string; instantiatedBy: string };
}

/** Stamp a prefab-sourced diagnostic with the provenance the message cannot otherwise carry. */
function withPrefabProvenance(
  diag: Diagnostic,
  prefab: { name: string; instantiatedBy: string },
): Diagnostic {
  return {
    ...diag,
    message: `Prefab "${prefab.name}" (instantiated by entity "${prefab.instantiatedBy}"): ${diag.message}`,
    data: { ...(diag.data ?? {}), prefab: prefab.name, instantiatedBy: prefab.instantiatedBy },
  };
}

/**
 * Validate one `componentId -> data` map: first that every id resolves, then that each
 * component's data matches that component's own shape (`schema.ts`).
 */
function validateComponentMap(
  components: Readonly<Record<string, ComponentData>>,
  scope: ComponentMapScope,
  ctx: SemanticContext,
): void {
  const { registry } = ctx.options;
  const { file, path, prefab } = scope;
  for (const cid of Object.keys(components)) {
    const type = registry.get(cid);
    if (type === undefined) {
      const suggestion = suggestName(cid, registry.ids());
      ctx.diags.push(
        diagnostic(
          ContentCode.UnknownComponent,
          `${scope.subject} uses unknown component "${cid}"${
            suggestion === undefined ? '' : ` - did you mean "${suggestion}"?`
          }`,
          {
            location: { file, path: `${path}.${cid}` },
            data: {
              component: cid,
              ...(suggestion === undefined ? {} : { suggestion }),
              ...(prefab === undefined
                ? {}
                : { prefab: prefab.name, instantiatedBy: prefab.instantiatedBy }),
              known: registry.ids(),
            },
            fix:
              suggestion === undefined
                ? 'Register the component type, or fix the component id.'
                : `Rename "${cid}" to "${suggestion}", or register the component type.`,
          },
        ),
      );
      continue;
    }
    // The id resolves, so the component's own schema can now check the authored data.
    const found = validateComponentData(type, components[cid], { path: `${path}.${cid}`, file });
    ctx.diags.push(
      ...(prefab === undefined ? found : found.map((d) => withPrefabProvenance(d, prefab))),
    );
  }
}

function validateEntitySemantics(decls: readonly EntityDecl[], path: string, ctx: SemanticContext) {
  decls.forEach((decl, i) => {
    const p = `${path}[${i}]`;
    if (decl.prefab !== undefined) {
      const resolved = ctx.options.prefabs?.resolve(decl.prefab);
      if (resolved === undefined) {
        ctx.diags.push(
          diagnostic(
            ContentCode.UnknownPrefab,
            `Entity "${decl.id}" references unknown prefab "${decl.prefab}".`,
            {
              location: { file: ctx.file, path: `${p}.prefab` },
              fix: 'Provide a PrefabResolver that resolves this name, or fix the prefab reference.',
            },
          ),
        );
      } else if (!ctx.checkedPrefabs.has(decl.prefab)) {
        // A prefab is authored content too, and its data is merged in ahead of the entity's:
        // a typo there breaks every instance. Check it once, wherever it is first referenced,
        // and stamp what comes back with that reference so the report names an entity that
        // will visibly misbehave.
        ctx.checkedPrefabs.add(decl.prefab);
        if (resolved.components) {
          validateComponentMap(
            resolved.components,
            {
              path: `prefabs["${decl.prefab}"].components`,
              subject: `Prefab "${decl.prefab}" (instantiated by entity "${decl.id}")`,
              file: undefined,
              prefab: { name: decl.prefab, instantiatedBy: decl.id },
            },
            ctx,
          );
        }
      }
    }
    if (decl.components) {
      validateComponentMap(
        decl.components,
        { path: `${p}.components`, subject: `Entity "${decl.id}"`, file: ctx.file },
        ctx,
      );
    }
    if (decl.children) validateEntitySemantics(decl.children, `${p}.children`, ctx);
  });
}

/** Validate the resource ids a scene sets, when the caller supplied a resource registry. */
function validateResources(
  resources: Readonly<Record<string, unknown>>,
  ctx: SemanticContext,
): void {
  const known = ctx.options.resources;
  if (known === undefined) return;
  for (const id of Object.keys(resources)) {
    if (known.has(id)) continue;
    const suggestion = suggestName(id, known.ids());
    ctx.diags.push(
      diagnostic(
        ContentCode.UnknownResource,
        `Scene sets unknown resource "${id}"${
          suggestion === undefined ? '' : ` - did you mean "${suggestion}"?`
        } Nothing reads an unregistered resource, so whatever it configures keeps its default.`,
        {
          // Resource ids are dotted by convention ("platformer.tilemap"), so the bracket form
          // is the only unambiguous path: `resources.platformer.tilemp` reads as three steps.
          location: { file: ctx.file, path: `resources[${JSON.stringify(id)}]` },
          data: {
            resource: id,
            ...(suggestion === undefined ? {} : { suggestion }),
            known: known.ids(),
          },
          fix:
            suggestion === undefined
              ? `Remove "${id}", or register the resource type. Known: ${known.ids().join(', ')}.`
              : `Rename "${id}" to "${suggestion}".`,
        },
      ),
    );
  }
}

/**
 * Validate a prefab document against the registry: its component ids must resolve and its
 * component data must match each component's shape. The scene-level pass runs this implicitly
 * for every prefab a scene references; call it directly to check a prefab on its own.
 */
export function validatePrefab(
  prefab: PrefabFile,
  options: ValidateOptions,
): Validated<PrefabFile> {
  const diags: Diagnostic[] = [];
  const ctx: SemanticContext = {
    options,
    diags,
    file: options.file,
    checkedPrefabs: new Set<string>(),
  };
  if (prefab.components) {
    // Validated as its own document here, so the location names the prefab's own file and no
    // instantiating entity exists to attribute it to.
    validateComponentMap(
      prefab.components,
      { path: 'components', subject: `Prefab "${prefab.name}"`, file: options.file },
      ctx,
    );
  }
  if (prefab.children) validateEntitySemantics(prefab.children, 'children', ctx);

  const ok = diags.every((d) => d.severity !== 'error');
  return ok ? { ok, value: prefab, diagnostics: diags } : { ok, diagnostics: diags };
}

/**
 * Validate an already-parsed scene object against the registry: unknown components **and the
 * shape of every component's authored data** (`schema.ts`), prefab references and their data,
 * duplicate ids, resource ids, and the mode. Separated from {@link parseScene} so callers
 * holding a scene built in code (see the builder) can validate without re-serialising.
 */
export function validateScene(scene: SceneFile, options: ValidateOptions): Validated<SceneFile> {
  const diags: Diagnostic[] = [];
  const file = options.file;
  if (scene.aegis !== 'scene/1') {
    diags.push(
      diagnostic(
        ContentCode.UnknownFormat,
        `Expected a "scene/1" document, got ${JSON.stringify(scene.aegis)}.`,
        {
          location: { file, path: 'aegis' },
        },
      ),
    );
  }
  if (typeof scene.mode !== 'string' || !isGameMode(scene.mode)) {
    diags.push(
      diagnostic(
        ContentCode.UnknownMode,
        `Scene mode ${JSON.stringify(scene.mode)} is not a supported game mode.`,
        {
          location: { file, path: 'mode' },
          data: { mode: scene.mode, supported: ['platformer', 'iso', 'fps'] },
        },
      ),
    );
  }
  const ctx: SemanticContext = { options, diags, file, checkedPrefabs: new Set<string>() };
  const seen = new Set<string>();
  collectEntityIds(scene.entities ?? [], 'entities', diags, seen, file);
  if (scene.resources) validateResources(scene.resources, ctx);
  validateEntitySemantics(scene.entities ?? [], 'entities', ctx);

  const ok = diags.every((d) => d.severity !== 'error');
  return ok ? { ok, value: scene, diagnostics: diags } : { ok, diagnostics: diags };
}

/** Options for {@link instantiateScene}. */
export interface InstantiateOptions extends ValidateOptions {
  /**
   * Validate before instantiating. Default `true`. Set `false` only when the scene was
   * already validated, to avoid duplicate work.
   */
  validate?: boolean;
}

/** The result of instantiating a scene into a world. */
export interface InstantiateResult {
  /** `true` when no error-severity diagnostics were produced. */
  ok: boolean;
  /** All diagnostics produced during validation/instantiation. */
  diagnostics: readonly Diagnostic[];
  /** Map from scene entity id to the spawned {@link Entity} handle. */
  entities: Readonly<Record<string, Entity>>;
}

/** Merge component-id → data maps: `over` wins per component (shallow merge of the data). */
function mergeComponents(
  base: Readonly<Record<string, ComponentData>> | undefined,
  over: Readonly<Record<string, ComponentData>> | undefined,
): Record<string, ComponentData> {
  const out: Record<string, ComponentData> = {};
  if (base) for (const [k, v] of Object.entries(base)) out[k] = { ...v };
  if (over) for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}

/**
 * Instantiate a validated scene into `world`: apply resources, then spawn each entity
 * (resolving prefabs, merging component data over defaults, resolving child transforms).
 * Does not advance time.
 */
export function instantiateScene(
  world: World,
  scene: SceneFile,
  options: InstantiateOptions,
): InstantiateResult {
  const diags: Diagnostic[] = [];
  if (options.validate !== false) {
    const validated = validateScene(scene, options);
    if (!validated.ok) {
      return { ok: false, diagnostics: validated.diagnostics, entities: {} };
    }
    diags.push(...validated.diagnostics);
  }

  // Apply resources first (a resource is a plain id→value singleton).
  if (scene.resources) {
    for (const [id, value] of Object.entries(scene.resources)) {
      const resourceType: ResourceType<unknown> = { id, create: () => value };
      world.setResource(resourceType, value);
    }
  }

  const entities: Record<string, Entity> = {};

  const spawnDecl = (decl: EntityDecl, parentPos: Vec3 | null): Entity => {
    let tags: string[] = [];
    let components: Record<string, ComponentData> = {};
    if (decl.prefab !== undefined) {
      const prefab = options.prefabs?.resolve(decl.prefab);
      if (prefab !== undefined) {
        tags = [...(prefab.tags ?? [])];
        components = mergeComponents(prefab.components, undefined);
      }
    }
    for (const t of decl.tags ?? []) if (!tags.includes(t)) tags.push(t);
    components = mergeComponents(components, decl.components);

    const entity = world.spawn();
    // Every instantiated entity carries a Name equal to its authoring id (CHARTER principle 1).
    world.add(entity, Name, { value: decl.id });

    for (const [cid, data] of Object.entries(components)) {
      const type = options.registry.get(cid) as ComponentType<unknown> | undefined;
      if (type === undefined) continue; // already reported by validation
      world.add(entity, type, data as Partial<unknown>);
    }
    // Tags: marker components. Use the registered type when present, else a synthesized marker.
    for (const tag of tags) {
      const type = options.registry.get(tag) ?? defineTag(tag);
      world.add(entity, type, {});
    }

    // Resolve this entity's world-space position by translating the authored (local) position
    // by the parent's resolved world position. Rotation/scale are left as authored.
    let worldPos: Vec3 | null = null;
    const t = world.get(entity, Transform);
    if (t !== undefined) {
      if (parentPos !== null) {
        t.position = {
          x: t.position.x + parentPos.x,
          y: t.position.y + parentPos.y,
          z: t.position.z + parentPos.z,
        };
      }
      worldPos = t.position;
    } else if (parentPos !== null) {
      worldPos = parentPos;
    }

    entities[decl.id] = entity;
    for (const child of decl.children ?? []) spawnDecl(child, worldPos);
    return entity;
  };

  for (const decl of scene.entities ?? []) spawnDecl(decl, null);

  const ok = diags.every((d) => d.severity !== 'error');
  return { ok, diagnostics: diags, entities };
}

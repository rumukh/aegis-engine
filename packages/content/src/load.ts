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
import {
  defineTag,
  DiagnosticError,
  isGameMode,
  MAX_SERIALISABLE_DEPTH,
  Name,
  Transform,
} from '@aegis/core';
import type { Diagnostic, Entity, ResourceType, Validated, Vec3, World } from '@aegis/core';
import { ContentCode, diagnostic } from './diagnostics.js';
import {
  componentSchema,
  isDescribedId,
  reportUnserialisable,
  suggestName,
  validateComponentData,
} from './schema.js';
import type { ComponentData, EntityDecl, PrefabFile, SceneFile, TilemapFile } from './scene.js';
import type { ComponentRegistry, ResourceRegistry } from './registry.js';

/** Resolves a prefab name to its {@link PrefabFile}. */
export interface PrefabResolver {
  /** Resolve a prefab by name, or `undefined` if unknown. */
  resolve(name: string): PrefabFile | undefined;
}

/** Build a deterministic prefab catalog, refusing ambiguous duplicate names. */
export function createPrefabResolver(...prefabs: PrefabFile[]): PrefabResolver {
  const catalog = new Map<string, PrefabFile>();
  for (const prefab of prefabs) {
    if (catalog.has(prefab.name)) {
      throw new DiagnosticError([
        diagnostic(ContentCode.DuplicateId, `Duplicate prefab name "${prefab.name}".`, {
          location: { path: `prefabs[${JSON.stringify(prefab.name)}]` },
          fix: 'Give every prefab in the plugin catalog a unique name.',
          data: { prefab: prefab.name },
        }),
      ]);
    }
    catalog.set(prefab.name, prefab);
  }
  return { resolve: (name) => catalog.get(name) };
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
  ancestors: Set<object> = new Set(),
): void {
  if (!isPlainObject(decl)) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `Entity at "${path}" must be an object.`, {
        location: { file, path },
      }),
    );
    return;
  }
  if (ancestors.has(decl) || ancestors.size >= MAX_SERIALISABLE_DEPTH) {
    diags.push(
      diagnostic(
        ContentCode.UnserialisableValue,
        `Entity hierarchy at "${path}" is cyclic or too deep.`,
        {
          location: { file, path },
          fix: `Use an acyclic entity tree with fewer than ${MAX_SERIALISABLE_DEPTH} nested levels.`,
        },
      ),
    );
    return;
  }
  if (typeof decl['id'] !== 'string' || decl['id'].length === 0) {
    diags.push(
      diagnostic(
        decl['id'] === undefined ? ContentCode.MissingField : ContentCode.TypeMismatch,
        `"${path}.id" must be a non-empty string.`,
        {
          location: { file, path: `${path}.id` },
        },
      ),
    );
  }
  ancestors.add(decl);
  validateEntityBody(decl, path, diags, file, ancestors);
  ancestors.delete(decl);
}

/** The tags/components/children shape shared by scene entities and prefab roots. */
function validateEntityBody(
  decl: Record<string, unknown>,
  path: string,
  diags: Diagnostic[],
  file: string | undefined,
  ancestors: Set<object>,
): void {
  const at = (key: string) => (path === '' ? key : `${path}.${key}`);
  if (
    decl['prefab'] !== undefined &&
    (typeof decl['prefab'] !== 'string' || decl['prefab'].length === 0)
  ) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `"${at('prefab')}" must be a non-empty string.`, {
        location: { file, path: at('prefab') },
      }),
    );
  }
  if (
    decl['tags'] !== undefined &&
    (!Array.isArray(decl['tags']) ||
      decl['tags'].some((tag) => typeof tag !== 'string' || tag.length === 0))
  ) {
    diags.push(
      diagnostic(
        ContentCode.TypeMismatch,
        `"${at('tags')}" must be an array of non-empty strings.`,
        {
          location: { file, path: at('tags') },
        },
      ),
    );
  }
  if (decl['components'] !== undefined && !isPlainObject(decl['components'])) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, `"${at('components')}" must be an object.`, {
        location: { file, path: at('components') },
      }),
    );
  } else if (isPlainObject(decl['components'])) {
    for (const [cid, cdata] of Object.entries(decl['components'])) {
      if (!isPlainObject(cdata)) {
        diags.push(
          diagnostic(
            ContentCode.InvalidComponentData,
            `Component "${cid}" data at "${at('components')}.${cid}" must be an object.`,
            { location: { file, path: `${at('components')}.${cid}` } },
          ),
        );
      }
    }
  }
  const children = decl['children'];
  if (children !== undefined) {
    if (!Array.isArray(children)) {
      diags.push(
        diagnostic(ContentCode.TypeMismatch, `"${at('children')}" must be an array.`, {
          location: { file, path: at('children') },
        }),
      );
    } else {
      const ids = new Set<string>();
      children.forEach((c, i) => {
        const childPath = `${at('children')}[${i}]`;
        validateEntityShape(c, childPath, diags, file, ancestors);
        if (isPlainObject(c) && typeof c['id'] === 'string') {
          if (ids.has(c['id'])) {
            diags.push(
              diagnostic(ContentCode.DuplicateId, `Duplicate child id "${c['id']}".`, {
                location: { file, path: childPath },
                fix: 'Give each child within this parent a unique local id.',
              }),
            );
          }
          ids.add(c['id']);
        }
      });
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
  validateEntityBody(obj, '', diags, file, new Set([obj]));

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
   * Shared harness/CLI/live initialization always supplies one from ModePlugin.resources()
   * plus explicit caller declarations. Low-level content-only callers may still omit it.
   */
  resources?: ResourceRegistry;
  /**
   * Source file, echoed into every diagnostic location. Supply it when the scene came from
   * disk so diagnostics carry file **and** JSON path (CHARTER principle 8).
   */
  file?: string;
}

/** State threaded through the semantic pass (registry lookups, prefab expansion, diagnostics). */
interface SemanticContext {
  options: ValidateOptions;
  diags: Diagnostic[];
  file: string | undefined;
  /** Prefabs whose own component data has already been checked, so a prefab used by twenty
   * entities reports its problems once. */
  checkedPrefabs: Set<string>;
  checkedMaps: Set<string>;
  resolvedPrefabs: Map<string, PrefabFile | undefined>;
  entityIds: Map<string, string>;
  validate: boolean;
}

function semanticContext(options: ValidateOptions, validate = true): SemanticContext {
  return {
    options,
    diags: [],
    file: options.file,
    checkedPrefabs: new Set(),
    checkedMaps: new Set(),
    resolvedPrefabs: new Map(),
    entityIds: new Map(),
    validate,
  };
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
  if (prefab !== undefined) {
    if (ctx.checkedMaps.has(path)) return;
    ctx.checkedMaps.add(path);
  }
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
    if (!ctx.validate) continue;
    // The id resolves, so the component's own schema can now check the authored data.
    const found = validateComponentData(type, components[cid], { path: `${path}.${cid}`, file });
    ctx.diags.push(
      ...(prefab === undefined ? found : found.map((d) => withPrefabProvenance(d, prefab))),
    );
  }
}

interface ExpansionScope {
  file: string | undefined;
  /** Present only for declarations inherited from a prefab, never for scene-authored children. */
  namespace?: string;
  prefab?: { name: string; instantiatedBy: string };
  inheritedFrom: readonly string[];
  depth: number;
}

function validatePrefabShape(
  prefab: PrefabFile,
  path: string,
  diags: Diagnostic[],
  file?: string,
): boolean {
  const start = diags.length;
  if (!isPlainObject(prefab)) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, 'A prefab must be a JSON object.', {
        location: { file, path },
      }),
    );
    return false;
  }
  const at = (key: string) => (path === '' ? key : `${path}.${key}`);
  if (prefab.aegis !== 'prefab/1') {
    diags.push(
      diagnostic(ContentCode.UnknownFormat, 'Expected a "prefab/1" document.', {
        location: { file, path: at('aegis') },
      }),
    );
  }
  if (typeof prefab.name !== 'string' || prefab.name.length === 0) {
    diags.push(
      diagnostic(ContentCode.MissingField, 'A prefab needs a non-empty name.', {
        location: { file, path: at('name') },
      }),
    );
  }
  validateEntityBody(prefab, path, diags, file, new Set([prefab]));
  return diags.length === start;
}

/** Resolve once per operation, so validation and instantiation cannot observe different content. */
function resolvePrefab(
  name: string,
  id: string,
  path: string,
  scope: ExpansionScope,
  ctx: SemanticContext,
): PrefabFile | undefined {
  if (!ctx.resolvedPrefabs.has(name)) {
    const prefab = ctx.options.prefabs?.resolve(name);
    const valid =
      prefab !== undefined &&
      validatePrefabShape(prefab, `prefabs[${JSON.stringify(name)}]`, ctx.diags);
    ctx.resolvedPrefabs.set(name, valid ? prefab : undefined);
    if (prefab === undefined) {
      const problem = diagnostic(
        ContentCode.UnknownPrefab,
        `Entity "${id}" references unknown prefab "${name}".`,
        {
          location: { file: scope.file, path: `${path}.prefab` },
          fix: 'Declare the prefab in ModePlugin.prefabs(), supply a PrefabResolver, or fix the reference.',
          data: { prefab: name, instantiatedBy: id },
        },
      );
      ctx.diags.push(
        scope.prefab === undefined ? problem : withPrefabProvenance(problem, scope.prefab),
      );
    }
  }
  const prefab = ctx.resolvedPrefabs.get(name);
  if (prefab !== undefined && !ctx.checkedPrefabs.has(name)) {
    ctx.checkedPrefabs.add(name);
    if (prefab.components !== undefined) {
      validateComponentMap(
        prefab.components,
        {
          path: `prefabs[${JSON.stringify(name)}].components`,
          subject: `Prefab "${name}" (instantiated by entity "${id}")`,
          file: undefined,
          prefab: { name, instantiatedBy: id },
        },
        ctx,
      );
    }
  }
  return prefab;
}

function localId(id: string): string {
  return id.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Expand a hierarchy in preorder, validating the effective IDs before any world writes. */
function expandEntities(
  decls: readonly EntityDecl[],
  path: string,
  ctx: SemanticContext,
  scope: ExpansionScope,
): EntityDecl[] {
  if (decls.length > 0 && scope.depth >= MAX_SERIALISABLE_DEPTH) {
    ctx.diags.push(
      diagnostic(ContentCode.UnserialisableValue, `Expanded hierarchy at "${path}" is too deep.`, {
        location: { file: scope.file, path },
        fix: `Keep prefab expansion below ${MAX_SERIALISABLE_DEPTH} nested entity levels.`,
      }),
    );
    return [];
  }
  return decls.map((decl, i) => {
    const at = `${path}[${i}]`;
    const id = scope.namespace === undefined ? decl.id : `${scope.namespace}/${localId(decl.id)}`;
    const firstPath = ctx.entityIds.get(id);
    if (firstPath !== undefined) {
      ctx.diags.push(
        diagnostic(ContentCode.DuplicateId, `Duplicate entity id "${id}".`, {
          location: { file: scope.file, path: at },
          fix: 'Keep scene IDs globally unique and prefab child IDs unique within their parent. Avoid IDs colliding with an inherited instance path.',
          data: { id, firstPath },
        }),
      );
    } else {
      ctx.entityIds.set(id, at);
    }
    const prefab =
      decl.prefab === undefined ? undefined : resolvePrefab(decl.prefab, id, at, scope, ctx);
    if (decl.components !== undefined) {
      validateComponentMap(
        decl.components,
        {
          path: `${at}.components`,
          subject: `Entity "${id}"`,
          file: scope.file,
          ...(scope.prefab === undefined ? {} : { prefab: scope.prefab }),
        },
        ctx,
      );
    }
    const tags = [...new Set([...(prefab?.tags ?? []), ...(decl.tags ?? [])])];
    const components = mergeComponents(prefab?.components, decl.components);
    const authoredName = components['Name']?.['value'];
    if (authoredName !== undefined && authoredName !== id) {
      const fromDecl = Object.hasOwn(decl.components?.['Name'] ?? {}, 'value');
      ctx.diags.push(
        diagnostic(
          ContentCode.EntityNameMismatch,
          `Entity "${id}" authors Name.value "${String(authoredName)}", which conflicts with its resolved identity.`,
          {
            location: {
              file: fromDecl ? scope.file : undefined,
              path: fromDecl
                ? `${at}.components.Name.value`
                : `prefabs[${JSON.stringify(decl.prefab)}].components.Name.value`,
            },
            fix: 'Remove the conflicting Name component from the entity or prefab. Scene initialization derives Name from the resolved entity id, including any prefab namespace.',
            data: { entity: id, authoredName, expectedName: id },
          },
        ),
      );
    }
    if (Object.hasOwn(components, 'Name')) components['Name'] = { value: id };
    let children: EntityDecl[] = [];
    if (decl.children !== undefined) {
      children = expandEntities(decl.children, `${at}.children`, ctx, {
        ...scope,
        ...(scope.namespace === undefined ? {} : { namespace: id }),
        depth: scope.depth + 1,
      });
    } else if (prefab?.children !== undefined && decl.prefab !== undefined) {
      if (prefab.children.length > 0 && scope.inheritedFrom.includes(decl.prefab)) {
        const cycle = [...scope.inheritedFrom, decl.prefab];
        ctx.diags.push(
          diagnostic(ContentCode.PrefabCycle, `Prefab expansion cycle: ${cycle.join(' -> ')}.`, {
            location: { file: scope.file, path: `${at}.prefab` },
            fix: 'Break the recursive prefab child reference, or replace its children with a finite explicit list.',
            data: { cycle, entity: id },
          }),
        );
      } else {
        children = expandEntities(
          prefab.children,
          `prefabs[${JSON.stringify(decl.prefab)}].children`,
          ctx,
          {
            file: undefined,
            namespace: id,
            prefab: { name: decl.prefab, instantiatedBy: id },
            inheritedFrom: [...scope.inheritedFrom, decl.prefab],
            depth: scope.depth + 1,
          },
        );
      }
    }
    return { id, tags, components, children };
  });
}

/**
 * Warn about a component whose schema declaration is almost certainly keyed against a
 * *different* component object with the same id.
 *
 * Schemas are keyed by identity (`schema.ts`), which is what stops three modules' `Velocity`
 * from crosstalking — but identity keying can also miss, and a miss is silent: the component
 * falls through to the undeclared path, where its optional fields become hard "unknown field"
 * errors. That is the same silent-rejection failure this layer exists to prevent, so it is
 * reported rather than left to be discovered as a mysterious false positive. A warning, not an
 * error: two unrelated components may legitimately share an id (a game's `Player` and a test
 * mode's, say), and only the author can say which case this is.
 */
function checkSchemaDeclarations(ctx: SemanticContext): void {
  const { registry } = ctx.options;
  for (const id of registry.ids()) {
    const type = registry.get(id);
    if (type === undefined) continue;
    if (componentSchema(type) !== undefined) continue; // declared against this exact object
    if (!isDescribedId(id)) continue; // nobody ever declared anything under this name
    ctx.diags.push(
      diagnostic(
        ContentCode.SchemaKeyMismatch,
        `Component "${id}" is registered with no schema of its own, but describeComponent() was called for a different component object with the same id. Schemas are keyed by component identity, so this registration is validated against its defaults alone and any optional field the declaration was meant to permit will be reported as an unknown field.`,
        {
          severity: 'warning',
          location: { file: ctx.file },
          data: { component: id },
          fix: `Call describeComponent() with the exact ComponentType that is registered — declare it directly below the definition — or ignore this if two unrelated components legitimately share the id "${id}".`,
        },
      ),
    );
  }
}

/**
 * Validate the resource ids a scene sets (when the caller supplied a resource registry) and
 * every resource **value** (always).
 *
 * The two halves are deliberately independent. Id checking needs a registry, supplied by the
 * shared scene bootstrap on all shipped run paths. Value checking needs nothing: a
 * resource value is written straight into the world with `setResource`, which rejects anything
 * it cannot serialise — and `1e999` in a scene file is `Infinity` the moment `JSON.parse`
 * touches it, which is how a document validated clean and then killed the run.
 */
function validateResources(
  resources: Readonly<Record<string, unknown>>,
  ctx: SemanticContext,
): void {
  for (const [id, value] of Object.entries(resources)) {
    reportUnserialisable(
      value,
      `resources[${JSON.stringify(id)}]`,
      `Resource "${id}"`,
      ctx.file,
      ctx.diags,
    );
  }
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
        } The active plugin has not declared a consumer for this resource.`,
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
              ? `Declare "${id}" in ModePlugin.resources() (include both mode and game-owned IDs), ` +
                `or supply an explicit resource registry to the run. Legacy plugins that omit ` +
                `resources() accept only resource-free scenes. Known: ${known.ids().join(', ') || '(none)'}.`
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
  const ctx = semanticContext(options);
  const diags = ctx.diags;
  if (validatePrefabShape(prefab, '', diags, options.file)) {
    ctx.resolvedPrefabs.set(prefab.name, prefab);
    ctx.checkedPrefabs.add(prefab.name);
    if (prefab.components) {
      checkSchemaDeclarations(ctx);
      validateComponentMap(
        prefab.components,
        { path: 'components', subject: `Prefab "${prefab.name}"`, file: options.file },
        ctx,
      );
    }
    expandEntities(prefab.children ?? [], 'children', ctx, {
      file: options.file,
      namespace: prefab.name,
      inheritedFrom: [prefab.name],
      depth: 0,
    });
  }

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
  const expanded = expandScene(scene, options);
  return expanded.ok ? { ok: true, value: scene, diagnostics: expanded.diagnostics } : expanded;
}

/**
 * Resolve prefab inheritance into an explicit entity tree without writing a World.
 * Transforms remain local. Inherited IDs are qualified; scene-authored IDs are unchanged.
 */
export function expandScene(scene: SceneFile, options: ValidateOptions): Validated<SceneFile> {
  return prepareScene(scene, options, true);
}

function prepareScene(
  scene: SceneFile,
  options: ValidateOptions,
  validate: boolean,
): Validated<SceneFile> {
  const ctx = semanticContext(options, validate);
  const diags = ctx.diags;
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
  const shapeStart = diags.length;
  if (!Array.isArray(scene.entities)) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, '"entities" must be an array.', {
        location: { file, path: 'entities' },
      }),
    );
  } else {
    scene.entities.forEach((decl, i) => validateEntityShape(decl, `entities[${i}]`, diags, file));
  }
  if (scene.resources !== undefined && !isPlainObject(scene.resources)) {
    diags.push(
      diagnostic(ContentCode.TypeMismatch, '"resources" must be an object.', {
        location: { file, path: 'resources' },
      }),
    );
  }
  if (diags.length > shapeStart) return { ok: false, diagnostics: diags };
  if (validate) {
    checkSchemaDeclarations(ctx);
    if (scene.resources) validateResources(scene.resources, ctx);
  }
  const entities = expandEntities(scene.entities, 'entities', ctx, {
    file,
    inheritedFrom: [],
    depth: 0,
  });

  const ok = diags.every((d) => d.severity !== 'error');
  return ok
    ? { ok, value: { ...scene, entities }, diagnostics: diags }
    : { ok, diagnostics: diags };
}

/** Options for {@link instantiateScene}. */
export interface InstantiateOptions extends ValidateOptions {
  /**
   * Check component/resource data before instantiating. Default `true`. Set `false` only
   * for already-validated data. Structural, reference, cycle and expanded-ID checks always
   * run because expansion cannot safely proceed without them.
   */
  validate?: boolean;
}

/** The result of instantiating a scene into a world. */
export interface InstantiateResult {
  /** `true` when no error-severity diagnostics were produced. */
  ok: boolean;
  /** All diagnostics produced during validation/instantiation. */
  diagnostics: readonly Diagnostic[];
  /** Map from expanded entity id (qualified for inherited prefab children) to its handle. */
  entities: Readonly<Record<string, Entity>>;
}

/** Merge component-id → data maps: `over` wins per component (shallow merge of the data). */
function mergeComponents(
  base: Readonly<Record<string, ComponentData>> | undefined,
  over: Readonly<Record<string, ComponentData>> | undefined,
): Record<string, ComponentData> {
  const out = new Map<string, ComponentData>();
  if (base) for (const [k, v] of Object.entries(base)) out.set(k, { ...v });
  if (over) for (const [k, v] of Object.entries(over)) out.set(k, { ...out.get(k), ...v });
  return Object.fromEntries(out);
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
  const prepared = prepareScene(scene, options, options.validate !== false);
  if (!prepared.ok || prepared.value === undefined) {
    return { ok: false, diagnostics: prepared.diagnostics, entities: {} };
  }

  // Apply resources first (a resource is a plain id→value singleton).
  if (scene.resources) {
    for (const [id, value] of Object.entries(scene.resources)) {
      const resourceType: ResourceType<unknown> = { id, create: () => value };
      world.setResource(resourceType, value);
    }
  }

  const entities = new Map<string, Entity>();

  const spawnDecl = (decl: EntityDecl, parentPos: Vec3 | null): Entity => {
    const entity = world.spawn();

    for (const [cid, data] of Object.entries(decl.components ?? {})) {
      const type = options.registry.get(cid);
      if (type === undefined) {
        throw new DiagnosticError([
          diagnostic(
            ContentCode.UnknownComponent,
            `Component "${cid}" disappeared from the registry during instantiation.`,
            {
              fix: 'Keep the component registry unchanged for the duration of scene initialization.',
            },
          ),
        ]);
      }
      world.add(entity, type, data);
    }
    // Tags: marker components. Use the registered type when present, else a synthesized marker.
    for (const tag of decl.tags ?? []) {
      const type = options.registry.get(tag) ?? defineTag(tag);
      world.add(entity, type, {});
    }
    world.add(entity, Name, { value: decl.id });

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

    entities.set(decl.id, entity);
    for (const child of decl.children ?? []) spawnDecl(child, worldPos);
    return entity;
  };

  for (const decl of prepared.value.entities) spawnDecl(decl, null);

  return { ok: true, diagnostics: prepared.diagnostics, entities: Object.fromEntries(entities) };
}

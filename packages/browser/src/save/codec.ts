import { BrowserServiceError, isRecord, requireId, requireInteger } from '../errors.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface SaveEnvelope<State = JsonValue, Resume = JsonValue> {
  format: 'aegis.save';
  formatVersion: 1;
  gameId: string;
  profileId: string;
  contentRevision: string;
  schemaVersion: number;
  engine: { id: string; snapshotVersion: number; revision: string };
  revision: number;
  state: State;
  resume: Resume;
  settings?: JsonValue;
}

export interface SavePolicy<State, Resume> {
  gameId: string;
  profileId: string;
  schemaVersion: number;
  engineId: string;
  engineSnapshotVersion: number;
  acceptsContent(revision: string, schemaVersion: number): boolean;
  validateState(value: unknown, version: number): boolean;
  validateResume(value: unknown, schemaVersion: number): value is Resume;
  /** Must validate the latest schema independently of migration implementations. */
  isCurrentState(value: unknown): value is State;
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export const DEFAULT_SAVE_BYTES = 4 * 1024 * 1024;

export function checkJson(value: unknown, maxDepth = 64, maxNodes = 200_000): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth)
      throw new BrowserServiceError('limit', 'JSON exceeds nesting or node limits.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null)
      throw new BrowserServiceError('invalid-data', 'Save values must be finite JSON data.');
    if (ancestors.has(item))
      throw new BrowserServiceError('invalid-data', 'Save values must not contain cycles.');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new BrowserServiceError('invalid-data', 'Save objects must be plain records.');
    ancestors.add(item);
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (
        !('value' in descriptor) ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      )
        throw new BrowserServiceError('invalid-data', 'Save contains an unsafe property.');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length)
      throw new BrowserServiceError('invalid-data', 'Sparse arrays are not save data.');
    ancestors.delete(item);
  };
  visit(value, 0);
}

export function parseBoundedJson(text: string, maxBytes = DEFAULT_SAVE_BYTES): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new BrowserServiceError('invalid-data', 'maxBytes must be a positive integer.');
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes)
    throw new BrowserServiceError('limit', 'Imported document exceeds the byte limit.');
  try {
    const value: unknown = JSON.parse(text);
    checkJson(value);
    return value;
  } catch (cause) {
    if (cause instanceof BrowserServiceError) throw cause;
    throw new BrowserServiceError('invalid-data', 'Document is not valid JSON.', { cause });
  }
}

export function validateEnvelope<State, Resume>(
  input: unknown,
  policy: SavePolicy<State, Resume>,
  allowOld = false,
): SaveEnvelope<unknown, Resume> {
  checkJson(input, policy.maxDepth, policy.maxNodes);
  if (!isRecord(input) || input.format !== 'aegis.save')
    throw new BrowserServiceError('invalid-data', 'Not an Aegis save envelope.');
  if (input.formatVersion !== 1)
    throw new BrowserServiceError('incompatible', 'Unsupported save format version.');
  requireId(input.gameId, 'gameId');
  requireId(input.profileId, 'profileId');
  requireId(input.contentRevision, 'contentRevision');
  requireInteger(input.schemaVersion, 1, 'schemaVersion');
  requireInteger(input.revision, 1, 'revision');
  if (!isRecord(input.engine))
    throw new BrowserServiceError('invalid-data', 'Missing engine compatibility metadata.');
  requireId(input.engine.id, 'engine.id');
  requireId(input.engine.revision, 'engine.revision');
  requireInteger(input.engine.snapshotVersion, 1, 'engine.snapshotVersion');
  if (
    input.gameId !== policy.gameId ||
    input.profileId !== policy.profileId ||
    input.engine.id !== policy.engineId ||
    input.engine.snapshotVersion !== policy.engineSnapshotVersion ||
    input.schemaVersion > policy.schemaVersion ||
    (!allowOld && input.schemaVersion !== policy.schemaVersion) ||
    !policy.acceptsContent(input.contentRevision, input.schemaVersion)
  )
    throw new BrowserServiceError(
      'incompatible',
      'Save identity, engine, schema or content is incompatible.',
    );
  if (
    !policy.validateState(input.state, input.schemaVersion) ||
    !policy.validateResume(input.resume, input.schemaVersion)
  )
    throw new BrowserServiceError(
      'invalid-data',
      'Save state or resume data failed consumer validation.',
    );
  const encoded = JSON.stringify(input);
  if (new TextEncoder().encode(encoded).byteLength > (policy.maxBytes ?? DEFAULT_SAVE_BYTES))
    throw new BrowserServiceError('limit', 'Save exceeds the byte limit.');
  // The validated JSON is detached so callers cannot mutate a queued checkpoint.
  return JSON.parse(encoded) as SaveEnvelope<unknown, Resume>;
}

export function importSave<State, Resume>(
  text: string,
  policy: SavePolicy<State, Resume>,
): SaveEnvelope<State, Resume> {
  const envelope = validateEnvelope(parseBoundedJson(text, policy.maxBytes), policy);
  if (!policy.isCurrentState(envelope.state))
    throw new BrowserServiceError('invalid-data', 'Latest save state failed consumer validation.');
  return { ...envelope, state: envelope.state };
}

export function exportSave<State, Resume>(
  value: SaveEnvelope<State, Resume>,
  policy: SavePolicy<State, Resume>,
): string {
  return JSON.stringify(importSave(JSON.stringify(validateEnvelope(value, policy)), policy));
}

export interface SaveMigrationData {
  state: unknown;
  resume: unknown;
  contentRevision: string;
  settings?: JsonValue;
}
export type SaveMigration = {
  from: number;
  to: number;
} & (
  | { migrate(state: unknown): unknown; migrateEnvelope?: never }
  | { migrate?: never; migrateEnvelope(data: SaveMigrationData): SaveMigrationData }
);

export function migrateSave<State, Resume>(
  text: string,
  policy: SavePolicy<State, Resume>,
  migrations: readonly SaveMigration[],
): SaveEnvelope<State, Resume> {
  let envelope = validateEnvelope(parseBoundedJson(text, policy.maxBytes), policy, true);
  const steps = new Map<number, SaveMigration>();
  for (const step of migrations) {
    requireInteger(step.from, 1, 'migration.from');
    if (step.to !== step.from + 1 || steps.has(step.from))
      throw new BrowserServiceError('invalid-data', 'Migrations must be unique sequential steps.');
    steps.set(step.from, step);
  }
  while (envelope.schemaVersion < policy.schemaVersion) {
    const step = steps.get(envelope.schemaVersion);
    if (!step)
      throw new BrowserServiceError('incompatible', 'A sequential save migration is missing.');
    try {
      const data = step.migrateEnvelope
        ? step.migrateEnvelope({
            state: envelope.state,
            resume: envelope.resume,
            contentRevision: envelope.contentRevision,
            ...(envelope.settings === undefined ? {} : { settings: envelope.settings }),
          })
        : { state: step.migrate(envelope.state) };
      envelope = validateEnvelope({ ...envelope, ...data, schemaVersion: step.to }, policy, true);
    } catch (cause) {
      if (cause instanceof BrowserServiceError) throw cause;
      throw new BrowserServiceError(
        'invalid-data',
        `Save migration ${step.from} to ${step.to} failed.`,
        { cause },
      );
    }
  }
  return importSave(JSON.stringify(envelope), policy);
}

import { BrowserServiceError, isRecord, requireId, requireInteger } from '../errors.js';
import { checkJson, parseBoundedJson, validateEnvelope } from './codec.js';
import type { JsonValue, SaveEnvelope, SavePolicy } from './codec.js';
import { storageRevision } from './storage.js';
import type { SaveKey, SaveStorage } from './storage.js';

/**
 * Local profiles (SAVE-08). A registry is one compare-and-swap record in the same `SaveStorage`
 * the saves use, under a reserved profile key, so cross-tab conflicts are detected exactly as for
 * saves. Each profile's progress keeps using `SaveService` with the key from `saveKeyFor`.
 */
export const PROFILE_REGISTRY_KEY = 'aegis.profiles';
export const DEVICE_SETTINGS_KEY = 'aegis.device';
const REGISTRY_FORMAT = 'aegis-profiles/1';
const DEVICE_FORMAT = 'aegis-device/1';
const MAX_PROFILES = 64;
const MAX_NAME = 64;
const MAX_SETTINGS_BYTES = 64 * 1024;
const CONFLICT_RETRIES = 3;

export interface Profile {
  id: string;
  name: string;
  /** Registry revision at which the profile was created; stable for ordering. */
  created: number;
  /** Per-profile settings, for example the avatar composition. */
  settings: JsonValue;
}
export interface ProfileRegistryOptions {
  storage: SaveStorage;
  gameId: string;
  /** Maximum number of profiles, 1..64. */
  limit: number;
  /**
   * Save slots per profile. Defaults to one unnamed slot. Each slot is a separate save key, and
   * removing a profile resets every declared slot.
   */
  slots?: readonly string[];
  /** Optional validation of per-profile settings (after the built-in JSON bounds). */
  validateSettings?(value: unknown): boolean;
  /** Optional validation of device settings (after the built-in JSON bounds). */
  validateDevice?(value: unknown): boolean;
}
export interface ProfileRegistrySnapshot {
  revision: number;
  profiles: readonly Profile[];
}
interface RegistryDocument {
  format: typeof REGISTRY_FORMAT;
  next: number;
  profiles: Profile[];
}

function boundedSettings(value: unknown, check?: (value: unknown) => boolean): JsonValue {
  checkJson(value, 32, 10_000);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_BYTES)
    throw new BrowserServiceError('limit', 'Settings exceed 64 KiB.');
  if (check && !check(value))
    throw new BrowserServiceError('invalid-data', 'Settings failed consumer validation.');
  return JSON.parse(text) as JsonValue;
}

function profileName(value: unknown): string {
  if (typeof value !== 'string')
    throw new BrowserServiceError('invalid-data', 'A profile name must be a string.');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > MAX_NAME || /\p{Cc}/u.test(name))
    throw new BrowserServiceError(
      'invalid-data',
      `A profile name must have 1-${String(MAX_NAME)} printable characters.`,
    );
  return name;
}

function parseRegistry(payload: string | undefined, limit: number): RegistryDocument {
  if (payload === undefined) return { format: REGISTRY_FORMAT, next: 1, profiles: [] };
  const value = parseBoundedJson(payload, 8 * 1024 * 1024);
  if (
    !isRecord(value) ||
    value.format !== REGISTRY_FORMAT ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > Math.max(limit, MAX_PROFILES)
  )
    throw new BrowserServiceError('invalid-data', 'Stored profile registry is corrupt.');
  requireInteger(value.next, 1, 'profile registry counter');
  const ids = new Set<string>();
  const profiles = value.profiles.map((item: unknown): Profile => {
    if (!isRecord(item))
      throw new BrowserServiceError('invalid-data', 'Stored profile is corrupt.');
    requireId(item.id, 'profile id');
    requireInteger(item.created, 0, 'profile created revision');
    if (ids.has(item.id) || item.id === PROFILE_REGISTRY_KEY || item.id === DEVICE_SETTINGS_KEY)
      throw new BrowserServiceError(
        'invalid-data',
        'Stored profile IDs are duplicate or reserved.',
      );
    ids.add(item.id);
    return {
      id: item.id,
      name: profileName(item.name),
      created: item.created,
      settings: boundedSettings(item.settings),
    };
  });
  return { format: REGISTRY_FORMAT, next: value.next, profiles };
}

export interface ProfileRegistry {
  readonly gameId: string;
  readonly limit: number;
  readonly slots: readonly string[];
  list(): Promise<ProfileRegistrySnapshot>;
  get(id: string): Promise<Profile | undefined>;
  create(input: { name: string; settings?: JsonValue; id?: string }): Promise<Profile>;
  rename(id: string, name: string): Promise<Profile>;
  updateSettings(id: string, settings: JsonValue): Promise<Profile>;
  /** Resets every declared slot of the profile, then removes it. `confirm` must equal `id`. */
  remove(id: string, confirmation: { confirm: string }): Promise<void>;
  /** The `SaveService`/`SaveStorage` key for a profile's slot. */
  saveKeyFor(id: string, slot?: string): SaveKey;
  device(): Promise<{ revision: number; settings: JsonValue | undefined }>;
  setDevice(settings: JsonValue): Promise<number>;
}

export function createProfileRegistry(options: ProfileRegistryOptions): ProfileRegistry {
  const { storage, gameId, limit } = options;
  requireId(gameId, 'gameId');
  requireInteger(limit, 1, 'profile limit');
  if (limit > MAX_PROFILES)
    throw new BrowserServiceError('limit', `At most ${String(MAX_PROFILES)} profiles.`);
  const slots = [...(options.slots ?? [''])];
  if (
    !slots.length ||
    slots.length > 16 ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => slot !== '' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(slot)) ||
    (slots.includes('') && slots.length > 1)
  )
    throw new BrowserServiceError(
      'invalid-data',
      'Slots must be up to 16 unique simple names, or one unnamed slot.',
    );
  const registryKey: SaveKey = { gameId, profileId: PROFILE_REGISTRY_KEY };
  const deviceKey: SaveKey = { gameId, profileId: DEVICE_SETTINGS_KEY };

  const read = async (): Promise<{ revision: number; document: RegistryDocument }> => {
    const history = await storage.read(registryKey);
    return {
      revision: storageRevision(history),
      document: parseRegistry(history.current?.payload, limit),
    };
  };
  /** Optimistic read-modify-write; the mutation re-runs against fresh state after a conflict. */
  const mutate = async <T>(
    change: (document: RegistryDocument, revision: number) => T,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const { revision, document } = await read();
      const result = change(document, revision);
      try {
        await storage.compareAndSwap(registryKey, revision, {
          revision: revision + 1,
          payload: JSON.stringify(document),
        });
        return result;
      } catch (cause) {
        if (
          !(cause instanceof BrowserServiceError && cause.code === 'conflict') ||
          attempt + 1 >= CONFLICT_RETRIES
        )
          throw cause;
      }
    }
  };
  const find = (document: RegistryDocument, id: string): Profile => {
    requireId(id, 'profile id');
    const profile = document.profiles.find((item) => item.id === id);
    if (!profile) throw new BrowserServiceError('invalid-data', 'Unknown profile.');
    return profile;
  };
  const saveKeyFor = (id: string, slot?: string): SaveKey => {
    requireId(id, 'profile id');
    if (id === PROFILE_REGISTRY_KEY || id === DEVICE_SETTINGS_KEY || id.includes(':'))
      throw new BrowserServiceError('invalid-data', 'Reserved profile ID or separator.');
    const name = slot ?? slots[0]!;
    if (!slots.includes(name)) throw new BrowserServiceError('invalid-data', 'Unknown save slot.');
    return { gameId, profileId: name ? `${id}:${name}` : id };
  };

  return {
    gameId,
    limit,
    slots,
    async list() {
      const { revision, document } = await read();
      return { revision, profiles: structuredClone(document.profiles) };
    },
    async get(id) {
      requireId(id, 'profile id');
      const { document } = await read();
      const profile = document.profiles.find((item) => item.id === id);
      return profile ? structuredClone(profile) : undefined;
    },
    async create(input) {
      const name = profileName(input.name);
      const settings = boundedSettings(input.settings ?? null, options.validateSettings);
      if (input.id !== undefined) saveKeyFor(input.id);
      return mutate((document, revision) => {
        if (document.profiles.length >= limit)
          throw new BrowserServiceError('limit', `At most ${String(limit)} profiles.`);
        const id = input.id ?? `profile-${String(document.next)}`;
        if (document.profiles.some((item) => item.id === id))
          throw new BrowserServiceError('conflict', 'A profile with this ID exists.');
        const profile: Profile = { id, name, created: revision + 1, settings };
        document.profiles.push(profile);
        // IDs are never reused, so a removed profile's tombstoned saves cannot be inherited.
        document.next += 1;
        return structuredClone(profile);
      });
    },
    async rename(id, value) {
      const name = profileName(value);
      return mutate((document) => {
        const profile = find(document, id);
        profile.name = name;
        return structuredClone(profile);
      });
    },
    async updateSettings(id, value) {
      const settings = boundedSettings(value, options.validateSettings);
      return mutate((document) => {
        const profile = find(document, id);
        profile.settings = settings;
        return structuredClone(profile);
      });
    },
    async remove(id, confirmation) {
      requireId(id, 'profile id');
      if (!isRecord(confirmation) || confirmation.confirm !== id)
        throw new BrowserServiceError('confirmation', 'Removing a profile requires its exact ID.');
      const { document } = await read();
      find(document, id);
      for (const slot of slots) {
        const key = saveKeyFor(id, slot);
        const history = await storage.read(key);
        if (history.current) await storage.reset(key, storageRevision(history), key);
      }
      await mutate((fresh) => {
        const index = fresh.profiles.findIndex((item) => item.id === id);
        if (index < 0)
          throw new BrowserServiceError('conflict', 'The profile was already removed.');
        fresh.profiles.splice(index, 1);
      });
    },
    saveKeyFor,
    async device() {
      const history = await storage.read(deviceKey);
      const revision = storageRevision(history);
      if (!history.current) return { revision, settings: undefined };
      const value = parseBoundedJson(history.current.payload, 1024 * 1024);
      if (!isRecord(value) || value.format !== DEVICE_FORMAT || !('settings' in value))
        throw new BrowserServiceError('invalid-data', 'Stored device settings are corrupt.');
      return { revision, settings: boundedSettings(value.settings) };
    },
    async setDevice(value) {
      const settings = boundedSettings(value, options.validateDevice);
      for (let attempt = 0; ; attempt++) {
        const revision = storageRevision(await storage.read(deviceKey));
        try {
          await storage.compareAndSwap(deviceKey, revision, {
            revision: revision + 1,
            payload: JSON.stringify({ format: DEVICE_FORMAT, settings }),
          });
          return revision + 1;
        } catch (cause) {
          if (
            !(cause instanceof BrowserServiceError && cause.code === 'conflict') ||
            attempt + 1 >= CONFLICT_RETRIES
          )
            throw cause;
        }
      }
    },
  };
}

/**
 * Rebind or copy a save envelope to another profile (issue #15). The source is validated as an
 * ordinary envelope of its own profile (older schema versions are accepted, so migration still
 * happens at load); only `profileId` changes; the result is validated for the target. The
 * `revision` is kept as provenance: `SaveService.save` assigns the next storage revision, so
 * install it with `service.save(withoutRevision(rebound))` after `service.load()`.
 */
export function rebindSave<State, Resume>(
  source: string | SaveEnvelope<unknown, unknown>,
  target: { profileId: string; expectSource?: string },
  policy: SavePolicy<State, Resume>,
): SaveEnvelope<unknown, Resume> {
  requireId(target.profileId, 'profileId');
  if (target.profileId !== policy.profileId)
    throw new BrowserServiceError('invalid-data', 'The policy must describe the target profile.');
  const input =
    typeof source === 'string'
      ? parseBoundedJson(source, policy.maxBytes)
      : structuredClone(source);
  if (!isRecord(input))
    throw new BrowserServiceError('invalid-data', 'Not an Aegis save envelope.');
  requireId(input.profileId, 'profileId');
  if (target.expectSource !== undefined && input.profileId !== target.expectSource)
    throw new BrowserServiceError('confirmation', 'The save belongs to a different profile.');
  validateEnvelope(input, { ...policy, profileId: input.profileId }, true);
  return validateEnvelope({ ...input, profileId: target.profileId }, policy, true);
}

/** The draft shape `SaveService.save` accepts. */
export function withoutRevision<State, Resume>(
  envelope: SaveEnvelope<State, Resume>,
): Omit<SaveEnvelope<State, Resume>, 'revision'> {
  const { revision: _revision, ...draft } = envelope;
  return draft;
}

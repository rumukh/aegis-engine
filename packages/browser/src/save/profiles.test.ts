import { describe, expect, it } from 'vitest';
import { exportSave, importSave } from './codec.js';
import type { SaveEnvelope, SavePolicy } from './codec.js';
import {
  createProfileRegistry,
  DEVICE_SETTINGS_KEY,
  PROFILE_REGISTRY_KEY,
  rebindSave,
  withoutRevision,
} from './profiles.js';
import { SaveService } from './service.js';
import { MemorySaveStorage } from './storage.js';
import type { SaveKey, SaveStorage, StoredSave } from './storage.js';

interface State {
  solved: number;
}
const isState = (value: unknown): value is State =>
  typeof value === 'object' && value !== null && Number.isSafeInteger((value as State).solved);
const policyFor = (profileId: string): SavePolicy<State, string> => ({
  gameId: 'fluffy',
  profileId,
  schemaVersion: 2,
  engineId: 'aegis',
  engineSnapshotVersion: 1,
  acceptsContent: (revision) => revision === 'c1',
  validateState: (value, version) => (version === 1 ? typeof value === 'number' : isState(value)),
  isCurrentState: isState,
  validateResume: (value): value is string => typeof value === 'string',
});
const draft = (profileId: string, solved: number) => ({
  format: 'aegis.save' as const,
  formatVersion: 1 as const,
  gameId: 'fluffy',
  profileId,
  contentRevision: 'c1',
  schemaVersion: 2,
  engine: { id: 'aegis', snapshotVersion: 1, revision: 'test' },
  state: { solved },
  resume: 'office',
});

async function service(storage: SaveStorage, key: SaveKey): Promise<SaveService<State, string>> {
  const result = new SaveService(storage, policyFor(key.profileId));
  await result.load();
  return result;
}

describe('profile registry (SAVE-08)', () => {
  it('isolates four profiles: rebind, export, import and reset one; the others are untouched (F10)', async () => {
    const storage = new MemorySaveStorage();
    const registry = createProfileRegistry({ storage, gameId: 'fluffy', limit: 4 });
    const names = ['Маша', 'Петя', 'Аня', 'Гость'];
    const profiles = [];
    for (const name of names)
      profiles.push(await registry.create({ name, settings: { avatar: { species: name } } }));
    expect(profiles.map((p) => p.id)).toEqual(['profile-1', 'profile-2', 'profile-3', 'profile-4']);
    await expect(registry.create({ name: 'Пятый' })).rejects.toMatchObject({ code: 'limit' });
    await registry.setDevice({ volume: 0.5 });

    const saves = [];
    for (const [index, profile] of profiles.entries()) {
      const key = registry.saveKeyFor(profile.id);
      const saveService = await service(storage, key);
      await saveService.save(draft(key.profileId, index + 1));
      saves.push(saveService);
    }
    const exported = exportSave(
      (await saves[1]!.load())!,
      policyFor(registry.saveKeyFor(profiles[1]!.id).profileId),
    );

    // Restore Petya's backup into Anya's slot, through an explicit, validated rebind.
    const anya = registry.saveKeyFor(profiles[2]!.id);
    const rebound = rebindSave(
      exported,
      { profileId: anya.profileId, expectSource: 'profile-2' },
      policyFor(anya.profileId),
    );
    expect(rebound.profileId).toBe('profile-3');
    expect(rebound.state).toEqual({ solved: 2 });
    await saves[2]!.load();
    expect(await saves[2]!.save(withoutRevision(rebound as SaveEnvelope<State, string>))).toBe(2);

    // Reset one profile: its saves are tombstoned and it leaves the registry.
    await expect(registry.remove('profile-4', { confirm: 'profile-1' })).rejects.toMatchObject({
      code: 'confirmation',
    });
    await registry.remove('profile-4', { confirm: 'profile-4' });
    await registry.rename('profile-1', '  Мария ');

    const after = await registry.list();
    expect(after.profiles.map((p) => [p.id, p.name])).toEqual([
      ['profile-1', 'Мария'],
      ['profile-2', 'Петя'],
      ['profile-3', 'Аня'],
    ]);
    const states = [];
    for (const id of ['profile-1', 'profile-2', 'profile-3', 'profile-4'])
      states.push((await (await service(storage, registry.saveKeyFor(id))).load())?.state ?? null);
    expect(states).toEqual([{ solved: 1 }, { solved: 2 }, { solved: 2 }, null]);
    expect((await registry.get('profile-2'))!.settings).toEqual({ avatar: { species: 'Петя' } });
    expect(await registry.device()).toMatchObject({ settings: { volume: 0.5 } });

    // IDs are never reused, so a new profile cannot inherit the removed profile's tombstone.
    expect((await registry.create({ name: 'Новый' })).id).toBe('profile-5');
    // The importer still refuses a backup that names a different source than expected.
    expect(() =>
      rebindSave(
        exported,
        { profileId: anya.profileId, expectSource: 'profile-1' },
        policyFor(anya.profileId),
      ),
    ).toThrow(/different profile/);
  });

  it('keeps cross-tab compare-and-swap conflicts per profile', async () => {
    const storage = new MemorySaveStorage();
    const registry = createProfileRegistry({ storage, gameId: 'fluffy', limit: 4 });
    const a = await registry.create({ name: 'A' });
    const b = await registry.create({ name: 'B' });
    const tab1 = await service(storage, registry.saveKeyFor(a.id));
    const tab2 = await service(storage, registry.saveKeyFor(a.id));
    const other = await service(storage, registry.saveKeyFor(b.id));
    await tab1.save(draft('profile-1', 1));
    await expect(tab2.save(draft('profile-1', 9))).rejects.toMatchObject({ code: 'conflict' });
    expect(await other.save(draft('profile-2', 1))).toBe(1);
    expect(tab2.status().status).toBe('conflict');
  });

  it('retries registry writes after a concurrent registry change, against fresh state', async () => {
    const backing = new MemorySaveStorage();
    let interfere = true;
    const racing: SaveStorage = {
      read: (key) => backing.read(key),
      reset: (key, expected, confirmation) => backing.reset(key, expected, confirmation),
      async compareAndSwap(key: SaveKey, expected: number, next: StoredSave) {
        if (interfere && key.profileId === PROFILE_REGISTRY_KEY) {
          interfere = false;
          await createProfileRegistry({ storage: backing, gameId: 'fluffy', limit: 2 }).create({
            name: 'Другая вкладка',
          });
        }
        return backing.compareAndSwap(key, expected, next);
      },
    };
    const registry = createProfileRegistry({ storage: racing, gameId: 'fluffy', limit: 2 });
    const created = await registry.create({ name: 'Эта вкладка' });
    expect(created.id).toBe('profile-2');
    expect((await registry.list()).profiles.map((p) => p.name)).toEqual([
      'Другая вкладка',
      'Эта вкладка',
    ]);
  });

  it('supports named slots for every profile and resets all of them on removal', async () => {
    const storage = new MemorySaveStorage();
    const registry = createProfileRegistry({
      storage,
      gameId: 'fluffy',
      limit: 3,
      slots: ['slot1', 'slot2', 'slot3'],
    });
    const p = await registry.create({ name: 'Ведьма' });
    expect(registry.saveKeyFor(p.id, 'slot2')).toEqual({
      gameId: 'fluffy',
      profileId: 'profile-1:slot2',
    });
    expect(() => registry.saveKeyFor(p.id, 'slot9')).toThrow(/slot/);
    for (const slot of registry.slots) {
      const key = registry.saveKeyFor(p.id, slot);
      await (await service(storage, key)).save(draft(key.profileId, 1));
    }
    await registry.remove(p.id, { confirm: p.id });
    for (const slot of registry.slots)
      expect(
        await (await service(storage, registry.saveKeyFor(p.id, slot))).load(),
      ).toBeUndefined();
  });

  it('validates names, settings, reserved IDs and corrupt registries', async () => {
    const storage = new MemorySaveStorage();
    const registry = createProfileRegistry({
      storage,
      gameId: 'fluffy',
      limit: 4,
      validateSettings: (value) =>
        value === null || (typeof value === 'object' && !Array.isArray(value)),
    });
    for (const name of ['', '   ', 'x'.repeat(65), 'a\u0007b'])
      await expect(registry.create({ name })).rejects.toMatchObject({ code: 'invalid-data' });
    await expect(registry.create({ name: 'ok', settings: [1] })).rejects.toMatchObject({
      code: 'invalid-data',
    });
    await expect(
      registry.create({ name: 'ok', settings: { big: 'x'.repeat(70_000) } }),
    ).rejects.toMatchObject({
      code: 'limit',
    });
    for (const id of [PROFILE_REGISTRY_KEY, DEVICE_SETTINGS_KEY, 'a:b'])
      await expect(registry.create({ name: 'ok', id })).rejects.toMatchObject({
        code: 'invalid-data',
      });
    await expect(registry.rename('profile-404', 'x')).rejects.toMatchObject({
      code: 'invalid-data',
    });
    await storage.compareAndSwap({ gameId: 'fluffy', profileId: PROFILE_REGISTRY_KEY }, 0, {
      revision: 1,
      payload: '{"format":"aegis-profiles/1","next":1,"profiles":[{"id":"x"}]}',
    });
    await expect(registry.list()).rejects.toMatchObject({ code: 'invalid-data' });
    expect(() => createProfileRegistry({ storage, gameId: 'fluffy', limit: 65 })).toThrow();
    expect(() =>
      createProfileRegistry({ storage, gameId: 'fluffy', limit: 1, slots: ['a', 'a'] }),
    ).toThrow();
  });

  it('rebind refuses a corrupt or foreign envelope and leaves the source untouched', () => {
    const source = { ...draft('profile-1', 3), revision: 7 };
    const before = JSON.stringify(source);
    const rebound = rebindSave(source, { profileId: 'profile-2' }, policyFor('profile-2'));
    expect(rebound).toMatchObject({ profileId: 'profile-2', revision: 7, state: { solved: 3 } });
    expect(JSON.stringify(source)).toBe(before);
    expect(importSave(JSON.stringify(rebound), policyFor('profile-2')).profileId).toBe('profile-2');
    expect(() =>
      rebindSave(
        { ...source, gameId: 'other' },
        { profileId: 'profile-2' },
        policyFor('profile-2'),
      ),
    ).toThrow();
    expect(() =>
      rebindSave(
        { ...source, state: { solved: 'x' } },
        { profileId: 'profile-2' },
        policyFor('profile-2'),
      ),
    ).toThrow();
    expect(() => rebindSave(source, { profileId: 'profile-3' }, policyFor('profile-2'))).toThrow(
      /target/,
    );
    // An older schema version is accepted; migration happens at load as usual.
    expect(
      rebindSave(
        { ...source, schemaVersion: 1, state: 4 },
        { profileId: 'profile-2' },
        policyFor('profile-2'),
      ).schemaVersion,
    ).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { BrowserServiceError } from '../errors.js';
import { exportSave, importSave, migrateSave } from './codec.js';
import type { SaveEnvelope, SavePolicy } from './codec.js';
import { MemorySaveStorage } from './storage.js';
import type { SaveStorage } from './storage.js';
import { SaveService } from './service.js';
import { IndexedDbSaveStorage } from './indexeddb.js';

interface State {
  turn: number;
  progress: string;
}
const isState = (value: unknown): value is State =>
  typeof value === 'object' &&
  value !== null &&
  'turn' in value &&
  Number.isSafeInteger(value.turn) &&
  'progress' in value &&
  typeof value.progress === 'string';
const isResume = (value: unknown): value is string => value === 'shelf' || value === 'dialogue';
const policy: SavePolicy<State, string> = {
  gameId: 'lab',
  profileId: 'family',
  schemaVersion: 2,
  engineId: 'aegis',
  engineSnapshotVersion: 1,
  acceptsContent: (revision) => revision === 'r1',
  validateState: (value, version) => (version === 1 ? typeof value === 'number' : isState(value)),
  isCurrentState: isState,
  validateResume: isResume,
};
const envelope = (turn = 1): SaveEnvelope<State, string> => ({
  format: 'aegis.save',
  formatVersion: 1,
  gameId: 'lab',
  profileId: 'family',
  contentRevision: 'r1',
  schemaVersion: 2,
  engine: { id: 'aegis', snapshotVersion: 1, revision: 'test' },
  revision: 1,
  state: { turn, progress: 'partly-placed' },
  resume: 'shelf',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('bounded save envelopes and migration', () => {
  it('round-trips current progress and rejects future, cross-game and content mismatches', () => {
    expect(importSave(exportSave(envelope(), policy), policy)).toEqual(envelope());
    for (const patch of [
      { formatVersion: 2 },
      { gameId: 'other' },
      { contentRevision: 'r2' },
      { schemaVersion: 3 },
    ])
      expect(() => importSave(JSON.stringify({ ...envelope(), ...patch }), policy)).toThrow(
        BrowserServiceError,
      );
    expect(() => importSave('{"__proto__":{}}', policy)).toThrow(/unsafe property/);
    expect(() => importSave('x'.repeat(100), { ...policy, maxBytes: 20 })).toThrow(/byte limit/);
    expect(() =>
      exportSave({ ...envelope(), state: { turn: NaN, progress: 'bad' } }, policy),
    ).toThrow(/finite JSON/);
    expect(() => importSave(JSON.stringify({ ...envelope(), resume: 'unknown' }), policy)).toThrow(
      /resume/,
    );
  });
  it('validates every sequential migration and leaves the original untouched on failure', () => {
    const original = JSON.stringify({ ...envelope(), schemaVersion: 1, state: 4 });
    const result = migrateSave(original, policy, [
      { from: 1, to: 2, migrate: (value) => ({ turn: value, progress: 'migrated' }) },
    ]);
    expect(result.state).toEqual({ turn: 4, progress: 'migrated' });
    expect(() =>
      migrateSave(original, policy, [{ from: 1, to: 2, migrate: () => ({ wrong: true }) }]),
    ).toThrow(/consumer validation/);
    expect(JSON.parse(original).state).toBe(4);
    expect(() => migrateSave(original, policy, [])).toThrow(/migration is missing/);
    expect(() =>
      migrateSave(original, policy, [{ from: 1, to: 3, migrate: (value) => value }]),
    ).toThrow(/sequential/);
  });
  it('migrates resume/content references only through explicitly accepted versioned transitions', () => {
    const original = JSON.stringify({
      ...envelope(),
      schemaVersion: 1,
      contentRevision: 'old',
      state: 3,
      resume: 'old-board',
    });
    const compatible = {
      ...policy,
      acceptsContent: (revision: string, version: number) =>
        version === 1 ? revision === 'old' : revision === 'r1',
      validateResume: (value: unknown, version: number): value is string =>
        version === 1 ? value === 'old-board' : isResume(value),
    };
    const result = migrateSave(original, compatible, [
      {
        from: 1,
        to: 2,
        migrateEnvelope: (data) => ({
          ...data,
          contentRevision: 'r1',
          resume: 'shelf',
          state: { turn: data.state, progress: 'converted' },
        }),
      },
    ]);
    expect(result).toMatchObject({
      contentRevision: 'r1',
      resume: 'shelf',
      state: { turn: 3, progress: 'converted' },
    });
    expect(() =>
      migrateSave(original, compatible, [
        {
          from: 1,
          to: 2,
          migrateEnvelope: (data) => ({ ...data, contentRevision: 'unexpected' }),
        },
      ]),
    ).toThrow(/incompatible/);
    expect(JSON.parse(original)).toMatchObject({
      contentRevision: 'old',
      resume: 'old-board',
      state: 3,
    });
  });
});

describe('strict ordered persistence', () => {
  it('acknowledges every exact intermediate revision, snapshots queued inputs and keeps recovery', async () => {
    const backing = new MemorySaveStorage();
    const gate = deferred<void>();
    const writes: number[] = [];
    const store: SaveStorage = {
      read: (key) => backing.read(key),
      reset: (key, expected, confirmation) => backing.reset(key, expected, confirmation),
      async compareAndSwap(key, expected, next) {
        if (!expected) await gate.promise;
        writes.push(JSON.parse(next.payload).state.turn);
        await backing.compareAndSwap(key, expected, next);
      },
    };
    const service = new SaveService(store, policy);
    await service.load();
    const first = service.save(envelope(1));
    const draft = envelope(2);
    const second = service.save(draft);
    draft.state.turn = 99;
    expect(service.status()).toMatchObject({ status: 'pending', persistedRevision: 0, pending: 2 });
    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(writes).toEqual([1, 2]);
    expect(await service.flush()).toBe(2);
    expect((await service.recovery())?.state.turn).toBe(1);
    expect((await service.load())?.state.turn).toBe(2);
  });
  it('blocks queued progress after a failed strict write and explicitly retries only that checkpoint', async () => {
    const backing = new MemorySaveStorage();
    let broken = true;
    const store: SaveStorage = {
      read: (key) => backing.read(key),
      reset: (key, expected, confirmation) => backing.reset(key, expected, confirmation),
      async compareAndSwap(key, expected, next) {
        if (broken) throw new DOMException('disk full', 'QuotaExceededError');
        return backing.compareAndSwap(key, expected, next);
      },
    };
    const service = new SaveService(store, policy);
    await service.load();
    const results = await Promise.allSettled([
      service.save(envelope(1)),
      service.save(envelope(2)),
    ]);
    expect(results.map((value) => value.status)).toEqual(['rejected', 'rejected']);
    expect(service.status()).toMatchObject({ status: 'failed', persistedRevision: 0, pending: 0 });
    expect(await backing.read(policy)).toEqual({});
    await expect(service.flush()).rejects.toThrow();
    broken = false;
    expect(await service.retry()).toBe(1);
    expect((await service.load())?.state.turn).toBe(1);
  });
  it('detects conflicting clients, never clobbers the winner and confines confirmed reset', async () => {
    const store = new MemorySaveStorage();
    const first = new SaveService(store, policy);
    const second = new SaveService(store, policy);
    await Promise.all([first.load(), second.load()]);
    await first.save(envelope(4));
    await expect(second.save(envelope(5))).rejects.toMatchObject({ code: 'conflict' });
    expect(second.status().status).toBe('conflict');
    await expect(second.retry()).rejects.toThrow(/conflicts/);
    await expect(first.reset({ ...policy, profileId: 'someone-else' })).rejects.toMatchObject({
      code: 'confirmation',
    });
    const other = new SaveService(store, { ...policy, profileId: 'other' });
    await other.load();
    await other.save({ ...envelope(), profileId: 'other' });
    await first.load();
    await first.reset(policy);
    expect((await store.read(policy)).current).toBeUndefined();
    expect((await store.read({ ...policy, profileId: 'other' })).current?.revision).toBe(1);
  });
  it('refuses corrupted progress without replacing it and reports unavailable IndexedDB', async () => {
    const store = new MemorySaveStorage();
    await store.compareAndSwap(policy, 0, { revision: 1, payload: 'broken' });
    const service = new SaveService(store, policy);
    await expect(service.load()).rejects.toThrow();
    await expect(service.save(envelope())).rejects.toMatchObject({ code: 'invalid-data' });
    expect((await store.read(policy)).current?.payload).toBe('broken');
    await service.reset(policy);
    expect((await store.read(policy)).current).toBeUndefined();
    const unavailable = new SaveService(new IndexedDbSaveStorage('absent', undefined), policy);
    await expect(unavailable.load()).rejects.toMatchObject({ code: 'unavailable' });
    expect(unavailable.status().status).toBe('unavailable');
  });
  it('keeps reset revisions monotonic so stale tabs cannot overwrite a restarted profile', async () => {
    const store = new MemorySaveStorage();
    const first = new SaveService(store, policy);
    const stale = new SaveService(store, policy);
    await first.load();
    await first.save(envelope(1));
    await stale.load();
    await first.reset(policy);
    expect(await first.save(envelope(0))).toBe(3);
    await expect(stale.save(envelope(9))).rejects.toMatchObject({ code: 'conflict' });
    expect((await first.load())?.state.turn).toBe(0);
  });
  it('blocks racing saves while a profile load is unresolved', async () => {
    const memory = new MemorySaveStorage();
    const read = deferred<void>();
    const service = new SaveService(
      {
        read: async (key) => {
          await read.promise;
          return memory.read(key);
        },
        compareAndSwap: (key, expected, next) => memory.compareAndSwap(key, expected, next),
        reset: (key, expected, confirmation) => memory.reset(key, expected, confirmation),
      },
      policy,
    );
    const loading = service.load();
    await expect(service.save(envelope())).rejects.toMatchObject({ code: 'blocked' });
    await expect(service.flush()).rejects.toMatchObject({ code: 'blocked' });
    read.resolve();
    await loading;
    expect(await service.save(envelope())).toBe(1);
  });
});

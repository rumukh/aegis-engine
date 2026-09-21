import { describe, expect, it } from 'vitest';
import {
  createRuntimeHost,
  isRuntimeSnapshot,
  requireValue,
  schema,
  success,
} from '@aegis/runtime';
import type { Checkpoint, ContentPack, RuntimeAdapter, RuntimeSnapshot } from '@aegis/runtime';
import { MemorySaveStorage } from './storage.js';
import type { SaveStorage } from './storage.js';
import { SaveService } from './service.js';
import type { SavePolicy } from './codec.js';
import { createSaveCheckpoint } from './checkpoint.js';

interface State {
  steps: number;
  charges: number;
}
type Action = 'free' | 'two';
interface Config {
  cost: number;
}
const number = schema.number({ integer: true, min: 0, max: 100 });
const adapter: RuntimeAdapter<State, Action, State, Config> = {
  id: 'save-fixture',
  stateVersion: 1,
  state: schema.object({ steps: number, charges: number }),
  action: schema.union(schema.literal('free'), schema.literal('two')),
  content: { schemaVersion: 1, schema: schema.object({ cost: number }) },
  eventPhases: ['ready'],
  initialize: () => ({ steps: 0, charges: 0 }),
  resolve: (action, context) =>
    success({
      rule: 'step',
      payload: null,
      turns: action === 'free' ? 0 : context.content.data.cost,
    }),
  commands: [
    {
      id: 'step',
      payload: schema.literal(null),
      progress: schema.literal(null),
      start: (context) => {
        context.state.charges++;
      },
      turn: (context) => {
        context.state.steps++;
      },
    },
  ],
  view: (context) => ({ ...context.state }),
};
const content: ContentPack<Config> = {
  id: 'save-fixture',
  revision: 'r1',
  schemaVersion: 1,
  data: { cost: 2 },
};
const policy: SavePolicy<RuntimeSnapshot, string> = {
  gameId: 'fixture',
  profileId: 'p1',
  schemaVersion: 1,
  engineId: 'aegis-runtime',
  engineSnapshotVersion: 1,
  acceptsContent: (revision) => revision === 'r1',
  validateState: (value) =>
    isRuntimeSnapshot(value) && value.adapter === 'save-fixture' && value.content.revision === 'r1',
  isCurrentState: isRuntimeSnapshot,
  validateResume: (value): value is string => value === 'board',
};
const metadata = () => ({
  format: 'aegis.save' as const,
  formatVersion: 1 as const,
  gameId: 'fixture',
  profileId: 'p1',
  contentRevision: 'r1',
  schemaVersion: 1,
  engine: { id: 'aegis-runtime', snapshotVersion: 1, revision: 'test' },
  resume: 'board',
});

describe('public runtime strict durability bridge', () => {
  it('never acknowledges a checkpoint by retrying a foreign failed SaveService draft', async () => {
    const memory = new MemorySaveStorage();
    let broken = true;
    const service = new SaveService<RuntimeSnapshot, string>(
      {
        read: (key) => memory.read(key),
        reset: (key, revision, confirmation) => memory.reset(key, revision, confirmation),
        compareAndSwap: async (key, expected, next) => {
          if (broken) throw new DOMException('quota', 'QuotaExceededError');
          await memory.compareAndSwap(key, expected, next);
        },
      },
      policy,
    );
    await service.load();
    const host = createRuntimeHost({ adapter, content, seed: 'bridge' });
    const foreign = host.snapshot();
    await expect(service.save({ ...metadata(), state: foreign })).rejects.toThrow();
    requireValue(await host.dispatch('free'));
    const wanted: Checkpoint = {
      revision: 1,
      hash: host.hash(),
      snapshot: host.snapshot(),
      kind: 'action',
    };
    const writer = createSaveCheckpoint(service, metadata);
    expect((await writer(wanted)).ok).toBe(false);
    broken = false;
    expect((await writer(wanted)).ok).toBe(false);
    expect((await memory.read(policy)).current).toBeUndefined();
    await service.retry();
    expect((await service.load())?.state).toEqual(foreign);
    expect((await writer(wanted)).ok).toBe(true);
    expect((await service.load())?.state).toEqual(wanted.snapshot);
    await host.dispose();
  });
  it('does not acquire retry ownership merely by queueing behind a different failing write', async () => {
    const memory = new MemorySaveStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new SaveService<RuntimeSnapshot, string>(
      {
        read: (key) => memory.read(key),
        reset: (key, revision, confirmation) => memory.reset(key, revision, confirmation),
        compareAndSwap: async () => {
          await gate;
          throw new DOMException('quota', 'QuotaExceededError');
        },
      },
      policy,
    );
    await service.load();
    const host = createRuntimeHost({ adapter, content, seed: 'bridge' });
    const owner = Symbol('direct-write');
    const direct = service
      .save({ ...metadata(), state: host.snapshot() }, owner)
      .catch((error: unknown) => error);
    requireValue(await host.dispatch('free'));
    const wanted: Checkpoint = {
      revision: 1,
      hash: host.hash(),
      snapshot: host.snapshot(),
      kind: 'action',
    };
    const writer = createSaveCheckpoint(service, metadata);
    const queued = writer(wanted);
    await Promise.resolve();
    release();
    await direct;
    expect((await queued).ok).toBe(false);
    expect(service.ownsFailedWrite(owner)).toBe(true);
    await expect(service.retry(Symbol('foreign-retry'))).rejects.toMatchObject({ code: 'blocked' });
    expect((await writer(wanted)).ok).toBe(false);
    expect((await memory.read(policy)).current).toBeUndefined();
    await host.dispose();
  });

  it('blocks a real multi-turn action on storage failure, retries exactly once and restores its intermediate save', async () => {
    const memory = new MemorySaveStorage();
    let broken = true;
    const written: number[] = [];
    const storage: SaveStorage = {
      read: (key) => memory.read(key),
      reset: (key, revision, confirmation) => memory.reset(key, revision, confirmation),
      async compareAndSwap(key, expected, next) {
        if (broken) throw new DOMException('quota', 'QuotaExceededError');
        await memory.compareAndSwap(key, expected, next);
        written.push(JSON.parse(next.payload).state.turn);
      },
    };
    const saves = new SaveService(storage, policy);
    await saves.load();
    const checkpoint = createSaveCheckpoint(saves, metadata);
    const host = createRuntimeHost({ adapter, content, seed: 'bridge', checkpoint });
    expect(await host.dispatch('two')).toMatchObject({ ok: false, error: { code: 'storage' } });
    expect(host.getStatus()).toMatchObject({ turn: 1, checkpoint: 'failed' });
    expect(host.getView()).toEqual({ steps: 1, charges: 1 });
    expect((await host.dispatch('free')).ok).toBe(false);
    expect(written).toEqual([]);
    broken = false;
    requireValue(await host.retryCheckpoint());
    expect(written).toEqual([1]);
    requireValue(await host.continuePending());
    expect(written).toEqual([1, 2]);
    expect(host.getView()).toEqual({ steps: 2, charges: 1 });
    const recovery = (await saves.recovery())!;
    expect(recovery.state.pending?.completedTurns).toBe(1);
    const resumed = createRuntimeHost({ adapter, content, seed: 'bridge', checkpoint });
    requireValue(
      await resumed.restore(recovery.state, { durableRevision: recovery.state.revision }),
    );
    requireValue(await resumed.continuePending());
    expect(resumed.getView()).toEqual({ steps: 2, charges: 1 });
    expect(written).toEqual([1, 2]);
    await host.dispose();
    await resumed.dispose();
  });

  it('deduplicates active/saved identities but invalidates cached acknowledgements on explicit profile reload', async () => {
    const service = new SaveService(new MemorySaveStorage(), policy);
    await service.load();
    const host = createRuntimeHost({ adapter, content, seed: 'bridge' });
    requireValue(await host.dispatch('free'));
    const value: Checkpoint = {
      revision: 1,
      snapshot: host.snapshot(),
      hash: host.hash(),
      kind: 'action',
    };
    const write = createSaveCheckpoint(service, metadata);
    const [a, b] = await Promise.all([write(value), write(value)]);
    expect(a.ok && b.ok).toBe(true);
    expect(await service.flush()).toBe(1);
    expect((await write({ ...value, hash: 'different' })).ok).toBe(false);
    await service.load();
    expect((await write(value)).ok).toBe(true);
    expect(await service.flush()).toBe(2);
    await host.dispose();
  });
  it('refuses falsely relabeling a checkpoint with a new content revision and permits explicit corrected retry', async () => {
    const service = new SaveService(new MemorySaveStorage(), policy);
    await service.load();
    const host = createRuntimeHost({ adapter, content, seed: 'bridge' });
    requireValue(await host.dispatch('free'));
    let revision = 'wrong-content';
    const writer = createSaveCheckpoint(service, () => ({
      ...metadata(),
      contentRevision: revision,
    }));
    const checkpoint: Checkpoint = {
      revision: 1,
      hash: host.hash(),
      snapshot: host.snapshot(),
      kind: 'action',
    };
    expect(await writer(checkpoint)).toMatchObject({ ok: false, error: { code: 'incompatible' } });
    expect(await service.flush()).toBe(0);
    revision = 'r1';
    expect((await writer(checkpoint)).ok).toBe(true);
    expect(await service.flush()).toBe(1);
    await host.dispose();
  });
});

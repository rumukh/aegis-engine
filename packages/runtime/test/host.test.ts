import { describe, expect, it } from 'vitest';
import {
  createRuntimeHost,
  failure,
  requireValue,
  runCommandTrace,
  schema,
  success,
} from '../src/index.js';
import type { Checkpoint, Outcome, RuntimeSnapshot } from '../src/index.js';
import { config, fixture, fixtureAdapter } from './fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('action runtime: HOST, TURN and runtime SAVE-05', () => {
  it('A03/K01/K02: only accepted commands change revision/time, and cost zero publishes immediately', async () => {
    const host = fixture();
    const seen: number[] = [];
    host.subscribe((view) => seen.push(view.count));
    const initial = host.hash();
    for (let frame = 0; frame < 10_000; frame++) host.getView();
    host.pause('visibility');
    host.resume('visibility');
    expect(host.hash()).toBe(initial);
    const free = host.dispatch({ type: 'free' });
    expect(host.getView()).toEqual({ count: 1, turn: 0, revision: 1, log: [] });
    expect(seen).toEqual([1]);
    requireValue(await free);
    requireValue(await host.dispatch({ type: 'wait' }));
    requireValue(await host.dispatch({ type: 'two' }));
    expect(host.getStatus()).toMatchObject({
      revision: 4,
      turn: 3,
      pendingAction: null,
      durableRevision: null,
    });
    expect(host.inspect().state).toMatchObject({
      count: 1,
      charged: 3,
      log: ['turn:1', 'turn:2', 'turn:3'],
    });
    expect((await host.flush()).ok).toBe(false);
  });

  it('A04: repeats independent seeded outcomes and pins a literal final hash', async () => {
    const a = fixture();
    const b = fixture();
    for (const host of [a, b]) {
      requireValue(await host.dispatch({ type: 'begin' }));
      requireValue(await host.dispatch({ type: 'two' }));
      requireValue(await host.dispatch({ type: 'claim' }));
    }
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.inspect().state.log).toEqual([
      'turn:1',
      'turn:2',
      'job-a',
      'job-b',
      'arrival',
      'expiration',
    ]);
    expect(a.inspect().state).toMatchObject({ reward: 1, charged: 3 });
    // Captured from this named, independently asserted fixture; changes require an explained repin.
    expect(a.hash()).toBe('41af0570df25d87d');
  });

  it('A05: JSON snapshot round trip preserves named PRNG streams and future continuation', async () => {
    const live = fixture();
    requireValue(await live.dispatch({ type: 'begin' }));
    requireValue(await live.dispatch({ type: 'wait' }));
    const copy = fixture();
    const beforeRestoreEvents: string[] = [];
    copy.subscribeCommits((commit) =>
      beforeRestoreEvents.push(...commit.events.map((event) => event.type)),
    );
    requireValue(await copy.restore(JSON.parse(JSON.stringify(live.snapshot()))));
    expect(beforeRestoreEvents).toEqual([]);
    for (const host of [live, copy]) {
      requireValue(await host.dispatch({ type: 'wait' }));
      requireValue(await host.dispatch({ type: 'claim' }));
      requireValue(await host.dispatch({ type: 'free' }));
    }
    expect(copy.snapshot()).toEqual(live.snapshot());
    expect(copy.inspect().state.reward).toBe(1);
  });

  it('A06: invalid, stale and duplicate commands cannot charge, emit, grant or consume randomness', async () => {
    const host = fixture();
    const before = host.snapshot();
    expect(await host.dispatch({ type: 'invalid' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-action' },
      progress: { accepted: false, committedRevision: null, durableRevision: null },
    });
    expect(await host.dispatch({ type: 'explode' })).toMatchObject({
      ok: false,
      error: { code: 'transition-failed' },
    });
    expect(await host.dispatch({ type: 'free' }, { expectedRevision: 17 })).toMatchObject({
      ok: false,
      error: { code: 'stale-action' },
    });
    expect(host.snapshot()).toEqual(before);
    requireValue(await host.dispatch({ type: 'claim' }));
    const claimed = host.snapshot();
    expect(await host.dispatch({ type: 'claim' })).toMatchObject({
      ok: false,
      error: { code: 'duplicate-claim' },
    });
    expect(host.snapshot()).toEqual(claimed);
    const control = fixture();
    requireValue(await control.dispatch({ type: 'claim' }));
    expect(host.snapshot()).toEqual(control.snapshot());
  });

  it('A07: pause reasons compose, reject input, and never queue work', async () => {
    const host = fixture();
    for (const reason of ['user', 'visibility', 'handoff']) host.pause(reason);
    host.resume('visibility');
    expect(host.getStatus().pauseReasons).toEqual(['handoff', 'user']);
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    });
    host.resume('handoff');
    expect(await host.dispatch({ type: 'wait' })).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    });
    host.resume('user');
    await Promise.resolve();
    expect(host.getStatus()).toMatchObject({ revision: 0, turn: 0 });
    requireValue(await host.dispatch({ type: 'free' }));
    expect(host.getView().count).toBe(1);
  });

  it('K03/K05: every intermediate turn commits and collisions have stable explicit order', async () => {
    const checkpoints: Checkpoint[] = [];
    const host = fixture(async (checkpoint) => {
      checkpoints.push(checkpoint);
      return success(undefined);
    });
    requireValue(await host.dispatch({ type: 'begin' }));
    requireValue(await host.dispatch({ type: 'two' }));
    expect(checkpoints.map((entry) => [entry.revision, entry.snapshot.turn])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(checkpoints[1]?.snapshot.pending).toMatchObject({
      rule: 'command',
      turns: 2,
      completedTurns: 1,
      id: 2,
      payload: { action: { type: 'two' } },
      progress: null,
    });
    expect(checkpoints[2]?.snapshot.pending).toBeNull();
    expect(host.inspect().state.log).toEqual([
      'turn:1',
      'turn:2',
      'job-a',
      'job-b',
      'arrival',
      'expiration',
    ]);
    expect(host.snapshot().consumedJobs.map((job) => job.id)).toEqual([
      'job-a',
      'job-b',
      'arrival',
      'expiration',
    ]);
  });

  it('K04: restore an intermediate acknowledged checkpoint without resolving/charging again', async () => {
    let intermediate: RuntimeSnapshot | undefined;
    const live = fixture(async (checkpoint) => {
      if (checkpoint.snapshot.turn === 1) intermediate = checkpoint.snapshot;
      return success(undefined);
    });
    requireValue(await live.dispatch({ type: 'begin' }));
    requireValue(await live.dispatch({ type: 'two' }));
    expect(intermediate).toBeDefined();
    const resumed = fixture(async () => success(undefined));
    requireValue(await resumed.restore(intermediate, { durableRevision: intermediate?.revision }));
    expect(await resumed.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'action-pending' },
    });
    requireValue(await resumed.continuePending());
    expect(resumed.snapshot()).toEqual(live.snapshot());
    expect(resumed.inspect().state.charged).toBe(3);
  });

  it('K09: strict durability blocks the next turn, publishes before IO, and rejects concurrent input', async () => {
    const pendingWrite = deferred<Outcome<void>>();
    const writes: number[] = [];
    const host = fixture(async (checkpoint) => {
      writes.push(checkpoint.revision);
      return checkpoint.revision === 1 ? pendingWrite.promise : success(undefined);
    });
    const dispatched = host.dispatch({ type: 'two' });
    expect(host.getStatus()).toMatchObject({
      revision: 1,
      turn: 1,
      checkpoint: 'pending',
      checkpointRevision: 1,
      durableRevision: null,
    });
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    expect(writes).toEqual([1]);
    const flushing = host.flush(1);
    pendingWrite.resolve(success(undefined));
    requireValue(await flushing);
    requireValue(await dispatched);
    expect(writes).toEqual([1, 2]);
    expect(host.getStatus()).toMatchObject({ revision: 2, turn: 2, durableRevision: 2 });
  });

  it('K09: failure/retry resubmits exactly one checkpoint, never repeats effects or skips a turn', async () => {
    let fail = true;
    const writes: Checkpoint[] = [];
    const host = fixture(async (checkpoint) => {
      writes.push(checkpoint);
      return fail ? failure('storage-full', 'Fixture storage is full.') : success(undefined);
    });
    const commits: number[] = [];
    host.subscribeCommits((commit) => commits.push(commit.revision));
    expect(await host.dispatch({ type: 'two' })).toMatchObject({
      ok: false,
      error: { code: 'storage-full' },
      progress: { accepted: true, committedRevision: 1, durableRevision: null, pendingAction: 1 },
    });
    expect(host.getStatus()).toMatchObject({
      checkpoint: 'failed',
      revision: 1,
      turn: 1,
      pendingAction: 1,
    });
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'checkpoint-blocked' },
    });
    expect(await host.continuePending()).toMatchObject({
      ok: false,
      error: { code: 'checkpoint-blocked' },
    });
    expect(await host.flush(1)).toMatchObject({ ok: false });
    fail = false;
    requireValue(await host.retryCheckpoint());
    expect(writes[1]).toEqual(writes[0]);
    expect(host.getStatus()).toMatchObject({ revision: 1, turn: 1, durableRevision: 1 });
    requireValue(await host.continuePending());
    expect(writes.map((entry) => entry.revision)).toEqual([1, 1, 2]);
    expect(commits).toEqual([1, 2]);
    expect(host.inspect().state.charged).toBe(3);
  });

  it('pause during a multi-turn write lets that checkpoint finish, then requires explicit continuation', async () => {
    const writing = deferred<Outcome<void>>();
    const host = fixture(async (checkpoint) =>
      checkpoint.revision === 1 ? writing.promise : success(undefined),
    );
    const action = host.dispatch({ type: 'two' });
    host.pause('user');
    writing.resolve(success(undefined));
    expect(requireValue(await action)).toMatchObject({ pending: true, turn: 1, durable: true });
    host.resume('user');
    await Promise.resolve();
    expect(host.getStatus().turn).toBe(1);
    requireValue(await host.continuePending());
    expect(host.getStatus().turn).toBe(2);
  });

  it('K08: distinct zero-turn checkpoints persist placement, hints, purchases, claims and phase changes', async () => {
    const snapshots: RuntimeSnapshot[] = [];
    const host = fixture(async (checkpoint) => {
      snapshots.push(checkpoint.snapshot);
      return success(undefined);
    });
    for (const type of ['free', 'hint', 'purchase', 'claim', 'phase'] as const)
      requireValue(await host.dispatch({ type }));
    expect(snapshots.map((snapshot) => [snapshot.revision, snapshot.turn])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
    ]);
    const restored = fixture();
    requireValue(await restored.restore(snapshots[4]));
    expect(restored.inspect().state).toMatchObject({ count: 1, hints: 1, charged: 3, reward: 1 });
    expect(restored.inspect().phase).toMatchObject({ id: 'second', allowance: 3 });
    expect(await restored.dispatch({ type: 'hint' })).toMatchObject({
      ok: false,
      error: { code: 'exhausted' },
    });
    expect(await restored.dispatch({ type: 'claim' })).toMatchObject({
      ok: false,
      error: { code: 'duplicate-claim' },
    });
  });

  it('K06: allowance changes move only unconsumed end-relative events and never rewind time', async () => {
    const host = fixture();
    requireValue(await host.dispatch({ type: 'begin' }));
    requireValue(await host.dispatch({ type: 'allowance', value: 6 }));
    expect(host.snapshot().jobs.map((job) => [job.id, job.dueTurn])).toEqual([
      ['job-a', 2],
      ['job-b', 2],
      ['arrival', 2],
      ['expiration', 4],
    ]);
    requireValue(await host.dispatch({ type: 'two' }));
    expect(host.inspect().state.log).toEqual(['turn:1', 'turn:2', 'job-a', 'job-b', 'arrival']);
    const before = host.snapshot();
    expect(await host.dispatch({ type: 'allowance', value: 3 })).toMatchObject({
      ok: false,
      error: { code: 'past-job' },
    });
    expect(host.snapshot()).toEqual(before);
    requireValue(await host.dispatch({ type: 'two' }));
    requireValue(await host.dispatch({ type: 'allowance', value: 10 }));
    requireValue(await host.dispatch({ type: 'two' }));
    expect(host.inspect().state.log.filter((event) => event === 'expiration')).toHaveLength(1);
    expect(host.snapshot().turn).toBe(6);
  });

  it('cancels/replaces by generation ticket and rejects stale completions after restore', async () => {
    const host = fixture();
    requireValue(await host.dispatch({ type: 'begin' }));
    const oldTicket = host.inspect().state.ticket;
    requireValue(await host.dispatch({ type: 'replace' }));
    expect(host.inspect().state.ticket).not.toEqual(oldTicket);
    requireValue(await host.dispatch({ type: 'wait' }));
    expect(host.inspect().state.log).toEqual(['turn:1', 'replacement']);
    const saved = host.snapshot();
    requireValue(await host.restore(saved));
    expect(await host.dispatch({ type: 'cancel' })).toMatchObject({
      ok: false,
      error: { code: 'stale-job' },
    });
    expect(host.snapshot()).toEqual(saved);
    const cancel = fixture();
    requireValue(await cancel.dispatch({ type: 'begin' }));
    requireValue(await cancel.dispatch({ type: 'cancel' }));
    requireValue(await cancel.dispatch({ type: 'two' }));
    expect(cancel.inspect().state.log).not.toContain('job-a');
  });

  it('bounds automatic same-turn chains and refuses backwards event ordering atomically', async () => {
    const host = fixture();
    const before = host.snapshot();
    expect(await host.dispatch({ type: 'cycle' })).toMatchObject({
      ok: false,
      error: { code: 'transition-limit' },
    });
    expect(await host.dispatch({ type: 'backward' })).toMatchObject({
      ok: false,
      error: { code: 'event-order' },
    });
    expect(host.snapshot()).toEqual(before);
    expect(host.getStatus().busy).toBe(false);
  });

  it('HOST-04: corrupt snapshots and missing content preserve the usable current state', async () => {
    const host = fixture();
    requireValue(await host.dispatch({ type: 'free' }));
    const before = host.snapshot();
    for (const candidate of [
      { ...before, turn: -1 },
      { ...before, adapter: 'other' },
      { ...before, streams: {} },
      { ...before, content: { ...before.content, revision: 'missing' } },
      {
        ...before,
        pending: {
          id: 1,
          rule: 'command',
          payload: null,
          turns: 2,
          completedTurns: 0,
          progress: null,
        },
      },
      {
        ...before,
        world: { ...before.world, resources: { 'aegis.runtime.state': { bad: true } } },
      },
    ]) {
      expect((await host.restore(candidate)).ok).toBe(false);
      expect(host.snapshot()).toEqual(before);
    }
    requireValue(await host.dispatch({ type: 'free' }));
    expect(host.getView().count).toBe(2);
  });

  it('restore stages references/content and publishes exactly once without one-shot events', async () => {
    const ready = deferred<Outcome<void>>();
    const host = fixture(undefined, { prepareRestore: () => ready.promise });
    const source = fixture();
    requireValue(await source.dispatch({ type: 'claim' }));
    const views: string[] = [];
    const events: string[] = [];
    host.subscribe((_view, reason) => views.push(reason));
    host.subscribeCommits((commit) => events.push(...commit.events.map((event) => event.type)));
    const restoring = host.restore(source.snapshot(), { pauseReasons: ['handoff', 'user'] });
    expect(host.inspect().state.reward).toBe(0);
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    ready.resolve(success(undefined));
    requireValue(await restoring);
    expect(views).toEqual(['restore']);
    expect(events).toEqual([]);
    expect(host.inspect().state.reward).toBe(1);
    expect(host.getStatus().pauseReasons).toEqual(['handoff', 'user']);
  });

  it.each([
    { initial: [], added: ['user', 'visibility'], removed: [], expected: ['user', 'visibility'] },
    { initial: ['user', 'visibility'], added: [], removed: ['visibility'], expected: ['user'] },
    { initial: ['user', 'visibility'], added: [], removed: ['user', 'visibility'], expected: [] },
  ])(
    'restore preserves live pause changes during preparation: $expected',
    async ({ initial, added, removed, expected }) => {
      const ready = deferred<Outcome<void>>();
      const host = fixture(undefined, { prepareRestore: () => ready.promise });
      for (const reason of initial) host.pause(reason);
      const observed: string[][] = [];
      host.subscribe((_view, reason) => {
        if (reason === 'restore') observed.push([...host.getStatus().pauseReasons]);
      });
      const restoring = host.restore(host.snapshot());
      for (const reason of added) host.pause(reason);
      for (const reason of removed) host.resume(reason);
      ready.resolve(success(undefined));
      requireValue(await restoring);
      expect(host.getStatus().pauseReasons).toEqual(expected);
      expect(observed).toEqual([expected]);
      if (expected.length > 0) {
        expect(await host.dispatch({ type: 'free' })).toMatchObject({
          ok: false,
          error: { code: 'paused' },
        });
        host.resume('visibility');
        expect(host.getStatus().pauseReasons).toEqual(['user']);
        expect(await host.dispatch({ type: 'free' })).toMatchObject({
          ok: false,
          error: { code: 'paused' },
        });
        host.resume('user');
      }
      requireValue(await host.dispatch({ type: 'free' }));
      expect(host.getView().count).toBe(1);
    },
  );

  it('an explicit restore pause override intentionally replaces live reasons at installation', async () => {
    const ready = deferred<Outcome<void>>();
    const host = fixture(undefined, { prepareRestore: () => ready.promise });
    host.pause('visibility');
    const requested = ['handoff'];
    const restoring = host.restore(host.snapshot(), { pauseReasons: requested });
    host.resume('visibility');
    host.pause('user');
    requested.push('parent');
    ready.resolve(success(undefined));
    requireValue(await restoring);
    expect(host.getStatus().pauseReasons).toEqual(['handoff']);
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    });
  });

  it('failed preparation preserves current pauses and does not apply an explicit override', async () => {
    const ready = deferred<Outcome<void>>();
    const host = fixture(undefined, { prepareRestore: () => ready.promise });
    const source = fixture();
    requireValue(await source.dispatch({ type: 'free' }));
    const before = host.snapshot();
    host.pause('visibility');
    host.pause('handoff');
    const restored: string[] = [];
    host.subscribe((_view, reason) => restored.push(reason));
    const restoring = host.restore(source.snapshot(), { pauseReasons: ['parent'] });
    host.resume('visibility');
    host.pause('user');
    ready.resolve(failure('content-unavailable', 'Required content could not be prepared.'));
    expect(await restoring).toMatchObject({
      ok: false,
      error: { code: 'content-unavailable' },
    });
    expect(host.getStatus().pauseReasons).toEqual(['handoff', 'user']);
    expect(host.snapshot()).toEqual(before);
    expect(restored).toEqual([]);
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    });
  });

  it('stale checkpoint acknowledgement cannot modify a restored session', async () => {
    const writing = deferred<Outcome<void>>();
    const host = fixture(() => writing.promise);
    const initial = host.snapshot();
    const dispatched = host.dispatch({ type: 'two' });
    requireValue(await host.restore(initial, { durableRevision: 0 }));
    writing.resolve(success(undefined));
    expect(await dispatched).toMatchObject({ ok: false, error: { code: 'superseded' } });
    expect(host.getStatus()).toMatchObject({
      revision: 0,
      turn: 0,
      durableRevision: 0,
      pendingAction: null,
    });
  });

  it('restore without persistence evidence blocks continuation until its own checkpoint is acknowledged', async () => {
    const live = fixture();
    requireValue(await live.dispatch({ type: 'free' }));
    const saves: Checkpoint[] = [];
    const restored = fixture(async (checkpoint) => {
      saves.push(checkpoint);
      return success(undefined);
    });
    requireValue(await restored.restore(live.snapshot()));
    expect(await restored.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'checkpoint-blocked' },
    });
    requireValue(await restored.retryCheckpoint());
    expect(saves.map((save) => [save.kind, save.revision])).toEqual([['restore', 1]]);
    requireValue(await restored.dispatch({ type: 'free' }));
  });

  it('nested dispatch, listener mutation, unsubscribe and listener failures cannot corrupt commits', async () => {
    const host = fixture();
    const nested: Promise<unknown>[] = [];
    const called: string[] = [];
    let stopSecond = () => {};
    host.subscribe((view) => {
      called.push('first');
      view.count = 400;
      nested.push(host.dispatch({ type: 'free' }));
      stopSecond();
    });
    stopSecond = host.subscribe(() => {
      called.push('second');
    });
    host.subscribeCommits(() => {
      throw new Error('listener fault');
    });
    requireValue(await host.dispatch({ type: 'free' }));
    expect(await Promise.all(nested)).toMatchObject([{ ok: false, error: { code: 'busy' } }]);
    expect(called).toEqual(['first']);
    expect(host.getView().count).toBe(1);
    expect(host.getStatus().error?.code).toBe('listener-failed');
  });

  it('disposal invalidates pending IO and preparation without post-disposal notifications', async () => {
    const writing = deferred<Outcome<void>>();
    const host = fixture(() => writing.promise);
    const action = host.dispatch({ type: 'two' });
    await host.dispose();
    writing.resolve(success(undefined));
    expect(await action).toMatchObject({ ok: false, error: { code: 'superseded' } });
    expect(host.getStatus()).toMatchObject({
      disposed: true,
      revision: 1,
      turn: 1,
      durableRevision: null,
    });
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'disposed' },
    });
    const ready = deferred<Outcome<void>>();
    const restoring = fixture(undefined, { prepareRestore: () => ready.promise });
    const before = restoring.snapshot();
    const restored = restoring.restore(fixture().snapshot());
    await restoring.dispose();
    ready.resolve(success(undefined));
    expect((await restored).ok).toBe(false);
    expect(restoring.snapshot()).toEqual(before);
  });

  it('rejects invalid state, nonsynchronous rules and throwing views before first publication', async () => {
    const adapter = fixtureAdapter();
    const original = adapter.commands[0];
    if (!original) throw new Error('fixture command absent');
    for (const broken of [
      {
        ...adapter,
        commands: [
          {
            ...original,
            start: (ctx: Parameters<NonNullable<typeof original.start>>[0]) => {
              ctx.state.count = -1;
            },
          },
        ],
      },
      { ...adapter, commands: [{ ...original, start: async () => {} }] },
      {
        ...adapter,
        view: (ctx: Parameters<typeof adapter.view>[0]) => {
          if (ctx.revision > 0) throw new Error('projection fault');
          return adapter.view(ctx);
        },
      },
    ]) {
      const host = fixture(undefined, { adapter: broken });
      const before = host.snapshot();
      expect((await host.dispatch({ type: 'free' })).ok).toBe(false);
      expect(host.snapshot()).toEqual(before);
    }
  });

  it('TURN-05: trace failures identify seed, rules, content, command and logical turn', async () => {
    const report = await runCommandTrace(fixture(), [
      { action: { type: 'free' }, ruleIds: ['command'], expectedTurn: 0, expectedRevision: 1 },
      { action: { type: 'wait' }, ruleIds: ['command'], expectedTurn: 8 },
    ]);
    expect(report.passed).toBe(false);
    expect(report.checked).toBe(5);
    expect(report.failure).toMatchObject({
      seed: 'runtime-proof',
      contentRevision: 'r1',
      index: 1,
      action: { type: 'wait' },
      turn: 1,
      revision: 2,
      ruleIds: ['command'],
      error: { code: 'trace-turn' },
    });
    const good = await runCommandTrace(fixture(), [
      {
        action: { type: 'invalid' },
        ruleIds: ['command'],
        expectError: 'invalid-action',
        expectedRevision: 0,
      },
      { action: { type: 'two' }, ruleIds: ['command'], expectedTurn: 2, expectedRevision: 2 },
    ]);
    expect(good.passed).toBe(true);
    expect(good.commits).toHaveLength(2);
  });

  it('does not rerun new-game effects on restore and isolates retained mutable state', async () => {
    let initialized = 0;
    const retained = { count: 0 };
    const host = createRuntimeHost({
      seed: 'small',
      content: config,
      adapter: {
        id: 'small',
        stateVersion: 1,
        state: schema.object({ count: schema.number() }),
        content: { schemaVersion: 1, schema: schema.json },
        action: schema.literal('next'),
        eventPhases: ['default'],
        jobs: [],
        initialize() {
          initialized++;
          return retained;
        },
        resolve: () => success({ rule: 'next', turns: 0, payload: null }),
        commands: [
          {
            id: 'next',
            payload: schema.literal(null),
            progress: schema.literal(null),
            start(ctx) {
              ctx.state.count++;
            },
          },
        ],
        view: (ctx) => ({ count: ctx.state.count }),
      },
    });
    const initial = host.snapshot();
    retained.count = 90;
    expect(host.getView().count).toBe(0);
    requireValue(await host.dispatch('next'));
    requireValue(await host.restore(initial));
    expect(initialized).toBe(1);
    expect(host.getView().count).toBe(0);
  });

  it('restores explicit effect progress and resolves randomness only once for a paid action', async () => {
    let resolutions = 0;
    const adapter = fixtureAdapter();
    const progress = schema.object({ paid: schema.boolean, turns: schema.array(schema.number()) });
    const command = adapter.commands[0];
    if (!command) throw new Error('missing command');
    const instrumented = {
      ...adapter,
      resolve: (...args: Parameters<typeof adapter.resolve>) => {
        resolutions++;
        return adapter.resolve(...args);
      },
      commands: [
        {
          ...command,
          progress,
          start(
            ctx: Parameters<NonNullable<typeof command.start>>[0],
            action: Parameters<NonNullable<typeof command.start>>[1],
          ) {
            ctx.state.charged += 3;
            action.progress = { paid: true, turns: [] };
          },
          turn(
            ctx: Parameters<NonNullable<typeof command.turn>>[0],
            action: Parameters<NonNullable<typeof command.turn>>[1],
          ) {
            const data = requireValue(progress.parse(action.progress));
            data.turns.push(ctx.turn);
            action.progress = data;
            ctx.state.count++;
          },
          finish(
            ctx: Parameters<NonNullable<typeof command.finish>>[0],
            action: Parameters<NonNullable<typeof command.finish>>[1],
          ) {
            const data = requireValue(progress.parse(action.progress));
            ctx.state.log = data.turns.map(String);
          },
        },
      ],
    };
    const checkpoints: RuntimeSnapshot[] = [];
    const live = fixture(
      async (save) => {
        checkpoints.push(save.snapshot);
        return success(undefined);
      },
      { adapter: instrumented },
    );
    requireValue(await live.dispatch({ type: 'two' }));
    expect(checkpoints[0]?.pending?.progress).toEqual({ paid: true, turns: [1] });
    const copy = fixture(undefined, { adapter: instrumented });
    requireValue(await copy.restore(checkpoints[0]));
    requireValue(await copy.continuePending());
    expect(resolutions).toBe(1);
    expect(copy.snapshot()).toEqual(live.snapshot());
    expect(copy.inspect().state).toMatchObject({ count: 2, charged: 3, log: ['1', '2'] });
  });

  it('a later failing substep preserves its previous committed checkpoint and blocks unrelated actions', async () => {
    let broken = true;
    const adapter = fixtureAdapter();
    const original = adapter.commands[0];
    if (!original) throw new Error('missing command');
    const host = fixture(undefined, {
      adapter: {
        ...adapter,
        commands: [
          {
            ...original,
            turn(ctx, action) {
              if (ctx.turn === 2 && broken) {
                ctx.state.count = 900;
                ctx.random('jobs').nextUint32();
                throw new Error('broken second step');
              }
              original.turn?.(ctx, action);
            },
          },
        ],
      },
    });
    expect(await host.dispatch({ type: 'two' })).toMatchObject({
      ok: false,
      progress: { accepted: true, committedRevision: 1, pendingAction: 1 },
    });
    expect(host.inspect().state).toMatchObject({ count: 0, charged: 3 });
    expect(host.snapshot()).toMatchObject({ turn: 1, revision: 1 });
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'action-pending' },
    });
    broken = false;
    requireValue(await host.continuePending());
    const control = fixture();
    requireValue(await control.dispatch({ type: 'two' }));
    expect(host.snapshot()).toEqual(control.snapshot());
  });

  it('a listener disposing during publication prevents checkpoint IO from starting', async () => {
    let writes = 0;
    const host = fixture(async () => {
      writes++;
      return success(undefined);
    });
    host.subscribe(() => {
      void host.dispose();
    });
    expect(await host.dispatch({ type: 'two' })).toMatchObject({ ok: false });
    expect(writes).toBe(0);
    expect(host.getStatus()).toMatchObject({ disposed: true, revision: 1, turn: 1 });
  });

  it('mutation controls catch missing rules, zero paid costs and removed per-turn effects', async () => {
    const adapter = fixtureAdapter();
    const command = adapter.commands[0];
    if (!command) throw new Error('missing command');
    const mutated = [
      fixture(undefined, { adapter: { ...adapter, commands: [] } }),
      fixture(undefined, {
        content: { ...config, data: { ...config.data, costs: { free: 0, wait: 0, two: 0 } } },
      }),
      fixture(undefined, { adapter: { ...adapter, commands: [{ ...command, turn: () => {} }] } }),
    ];
    for (const host of mutated) {
      const report = await runCommandTrace(host, [
        {
          action: { type: 'two' },
          ruleIds: ['command'],
          expectedTurn: 2,
          assert: (_view, read) =>
            read.state.log.join(',') === 'turn:1,turn:2'
              ? success(undefined)
              : failure('turn-effects', 'Each paid turn must execute its named rule.'),
        },
      ]);
      expect(report.passed).toBe(false);
    }
  });
});

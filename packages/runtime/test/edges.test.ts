import { describe, expect, it } from 'vitest';
import {
  createRuntimeHost,
  failure,
  requireValue,
  runCommandTrace,
  schema,
  success,
} from '../src/index.js';
import { config, fixture, fixtureAdapter } from './fixture.js';

describe('runtime boundary invariants', () => {
  it('automatic-job limits cover start, turn and finish together, not each drain separately', async () => {
    const base = fixtureAdapter();
    const original = base.commands[0];
    if (!original) throw new Error('missing fixture command');
    const host = fixture(undefined, {
      limits: { maxEventsPerCommit: 3 },
      adapter: {
        ...base,
        commands: [
          {
            ...original,
            start(ctx) {
              for (const id of ['a', 'b'])
                ctx.schedule({
                  id,
                  rule: 'event',
                  payload: id,
                  anchor: { kind: 'elapsed', turn: ctx.turn },
                  phase: 'ready',
                  priority: 0,
                });
            },
            finish(ctx) {
              for (const id of ['c', 'd'])
                ctx.schedule({
                  id,
                  rule: 'event',
                  payload: id,
                  anchor: { kind: 'elapsed', turn: ctx.turn },
                  phase: 'ready',
                  priority: 0,
                });
            },
          },
        ],
      },
    });
    const before = host.snapshot();
    expect(await host.dispatch({ type: 'free' })).toMatchObject({
      ok: false,
      error: { code: 'transition-limit' },
      progress: { accepted: false },
    });
    expect(host.snapshot()).toEqual(before);
  });

  it('priority precedes lexical ID while equal-priority order ignores insertion order', async () => {
    const host = createRuntimeHost({
      seed: 'ordering',
      content: config,
      adapter: {
        id: 'ordering',
        stateVersion: 1,
        state: schema.array(schema.string()),
        action: schema.literal('run'),
        content: { schemaVersion: 1, schema: schema.json },
        initialize: () => [] as string[],
        eventPhases: ['ready', 'last'],
        resolve: () => success({ rule: 'run', turns: 1, payload: null }),
        commands: [
          {
            id: 'run',
            payload: schema.literal(null),
            progress: schema.literal(null),
            start(ctx) {
              for (const id of ['b', 'a'])
                ctx.schedule({
                  id,
                  rule: 'append',
                  payload: id,
                  anchor: { kind: 'elapsed', turn: 1 },
                  phase: 'ready',
                  priority: 0,
                });
              ctx.schedule({
                id: 'z-first',
                rule: 'append',
                payload: 'first',
                anchor: { kind: 'elapsed', turn: 1 },
                phase: 'ready',
                priority: -10,
              });
              ctx.schedule({
                id: 'a-last',
                rule: 'append',
                payload: 'last',
                anchor: { kind: 'elapsed', turn: 1 },
                phase: 'last',
                priority: -100,
              });
            },
          },
        ],
        jobs: [
          {
            id: 'append',
            payload: schema.string(),
            run(ctx, job) {
              ctx.state.push(requireValue(schema.string().parse(job.payload)));
            },
          },
        ],
        view: (read) => ({ log: read.state }),
      },
    });
    requireValue(await host.dispatch('run'));
    expect(host.inspect().state).toEqual(['first', 'a', 'b', 'last']);
  });

  it('registered cross-reference validation rejects a bad active node before restoring', async () => {
    const host = fixture(undefined, {
      adapter: {
        ...fixtureAdapter(),
        validate(read) {
          return read.state.log.includes('missing-node')
            ? failure('missing-node', 'Active narrative node is not installed.', {
                recordId: 'missing-node',
                path: 'state.log',
              })
            : success(undefined);
        },
      },
    });
    requireValue(await host.dispatch({ type: 'free' }));
    const before = host.snapshot();
    const candidate = {
      ...before,
      world: {
        ...before.world,
        resources: { 'aegis.runtime.state': { ...host.inspect().state, log: ['missing-node'] } },
      },
    };
    expect(await host.restore(candidate)).toMatchObject({
      ok: false,
      error: {
        code: 'missing-node',
        diagnostics: [{ recordId: 'missing-node', path: 'state.log' }],
      },
    });
    expect(host.snapshot()).toEqual(before);
    requireValue(await host.dispatch({ type: 'free' }));
  });

  it('rejects impossible identity counters and unprocessed due jobs in saved boundaries', async () => {
    const host = fixture();
    requireValue(await host.dispatch({ type: 'begin' }));
    const before = host.snapshot();
    const job = before.jobs[0];
    if (!job) throw new Error('fixture job missing');
    for (const candidate of [
      { ...before, nextAction: 0 },
      { ...before, nextJob: 0 },
      { ...before, nextPhase: 0 },
      { ...before, revision: 0, turn: 1 },
      { ...before, jobs: [{ ...job, anchor: { kind: 'elapsed', turn: 0 }, dueTurn: 0 }] },
      {
        ...before,
        jobs: [
          { ...job, token: 1 },
          { ...job, id: 'another', token: 1 },
        ],
      },
      { ...before, consumedJobs: [{ id: job.id, token: job.token }] },
    ]) {
      expect((await host.restore(candidate)).ok).toBe(false);
      expect(host.snapshot()).toEqual(before);
    }
  });

  it('rejects implicit state normalization rather than silently migrating a saved game', () => {
    expect(() =>
      fixture(undefined, {
        adapter: {
          ...fixtureAdapter(),
          state: {
            parse(candidate) {
              const parsed = fixtureAdapter().state.parse(candidate);
              return parsed.ok
                ? success({ ...parsed.value, count: parsed.value.count + 1 })
                : parsed;
            },
          },
        },
      }),
    ).toThrow('without implicit normalization');
  });

  it('empty traces are explicitly unexecuted, not a green zero-assertion result', async () => {
    expect(await runCommandTrace(fixture(), [])).toMatchObject({
      passed: false,
      checked: 0,
      commits: [],
      failure: { action: null, error: { code: 'trace-size' } },
    });
  });

  it('pause caused by a status listener never recursively notifies or queues a command', async () => {
    const host = fixture();
    let calls = 0;
    host.subscribeStatus((status) => {
      calls++;
      if (status.busy) host.pause('user');
    });
    // The command has been submitted but pause arrived before its first authoritative step.
    const before = host.snapshot();
    const result = await host.dispatch({ type: 'free' });
    expect(result).toMatchObject({ ok: false, error: { code: 'paused' } });
    expect(host.snapshot()).toEqual(before);
    expect(calls).toBeLessThan(5);
  });
});

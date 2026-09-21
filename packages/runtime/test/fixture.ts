import {
  applyBoundaryTransforms,
  createRuntimeHost,
  failure,
  requireValue,
  schema,
  success,
} from '../src/index.js';
import type {
  CheckpointWriter,
  ContentPack,
  InferSchema,
  RuntimeAdapter,
  RuntimeOptions,
} from '../src/index.js';

const count = schema.number({ integer: true, min: 0, max: 100_000 });
export const configSchema = schema.object({
  costs: schema.object({ free: count, wait: count, two: count }),
  allowance: count,
  jobDelay: count,
  price: count,
});
export type Config = InferSchema<typeof configSchema>;
export const config: ContentPack<Config> = {
  id: 'fixture',
  revision: 'r1',
  schemaVersion: 1,
  data: { costs: { free: 0, wait: 1, two: 2 }, allowance: 4, jobDelay: 2, price: 3 },
};
export const stateSchema = schema.object({
  count,
  charged: count,
  hints: count,
  reward: count,
  draws: schema.array(count),
  log: schema.array(schema.string()),
  slots: schema.array(count),
  ticket: schema.union(schema.literal(null), schema.object({ id: schema.string(), token: count })),
});
export type State = InferSchema<typeof stateSchema>;
const kinds = [
  'begin',
  'free',
  'wait',
  'two',
  'invalid',
  'claim',
  'hint',
  'purchase',
  'phase',
  'cancel',
  'replace',
  'cycle',
  'backward',
  'explode',
  'boundary',
] as const;
export const actionSchema = schema.union(
  schema.object({ type: schema.union(...kinds.map((kind) => schema.literal(kind))) }),
  schema.object({ type: schema.literal('allowance'), value: count }),
);
export type Action = InferSchema<typeof actionSchema>;
export type View = { count: number; turn: number; revision: number; log: readonly string[] };

export function fixtureAdapter(): RuntimeAdapter<State, Action, View, Config> {
  return {
    id: 'fixture',
    stateVersion: 1,
    state: stateSchema,
    action: actionSchema,
    content: { schemaVersion: 1, schema: configSchema },
    randomStreams: ['jobs'],
    eventPhases: ['ready', 'arrival', 'expiration'],
    initialize: () => ({
      count: 0,
      charged: 0,
      hints: 0,
      reward: 0,
      draws: [],
      log: [],
      slots: [1, 2, 3],
      ticket: null,
    }),
    resolve(action, context) {
      if (action.type === 'invalid') {
        context.random().nextUint32();
        return failure('invalid-action', 'Deliberately invalid command.');
      }
      if (action.type === 'claim' && context.claims.includes('reward')) {
        return failure('duplicate-claim', 'Reward was already claimed.');
      }
      if (action.type === 'hint' && context.state.hints >= 1) {
        return failure('exhausted', 'No hints remain.');
      }
      return success({
        rule: 'command',
        turns:
          action.type === 'two'
            ? context.content.data.costs.two
            : action.type === 'wait'
              ? context.content.data.costs.wait
              : context.content.data.costs.free,
        payload: { action, roll: context.random().int(0, 1000) },
      });
    },
    commands: [
      {
        id: 'command',
        payload: schema.object({ action: actionSchema, roll: count }),
        progress: schema.literal(null),
        start(context, pending) {
          const payload = requireValue(
            schema.object({ action: actionSchema, roll: count }).parse(pending.payload),
          );
          const action = payload.action;
          context.state.draws.push(payload.roll);
          if (action.type === 'begin') {
            context.enterPhase('first', context.content.data.allowance, 'reject');
            const phase = context.phase;
            if (!phase) throw new Error('phase missing');
            for (const id of ['job-b', 'job-a']) {
              const ticket = context.schedule({
                id,
                rule: 'event',
                payload: id,
                phase: 'ready',
                priority: 0,
                anchor: { kind: 'elapsed', turn: context.turn + context.content.data.jobDelay },
              });
              if (id === 'job-a') context.state.ticket = ticket;
            }
            context.schedule({
              id: 'arrival',
              rule: 'event',
              payload: 'arrival',
              phase: 'arrival',
              priority: 0,
              anchor: { kind: 'phase-entry', instance: phase.instance, offset: 2 },
            });
            context.schedule({
              id: 'expiration',
              rule: 'event',
              payload: 'expiration',
              phase: 'expiration',
              priority: 0,
              anchor: { kind: 'phase-end', instance: phase.instance, offset: -2 },
            });
          } else if (action.type === 'allowance') context.adjustAllowance(action.value);
          else if (action.type === 'phase') context.enterPhase('second', 3, 'cancel');
          else if (action.type === 'free') context.state.count++;
          else if (action.type === 'hint') context.state.hints++;
          else if (action.type === 'purchase') context.state.charged += context.content.data.price;
          else if (action.type === 'two') context.state.charged += context.content.data.price;
          else if (action.type === 'claim') {
            if (context.claim('reward')) context.state.reward++;
            context.emit('reward.claimed');
          } else if (action.type === 'cancel') {
            if (!context.state.ticket) throw new Error('ticket missing');
            requireValue(context.cancel(context.state.ticket));
          } else if (action.type === 'replace') {
            if (!context.state.ticket) throw new Error('ticket missing');
            context.state.ticket = context.schedule(
              {
                id: 'job-a',
                rule: 'event',
                payload: 'replacement',
                phase: 'ready',
                priority: 0,
                anchor: { kind: 'elapsed', turn: context.turn + 1 },
              },
              context.state.ticket,
            );
          } else if (action.type === 'cycle' || action.type === 'backward') {
            context.schedule({
              id: 'loop',
              rule: action.type,
              payload: 0,
              phase: 'ready',
              priority: 0,
              anchor: { kind: 'elapsed', turn: context.turn },
            });
          } else if (action.type === 'explode') {
            context.state.count = 99;
            context.random('jobs').nextUint32();
            throw new Error('deliberate rule failure');
          } else if (action.type === 'boundary') {
            context.state = requireValue(
              applyBoundaryTransforms(context.state, [
                {
                  id: 'left',
                  evaluate: (before) => [{ path: ['slots', 0], value: before.slots[1] ?? 0 }],
                },
                {
                  id: 'middle',
                  evaluate: (before) => [{ path: ['slots', 1], value: before.slots[0] ?? 0 }],
                },
              ]),
            );
          }
        },
        turn(context) {
          context.state.log.push(`turn:${context.turn}`);
        },
        finish(context, pending) {
          context.emit('action.finished', pending.id);
        },
      },
    ],
    jobs: [
      {
        id: 'event',
        payload: schema.string(),
        run(context, job) {
          context.state.log.push(String(job.payload));
          context.state.draws.push(context.random('jobs').int(0, 1000));
          context.emit('job.ready', job.id);
        },
      },
      ...(['cycle', 'backward'] as const).map((id) => ({
        id,
        payload: count,
        run(
          context: Parameters<
            NonNullable<RuntimeAdapter<State, Action, View, Config>['jobs']>[number]['run']
          >[0],
          job: Parameters<
            NonNullable<RuntimeAdapter<State, Action, View, Config>['jobs']>[number]['run']
          >[1],
        ) {
          const n = requireValue(count.parse(job.payload)) + 1;
          context.schedule({
            id: id === 'backward' ? 'aaa' : `loop-${String(n).padStart(6, '0')}`,
            rule: id,
            payload: n,
            phase: 'ready',
            priority: 0,
            anchor: { kind: 'elapsed', turn: context.turn },
          });
        },
      })),
    ],
    view: (read) => ({
      count: read.state.count,
      turn: read.turn,
      revision: read.revision,
      log: read.state.log,
    }),
    canActivateContent: (read) => read.phase?.id === 'second',
  };
}

export function fixture(
  checkpoint?: CheckpointWriter,
  overrides: Partial<RuntimeOptions<State, Action, View, Config>> = {},
) {
  return createRuntimeHost({
    adapter: fixtureAdapter(),
    content: config,
    seed: 'runtime-proof',
    checkpoint,
    limits: { maxEventsPerCommit: 8 },
    ...overrides,
  });
}

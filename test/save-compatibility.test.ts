import { describe, expect, it } from 'vitest';
import {
  createRuntimeHost,
  failure,
  requireValue,
  schema,
  success,
  validateRuntimeSnapshot,
} from '@aegis/runtime';
import type { RuntimeAdapter, RuntimeSnapshot } from '@aegis/runtime';

/**
 * F11 (SAVE-09, issue #8): a campaign that saves after every action. 10,000 separate commits,
 * each consuming a job and a once-ever claim, must keep the checkpoint bounded and valid, restore,
 * and still refuse a replayed claim or a stale job ticket.
 */
type State = { moves: number; ticket: { id: string; token: number } | null };
type Action = { type: 'move' } | { type: 'reclaim'; n: number } | { type: 'cancel' };
const counter = schema.number({ integer: true, min: 0 });
const ticket = schema.object({ id: schema.string(), token: counter });
const action = schema.union(
  schema.object({ type: schema.literal('move') }),
  schema.object({ type: schema.literal('reclaim'), n: counter }),
  schema.object({ type: schema.literal('cancel') }),
);
const adapter: RuntimeAdapter<State, Action, { moves: number }, unknown> = {
  id: 'save-after-every-move',
  stateVersion: 1,
  state: schema.object({ moves: counter, ticket: schema.union(schema.literal(null), ticket) }),
  action,
  content: { schemaVersion: 1, schema: schema.json },
  eventPhases: ['ready'],
  initialize: () => ({ moves: 0, ticket: null }),
  resolve(next, read) {
    if (next.type === 'reclaim' && read.claims.includes(`reward-${String(next.n)}`))
      return failure('duplicate-claim', 'Reward already granted.');
    return success({ rule: 'move', payload: next, turns: next.type === 'move' ? 1 : 0 });
  },
  commands: [
    {
      id: 'move',
      payload: action,
      progress: schema.literal(null),
      start(context, pending) {
        if ((pending.payload as Action).type === 'cancel' && context.state.ticket)
          requireValue(context.cancel(context.state.ticket));
      },
      turn(context) {
        context.state.moves++;
        context.state.ticket = context.schedule({
          id: 'tick',
          rule: 'tick',
          payload: context.turn,
          anchor: { kind: 'elapsed', turn: context.turn },
          phase: 'ready',
          priority: 0,
        });
        if (!context.claim(`reward-${String(context.state.moves)}`))
          throw new Error('claim was granted twice');
      },
    },
  ],
  jobs: [{ id: 'tick', payload: counter, run: () => undefined }],
  view: (read) => ({ moves: read.state.moves }),
};
const content = { id: 'campaign', revision: 'r1', schemaVersion: 1, data: null };

describe('long-lived saves stay bounded and idempotent (F11)', () => {
  it('makes 10,000 commits with a checkpoint after each and restores the last one', async () => {
    let last: RuntimeSnapshot | undefined;
    const sizes: number[] = [];
    let checkpoints = 0;
    const host = createRuntimeHost({
      adapter,
      content,
      seed: 'campaign',
      checkpoint: async (checkpoint) => {
        checkpoints++;
        last = checkpoint.snapshot;
        if (checkpoints % 500 === 0) sizes.push(JSON.stringify(last).length);
        return success(undefined);
      },
    });
    for (let i = 0; i < 10_000; i++) {
      requireValue(await host.dispatch({ type: 'move' }));
      // Yield a macrotask now and then: microtask-only awaits would starve the worker's RPC.
      if (i % 200 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(checkpoints).toBeGreaterThanOrEqual(10_000);
    const final = JSON.parse(JSON.stringify(last)) as RuntimeSnapshot;
    expect(validateRuntimeSnapshot(final)).toMatchObject({ ok: true });
    // Lists compact past 1,024 entries; afterwards the checkpoint stops growing.
    expect(Math.max(...sizes)).toBeLessThan(64 * 1024);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(sizes[3]! + 64);
    const restored = createRuntimeHost({ adapter, content, seed: 'campaign' });
    requireValue(await restored.restore(final));
    expect(restored.getView()).toEqual({ moves: 10_000 });
    for (const n of [1, 5_000, 10_000])
      expect(await restored.dispatch({ type: 'reclaim', n })).toMatchObject({
        ok: false,
        error: { code: 'duplicate-claim' },
      });
    expect(await restored.dispatch({ type: 'cancel' })).toMatchObject({ ok: false });
    requireValue(await restored.dispatch({ type: 'move' }));
    expect(restored.getView()).toEqual({ moves: 10_001 });
    await host.dispose();
    await restored.dispose();
  }, 120_000);
});

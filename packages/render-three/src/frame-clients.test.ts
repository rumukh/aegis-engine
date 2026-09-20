import { describe, expect, it } from 'vitest';
import { createLiveInput } from './live-input.js';
import {
  FrameClients,
  FRAME_CLIENT_IDLE_SECONDS,
  FRAME_CLIENT_LIMIT,
  FRAME_OWNER_IDLE_SECONDS,
  validFrameClient,
} from './frame-clients.js';
import type { FrameClient } from './frame-clients.js';
import type { InputPacket } from './live-input.js';

function rig() {
  const input = createLiveInput();
  const clients = new FrameClients();
  const submit = (
    id: string,
    seq: number,
    claim: boolean,
    packet: Partial<InputPacket> = {},
    generation: number | null = 0,
    now = 0,
  ) => {
    const client = clients.client(id, now, input);
    if (client === undefined) throw new Error('Fixture exceeded client limit');
    return clients.submit(input, client, { id, claim, generation }, { seq, ...packet }, 0, now);
  };
  return { input, clients, submit };
}

describe('per-page live input ownership', () => {
  it('acknowledges a retained source release after expiry without reclaiming control or losing pending impulses', () => {
    const { input, submit } = rig();
    submit('driver', 1, true, {
      held: ['Use'],
      pressed: ['Use'],
      axes: { Forward: 1 },
      look: { dx: 90.02, dy: 0 },
    });
    expect(
      submit(
        'driver',
        2,
        false,
        {
          held: [],
          pressed: [],
          released: ['Use'],
          axes: {},
          look: { dx: 0, dy: 0 },
          pointer: null,
        },
        0,
        3,
      ),
    ).toEqual({ role: 'observing', accepted: true, reason: 'accepted', lastSeq: 2 });
    expect(submit('driver', 3, false, { axes: { Forward: 0 } }, 0, 3.1).accepted).toBe(true);
    expect(submit('driver', 4, false, { axes: { Forward: 1 } }, 0, 3.2)).toMatchObject({
      role: 'observing',
      accepted: false,
      reason: 'observing',
    });
    expect(input.frameFor(0)).toMatchObject({
      actions: { Use: true },
      pressed: ['Use'],
      released: ['Use'],
      axes: {},
      look: { dx: 90.02, dy: 0 },
    });
    expect(input.frameFor(1)).toMatchObject({
      actions: {},
      pressed: [],
      released: [],
      axes: {},
      look: { dx: 0, dy: 0 },
    });
  });

  it.each([
    { held: ['Use'] },
    { pressed: ['Use'] },
    { axes: { Forward: 1 } },
    { axes: { Forward: -1 } },
    { axes: { Forward: NaN } },
    { look: { dx: 1, dy: 0 } },
    { look: { dx: 0, dy: -1 } },
    { look: { dx: NaN, dy: 0 } },
    { pointer: { screen: { x: 1, y: 2 }, world: null, buttons: [] } },
  ] satisfies Partial<InputPacket>[])(
    'does not admit an active channel through the expired release-only path: %j',
    (extra) => {
      const { input, submit } = rig();
      submit('driver', 1, true, { look: { dx: 90.02, dy: 0 } });
      expect(submit('driver', 2, false, { released: ['Use'], ...extra }, 0, 3)).toMatchObject({
        role: 'observing',
        accepted: false,
        reason: 'observing',
      });
      expect(input.frameFor(0)).toMatchObject({
        axes: {},
        released: [],
        look: { dx: 90.02, dy: 0 },
      });
    },
  );

  it('requires the retained source, current generation and new sequence for release acknowledgement', () => {
    const { input, submit } = rig();
    submit('driver', 3, true, { look: { dx: 90.02, dy: 0 } });
    expect(submit('other', 1, false, { released: ['Use'] }, 0, 3).reason).toBe('observing');
    expect(submit('driver', 3, false, { released: ['Use'] }, 0, 3).reason).toBe('stale');
    expect(submit('driver', 4, false, { released: ['Use'] }, 1, 3).reason).toBe('generation');
    expect(input.frameFor(0)).toMatchObject({ released: [], look: { dx: 90.02, dy: 0 } });
    submit('new-owner', 1, true, { axes: { Strafe: 1 } }, 0, 3);
    expect(submit('driver', 5, false, { released: ['Use'] }, 0, 3).reason).toBe('observing');
    expect(input.frameFor(1)).toMatchObject({ axes: { Strafe: 1 }, released: [] });
  });

  it('expires held levels at two seconds but keeps accepted turns, taps and clicks for one tick', () => {
    const { input, submit } = rig();
    const pointer = { screen: { x: 10, y: 20 }, world: { x: 3, y: 0, z: 4 }, buttons: ['primary'] };
    submit('driver', 1, true, {
      held: ['Use'],
      pressed: ['Use'],
      released: ['Tap'],
      axes: { Forward: 1 },
      look: { dx: 90.02, dy: -2 },
      pointer,
    });
    submit('observer', 1, false, {}, 0, 2.001);
    expect(input.frameFor(2481)).toMatchObject({
      actions: { Use: true },
      pressed: ['Use'],
      released: ['Tap'],
      axes: {},
      look: { dx: 90.02, dy: -2 },
      pointer,
    });
    expect(input.frameFor(2482)).toMatchObject({
      actions: {},
      pressed: [],
      released: [],
      axes: {},
      look: { dx: 0, dy: 0 },
      pointer: null,
    });
  });

  it('preserves only the pending aggregate when fresh same-owner movement reacquires after expiry', () => {
    const { input, submit } = rig();
    submit('driver', 1, true, { look: { dx: 90.02, dy: 0 } });
    expect(submit('driver', 2, true, { axes: { Forward: 1 } }, 0, 3.1158).accepted).toBe(true);
    expect(input.frameFor(2481)).toMatchObject({
      axes: { Forward: 1 },
      look: { dx: 90.02, dy: 0 },
    });
    expect(input.frameFor(2482).look.dx).toBe(0);
  });

  it('retains the pending source sequence beyond record expiry without growing an input queue', () => {
    const { input, clients, submit } = rig();
    submit('driver', 7, true, { look: { dx: 90.02, dy: 0 } });
    for (let index = 0; index < FRAME_CLIENT_LIMIT - 1; index++)
      submit(`observer-${index}`, 1, false);
    expect(clients.client('fresh', 61, input)).toBeDefined();
    expect(submit('driver', 7, true, { look: { dx: 90.02, dy: 0 } }, 0, 61).reason).toBe('stale');
    expect(input.frameFor(0).look.dx).toBe(90.02);
    expect(input.frameFor(1).look.dx).toBe(0);
  });

  it.each(['reset', 'handoff', 'restart', 'legacy'] as const)(
    'cancels the expired source aggregate on explicit %s, never from an unrelated observer',
    (boundary) => {
      const { input, clients, submit } = rig();
      submit('driver', 1, true, {
        look: { dx: 90.02, dy: 0 },
        pressed: ['Use'],
        released: ['Use'],
        pointer: { screen: { x: 1, y: 2 }, world: null, buttons: ['primary'] },
      });
      submit('observer', 1, false, { reset: true }, 0, 3);
      if (boundary === 'reset') submit('driver', 2, false, { reset: true }, 0, 3);
      if (boundary === 'handoff') submit('new', 1, true, {}, 0, 3);
      if (boundary === 'legacy') clients.submitLegacy(input, { seq: 1 }, 3);
      if (boundary === 'restart') {
        clients.reset();
        input.clear();
      }
      expect(input.frameFor(0)).toMatchObject({
        pressed: [],
        released: [],
        look: { dx: 0, dy: 0 },
        pointer: null,
      });
    },
  );

  it('does not let stale or old-generation resets cancel accepted pending input', () => {
    const { input, submit } = rig();
    submit('driver', 2, true, { look: { dx: 90.02, dy: 0 } });
    expect(submit('driver', 1, false, { reset: true }, 0, 3).reason).toBe('stale');
    expect(submit('driver', 3, false, { reset: true }, 1, 3).reason).toBe('generation');
    expect(input.frameFor(0).look.dx).toBe(90.02);
  });

  it('accepts a fresh low-sequence page while an older neutral page keeps polling', () => {
    const { input, submit } = rig();
    submit('older', 1057, false, { axes: {} });
    expect(
      submit('newer', 1, true, { axes: { Forward: 1 }, look: { dx: -5.6, dy: 0 } }),
    ).toMatchObject({ role: 'controlling', accepted: true, lastSeq: 1 });
    expect(submit('older', 1058, false, { axes: {}, reset: true })).toMatchObject({
      accepted: false,
      role: 'observing',
    });
    expect(input.frameFor(0)).toMatchObject({ axes: { Forward: 1 }, look: { dx: -5.6, dy: 0 } });
    submit('newer', 2, false, { axes: {} });
    expect(input.frameFor(1).axes).toEqual({});
  });

  it('transfers only on fresh intent, never old held resends or release packets', () => {
    const { input, submit } = rig();
    submit('first', 1, true, { held: ['Jump'], pressed: ['Jump'], axes: { Forward: 1 } });
    input.frameFor(0);
    submit('second', 1, true, { axes: { Strafe: 1 }, look: { dx: 3, dy: 0 } });
    submit('first', 2, false, { held: ['Jump'], axes: { Forward: 1 } });
    expect(input.frameFor(1)).toMatchObject({
      actions: {},
      axes: { Strafe: 1 },
      look: { dx: 3, dy: 0 },
    });
    submit('first', 3, false, { held: [], released: ['Jump'], reset: true, axes: {} });
    expect(input.frameFor(2).axes).toEqual({ Strafe: 1 });
    submit('first', 4, true, { axes: { Forward: -1 } });
    expect(input.frameFor(3).axes).toEqual({ Forward: -1 });
  });

  it('rejects duplicate/out-of-order claims per page and consumes look/edges once', () => {
    const { input, submit } = rig();
    submit('first', 100, true, { pressed: ['Use'], look: { dx: 2, dy: 1 } });
    expect(submit('first', 99, true, { look: { dx: 50, dy: 30 } }).reason).toBe('stale');
    expect(input.frameFor(0)).toMatchObject({ pressed: ['Use'], look: { dx: 2, dy: 1 } });
    submit('second', 1, true);
    expect(submit('first', 100, true).reason).toBe('stale');
    expect(input.frameFor(1)).toMatchObject({ pressed: [], look: { dx: 0, dy: 0 } });
  });

  it('releases a vanished owner without letting an observer heartbeat preserve held input', () => {
    const { input, submit } = rig();
    submit('first', 1, true, { axes: { Forward: 1 } }, 0, 0);
    submit('observer', 100, false, {}, 0, FRAME_OWNER_IDLE_SECONDS);
    expect(input.frameFor(0).axes).toEqual({ Forward: 1 });
    submit('observer', 101, false, {}, 0, FRAME_OWNER_IDLE_SECONDS + 0.01);
    expect(input.frameFor(1).axes).toEqual({});
    expect(submit('first', 2, false, { axes: { Forward: 1 } }, 0, 3).role).toBe('observing');
    expect(submit('first', 3, true, { axes: { Forward: 1 } }, 0, 3).role).toBe('controlling');
  });

  it('keeps event cursors independent and resets them without accepting delayed old-generation input', () => {
    const { input, clients, submit } = rig();
    const first = clients.client('first', 0, input)!;
    const second = clients.client('second', 0, input)!;
    first.eventCursor = 6;
    expect(second.eventCursor).toBe(0);
    submit('first', 1, true, { axes: { Forward: 1 } });
    clients.reset();
    input.clear();
    expect(first.eventCursor).toBe(0);
    expect(
      clients.submit(
        input,
        first,
        { id: 'first', claim: true, generation: 0 },
        { seq: 2, axes: { Forward: 1 } },
        1,
        0,
      ).reason,
    ).toBe('generation');
    expect(input.frameFor(0).axes).toEqual({});
    expect(
      clients.submit(
        input,
        first,
        { id: 'first', claim: true, generation: 1 },
        { seq: 3, axes: { Forward: 1 } },
        1,
        0,
      ).accepted,
    ).toBe(true);
  });

  it('retains metadata-free API ordering and blocks it from silently erasing a modern owner', () => {
    const { input, clients, submit } = rig();
    expect(clients.submitLegacy(input, { seq: 1057, axes: { Forward: 1 } }, 0).accepted).toBe(true);
    expect(clients.submitLegacy(input, { seq: 10 }, 0).reason).toBe('stale');
    submit('modern', 1, true, { axes: { Strafe: 1 } });
    expect(clients.submitLegacy(input, { seq: 5000, axes: {} }, 0).reason).toBe('observing');
    expect(input.frameFor(0).axes).toEqual({ Strafe: 1 });
    expect(clients.submitLegacy(input, { seq: 5001, axes: { Forward: -1 } }, 3).accepted).toBe(
      true,
    );
    expect(input.frameFor(1).axes).toEqual({ Forward: -1 });
  });

  it('bounds identity storage and prunes only idle nonowners', () => {
    const { input, clients } = rig();
    for (let index = 0; index < FRAME_CLIENT_LIMIT; index++)
      expect(clients.client(`page-${index}`, 0, input)).toBeDefined();
    expect(clients.client('overflow', 0, input)).toBeUndefined();
    expect(clients.client('new-page', FRAME_CLIENT_IDLE_SECONDS + 1, input)).toBeDefined();
  });

  it('validates client identity, claims and restart generation without accepting arbitrary shapes', () => {
    const valid: FrameClient = { id: 'page-1', claim: false, generation: null };
    expect(validFrameClient(valid)).toBe(true);
    expect(validFrameClient({ ...valid, claim: true, generation: 1 })).toBe(true);
    for (const bad of [
      null,
      [],
      {},
      { ...valid, id: '' },
      { ...valid, id: 'x'.repeat(65) },
      { ...valid, claim: 1 },
      { ...valid, generation: -1 },
      { ...valid, generation: 0.5 },
    ])
      expect(validFrameClient(bad)).toBe(false);
  });
});

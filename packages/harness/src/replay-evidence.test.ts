import { createSchedule, defineResource, Transform } from '@aegis/core';
import type { System, World } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import { describe, expect, it } from 'vitest';
import { formatReplayDetails, parseRecording, serializeRecording } from './replay.js';
import { runScene, verifyReplay } from './run.js';
import { fakeMode } from './testing/fake-mode.js';

const scene: SceneFile = {
  aegis: 'scene/1',
  name: 'sensor',
  mode: 'fps',
  entities: [{ id: 'sensor', components: { Transform: {} } }],
};
function capture(run: System['run'], init?: (world: World) => void, ticks = 5, detailed = true) {
  return runScene(
    { ...scene, mode: fakeMode.mode },
    {
      plugin: {
        ...fakeMode,
        init,
        systems: () => createSchedule().add({ name: 'sensor', phase: 'update', run }),
      },
      ticks,
      captureReplayEvidence: detailed,
      recordEvents: false,
    },
  );
}
function pulse(field = 2, omit = false): System['run'] {
  return ({ world, tick }) => {
    world
      .query({ has: [Transform] })
      .one()
      .get(Transform).position.x = tick === 2 ? field : 0;
    if (tick === 1 && !omit) world.events.emit('armed', { channel: 1 });
    if (tick === 2) world.events.emit('pulse', { channel: 1 });
  };
}

describe('opt-in recording evidence', () => {
  it('round-trips a matching run and explains a transient field change despite final convergence', async () => {
    const text = serializeRecording((await capture(pulse())).recording());
    const baseline = parseRecording(text);
    const control = await capture(pulse());
    expect(serializeRecording(control.recording())).toBe(text);
    expect(verifyReplay(baseline, control)).toMatchObject({
      ok: true,
      details: { status: 'matched' },
    });
    const candidate = await capture(pulse(7));
    const result = verifyReplay(baseline, candidate);
    expect(result).toMatchObject({
      ok: false,
      finalHashMatched: true,
      firstDivergentTick: 2,
      details: {
        status: 'diverged',
        phase: 'step',
        tick: 2,
        fields: {
          total: 1,
          truncated: false,
          differences: [
            {
              path: '/entities/4294967296/components/Transform/position/x',
              expected: { value: 2 },
              actual: { value: 7 },
            },
          ],
        },
        events: { firstDifference: null, actual: { entries: [{ type: 'pulse' }] } },
      },
    });
    expect(formatReplayDetails(result.details)).toContain('expected 2, actual 7');
  });

  it('fails event-only changes with every hash equal, and finds an earlier missing event before a state mismatch', async () => {
    const baseline = parseRecording(serializeRecording((await capture(pulse())).recording()));
    for (const field of [2, 7]) {
      const run = await capture(pulse(field, true));
      if (field === 2) expect(run.tickHashes).toEqual(baseline.tickHashes);
      expect(verifyReplay(baseline, run)).toMatchObject({
        ok: false,
        finalHashMatched: true,
        firstDivergentTick: 1,
        details: {
          tick: 1,
          fields: { total: 0 },
          events: {
            firstDifference: 0,
            expected: { total: 1, entries: [{ type: 'armed', data: { value: { channel: 1 } } }] },
            actual: { total: 0, entries: [] },
          },
        },
      });
    }
  });

  it('keeps hash-only recordings small and explicit; missing or malformed detailed evidence cannot silently pass', async () => {
    const basic = await capture(pulse(), undefined, 5, false);
    const text = serializeRecording(basic.recording());
    expect(text).not.toContain('evidence');
    expect(verifyReplay(parseRecording(text), await capture(pulse(7)))).toMatchObject({
      ok: false,
      firstDivergentTick: 2,
      details: { status: 'unavailable', reason: 'hash-only-recording' },
    });
    const detailed = (await capture(pulse())).recording();
    expect(verifyReplay(detailed, basic)).toMatchObject({
      ok: false,
      details: { reason: 'replay-not-captured' },
    });
    const malformed = JSON.parse(serializeRecording(detailed));
    malformed.evidence.frames[1].state['/prng'] = -1;
    expect(() => parseRecording(JSON.stringify(malformed))).toThrow(/dictionary reference/);
  });

  it('compares bootstrap on a zero-step run and caps large values, paths, field counts and FIFO windows', async () => {
    const resource = defineResource<Record<string, unknown>>('probe/~', () => ({}));
    const setup = (changed: boolean) => (w: World) => {
      w.setResource(resource, {
        ...(changed ? {} : { removed: null }),
        ['a'.repeat(400)]: (changed ? 'y' : 'x').repeat(500),
        z: Array(32).fill(changed ? 1 : 0),
      });
      for (let i = 0; i < 24; i++)
        w.events.emit('many', i < 10 ? i : (changed ? 'y' : 'x').repeat(500));
    };
    const old = (await capture(pulse(), setup(false), 0)).recording();
    const candidate = await capture(pulse(), setup(true), 0);
    const result = verifyReplay(old, candidate);
    expect(result).toMatchObject({
      ok: false,
      firstDivergentTick: 0,
      details: {
        status: 'diverged',
        phase: 'initial',
        fields: { total: 34, truncated: true },
        events: { firstDifference: 10, offset: 10, expected: { total: 24, truncated: true } },
      },
    });
    if (result.details.status !== 'diverged') throw new Error('missing details');
    const { fields, events } = result.details;
    expect(fields.differences).toHaveLength(16);
    expect(fields.differences[0]).toMatchObject({ pathTruncated: true, expected: { chars: 502 } });
    expect(fields.differences[1]).toMatchObject({
      path: '/resources/probe~1~0/removed',
      expected: { value: null },
      actual: { missing: true },
    });
    expect(events.expected.entries).toHaveLength(8);
    expect(events.actual.entries[0]!.data).toMatchObject({ chars: 502 });
    expect(verifyReplay(old, candidate)).toEqual(result);
  });
});

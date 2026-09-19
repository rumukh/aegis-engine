import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeHorrorPage,
  HORROR_FAILURE_EXPRESSION,
  projectHorrorFailure,
  reportHorrorFailure,
} from './support/horror-failure-context.js';

function fixture() {
  return {
    snapshot: {
      tick: 8217,
      resources: { deliberatelyOmitted: 'DO_NOT_DUMP_RESOURCES' },
      entities: [
        {
          name: 'mission',
          components: {
            HorrorMission: { power: true, uplink: false, escaped: false, dead: false },
          },
        },
        {
          name: 'player',
          components: {
            Transform: { position: { x: 12, y: 0, z: 31 } },
            LookState: { yawDeg: 90.02, pitchDeg: 0 },
            Health: { current: 100, max: 100 },
            HorrorPlayer: { stamina: 3, noise: 4 },
            HorrorStatus: { objective: 'Find the recorder', ended: false },
          },
        },
        {
          name: 'responder',
          components: {
            Transform: { position: { x: 24, y: 0, z: 31 } },
            HorrorThreat: {
              mode: 'search',
              suspicion: 0.7,
              searchTicks: 18,
              path: [{ x: 23, z: 31 }],
            },
          },
        },
        {
          name: 'power-console',
          components: {
            HorrorInteractable: {
              kind: 'power',
              selection: 2,
              progress: 90,
              holdTicks: 90,
              used: true,
              transcript: 'NOT_NEEDED',
            },
          },
        },
      ],
    },
    observations: {
      tick: 8217,
      hash: 'independent-receipt-hash',
      paused: true,
      presentation: {
        status: 'ready',
        generation: 1,
        input: {
          capture: { focused: true, pointer: 'locked', paused: true },
          transport: { role: 'observing', accepted: false, reason: 'generation', lastSeq: 90 },
        },
      },
      timings: {
        exchangeErrors: 1,
        firstExchangeFailure: {
          stage: 'body',
          responseStatus: 200,
          name: 'AbortError',
          message: 'The user aborted a request.',
          elapsedMs: 2517,
          requestSequence: 41,
          requestGeneration: 1,
          generation: 1,
          tick: 5,
          renderedGeneration: 1,
          lastRenderMs: 1,
          longestRenderWhilePendingMs: 2510,
        },
      },
    },
    events: [
      { type: 'horror.power.restored', tick: 2477, sequence: 10, data: { selection: 2 } },
      {
        type: 'horror.player.step',
        tick: 2500,
        sequence: 11,
        data: { position: { x: 12, z: 30 } },
      },
      { type: 'horror.threat.search', tick: 5318, sequence: 12, data: { lostTicks: 20 } },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Horror failure-only browser diagnostics', () => {
  it('reports independent mission/player/threat and input/first-exchange facts without dumping world resources', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const report = projectHorrorFailure(input);
    expect(report).toMatchObject({
      world: { tick: 8217, entities: 4, resources: 'omitted' },
      mission: { escaped: false, power: true, uplink: false },
      player: {
        position: { x: 12, y: 0, z: 31 },
        look: { yawDeg: 90.02 },
        health: { current: 100 },
      },
      threat: { state: { mode: 'search', searchTicks: 18 } },
      presentation: { input: { transport: { role: 'observing', lastSeq: 90 } } },
      firstExchangeFailure: {
        stage: 'body',
        responseStatus: 200,
        longestRenderWhilePendingMs: 2510,
      },
      events: {
        available: true,
        total: 3,
        relevant: 2,
        returned: 2,
        items: [
          { type: 'horror.power.restored', tick: 2477 },
          { type: 'horror.threat.search', tick: 5318 },
        ],
      },
    });
    expect(JSON.stringify(report)).not.toContain('DO_NOT_DUMP_RESOURCES');
    expect(JSON.stringify(report)).not.toContain('NOT_NEEDED');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('bounds authored values, long event payloads and path/interaction lists with explicit truncation counts', () => {
    const input = fixture();
    const long = 'x'.repeat(10000);
    const snapshot = {
      ...input.snapshot,
      entities: [
        ...input.snapshot.entities,
        ...Array.from({ length: 40 }, (_, index) => ({
          name: `console-${index}`,
          components: {
            HorrorInteractable: { kind: long, selection: index, progress: index, used: false },
          },
        })),
      ],
    };
    const report = projectHorrorFailure({
      ...input,
      snapshot,
      events: Array.from({ length: 1000 }, (_, index) => ({
        type: 'horror.threat.search',
        tick: index,
        sequence: index,
        data: { text: long, values: Array.from({ length: 100 }, () => ({ text: long })) },
      })),
    });
    expect(report).toMatchObject({
      events: { total: 1000, relevant: 1000, returned: 24, limit: 24 },
      interactables: { total: 41, returned: 16 },
      bounds: { truncated: true, maxValueNodes: 512, maxTextChars: 8192 },
      firstExchangeFailure: { longestRenderWhilePendingMs: 2510 },
    });
    expect(JSON.stringify(report).length).toBeLessThan(24000);
    expect(JSON.stringify(report)).toContain('[truncated]');
  });

  it('executes the serialized diagnostic in an isolated page context and reads the snapshot once', () => {
    const input = fixture();
    const snapshot = vi.fn(() => input.snapshot);
    const read = runInNewContext(HORROR_FAILURE_EXPRESSION, {
      aegis: {
        world: { snapshot, hash: () => 'browser-hash' },
        tick: () => 8217,
        presentation: () => input.observations.presentation,
        timings: () => input.observations.timings,
      },
      document: {
        getElementById: () => ({ getAttribute: () => 'true' }),
        hasFocus: () => true,
        visibilityState: 'visible',
        activeElement: { id: 'stage' },
        pointerLockElement: { id: 'stage' },
      },
    });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(read).toMatchObject({
      observation: {
        hash: 'browser-hash',
        paused: true,
        focused: true,
        activeElement: 'stage',
        pointerLocked: 'stage',
      },
      events: { available: false },
      mission: { escaped: false },
    });
  });

  it('preserves the actual failing assertion and reports both authoritative and browser evidence', async () => {
    const input = fixture();
    let original: unknown;
    try {
      assert.equal(false, true, 'escaped must be true');
    } catch (error) {
      original = error;
    }
    expect(original).toBeInstanceOf(assert.AssertionError);
    const emit = vi.fn();
    const send = vi.fn(async () => ({ result: { value: projectHorrorFailure(input) } }));
    const failure = async () => {
      try {
        throw original;
      } catch (error) {
        await reportHorrorFailure(error, {
          label: 'live: win route',
          page: { send },
          authoritative: () => input,
          emit,
        });
        throw error;
      }
    };
    await expect(failure()).rejects.toBe(original);
    expect(original).toMatchObject({ actual: false, expected: true, operator: 'strictEqual' });
    expect((original as Error).message).toContain('escaped must be true');
    expect((original as Error).stack).toContain('[horror-failure]');
    const report = JSON.parse(emit.mock.calls[0]![0].replace('[horror-failure] ', ''));
    expect(report).toMatchObject({
      label: 'live: win route',
      authoritative: { available: true, value: { mission: { escaped: false } } },
      browser: {
        available: true,
        value: { presentation: { input: { transport: { role: 'observing' } } } },
      },
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      'Runtime.evaluate',
      { expression: HORROR_FAILURE_EXPRESSION, returnByValue: true, awaitPromise: false },
      3000,
    );
  });

  it('states diagnostic read failures explicitly without hiding or replacing the assertion', async () => {
    const original = new Error('distance 13.6 exceeds 5');
    const emit = vi.fn();
    const send = vi.fn(async () => {
      throw new Error('Target closed');
    });
    await reportHorrorFailure(original, {
      label: 'live: caught route',
      page: { send },
      emit,
      authoritative: () => {
        throw new Error('Session unavailable');
      },
    });
    const report = JSON.parse(emit.mock.calls[0]![0].replace('[horror-failure] ', ''));
    expect(report.authoritative).toEqual({ available: false, error: 'Error: Session unavailable' });
    expect(report.browser).toEqual({ available: false, error: 'Error: Target closed' });
    expect(original.message).toContain('distance 13.6 exceeds 5');
  });

  it('distinguishes unavailable events, no live server and a page evaluation exception', async () => {
    const original = new Error('original');
    const emit = vi.fn();
    await reportHorrorFailure(original, {
      label: 'static: win route',
      page: { send: async () => ({ result: {}, exceptionDetails: { text: 'page has no aegis' } }) },
      emit,
    });
    const report = JSON.parse(emit.mock.calls[0]![0].replace('[horror-failure] ', ''));
    expect(report.authoritative).toEqual({
      available: false,
      reason: 'Static simulation is local to the browser.',
    });
    expect(report.browser.available).toBe(false);
    expect(report.browser.error).toContain('page has no aegis');
    expect(projectHorrorFailure({ snapshot: {} })).toMatchObject({
      mission: null,
      player: { health: null },
      events: { available: false, total: 0 },
    });
  });

  it('does not replace the original failure if its output sink fails', async () => {
    const original = new Error('original assertion');
    await reportHorrorFailure(original, {
      label: 'live',
      page: { send: async () => ({ result: { value: {} } }) },
      emit: () => {
        throw new Error('sink unavailable');
      },
    });
    expect(original.message).toContain('original assertion');
    expect(original.message).toContain('Diagnostic output failed: Error: sink unavailable');
  });

  it('keeps cleanup failure fatal on success but cannot overwrite an already reported mismatch', async () => {
    const close = vi.fn();
    const error = new Error('Navigation target closed');
    const page = {
      send: vi.fn(async () => {
        throw error;
      }),
      close,
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(closeHorrorPage(page, false)).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    await closeHorrorPage(page, true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[horror-failure] Page cleanup also failed:',
      'Error: Navigation target closed',
    );
  });
});

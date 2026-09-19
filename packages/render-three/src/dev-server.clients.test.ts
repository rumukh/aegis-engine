import { afterEach, describe, expect, it } from 'vitest';
import { fpsPlugin } from '@aegis/mode-fps';
import { parseInputScript, runScene } from '@aegis/harness';
import { BINDINGS } from './bindings.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import type { FrameResponse } from './protocol.js';
import { FPS_SCENE } from './testing/scenes.js';

let server: DevServer | undefined;
let now = 0;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
async function start() {
  now = 0;
  server = await startDevServer({
    port: 0,
    clock: () => now,
    games: [
      {
        id: 'test',
        title: 'Shared input fixture',
        blurb: '',
        objective: '',
        mode: 'fps',
        plugin: fpsPlugin,
        scene: FPS_SCENE,
        bindings: BINDINGS.fps,
        presentation: { manifest: { aegis: 'presentation/1' } },
      },
    ],
  });
  return server;
}
async function request(body: unknown): Promise<Response> {
  return fetch(`${server!.url}/api/test/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function frame(
  id: string,
  seq: number,
  claim = false,
  axes = {},
  generation: number | null = 0,
  extra = {},
): Promise<FrameResponse> {
  const result = await request({
    client: { id, claim, generation },
    input: { seq, axes, ...extra },
    presentationGeneration: generation,
  });
  expect(result.status).toBe(200);
  return result.json() as Promise<FrameResponse>;
}

describe('shared live host browser clients', () => {
  it('preserves the complete single-player trajectory with legacy or named input and a neutral observer', async () => {
    const script = 'axis Strafe 0.5 0..12\nlook 6 0 0..12\npress Jump @3';
    const parsed = parseInputScript(script);
    if (!parsed.ok || parsed.value === undefined) throw new Error('Invalid test input script');
    const frames = parsed.value.frames(24);
    const expected = await runScene(FPS_SCENE, { plugin: fpsPlugin, ticks: 24, input: script });
    for (const named of [false, true]) {
      const host = await start();
      await fetch(`${host.url}/api/test/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'pause' }),
      });
      const hashes: string[] = [];
      for (const [index, input] of frames.entries()) {
        const result = await request({
          input: {
            seq: index + 1,
            held: Object.keys(input.actions).filter((action) => input.actions[action]),
            pressed: input.pressed,
            released: input.released,
            axes: input.axes,
            look: input.look,
            pointer: input.pointer,
          },
          ...(named ? { client: { id: 'driver', claim: index === 0, generation: 0 } } : {}),
        });
        expect(result.status).toBe(200);
        await frame('neutral-observer', 1000 + index);
        const step = await fetch(`${host.url}/api/test/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'step' }),
        });
        const state = (await step.json()) as FrameResponse;
        hashes.push(state.hash!);
      }
      expect(hashes).toEqual(expected.tickHashes);
      await host.close();
      server = undefined;
    }
  });

  it('accepts a later page from seq1 and keeps old neutral/reset polls from cancelling movement or look', async () => {
    await start();
    await frame('old', 1057, false, {}, null);
    const claimed = await frame('new', 1, true, { Forward: 1 }, 0, { look: { dx: 5, dy: 0 } });
    expect(claimed.inputStatus).toMatchObject({ accepted: true, role: 'controlling', lastSeq: 1 });
    const before = claimed.snapshot.entities.find((entity) => entity.name === 'player')!.components[
      'Transform'
    ];
    now += 0.1;
    const observed = await frame('old', 1058, false, {}, 0, { reset: true });
    expect(observed.inputStatus).toMatchObject({ accepted: false, role: 'observing' });
    const player = observed.snapshot.entities.find((entity) => entity.name === 'player')!;
    expect(player.components['Transform']).not.toEqual(before);
    expect(player.components['LookState']).toMatchObject({ yawDeg: expect.closeTo(5, 12) });
    const released = await frame('new', 2, false, {});
    now += 0.1;
    const stopped = await frame('old', 1059);
    expect(
      stopped.snapshot.entities.find((entity) => entity.name === 'player')!.components['Transform'],
    ).toEqual(
      released.snapshot.entities.find((entity) => entity.name === 'player')!.components[
        'Transform'
      ],
    );
  });

  it('delivers event history to both pages, never drained by another observer', async () => {
    const host = await start();
    await frame('one', 1);
    await frame('two', 1);
    host.session('test')!.world.events.emit('fixture.sound', { source: 'player' });
    const first = await frame('one', 2);
    const second = await frame('two', 2);
    expect(first.events).toEqual(second.events);
    expect(first.events.map((event) => event.type)).toContain('fixture.sound');
    expect((await frame('one', 3)).events).toEqual([]);
    expect((await frame('two', 3)).events).toEqual([]);
  });

  it('rejects stale and cross-generation claims and preserves paused restart', async () => {
    const host = await start();
    await frame('one', 10, true, { Forward: 1 });
    expect((await frame('one', 9, true, { Forward: -1 })).inputStatus?.reason).toBe('stale');
    const post = (command: string) =>
      fetch(`${host.url}/api/test/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    await post('pause');
    await post('restart');
    const stale = await frame('one', 11, true, { Forward: 1 }, 0);
    expect(stale).toMatchObject({
      tick: 0,
      paused: true,
      generation: 1,
      inputStatus: { accepted: false, reason: 'generation' },
    });
    expect((await frame('one', 12, false, { Forward: 1 }, 1)).inputStatus?.role).toBe('observing');
    expect((await frame('one', 13, true, { Forward: 1 }, 1)).inputStatus?.accepted).toBe(true);
    expect(host.session('test')!.tick).toBe(0);
  });

  it('bounds page records and rejects invalid identities/sequences with explicit HTTP errors', async () => {
    await start();
    for (const body of [
      { client: { id: '../bad', claim: true, generation: 0 }, input: { seq: 1 } },
      { client: { id: 'ok', claim: true, generation: 0 }, input: { seq: null } },
      { client: { id: 'ok', claim: 'yes', generation: 0 }, input: { seq: 1 } },
      { input: { seq: 1.5 } },
      { input: null },
      { input: 'not a packet' },
    ]) {
      const result = await request(body);
      expect(result.status).toBe(400);
      expect(await result.json()).toHaveProperty('error');
    }
    for (let index = 0; index < 32; index++) await frame(`page-${index}`, 1);
    const rejected = await request({
      client: { id: 'overflow', claim: false, generation: 0 },
      input: { seq: 1 },
    });
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      error: expect.stringContaining('32 recent browser clients'),
    });
    now = 61;
    expect((await frame('fresh', 1, true)).inputStatus?.accepted).toBe(true);
  });
});

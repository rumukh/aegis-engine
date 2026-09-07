import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import { parseRecording, serializeRecording } from './replay.js';
import { replayRecording, runScene, verifyReplay } from './run.js';
import { fakeMode } from './testing/fake-mode.js';

const dir = mkdtempSync(join(tmpdir(), 'aegis-recording-rate-'));
const scenePath = join(dir, 'rate.scene.json');
const scene: SceneFile = {
  aegis: 'scene/1',
  name: 'rate',
  mode: 'platformer',
  seed: 'rate',
  entities: [
    {
      id: 'player',
      tags: ['Player'],
      components: { Transform: {}, Velocity: {} },
    },
  ],
};
writeFileSync(scenePath, JSON.stringify(scene));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const legacyDocument = {
  aegis: 'recording/1',
  scene: scenePath,
  seed: 'rate',
  ticks: 0,
  input: '',
  finalHash: '0000000000000000',
} as const;

describe('recording tick-rate contract', () => {
  it.each([30, 59.94, 120])(
    'records and reproduces the exact %s Hz run without an override',
    async (tickRate) => {
      const original = await runScene(scenePath, {
        plugin: fakeMode,
        ticks: 3,
        tickRate,
        input: 'hold Right 0..3',
      });
      expect(original.tickRate).toBe(tickRate);
      const recording = original.recording();
      expect(recording.tickRate).toBe(tickRate);
      const text = serializeRecording(recording);
      expect(Object.keys(JSON.parse(text))).toEqual([
        'aegis',
        'scene',
        'seed',
        'ticks',
        'tickRate',
        'input',
        'finalHash',
        'tickHashes',
      ]);
      const parsed = parseRecording(text);
      expect(parsed.tickRate).toBe(tickRate);
      expect(serializeRecording(parsed)).toBe(text);
      const replayed = await replayRecording(parsed, { plugin: fakeMode, ticks: 0 });
      expect(replayed.tickRate).toBe(tickRate);
      expect(
        replayed
          .query({ has: ['Player'] })
          .one()
          .get(Transform).position.x,
      ).toBeCloseTo((8 * 3) / tickRate, 12);
      expect(replayed.hash).toBe(original.hash);
      expect(replayed.tickHashes).toEqual(original.tickHashes);
      expect(verifyReplay(parsed, replayed).unverified).toEqual([]);
    },
  );

  it('reads old recordings at 60 Hz without inventing a rate pin in the file', async () => {
    const original = await runScene(scenePath, {
      plugin: fakeMode,
      ticks: 3,
      input: 'hold Right 0..3',
    });
    const legacy = { ...original.recording() };
    delete legacy.tickRate;
    const text = serializeRecording(legacy);
    expect(text).not.toContain('tickRate');
    const parsed = parseRecording(text);
    expect(parsed.tickRate).toBeUndefined();
    const replayed = await replayRecording(parsed, { plugin: fakeMode, ticks: 0 });
    expect(replayed.tickRate).toBe(60);
    expect(replayed.hash).toBe(original.hash);
    expect(verifyReplay(parsed, replayed).unverified.some((s) => s.includes('tick rate'))).toBe(
      true,
    );
  });

  it('retains an explicit rate override for legacy recordings that did not capture it', async () => {
    const original = await runScene(scenePath, {
      plugin: fakeMode,
      ticks: 3,
      tickRate: 30,
      input: 'hold Right 0..3',
    });
    const legacy = { ...original.recording() };
    delete legacy.tickRate;
    await expect(replayRecording(legacy, { plugin: fakeMode, ticks: 0 })).rejects.toThrow(
      'verification FAILED',
    );
    const replayed = await replayRecording(legacy, { plugin: fakeMode, ticks: 0, tickRate: 30 });
    expect(replayed.hash).toBe(original.hash);
  });

  it('checks the pinned rate even when different rates produce the same resting world', async () => {
    const original = await runScene(scene, { plugin: fakeMode, ticks: 0, tickRate: 30 });
    const different = await runScene(scene, { plugin: fakeMode, ticks: 0, tickRate: 60 });
    expect(different.hash).toBe(original.hash);
    const verification = verifyReplay(original.recording(), different);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('tick rate: recorded 30 Hz, replayed 60 Hz');
  });

  it.each([0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE])(
    'rejects invalid numeric rate %s at every recording boundary',
    async (tickRate) => {
      const invalid = { ...legacyDocument, tickRate };
      expect(() => serializeRecording(invalid)).toThrow(/tickRate/);
      expect(() => parseRecording(JSON.stringify(invalid))).toThrow(/tickRate/);
      await expect(
        replayRecording(invalid, { plugin: fakeMode, ticks: 0, tickRate: 60 }),
      ).rejects.toThrow(/tickRate/);
      let initialized = false;
      await expect(
        runScene(scene, {
          plugin: {
            ...fakeMode,
            init() {
              initialized = true;
            },
          },
          ticks: 0,
          tickRate,
        }),
      ).rejects.toThrow(/tickRate/);
      expect(initialized).toBe(false);
    },
  );

  it.each([null, '30', false, [], {}])('rejects a nonnumeric authored rate %j', (tickRate) => {
    expect(() => parseRecording(JSON.stringify({ ...legacyDocument, tickRate }))).toThrow(
      /tickRate/,
    );
  });
});

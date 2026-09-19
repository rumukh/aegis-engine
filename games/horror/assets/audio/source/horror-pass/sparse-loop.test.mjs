import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleSparseLoop, inspectQuiet } from './sparse-loop.mjs';

test('approved gesture samples retain timing and bounded gain inside real silence', () => {
  const source = Float32Array.from([0, 0.5, -0.25, 0]);
  const loop = assembleSparseLoop(source, 4, 12, [
    { startSeconds: 2, gain: 1 },
    { startSeconds: 7, gain: 0.5 },
  ]);
  assert.equal(loop.samples.length, 48);
  assert.deepEqual([...loop.samples.slice(8, 12)], [0, 0.5, -0.25, 0]);
  assert.deepEqual([...loop.samples.slice(28, 32)], [0, 0.25, -0.125, 0]);
  assert.deepEqual(loop.quiet, [
    { startFrame: 0, endFrame: 8 },
    { startFrame: 12, endFrame: 28 },
    { startFrame: 32, endFrame: 48 },
  ]);
  assert.equal(loop.quietFraction, 40 / 48);
  assert.ok(inspectQuiet(loop.samples, loop.quiet, 4).every((interval) => interval.peak === 0));
  assert.equal(loop.samples[0], 0);
  assert.equal(loop.samples.at(-1), 0);
});

test('too-close events, clipped tails and gain boosts fail rather than changing the edit', () => {
  const source = Float32Array.from([0, 0.5, -0.25, 0]);
  assert.throws(() =>
    assembleSparseLoop(source, 4, 12, [
      { startSeconds: 2, gain: 1 },
      { startSeconds: 4, gain: 1 },
    ]),
  );
  assert.throws(() =>
    assembleSparseLoop(source, 4, 12, [
      { startSeconds: 2, gain: 1 },
      { startSeconds: 10, gain: 1 },
    ]),
  );
  assert.throws(() =>
    assembleSparseLoop(source, 4, 12, [
      { startSeconds: 2, gain: 1.1 },
      { startSeconds: 7, gain: 1 },
    ]),
  );
});

test('codec silence inspection detects leaked audio independently of the recipe', () => {
  const samples = new Float32Array(48);
  samples[4] = 0.125;
  const quiet = inspectQuiet(samples, [{ startFrame: 0, endFrame: 12 }], 4);
  assert.equal(quiet[0].peak, 0.125);
});

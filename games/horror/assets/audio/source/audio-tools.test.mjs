import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossfadeLoop, fadeEdges, floatWav, assertSamples } from './audio-tools.mjs';

test('loop retains stereo channels and makes an actual wrap-continuous overlap', () => {
  const input = new Float32Array([1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8]);
  const output = crossfadeLoop(input, 2, 2);
  assert.deepEqual([...output], [3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 2, -2]);
  assert.equal(output[0] - output.at(-2), 1);
  assert.equal(output[1] - output.at(-1), -1);
});

test('overlap uses equal-power gains without a center dip', () => {
  const output = crossfadeLoop(Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1]), 1, 3);
  assert.equal(output.length, 5);
  assert.ok(Math.abs(output[3] - Math.sqrt(2)) < 0.000001);
});

test('invalid loop boundaries fail instead of silently truncating', () => {
  assert.throws(() => crossfadeLoop(new Float32Array(8), 1, 4));
  assert.throws(() => crossfadeLoop(new Float32Array(8), 1, 1));
  assert.throws(() => crossfadeLoop(new Float32Array(7), 2, 2));
});

test('one-shots have silent endpoints and preserved interior samples', () => {
  assert.deepEqual(
    [...fadeEdges(Float32Array.from([1, 1, 1, 1, 1, 1]), 1, 2, 2)],
    [0, 1, 1, 1, 1, 0],
  );
});

test('float WAV explicitly preserves lossless samples and format fields', () => {
  const buffer = floatWav(Float32Array.from([0.25, -0.125]), 1);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.readUInt16LE(20), 3);
  assert.equal(buffer.readUInt32LE(24), 48000);
  assert.equal(buffer.readFloatLE(44), 0.25);
  assert.equal(buffer.readFloatLE(48), -0.125);
});

test('silence and non-finite samples are rejected', () => {
  assert.throws(() => assertSamples(new Float32Array(4)));
  assert.throws(() => assertSamples(Float32Array.from([0.5, NaN])));
});

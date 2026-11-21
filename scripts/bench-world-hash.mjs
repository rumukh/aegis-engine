// Run from the repository root after building. No browser, timing threshold or fixture rewrite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { hashSnapshot, hashString } from '@aegis/core';
import { runScene } from '@aegis/harness';
import { nullMeridianPlugin } from '@aegis/game-horror';
import {
  assertMissionCompleted,
  GOLDEN_HASH,
  GOLDEN_TRAJECTORY,
} from '../games/horror/dist/null-meridian.gametest.js';

const { values } = parseArgs({ options: { 'full-check': { type: 'boolean' } } });
const scene = JSON.parse(readFileSync('games/horror/levels/null-meridian.scene.json', 'utf8'));
const input = readFileSync('games/horror/play/null-meridian.input', 'utf8');
const seed = 'null-meridian-1';
const full = values['full-check'] === true;
const ticks = full ? 8217 : 600;

async function measure(method, perTick) {
  let calls = 0;
  const plugin = {
    ...nullMeridianPlugin,
    init(world) {
      nullMeridianPlugin.init(world);
      const hash = method === 'before' ? () => hashSnapshot(world.snapshot()) : world.hash;
      world.hash = () => {
        calls++;
        return hash();
      };
    },
  };
  const start = performance.now();
  const result = await runScene(scene, {
    plugin,
    seed,
    input,
    ticks,
    tickRate: 60,
    captureTickHashes: perTick,
  });
  const ms = performance.now() - start;
  assert.equal(calls, perTick ? ticks + 1 : 1);
  assert.equal(result.tickHashes.length, perTick ? ticks : 0);
  if (full) {
    assertMissionCompleted(result);
    assert.equal(result.hash, GOLDEN_HASH);
    if (perTick) assert.equal(hashString(result.tickHashes.join('|')), GOLDEN_TRAJECTORY);
  }
  return { ms, final: result.hash, events: result.events.digest(), hashes: result.tickHashes };
}

const cases = [
  ['before', false],
  ['after', false],
  ['before', true],
  ['after', true],
];
const samples = cases.map(() => []);
let control, trajectory;
// Warm each arm with the same complete workload. Reverse order between measured rounds.
for (let round = full ? 0 : -1; round < (full ? 1 : 3); round++) {
  const order = round % 2 === 0 ? [0, 1, 2, 3] : [3, 2, 1, 0];
  for (const i of order) {
    const [method, perTick] = cases[i];
    const result = await measure(method, perTick);
    control ??= [result.final, result.events];
    assert.deepEqual([result.final, result.events], control);
    if (perTick) {
      trajectory ??= result.hashes;
      assert.deepEqual(result.hashes, trajectory); // every position, not just the last digest
    }
    if (round >= 0) samples[i].push(Number(result.ms.toFixed(2)));
  }
}
console.log(
  JSON.stringify(
    {
      workload: 'NULL MERIDIAN',
      seed,
      tickRate: 60,
      ticks,
      node: process.version,
      host: `${process.platform}/${process.arch} ${cpus()[0]?.model}`,
      warmupsPerCase: full ? 0 : 1,
      cases: cases.map(([method, perTick], i) => ({
        method,
        perTick,
        calls: perTick ? ticks + 1 : 1,
        ms: samples[i],
        medianMs: [...samples[i]].sort((a, b) => a - b)[Math.floor(samples[i].length / 2)],
      })),
      final: control[0],
      events: control[1],
      comparedTicks: trajectory.length,
      trajectory: hashString(trajectory.join('|')),
    },
    null,
    2,
  ),
);

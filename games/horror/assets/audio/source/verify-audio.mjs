import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';
import { sha256 } from './audio-tools.mjs';

const names = argv.slice(2);
const expectedCounts = { voices: 8, foley: 19, score: 3 };
assert.ok(names.length > 0 && names.every((name) => Object.hasOwn(expectedCounts, name)));
assert.equal(new Set(names).size, names.length);
const root = join(import.meta.dirname, '..');
const all = [];
let bytes = 0;
let decodedPcmBytes = 0;
for (const name of names) {
  const inventory = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
  assert.equal(inventory.cues.length, expectedCounts[name], `${name} cue count`);
  let subtotal = 0;
  for (const cue of inventory.cues) {
    assert.equal(await sha256(join(root, cue.url)), cue.sha256, cue.id);
    assert.equal(cue.measured.codec, 'opus', cue.id);
    assert.equal(cue.measured.sampleRate, 48000, cue.id);
    assert.ok(cue.durationSeconds > 0 && Number.isInteger(cue.frames), cue.id);
    assert.ok(cue.measured.truePeakDbtp <= -5, cue.id);
    assert.ok(cue.measured.integratedLufs !== null, cue.id);
    assert.equal(cue.frames / 48000, cue.durationSeconds, cue.id);
    if (cue.loop) {
      assert.equal(cue.loop.startSeconds, 0);
      assert.equal(cue.loop.endSeconds, cue.durationSeconds);
      assert.ok(cue.loop.offlineOverlapSeconds >= 2);
      assert.ok(cue.loop.decodedBoundaryStep < 0.01, `${cue.id} decoded loop edge`);
    }
    for (const binding of cue.bindings ?? []) {
      if (binding.spatial) assert.equal(cue.channels, 1, `${cue.id} must be mono for HRTF`);
      assert.ok(binding.maxVoices >= 1 && binding.maxVoices <= 3, cue.id);
    }
    if (cue.layer?.spatial) assert.equal(cue.channels, 1, cue.id);
    subtotal += (await stat(join(root, cue.url))).size;
    decodedPcmBytes += cue.frames * cue.channels * 4;
    all.push(cue);
  }
  assert.equal(subtotal, inventory.totalRuntimeBytes, `${name} bytes`);
  bytes += subtotal;
  if (name === 'voices') {
    assert.deepEqual(
      inventory.cues.map((cue) => cue.event),
      [
        'horror.arrived',
        'horror.bus.isolated',
        'horror.power.restored',
        'horror.triage.played',
        'horror.recorder.recovered',
        'horror.coolant.isolated',
        'horror.uplink.transmitted',
        'level.completed',
      ],
    );
    for (const cue of inventory.cues) {
      assert.equal(cue.voiceGroup, 'dialogue');
      assert.equal(cue.maxVoices, 1);
      assert.ok(cue.caption.text.length > 10);
      assert.ok(cue.measured.integratedLufs >= -23);
    }
  }
  if (name === 'foley') {
    const bindings = inventory.cues.flatMap((cue) => cue.bindings ?? []);
    for (const [event, variants] of [
      ['horror.player.step', [0, 1, 2, 3]],
      ['horror.threat.step', [0, 1, 2]],
    ]) {
      const matches = bindings.filter((binding) => binding.event === event);
      assert.equal(matches.length, variants.length, event);
      assert.deepEqual(
        matches.map((binding) => binding.when),
        variants.map((equals) => ({ field: 'variant', equals })),
        event,
      );
    }
  }
}
assert.equal(new Set(all.map((cue) => cue.id)).size, all.length, 'No duplicate global asset IDs');
assert.ok(bytes <= 12 * 1024 * 1024, 'Twelve MiB audio budget');
stdout.write(
  `${JSON.stringify(
    {
      verifiedSubsets: names,
      assets: all.length,
      runtimeBytes: bytes,
      decodedFloatPcmBytes: decodedPcmBytes,
      scope:
        'Exact saved-file integrity, bounds, loop metadata and event selection; no human listening or spatial gameplay claim.',
    },
    null,
    2,
  )}\n`,
);

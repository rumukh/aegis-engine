import { argv } from 'node:process';
import { writeFile } from 'node:fs/promises';
import { decode, SAMPLE_RATE, sha256 } from './audio-tools.mjs';

const [output, ...paths] = argv.slice(2);
if (!output || !paths.length)
  throw new Error('Usage: node inspect-events.mjs <report.json> <source.wav> ...');
const reports = [];
for (const path of paths) {
  const samples = decode(path, 1, ['highpass=f=70']);
  const width = Math.round(SAMPLE_RATE * 0.01);
  const bins = [];
  for (let start = 0; start < samples.length; start += width) {
    let energy = 0;
    const end = Math.min(samples.length, start + width);
    for (let i = start; i < end; i++) energy += samples[i] * samples[i];
    bins.push(Math.sqrt(energy / (end - start)));
  }
  const peakRms = Math.max(...bins);
  const threshold = peakRms * 0.15;
  const intervals = [];
  let start;
  let lastActive = -1;
  for (let i = 0; i <= bins.length + 25; i++) {
    if (i < bins.length && bins[i] >= threshold) {
      start ??= i;
      lastActive = i;
    } else if (start !== undefined && i - lastActive >= 25) {
      intervals.push({
        startSeconds: Math.max(0, start * 0.01 - 0.04),
        endSeconds: Math.min(samples.length / SAMPLE_RATE, lastActive * 0.01 + 0.2),
        activeSeconds: (lastActive - start + 1) * 0.01,
      });
      start = undefined;
    }
  }
  reports.push({
    path,
    sha256: await sha256(path),
    durationSeconds: samples.length / SAMPLE_RATE,
    peakWindowRms: peakRms,
    threshold,
    intervals,
    limitation:
      'Energy-guided cut candidates only. Not a semantic or human-listening quality verdict.',
  });
}
await writeFile(output, `${JSON.stringify(reports, null, 2)}\n`);

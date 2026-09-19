import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import {
  launchBrowser,
  openPage,
  evaluate,
} from '../../../../../../packages/render-three/dist/browser.js';
import { command, sha256 } from '../audio-tools.mjs';

const [url, directory, reportPath] = argv.slice(2);
if (!url || !directory || !reportPath) {
  throw new Error('Usage: node check-audition.mjs <loopback-url> <audition-dir> <report.json>');
}
const manifest = JSON.parse(await readFile(join(directory, 'audition.json'), 'utf8'));
const expected = [...manifest.cues, { id: 'context-38s', ...manifest.mix }];
assert.equal(expected.length, 4);
const browser = await launchBrowser({ viewport: { width: 640, height: 360 } });
let page;
try {
  page = await openPage(browser.port, url);
  const report = await evaluate(
    page,
    `(async () => {
    const context = new OfflineAudioContext(2,1,48000);
    const result = [];
    for (const id of ${JSON.stringify(expected.map((item) => item.id))}) {
      const response = await fetch('/media/'+id);
      if(!response.ok) throw new Error(id+': HTTP '+response.status);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256',bytes);
      const hash = [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
      const audio = await context.decodeAudioData(bytes);
      let peak=0;
      for(let channel=0;channel<audio.numberOfChannels;channel++){
        for(const value of audio.getChannelData(channel)){
          if(!Number.isFinite(value)) throw new Error(id+': nonfinite sample');
          peak=Math.max(peak,Math.abs(value));
        }
      }
      result.push({id,sha256:hash,channels:audio.numberOfChannels,frames:audio.length,sampleRate:audio.sampleRate,peak});
    }
    return {userAgent:navigator.userAgent,autoplayCount:document.querySelectorAll('audio[autoplay]').length,controlCount:document.querySelectorAll('audio[controls]').length,result};
  })()`,
  );
  assert.equal(report.autoplayCount, 0);
  assert.equal(report.controlCount, 4);
  assert.equal(report.result.length, 4);
  for (const actual of report.result) {
    const item = expected.find((candidate) => candidate.id === actual.id);
    assert.equal(actual.sha256, item.sha256, item.id);
    assert.equal(await sha256(join(directory, item.file)), item.sha256, item.id);
    assert.equal(actual.channels, item.channels, item.id);
    assert.equal(actual.frames, item.frames, item.id);
    assert.equal(actual.sampleRate, 48000, item.id);
    assert.ok(actual.peak > 0.0001 && actual.peak < 0.5, item.id);
  }
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        decision: 'PASS',
        scope:
          'Exact audition bytes decoded with Chromium WebAudio; four native controls and no autoplay. Not aesthetic, HRTF or gameplay acceptance.',
        ...report,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  page?.close();
  if (browser.process.exitCode === null && browser.process.signalCode === null) {
    command('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${browser.process.pid} -Force -ErrorAction Stop; Wait-Process -Id ${browser.process.pid} -Timeout 20 -ErrorAction SilentlyContinue`,
    ]);
  }
  await rm(browser.profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}

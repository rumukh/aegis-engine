import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv, platform } from 'node:process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  launchBrowser,
  openPage,
  evaluate,
} from '../../../../../packages/render-three/dist/browser.js';
import { sha256, command } from './audio-tools.mjs';

const [reportPath, ...inventories] = argv.slice(2);
if (!reportPath || !inventories.length) {
  throw new Error('Usage: node check-browser-audio.mjs <report.json> <inventory.json> ...');
}
const root = resolve(import.meta.dirname, '..');
const cues = [];
for (const path of inventories) {
  const inventory = JSON.parse(await readFile(path, 'utf8'));
  cues.push(...inventory.cues);
}
assert.ok(cues.length > 0, 'No audio was supplied for decoding');
assert.equal(new Set(cues.map((cue) => cue.id)).size, cues.length, 'Duplicate cue IDs');
for (const cue of cues) assert.equal(await sha256(join(root, cue.url)), cue.sha256, cue.id);
const failures = [];
const server = createServer(async (request, response) => {
  try {
    const cue = cues.find((candidate) => request.url === `/audio/${candidate.id}`);
    if (request.url === '/') {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!doctype html><title>Audio decoding QA</title>');
    } else if (cue) {
      response
        .writeHead(200, { 'Content-Type': 'audio/ogg' })
        .end(await readFile(join(root, cue.url)));
    } else {
      response.writeHead(404).end('Not found');
    }
  } catch (error) {
    failures.push(String(error));
    response.writeHead(500).end('Audio unavailable');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
let page;
try {
  browser = await launchBrowser({ viewport: { width: 640, height: 360 } });
  page = await openPage(browser.port, `http://127.0.0.1:${server.address().port}/`);
  const results = await evaluate(
    page,
    `(async () => {
    const context = new OfflineAudioContext(2, 1, 48000);
    const results = [];
    for (const cue of ${JSON.stringify(cues.map(({ id }) => ({ id })))}) {
      const response = await fetch('/audio/' + cue.id);
      if (!response.ok) throw new Error(cue.id + ': HTTP ' + response.status);
      const encoded = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      const buffer = await context.decodeAudioData(encoded);
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (const value of samples) {
          if (!Number.isFinite(value)) throw new Error(cue.id + ': nonfinite PCM');
          peak = Math.max(peak, Math.abs(value));
        }
      }
      results.push({id:cue.id, sha256, frames:buffer.length, sampleRate:buffer.sampleRate,
        channels:buffer.numberOfChannels, durationSeconds:buffer.duration, peak});
    }
    return {userAgent:navigator.userAgent, results};
  })()`,
  );
  assert.deepEqual(failures, []);
  assert.equal(results.results.length, cues.length);
  for (const result of results.results) {
    const cue = cues.find((candidate) => candidate.id === result.id);
    assert.equal(result.sha256, cue.sha256, `${result.id} fetched bytes`);
    assert.equal(result.channels, cue.channels, result.id);
    assert.equal(result.sampleRate, 48000, result.id);
    assert.ok(Math.abs(result.frames - cue.frames) <= 2, `${result.id} decoded frame count`);
    assert.ok(result.peak > 0.00001 && result.peak < 0.75, `${result.id} audibility/peak`);
  }
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        scope: 'Actual shipped Chromium WebAudio decode; no playback or human-listening claim',
        inventoryCount: inventories.length,
        assetCount: cues.length,
        decision: 'PASS',
        ...results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  page?.close();
  if (browser) {
    if (browser.process.exitCode === null && browser.process.signalCode === null) {
      const ended = once(browser.process, 'exit');
      if (platform === 'win32') {
        command('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Stop-Process -Id ${browser.process.pid} -Force -ErrorAction Stop`,
        ]);
      } else {
        browser.process.kill('SIGKILL');
      }
      await Promise.race([
        ended,
        delay(30000, undefined, { ref: false }).then(() => {
          throw new Error(`Owned audio QA browser ${browser.process.pid} did not exit`);
        }),
      ]);
    }
    await rm(browser.profile, { recursive: true });
  }
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}

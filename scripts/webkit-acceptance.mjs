#!/usr/bin/env node
/**
 * Optional WebKit acceptance for spec section 23 (ANIM-01, AUDIO-07, UI-10, OFFLINE-04).
 *
 * WebKit is not a repository dependency and this script is not part of `npm run verify`.
 * Install Playwright's WebKit outside the repository and point this script at it:
 *
 *   mkdir %TEMP%\aegis-webkit && cd %TEMP%\aegis-webkit && npm init -y && npm install playwright-core@1.63.0
 *   npx playwright-core install webkit
 *   set AEGIS_PLAYWRIGHT_CORE=%TEMP%\aegis-webkit\node_modules\playwright-core
 *   npm run build && node scripts/webkit-acceptance.mjs --out webkit-acceptance.json
 *
 * Each scenario reports passed/failed with its measurements; nothing is skipped silently. This is
 * Playwright's WebKit build on the host OS, not Safari on iPadOS: physical-device acceptance stays
 * with the consumer (spec 17, "Browser/device scope").
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { RAMP_RATE, RAMP_SECONDS, startStageSite } from './stage-acceptance-site.mjs';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const modulePath = process.env.AEGIS_PLAYWRIGHT_CORE;
if (!modulePath) {
  console.error('Set AEGIS_PLAYWRIGHT_CORE to an installed playwright-core directory.');
  process.exit(64);
}
const { webkit } = await import(pathToFileURL(join(modulePath, 'index.mjs')).href);

const site = await startStageSite();
const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
const page = await context.newPage();
const results = [];
const run = async (name, body, check, requires) => {
  const started = Date.now();
  if (requires && !environment[requires]) {
    results.push({
      name,
      passed: false,
      exercised: false,
      problem: `not exercised: this WebKit build has no ${requires}`,
    });
    console.log(`NOT EXERCISED ${name} (no ${requires})`);
    return;
  }
  try {
    const value = await body();
    const problem = check(value);
    results.push({
      name,
      passed: !problem,
      ...(problem ? { problem } : {}),
      value,
      ms: Date.now() - started,
    });
  } catch (error) {
    results.push({
      name,
      passed: false,
      problem: String(error?.message ?? error).slice(0, 2000),
      ms: Date.now() - started,
    });
  }
  const last = results.at(-1);
  console.log(
    `${last.passed ? 'PASS' : 'FAIL'} ${name}${last.problem ? ` — ${last.problem}` : ''}`,
  );
};
const evaluate = (body) => page.evaluate(`(async () => { ${body} })()`);

await page.goto(`${site.origin}${site.base}`);
await page.waitForFunction('globalThis.ready === true');
const environment = await evaluate(`
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return { userAgent: navigator.userAgent, webgl: !!gl, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
    webAudio: typeof AudioContext === 'function', audioWorklet: typeof AudioWorkletNode === 'function',
    outputTimestamp: typeof AudioContext === 'function' && typeof AudioContext.prototype.getOutputTimestamp === 'function',
    serviceWorker: 'serviceWorker' in navigator, indexedDB: typeof indexedDB === 'object' };
`);
console.log(JSON.stringify(environment));

await run(
  'F02 runtime avatar composition, tint and badge anchor',
  () =>
    evaluate(`
    const stage = await newStage({ autoStart: false });
    const failures = []; let count = 0;
    for (const species of ['fox', 'cat', 'rabbit', 'bear', 'hedgehog']) for (const color of ['#c8553d', '#2f6fb3', '#e2b33b']) {
      const p = stage.puppet({ id: 'p', rig: 'avatar.' + species, at: { x: 1280, y: 1450 }, tints: { scarf: color },
        accessories: [{ slot: 'scarf', rig: 'acc.scarf.long' }, { slot: 'hat', rig: 'acc.hat.cap' }, { anchor: 'badge', rig: 'acc.badge' }] });
      stage.renderFrame(0);
      const m = p.model.pose(stage.now()).find((i) => i.id.endsWith('/scarf.wrap')).matrix;
      const [px, badge] = pixels(stage, [{ x: m[0] * 125 + m[2] * 20 + m[4], y: m[1] * 125 + m[3] * 20 + m[5] }, p.model.anchorAt('badge', stage.now())]);
      const want = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) * (0xe8 / 255));
      if (!want.every((v, i) => Math.abs(v - px[i]) <= 26)) failures.push(species + color + ' scarf ' + px);
      if (![0xf5, 0xc5, 0x18].every((v, i) => Math.abs(v - badge[i]) <= 30)) failures.push(species + color + ' badge ' + badge);
      p.remove(); count++;
    }
    const renderer = stage.renderer; await stage.dispose();
    return { count, renderer, failures };
  `),
  (v) => (v.failures.length ? v.failures.join('; ') : v.count !== 15 ? 'wrong count' : undefined),
);

await run(
  'F01 four puppets, effects and 2560x1600 background (unthrottled; WebKit has no CPU throttling)',
  () =>
    evaluate(`
    const stage = await newStage();
    const puppets = ['fox', 'cat', 'rabbit', 'bear'].map((s, i) => stage.puppet({ rig: 'avatar.' + s, at: { x: 520 + i * 520, y: 1450 },
      tints: { scarf: '#2f6fb3' }, accessories: [{ slot: 'scarf', rig: 'acc.scarf.long' }, { slot: 'hat', rig: 'acc.hat.beret' }],
      behaviours: { breathe: {}, blink: { seed: s } } }));
    for (const p of puppets) p.play('sway', { layer: 'idle', loop: true });
    const timer = setInterval(() => { for (const p of puppets) p.play('wave'); stage.effect('sparkles', { x: 1280, y: 700 }, 1.5); }, 700);
    await new Promise((r) => setTimeout(r, 1000));
    const times = [];
    await new Promise((resolve) => { const step = (t) => { times.push(t); if (t - times[0] < 5000) requestAnimationFrame(step); else resolve(); }; requestAnimationFrame(step); });
    clearInterval(timer);
    const intervals = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    const stats = stage.stats(); await stage.dispose();
    return { fps: (times.length - 1) / ((times.at(-1) - times[0]) / 1000), p95: intervals[Math.floor(intervals.length * 0.95)], renderer: stats.renderer, frameMs: stats.frameMs };
  `),
  (v) => (v.fps >= 30 ? undefined : `fps ${v.fps.toFixed(1)} below the 30 fps floor`),
);

await run(
  'AUDIO-07/F03/F09 audio unlock and narration clock drift against rendered samples',
  async () => {
    await evaluate(`
      globalThis.reports = [];
      globalThis.audioContext = new AudioContext({ sampleRate: ${RAMP_RATE} });
      await audioContext.audioWorklet.addModule('tap.js');
      const tap = new AudioWorkletNode(audioContext, 'tap');
      tap.port.onmessage = (e) => { reports.push(e.data); if (reports.length > 4000) reports.splice(0, 2000); };
      const sink = audioContext.createGain(); sink.gain.value = 0; tap.connect(sink); sink.connect(audioContext.destination);
      const create = audioContext.createGain.bind(audioContext); let tapped = false;
      audioContext.createGain = () => { const node = create(); if (!tapped) { tapped = true; node.connect(tap); } return node; };
      globalThis.events = [];
      globalThis.narration = createNarration({ baseUrl: location.href, onState: () => {}, contextFactory: () => audioContext });
      narration.registerPack({ id: 'voice', revision: '1', assets: [{ id: 'ramp', src: 'assets/ramp.wav' }], lines: [{ id: 'ramp', asset: 'ramp', caption: 'x' }] });
      narration.subscribe((e) => events.push(e.type + (e.reason ? ':' + e.reason : '')));
      document.querySelector('#unlock').onclick = () => narration.unlock().catch((e) => { globalThis.unlockError = String(e); });
      globalThis.drift = []; globalThis.sampling = true;
      const truth = () => {
        const stamp = audioContext.getOutputTimestamp ? audioContext.getOutputTimestamp() : {};
        const audible = stamp.contextTime ? stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000
          : audioContext.currentTime - (audioContext.outputLatency || audioContext.baseLatency || 0);
        let best; for (let i = reports.length - 1; i >= 0; i--) if (reports[i].frame / ${RAMP_RATE} <= audible) { best = reports[i]; break; }
        if (!best || best.value < 0.002 || audible - best.frame / ${RAMP_RATE} > 0.1) return undefined;
        return (best.value / 0.9) * ${RAMP_SECONDS} + (audible - best.frame / ${RAMP_RATE});
      };
      const sample = () => { if (!sampling) return; const c = narration.clock();
        if (c.status === 'playing' && c.position > 0.08 && c.position < ${RAMP_SECONDS} - 0.08) { const t = truth(); if (t !== undefined) drift.push(c.position - t); }
        requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
    `);
    await page.click('#unlock');
    await page.waitForFunction("narration.context().state === 'running'", null, {
      timeout: 10_000,
    });
    await evaluate(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await narration.playLine('voice', 'ramp'); await wait(900);
      narration.pause(); await wait(300); await narration.resume(); await wait(700);
      await narration.replay(); await wait(700);
    `);
    await evaluate(`await audioContext.suspend(); await new Promise((r) => setTimeout(r, 300));`);
    await page.click('#unlock');
    await page.waitForFunction("narration.clock().status === 'completed'", null, {
      timeout: 20_000,
    });
    return evaluate(`sampling = false; const abs = drift.map(Math.abs);
      return { samples: drift.length, max: Math.max(...abs), events, latency: audioContext.outputLatency ?? audioContext.baseLatency };`);
  },
  (v) =>
    v.samples < 30
      ? `only ${v.samples} samples`
      : v.max > 0.05
        ? `max drift ${(v.max * 1000).toFixed(1)} ms`
        : undefined,
  'audioWorklet',
);

await run(
  'F06 comfort grade and reduced-motion camera cut',
  () =>
    evaluate(`
    const stage = await newStage({ autoStart: false, reducedMotion: true });
    stage.renderFrame(0); const plain = luminance(stage); stage.setComfort(true); stage.renderFrame(0); const warm = luminance(stage);
    const pan = stage.setCamera({ x: 900, y: 900, zoom: 1.6 }, { duration: 2 }); await stage.dispose();
    return { plain, warm, pan };
  `),
  (v) => (v.warm > v.plain + 0.02 && v.pan === 0 ? undefined : JSON.stringify(v)),
);

await run(
  'F08 owned memory over 20 scene transitions',
  () =>
    evaluate(`
    const stage = createStage({ host: document.querySelector('#host'), baseUrl: location.href, resolve: resolveAsset, autoStart: false });
    for (let i = 0; i < 20; i++) {
      const loaded = await stage.load({ documents: DOCUMENTS, images: ['bg.office.png'] });
      if (!loaded.ok) throw new Error('load ' + i + ': ' + JSON.stringify(loaded.diagnostics.slice(0, 3)));
      stage.puppet({ rig: 'avatar.fox', at: { x: 1000, y: 1450 } }); stage.renderFrame(0.016); stage.clearScene();
      stage.release({ atlases: DOCUMENTS.filter((d) => d.endsWith('.atlas')), images: ['bg.office.png'],
        rigs: DOCUMENTS.filter((d) => !d.endsWith('.atlas')), clips: DOCUMENTS.filter((d) => !d.endsWith('.atlas')) });
    }
    const end = stage.stats(); await stage.dispose();
    return { owned: end.ownedBytes, textures: end.textures, listeners: end.listeners };
  `),
  (v) => (v.owned === 0 && v.textures === 0 ? undefined : JSON.stringify(v)),
);

await run(
  'Issue #14 zero-specificity preset and reduced motion from <html>',
  () =>
    evaluate(`
    const style = document.createElement('style');
    style.textContent = ui.CHILD_SAFE_CSS + '.small { min-height: 30px; } @keyframes spin { to { transform: rotate(1turn); } } .spin { animation: spin 1s infinite; }';
    document.head.append(style);
    const root = document.createElement('div'); root.className = 'aegis-child';
    const plain = document.createElement('button'); const small = document.createElement('button'); small.className = 'small';
    const spinner = document.createElement('div'); spinner.className = 'spin'; root.append(plain, small, spinner); document.body.append(root);
    document.documentElement.dataset.reducedMotion = 'true';
    const out = { plain: getComputedStyle(plain).minHeight, small: getComputedStyle(small).minHeight, animation: getComputedStyle(spinner).animationName };
    root.remove(); style.remove(); delete document.documentElement.dataset.reducedMotion; return out;
  `),
  (v) =>
    v.plain === '48px' && v.small === '30px' && v.animation === 'none'
      ? undefined
      : JSON.stringify(v),
);

await run(
  'UI-10 IndexedDB compare-and-swap and profile registry',
  () =>
    evaluate(`
    const storage = new IndexedDbSaveStorage('webkit-acceptance-' + Date.now());
    const registry = save.createProfileRegistry({ storage, gameId: 'fluffy', limit: 4 });
    for (const name of ['Маша', 'Петя', 'Аня', 'Гость']) await registry.create({ name });
    let limit = false; try { await registry.create({ name: 'x' }); } catch (e) { limit = e.code === 'limit'; }
    const key = registry.saveKeyFor('profile-2');
    await storage.compareAndSwap(key, 0, { revision: 1, payload: '{}' });
    let conflict = false; try { await storage.compareAndSwap(key, 0, { revision: 1, payload: '{}' }); } catch (e) { conflict = e.code === 'conflict'; }
    await registry.remove('profile-4', { confirm: 'profile-4' });
    const names = (await registry.list()).profiles.map((p) => p.name); await storage.close?.();
    return { limit, conflict, names };
  `),
  (v) =>
    v.limit && v.conflict && v.names.join() === 'Маша,Петя,Аня' ? undefined : JSON.stringify(v),
);

await run(
  'OFFLINE-04/UI-10 service worker serves an installed pack after an offline reload',
  async () => {
    const offline = await context.newPage();
    try {
      await offline.goto(`${site.origin}${site.base}offline.html`);
      await offline.waitForFunction('globalThis.ready === true');
      const installed = await offline.evaluate(`installOffline(${JSON.stringify(site.manifest)})`);
      site.setOffline(true);
      await offline.reload();
      await offline.waitForFunction(
        "document.querySelector('#state')?.textContent === 'served'",
        null,
        { timeout: 30_000 },
      );
      return { fits: installed.plan.fits, requiredBytes: installed.plan.requiredBytes };
    } finally {
      site.setOffline(false);
      await offline.close();
    }
  },
  () => undefined,
  'serviceWorker',
);

await browser.close();
await site.close();
const report = {
  format: 'aegis-webkit-acceptance/1',
  date: new Date().toISOString(),
  environment,
  results,
};
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const failed = results.filter((r) => !r.passed && r.exercised !== false).length;
const skipped = results.filter((r) => r.exercised === false).length;
console.log(
  `-- ${String(results.length - failed - skipped)} passed, ${String(failed)} failed, ${String(skipped)} not exercised (${environment.userAgent})`,
);
process.exit(failed ? 1 : 0);

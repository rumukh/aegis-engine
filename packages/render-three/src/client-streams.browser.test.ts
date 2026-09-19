import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fpsPlugin } from '@aegis/mode-fps';
import { BINDINGS } from './bindings.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import {
  click,
  evaluate,
  key,
  launchBrowser,
  mouseMove,
  openPage,
  stopExternalLagWitness,
  until,
} from './browser.js';
import type { CdpSession, LaunchedBrowser } from './browser.js';
import { navigateAndWait } from './browser-navigation.js';
import { closeOwnedBrowser } from './testing/browser-lifecycle.js';
import { FPS_SCENE } from './testing/scenes.js';
import { writePresentationFixture } from './testing/presentation-fixture.js';

const viewport = { width: 640, height: 360 };
let server: DevServer;
let root: string;
const owned: LaunchedBrowser[] = [];
const pages: CdpSession[] = [];
const read = `(()=>{
  const a=aegis,p=a.world.snapshot().entities.find(e=>e.name==='player').components;
  return {tick:a.tick(),position:p.Transform.position,look:p.LookState,
    input:a.presentation().input,focused:document.hasFocus(),locked:document.pointerLockElement?.id,
    trustedKeys:globalThis.__streamProbe.keys,starts:globalThis.__streamProbe.starts,
    packets:globalThis.__streamProbe.packets};
})()`;
type Seen = {
  tick: number;
  position: { x: number; y: number; z: number };
  look: { yawDeg: number; pitchDeg: number };
  input: { transport: { role: string; lastSeq: number }; capture: { pointer: string } };
  focused: boolean;
  locked?: string;
  trustedKeys: { code: string; trusted: boolean; target: string }[];
  starts: number;
  packets: { input: { seq: number }; client: { id: string; claim: boolean } }[];
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aegis-client-streams-'));
  const fixture = writePresentationFixture(root);
  server = await startDevServer({
    port: 0,
    games: [
      {
        id: 'streams',
        title: 'Shared input streams',
        blurb: '',
        objective: 'One controller, independent viewers.',
        mode: 'fps',
        plugin: fpsPlugin,
        scene: FPS_SCENE,
        bindings: BINDINGS.fps,
        presentation: {
          ...fixture,
          manifest: {
            aegis: 'presentation/1',
            assets: fixture.manifest.assets,
            audio: { cues: [{ event: 'stream.cue', asset: 'tone' }] },
          },
        },
      },
    ],
  });
});
afterAll(async () => {
  for (const page of pages) {
    try {
      await page.send('Page.navigate', { url: 'about:blank' });
    } finally {
      page.close();
    }
  }
  try {
    for (const browser of owned) {
      await closeOwnedBrowser(browser);
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    await server?.close();
    stopExternalLagWitness();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

async function open(): Promise<CdpSession> {
  const browser = await launchBrowser({ viewport });
  owned.push(browser);
  const page = await openPage(browser.port, 'about:blank', viewport);
  pages.push(page);
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    globalThis.__streamProbe={keys:[],packets:[],starts:0};
    window.addEventListener('keydown',e=>__streamProbe.keys.push({code:e.code,trusted:e.isTrusted,target:e.target.tagName}),true);
    const original=globalThis.fetch;
    globalThis.fetch=function(url,options){
      if(String(url).endsWith('/frame')&&options?.body){__streamProbe.packets.push(JSON.parse(options.body));if(__streamProbe.packets.length>20)__streamProbe.packets.shift();}
      return original.call(this,url,options);
    };
    const start=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(...args){__streamProbe.starts++;return start.apply(this,args)};
  `,
  });
  await navigateAndWait(page, () =>
    page.send('Page.navigate', { url: `${server.url}/play/streams/` }),
  );
  await until(page, 'globalThis.aegis?.presentation().status', (status) => status === 'ready');
  return page;
}
async function frames(page: CdpSession, count = 4): Promise<void> {
  await evaluate(
    page,
    `new Promise(r=>{let left=${count};function f(){if(--left<=0)r(null);else requestAnimationFrame(f)}requestAnimationFrame(f)})`,
  );
}

describe('independent browser streams on one live session', () => {
  it('accepts the newer trusted page, ignores old neutral/held polls and delivers cues to both viewers', async () => {
    const older = await open();
    await until<number>(older, 'aegis.presentation().input.transport.lastSeq', (seq) => seq > 40);
    const newer = await open();
    const before = await evaluate<Seen>(newer, read);
    const oldAtOpen = await evaluate<Seen>(older, read);
    expect(oldAtOpen.input.transport.lastSeq).toBeGreaterThan(before.input.transport.lastSeq);
    expect(oldAtOpen.packets.at(-1)?.client.id).not.toBe(before.packets.at(-1)?.client.id);
    await click(newer, 460, 220);
    await until(newer, 'document.pointerLockElement?.id', (id) => id === 'stage');
    await until(newer, 'aegis.presentation().audio.status', (status) => status === 'ready');
    await key(newer, 'KeyW', true);
    await mouseMove(newer, 500, 220);
    const moving = await until<Seen>(
      newer,
      read,
      (state) => state.position.z > before.position.z + 0.15 && Math.abs(state.look.yawDeg) > 1,
    );
    expect(moving.input.transport.role).toBe('controlling');
    expect(moving.focused).toBe(true);
    expect(
      moving.trustedKeys.some(
        (event) => event.code === 'KeyW' && event.trusted && event.target === 'CANVAS',
      ),
    ).toBe(true);
    expect((await evaluate<Seen>(older, read)).input.transport.role).toBe('observing');
    await frames(newer);
    expect((await evaluate<Seen>(newer, read)).input.transport.role).toBe('controlling');

    await click(older, 460, 220);
    await until(older, 'aegis.presentation().audio.status', (status) => status === 'ready');
    await key(older, 'KeyD', true);
    await until<Seen>(older, read, (state) => state.input.transport.role === 'controlling');
    // The newer page is still sending held W levels, but no new W press may reclaim control.
    await frames(newer, 8);
    expect((await evaluate<Seen>(newer, read)).input.transport.role).toBe('observing');
    await key(newer, 'KeyW', false);
    await frames(older);
    expect((await evaluate<Seen>(older, read)).input.transport.role).toBe('controlling');
    await key(older, 'KeyD', false);
    await evaluate(older, 'aegis.sync().then(()=>null)');
    await frames(older);
    const stopped = await evaluate<Seen>(older, read);
    await frames(newer, 8);
    const still = await evaluate<Seen>(older, read);
    expect(still.position.x).toBeCloseTo(stopped.position.x, 10);
    expect(still.position.z).toBeCloseTo(stopped.position.z, 10);

    const oldStarts = (await evaluate<Seen>(older, read)).starts;
    const newStarts = (await evaluate<Seen>(newer, read)).starts;
    server.session('streams')!.world.events.emit('stream.cue', {});
    await until<Seen>(older, read, (state) => state.starts === oldStarts + 1);
    await until<Seen>(newer, read, (state) => state.starts === newStarts + 1);

    const tickBeforeReload = await evaluate<number>(newer, 'aegis.tick()');
    await navigateAndWait(newer, () => newer.send('Page.reload', { ignoreCache: true }));
    await until(newer, 'aegis?.presentation().status', (status) => status === 'ready');
    expect(await evaluate<number>(newer, 'aegis.tick()')).toBeGreaterThanOrEqual(tickBeforeReload);
    await click(newer, 460, 220);
    await key(newer, 'KeyA', true);
    await until<Seen>(newer, read, (state) => state.input.transport.role === 'controlling');
    await key(newer, 'KeyA', false);
    expect(older.diagnostics).toEqual([]);
    expect(newer.diagnostics).toEqual([]);
  }, 180_000);

  it('shows a pointer-lock denial without swallowing it or stealing controls through UI focus', async () => {
    const page = await open();
    await evaluate(
      page,
      `document.getElementById('stage').requestPointerLock=()=>Promise.reject(new DOMException('Controlled host denial','NotSupportedError'))`,
    );
    await click(page, 460, 220);
    await until(
      page,
      'aegis.presentation().input.capture.pointer',
      (status) => status === 'denied',
    );
    expect(await evaluate(page, "document.getElementById('hud-input').checkVisibility()")).toBe(
      true,
    );
    expect(await evaluate(page, "document.getElementById('hud-input').textContent")).toMatch(
      /Controlled host denial/,
    );
    expect(await evaluate(page, 'document.pointerLockElement')).toBeNull();
    const state = await evaluate<Seen>(page, read);
    const button = await evaluate<{ x: number; y: number }>(
      page,
      "(()=>{const r=document.getElementById('action-mute').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await click(page, button.x, button.y);
    await key(page, 'KeyW', true);
    await frames(page);
    await key(page, 'KeyW', false);
    expect((await evaluate<Seen>(page, read)).position).toEqual(state.position);
    expect(page.diagnostics).toEqual([]);
  }, 120_000);
});

import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Health } from '@aegis/content';
import { fpsPlugin } from '@aegis/mode-fps';
import type { ModePlugin } from '@aegis/harness';
import { BINDINGS } from './bindings.js';
import { findRepoRoot } from './catalog.js';
import { startDevServer } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { exportStaticSite } from './static-site.js';
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
import { virtualGamepad } from './testing/gamepad.js';
import type { PresentationManifest } from './presentation/schema.js';

const viewport = { width: 800, height: 450 };
const bindings = {
  ...BINDINGS.fps,
  actions: [
    ...BINDINGS.fps.actions,
    { code: 'KeyL', action: 'Lose' },
    { code: 'KeyV', action: 'Win' },
  ],
};
const plugin: ModePlugin = {
  ...fpsPlugin,
  systems: () =>
    fpsPlugin.systems().add({
      name: 'fixture.outcome',
      phase: 'postUpdate',
      run({ world, input }): void {
        const player = world.query({ has: ['FpsController', Health] }).one();
        if (input.pressed.includes('Lose') && player.get(Health).current > 0) {
          player.get(Health).current = 0;
          world.events.emit('fixture.lost', { actor: player.entity });
        }
        if (input.pressed.includes('Win')) world.events.emit('fixture.won', {});
      },
    }),
};
const manifest: PresentationManifest = {
  aegis: 'presentation/1',
  hud: { playerName: 'player', winEvent: 'fixture.won', loseEvents: ['fixture.lost'] },
  ui: {
    lossEnding: {
      title: 'YOU WERE CAUGHT',
      message: 'Restart at the docking airlock.',
      fadeSeconds: 1,
    },
  },
};
let directory: string;
let dev: DevServer;
let files: Server;
let staticUrl: string;
let browser: LaunchedBrowser;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aegis-loss-ending-'));
  const module = join(directory, 'plugin.mjs');
  writeFileSync(
    module,
    `import {Health} from '@aegis/content';import{fpsPlugin}from'@aegis/mode-fps';
    export const plugin={...fpsPlugin,systems:()=>fpsPlugin.systems().add({
      name:'fixture.outcome',phase:'postUpdate',run({world,input}){
        const player=world.query({has:['FpsController',Health]}).one();
        if(input.pressed.includes('Lose')&&player.get(Health).current>0){
          player.get(Health).current=0;world.events.emit('fixture.lost',{actor:player.entity});
        }
        if(input.pressed.includes('Win'))world.events.emit('fixture.won',{});
      }
    })};`,
  );
  const game = {
    id: 'ending',
    title: 'Loss ending fixture',
    blurb: '',
    objective: 'Authoritative outcome fixture',
    mode: 'fps' as const,
    plugin,
    scene: FPS_SCENE,
    bindings,
    presentation: { manifest },
  };
  dev = await startDevServer({ games: [game], port: 0 });
  const out = join(directory, 'site');
  exportStaticSite({
    games: [
      {
        ...game,
        sceneText: JSON.stringify(FPS_SCENE),
        pluginModule: '@aegis/ending-fixture',
        pluginExport: 'plugin',
      },
    ],
    modules: [
      {
        specifier: '@aegis/ending-fixture',
        name: '@aegis/ending-fixture',
        root: directory,
        entry: module,
      },
    ],
    outDir: out,
    repoRoot: findRepoRoot(),
  });
  files = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);
    const target = resolve(out, `.${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`);
    if (!target.startsWith(out + sep)) {
      response.writeHead(403).end();
      return;
    }
    let exists = false;
    try {
      exists = statSync(target).isFile();
    } catch {
      /* Explicit 404 below. */
    }
    if (!exists) {
      response.writeHead(404).end();
      return;
    }
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.json': 'application/json',
    };
    response.writeHead(200, {
      'content-type': types[extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(response);
  });
  await new Promise<void>((done) => files.listen(0, '127.0.0.1', done));
  const address = files.address();
  if (address === null || typeof address === 'string') throw new Error('Missing static port');
  staticUrl = `http://127.0.0.1:${address.port}`;
  browser = await launchBrowser({ viewport });
}, 120_000);
afterAll(async () => {
  try {
    if (browser !== undefined) {
      await closeOwnedBrowser(browser);
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    stopExternalLagWitness();
    await dev?.close();
    if (files !== undefined)
      await new Promise<void>((done) => {
        files.closeAllConnections();
        files.close(() => done());
      });
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

async function point(page: CdpSession, selector: string) {
  return evaluate<{ x: number; y: number }>(
    page,
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
}
async function control(
  page: CdpSession,
  transport: 'live' | 'static',
  command: 'pause' | 'restart' | 'step',
): Promise<void> {
  if (transport === 'live') {
    const response = await fetch(`${dev.url}/api/ending/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    expect(response.ok).toBe(true);
  } else if (command !== 'pause' || !(await evaluate(page, 'aegis.paused()'))) {
    const code = command === 'pause' ? 'KeyP' : command === 'restart' ? 'KeyR' : 'Period';
    await key(page, code, true);
    await key(page, code, false);
  }
  await evaluate(page, 'aegis.sync().then(()=>null)');
}
async function lose(page: CdpSession, transport: 'live' | 'static', capture = true): Promise<void> {
  if (capture) {
    if (!(await evaluate(page, "document.pointerLockElement?.id === 'stage'")))
      await click(page, 420, 300);
    await until(
      page,
      `({
      lock:document.pointerLockElement?.id,
      focus:document.activeElement.id,
      ending:aegis.presentation().ending,
      capture:aegis.presentation().input.capture,
    })`,
      (state: {
        lock?: string;
        ending: { active: boolean };
        capture: { pointer: string; error?: string; gameplayBlocked: boolean };
      }) => {
        if (state.capture.error !== undefined) throw new Error(JSON.stringify(state));
        if (state.ending.active || state.capture.gameplayBlocked)
          throw new Error(`Loss fixture was not reset: ${JSON.stringify(state)}`);
        return state.lock === 'stage';
      },
    );
  } else expect(await evaluate(page, 'document.activeElement.id')).toBe('stage');
  await key(page, 'KeyL', true);
  await evaluate(page, 'aegis.sync().then(()=>null)');
  await key(page, 'KeyL', false);
  await control(page, transport, 'step');
  await until(page, 'aegis.presentation().ending.active', (active) => active === true);
  await until(
    page,
    "document.pointerLockElement === null && document.activeElement.id === 'loss-restart'",
    Boolean,
  );
}

describe('persistent cinematic loss in real pages', () => {
  it('uses actual native Enter activation and a trusted explicitly bound Control key', async () => {
    const page = await openPage(browser.port, 'about:blank', viewport);
    try {
      await evaluate(
        page,
        `(()=>{
        document.body.innerHTML='<button id="activate">Restart</button>';
        globalThis.activations=0;const b=document.getElementById('activate');
        b.addEventListener('click',()=>globalThis.activations++);b.focus();
      })()`,
      );
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        code: 'Enter',
        key: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        code: 'Enter',
        key: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      expect(await evaluate(page, 'globalThis.activations')).toBe(0);
      await key(page, 'Enter', true);
      await key(page, 'Enter', false);
      expect(await evaluate(page, 'globalThis.activations')).toBe(1);
      await navigateAndWait(page, () =>
        page.send('Page.navigate', { url: `${dev.url}/play/ending/` }),
      );
      await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
      await evaluate(
        page,
        `(async()=>{
        const {createInputCollector}=await import('/vendor/@aegis/render-three/dist/client/input.js');
        const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.id='modifier-probe';document.body.append(canvas);
        globalThis.modifierEvents=[];
        canvas.addEventListener('keydown',e=>modifierEvents.push({code:e.code,ctrl:e.ctrlKey,trusted:e.isTrusted}));
        globalThis.modifierInput=createInputCollector({canvas,bindings:{actions:[{code:'ControlLeft',action:'Crouch'}],axes:[],pointer:'none',help:[]},pick:()=>null,onCommand:()=>{}});
        canvas.focus();
      })()`,
      );
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        code: 'ControlLeft',
        key: 'Control',
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
        location: 1,
        modifiers: 2,
      });
      expect(await evaluate(page, 'modifierInput.take().pressed')).toEqual(['Crouch']);
      expect(await evaluate(page, 'modifierEvents')).toEqual([
        { code: 'ControlLeft', ctrl: true, trusted: true },
      ]);
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        code: 'ControlLeft',
        key: 'Control',
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
        location: 1,
        modifiers: 0,
      });
      expect(await evaluate(page, 'modifierInput.take().released')).toEqual(['Crouch']);
      await evaluate(
        page,
        "modifierInput.dispose();document.getElementById('modifier-probe').remove()",
      );
    } finally {
      try {
        await page.send('Page.navigate', { url: 'about:blank' });
      } finally {
        page.close();
      }
    }
  });

  for (const transport of ['live', 'static'] as const)
    it(`${transport}: fades on authoritative loss, preserves paused state and supports R/click/native keys with fresh input`, async () => {
      const page = await openPage(
        browser.port,
        `${transport === 'live' ? dev.url : staticUrl}/play/ending/`,
        viewport,
      );
      try {
        await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
        await control(page, transport, 'pause');
        await control(page, transport, 'restart');
        await lose(page, transport);
        const hash = await evaluate(page, 'aegis.world.hash()');
        expect(await evaluate(page, "document.getElementById('loss-ending').open")).toBe(true);
        expect(await evaluate(page, "document.getElementById('loss-title').textContent")).toBe(
          'YOU WERE CAUGHT',
        );
        expect(
          await evaluate(page, "document.getElementById('loss-ending').getAttribute('aria-modal')"),
        ).toBe('true');
        expect(await evaluate(page, 'document.activeElement.id')).toBe('loss-restart');
        expect(await evaluate(page, 'document.pointerLockElement')).toBeNull();
        expect(await evaluate(page, 'aegis.presentation().input.capture.gameplayBlocked')).toBe(
          true,
        );
        expect(
          await evaluate(
            page,
            "getComputedStyle(document.getElementById('loss-shade')).transitionDuration",
          ),
        ).toBe('1s');
        await until<number>(
          page,
          "Number(getComputedStyle(document.getElementById('loss-shade')).opacity)",
          (opacity) => opacity >= 0.95,
          5000,
        );
        await until(page, 'aegis.presentation().ending.phase', (phase) => phase === 'shown', 5000);
        expect(
          await evaluate(
            page,
            "Number(getComputedStyle(document.getElementById('loss-shade')).opacity)",
          ),
        ).toBe(0.96);
        expect(
          await evaluate(page, "getComputedStyle(document.getElementById('loss-restart')).opacity"),
        ).toBe('1');
        const pose = await evaluate(page, 'aegis.adapter.camera.matrixWorld.toArray()');
        await key(page, 'KeyW', true);
        await mouseMove(page, 510, 310);
        await key(page, 'KeyW', false);
        await evaluate(page, 'aegis.sync().then(()=>null)');
        expect(await evaluate(page, 'aegis.world.hash()')).toBe(hash);
        expect(await evaluate(page, 'aegis.adapter.camera.matrixWorld.toArray()')).toEqual(pose);
        await key(page, 'KeyR', true);
        await key(page, 'KeyR', false);
        await until(page, 'aegis.presentation().ending.active', (active) => active === false);
        expect(await evaluate(page, "document.getElementById('loss-ending').open")).toBe(false);
        expect(await evaluate(page, 'document.activeElement.id')).toBe('stage');
        expect(
          await evaluate(
            page,
            "document.getElementById('action-pause').getAttribute('aria-pressed')",
          ),
        ).toBe('true');
        expect(await evaluate(page, 'aegis.tick()')).toBe(0);

        await lose(page, transport);
        const restart = await point(page, '#loss-restart');
        await click(page, restart.x, restart.y);
        await until(page, 'aegis.presentation().ending.active', (active) => active === false);
        expect(await evaluate(page, 'aegis.tick()')).toBe(0);
        for (const activation of ['Enter', 'Space']) {
          await lose(page, transport);
          expect(
            await evaluate(
              page,
              "({focus:document.activeElement.id,disabled:document.getElementById('loss-restart').disabled,lock:document.pointerLockElement})",
            ),
            `${transport} before ${activation}`,
          ).toEqual({ focus: 'loss-restart', disabled: false, lock: null });
          await key(page, activation, true);
          await key(page, activation, false);
          await until(page, 'aegis.presentation().ending.active', (active) => active === false);
          expect(await evaluate(page, 'aegis.tick()')).toBe(0);
        }

        await evaluate(
          page,
          `(()=>{
        globalThis.__endingPad=${JSON.stringify(virtualGamepad())};
        globalThis.__endingPadPolls=0;
        Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{
          globalThis.__endingPadPolls++;return[globalThis.__endingPad];
        }});
      })()`,
        );
        await until<number>(page, 'globalThis.__endingPadPolls', (count) => count >= 2);
        await key(page, 'Space', true);
        await evaluate(page, '__endingPad.buttons[0].value=1;__endingPad.buttons[0].pressed=true');
        await lose(page, transport, false);
        const lostTick = await evaluate(page, 'aegis.tick()');
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          code: 'Space',
          key: ' ',
          windowsVirtualKeyCode: 32,
          autoRepeat: true,
        });
        await key(page, 'Space', false);
        await evaluate(page, '__endingPad.buttons[8].value=1;__endingPad.buttons[8].pressed=true');
        const poll = await evaluate<number>(page, '__endingPadPolls');
        await until<number>(page, '__endingPadPolls', (count) => count >= poll + 3);
        expect(await evaluate(page, 'aegis.presentation().ending.active')).toBe(true);
        expect(await evaluate(page, 'aegis.tick()')).toBe(lostTick);
        await evaluate(page, 'for(const b of __endingPad.buttons){b.value=0;b.pressed=false}');
        const neutral = await evaluate<number>(page, '__endingPadPolls');
        await until<number>(page, '__endingPadPolls', (count) => count >= neutral + 2);
        await evaluate(page, '__endingPad.buttons[8].value=1;__endingPad.buttons[8].pressed=true');
        await until(page, 'aegis.presentation().ending.active', (active) => active === false);
        expect(await evaluate(page, 'aegis.tick()')).toBe(0);
        expect(await evaluate(page, 'document.activeElement.id')).toBe('stage');
        await evaluate(page, '__endingPad.buttons[8].value=0;__endingPad.buttons[8].pressed=false');

        expect(await evaluate(page, 'document.activeElement.id')).toBe('stage');
        await key(page, 'KeyV', true);
        await evaluate(page, 'aegis.sync().then(()=>null)');
        await key(page, 'KeyV', false);
        await control(page, transport, 'step');
        await until(
          page,
          "document.getElementById('hud-outcome').dataset.outcome",
          (value) => value === 'win',
        );
        expect(await evaluate(page, 'aegis.presentation().ending.active')).toBe(false);
        expect(await evaluate(page, 'aegis.presentation().input.capture.gameplayBlocked')).toBe(
          false,
        );
        expect(page.diagnostics).toEqual([]);
      } finally {
        try {
          await page.send('Page.navigate', { url: 'about:blank' });
        } finally {
          page.close();
        }
      }
    }, 180_000);

  it('hydrates an already-lost live world with immediate reduced-motion dim and no replayed input', async () => {
    const page = await openPage(browser.port, 'about:blank', viewport);
    try {
      await page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await navigateAndWait(page, () =>
        page.send('Page.navigate', { url: `${dev.url}/play/ending/` }),
      );
      await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
      await control(page, 'live', 'pause');
      await control(page, 'live', 'restart');
      await lose(page, 'live');
      const hash = await evaluate(page, 'aegis.world.hash()');
      await navigateAndWait(page, () => page.send('Page.reload'));
      await until(
        page,
        'globalThis.aegis?.presentation().ending.active',
        (active) => active === true,
      );
      expect(await evaluate(page, 'aegis.presentation().ending')).toMatchObject({
        phase: 'shown',
        reducedMotion: true,
        fadeSeconds: 0,
      });
      expect(
        await evaluate(
          page,
          "Number(getComputedStyle(document.getElementById('loss-shade')).opacity)",
        ),
      ).toBe(0.96);
      expect(
        await evaluate(
          page,
          "getComputedStyle(document.getElementById('loss-shade')).transitionDuration",
        ),
      ).toBe('0s');
      expect(await evaluate(page, 'aegis.world.hash()')).toBe(hash);
      expect(await evaluate(page, 'document.activeElement.id')).toBe('loss-restart');
      expect(page.diagnostics).toEqual([]);
    } finally {
      try {
        await page.send('Page.navigate', { url: 'about:blank' });
      } finally {
        page.close();
      }
    }
  }, 120_000);
});

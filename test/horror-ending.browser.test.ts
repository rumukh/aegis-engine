import assert from 'node:assert/strict';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { cpus, tmpdir, totalmem } from 'node:os';
import { extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fpsPlugin } from '@aegis/mode-fps';
import type { ModePlugin } from '@aegis/harness';
import { horror } from '../poc/horror.mjs';
import { BINDINGS } from '../packages/render-three/src/bindings.js';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import type { DevServer } from '../packages/render-three/src/dev-server.js';
import { exportStaticSite } from '../packages/render-three/src/static-site.js';
import { FPS_SCENE } from '../packages/render-three/src/testing/scenes.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { navigateAndWait } from '../packages/render-three/src/browser-navigation.js';
import {
  click,
  evaluate,
  key,
  launchBrowser,
  openPage,
  screenshot,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import type { PresentationManifest } from '../packages/render-three/src/presentation/schema.js';

const artifacts = process.env['AEGIS_ENDING_ARTIFACTS'];
const traceDirectory = process.env['AEGIS_ENDING_TRACE'];
const hardware = process.env['AEGIS_ENDING_HARDWARE'] === '1';
const bindings = {
  ...BINDINGS.fps,
  actions: [...BINDINGS.fps.actions, { code: 'KeyV', action: 'Win' }],
};
const plugin: ModePlugin = {
  ...fpsPlugin,
  systems: () =>
    fpsPlugin.systems().add({
      name: 'fixture.win',
      phase: 'postUpdate',
      run({ world, input }): void {
        if (input.pressed.includes('Win')) world.events.emit('level.completed', {});
      },
    }),
};
const source = horror.presentation.manifest;
assert.ok(source.ui?.winEnding);
const manifest: PresentationManifest = {
  aegis: 'presentation/1',
  quality: hardware ? 'high' : 'low',
  pipeline: source.pipeline,
  assets: source.assets?.filter((asset) =>
    ['evacuation-ending', 'station-reflection', 'vo-exit'].includes(asset.id),
  ),
  environment: { reflections: source.environment?.reflections },
  audio: { headroom: 0.65, cues: source.audio?.cues?.filter((cue) => cue.asset === 'vo-exit') },
  hud: { playerName: 'player', winEvent: 'level.completed', loseEvents: ['player.died'] },
  ui: { winEnding: source.ui.winEnding },
};
let directory: string, dev: DevServer, files: Server, staticUrl: string;
let browser: LaunchedBrowser | undefined;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aegis-win-ending-'));
  const module = join(directory, 'plugin.mjs');
  writeFileSync(
    module,
    `import{fpsPlugin}from'@aegis/mode-fps';
    export const plugin={...fpsPlugin,systems:()=>fpsPlugin.systems().add({
      name:'fixture.win',phase:'postUpdate',run({world,input}){
        if(input.pressed.includes('Win'))world.events.emit('level.completed',{});
      }
    })};`,
  );
  const game = {
    id: 'ending',
    title: 'NULL MERIDIAN / ending preview fixture',
    blurb: '',
    objective: 'Press V to preview the authored ending (not a gameplay completion proof).',
    mode: 'fps' as const,
    plugin,
    scene: FPS_SCENE,
    bindings,
    presentation: { assetRoot: horror.presentation.assetRoot, manifest },
  };
  dev = await startDevServer({ games: [game], port: 0 });
  const site = exportStaticSite({
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
    outDir: join(directory, 'site'),
    repoRoot: process.cwd(),
  });
  const table = new Map(
    site.files.map((file) => [`/${file.replaceAll('\\', '/')}`, join(site.outDir, file)]),
  );
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.glb': 'model/gltf-binary',
    '.ogg': 'audio/ogg',
  };
  files = createServer((request, response) => {
    let path = new URL(request.url ?? '/', 'http://local').pathname;
    if (path.endsWith('/')) path += 'index.html';
    const file = table.get(path);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => files.listen(0, '127.0.0.1', done));
  const address = files.address();
  assert.ok(address && typeof address !== 'string');
  staticUrl = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${dev.url}/play/ending/`)).status).toBe(200);
  expect((await fetch(`${staticUrl}/play/ending/`)).status).toBe(200);
}, 120_000);

afterAll(async () => {
  stopExternalLagWitness();
  await dev?.close();
  if (files !== undefined)
    await new Promise<void>((done) => {
      files.closeAllConnections();
      files.close(() => done());
    });
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});
async function button(page: CdpSession, id: string): Promise<void> {
  const point = await evaluate<{ x: number; y: number }>(
    page,
    `(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await click(page, point.x, point.y);
}
async function frames(page: CdpSession): Promise<void> {
  await evaluate(
    page,
    `new Promise(resolve=>{let n=0;function frame(){if(++n===12)resolve(null);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})`,
  );
}
async function win(page: CdpSession): Promise<void> {
  await click(page, hardware ? 900 : 500, hardware ? 600 : 330);
  await key(page, 'KeyV', true);
  await until(page, 'aegis.presentation().winEnding.active', (value) => value === true);
  await key(page, 'KeyV', false);
}
function failureDetails(error: unknown): object {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error instanceof AggregateError ? { errors: error.errors.map(failureDetails) } : {}),
      }
    : { value: String(error) };
}
interface ProbeDocument {
  boundary: 'before-reload' | 'before-cleanup';
  trace: unknown;
}
async function captureProbeDocument(
  documents: ProbeDocument[],
  boundary: ProbeDocument['boundary'],
  read: () => Promise<unknown>,
): Promise<void> {
  const trace = await read();
  documents.push({ boundary, trace });
}
function readProbe(page: CdpSession): Promise<unknown> {
  return evaluate(
    page,
    `window.__endingProbe?{
      ...JSON.parse(JSON.stringify(window.__endingProbe)),
      final:window.__endingProbe.snapshot(),sourceDurations:window.__voices
    }:{installed:false,url:location.href,presentation:globalThis.aegis?.presentation()}`,
  );
}
describe('authored win cutscene in live and static clients', () => {
  for (const transport of ['live', 'static'] as const)
    it(`${transport}: renders the actual set, pauses/skips/restarts and plays separation once`, async () => {
      browser = await launchBrowser({
        viewport: hardware ? { width: 1600, height: 900 } : { width: 800, height: 450 },
        graphics: hardware ? 'hardware' : 'software',
      });
      const page = await openPage(
        browser.port,
        'about:blank',
        hardware ? { width: 1600, height: 900 } : { width: 800, height: 450 },
      );
      const failures: unknown[] = [];
      const cleanup: { stage: string; error?: object }[] = [];
      const ownedBrowser = {
        pid: browser.process.pid,
        args: browser.process.spawnargs,
        profile: browser.profile,
      };
      const documents: ProbeDocument[] = [];
      let pageDiagnostics: readonly string[] = [];
      let pageWarnings: readonly string[] = [];
      try {
        await navigateAndWait(page, () =>
          page.send('Page.navigate', {
            url: `${transport === 'live' ? dev.url : staticUrl}/play/ending/`,
          }),
        );
        await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
        await evaluate(
          page,
          `(async()=>{
          const snapshot=()=>{
            const p=globalThis.aegis.presentation();
            return {
              at:performance.now(),tick:aegis.tick(),generation:p.generation,
              ending:p.winEnding,audio:p.audio,
              capture:p.input?.capture,
              hidden:document.hidden,focused:document.hasFocus(),
              activeElement:document.activeElement?.id,
              liveFrameTiming:typeof aegis.timings==='function'
                ?{available:true,gapMs:aegis.timings().gap}
                :{available:false}
            };
          };
          const probe=window.__endingProbe={
            initial:snapshot(),snapshot,
            environment:{
              userAgent:navigator.userAgent,platform:navigator.platform,
              logicalProcessors:navigator.hardwareConcurrency,
              deviceMemoryGiB:navigator.deviceMemory??null,
              viewport:[innerWidth,innerHeight],devicePixelRatio
            },
            renderer:null,timeline:[],recent:[],crossings:[],
            renderSamples:0,maxLiveFrameGapMs:null,maxObservedRenderIntervalMs:null,
            maxSecondsDelta:0,largestDelta:null
          };
          const append=(list,value,limit)=>{list.push(value);if(list.length>limit)list.shift()};
          const record=(kind,detail={})=>append(probe.timeline,{kind,...snapshot(),detail},96);
          const audioError=error=>({name:error?.name??typeof error,message:String(error?.message??error)});
          const contexts=new WeakMap();
          let contextId=0,audioCallId=0;
          const contextInfo=context=>{
            if(!contexts.has(context)){
              contexts.set(context,++contextId);
              context.addEventListener('statechange',()=>record('context-state',contextInfo(context)));
            }
            return {context:contexts.get(context),state:context.state,currentTime:context.currentTime};
          };
          for(const method of ['resume','decodeAudioData']){
            const original=AudioContext.prototype[method];
            AudioContext.prototype[method]=function(...args){
              const call=++audioCallId;
              const inputBytes=method==='decodeAudioData'?args[0]?.byteLength:undefined;
              let result;
              try{result=original.apply(this,args)}
              catch(error){
                record(method+':threw',{call,inputBytes,...contextInfo(this),error:audioError(error)});
                throw error;
              }
              record(method+':called',{call,inputBytes,...contextInfo(this)});
              result.then(value=>record(method+':resolved',{
                call,...contextInfo(this),
                ...(method==='decodeAudioData'?{
                  duration:value.duration,channels:value.numberOfChannels,sampleRate:value.sampleRate
                }:{})
              }),error=>record(method+':rejected',{call,...contextInfo(this),error:audioError(error)}));
              return result;
            };
          }
          const control=(event,phase)=>{
            const id=event.target instanceof Element?event.target.closest('button')?.id:undefined;
            if(id?.startsWith('win-'))record('control:'+phase,{id,trusted:event.isTrusted});
          };
          document.addEventListener('click',event=>control(event,'before'),true);
          document.addEventListener('click',event=>control(event,'after'));
          window.addEventListener('keydown',event=>{
            if(event.code==='KeyV')record('win-key',{trusted:event.isTrusted,repeat:event.repeat});
          },true);
          const {Scene}=await import('three'),render=Scene.prototype.onBeforeRender;
          let previous;
          const crossed=new Set();
          Scene.prototype.onBeforeRender=function(renderer,scene,camera,...rest){
            if(scene.name==='presentation:win-ending'||scene.name==='aegis:fps'){
              window.__currentView={scene:scene.name,camera:camera.uuid};
              if(scene.name==='presentation:win-ending')window.__endingScene=scene;
              if(probe.renderer===null){
                const gl=renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
                probe.renderer={
                  vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),
                  version:gl.getParameter(gl.VERSION),
                  shadingLanguage:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                  unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,
                  unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
                  attributes:gl.getContextAttributes(),
                  drawingBuffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],
                  pixelRatio:renderer.getPixelRatio()
                };
              }
              const current=snapshot();
              probe.renderSamples++;
              if(current.liveFrameTiming.available){
                const gap=current.liveFrameTiming.gapMs;
                probe.maxLiveFrameGapMs=Math.max(probe.maxLiveFrameGapMs??gap,gap);
              }
              if(previous){
                const interval=current.at-previous.at;
                probe.maxObservedRenderIntervalMs=Math.max(
                  probe.maxObservedRenderIntervalMs??interval,interval
                );
              }
              append(probe.recent,current,16);
              if(previous?.generation===current.generation&&previous.ending?.phase==='playing'){
                const delta=current.ending.seconds-previous.ending.seconds;
                if(delta>probe.maxSecondsDelta){
                  probe.maxSecondsDelta=delta;
                  probe.largestDelta={before:previous,after:current};
                }
                if(previous.ending.seconds<4&&current.ending.seconds>=4&&!crossed.has(current.generation)){
                  crossed.add(current.generation);
                  append(probe.crossings,{
                    generation:current.generation,before:previous,after:current,
                    latenessSeconds:current.ending.seconds-4
                  },8);
                }
              }
              previous=current;
            }
            return render.call(this,renderer,scene,camera,...rest);
          };
          window.__voices=[];
          const start=AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start=function(...args){
            const duration=this.buffer?.duration;
            window.__voices.push(duration);
            let result;
            try{result=start.apply(this,args)}
            catch(error){
              record('source-start:threw',{duration,...contextInfo(this.context),error:audioError(error)});
              throw error;
            }
            record('source-start',{duration,...contextInfo(this.context)});
            return result;
          };
          record('instrumentation-installed');
        })()`,
        );
        await frames(page);
        const originalCamera = await evaluate(page, 'window.__currentView.camera');
        await win(page);
        await until(
          page,
          'aegis.presentation().winEnding.seconds',
          (seconds: number) => seconds >= 0.5,
        );
        expect(await evaluate(page, 'window.__currentView.scene')).toBe('presentation:win-ending');
        expect(await evaluate(page, 'window.__currentView.camera')).not.toBe(originalCamera);
        expect(
          await evaluate(
            page,
            "document.pointerLockElement === null && document.activeElement.id === 'win-skip'",
          ),
        ).toBe(true);
        expect(await evaluate(page, 'aegis.presentation().input.capture.gameplayBlocked')).toBe(
          true,
        );
        if (artifacts) await screenshot(page, join(artifacts, `${transport}-01-hatch.png`));
        await button(page, 'win-pause');
        const paused = await evaluate(page, 'aegis.presentation().winEnding.seconds');
        await frames(page);
        expect(await evaluate(page, 'aegis.presentation().winEnding.seconds')).toBe(paused);
        expect(await evaluate(page, 'window.__voices.length')).toBe(0);
        await button(page, 'win-pause');
        await until(
          page,
          'aegis.presentation().winEnding.seconds',
          (seconds: number) => seconds >= 6,
        );
        if (artifacts) await screenshot(page, join(artifacts, `${transport}-02-separation.png`));
        expect(await evaluate<number[]>(page, 'window.__voices')).toEqual([
          expect.closeTo(4.138, 1),
        ]);
        await until(
          page,
          'aegis.presentation().winEnding.seconds',
          (seconds: number) => seconds >= 12,
        );
        expect(
          await evaluate<number>(
            page,
            "window.__endingScene.getObjectByName('independent-capsule').position.x",
          ),
        ).toBeGreaterThan(50);
        if (artifacts) await screenshot(page, join(artifacts, `${transport}-03-departure.png`));
        await until(page, 'aegis.presentation().winEnding.phase', (phase) => phase === 'shown');
        expect(await evaluate(page, 'document.activeElement.id')).toBe('win-restart');
        expect(
          await evaluate(page, "document.getElementById('win-message').textContent"),
        ).toContain('crew archive is safe');
        if (artifacts) await screenshot(page, join(artifacts, `${transport}-04-complete.png`));
        await button(page, 'win-restart');
        await until(page, 'aegis.presentation().winEnding.phase', (phase) => phase === 'hidden');
        await frames(page);
        expect(await evaluate(page, 'window.__currentView.scene')).toBe('aegis:fps');
        expect(await evaluate(page, 'window.__currentView.camera')).toBe(originalCamera);
        expect(await evaluate(page, 'aegis.presentation().input.capture.gameplayBlocked')).toBe(
          false,
        );
        await win(page);
        await button(page, 'win-mute');
        await until(
          page,
          'aegis.presentation().winEnding.seconds',
          (seconds: number) => seconds >= 5,
        );
        expect(await evaluate(page, 'window.__voices.length')).toBe(1);
        await button(page, 'win-mute');
        await frames(page);
        expect(await evaluate(page, 'window.__voices.length')).toBe(1);
        await button(page, 'win-skip');
        await frames(page);
        expect(await evaluate(page, 'aegis.presentation().winEnding.phase')).toBe('shown');
        expect(await evaluate(page, 'window.__voices.length')).toBe(1);
        await button(page, 'win-restart');
        await until(page, 'aegis.presentation().winEnding.phase', (phase) => phase === 'hidden');
        await page.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await frames(page);
        await win(page);
        expect(await evaluate(page, 'aegis.presentation().winEnding')).toMatchObject({
          phase: 'shown',
          reducedMotion: true,
          seconds: 0,
        });
        expect(await evaluate(page, 'window.__voices.length')).toBe(1);
        if (transport === 'live') {
          await page.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
          });
          await captureProbeDocument(documents, 'before-reload', () => readProbe(page));
          await navigateAndWait(page, () => page.send('Page.reload'));
          await until(
            page,
            'globalThis.aegis?.presentation().winEnding?.phase',
            (phase) => phase === 'shown',
          );
          expect(await evaluate(page, 'aegis.presentation().winEnding')).toMatchObject({
            seconds: 0,
            reducedMotion: false,
          });
          expect(await evaluate(page, 'aegis.presentation().audio.voices')).toBe(0);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await captureProbeDocument(documents, 'before-cleanup', () => readProbe(page));
        } catch (error) {
          failures.push(error);
          cleanup.push({ stage: 'collect-probe', error: failureDetails(error) });
        }
        pageDiagnostics = [...page.diagnostics];
        pageWarnings = [...page.warnings];
        console.info(
          '[ending-fixture-probe:before-cleanup]',
          JSON.stringify({
            kind: 'ending-fixture-probe/2',
            stage: 'before-cleanup',
            transport,
            browser: ownedBrowser,
            documents,
            pageDiagnostics,
            pageWarnings,
            failures: failures.map(failureDetails),
          }),
        );
        try {
          await navigateAndWait(page, () => page.send('Page.navigate', { url: 'about:blank' }));
          cleanup.push({ stage: 'navigate-blank' });
        } catch (error) {
          failures.push(error);
          cleanup.push({ stage: 'navigate-blank', error: failureDetails(error) });
        }
        page.close();
        cleanup.push({ stage: 'close-page' });
        const owned = browser;
        browser = undefined;
        try {
          await closeOwnedBrowser(owned);
          cleanup.push({ stage: 'close-browser' });
        } catch (error) {
          failures.push(error);
          cleanup.push({ stage: 'close-browser', error: failureDetails(error) });
        } finally {
          try {
            rmSync(owned.profile, {
              recursive: true,
              force: true,
              maxRetries: 20,
              retryDelay: 100,
            });
            cleanup.push({ stage: 'remove-profile' });
          } catch (error) {
            failures.push(error);
            cleanup.push({ stage: 'remove-profile', error: failureDetails(error) });
          }
        }
      }
      const evidence = {
        kind: 'ending-fixture-probe/2',
        transport,
        result: failures.length === 0 ? 'passed' : 'failed',
        runner: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          logicalProcessors: cpus().length,
          processor: cpus()[0]?.model,
          memoryBytes: totalmem(),
          requestedGraphics: hardware ? 'hardware' : 'software',
        },
        browser: ownedBrowser,
        documents,
        pageDiagnostics,
        pageWarnings,
        failures: failures.map(failureDetails),
        cleanup,
      };
      if (traceDirectory !== undefined) {
        mkdirSync(traceDirectory, { recursive: true });
        writeFileSync(
          join(traceDirectory, `${transport}.json`),
          JSON.stringify(evidence, null, 2) + '\n',
        );
      }
      console.info('[ending-fixture-probe]', JSON.stringify(evidence));
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `${transport} ending failure: ${failures.map(String).join('\n')}`,
        );
    }, 120_000);
});

import { createServer } from 'node:http';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  click,
  evaluate,
  findBrowser,
  key,
  launchBrowser,
  mouseButton,
  openPage,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, '..', 'packages', 'browser', 'dist');
const base = '/nested/lab/';
const files = new Map<string, { bytes: Buffer; type: string }>();
let browser: LaunchedBrowser;
let page: CdpSession;
let origin: string;
let denied = false;
let deniedRequests = 0;
let audioRequests = 0;
const narrationSample =
  process.env['AEGIS_NARRATION_SAMPLE'] ??
  join(root, '..', 'poc', 'lab-shared', 'assets', 'lab.welcome.wav');

function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24);
  output.writeUInt32LE(rate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    output.writeInt16LE(Math.round(Math.sin((i * 440 * Math.PI * 2) / rate) * 3000), 44 + i * 2);
  return output;
}
function add(path: string, text: string, type = 'text/javascript'): void {
  files.set(`${base}${path}`, { bytes: Buffer.from(text), type });
}
function modules(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) modules(file);
    else if (entry.name.endsWith('.js')) {
      files.set(`${base}sdk/${relative(dist, file).replaceAll('\\', '/')}`, {
        bytes: readFileSync(file),
        type: 'text/javascript',
      });
    }
  }
}
const server = createServer((request, response) => {
  if (denied) {
    deniedRequests++;
    response.writeHead(503).end('network denied');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === `${base}audio.wav`) audioRequests++;
  const value = files.get(url.pathname === base ? `${base}index.html` : url.pathname);
  if (!value) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { 'content-type': value.type, 'cache-control': 'no-store' })
    .end(value.bytes);
});

beforeAll(async () => {
  modules(dist);
  add(
    'index.html',
    '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Browser services</title><body><button id="unlock">Sound</button><main id="stage"></main><script type="module" src="./boot.js"></script></body></html>',
    'text/html',
  );
  add(
    'boot.js',
    `import {IndexedDbSaveStorage} from './sdk/save/indexeddb.js';
    const store = new IndexedDbSaveStorage('offline-progress');
    const record = await store.read({gameId:'lab',profileId:'p1'});
    document.querySelector('#stage').textContent = record.current?.payload ?? 'new';
    await store.close();
    globalThis.fixtureReady = true;`,
  );
  files.set(`${base}audio.wav`, { bytes: wav(3), type: 'audio/wav' });
  if (narrationSample)
    files.set(`${base}narration.wav`, { bytes: readFileSync(narrationSample), type: 'audio/wav' });
  add('data.json', '{"revision":"r1","clue":"approved"}', 'application/json');
  add('data-next.json', '{"revision":"r2","clue":"updated"}', 'application/json');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to bind.');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await launchBrowser({ viewport: { width: 800, height: 700 } });
  page = await openPage(browser.port, `${origin}${base}`);
  await until(page, 'globalThis.fixtureReady', (value) => value === true, 15_000);
}, 120_000);

afterAll(async () => {
  try {
    page?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    stopExternalLagWitness();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const execute = <T>(body: string): Promise<T> => evaluate<T>(page, `(async () => { ${body} })()`);

describe('actual Chromium browser services', () => {
  it('uses real cross-tab IndexedDB CAS, atomic rollback and previous revision recovery', async () => {
    const other = await openPage(browser.port, `${origin}${base}`);
    try {
      const setup = `(async () => {
        const {IndexedDbSaveStorage}=await import('./sdk/save/indexeddb.js');
        globalThis.db=new IndexedDbSaveStorage('cas-probe');
        return db.read({gameId:'lab',profileId:'p1'});
      })()`;
      expect(await evaluate(page, setup)).toEqual({});
      expect(await evaluate(other, setup)).toEqual({});
      const write = (payload: string): string => `(async()=>{try{
        await db.compareAndSwap({gameId:'lab',profileId:'p1'},0,{revision:1,payload:'${payload}'});
        return 'saved'; }catch(error){return error.code;}})()`;
      const results = await Promise.all([
        evaluate(page, write('first')),
        evaluate(other, write('second')),
      ]);
      expect(results.sort()).toEqual(['conflict', 'saved']);
      const rollback = await execute<{
        revision: number;
        aborted: string;
        previous: number;
        other: string;
      }>(`
        const key={gameId:'lab',profileId:'p1'};
        const original=IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put=function(...args){
          const request=original.apply(this,args); this.transaction.abort(); return request;
        };
        let aborted;
        try { await db.compareAndSwap(key,1,{revision:2,payload:'must-rollback'}); }
        catch(error){aborted=error.code;} finally {IDBObjectStore.prototype.put=original;}
        const rolled=await db.read(key);
        await db.compareAndSwap(key,1,{revision:2,payload:'second-valid'});
        await db.compareAndSwap({gameId:'other',profileId:'p1'},0,{revision:1,payload:'untouched'});
        const history=await db.read(key);
        await db.reset(key,2,key);
        const other=await db.read({gameId:'other',profileId:'p1'});
        await db.close();
        return {revision:rolled.current.revision,aborted,previous:history.previous.revision,other:other.current.payload};
      `);
      expect(rollback).toEqual({
        revision: 1,
        aborted: 'storage',
        previous: 1,
        other: 'untouched',
      });
      await evaluate(other, 'db.close()');
    } finally {
      other.close();
    }
  });

  it('resumes at the actual media offset and ignores stale real-source callbacks after replay/replace', async () => {
    await execute(`
      const {createNarration}=await import('./sdk/audio/index.js');
      globalThis.audioStates=[]; globalThis.captions=[]; globalThis.completions=[]; globalThis.sources=[];globalThis.starts=[];
      globalThis.audio=createNarration({baseUrl:location.href,onState:s=>audioStates.push(s),
        onCaption:line=>captions.push(line?.id??null),onComplete:id=>completions.push(id),
        contextFactory:()=>{globalThis.context=new AudioContext();
          const create=context.createBufferSource.bind(context);
          context.createBufferSource=()=>{const source=create();sources.push(source);
            const start=source.start.bind(source);source.start=(when,offset)=>{starts.push({clock:context.currentTime,offset});start(when,offset);};
            return source;};return context;}});
      audio.registerPack({id:'case',revision:'r1',assets:[{id:'line',src:${JSON.stringify(narrationSample ? 'narration.wav' : 'audio.wav')}}],
        lines:[{id:'one',asset:'line',caption:'Первый голос'},{id:'two',asset:'line',caption:'Второй голос'},{id:'missing',asset:'absent',caption:'Текст остаётся'}]});
      await audio.playLine('case','one');
      document.querySelector('#unlock').onclick=()=>audio.unlock().catch(error=>{globalThis.unlockError=error.code;});
      return audio.state();
    `);
    expect(await execute('return audio.state().status;')).toBe('blocked');
    expect(await execute('return captions;')).toEqual(['one']);
    const rect = await execute<{ x: number; y: number }>(
      "const r=document.querySelector('#unlock').getBoundingClientRect();return {x:r.x+10,y:r.y+10};",
    );
    await click(page, rect.x, rect.y);
    await until(page, 'audio.state().status', (value) => value === 'playing', 15_000);
    const duration = await execute<number>('return sources[0].buffer.duration;');
    await until<number>(page, 'audio.state().offset', (value) => value >= duration / 2, 20_000);
    const paused = await execute<{ elapsed: number; offset: number }>(
      'const elapsed=context.currentTime-starts[0].clock;audio.pause();return {elapsed,offset:audio.state().offset};',
    );
    await execute('await new Promise(resolve=>setTimeout(resolve,350));');
    const still = await execute<number>('return audio.state().offset;');
    expect(Math.abs(still - paused.offset)).toBeLessThan(0.02);
    const resumed = await execute<number>('await audio.resume(); return starts.at(-1).offset;');
    expect(Math.abs(resumed - paused.elapsed)).toBeLessThan(0.25);
    console.info(
      'Narration resume evidence',
      JSON.stringify({
        source: narrationSample ? 'approved-Russian-recording' : 'synthetic-test-tone',
        durationSeconds: duration,
        pausedSeconds: paused.elapsed,
        resumedSeconds: resumed,
        errorMilliseconds: Math.abs(resumed - paused.elapsed) * 1000,
      }),
    );
    const guard = await execute<{
      captions: (string | null)[];
      completions: string[];
      offset: number;
      status: string;
      readable: string;
    }>(`
      const stale=sources.at(-1).onended;
      await audio.replay();
      const offset=audio.state().offset;
      const replayEnded=sources.at(-1).onended;
      await audio.playLine('case','two');
      stale(); replayEnded();
      const completed=sources.at(-1).onended; completed(); completed();
      const status=audio.state().status;
      try{await audio.playLine('case','missing');}catch{}
      return {captions,completions,offset,status,readable:audio.state().line.caption};
    `);
    expect(guard.offset).toBeLessThan(0.25);
    expect(guard.status).toBe('completed');
    expect(guard.completions).toEqual(['two']);
    expect(guard.captions).toEqual(['one', 'one', 'two', 'missing']);
    expect(guard.readable).toBe('Текст остаётся');
    expect(await execute('return audio.state().status;')).toBe('failed');
    expect(
      await execute(`
      audio.registerPack({id:'invalid-format',revision:'r1',assets:[{id:'bad',src:'data.json'}],
        lines:[{id:'bad',asset:'bad',caption:'Readable after decode failure'}]});
      let rejected=false;
      try{await audio.playLine('invalid-format','bad');}catch{rejected=true;}
      return {rejected,status:audio.state().status,caption:audio.state().line.caption,completions};
    `),
    ).toEqual({
      rejected: true,
      status: 'failed',
      caption: 'Readable after decode failure',
      completions: ['two'],
    });
    await execute('await audio.dispose();');
  });

  it('recovers real suspended/autoplay-blocked contexts with a new gesture without duplicate voices', async () => {
    const fresh = await openPage(browser.port, `${origin}${base}`);
    try {
      const blocked = await evaluate(
        fresh,
        `(async()=>{
        const {createNarration}=await import('./sdk/audio/index.js');
        globalThis.voice=createNarration({baseUrl:location.href,unlockTimeoutMs:120,onState:()=>{},
          contextFactory:()=>{globalThis.ctx=new AudioContext();return ctx;}});
        voice.registerPack({id:'case',revision:'r1',assets:[{id:'a',src:'audio.wav'}],
          lines:[{id:'a',asset:'a',caption:'Caption while blocked'}]});
        await voice.playLine('case','a');
        let code;try{await voice.unlock();}catch(error){code=error.code;}
        document.querySelector('#unlock').onclick=()=>voice.unlock().catch(error=>{globalThis.gestureError=error.code;});
        return {code,status:voice.state().status,context:ctx.state,caption:voice.state().line.caption};
      })()`,
      );
      expect(blocked).toEqual({
        code: 'blocked',
        status: 'blocked',
        context: 'suspended',
        caption: 'Caption while blocked',
      });
      await fresh.send('Page.bringToFront');
      const at = await evaluate<{ x: number; y: number }>(
        fresh,
        "(()=>{const r=document.querySelector('#unlock').getBoundingClientRect();return {x:r.x+10,y:r.y+10};})()",
      );
      await click(fresh, at.x, at.y);
      await until(fresh, 'voice.state().status', (value) => value === 'playing', 10_000);
      await evaluate(fresh, 'ctx.suspend()');
      await until(fresh, 'voice.state().status', (value) => value === 'blocked', 10_000);
      await click(fresh, at.x, at.y);
      await until(fresh, 'voice.state().status', (value) => value === 'playing', 10_000);
      expect(
        await evaluate(
          fresh,
          '(async()=>{await voice.unlock();await voice.unlock();return voice.state().voices;})()',
        ),
      ).toBe(1);
      await evaluate(fresh, 'voice.dispose()');
    } finally {
      fresh.close();
    }
  });

  it('bounds pack memory/voices and keeps explicit atmosphere silence after interruption/unlock', async () => {
    audioRequests = 0;
    const result = await execute<{
      peak: number;
      decoded: number;
      released: number;
      silent: number;
      requests: number;
    }>(`
      const {createNarration}=await import('./sdk/audio/index.js');
      let peak=0;
      const transport=createNarration({baseUrl:location.href,maxVoices:3,onState:s=>{peak=Math.max(peak,s.voices);},
        contextFactory:()=>{globalThis.musicContext=new AudioContext();return musicContext;}});
      transport.registerPack({id:'case',revision:'r1',assets:[{id:'slow',src:'audio.wav'},{id:'fast',src:'audio.wav'}],lines:[]});
      await transport.unlock();
      await transport.setAtmosphere({packId:'case',asset:'slow',fadeSeconds:0.05});
      await transport.setAtmosphere({packId:'case',asset:'fast',fadeSeconds:0.05});
      await transport.setAtmosphere({packId:'case',asset:'slow',fadeSeconds:0.05});
      const decoded=transport.state().decodedBytes;
      await transport.setAtmosphere(null);
      transport.pause(); await transport.resume(); await musicContext.suspend(); await transport.unlock(); await transport.unlock();
      const silent=transport.state().voices;
      transport.releasePack('case');
      const released=transport.state().decodedBytes;
      await transport.dispose();
      return {peak,decoded,released,silent};
    `);
    expect(result.peak).toBeLessThanOrEqual(2);
    expect(result.decoded).toBeGreaterThan(100_000);
    expect(result.decoded).toBeLessThan(64 * 1024 * 1024);
    expect(result.released).toBe(0);
    expect(result.silent).toBe(0);
    expect(audioRequests).toBe(2);
    console.info(
      'Atmosphere evidence',
      JSON.stringify({ ...result, requests: audioRequests, configuredMaxVoices: 3 }),
    );
  });

  it('bounds concurrent real decoding/effects and cancels held loads across restore/privacy boundaries', async () => {
    const result = await execute<{
      peakRequests: number;
      peakVoices: number;
      limited: number;
      decoded: number;
      afterClear: number;
      afterRelease: number;
      budgetCode: string;
      budgetBytes: number;
      budgetCaption: string;
    }>(`
      const {createNarration}=await import('./sdk/audio/index.js');
      let active=0,peakRequests=0,peakVoices=0;
      const transport=createNarration({baseUrl:location.href,maxRequests:2,maxVoices:3,
        onState:s=>{peakVoices=Math.max(peakVoices,s.voices);},
        fetch:async(...args)=>{active++;peakRequests=Math.max(peakRequests,active);
          try{return await fetch(...args);}finally{active--;}}});
      transport.registerPack({id:'effects',revision:'r1',assets:Array.from({length:6},(_,i)=>({id:'a'+i,src:'audio.wav'})),lines:[]});
      await transport.unlock();
      const outcomes=await Promise.allSettled(Array.from({length:6},(_,i)=>transport.playEffect('effects','a'+i)));
      const limited=outcomes.filter(o=>o.status==='rejected'&&o.reason.code==='limit').length;
      const decoded=transport.state().decodedBytes;
      transport.clear();transport.releasePack('effects');await transport.dispose();
      let release;
      const gate=new Promise(resolve=>{release=resolve;});
      const late=createNarration({baseUrl:location.href,onState:()=>{},fetch:async(...args)=>{
        const response=await fetch(...args);await gate;return response;}});
      late.registerPack({id:'late',revision:'r1',assets:[{id:'a',src:'audio.wav'}],
        lines:[{id:'one',asset:'a',caption:'Visible before restore'}]});
      await late.unlock();
      const line=late.playLine('late','one');
      const ambience=late.setAtmosphere({packId:'late',asset:'a'});
      late.clear();release();await Promise.all([line,ambience]);await late.unlock();
      const afterClear=late.state().voices;
      late.releasePack('late');
      const afterRelease=late.state().decodedBytes;
      await late.dispose();
      const tiny=createNarration({baseUrl:location.href,maxDecodedBytes:1024,onState:()=>{}});
      tiny.registerPack({id:'tiny',revision:'r1',assets:[{id:'a',src:'audio.wav'}],
        lines:[{id:'one',asset:'a',caption:'Caption survives a PCM budget refusal'}]});
      await tiny.unlock();
      let budgetCode;
      try { await tiny.playLine('tiny','one'); } catch(error) { budgetCode=error.code; }
      const budgetBytes=tiny.state().decodedBytes,budgetCaption=tiny.state().line.caption;
      await tiny.dispose();
      return {peakRequests,peakVoices,limited,decoded,afterClear,afterRelease,budgetCode,budgetBytes,budgetCaption};
    `);
    expect(result.peakRequests).toBe(2);
    expect(result.peakVoices).toBe(3);
    expect(result.limited).toBe(3);
    expect(result.decoded).toBeGreaterThan(0);
    expect(result.decoded).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(result.afterClear).toBe(0);
    expect(result.afterRelease).toBe(0);
    expect(result.budgetCode).toBe('limit');
    expect(result.budgetBytes).toBe(0);
    expect(result.budgetCaption).toBe('Caption survives a PCM budget refusal');
    console.info('Bounded audio evidence', JSON.stringify(result));
  });

  it('uses native keyboard/pointer single activation, accessible placement, scaling, focus and private-tree removal', async () => {
    await page.send('Page.bringToFront');
    await execute(`
      const ui=await import('./sdk/ui/index.js');
      const stage=document.querySelector('#stage'); stage.className='aegis-child'; stage.replaceChildren();
      const style=document.createElement('style');style.textContent=ui.CHILD_SAFE_CSS;document.head.append(style);
      ui.applyPresentationPreferences(stage,{locale:'ru',textScale:2,reducedMotion:true,comfort:true,hideSpoilers:true,volumes:{music:0,narration:0,effects:0}});
      globalThis.commands=0;globalThis.moves=[];globalThis.errors=[];
      const button=ui.createActionButton({document,label:'Очень длинная русская подпись: Алёна и ёж',command:()=>{commands++;},onError:error=>errors.push(error.code)});
      button.id='command';stage.append(button);
      const placement=ui.createPlacement({validate:()=>({ok:true}),commit:(item,slot)=>{moves.push([item,slot]);},
        onChange:()=>{},onError:error=>errors.push(error.code)});
      const item=document.createElement('button');item.textContent='Предмет';item.id='item';
      const slot=document.createElement('button');slot.textContent='Место';slot.id='slot';
      stage.append(item,slot);
      globalThis.unbindItem=ui.bindPlacementItem(item,'jar',placement,{slotAt:()=> 's1',onError:error=>errors.push(error.code)});
      globalThis.unbindSlot=ui.bindPlacementSlot(slot,'s1',placement,error=>errors.push(error.code));
      globalThis.placement=placement;
      button.focus();
    `);
    await key(page, 'Enter', true);
    await key(page, 'Enter', false);
    expect(await execute('return commands;')).toBe(1);
    const controls = await execute<
      { x: number; y: number; width: number; height: number; font: number }[]
    >(`
      return ['command','item','slot'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();
        return {x:r.x+10,y:r.y+10,width:r.width,height:r.height,font:parseFloat(getComputedStyle(e).fontSize)};});`);
    expect(
      controls.every((item) => item.width >= 48 && item.height >= 48 && item.font === 48),
    ).toBe(true);
    const contrast = await execute<{ text: number; boundary: number }>(`
      const css=getComputedStyle(document.querySelector('#stage'));
      const button=getComputedStyle(document.querySelector('#command'));
      const luminance=color=>{const rgb=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{
        const s=v/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});
        return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;};
      const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
      return {text:ratio(css.color,css.backgroundColor),boundary:ratio(button.borderTopColor,button.backgroundColor)};
    `);
    expect(contrast.text).toBeGreaterThanOrEqual(4.5);
    expect(contrast.boundary).toBeGreaterThanOrEqual(3);
    await click(page, controls[0]!.x, controls[0]!.y);
    expect(await execute('return commands;')).toBe(2);
    await click(page, controls[1]!.x, controls[1]!.y);
    await click(page, controls[2]!.x, controls[2]!.y);
    expect(await execute('return moves;')).toEqual([['jar', 's1']]);
    await mouseButton(page, true, controls[1]!.x, controls[1]!.y);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: controls[2]!.x,
      y: controls[2]!.y,
      button: 'left',
      buttons: 1,
    });
    await mouseButton(page, false, controls[2]!.x, controls[2]!.y);
    expect(await execute('return moves;')).toEqual([
      ['jar', 's1'],
      ['jar', 's1'],
    ]);
    await mouseButton(page, true, controls[1]!.x, controls[1]!.y);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: controls[2]!.x,
      y: controls[2]!.y,
      button: 'left',
      buttons: 1,
    });
    await key(page, 'Escape', true);
    await key(page, 'Escape', false);
    await mouseButton(page, false, controls[2]!.x, controls[2]!.y);
    expect(await execute('return moves.length;')).toBe(2);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    for (const item of [controls[1]!, controls[2]!]) {
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: item.x, y: item.y }],
      });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    expect(await execute('return moves.length;')).toBe(3);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await execute("document.querySelector('#item').focus();");
    await key(page, 'Space', true);
    await key(page, 'Space', false);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await execute("document.querySelector('#slot').focus();");
    await key(page, 'Space', true);
    await key(page, 'Space', false);
    expect(await execute('return moves.length;')).toBe(4);
    expect(await execute('return document.documentElement.scrollWidth<=innerWidth;')).toBe(true);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const privacy = await execute<{
      secret: boolean;
      audio: number;
      focus: string;
      cancel: boolean;
      lang: string;
      overflow: boolean;
    }>(`
      const ui=await import('./sdk/ui/index.js');const stage=document.querySelector('#stage');
      let stopped=0;stage.append(document.createTextNode('SECRET_PRIVATE_CAPTION'));
      const privateControl=document.createElement('button');privateControl.setAttribute('aria-label','SECRET_PRIVATE_ARIA');stage.append(privateControl);
      const announcement=document.createElement('div');announcement.setAttribute('aria-live','polite');announcement.textContent='SECRET_LIVE';document.body.append(announcement);
      ui.assertChildSafeView(stage,location.href);
      const forbidden=document.createElement('a');forbidden.href='https://example.invalid/';
      let denied=false;try{ui.assertChildSafeView(forbidden,location.href);}catch{denied=true;}
      if(!denied)throw new Error('Outbound-link negative control failed.');
      placement.select('jar');
      ui.replaceProjection(stage,doc=>{const next=doc.createElement('button');next.id='handoff';next.textContent='Передайте устройство';return next;},
        {stopAudio:()=>{stopped++;},clearAnnouncements:()=>announcement.replaceChildren(),cancelInput:()=>placement.cancel(),focus:()=>document.querySelector('#handoff')});
      const result={secret:document.body.textContent.includes('SECRET'),audio:stopped,
        focus:document.activeElement.id,cancel:placement.selected()===undefined,lang:stage.lang,
        overflow:document.documentElement.scrollWidth>innerWidth};
      unbindItem();unbindSlot();return result;
    `);
    expect(privacy).toEqual({
      secret: false,
      audio: 1,
      focus: 'handoff',
      cancel: true,
      lang: 'ru',
      overflow: false,
    });
    const accessibility = await page.send('Accessibility.getFullAXTree');
    expect(JSON.stringify(accessibility)).not.toContain('SECRET');
  });

  it('never marks interrupted/corrupt packs ready and protects retained revision activation', async () => {
    const resource = files.get(`${base}data.json`)!;
    const item = {
      id: 'data',
      src: 'data.json',
      bytes: resource.bytes.length,
      sha256: createHash('sha256').update(resource.bytes).digest('hex'),
      kind: 'data',
    };
    const html = files.get(`${base}index.html`)!;
    const second = {
      id: 'html',
      src: 'index.html',
      bytes: html.bytes.length,
      sha256: createHash('sha256').update(html.bytes).digest('hex'),
      kind: 'shell',
    };
    const result = await execute<{
      bad: string;
      missing: boolean;
      aborted: string;
      list: unknown[];
      blocked: string;
      mismatch: string;
      partialReady: boolean;
      boundary: string;
      active: string;
    }>(`
      const {OfflinePackStore}=await import('./sdk/offline/index.js');
      const statuses=[];const abort=new AbortController();
      globalThis.packStore=new OfflinePackStore({namespace:'pack-probe',baseUrl:new URL('.',location.href).href,onStatus:s=>{
        statuses.push(s.status);if(s.pack.revision==='aborted'&&s.completed===1)abort.abort();}});
      const good={id:'case',revision:'r1',resources:[${JSON.stringify(item)}]};
      let bad,aborted,blocked,mismatch,boundary;
      try{await packStore.install({...good,revision:'bad',resources:[{...good.resources[0],sha256:'0'.repeat(64)}]});}catch(error){bad=error.code;}
      const missing=await packStore.inspect({id:'case',revision:'bad'})===undefined;
      try{await packStore.install({...good,revision:'aborted',resources:[...good.resources,${JSON.stringify(second)}]},abort.signal);}catch(error){aborted=error.code;}
      const partialReady=await packStore.inspect({id:'case',revision:'aborted'})!==undefined;
      await packStore.install(good);
      await packStore.activate(good,()=>true,true);
      const nextBytes=new TextEncoder().encode('{"revision":"r2","clue":"updated"}');
      const nextHash=await crypto.subtle.digest('SHA-256',nextBytes);
      const nextDigest=Array.from(new Uint8Array(nextHash)).map(v=>v.toString(16).padStart(2,'0')).join('');
      const next={...good,revision:'r2',resources:[{...good.resources[0],src:'data-next.json',bytes:nextBytes.length,sha256:nextDigest}]};
      await packStore.install(next);
      const release=packStore.retain(good);
      try{await packStore.remove(good,good);}catch(error){blocked=error.code;}
      try{await packStore.activate(next,()=>false,true);}catch(error){mismatch=error.code;}
      try{await packStore.activate(next,()=>true,false);}catch(error){boundary=error.code;}
      const list=await packStore.list();release();
      return {bad,missing,aborted,list,blocked,mismatch,partialReady,boundary,active:packStore.activePack().revision};
    `);
    expect(result).toEqual({
      bad: 'asset',
      missing: true,
      aborted: 'cancelled',
      list: [
        { id: 'case', revision: 'r1' },
        { id: 'case', revision: 'r2' },
      ],
      blocked: 'blocked',
      mismatch: 'incompatible',
      partialReady: false,
      boundary: 'blocked',
      active: 'r1',
    });
  });

  it('cold-starts from a revision-pinned service worker after a real browser restart with all app network denied', async () => {
    const graph = [...files.entries()]
      .filter(([path]) => !path.endsWith('.wav'))
      .map(([path, file], index) => ({
        id: `resource-${index}`,
        src: path.slice(base.length),
        bytes: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        kind: path.endsWith('.html') ? 'shell' : path.endsWith('.json') ? 'data' : 'script',
      }));
    add(
      'sw.js',
      `import {OfflinePackStore,attachOfflineWorker} from './sdk/offline/index.js';
      const store=new OfflinePackStore({namespace:'cold-start',baseUrl:new URL('./',self.location.href).href});
      attachOfflineWorker(self,store,{packs:[{id:'shell',revision:'r1'}],shell:'index.html',onError:()=>{}});`,
    );
    await execute(`
      const {OfflinePackStore,registerOfflineWorker}=await import('./sdk/offline/index.js');
      const {IndexedDbSaveStorage}=await import('./sdk/save/indexeddb.js');
      const storage=new IndexedDbSaveStorage('offline-progress');
      await storage.compareAndSwap({gameId:'lab',profileId:'p1'},0,{revision:1,payload:'resumed-mid-puzzle'});
      await storage.close();
      const store=new OfflinePackStore({namespace:'cold-start',baseUrl:new URL('.',location.href).href});
      await store.install({id:'shell',revision:'r1',resources:${JSON.stringify(graph)}});
      await registerOfflineWorker('sw.js',new URL('.',location.href).href);
      await navigator.serviceWorker.ready;
    `);
    const profile = browser.profile;
    const args = browser.process.spawnargs.slice(1);
    page.close();
    await closeOwnedBrowser(browser);
    denied = true;
    deniedRequests = 0;
    expect((await fetch(`${origin}${base}`)).status).toBe(503);
    rmSync(join(profile, 'DevToolsActivePort'), { force: true });
    const child = spawn(findBrowser(), args, { stdio: 'ignore' });
    let port = 0;
    const deadline = Date.now() + 20_000;
    while (!port && Date.now() < deadline) {
      try {
        port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    browser = { process: child, profile, port };
    expect(port).toBeGreaterThan(0);
    page = await openPage(port, `${origin}${base}`);
    await until(page, 'globalThis.fixtureReady', (value) => value === true, 20_000);
    expect(await execute('return document.querySelector("#stage").textContent;')).toBe(
      'resumed-mid-puzzle',
    );
    expect(await execute('return !!navigator.serviceWorker.controller;')).toBe(true);
    const details = await execute<{ browser: string; packs: unknown[] }>(`
      const {OfflinePackStore}=await import('./sdk/offline/index.js');
      const store=new OfflinePackStore({namespace:'cold-start',baseUrl:new URL('.',location.href).href});
      return {browser:navigator.userAgent,packs:await store.list()};`);
    expect(details.packs).toEqual([{ id: 'shell', revision: 'r1' }]);
    expect(details.browser).toContain('Chrome');
    // The failed-network control above must fire; a worker update check may add denied attempts.
    expect(deniedRequests).toBeGreaterThan(0);
  }, 120_000);
});

describe('browser lifecycle review regressions', () => {
  beforeAll(async () => {
    denied = false;
    await execute(`if(navigator.serviceWorker.controller){
      const registration=await navigator.serviceWorker.getRegistration();await registration?.unregister();
    }`);
    page.close();
    page = await openPage(browser.port, `${origin}${base}`);
    await until(page, 'globalThis.fixtureReady', (value) => value === true, 15_000);
  });

  it('regression: stale effect rejection cannot change replacement narration, captions or ducking', async () => {
    await page.send('Page.bringToFront');
    await click(page, 20, 20);
    const result = await execute<{
      before: { status: string; voices: number; line: string; gain: number; publications: number };
      after: { status: string; voices: number; line: string; gain: number; publications: number };
      caption: string;
      completions: number;
    }>(`
      const {createNarration}=await import('./sdk/audio/index.js');
      let rejectEffect,entered;
      const requested=new Promise(resolve=>{entered=resolve;});
      const states=[],captions=[],gains=[];let completions=0;
      const sound=createNarration({baseUrl:location.href,onState:s=>states.push(s),onCaption:l=>captions.push(l?.caption),
        onComplete:()=>{completions++;},contextFactory:()=>{const ctx=new AudioContext();
          const create=ctx.createGain.bind(ctx);ctx.createGain=()=>{const node=create();gains.push(node);return node;};return ctx;},
        fetch:(input,init)=>String(input).endsWith('held-effect.wav')?new Promise((_resolve,reject)=>{rejectEffect=reject;entered();}):fetch(input,init)});
      sound.registerPack({id:'p',revision:'r1',assets:[{id:'late',src:'held-effect.wav'},{id:'line',src:'audio.wav'}],
        lines:[{id:'new',asset:'line',caption:'Replacement caption'}]});
      await sound.unlock();
      const old=sound.playEffect('p','late').catch(error=>error.code);
      await requested;sound.clear();
      await sound.playLine('p','new');await sound.setAtmosphere({packId:'p',asset:'line'});
      const snapshot=()=>({status:sound.state().status,voices:sound.state().voices,line:sound.state().line.id,
        gain:gains[1].gain.value,publications:states.length});
      const before=snapshot();rejectEffect(new Error('obsolete network failure'));await old;
      const after=snapshot(),caption=captions.at(-1);
      await sound.dispose();return {before,after,caption,completions};
    `);
    expect(result.before).toMatchObject({ status: 'playing', voices: 2, line: 'new' });
    expect(result.before.gain).toBeCloseTo(0.35);
    expect(result.after).toEqual(result.before);
    expect(result.caption).toBe('Replacement caption');
    expect(result.completions).toBe(0);
  });

  it('regression: ambience-only interruption publishes blocked state and recovers one loop, not silence', async () => {
    await page.send('Page.bringToFront');
    await click(page, 20, 20);
    const interrupted = await execute<{
      status: string;
      reportedVoices: number;
      actualVoices: number;
      error: string;
      resume: string;
    }>(`
      const {createNarration}=await import('./sdk/audio/index.js');
      globalThis.ambientStates=[];
      globalThis.ambient=createNarration({baseUrl:location.href,onState:s=>ambientStates.push(s),
        contextFactory:()=>{globalThis.ambientContext=new AudioContext();return ambientContext;}});
      ambient.registerPack({id:'p',revision:'r1',assets:[{id:'loop',src:'audio.wav'}],lines:[]});
      await ambient.unlock();await ambient.setAtmosphere({packId:'p',asset:'loop'});
      const changed=new Promise(resolve=>ambientContext.addEventListener('statechange',resolve,{once:true}));
      await ambientContext.suspend();await changed;
      let resume='resolved';try{await ambient.resume();}catch(error){resume=error.code;}
      const latest=ambientStates.at(-1);
      document.querySelector('#unlock').onclick=()=>ambient.unlock().catch(error=>{globalThis.ambientUnlockFailure=error.code;});
      return {status:latest.status,reportedVoices:latest.voices,actualVoices:ambient.state().voices,error:latest.error?.code,resume};
    `);
    expect(interrupted).toEqual({
      status: 'blocked',
      reportedVoices: 0,
      actualVoices: 0,
      error: 'blocked',
      resume: 'blocked',
    });
    await click(page, 20, 20);
    await until(page, 'ambient.state().voices', (value) => value === 1, 10_000);
    expect(
      await execute(`
      await ambient.unlock();await ambient.unlock();
      const ready={voices:ambient.state().voices,status:ambient.state().status,error:ambient.state().error??null};
      await ambient.setAtmosphere(null);
      const changed=new Promise(resolve=>ambientContext.addEventListener('statechange',resolve,{once:true}));
      await ambientContext.suspend();await changed;await ambient.unlock();
      const silent=ambient.state().voices;await ambient.dispose();return {ready,silent};
    `),
    ).toEqual({ ready: { voices: 1, status: 'idle', error: null }, silent: 0 });
  });

  it('regression: activation verification and pending removal cannot lose retained pack bytes', async () => {
    const resource = files.get(`${base}data.json`)!;
    const entry = {
      id: 'data',
      src: 'data.json',
      bytes: resource.bytes.length,
      sha256: createHash('sha256').update(resource.bytes).digest('hex'),
      kind: 'data',
    };
    const result = await execute<{
      removal: string;
      activation: string;
      remains: boolean;
      hold: string;
      removed: string;
    }>(`
      const {OfflinePackStore}=await import('./sdk/offline/index.js');
      let gate=false,enter,release;
      const entered=new Promise(resolve=>{enter=resolve;});
      const pending=new Promise(resolve=>{release=resolve;});
      const instrumented={randomUUID:crypto.randomUUID.bind(crypto),getRandomValues:crypto.getRandomValues.bind(crypto),
        subtle:new Proxy(crypto.subtle,{get(target,key){
          const member=Reflect.get(target,key,target);
          if(key==='digest')return async(...args)=>{const digest=await member.apply(target,args);
            if(gate){gate=false;enter();await pending;}return digest;};
          return typeof member==='function'?member.bind(target):member;
        }})};
      const store=new OfflinePackStore({namespace:'lifecycle-races',baseUrl:new URL('.',location.href).href,crypto:instrumented});
      const active={id:'active',revision:'r1',resources:[${JSON.stringify(entry)}]};
      const held={...active,id:'held'};
      await store.install(active);await store.install(held);
      gate=true;
      const activating=store.activate(active,()=>true,true).then(()=> 'activated',error=>error.code);
      await entered;
      const removal=await store.remove(active,active).then(()=> 'removed',error=>error.code);
      release();const activation=await activating;
      const remains=await store.inspect(active)!==undefined;
      const removing=store.remove(held,held);
      let hold='retained',end;
      try{end=store.retain(held);}catch(error){hold=error.code;}
      const removed=await removing.then(()=> 'removed',error=>error.code);
      end?.();
      return {removal,activation,remains,hold,removed};
    `);
    expect(result).toEqual({
      removal: 'blocked',
      activation: 'activated',
      remains: true,
      hold: 'blocked',
      removed: 'removed',
    });
  });

  it('regression: touch dragging survives the browser pan threshold while outside scrolling and tap placement remain available', async () => {
    const fresh = await openPage(browser.port, `${origin}${base}`, { width: 480, height: 800 });
    try {
      await until(fresh, 'globalThis.fixtureReady', (value) => value === true, 15_000);
      await fresh.send('Page.bringToFront');
      await fresh.send('Emulation.setDeviceMetricsOverride', {
        width: 480,
        height: 800,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await fresh.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      await evaluate(
        fresh,
        `(async()=>{
        const {createPlacement,bindPlacementItem,bindPlacementSlot}=await import('./sdk/ui/index.js');
        const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';document.head.append(viewport);
        document.body.replaceChildren();document.body.style.cssText='margin:0;height:2400px;background:#eee;';
        globalThis.touchMoves=[];globalThis.touchErrors=[];globalThis.cancelledPointers=0;globalThis.touchSelection=null;globalThis.touchPublications=0;
        const item=document.createElement('button');item.id='touch-item';item.textContent='Select or drag';
        item.style.cssText='position:absolute;left:40px;top:340px;width:180px;height:90px;touch-action:pan-y pinch-zoom;';
        item.style.setProperty('touch-action','pan-y pinch-zoom','important');
        const slot=document.createElement('button');slot.id='touch-slot';slot.textContent='Destination';
        slot.style.cssText='position:absolute;left:40px;top:120px;width:180px;height:90px;';
        document.body.append(item,slot);
        const placement=createPlacement({validate:()=>({ok:true}),commit:(item,slot)=>{touchMoves.push([item,slot]);},
          onChange:state=>{touchSelection=state.selected??null;touchPublications++;},onError:error=>touchErrors.push(error.code)});
        item.addEventListener('pointercancel',()=>{cancelledPointers++;});
        globalThis.unbindTouch=bindPlacementItem(item,'jar',placement,{slotAt:(x,y)=>{
          const r=slot.getBoundingClientRect();return x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom?'slot':undefined;
        },onError:error=>touchErrors.push(error.code)});
        globalThis.unbindDestination=bindPlacementSlot(slot,'slot',placement,error=>touchErrors.push(error.code));
        globalThis.touchEvents=[];
        document.addEventListener('pointerdown',event=>touchEvents.push({target:event.target.id,x:event.clientX,y:event.clientY}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      })()`,
      );
      await until<number>(fresh, 'innerWidth', (value) => value === 480, 5000);
      expect(await evaluate(fresh, 'document.elementFromPoint(120,385)?.id')).toBe('touch-item');
      const touch = (type: string, x?: number, y?: number): Promise<unknown> =>
        fresh.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: x === undefined ? [] : [{ x, y, id: 1 }],
        });
      await touch('touchStart', 120, 385);
      for (const y of [355, 315, 270, 220, 165]) await touch('touchMove', 120, y);
      await touch('touchEnd');
      expect(
        await evaluate(
          fresh,
          '({moves:touchMoves,cancelled:cancelledPointers,scroll:scrollY,events:touchEvents})',
        ),
      ).toEqual({
        moves: [['jar', 'slot']],
        cancelled: 0,
        scroll: 0,
        events: [{ target: 'touch-item', x: 120, y: 385 }],
      });
      await fresh.send('Input.synthesizeTapGesture', {
        x: 120,
        y: 385,
        duration: 80,
        gestureSourceType: 'touch',
      });
      await until(fresh, 'touchSelection', (value) => value === 'jar', 5000);
      expect(
        await evaluate(
          fresh,
          `(()=>{const before=touchPublications;
        document.querySelector('#touch-item').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
        return touchPublications-before;})()`,
        ),
      ).toBe(0);
      await fresh.send('Input.synthesizeTapGesture', {
        x: 120,
        y: 165,
        duration: 80,
        gestureSourceType: 'touch',
      });
      await until(fresh, 'touchMoves.length', (value) => value === 2, 5000);
      expect(
        await evaluate(
          fresh,
          `(()=>{const before=touchPublications;
        document.querySelector('#touch-slot').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
        return touchPublications-before;})()`,
        ),
      ).toBe(0);
      await touch('touchStart', 400, 600);
      for (const y of [560, 500, 440, 380]) await touch('touchMove', 400, y);
      await touch('touchEnd');
      await until<number>(fresh, 'scrollY', (value) => value > 50, 5000);
      expect(
        await evaluate(
          fresh,
          `(()=>{unbindTouch();unbindDestination();return {
        restored:document.querySelector('#touch-item').style.touchAction,body:getComputedStyle(document.body).touchAction,
        priority:document.querySelector('#touch-item').style.getPropertyPriority('touch-action'),
        viewport:document.querySelector('meta[name=viewport]').content,errors:touchErrors,moves:touchMoves.length};})()`,
        ),
      ).toEqual({
        restored: 'pan-y pinch-zoom',
        priority: 'important',
        body: 'auto',
        viewport: 'width=device-width, initial-scale=1',
        errors: [],
        moves: 2,
      });
    } finally {
      await fresh.send('Page.navigate', { url: 'about:blank' });
      fresh.close();
    }
  });

  it('regression: a controlled r1 page installs changed and new r2 URLs without switching its pinned gameplay', async () => {
    add(
      'update/index.html',
      '<!doctype html><title>Controlled update</title><main>r1 session</main>',
      'text/html',
    );
    add('update/shared.txt', 'old-content', 'text/plain');
    const graph = [...files.entries()]
      .filter(
        ([path]) =>
          path.includes('/sdk/') ||
          path === `${base}update/index.html` ||
          path === `${base}update/shared.txt`,
      )
      .map(([path, file], index) => ({
        id: `update-${index}`,
        src: path.slice(base.length),
        bytes: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        kind: path.endsWith('.html') ? 'shell' : path.endsWith('.txt') ? 'data' : 'script',
      }));
    add(
      'update/sw.js',
      `import {OfflinePackStore,attachOfflineWorker} from '../sdk/offline/index.js';
      const store=new OfflinePackStore({namespace:'controlled-update',baseUrl:new URL('../',self.location.href).href});
      attachOfflineWorker(self,store,{packs:[{id:'case',revision:'r1'}],shell:'update/index.html',onError:()=>{}});`,
    );
    await execute(`
      const {OfflinePackStore,registerOfflineWorker}=await import('./sdk/offline/index.js');
      const store=new OfflinePackStore({namespace:'controlled-update',baseUrl:new URL('.',location.href).href});
      await store.install({id:'case',revision:'r1',resources:${JSON.stringify(graph)}});
      const registration=await registerOfflineWorker('sw.js',new URL('./update/',location.href).href);
      if(!registration.active)await new Promise((resolve,reject)=>{
        const worker=registration.installing??registration.waiting;
        if(!worker)return reject(new Error('No installing update worker'));
        worker.addEventListener('statechange',()=>{if(worker.state==='activated')resolve();else if(worker.state==='redundant')reject(new Error('Worker failed'));});
      });
    `);
    const controlled = await openPage(browser.port, `${origin}${base}update/`);
    try {
      expect(await evaluate(controlled, '!!navigator.serviceWorker.controller')).toBe(true);
      expect(await evaluate(controlled, "fetch('./shared.txt').then(r=>r.text())")).toBe(
        'old-content',
      );
      add('update/shared.txt', 'new-content', 'text/plain');
      add('update/added.txt', 'new-resource', 'text/plain');
      const updated = graph.map((item) => {
        const bytes = files.get(`${base}${item.src}`)!.bytes;
        return {
          ...item,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      });
      const added = files.get(`${base}update/added.txt`)!.bytes;
      updated.push({
        id: 'added',
        src: 'update/added.txt',
        bytes: added.length,
        sha256: createHash('sha256').update(added).digest('hex'),
        kind: 'data',
      });
      expect(await (await fetch(`${origin}${base}update/shared.txt`)).text()).toBe('new-content');
      const result = await evaluate(
        controlled,
        `(async()=>{
        const {OfflinePackStore}=await import('../sdk/offline/index.js');
        const store=new OfflinePackStore({namespace:'controlled-update',baseUrl:new URL('../',location.href).href});
        let installed=true,code;
        try{await store.install({id:'case',revision:'r2',resources:${JSON.stringify(updated)}});}catch(error){installed=false;code=error.code;}
        const r2=await store.inspect({id:'case',revision:'r2'});
        const next=r2?await (await store.response(r2,new Request(new URL('./shared.txt',location.href)))).text():null;
        const added=r2?await (await store.response(r2,new Request(new URL('./added.txt',location.href)))).text():null;
        const playing=await (await fetch('./shared.txt')).text(),newStatus=(await fetch('./added.txt')).status;
        return {installed,code,next,added,playing,newStatus,controlled:!!navigator.serviceWorker.controller};
      })()`,
      );
      expect(result).toEqual({
        installed: true,
        next: 'new-content',
        added: 'new-resource',
        playing: 'old-content',
        newStatus: 503,
        controlled: true,
      });
    } finally {
      await evaluate(
        controlled,
        'navigator.serviceWorker.getRegistration().then(r=>r.unregister())',
      );
      await controlled.send('Page.navigate', { url: 'about:blank' });
      controlled.close();
    }
  }, 120_000);
});

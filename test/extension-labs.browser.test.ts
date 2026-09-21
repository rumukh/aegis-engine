import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveLabs } from '../scripts/serve-labs.mjs';
import { repositoryRoot } from '../scripts/sdk-tools.mjs';
import { createKitchen, kitchenTrace, loadKitchenContent } from '../poc/turn-kitchen-lab/model.js';
import { requireValue, validateRuntimeSnapshot } from '@aegis/runtime';
import { saveKey } from '@aegis/browser/save';
import type { SaveHistory } from '@aegis/browser/save';
import {
  click,
  evaluate,
  findBrowser,
  key,
  launchBrowser,
  openPage,
  sleep,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';

const viewport = { width: 1000, height: 800 };
let directory: string;
let consumerDirectory: string;
let siteDirectory: string;
let preview: Awaited<ReturnType<typeof serveLabs>>;
let browser: LaunchedBrowser;
let page: CdpSession;
let denied = false;

const execute = <T>(body: string): Promise<T> => evaluate(page, `(async () => { ${body} })()`);
async function open(route: string, recovery = false): Promise<void> {
  page?.close();
  page = await openPage(browser.port, preview.url + route + '/', viewport);
  await until(
    page,
    recovery
      ? '!!document.querySelector("[data-testid=startup-recovery]")'
      : '!!document.querySelector("[data-testid=family-toggle], [data-testid=begin], [data-testid=slots]") || !!document.querySelector(".slots")',
    (ready) => ready === true,
    20_000,
  );
}
async function activate(id: string, method: 'keyboard' | 'pointer' = 'keyboard'): Promise<void> {
  const selector = `[data-testid="${id}"]`;
  const rect = await execute<{ x: number; y: number; checkbox: boolean }>(`
    const button=document.querySelector(${JSON.stringify(selector)});
    if(!button) throw new Error('Missing reference control ${id}');
    button.scrollIntoView({block:'center'}); button.focus();
    const r=button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,checkbox:button.type==='checkbox'};
  `);
  if (method === 'keyboard') {
    const code = rect.checkbox ? 'Space' : 'Enter';
    await key(page, code, true);
    await key(page, code, false);
  } else await click(page, rect.x, rect.y);
  await until(
    page,
    '!document.querySelector("button[aria-busy=true]")',
    (ready) => ready === true,
    15_000,
  );
  await until(
    page,
    'document.querySelector("[data-testid=save-status]")?.textContent !== "Сохраняем…"',
    (ready) => ready === true,
    15_000,
  );
}
async function profileRecord(
  gameId: string,
  operation: 'read' | 'write' | 'delete' = 'read',
  value?: unknown,
): Promise<SaveHistory | undefined> {
  return execute(`
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('aegis-reference-labs',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try { return await new Promise((resolve,reject)=>{
      const tx=db.transaction('saves',${JSON.stringify(operation === 'read' ? 'readonly' : 'readwrite')});
      const store=tx.objectStore('saves'),key=${JSON.stringify(saveKey({ gameId, profileId: 'default' }))};
      const request=${operation === 'read' ? 'store.get(key)' : operation === 'delete' ? 'store.delete(key)' : `store.put(${JSON.stringify(value)},key)`};
      let result;request.onsuccess=()=>{result=request.result};tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
    }); } finally {db.close();}
  `);
}
async function settledSave(): Promise<void> {
  await until(
    page,
    'document.querySelector("[data-testid=save-status]")?.textContent',
    (value) => value === 'Сохранено на устройстве.',
    15_000,
  );
}
async function tap(id: string): Promise<void> {
  const selector = JSON.stringify(`[data-testid="${id}"]`);
  await until(
    page,
    `(() => {
      const control=document.querySelector(${selector});
      if(!control) return false;
      const bounds=control.getBoundingClientRect();
      return bounds.width>0 && bounds.height>0 && !control.matches(':disabled') &&
        control.getAttribute('aria-disabled')!=='true' && document.fonts.status==='loaded';
    })()`,
    (ready) => ready === true,
    15_000,
  );
  const point = await execute<{ x: number; y: number }>(`
    await document.fonts.ready;
    const control=document.querySelector(${selector});
    if(!control) throw new Error('Missing touch route ${id}');
    control.scrollIntoView({block:'center',behavior:'instant'});
    await new Promise(requestAnimationFrame);
    const current=document.querySelector(${selector});
    if(!current) throw new Error('Touch route disappeared: ${id}');
    const bounds=current.getBoundingClientRect();
    const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
    const hit=document.elementFromPoint(x,y);
    if(!hit || !current.contains(hit)) throw new Error('Touch route is not at its measured point: ${id}');
    return {x,y};`);
  await page.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 4, radiusY: 4 }],
  });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(
    page,
    '!document.querySelector("button[aria-busy=true]") && document.querySelector("[data-testid=save-status]")?.textContent !== "Сохраняем…"',
    (value) => value === true,
    15_000,
  );
}
async function saved(gameId: string) {
  const candidate = await execute<unknown>(`
    const database=await new Promise((resolve,reject)=>{const r=indexedDB.open('aegis-reference-labs',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try {
      const all=await new Promise((resolve,reject)=>{const r=database.transaction('saves').objectStore('saves').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const envelope=all.filter(value=>value.current).map(value=>JSON.parse(value.current.payload)).find(value=>value.gameId===${JSON.stringify(gameId)});
      return envelope?.state;
    } finally { database.close(); }
  `);
  return requireValue(validateRuntimeSnapshot(candidate));
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aegis-lab-browser-'));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const artifactDir = join(directory, 'artifacts');
  const command = promisify(execFile);
  await command(
    process.execPath,
    ['scripts/pack-sdk.mjs', '--revision', revision, '--allow-dirty', '--out', artifactDir],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const { stdout } = await command(
    process.execPath,
    ['scripts/test-standalone-consumer.mjs', '--artifacts', artifactDir, '--keep'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const consumer: {
    directory: string;
    site: { directory: string };
    version: string;
    sourceDigest: string;
  } = JSON.parse(stdout);
  consumerDirectory = consumer.directory;
  siteDirectory = consumer.site.directory;
  preview = await serveLabs({ directory: consumer.site.directory, allowRequest: () => !denied });
  const evidence = process.env.AEGIS_LAB_EVIDENCE;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'independent-consumer.json'), stdout);
  }
  browser = await launchBrowser({ viewport });
}, 240_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const clean = async (operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (cause) {
      failures.push(cause);
    }
  };
  await clean(() => page?.close());
  if (browser) await clean(() => closeOwnedBrowser(browser));
  await clean(() => stopExternalLagWitness());
  if (preview) await clean(() => preview.close());
  for (const path of [browser?.profile, directory, consumerDirectory]) {
    if (path)
      await clean(() =>
        rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
      );
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Reference browser cleanup failed; no cleanup failure is accepted as a pass.',
    );
});

describe('static reference applications in Chromium', () => {
  it('completes the turn trace via keyboard and click slots with the same authoritative checkpoint', async () => {
    await open('turn-kitchen-lab');
    await activate('begin');
    const idleState = await saved('turn-kitchen-lab');
    await activate('ambience', 'pointer');
    const frames = await execute<number>(`
      const animation=document.querySelector('.ambient-mark').getAnimations()[0];
      if(!animation) throw new Error('No independent presentation animation');
      let samples=0;
      for(let frame=0;frame<10000;frame++){animation.currentTime=frame*1000/60;getComputedStyle(document.querySelector('.ambient-mark')).transform;samples++;}
      return samples;
    `);
    expect(frames).toBe(10_000);
    expect(await saved('turn-kitchen-lab')).toEqual(idleState);
    await activate('silence');
    for (const id of [
      'slot-0',
      'slot-3',
      'hint',
      'purchase',
      'startB',
      'startA',
      'wait',
      'listen',
      'nextPhase',
      'finishShare',
    ]) {
      await activate(id);
    }
    const actual = await saved('turn-kitchen-lab');
    const content = loadKitchenContent(
      readFileSync(join(repositoryRoot, 'poc', 'turn-kitchen-lab', 'balance.json'), 'utf8'),
    );
    const expected = createKitchen(content);
    for (const action of kitchenTrace) requireValue(await expected.dispatch(action));
    expect(actual).toEqual(expected.snapshot());
    await expected.dispose();
    expect(
      await execute('return document.querySelector("[data-testid=save-status]").textContent;'),
    ).toBe('Сохранено на устройстве.');
    await open('turn-kitchen-lab');
    expect(await saved('turn-kitchen-lab')).toEqual(actual);
    expect(await execute('return document.body.textContent;')).toContain('Результат подарен');
  }, 120_000);

  it('resumes real Russian speech within 250ms and keeps replay outside the logical clock', async () => {
    await open('storybook-lab');
    await activate('choice-look');
    const before = await saved('storybook-lab');
    await activate('replay', 'pointer');
    await until(
      page,
      'document.querySelector("[data-testid=voice-status]").dataset.status',
      (value) => value === 'playing',
      15_000,
    );
    await sleep(650);
    await activate('pause');
    const paused = await execute<number>(
      'return Number(document.querySelector("[data-testid=voice-status]").dataset.offset);',
    );
    expect(paused).toBeGreaterThan(0.4);
    await sleep(300);
    expect(
      await execute(
        'return Number(document.querySelector("[data-testid=voice-status]").dataset.offset);',
      ),
    ).toBe(paused);
    await activate('resume');
    const resumed = await execute<number>(
      'return Number(document.querySelector("[data-testid=voice-status]").dataset.offset);',
    );
    expect(Math.abs(resumed - paused)).toBeLessThanOrEqual(0.25);
    await activate('replay');
    expect(
      await execute<number>(
        'return Number(document.querySelector("[data-testid=voice-status]").dataset.offset);',
      ),
    ).toBeLessThan(0.25);
    expect(await saved('storybook-lab')).toEqual(before);
    expect(
      await execute<number>(
        'return Number(document.querySelector("[data-testid=voice-status]").dataset.voices);',
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      await execute<number>(
        'return Number(document.querySelector("[data-testid=voice-status]").dataset.decodedBytes);',
      ),
    ).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);

  it('keeps private cards absent from handoff DOM/captions and restores only a neutral screen', async () => {
    await activate('family-toggle');
    expect(await execute('return document.body.textContent;')).not.toContain('На моей карточке');
    await activate('confirmPlayer');
    expect(await execute('return document.body.textContent;')).toContain(
      'На моей карточке тихое окно.',
    );
    await activate('nextPlayer');
    expect(await execute('return document.body.textContent;')).not.toContain('На моей карточке');
    expect(
      await execute('return document.querySelector("[data-testid=caption]").textContent;'),
    ).toBe('');
    await activate('confirmPlayer');
    expect(await execute('return document.body.textContent;')).toContain(
      'На моей карточке маленький сад.',
    );
    expect(await execute('return document.body.textContent;')).not.toContain(
      'На моей карточке тихое окно.',
    );
    await open('storybook-lab');
    await activate('family-toggle');
    expect(await execute('return document.body.textContent;')).not.toContain('На моей карточке');
    await activate('family-toggle');
  }, 120_000);

  it('completes story activities through bounded keyboard choices and resumes both partial arrangements', async () => {
    await activate('activity-scene');
    await execute(`
      const note=[...document.querySelectorAll('button')].find(button=>button.textContent==='Записка на столе');
      if(!note) throw new Error('Missing non-spatial scene route');
      note.dataset.testid='note-list';`);
    await activate('note-list');
    await activate('activity-notebook');
    await activate('hint');
    await activate('activity-matching');
    await activate('match-round');
    const matching = await saved('storybook-lab');
    await open('storybook-lab');
    expect(await saved('storybook-lab')).toEqual(matching);
    await activate('activity-matching');
    await activate('match-sun');
    await activate('activity-ordering');
    await activate('order-morning');
    expect(
      await execute('return document.querySelectorAll("[data-testid^=order-position-]").length;'),
    ).toBe(3);
    expect(
      await execute('return document.querySelectorAll("[data-testid=order-morning]").length;'),
    ).toBe(0);
    await activate('order-position-0');
    const ordering = await saved('storybook-lab');
    await open('storybook-lab');
    expect(await saved('storybook-lab')).toEqual(ordering);
    await activate('activity-ordering');
    await activate('order-day');
    await activate('order-position-1');
    await activate('order-evening');
    await activate('order-position-2');
    await activate('order-submit');
    await activate('activity-dialogue');
    await activate('choice-finish');
    const complete = await saved('storybook-lab');
    expect(complete.world.resources['aegis.runtime.state']).toMatchObject({
      story: { collected: { reward: ['scarf'] } },
      hints: { used: ['place-help'] },
    });
    await activate('activity-extras');
    await activate('generated');
    const generated = await saved('storybook-lab');
    await open('storybook-lab');
    expect(await saved('storybook-lab')).toEqual(generated);
  }, 120_000);

  it('scales Russian text to 200%, retains targets and uses a local Cyrillic font without outbound links', async () => {
    await activate('settings');
    await activate('largeText');
    await until(
      page,
      'document.documentElement.style.getPropertyValue("--aegis-text-scale")',
      (value) => value === '2',
      10_000,
    );
    await activate('reducedMotion');
    await execute('document.querySelector("dialog button[data-testid=close]").click();');
    const result = await execute<{
      fontSize: number;
      fontLoaded: boolean;
      overflow: boolean;
      small: number;
      requests: string[];
      outbound: number;
      globals: string[];
    }>(`
      await document.fonts.ready;
      const controls=[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0);
      return {
        fontSize:parseFloat(getComputedStyle(document.documentElement).fontSize),
        fontLoaded:document.fonts.check('24px "Lab Sans"','Алёна Ёжик'),
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        small:controls.filter(b=>{const r=b.getBoundingClientRect();return r.width<48||r.height<48}).length,
        requests:performance.getEntriesByType('resource').map(r=>r.name),
        outbound:[...document.querySelectorAll('a[href]')].filter(a=>new URL(a.href).origin!==location.origin).length,
        globals:Object.keys(window).filter(k=>k==='aegis'||k==='__aegis'||k==='fixtureReady')
      };
    `);
    expect(result.fontSize).toBe(48);
    expect(result.fontLoaded).toBe(true);
    expect(result.overflow).toBe(false);
    expect(result.small).toBe(0);
    expect(result.outbound).toBe(0);
    expect(result.globals).toEqual([]);
    expect(result.requests.some((url) => url.endsWith('NotoSans.ttf'))).toBe(true);
    expect(result.requests.every((url) => url.startsWith(preview.url))).toBe(true);
    const evidence = process.env.AEGIS_LAB_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      const png = await page.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      writeFileSync(join(evidence, 'storybook-200-percent.png'), Buffer.from(png.data, 'base64'));
      writeFileSync(
        join(evidence, 'browser-layout.json'),
        JSON.stringify(
          { ...result, userAgent: await execute('return navigator.userAgent;') },
          null,
          2,
        ),
      );
    }
  }, 120_000);

  it('continues accepted multi-turn work after checkpoint retry, user resume and intermediate reload', async () => {
    const original = await profileRecord('turn-kitchen-lab');
    const content = loadKitchenContent(
      readFileSync(join(repositoryRoot, 'poc', 'turn-kitchen-lab', 'balance.json'), 'utf8'),
    );
    const expected = createKitchen(content);
    for (const index of [0, 4, 5, 6]) requireValue(await expected.dispatch(kitchenTrace[index]!));
    try {
      for (const recovery of ['retry', 'resume', 'reload']) {
        await profileRecord('turn-kitchen-lab', 'delete');
        await open('turn-kitchen-lab');
        for (const id of ['begin', 'startB', 'startA']) await activate(id);
        await execute(`
          globalThis.__originalPut=IDBObjectStore.prototype.put;let hit=false;
          IDBObjectStore.prototype.put=function(value,...args){
            const request=__originalPut.call(this,value,...args);
            const envelope=value?.current ? JSON.parse(value.current.payload) : null;
            if(!hit&&envelope?.gameId==='turn-kitchen-lab'&&envelope.state.turn===1){
              hit=true;
              ${recovery === 'retry' ? 'this.transaction.abort();' : `request.addEventListener('success',()=>document.querySelector('[data-testid=pause]').click(),{once:true});`}
            }
            return request;
          };`);
        await activate('wait');
        if (recovery === 'retry') {
          expect(
            await execute(
              'return document.querySelector("[data-testid=save-status]").textContent;',
            ),
          ).toContain('не сохранён');
          expect((await saved('turn-kitchen-lab')).turn).toBe(0);
          await activate('listen');
          expect((await saved('turn-kitchen-lab')).turn).toBe(0);
        } else {
          const midway = await saved('turn-kitchen-lab');
          expect(midway.turn).toBe(1);
          expect(midway.pending?.completedTurns).toBe(1);
        }
        await execute(
          'IDBObjectStore.prototype.put=__originalPut;delete globalThis.__originalPut;',
        );
        if (recovery === 'reload') await open('turn-kitchen-lab');
        else await activate(recovery);
        await settledSave();
        expect(await saved('turn-kitchen-lab')).toEqual(expected.snapshot());
      }
    } finally {
      await expected.dispose();
      if (original) await profileRecord('turn-kitchen-lab', 'write', original);
    }
  }, 120_000);

  it('keeps a genuine 390px layout at 200% text on both narrow reference routes', async () => {
    for (const route of ['storybook-lab', 'turn-kitchen-lab']) {
      await open(route);
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await activate('settings');
      const checked = await execute<boolean>(
        'return document.querySelector("[data-testid=largeText]").checked;',
      );
      if (!checked) await activate('largeText');
      await execute(
        'document.querySelector("dialog [data-testid=close]").click();await document.fonts.ready;',
      );
      const measure = await execute<{
        width: number;
        scroll: number;
        font: number;
        shells: number;
        headings: number;
        pauseButtons: number;
      }>(`
        return {width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,
          font:parseFloat(getComputedStyle(document.documentElement).fontSize),
          shells:document.querySelectorAll('#app > main').length,headings:document.querySelectorAll('main > h1').length,
          pauseButtons:document.querySelectorAll('[data-testid=pause]').length};`);
      expect(measure).toEqual({
        width: 390,
        scroll: 390,
        font: 48,
        shells: 1,
        headings: 1,
        pauseButtons: 1,
      });
      const evidence = process.env.AEGIS_LAB_EVIDENCE;
      if (evidence) {
        const png = await page.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
        });
        writeFileSync(join(evidence, route + '-narrow-200.png'), Buffer.from(png.data, 'base64'));
        writeFileSync(join(evidence, route + '-narrow-200.json'), JSON.stringify(measure, null, 2));
      }
    }
  }, 120_000);

  it('filters private information immediately even when saving the spoiler preference fails or never acknowledges', async () => {
    const original = await profileRecord('storybook-lab-preferences');
    try {
      for (const mode of ['fail', 'hold']) {
        await profileRecord('storybook-lab-preferences', 'delete');
        await open('storybook-lab');
        await activate('family-toggle');
        await activate('confirmPlayer');
        expect(await execute('return document.body.textContent;')).toContain('На моей карточке');
        await activate('settings');
        await execute(`
          globalThis.__originalPut=IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put=function(value,...args){
            const envelope=value?.current ? JSON.parse(value.current.payload) : null;
            if(envelope?.gameId==='storybook-lab-preferences'){
              ${mode === 'fail' ? `throw new Error('Injected preference failure');` : `const request=__originalPut.call(this,value,...args);this.transaction.oncomplete=()=>{};return request;`}
            }
            return __originalPut.call(this,value,...args);
          };`);
        await activate('spoiler');
        await execute('document.querySelector("dialog [data-testid=close]").click();');
        expect(await execute('return document.body.textContent;')).not.toContain(
          'На моей карточке',
        );
        expect(
          await execute('return document.querySelector("[data-testid=caption]").textContent;'),
        ).toBe('');
        if (mode === 'fail') {
          await until(
            page,
            'document.querySelector("[data-testid=status]").textContent',
            (value) => typeof value === 'string' && value.includes('не сохранена'),
            15_000,
          );
          expect(
            await execute('return document.querySelector("[data-testid=status]").textContent;'),
          ).toContain('не сохранена');
        }
        await execute(
          'IDBObjectStore.prototype.put=__originalPut;delete globalThis.__originalPut;',
        );
      }
    } finally {
      await execute(
        'if(globalThis.__originalPut){IDBObjectStore.prototype.put=__originalPut;delete globalThis.__originalPut;}',
      );
      if (original) await profileRecord('storybook-lab-preferences', 'write', original);
      else await profileRecord('storybook-lab-preferences', 'delete');
    }
  }, 120_000);

  it('rejects retained controls after another commit and after restoring the same numeric revision', async () => {
    const original = await profileRecord('storybook-lab');
    try {
      await profileRecord('storybook-lab', 'delete');
      await open('storybook-lab');
      await execute('globalThis.__oldTalk=document.querySelector("[data-testid=choice-talk]");');
      await activate('choice-look');
      const committed = await saved('storybook-lab');
      await execute('__oldTalk.click();await new Promise(resolve=>setTimeout(resolve,50));');
      expect(await saved('storybook-lab')).toEqual(committed);
      await execute('globalThis.__oldTalk=document.querySelector("[data-testid=choice-talk]");');
      await activate('load');
      await execute(
        '__oldTalk.click();await new Promise(resolve=>setTimeout(resolve,50));delete globalThis.__oldTalk;',
      );
      expect(await saved('storybook-lab')).toEqual(committed);
      await activate('choice-talk');
      expect((await saved('storybook-lab')).revision).toBe(committed.revision + 1);
    } finally {
      if (original) await profileRecord('storybook-lab', 'write', original);
    }
  }, 120_000);

  it('keeps invalid startup records until validated import or explicit profile-scoped reset consent', async () => {
    const original = await profileRecord('storybook-lab');
    const unrelated = await profileRecord('turn-kitchen-lab');
    if (!original?.current) throw new Error('Recovery positive control requires saved progress');
    const backup = original.current.payload;
    const malformed = [
      '{broken JSON',
      JSON.stringify({ ...JSON.parse(backup), contentRevision: 'uninstalled-content' }),
      JSON.stringify({ ...JSON.parse(backup), formatVersion: 99 }),
    ];
    for (const payload of malformed) {
      const corrupt = { ...original, current: { ...original.current, payload } };
      await profileRecord('storybook-lab', 'write', corrupt);
      await open('storybook-lab', true);
      expect(await execute('return !!document.querySelector("[data-testid=choice-look]");')).toBe(
        false,
      );
      expect(await profileRecord('storybook-lab')).toEqual(corrupt);
      await execute(`
        const transfer=new DataTransfer();transfer.items.add(new File(['invalid'], 'invalid.json',{type:'application/json'}));
        document.querySelector('[data-testid=recovery-file]').files=transfer.files;`);
      await activate('recovery-recoveryImport');
      expect(await profileRecord('storybook-lab')).toEqual(corrupt);
      await execute(`
        const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(backup)}], 'backup.json',{type:'application/json'}));
        document.querySelector('[data-testid=recovery-file]').files=transfer.files;`);
      await activate('recovery-recoveryImport');
      await until(
        page,
        '!!document.querySelector("[data-testid=family-toggle]")',
        (value) => value === true,
        15_000,
      );
      expect((await saved('storybook-lab')).world).toEqual(JSON.parse(backup).state.world);
    }
    const corrupt = { ...original, current: { ...original.current, payload: malformed[0]! } };
    await profileRecord('storybook-lab', 'write', corrupt);
    await open('storybook-lab', true);
    await activate('recovery-reset');
    expect(await profileRecord('storybook-lab')).toEqual(corrupt);
    await activate('recovery-cancel');
    expect(await profileRecord('storybook-lab')).toEqual(corrupt);
    await activate('recovery-reset');
    await activate('recovery-confirmReset');
    await until(
      page,
      '!!document.querySelector("[data-testid=family-toggle]")',
      (value) => value === true,
      15_000,
    );
    expect((await profileRecord('storybook-lab'))?.current).toBeUndefined();
    expect(await profileRecord('turn-kitchen-lab')).toEqual(unrelated);
    await profileRecord('storybook-lab', 'write', original);
    await open('storybook-lab');
  }, 120_000);

  it('waits for a newly presented touch target rather than treating input delivery as UI completion', async () => {
    await open('storybook-lab');
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const pending = Promise.allSettled([tap('deferred-touch-control')]);
    try {
      await execute(`
        const control=document.createElement('button');
        control.dataset.testid='deferred-touch-control';
        control.textContent='Deferred control';
        control.style.cssText='position:fixed;left:20px;top:20px;width:150px;height:60px;z-index:10000';
        control.addEventListener('click',event=>{
          control.dataset.count=String(Number(control.dataset.count??0)+1);
          control.dataset.trusted=String(event.isTrusted);
        });
        document.body.append(control);`);
      const [result] = await pending;
      if (result?.status === 'rejected') throw result.reason;
      expect(result?.status).toBe('fulfilled');
      await until(
        page,
        'document.querySelector("[data-testid=deferred-touch-control]")?.dataset.count',
        (count) => count === '1',
        15_000,
      );
      expect(
        await execute(
          'return document.querySelector("[data-testid=deferred-touch-control]").dataset.trusted;',
        ),
      ).toBe('true');
    } finally {
      await execute('document.querySelector("[data-testid=deferred-touch-control]")?.remove();');
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  });

  it.each(['cached', 'uncached'])(
    'completes both reference gameplay routes using real emulated touch events, help/back and settings (%s navigation)',
    async (cacheMode) => {
      const storyRecord = await profileRecord('storybook-lab');
      const kitchenRecord = await profileRecord('turn-kitchen-lab');
      const preferences = await profileRecord('storybook-lab-preferences');
      try {
        for (const id of ['storybook-lab', 'turn-kitchen-lab', 'storybook-lab-preferences'])
          await profileRecord(id, 'delete');
        await open('storybook-lab');
        await page.send('Network.setCacheDisabled', { cacheDisabled: cacheMode === 'uncached' });
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await tap('help');
        await tap('close');
        await tap('replay');
        await tap('pause');
        await tap('resume');
        await tap('settings');
        await tap('comfort');
        await tap('close');
        await tap('map');
        await tap('roomLocation');
        await tap('choice-look');
        await tap('activity-scene');
        await execute(
          `document.querySelector('[aria-label="Найди записку"] button').dataset.testid='touch-note';`,
        );
        await tap('touch-note');
        await tap('activity-notebook');
        await tap('hint');
        await tap('mark-shape-sun');
        await tap('activity-matching');
        await tap('match-round');
        await tap('match-sun');
        await tap('activity-ordering');
        for (const [item, index] of [
          ['morning', 0],
          ['day', 1],
          ['evening', 2],
        ]) {
          await tap('order-' + item);
          await tap('order-position-' + index);
        }
        await tap('order-submit');
        await tap('activity-dialogue');
        await tap('choice-finish');
        await tap('scarf');
        await tap('family-toggle');
        await tap('confirmPlayer');
        await tap('nextPlayer');
        expect(await execute('return document.body.textContent;')).not.toContain(
          'На моей карточке',
        );
        await tap('confirmPlayer');
        await tap('family-toggle');
        expect((await saved('storybook-lab')).world.resources['aegis.runtime.state']).toMatchObject(
          {
            scarf: true,
            story: { collected: { reward: ['scarf'] } },
          },
        );
        await execute(
          `document.querySelector('main>nav a[href$="/turn-kitchen-lab/"]').dataset.testid='touch-kitchen-link';`,
        );
        await tap('touch-kitchen-link');
        await until(
          page,
          '!!document.querySelector("[data-testid=begin]")',
          (value) => value === true,
          15_000,
        );
        for (const id of [
          'help',
          'close',
          'begin',
          'slot-0',
          'slot-3',
          'hint',
          'purchase',
          'startB',
          'startA',
          'wait',
          'listen',
          'nextPhase',
          'finishShare',
        ])
          await tap(id);
        await settledSave();
        const expected = createKitchen(
          loadKitchenContent(
            readFileSync(join(repositoryRoot, 'poc', 'turn-kitchen-lab', 'balance.json'), 'utf8'),
          ),
        );
        for (const action of kitchenTrace) requireValue(await expected.dispatch(action));
        expect(await saved('turn-kitchen-lab')).toEqual(expected.snapshot());
        expect(
          await execute('return document.querySelector("[data-testid=status]").textContent;'),
        ).not.toBe('Это действие пока недоступно. Проверь состояние или попробуй снова.');
        await expected.dispose();
        const evidence = process.env.AEGIS_LAB_EVIDENCE;
        if (evidence)
          writeFileSync(
            join(evidence, 'touch-route.json'),
            JSON.stringify(
              {
                input:
                  'CDP touchStart/touchEnd; no keyboard, mouse click or element.click activation',
                targeting: 'DOM scrollIntoView for automated target positioning',
                viewport: { width: 390, height: 844 },
                story: [
                  'help/back',
                  'narration gesture/replay',
                  'map/room navigation',
                  'pause/resume',
                  'comfort setting',
                  'dialogue',
                  'scene list',
                  'notebook/hint/mark',
                  'matching',
                  'ordering',
                  'reward/avatar',
                  'two-player handoff',
                  'navigation exit',
                ],
                kitchen: ['help/back', ...kitchenTrace.map((action) => action.type)],
                notCovered: [
                  'physical touch device',
                  'software keyboard text entry',
                  'OS file picker/print dialog',
                ],
              },
              null,
              2,
            ),
          );
      } finally {
        await page.send('Network.setCacheDisabled', { cacheDisabled: false });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        if (storyRecord) await profileRecord('storybook-lab', 'write', storyRecord);
        if (kitchenRecord) await profileRecord('turn-kitchen-lab', 'write', kitchenRecord);
        if (preferences) await profileRecord('storybook-lab-preferences', 'write', preferences);
        await open('storybook-lab');
      }
    },
    120_000,
  );

  it('cold-starts both nested routes after browser restart with the entire HTTP origin denied', async () => {
    await activate('offline', 'pointer');
    await until(
      page,
      'document.querySelector("[data-testid=offline-status]").textContent',
      (value) => value !== 'Устанавливаем полный набор…',
      20_000,
    );
    const installed = await execute(
      'return document.querySelector("[data-testid=offline-status]").outerHTML;',
    );
    expect(installed).toContain('Этот набор установлен');
    await execute('await navigator.serviceWorker.ready;');
    await open('storybook-lab');
    expect(await execute('return !!navigator.serviceWorker.controller;')).toBe(true);
    const graphPath = join(siteDirectory, 'resource-graph.json');
    const assetPath = join(siteDirectory, 'assets', 'provenance.json');
    const originalGraph = readFileSync(graphPath, 'utf8');
    const originalAsset = readFileSync(assetPath, 'utf8');
    const graph = JSON.parse(originalGraph);
    const revisedAsset = JSON.stringify({ ...JSON.parse(originalAsset), updateFixture: true });
    const added = '{"revision":"next"}';
    writeFileSync(assetPath, revisedAsset);
    writeFileSync(join(siteDirectory, 'update-fixture.json'), added);
    graph.revision += '-next';
    for (const resource of graph.resources) {
      if (resource.src.endsWith('/assets/provenance.json')) {
        resource.sha256 = createHash('sha256').update(revisedAsset).digest('hex');
        resource.bytes = Buffer.byteLength(revisedAsset);
      }
    }
    graph.resources.push({
      id: 'new-update-fixture',
      src: new URL('update-fixture.json', preview.url).pathname,
      kind: 'data',
      bytes: Buffer.byteLength(added),
      sha256: createHash('sha256').update(added).digest('hex'),
    });
    writeFileSync(graphPath, JSON.stringify(graph));
    await activate('offline', 'pointer');
    await until(
      page,
      'document.querySelector("[data-testid=offline-status]").textContent',
      (value) => value !== 'Устанавливаем полный набор…',
      20_000,
    );
    expect(
      await execute('return document.querySelector("[data-testid=offline-status]").outerHTML;'),
    ).toContain('Этот набор установлен');
    expect(await execute('return (await fetch("../assets/provenance.json")).text();')).toBe(
      originalAsset,
    );
    writeFileSync(assetPath, originalAsset);
    writeFileSync(graphPath, originalGraph);
    const before = await saved('storybook-lab');
    const profile = browser.profile;
    const args = browser.process.spawnargs.slice(1);
    page.close();
    await closeOwnedBrowser(browser);
    denied = true;
    rmSync(join(profile, 'DevToolsActivePort'), { force: true });
    const child = spawn(findBrowser(), args, { stdio: 'ignore' });
    let port = 0;
    const deadline = Date.now() + 20_000;
    while (!port && Date.now() < deadline) {
      try {
        port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
        await sleep(50);
      }
    }
    browser = { process: child, profile, port };
    expect(port).toBeGreaterThan(0);
    await open('storybook-lab');
    expect(await execute('return !!navigator.serviceWorker.controller;')).toBe(true);
    expect(await saved('storybook-lab')).toEqual(before);
    await activate('scarf');
    expect((await saved('storybook-lab')).revision).toBe(before.revision + 1);
    await open('turn-kitchen-lab');
    expect(await execute('return document.body.textContent;')).toContain('Результат подарен');
    expect(await execute('return !!navigator.serviceWorker.controller;')).toBe(true);
  }, 120_000);

  it('renders and exports both print sizes without clipped cells or external resources', async () => {
    for (const paper of ['a4', 'letter']) {
      page.close();
      page = await openPage(browser.port, preview.url + `print-${paper}.html`, viewport);
      const geometry = await execute<{
        cells: number;
        clipped: number;
        outside: number;
        language: string;
      }>(`
        await document.fonts.ready;
        const cells=[...document.querySelectorAll('.item')];
        return {cells:cells.length,clipped:cells.filter(c=>c.scrollWidth>c.clientWidth+1||c.scrollHeight>c.clientHeight+1).length,
          outside:cells.filter(c=>{const a=c.getBoundingClientRect(),b=c.closest('.page').getBoundingClientRect();
            return a.left<b.left-1||a.top<b.top-1||a.right>b.right+1||a.bottom>b.bottom+1;}).length,language:document.documentElement.lang};
      `);
      expect(geometry).toEqual({ cells: 10, clipped: 0, outside: 0, language: 'ru' });
      const pdf = await page.send<{ data: string }>('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
      });
      const bytes = Buffer.from(pdf.data, 'base64');
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const evidence = process.env.AEGIS_LAB_EVIDENCE;
      if (evidence) {
        writeFileSync(join(evidence, `reference-${paper}.pdf`), bytes);
        writeFileSync(join(evidence, `print-${paper}.json`), JSON.stringify(geometry, null, 2));
      }
    }
  }, 120_000);
});

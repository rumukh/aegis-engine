import { describe, expect, it, vi } from 'vitest';
import type { GameMode } from '@aegis/core';
import { BINDINGS, SESSION_CONTROLS, CONTROLLER_SESSION_CONTROLS } from './bindings.js';
import type { PresentationManifest } from './presentation/schema.js';
import { PAGE_STYLE, renderCatalogBody, renderGameChrome } from './page-chrome.js';
import type { CatalogGame, GameChromeOptions } from './page-chrome.js';

const GAME: GameChromeOptions = {
  title: 'The Long Way Home',
  objective: 'Restore power and bring the crew home.',
  mode: 'platformer',
  bindings: BINDINGS.platformer,
  backHref: '../../',
};
const MANIFEST: PresentationManifest = {
  aegis: 'presentation/1',
  quality: 'low',
  audio: { cues: [{ event: 'power.restored', asset: 'power' }] },
  hud: {
    playerName: 'navigator',
    winEvent: 'expedition.complete',
    loseEvents: ['crew.lost'],
    steps: [{ id: 'power', label: 'Restore power', event: 'power.restored' }],
  },
  ui: { accent: '#addecf', eyebrow: 'A quiet expedition', cover: 'cover-art' },
};
const CATALOG_GAME: CatalogGame = {
  id: 'long-way',
  title: GAME.title,
  blurb: 'A short journey through a forgotten station.',
  mode: GAME.mode,
  bindings: GAME.bindings,
};

describe('shared play-page body', () => {
  it('creates accessible opt-in cutscene controls and escapes completion copy', () => {
    expect(renderGameChrome(GAME)).not.toContain('id="win-ending"');
    const html = renderGameChrome({
      ...GAME,
      manifest: {
        ...MANIFEST,
        ui: {
          winEnding: {
            model: 'set',
            clip: 'Departure',
            camera: { eye: 'eye', target: 'target' },
            title: 'Safe <now>',
            message: 'Evidence & crew',
          },
        },
      },
    });
    expect(html).toContain('Safe &lt;now&gt;');
    expect(html).toContain('Evidence &amp; crew');
    for (const id of [
      'win-ending',
      'win-caption',
      'win-skip',
      'win-pause',
      'win-mute',
      'win-restart',
      'win-error',
    ])
      expect(html.split(`id="${id}"`)).toHaveLength(2);
    expect(html).toContain('aria-labelledby="win-title"');
  });
  it('creates a labelled native loss dialog only on explicit opt-in and escapes authored text', () => {
    expect(renderGameChrome(GAME)).not.toContain('id="loss-ending"');
    const html = renderGameChrome({
      ...GAME,
      manifest: {
        ...MANIFEST,
        ui: { lossEnding: { title: 'Caught <again>', message: 'Restart & try again.' } },
      },
    });
    expect(html).toContain(
      '<dialog id="loss-ending" aria-modal="true" aria-labelledby="loss-title" aria-describedby="loss-message"',
    );
    expect(html).toContain('Caught &lt;again&gt;');
    expect(html).toContain('Restart &amp; try again.');
    for (const id of [
      'loss-ending',
      'loss-shade',
      'loss-title',
      'loss-message',
      'loss-restart',
      'loss-error',
    ])
      expect(html.split(`id="${id}"`)).toHaveLength(2);
    expect(html).toContain('<button id="loss-restart" type="button">Restart</button>');
  });
  it('keeps cinematic status and session controls accessible on demand without changing defaults', () => {
    const standard = renderGameChrome({ ...GAME, manifest: MANIFEST });
    const compact = renderGameChrome({
      ...GAME,
      manifest: { ...MANIFEST, ui: { ...MANIFEST.ui, layout: 'cinematic' } },
    });
    expect(standard).not.toContain('id="mission-status"');
    expect(compact).toContain('data-layout="cinematic"');
    expect(compact).toMatch(
      /<details class="compact-menu" id="mission-status"><summary>Status<\/summary>/,
    );
    expect(compact).toMatch(
      /<details class="compact-menu" id="session-menu"><summary>Session<\/summary>/,
    );
    for (const id of [
      'hud-objective',
      'hud-prompt',
      'hud-subtitle',
      'hud-step-0',
      'action-pause',
      'quality',
      'loading-panel',
    ])
      expect(compact.split(`id="${id}"`)).toHaveLength(2);
    expect(compact).not.toMatch(/id="(?:mission-status|session-menu)" open/);
  });
  it('contains one of every host hook without taking ownership of the HTML document or boot script', () => {
    const body = renderGameChrome(GAME);
    for (const id of [
      'stage',
      'hud',
      'hud-objective',
      'hud-health',
      'hud-health-bar',
      'hud-progress',
      'hud-outcome',
      'hud-tick',
      'hud-status',
      'hud-controller',
      'gamepad-cursor',
      'hud-stats',
      'hud-events',
      'action-pause',
      'action-restart',
      'action-mute',
      'quality',
      'controls',
      'diagnostics',
      'loading-panel',
      'loading-message',
      'action-retry',
    ])
      expect(body.split(`id="${id}"`), `${id} must occur exactly once`).toHaveLength(2);
    expect(body).toContain('<canvas id="stage"');
    expect(body).toContain('href="../../"');
    expect(body).toContain('All games');
    expect(body).not.toMatch(/<!doctype|<html|<head|<body|<script|<style/i);
  });

  it.each<GameMode>(['platformer', 'iso', 'fps'])(
    'prints the real %s bindings and session keys',
    (mode) => {
      const body = renderGameChrome({ ...GAME, mode, bindings: BINDINGS[mode] });
      for (const line of [
        ...BINDINGS[mode].help,
        ...SESSION_CONTROLS,
        ...CONTROLLER_SESSION_CONTROLS,
      ]) {
        expect(body).toContain(`<kbd>${line.keys}</kbd>`);
        expect(body).toContain(`<dd>${line.does}</dd>`);
      }
      expect(body.includes('id="crosshair"')).toBe(mode === 'fps');
      if (mode === 'fps') expect(body).toContain('id="crosshair" aria-hidden="true"');
    },
  );

  it('keeps diagnostic counters and feed inside closed details, rather than default debug panes', () => {
    const body = renderGameChrome(GAME);
    const diagnostics = body.match(/<details\b[^>]*id="diagnostics"[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.split('>')[0]).not.toMatch(/\bopen\b/);
    for (const id of ['hud-tick', 'hud-status', 'hud-stats', 'hud-events'])
      expect(diagnostics).toContain(`id="${id}"`);
    const toggle = diagnostics?.match(/<input\b[^>]*id="collision-debug"[^>]*>/)?.[0];
    expect(toggle).toContain('type="checkbox"');
    expect(toggle).not.toMatch(/\b(?:checked|disabled)\b/);
    expect(diagnostics).toMatch(
      /<label\b[^>]*><input\b[^>]*id="collision-debug"[^>]*>\s*Show collision geometry<\/label>/,
    );
    expect(body.match(/<details\b[^>]*id="controls"[^>]*>/)?.[0]).not.toMatch(/\bopen\b/);
  });

  it('does not advertise the standard session profile for keyboard-only custom bindings', () => {
    const body = renderGameChrome({
      ...GAME,
      bindings: { actions: [], axes: [], pointer: 'none', help: [] },
    });
    expect(body).not.toContain('controller: Menu / View');
    expect(body).toContain('id="hud-controller" role="status" hidden');
    expect(body).toContain('pause / resume');
  });

  it('renders authored HUD data, accent, audio readiness and the selected quality tier', () => {
    const body = renderGameChrome({ ...GAME, manifest: MANIFEST });
    expect(body).toContain('style="--accent: #addecf"');
    expect(body).toContain('A quiet expedition');
    expect(body).toContain('Restore power and bring the crew home.');
    expect(body).toContain('<li id="hud-step-0" data-complete="false">Restore power</li>');
    expect(body).toContain('id="hud-progress" aria-live="polite">0 / 1 complete</p>');
    expect(body).toContain('<option value="low" selected>Low</option>');
    expect(body).toContain('<option value="standard">Standard</option>');
    expect(body).toMatch(/<button id="action-mute"[^>]*>Enable sound<\/button>/);
    expect(body).not.toContain('disabled aria-disabled="true"');
    expect(body).toContain('id="hud-outcome" role="status" aria-live="polite" hidden');
  });

  it('does not invent audio, health values, progress steps or outcomes for an unconfigured game', () => {
    const body = renderGameChrome(GAME);
    expect(body).toContain('id="health-readout" hidden');
    expect(body).toContain('<output id="hud-health">—</output>');
    expect(body).toContain('id="hud-progress" aria-live="polite" hidden>');
    expect(body).toContain('disabled aria-disabled="true">Sound unavailable</button>');
    expect(body).not.toContain('id="hud-step-');
    expect(body).toContain('<option value="standard" selected>Standard</option>');
  });

  it('uses semantic controls, polite status announcements and keyboard-scrollable details', () => {
    const body = renderGameChrome(GAME);
    expect(body).toContain('aria-label="Session controls"');
    for (const id of ['action-pause', 'action-restart', 'action-mute', 'action-retry'])
      expect(body).toMatch(new RegExp(`<button id="${id}" type="button"`));
    expect(body).toContain('for="quality"');
    expect(body).toContain('id="quality" aria-label="Presentation quality"');
    expect(body).toContain('aria-atomic="true" aria-labelledby="loading-title"');
    expect(body).toContain('tabindex="0" aria-label="Controls reference"');
    expect(body).toContain('tabindex="0" aria-label="Simulation diagnostics"');
  });

  it('escapes all text/attribute inputs and never interpolates unchecked CSS values', () => {
    const attack = '\'"<img src=x onerror=bad>&';
    const body = renderGameChrome({
      ...GAME,
      title: attack,
      objective: attack,
      bindings: { ...BINDINGS.platformer, help: [{ keys: attack, does: attack }] },
      manifest: {
        ...MANIFEST,
        ui: { eyebrow: attack, accent: '#ffffff; background:url(https://example.com)' },
        hud: { ...MANIFEST.hud!, steps: [{ id: 'a', label: attack, event: 'a' }] },
      },
    });
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&#39;&quot;&lt;img src=x onerror=bad&gt;&amp;');
    expect(body).not.toContain('background:url');
    expect(body).not.toContain('style="--accent:');
  });
});

describe('shared catalog body', () => {
  it('uses the supplied prefix-safe routes and cover URL, never treating a manifest asset ID as a URL', () => {
    const gameHref = vi.fn((id: string) => `./play/${id}/`);
    const body = renderCatalogBody({
      games: [
        { ...CATALOG_GAME, manifest: MANIFEST, coverUrl: './assets/long-way/cover%20art.svg' },
        { ...CATALOG_GAME, id: 'other', manifest: MANIFEST },
      ],
      gameHref,
      staticSite: true,
    });
    expect(gameHref.mock.calls).toEqual([['long-way'], ['other']]);
    expect(body).toContain('href="./play/long-way/"');
    expect(body).toContain('src="./assets/long-way/cover%20art.svg"');
    expect(body.match(/<img\b/g)).toHaveLength(1);
    expect(body).not.toContain('src="cover-art"');
    expect(body).toContain('width="960" height="540" loading="lazy" decoding="async"');
    expect(body).toContain('style="--accent: #addecf"');
    expect(body).toContain('aria-labelledby="game-0-title"');
    expect(body).toContain('id="game-1-title"');
    expect(body).toContain('Simulation runs in your browser.');
    expect(body).not.toMatch(/<html|<body|<script|<style/i);
  });

  it('renders mode, title, blurb and control keys, with distinct dev wording', () => {
    const body = renderCatalogBody({
      games: [{ ...CATALOG_GAME, mode: 'fps', bindings: BINDINGS.fps }],
      gameHref: () => '../play/',
      staticSite: false,
    });
    expect(body).toContain('First person');
    expect(body).toContain(CATALOG_GAME.title);
    expect(body).toContain(CATALOG_GAME.blurb);
    expect(body).toContain('W / S');
    expect(body).toContain('left click');
    expect(body).toContain('Live simulation · development preview');
    expect(body).not.toContain('Simulation runs in your browser.');
  });

  it('escapes catalog metadata and URL attributes, including ampersands and quotes', () => {
    const body = renderCatalogBody({
      games: [
        {
          ...CATALOG_GAME,
          title: '<script>bad()</script>',
          blurb: '"safety" & <care>',
          coverUrl: './cover.svg?v=1&name="art"',
        },
      ],
      gameHref: () => './play/?next="x"&test=1',
      staticSite: true,
    });
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(body).toContain('&quot;safety&quot; &amp; &lt;care&gt;');
    expect(body).toContain('href="./play/?next=&quot;x&quot;&amp;test=1"');
    expect(body).toContain('src="./cover.svg?v=1&amp;name=&quot;art&quot;"');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    '//external.test/image',
    'https://external.test',
    '\\\\host\\asset',
    'java\nscript:alert(1)',
  ])('rejects active or non-local URLs: %s', (path) => {
    expect(() => renderGameChrome({ ...GAME, backHref: path })).toThrow('local, URL-encoded');
    expect(() =>
      renderCatalogBody({
        games: [CATALOG_GAME],
        gameHref: () => path,
        staticSite: true,
      }),
    ).toThrow('local, URL-encoded');
    expect(() =>
      renderCatalogBody({
        games: [{ ...CATALOG_GAME, coverUrl: path }],
        gameHref: () => './play/',
        staticSite: true,
      }),
    ).toThrow('local, URL-encoded');
  });

  it('handles an empty collection without inventing playable links', () => {
    const gameHref = vi.fn();
    const body = renderCatalogBody({ games: [], gameHref, staticSite: true });
    expect(body).toContain('No games are configured yet.');
    expect(body).not.toContain('class="card"');
    expect(gameHref).not.toHaveBeenCalled();
  });
});

describe('shared responsive page styles', () => {
  it('keeps readouts pointer-transparent, controls operable, focus visible, and motion optional', () => {
    expect(PAGE_STYLE).toMatch(/\.panel\s*\{[^}]*pointer-events:\s*none/);
    expect(PAGE_STYLE).toMatch(/\.game-shell\s*\{[^}]*pointer-events:\s*none/);
    expect(PAGE_STYLE).toContain(
      '.game-shell :where(a, button, select, summary, input, label, [tabindex="0"]) { pointer-events: auto; }',
    );
    expect(PAGE_STYLE).toContain(':focus-visible');
    expect(PAGE_STYLE).toContain('outline: 3px solid var(--accent)');
    expect(PAGE_STYLE).toContain('[hidden] { display: none !important; }');
    expect(PAGE_STYLE).toContain('@media (max-width: 640px)');
    expect(PAGE_STYLE).toContain('100dvh');
    expect(PAGE_STYLE).toContain('safe-area-inset-bottom');
    expect(PAGE_STYLE).toContain('@media (prefers-reduced-motion: reduce)');
    expect(PAGE_STYLE).toContain('transition: none !important');
    expect(PAGE_STYLE).not.toMatch(/@import|https?:|url\(/i);
  });
});

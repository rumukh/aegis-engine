/**
 * The two HTML documents the dev server serves: a landing page listing the games and a play page
 * per game.
 *
 * There is no build step and no bundler. Every `@aegis/*` package except the harness is free of
 * Node built-ins and is emitted as plain `NodeNext` ESM with explicit `.js` extensions, which a
 * browser can load directly — so the page just declares an **import map** pointing at the built
 * `dist/` folders and `three`'s ESM build. That keeps ADR-0005's "three.js is the only
 * third-party runtime dependency" intact: nothing else was added to make pixels happen.
 * @packageDocumentation
 */
import type { GameDefinition } from './catalog.js';
import { SESSION_CONTROLS } from './bindings.js';
import type { BootConfig } from './protocol.js';

/** Escape a string for interpolation into HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The import map that lets the browser resolve the workspace's bare specifiers. */
export function importMap(): string {
  return JSON.stringify(
    {
      imports: {
        three: '/vendor/three/build/three.module.js',
        'three/': '/vendor/three/',
        '@aegis/core': '/vendor/@aegis/core/dist/index.js',
        '@aegis/core/math': '/vendor/@aegis/core/dist/math/index.js',
        '@aegis/content': '/vendor/@aegis/content/dist/index.js',
        '@aegis/mode-platformer': '/vendor/@aegis/mode-platformer/dist/index.js',
        '@aegis/mode-iso': '/vendor/@aegis/mode-iso/dist/index.js',
        '@aegis/mode-fps': '/vendor/@aegis/mode-fps/dist/index.js',
      },
    },
    null,
    2,
  );
}

/** Shared page chrome. */
export const PAGE_STYLE = `
  :root { color-scheme: dark; --ink: #e6edf3; --dim: #8b98a5; --edge: #22303f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #05070d; color: var(--ink);
         font: 12px/1.45 ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; }
  a { color: #67e8f9; }
  #stage { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
  .panel { position: fixed; background: rgba(5,7,13,.78); border: 1px solid var(--edge);
           border-radius: 8px; padding: 8px 11px; backdrop-filter: blur(3px); }
  #hud { top: 10px; left: 10px; width: 264px; }
  #hud h1 { margin: 0 0 2px; font-size: 13px; letter-spacing: .02em; }
  #hud .obj { color: var(--dim); margin-bottom: 6px; }
  #hud .row { display: flex; gap: 12px; color: #7dd3fc; }
  #hud-stats { white-space: pre; margin-top: 4px; color: var(--ink); }
  #events { top: 10px; right: 10px; width: 232px; }
  #events b { color: var(--dim); font-weight: 600; }
  #hud-events { white-space: pre; margin-top: 4px; color: #a3e635; min-height: 6em; }
  #controls { bottom: 10px; left: 10px; width: 340px; color: var(--dim); }
  #controls b { color: var(--dim); font-weight: 600; }
  #controls div { display: flex; gap: 8px; }
  #controls span:first-child { min-width: 118px; color: var(--ink); }
  #crosshair { position: fixed; left: 50%; top: 50%; width: 14px; height: 14px;
               transform: translate(-50%,-50%); pointer-events: none; }
  #crosshair::before, #crosshair::after { content: ""; position: absolute; background: #e6edf3;
               opacity: .85; }
  #crosshair::before { left: 6px; top: 0; width: 2px; height: 14px; }
  #crosshair::after { top: 6px; left: 0; height: 2px; width: 14px; }
  .index { max-width: 760px; margin: 8vh auto; padding: 0 24px; font-size: 14px; }
  .index h1 { font-size: 26px; margin-bottom: 4px; }
  .index p.lede { color: var(--dim); margin-top: 0; }
  .card { display: block; border: 1px solid var(--edge); border-radius: 10px; padding: 16px 18px;
          margin: 14px 0; text-decoration: none; color: var(--ink); background: #0b1220; }
  .card:hover { border-color: #3f6d8f; }
  .card h2 { margin: 0 0 4px; font-size: 17px; }
  .card p { margin: 0; color: var(--dim); }
  .card .mode { float: right; color: #67e8f9; }
`;

/** The landing page linking every game in the catalogue. */
export function renderIndexPage(games: readonly GameDefinition[]): string {
  const cards = games
    .map(
      (game) => `    <a class="card" href="/play/${escapeHtml(game.id)}">
      <span class="mode">${escapeHtml(game.mode)}</span>
      <h2>${escapeHtml(game.title)}</h2>
      <p>${escapeHtml(game.blurb)}</p>
    </a>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Aegis — play the proof-of-concept games</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main class="index">
    <h1>Aegis</h1>
    <p class="lede">
      The simulation runs headlessly and deterministically; this page is the optional render
      adapter. Pick a game and play it with a keyboard and mouse.
    </p>
${cards}
  </main>
</body>
</html>
`;
}

/** The play page for one game. */
export function renderPlayPage(game: GameDefinition): string {
  const config: BootConfig = {
    gameId: game.id,
    mode: game.mode,
    title: game.title,
    objective: game.objective,
    api: `/api/${game.id}`,
  };
  const controls = [...game.bindings.help, ...SESSION_CONTROLS]
    .map(
      (line) =>
        `      <div><span>${escapeHtml(line.keys)}</span><span>${escapeHtml(line.does)}</span></div>`,
    )
    .join('\n');
  const crosshair = game.mode === 'fps' ? '  <div id="crosshair"></div>\n' : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(game.title)} — Aegis</title>
  <style>${PAGE_STYLE}</style>
  <script type="importmap">
${importMap()}
  </script>
</head>
<body>
  <canvas id="stage"></canvas>
${crosshair}  <section class="panel" id="hud">
    <h1>${escapeHtml(game.title)}</h1>
    <div class="obj">${escapeHtml(game.objective)}</div>
    <div class="row"><span id="hud-tick">tick 0</span><span id="hud-status">starting…</span></div>
    <div id="hud-stats"></div>
  </section>
  <section class="panel" id="events">
    <b>simulation events</b>
    <div id="hud-events"></div>
  </section>
  <section class="panel" id="controls">
    <b>controls</b>
${controls}
  </section>
  <script type="module">
    import { boot } from '/vendor/@aegis/render-three/dist/client/boot.js';
    boot(${JSON.stringify(config)});
  </script>
</body>
</html>
`;
}

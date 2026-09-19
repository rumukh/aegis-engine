import type { GameMode } from '@aegis/core';
import { SESSION_CONTROLS, CONTROLLER_SESSION_CONTROLS } from './bindings.js';
import type { ModeBindings } from './bindings.js';
import type { PresentationManifest } from './presentation/schema.js';

export interface GameChromeOptions {
  title: string;
  objective: string;
  mode: GameMode;
  bindings: ModeBindings;
  backHref: string;
  manifest?: PresentationManifest;
}

export interface CatalogGame {
  id: string;
  title: string;
  blurb: string;
  mode: GameMode;
  bindings: ModeBindings;
  manifest?: PresentationManifest;
  coverUrl?: string;
}

export interface CatalogBodyOptions {
  games: readonly CatalogGame[];
  gameHref(id: string): string;
  staticSite: boolean;
}

const MODE_LABELS: Readonly<Record<GameMode, string>> = {
  platformer: 'Platformer',
  iso: 'Isometric',
  fps: 'First person',
};

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function localUrl(value: string): string {
  const path = value.trim();
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith('//') ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || character === '\\';
    })
  )
    throw new Error('Page chrome requires a local, URL-encoded link or asset path.');
  return escape(path);
}

function accent(manifest?: PresentationManifest): string {
  const color = manifest?.ui?.accent;
  return color !== undefined && /^#[0-9a-f]{6}$/i.test(color) ? ` style="--accent: ${color}"` : '';
}

/** Browser-neutral styles shared by dev and static documents; no external font or asset loads. */
export const PAGE_STYLE = `
  :root {
    color-scheme: dark;
    --ink: #edf3f4; --dim: #a4b2bb; --edge: #2c3c48; --accent: #8de0cc;
    --surface: #111d28; --base: #080f17;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.5;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--base); color: var(--ink); }
  [hidden] { display: none !important; }
  a { color: inherit; text-underline-offset: .22em; }
  button, select, input { font: inherit; }
  button, select {
    min-height: 2.5rem; border: 1px solid var(--edge); border-radius: .55rem;
    background: #172633; color: var(--ink); padding: .45rem .8rem;
  }
  button, summary, select { cursor: pointer; }
  button:hover, select:hover { border-color: var(--accent); background: #20323f; }
  button:disabled { cursor: not-allowed; color: var(--dim); opacity: .65; }
  :where(a, button, select, summary, input, [tabindex="0"]):focus-visible {
    outline: 3px solid var(--accent); outline-offset: 4px;
  }
  .eyebrow {
    margin: 0; color: var(--accent); font-size: .68rem; font-weight: 650;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .panel {
    border: 1px solid var(--edge); border-radius: .85rem; padding: .9rem 1rem;
    background: rgba(9, 18, 27, .9); box-shadow: 0 8px 30px #0003;
    backdrop-filter: blur(10px); pointer-events: none;
  }
  .game-shell { position: fixed; inset: 0; pointer-events: none; }
  #stage {
    position: fixed; inset: 0; display: block; width: 100vw; height: 100vh;
    width: 100dvw; height: 100dvh; pointer-events: auto; touch-action: none;
  }
  #stage:focus-visible { outline-offset: -4px; }
  .game-shell :where(a, button, select, summary, input, label, [tabindex="0"]) { pointer-events: auto; }
  .game-topbar {
    position: absolute; top: max(1rem, env(safe-area-inset-top));
    left: max(1rem, env(safe-area-inset-left)); right: max(1rem, env(safe-area-inset-right));
    display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;
  }
  #hud { width: min(24rem, 44vw); }
  .hud-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .back-link { font-size: .74rem; color: var(--dim); text-decoration: none; }
  .back-link:hover { color: var(--ink); }
  #hud h1 { margin: .45rem 0 .3rem; font-size: 1.25rem; line-height: 1.2; font-weight: 650; }
  #hud-objective { margin: 0; color: var(--dim); font-size: .83rem; }
  .health-readout { display: grid; grid-template-columns: 1fr auto; gap: .2rem .8rem; margin-top: .7rem; }
  .readout-label, #hud-health { font-size: .73rem; font-variant-numeric: tabular-nums; }
  .readout-label { color: var(--dim); }
  #hud-health-bar { grid-column: 1 / -1; width: 100%; height: .45rem; accent-color: var(--accent); }
  #hud-health-bar::-webkit-meter-bar { background: #263440; border: 0; }
  #hud-health-bar::-webkit-meter-optimum-value { background: var(--accent); }
  #hud-health-bar::-moz-meter-bar { background: var(--accent); }
  #hud-progress { margin: .7rem 0 .2rem; color: var(--accent); font-size: .7rem; letter-spacing: .04em; }
  .objective-steps { list-style: none; padding: 0; margin: .25rem 0 0; font-size: .76rem; }
  .objective-steps li { padding: .1rem 0; color: var(--dim); }
  .objective-steps li[data-complete="true"] { color: var(--accent); }
  #hud-outcome { margin: .8rem 0 0; padding-top: .65rem; border-top: 1px solid var(--edge); font-weight: 650; }
  #hud-outcome[data-outcome="win"] { color: #b9ebc3; }
  #hud-outcome[data-outcome="lose"] { color: #ffd29e; }
  .session-controls { max-width: 32rem; padding: .55rem; }
  .session-actions { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
  .session-actions button { font-size: .77rem; }
  .quality-control { display: flex; align-items: center; gap: .4rem; padding-left: .25rem; font-size: .7rem; color: var(--dim); }
  .quality-control select { font-size: .77rem; padding: .4rem; }
  .narrative-overlay { position: absolute; left: 50%; bottom: 6rem; transform: translateX(-50%); width: min(42rem, 86%); text-align: center; pointer-events: none; }
  .narrative-overlay p { background: rgb(5 9 14 / 88%); border-radius: .35rem; padding: .5rem .8rem; margin: .4rem auto; width: fit-content; color: #f1f4f5; line-height: 1.5; }
  #hud-prompt { font-weight: 600; }
  #hud-narrative-status { color: #b6c6cf; font-size: .8rem; }
  #hud-input { position: absolute; bottom: 3.6rem; left: 50%; transform: translateX(-50%); max-width: min(42rem, 80vw); margin: 0; padding: .45rem .7rem; border: 1px solid var(--edge); border-radius: .4rem; background: #09121bea; color: var(--dim); text-align: center; font-size: .75rem; pointer-events: none; }
  #hud-input[data-state="error"] { color: #ffd29e; border-color: #8d734f; }
  #loss-ending { position: fixed; inset: 0; width: 100vw; height: 100vh; width: 100dvw; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 1rem; border: 0; background: transparent; color: var(--ink); overflow: auto; pointer-events: auto; }
  #loss-ending[open] { display: grid; place-items: center; }
  #loss-ending::backdrop { background: transparent; }
  #loss-shade { position: fixed; inset: 0; background: #020407; opacity: 0; transition: opacity var(--loss-fade, 1s) ease-out; pointer-events: none; }
  #loss-ending[data-visible="true"] #loss-shade { opacity: .96; }
  .loss-card { position: relative; z-index: 1; width: min(32rem, 90vw); padding: clamp(1.2rem, 4vw, 2.5rem); border: 1px solid #697d8980; border-radius: .8rem; background: #09121bed; text-align: center; }
  #loss-title { margin: 0 0 .8rem; font-size: clamp(1.4rem, 3vw, 2.5rem); letter-spacing: .08em; line-height: 1.15; }
  #loss-message { margin: 0 0 1.5rem; color: #d3dde3; }
  #loss-restart { min-width: 10rem; border-color: var(--accent); font-weight: 650; }
  #loss-help { font-size: .75rem; color: var(--dim); }
  #loss-error { color: #ffd29e; white-space: pre-wrap; overflow-wrap: anywhere; }
  #game-shell[data-ending="win"] > :is(.game-topbar, .game-bottom, .narrative-overlay, #crosshair, #hud-input) { visibility: hidden; }
  #win-ending { position: fixed; inset: 0; width: 100vw; height: 100vh; width: 100dvw; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; color: var(--ink); pointer-events: auto; overflow: auto; }
  #win-ending::backdrop { background: transparent; }
  #win-ending::before, #win-ending::after { content: ""; position: fixed; left: 0; right: 0; height: 9vh; background: #020407; pointer-events: none; }
  #win-ending::before { top: 0; }
  #win-ending::after { bottom: 0; }
  #win-shade { position: fixed; inset: 0; background: #020407; opacity: 0; pointer-events: none; }
  .win-actions { position: absolute; top: max(1rem, env(safe-area-inset-top)); right: max(1rem, env(safe-area-inset-right)); display: flex; gap: .5rem; z-index: 2; }
  .win-actions button { font-size: .8rem; background: #081018e8; }
  #win-caption { position: absolute; bottom: 12vh; left: 50%; transform: translateX(-50%); width: min(42rem, 88vw); margin: 0; padding: .7rem 1rem; background: #020407de; text-align: center; line-height: 1.5; font-size: clamp(.9rem, 2vw, 1.1rem); }
  #win-card { position: relative; z-index: 1; width: min(40rem, 88vw); margin: 25vh auto 4rem; padding: 2rem 1rem; text-align: center; }
  #win-title { font-size: clamp(1.7rem, 5vw, 3.8rem); letter-spacing: .12em; line-height: 1.15; margin: 1rem 0; }
  #win-message { color: #c5d8c8; line-height: 1.8; margin: 1rem 0 2rem; }
  #win-restart { margin-right: 1rem; border-color: var(--accent); }
  #win-error { position: relative; z-index: 3; margin: 12vh auto 1rem; padding: 1rem; max-width: min(42rem, 88vw); color: #ffd29e; background: #09121bf2; white-space: pre-wrap; overflow-wrap: anywhere; }
  [data-layout="cinematic"] #hud { width: min(24rem, 46vw); padding: .65rem .8rem; }
  [data-layout="cinematic"] #hud h1 { font-size: .9rem; margin: .25rem 0; }
  [data-layout="cinematic"] .eyebrow { font-size: .6rem; }
  [data-layout="cinematic"] .session-controls { padding: .5rem .7rem; }
  [data-layout="cinematic"] #mission-status[open] .objective-steps { display: block; }
  .compact-menu > summary { font-size: .75rem; color: var(--dim); padding: .2rem 0; }
  .compact-menu[open] > summary { margin-bottom: .4rem; }
  #mission-status { margin-top: .35rem; }
  #hud-audio { margin: .3rem .25rem 0; color: var(--dim); font-size: .67rem; max-width: 28rem; overflow-wrap: anywhere; }
  #hud-audio[data-status="error"] { color: #ffd29e; }
  .game-bottom {
    position: absolute; bottom: max(1rem, env(safe-area-inset-bottom));
    left: max(1rem, env(safe-area-inset-left)); right: max(1rem, env(safe-area-inset-right));
    display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem;
  }
  .details-panel { padding: 0; max-width: min(28rem, 46vw); }
  .details-panel summary { padding: .55rem .8rem; color: var(--dim); font-size: .75rem; }
  .details-panel summary::marker { color: var(--accent); }
  .details-panel[open] summary { border-bottom: 1px solid var(--edge); color: var(--ink); }
  .details-content { padding: .75rem .85rem; max-height: 42vh; overflow: auto; }
  .binding-list { display: grid; grid-template-columns: minmax(6rem, auto) 1fr; gap: .5rem .9rem; margin: 0; font-size: .76rem; }
  .binding-list dt { margin: 0; color: var(--ink); }
  .binding-list dd { margin: 0; color: var(--dim); }
  kbd { font: inherit; }
  .diagnostic-row { display: flex; gap: 1.1rem; color: var(--accent); font-size: .75rem; }
  #hud-stats, #hud-events, #hud-controller {
    white-space: pre-wrap; overflow-wrap: anywhere; font: .71rem/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
    margin: .55rem 0; color: var(--dim);
  }
  #events h2 { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; margin: .8rem 0 .25rem; }
  .debug-toggle { display: inline-flex; align-items: center; gap: .4rem; font-size: .72rem; color: var(--dim); }
  #crosshair { position: fixed; left: 50%; top: 50%; width: 14px; height: 14px; transform: translate(-50%, -50%); pointer-events: none; }
  #crosshair::before, #crosshair::after { content: ""; position: absolute; background: #edf3f4; box-shadow: 0 0 2px #000; opacity: .85; }
  #crosshair::before { left: 6px; top: 0; width: 2px; height: 14px; }
  #crosshair::after { top: 6px; left: 0; height: 2px; width: 14px; }
  #gamepad-cursor {
    position: fixed; width: 18px; height: 18px; z-index: 2; pointer-events: none;
    border: 2px solid #fff; border-radius: 50%; background: #07152088;
    box-shadow: 0 0 0 1px #071520; transform: translate(-50%, -50%);
  }
  .loading-panel { position: absolute; inset: 0; display: grid; place-items: center; padding: 1rem; background: #050a1280; pointer-events: none; }
  .loading-card { width: min(29rem, 100%); padding: 1.6rem; background: #101d29; }
  .loading-card h2 { margin: .3rem 0 .7rem; font-size: 1.3rem; }
  #loading-message { color: var(--dim); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50vh; overflow: auto; font-size: .85rem; }
  #action-retry { margin-top: .5rem; }
  .loading-panel[data-state="reconnecting"] { inset: auto 1rem 4.5rem auto; display: block; width: min(28rem, calc(100% - 2rem)); padding: 0; background: none; }
  .loading-panel[data-state="reconnecting"] .loading-card { padding: 1rem; border-color: #8d734f; }
  .index { width: min(1160px, 100%); margin: 0 auto; padding: clamp(2rem, 7vw, 5rem) clamp(1rem, 4vw, 3rem); }
  .catalog-header { max-width: 42rem; margin-bottom: 2.5rem; }
  .brand { display: inline-block; margin: 0 0 2.5rem; font-size: .9rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .catalog-header h1 { margin: .5rem 0 1rem; font-size: clamp(2.3rem, 5vw, 4rem); line-height: 1.06; letter-spacing: -.045em; font-weight: 650; }
  .lede { margin: 0; max-width: 34rem; color: var(--dim); font-size: 1rem; }
  .catalog-note { margin: 1rem 0 0; color: var(--dim); font-size: .75rem; }
  .game-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 1.2rem; align-items: stretch; }
  .game-card { min-width: 0; display: flex; }
  .card { display: flex; flex-direction: column; width: 100%; border: 1px solid var(--edge); border-radius: 1rem; overflow: hidden; text-decoration: none; background: var(--surface); transition: border-color 160ms ease, transform 160ms ease; }
  .card:hover { border-color: var(--accent); transform: translateY(-3px); }
  .card-cover { position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: linear-gradient(145deg, #263c4a, #0b1824 75%); }
  .card-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .cover-mark { position: absolute; inset: 18% 22%; border: 1px solid var(--accent); border-radius: .6rem; opacity: .55; transform: rotate(-12deg); }
  .cover-mark::after { content: ""; position: absolute; inset: 18%; border: 1px solid var(--accent); border-radius: .4rem; }
  .card-mode { position: absolute; left: 1rem; bottom: .8rem; padding: .2rem .5rem; border: 1px solid #ffffff26; border-radius: .35rem; color: var(--ink); font-size: .67rem; background: #09121be6; }
  .card-body { flex: 1; display: flex; flex-direction: column; padding: 1.2rem; }
  .card h2 { margin: .3rem 0 .6rem; font-size: 1.4rem; line-height: 1.2; font-weight: 650; letter-spacing: -.02em; }
  .card-blurb { margin: 0; font-size: .85rem; color: var(--dim); }
  .card-keys { margin: 1.2rem 0; color: var(--dim); font-size: .71rem; line-height: 1.7; }
  .card-cta { display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: .8rem; border-top: 1px solid var(--edge); color: var(--accent); font-size: .82rem; font-weight: 600; }
  .catalog-footer { margin-top: 2.5rem; color: var(--dim); font-size: .75rem; }
  @media (max-width: 900px) {
    #hud { width: min(22rem, 46vw); }
    .session-controls { max-width: 21rem; }
    .quality-control { padding-left: 0; }
  }
  @media (max-width: 640px) {
    .game-topbar { top: max(.75rem, env(safe-area-inset-top)); left: .75rem; right: .75rem; }
    #hud { width: min(23rem, 100%); padding: .7rem .85rem; }
    #hud h1 { font-size: 1.1rem; }
    #hud-objective { font-size: .77rem; }
    .session-controls { position: fixed; left: .75rem; right: .75rem; bottom: max(4rem, calc(env(safe-area-inset-bottom) + 3.25rem)); max-width: none; }
    .session-actions { gap: .3rem; }
    .session-actions button { flex: 1; padding: .4rem .5rem; }
    .quality-control { flex: 1; justify-content: flex-end; }
    .quality-control > span { display: none; }
    .game-bottom { left: .75rem; right: .75rem; bottom: max(.75rem, env(safe-area-inset-bottom)); gap: .5rem; }
    .details-panel { max-width: calc(50vw - 1rem); }
    .details-panel[open] { position: fixed; left: .75rem; right: .75rem; bottom: max(.75rem, env(safe-area-inset-bottom)); max-width: none; z-index: 1; }
    .details-content { max-height: 35vh; }
    .loading-panel[data-state="reconnecting"] { left: .75rem; right: .75rem; bottom: 10rem; width: auto; }
  }
  @media (max-height: 540px) and (min-width: 480px) {
    .game-topbar { top: .65rem; left: .65rem; right: .65rem; gap: .6rem; }
    #hud { width: min(20rem, 47vw); padding: .5rem .7rem; }
    #hud h1 { margin: .3rem 0; font-size: 1rem; }
    #hud-objective { font-size: .73rem; }
    .health-readout { margin-top: .4rem; }
    .session-controls { position: static; max-width: 48vw; padding: .4rem; }
    .session-actions { gap: .3rem; }
    .session-actions button, .quality-control select { min-height: 2rem; font-size: .7rem; }
    .session-actions button { flex: initial; }
    .quality-control { flex: initial; }
    .quality-control > span { display: none; }
    #hud-audio { font-size: .62rem; margin-top: .15rem; }
    .objective-steps { display: none; }
    #hud-progress { margin-top: .4rem; }
    .details-content { max-height: 30vh; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .card:hover { transform: none; }
  }
`;

/** Return only body content; document/import-map/boot ownership stays with the delivery path. */
export function renderGameChrome(options: GameChromeOptions): string {
  const { title, objective, mode, bindings, manifest } = options;
  const steps = manifest?.hud?.steps ?? [];
  const hasAudio =
    manifest?.audio?.ambient !== undefined ||
    (manifest?.audio?.layers?.length ?? 0) > 0 ||
    (manifest?.audio?.cues?.some((cue) => cue.asset !== undefined) ?? false);
  const quality = manifest?.quality ?? 'standard';
  const compact = manifest?.ui?.layout === 'cinematic';
  const ending = manifest?.ui?.lossEnding;
  const win = manifest?.ui?.winEnding;
  const controls = [
    ...bindings.help,
    ...SESSION_CONTROLS,
    ...(bindings.gamepad === undefined ? [] : CONTROLLER_SESSION_CONTROLS),
  ]
    .map(
      (line) => `          <dt><kbd>${escape(line.keys)}</kbd></dt><dd>${escape(line.does)}</dd>`,
    )
    .join('\n');
  return `  <main class="game-shell" id="game-shell" data-mode="${escape(mode)}"${compact ? ' data-layout="cinematic"' : ''}${accent(manifest)}>
    <canvas id="stage" tabindex="0" aria-label="${escape(title)} game view" aria-busy="true">This game requires a browser with WebGL support.</canvas>
    <div id="gamepad-cursor" aria-hidden="true" hidden></div>
${mode === 'fps' ? '    <div id="crosshair" aria-hidden="true"></div>\n' : ''}    <div class="game-topbar">
      <section class="panel" id="hud" aria-labelledby="game-title">
        <div class="hud-heading"><a class="back-link" href="${localUrl(options.backHref)}"><span aria-hidden="true">← </span>All games</a><p class="eyebrow">${escape(manifest?.ui?.eyebrow ?? MODE_LABELS[mode])}</p></div>
        <h1 id="game-title">${escape(title)}</h1>
        <p id="hud-objective">${escape(objective)}</p>
${compact ? '        <details class="compact-menu" id="mission-status"><summary>Status</summary>\n' : ''}\
        <div class="health-readout" id="health-readout" hidden><span class="readout-label">Health</span><output id="hud-health">—</output><meter id="hud-health-bar" min="0" max="100" value="100" aria-label="Health"></meter></div>
        <p id="hud-progress" aria-live="polite"${steps.length === 0 ? ' hidden' : ''}>${steps.length === 0 ? '' : `0 / ${steps.length} complete`}</p>
${steps.length === 0 ? '' : `        <ol class="objective-steps" id="hud-steps" aria-label="Objective steps">\n${steps.map((step, index) => `          <li id="hud-step-${index}" data-complete="false">${escape(step.label)}</li>`).join('\n')}\n        </ol>\n`}${compact ? '        </details>\n' : ''}        <p id="hud-outcome" role="status" aria-live="polite" hidden></p>
      </section>
      <nav class="panel session-controls" aria-label="Session controls">
${compact ? '        <details class="compact-menu" id="session-menu"><summary>Session</summary>\n' : ''}\
        <div class="session-actions">
          <button id="action-pause" type="button" aria-label="Pause game" aria-pressed="false">Pause</button>
          <button id="action-restart" type="button">Restart</button>
          <button id="action-mute" type="button" aria-pressed="false"${hasAudio ? '' : ' disabled aria-disabled="true"'}>${hasAudio ? 'Enable sound' : 'Sound unavailable'}</button>
          <label class="quality-control" for="quality"><span>Quality</span><select id="quality" aria-label="Presentation quality"><option value="standard"${quality === 'standard' ? ' selected' : ''}>Standard</option><option value="low"${quality === 'low' ? ' selected' : ''}>Low</option>${manifest?.pipeline === undefined ? '' : `<option value="high"${quality === 'high' ? ' selected' : ''}>High (1440p budget)</option><option value="photo"${quality === 'photo' ? ' selected' : ''}>Photo (4K budget)</option>`}</select></label>
        </div>
        <p id="hud-audio" role="status" aria-live="polite">${hasAudio ? 'Sound needs a gesture' : 'Sound unavailable'}</p>
${compact ? '        </details>\n' : ''}\
      </nav>
    </div>
    <div class="narrative-overlay"><p id="hud-narrative-status" role="status" hidden></p><p id="hud-prompt" hidden></p><p id="hud-subtitle" role="status" aria-live="polite" hidden></p></div>
    <p id="hud-input" role="status" aria-live="polite" hidden></p>
${
  ending === undefined
    ? ''
    : `    <dialog id="loss-ending" aria-modal="true" aria-labelledby="loss-title" aria-describedby="loss-message" data-phase="hidden" data-visible="false">
      <div id="loss-shade" aria-hidden="true"></div>
      <section class="loss-card"><h2 id="loss-title">${escape(ending.title ?? 'Run ended')}</h2>
        <p id="loss-message">${escape(ending.message ?? 'Restart to try again.')}</p>
        <button id="loss-restart" type="button">Restart</button>
        <p id="loss-help">Press R or the controller restart button.</p>
        <p id="loss-error" role="alert" hidden></p>
      </section>
    </dialog>\n`
}\
${
  win === undefined
    ? ''
    : `    <dialog id="win-ending" aria-modal="true" aria-labelledby="win-title" data-phase="hidden">
      <div id="win-shade" aria-hidden="true"></div>
      <div class="win-actions">
        <button id="win-mute" type="button" aria-pressed="false">Enable sound</button>
        <button id="win-pause" type="button" aria-pressed="false">Pause</button>
        <button id="win-skip" type="button">Skip / Esc</button>
      </div>
      <p id="win-caption" role="status" aria-live="polite" hidden></p>
      <section id="win-card" hidden><p class="eyebrow">Mission complete</p>
        <h2 id="win-title">${escape(win.title)}</h2>
        <p id="win-message">${escape(win.message)}</p>
        <button id="win-restart" type="button">Play again</button>
        <a class="back-link" href="${localUrl(options.backHref)}">All games</a>
        <p class="eyebrow">R / controller restart also starts a new run.</p>
      </section>
      <p id="win-error" role="alert" hidden></p>
    </dialog>\n`
}\
    <div class="game-bottom">
      <details class="panel details-panel" id="controls">
        <summary>Controls</summary>
        <div class="details-content" tabindex="0" aria-label="Controls reference"><dl class="binding-list">
${controls}
        </dl></div>
      </details>
      <details class="panel details-panel" id="diagnostics">
        <summary>Diagnostics</summary>
        <div class="details-content" tabindex="0" aria-label="Simulation diagnostics">
          <div class="diagnostic-row"><output id="hud-tick">tick 0</output><output id="hud-status">starting…</output></div>
          <p id="hud-controller" role="status"${bindings.gamepad === undefined ? ' hidden' : ''}>Controller not sampled yet</p>
          <pre id="hud-stats"></pre>
          <section id="events" aria-labelledby="events-title"><h2 id="events-title">Simulation events</h2><pre id="hud-events"></pre></section>
          <label class="debug-toggle"><input type="checkbox" id="collision-debug" /> Show collision geometry</label>
        </div>
      </details>
    </div>
    <section class="loading-panel" id="loading-panel" data-state="loading" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="loading-title">
      <div class="panel loading-card"><p class="eyebrow">Presentation</p><h2 id="loading-title">Getting ready</h2><p id="loading-message" tabindex="0">Preparing the game…</p><button id="action-retry" type="button" hidden>Reload game</button></div>
    </section>
  </main>`;
}

export function renderCatalogBody(options: CatalogBodyOptions): string {
  const cards = options.games
    .map((game, index) => {
      const { manifest } = game;
      const cover =
        game.coverUrl === undefined
          ? '<span class="cover-mark" aria-hidden="true"></span>'
          : `<img src="${localUrl(game.coverUrl)}" alt="" width="960" height="540" loading="lazy" decoding="async" />`;
      const keys = game.bindings.help.map((line) => escape(line.keys)).join(' &nbsp;·&nbsp; ');
      return `      <article class="game-card" data-mode="${escape(game.mode)}"${accent(manifest)}>
        <a class="card" href="${localUrl(options.gameHref(game.id))}" aria-labelledby="game-${index}-title">
          <div class="card-cover">${cover}<span class="card-mode">${escape(MODE_LABELS[game.mode])}</span></div>
          <div class="card-body"><p class="eyebrow">${escape(manifest?.ui?.eyebrow ?? MODE_LABELS[game.mode])}</p><h2 id="game-${index}-title">${escape(game.title)}</h2><p class="card-blurb">${escape(game.blurb)}</p>
            <p class="card-keys">${keys}</p><span class="card-cta">Play game <span aria-hidden="true">↗</span></span>
          </div>
        </a>
      </article>`;
    })
    .join('\n');
  return `  <main class="index">
    <header class="catalog-header"><p class="brand">Aegis</p><p class="eyebrow">Game collection</p><h1>Pick a world.<br />Make your move.</h1><p class="lede">Short, playable games. Choose a game below, then use a keyboard and mouse or a standard-mapped controller to find your way through.</p><p class="catalog-note">${options.staticSite ? 'Simulation runs in your browser.' : 'Live simulation · development preview'}</p></header>
    <section class="game-grid" aria-label="Games">
${cards || '      <p class="lede">No games are configured yet.</p>'}
    </section>
    <footer class="catalog-footer">Play first. Open the in-game diagnostics when you want to look under the hood.</footer>
  </main>`;
}

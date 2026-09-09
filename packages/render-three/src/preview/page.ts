import { escapeHtml, importMap, scriptJson } from '../pages.js';
import type { PreviewSettings } from './types.js';

export interface PreviewBootConfig {
  token: string;
  settings: PreviewSettings;
  watch: boolean;
  captureEnabled: boolean;
}

export function renderAssetPreviewPage(
  title: string,
  config: PreviewBootConfig,
  nonce: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>${escapeHtml(title)} - Aegis asset studio</title>
  <style>
    :root { color-scheme: dark; font: 14px/1.5 system-ui, sans-serif; color: #e5edf7; background: #101722; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, select, input { font: inherit; color: inherit; background: #1e2b3d; border: 1px solid #50617a; border-radius: 5px; padding: .45rem .6rem; min-height: 36px; }
    button { cursor: pointer; } button:hover { background: #304158; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    :focus-visible { outline: 3px solid #78ddcb; outline-offset: 3px; }
    header { min-height: 76px; padding: 14px 22px; border-bottom: 1px solid #344257; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    h1 { margin: 0; font-size: 19px; overflow-wrap: anywhere; }
    .eyebrow { color: #8ee3d1; text-transform: uppercase; font-size: 11px; letter-spacing: .16em; font-weight: 700; }
    .muted { color: #a5b5cb; font-size: 12px; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; height: calc(100dvh - 76px); min-height: 560px; }
    .viewport { display: flex; flex-direction: column; min-width: 0; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #344257; }
    .surface { position: relative; flex: 1; min-height: 300px; }
    canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; touch-action: none; }
    #status { margin: 0; padding: 9px 16px; border-top: 1px solid #344257; overflow-wrap: anywhere; }
    #error { margin: 0; padding: 12px 16px; background: #462a2a; color: #ffe0df; white-space: pre-wrap; max-height: 170px; overflow: auto; }
    [hidden] { display: none !important; }
    aside { padding: 18px; border-left: 1px solid #344257; overflow-y: auto; }
    fieldset { margin: 0 0 18px; border: 0; padding: 0; }
    legend { font-size: 11px; color: #a7bed6; text-transform: uppercase; letter-spacing: .12em; margin-bottom: 9px; font-weight: 700; }
    label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; font-size: 12px; }
    select, input:not([type=range]):not([type=color]) { width: 100%; }
    .row { display: flex; gap: 8px; align-items: center; } .row > label { flex: 1; min-width: 0; }
    #scrub { width: 100%; } #time { font-variant-numeric: tabular-nums; }
    dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; font-size: 12px; }
    dt { color: #a5b5cb; } dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
    #bounds, #provenance { font-size: 12px; overflow-wrap: anywhere; }
    a { color: #8ee3d1; }
    @media (max-width: 760px) { header { align-items: flex-start; } main { display: flex; flex-direction: column; height: auto; } .surface { height: 55dvh; flex: none; } aside { border-left: 0; border-top: 1px solid #344257; overflow: visible; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
  </style>
  <script type="importmap" nonce="${nonce}">${importMap('./')}</script>
</head>
<body>
  <header><div><div class="eyebrow">Aegis / Asset studio</div><h1>${escapeHtml(title)}</h1></div>
    <div class="muted">Asset-only preview<br>No game or simulation running</div></header>
  <main>
    <section class="viewport" aria-label="Asset viewport">
      <div class="toolbar">
        <button id="fit" type="button" title="Reset camera to asset bounds (F)">Fit asset</button>
        <button id="reload" type="button">Reload source</button>
        <span id="watch" class="muted"></span>
      </div>
      <div class="surface"><canvas id="preview" tabindex="0" aria-label="3D asset. Drag to orbit; right-drag or arrow keys to pan; wheel or plus and minus to zoom; F to fit."></canvas></div>
      <p id="status" role="status" aria-live="polite">Preparing asset preview...</p>
      <pre id="error" role="alert" hidden></pre>
    </section>
    <aside aria-label="Studio controls">
      <fieldset><legend>Specimen</legend>
        <label>Asset<select id="asset"></select></label>
        <label id="frame-label" hidden>Atlas frame<select id="frame"></select></label>
        <label id="material-label" hidden>Material override<select id="material"></select></label>
        <label id="shape-label" hidden>Material sample<select id="shape"><option value="sphere">Sphere</option><option value="cube">Cube</option><option value="plane">Plane</option></select></label>
      </fieldset>
      <fieldset><legend>Camera &amp; studio</legend>
        <label>View<select id="view"><option value="three-quarter">Three-quarter</option><option value="front">Front (+Z)</option><option value="back">Back (-Z)</option><option value="left">Left (-X)</option><option value="right">Right (+X)</option><option value="top">Top (+Y)</option></select></label>
        <label>Projection<select id="projection"><option value="perspective">Perspective</option><option value="orthographic">Orthographic</option></select></label>
        <label>Lighting<select id="lighting"><option value="studio">Studio</option><option value="neutral">Neutral</option><option value="warm">Warm</option></select></label>
        <label>Background<input id="background" type="color" value="#18212f"></label>
      </fieldset>
      <fieldset><legend>Animation</legend>
        <label>Clip<select id="clip"><option value="">Rest pose</option></select></label>
        <label>Sample time <output id="time" for="scrub">0.000 s</output><input id="scrub" type="range" min="0" max="1" step="0.001" value="0" disabled></label>
        <button id="play" type="button" disabled>Play clip</button>
        <p class="muted">Studio playback only. Starts paused; reduced-motion preference pauses playback.</p>
      </fieldset>
      <fieldset><legend>Asset facts</legend><dl id="stats"></dl><p id="bounds"></p><p id="provenance" class="muted"></p></fieldset>
      <fieldset><legend>Capture current view</legend>
        <label>PNG filename<input id="filename" value="asset-preview.png" maxlength="100" spellcheck="false"></label>
        <div class="row"><label>Width<input id="width" type="number" min="64" max="4096" value="1024"></label><label>Height<input id="height" type="number" min="64" max="4096" value="768"></label></div>
        <button id="capture" type="button" disabled>Save PNG + recipe</button>
        <p id="capture-result" class="muted" role="status"></p>
      </fieldset>
      <p class="muted">Drag: orbit. Right-drag / arrows: pan.<br>Wheel / +/-: zoom. F / Home: fit.<br>Captures contain the asset, not this interface.</p>
    </aside>
  </main>
  <script type="module" nonce="${nonce}">
    import { bootAssetPreview } from './vendor/@aegis/render-three/dist/preview/client/boot.js';
    bootAssetPreview(${scriptJson(config)});
  </script>
</body>
</html>`;
}

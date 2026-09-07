/**
 * Dev HTML documents. All addresses are relative to canonical trailing-slash play pages, so
 * the same bytes work at the origin root or beneath the dev server's deployment prefix.
 */
import type { GameDefinition } from './catalog.js';
import type { BootConfig } from './protocol.js';
import { PAGE_STYLE, renderCatalogBody, renderGameChrome } from './page-chrome.js';
import { preparePresentation } from './presentation/files.js';
import type { PresentationManifest, ResolvedPresentation } from './presentation/schema.js';

export { PAGE_STYLE } from './page-chrome.js';

/** Escape a string for interpolation into HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON used inside a script must not be able to terminate that HTML element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** A cover is an asset id, never an arbitrary URL or a host path. */
export function presentationCover(
  manifest: PresentationManifest | undefined,
  base: string,
): string | undefined {
  if (manifest?.ui?.cover === undefined) return undefined;
  const cover = manifest.assets?.find((asset) => asset.id === manifest.ui?.cover);
  return cover === undefined ? undefined : base + cover.src;
}

/** The import map for a play page, or a caller-supplied relative prefix to the site root. */
export function importMap(base = '../../'): string {
  return scriptJson({
    imports: {
      three: `${base}vendor/three/build/three.module.js`,
      'three/': `${base}vendor/three/`,
      'three/addons/loaders/GLTFLoader.js': `${base}vendor/three/examples/jsm/loaders/GLTFLoader.js`,
      'three/addons/utils/SkeletonUtils.js': `${base}vendor/three/examples/jsm/utils/SkeletonUtils.js`,
      '@aegis/core': `${base}vendor/@aegis/core/dist/index.js`,
      '@aegis/core/math': `${base}vendor/@aegis/core/dist/math/index.js`,
      '@aegis/content': `${base}vendor/@aegis/content/dist/index.js`,
      '@aegis/harness': `${base}vendor/@aegis/harness/dist/index.js`,
      '@aegis/mode-platformer': `${base}vendor/@aegis/mode-platformer/dist/index.js`,
      '@aegis/mode-iso': `${base}vendor/@aegis/mode-iso/dist/index.js`,
      '@aegis/mode-fps': `${base}vendor/@aegis/mode-fps/dist/index.js`,
      '@aegis/render-three/client/boot': `${base}vendor/@aegis/render-three/dist/client/boot.js`,
      '@aegis/render-three/presentation': `${base}vendor/@aegis/render-three/dist/presentation/index.js`,
      '@aegis/render-three/presentation/schema': `${base}vendor/@aegis/render-three/dist/presentation/schema.js`,
      '@aegis/render-three/presentation/validate': `${base}vendor/@aegis/render-three/dist/presentation/validate.js`,
    },
  });
}

/** The landing page linking every game in the catalogue. */
export function renderIndexPage(games: readonly GameDefinition[]): string {
  const body = renderCatalogBody({
    games: games.map((game) => ({
      id: game.id,
      title: game.title,
      blurb: game.blurb,
      mode: game.mode,
      bindings: game.bindings,
      ...(game.presentation === undefined ? {} : { manifest: game.presentation.manifest }),
      coverUrl: presentationCover(game.presentation?.manifest, `assets/${game.id}/`),
    })),
    gameHref: (id: string) => `play/${id}/`,
    staticSite: false,
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>Aegis — play the proof-of-concept games</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** The play page for one game. Hosts can pass their already-prepared asset inventory. */
export function renderPlayPage(game: GameDefinition, presentation?: ResolvedPresentation): string {
  if (presentation === undefined && game.presentation !== undefined) {
    const prepared = preparePresentation(game.presentation, game.scene);
    presentation = {
      manifest: prepared.manifest,
      baseUrl: `../../assets/${game.id}/`,
      files: prepared.files.map((file) => file.path),
    };
  }
  const config: BootConfig = {
    gameId: game.id,
    mode: game.mode,
    title: game.title,
    objective: game.objective,
    bindings: game.bindings,
    tickRate: game.tickRate ?? 60,
    api: `../../api/${game.id}`,
    ...(presentation === undefined ? {} : { presentation }),
  };
  const body = renderGameChrome({
    title: game.title,
    objective: game.objective,
    mode: game.mode,
    bindings: game.bindings,
    backHref: '../../',
    ...(presentation === undefined ? {} : { manifest: presentation.manifest }),
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>${escapeHtml(game.title)} — Aegis</title>
  <style>${PAGE_STYLE}</style>
  <script type="importmap">
${importMap()}
  </script>
</head>
<body>
${body}
  <script type="module">
    import { boot } from '@aegis/render-three/client/boot';
    boot(${scriptJson(config)});
  </script>
</body>
</html>
`;
}

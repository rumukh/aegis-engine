/**
 * The **static** site: the same three games, exported as files a dumb HTTP server can hand out.
 *
 * `./dev-server.ts` is a Node process that owns the simulation and answers `POST /api/<id>/frame`.
 * GitHub Pages runs no process at all, so a site built from `./pages.ts` and uploaded unchanged
 * would boot, paint its HUD and then fail every exchange for ever — deployed-looking and unplayable.
 * `./client/static-boot.ts` moves the session into the page; this module is what writes the page.
 *
 * Three properties are worth stating, because each one is a way the export could have been a shell:
 *
 * 1. **Every URL is relative.** No `/vendor/...`, no `/play/iso`. The artifact is therefore
 *    base-path independent: the identical bytes work at `https://user.github.io/aegis-engine/`, at
 *    a domain root, and under any prefix a reviewer serves it from. Import-map addresses are
 *    resolved against the document's base URL, so `../../vendor/...` is all it takes — and it is
 *    the one spelling that cannot be broken by a project page's `/<repo>/` prefix.
 * 2. **The module graph is crawled, and only what is reachable is copied.** Not "copy `dist`":
 *    `packages/render-three/dist` contains `dev-server.js`, `catalog.js` and `capture.js`, which
 *    import `node:http` and `node:fs`. A copy-everything export would ship them, and nothing would
 *    say so. {@link collectModuleGraph} starts from the page's own entry modules and follows
 *    static imports, so a Node-only module can only reach the artifact by actually being imported.
 * 3. **A static specifier that cannot be resolved is a build failure, not a 404 in someone's
 *    browser.** That is the check that makes the first two mean anything: the exporter refuses to
 *    write a site whose graph names a module it cannot serve — including any `node:` built-in.
 *
 * This module knows nothing about any game (`scripts/check-deps.mjs`: the engine must never depend
 * on a game). It is handed a catalogue, exactly as the dev server is; `poc/build-site.mjs` is the
 * composition root that names the three PoCs.
 * @packageDocumentation
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { DiagnosticError } from '@aegis/core';
import type { Diagnostic, GameMode } from '@aegis/core';
import { parseScene } from '@aegis/content';
import type { ModeBindings } from './bindings.js';
import { escapeHtml, presentationCover, scriptJson } from './pages.js';
import { PAGE_STYLE, renderCatalogBody, renderGameChrome } from './page-chrome.js';
import { preparePresentation, readPreparedPresentationFile } from './presentation/files.js';
import type { PreparedPresentation } from './presentation/files.js';
import { renderDiagnostic, RenderCode } from './presentation/diagnostics.js';
import type {
  PresentationSource,
  Provenance,
  ResolvedPresentation,
} from './presentation/schema.js';

// ---------------------------------------------------------------------------------------------
// The module table
// ---------------------------------------------------------------------------------------------

/**
 * One bare specifier the browser must be able to resolve, and where it lives on disk.
 *
 * `name` doubles as the directory under `vendor/`, which is what makes the mapping reversible: a
 * file at `<root>/<rest>` is served from `vendor/<name>/<rest>`. That is the same shape
 * {@link "./dev-server".resolveVendorPath} serves, so a module URL means the same thing in the dev
 * server and in the exported site.
 */
export interface StaticModule {
  /** The specifier as written in source, e.g. `"@aegis/core/math"`. */
  specifier: string;
  /** The package it belongs to; also its directory under `vendor/`. */
  name: string;
  /** Absolute path of the package root. */
  root: string;
  /** Absolute path of the module the specifier resolves to. */
  entry: string;
}

/**
 * The subpath specifier the generated boot module imports the browser runtime from.
 *
 * A subpath rather than the package barrel, and a **declared** one:
 * `packages/render-three/package.json` exports it, so this string resolves in Node too and is not
 * a fiction the import map maintains on its own.
 */
export const STATIC_BOOT_SPECIFIER = '@aegis/render-three/client/static-boot';

/**
 * The engine's own bare specifiers, as repo-relative paths.
 *
 * `@aegis/render-three`'s **barrel** is deliberately absent: `dist/index.js` re-exports the dev
 * server, the catalogue loader and the screenshot capture — three Node-only modules — so a page
 * that imported it would drag `node:http` into the graph. The browser entry is named by its own
 * subpath specifier instead, which `packages/render-three/package.json` also declares, so the
 * specifier the generated boot module writes is a real one in Node as well as in the import map.
 */
const ENGINE_MODULE_PATHS: readonly {
  specifier: string;
  name: string;
  root: string;
  entry: string;
}[] = [
  {
    specifier: 'three',
    name: 'three',
    root: 'node_modules/three',
    entry: 'node_modules/three/build/three.module.js',
  },
  {
    specifier: 'three/addons/loaders/GLTFLoader.js',
    name: 'three',
    root: 'node_modules/three',
    entry: 'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
  },
  {
    specifier: 'three/addons/utils/SkeletonUtils.js',
    name: 'three',
    root: 'node_modules/three',
    entry: 'node_modules/three/examples/jsm/utils/SkeletonUtils.js',
  },
  {
    specifier: '@aegis/core',
    name: '@aegis/core',
    root: 'packages/core',
    entry: 'packages/core/dist/index.js',
  },
  {
    specifier: '@aegis/core/math',
    name: '@aegis/core',
    root: 'packages/core',
    entry: 'packages/core/dist/math/index.js',
  },
  {
    specifier: '@aegis/content',
    name: '@aegis/content',
    root: 'packages/content',
    entry: 'packages/content/dist/index.js',
  },
  {
    specifier: '@aegis/harness',
    name: '@aegis/harness',
    root: 'packages/harness',
    entry: 'packages/harness/dist/index.js',
  },
  {
    specifier: '@aegis/mode-platformer',
    name: '@aegis/mode-platformer',
    root: 'packages/mode-platformer',
    entry: 'packages/mode-platformer/dist/index.js',
  },
  {
    specifier: '@aegis/mode-iso',
    name: '@aegis/mode-iso',
    root: 'packages/mode-iso',
    entry: 'packages/mode-iso/dist/index.js',
  },
  {
    specifier: '@aegis/mode-fps',
    name: '@aegis/mode-fps',
    root: 'packages/mode-fps',
    entry: 'packages/mode-fps/dist/index.js',
  },
  {
    specifier: STATIC_BOOT_SPECIFIER,
    name: '@aegis/render-three',
    root: 'packages/render-three',
    entry: 'packages/render-three/dist/client/static-boot.js',
  },
  {
    specifier: '@aegis/render-three/input',
    name: '@aegis/render-three',
    root: 'packages/render-three',
    entry: 'packages/render-three/dist/input.js',
  },
  {
    specifier: '@aegis/render-three/presentation',
    name: '@aegis/render-three',
    root: 'packages/render-three',
    entry: 'packages/render-three/dist/presentation/index.js',
  },
  {
    specifier: '@aegis/render-three/presentation/schema',
    name: '@aegis/render-three',
    root: 'packages/render-three',
    entry: 'packages/render-three/dist/presentation/schema.js',
  },
  {
    specifier: '@aegis/render-three/presentation/validate',
    name: '@aegis/render-three',
    root: 'packages/render-three',
    entry: 'packages/render-three/dist/presentation/validate.js',
  },
];

/** The engine's module table, resolved against `repoRoot`. */
export function engineModules(repoRoot: string): StaticModule[] {
  return ENGINE_MODULE_PATHS.map((module) => ({
    specifier: module.specifier,
    name: module.name,
    root: join(repoRoot, ...module.root.split('/')),
    entry: join(repoRoot, ...module.entry.split('/')),
  }));
}

/** The browser entry inside `@aegis/render-three` that a generated boot module imports. */
export const STATIC_BOOT_MODULE = 'packages/render-three/dist/client/static-boot.js';
// ---------------------------------------------------------------------------------------------
// The crawler
// ---------------------------------------------------------------------------------------------

/**
 * Strip line and block comments so a module that merely *mentions* a specifier is not followed.
 *
 * Approximate in one direction only, and one direction is what is wanted: stripping can remove
 * text but never invent it, so the worst it can do is miss a real import — which surfaces as a
 * missing file in a browser and a red browser spec, never as a silently larger artifact. The same
 * argument `test/browser-specs-run-solo.test.ts` makes about its own textual scan.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * `import ... from 'x'` and `export ... from 'x'`, **anchored to the start of a line**.
 *
 * The anchor is what keeps a string literal from being read as an import. `tsc` emits every module
 * specifier at column 0, so anchoring costs nothing real and removes the whole false-positive
 * class: a message like `throw new Error('cannot import x from ' + y)` is indented, and an
 * unanchored scan would happily read a specifier out of it and then fail the export over a module
 * nobody imports. Measured on this repository's emitted output and on `three.module.js` (1.27 MB
 * of rollup output, zero import statements): identical results, no false positives.
 */
const FROM_RE = /^[ \t]*(?:import|export)\b[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/gm;
/** A bare side-effect import, `import 'x'`. */
const BARE_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
/** A dynamic `import('x')`, which may appear anywhere. */
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The specifiers a module names, split by how the browser would fetch them. */
export interface ModuleSpecifiers {
  /** Fetched eagerly when the module loads. Every one of these must resolve. */
  statik: string[];
  /** Fetched only if that branch runs. Recorded and reported, never fatal. */
  dynamic: string[];
}

/**
 * The specifiers `source` imports.
 *
 * Static and dynamic are kept apart because they carry different obligations. A static import is
 * part of the graph the browser downloads before the module evaluates: if it cannot be resolved,
 * the page is dead on arrival, so an unresolvable one must fail the export. A dynamic import is a
 * runtime decision that may never be taken — `@aegis/harness`'s `run.ts` defers
 * `node:fs/promises` precisely so that importing the harness in a page costs nothing — so an
 * unresolvable one is reported and left alone rather than treated as a lie.
 */
export function moduleSpecifiers(source: string): ModuleSpecifiers {
  const dynamic: string[] = [];
  // Dynamic imports are lifted out first and replaced, so `import(` can never be mistaken for the
  // side-effect form `import '...'` by the scan below. One pass, no ordering subtlety.
  const text = withoutComments(source).replace(DYNAMIC_RE, (_match, specifier: string) => {
    dynamic.push(specifier);
    return ' /* dynamic */ ';
  });
  const statik = new Set<string>();
  for (const re of [FROM_RE, BARE_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) statik.add(match[1] as string);
  }
  return { statik: [...statik], dynamic };
}

/** A module the crawler reached, and where it must be written in the artifact. */
export interface GraphFile {
  /** Absolute path on disk. */
  source: string;
  /** Forward-slashed path inside the artifact, e.g. `vendor/@aegis/core/dist/index.js`. */
  target: string;
}

/** The outcome of a crawl. */
export interface ModuleGraph {
  /** Every reachable module, in the order it was first reached. */
  files: GraphFile[];
  /** The bare specifiers that were actually resolved, sorted. */
  usedSpecifiers: string[];
  /** Deferred (`import(...)`) specifiers that resolve to nothing servable, `"file → specifier"`. */
  deferred: string[];
}

/** Thrown when the graph names something the artifact could not serve. */
export class StaticGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticGraphError';
  }
}

/**
 * Is `child` inside `parent` (or the same directory)?
 *
 * The `isAbsolute` clause is the whole point, and leaving it out cost a CI round trip. On Windows,
 * `path.relative` between two different **drives** returns the target as an absolute path — there
 * is no `..` chain that gets you from `C:\` to `D:\`. So `relative(outDir, repoRoot)` answered
 * `D:\a\aegis-engine\aegis-engine` on a hosted runner whose repository is on `D:` and whose
 * `os.tmpdir()` is on `C:`, and every "does not start with `..`, therefore it is inside" test in
 * this file inverted at once: the export guard refused a perfectly good temp directory, and
 * `placeOf` would have addressed a vendored module as if it lived in the artifact.
 *
 * Neither showed up locally, because on a development machine the repository and the temp
 * directory are on the same drive; the same code answers correctly there for the wrong reason.
 * `scripts/check-deps.mjs` has had this clause since it was written.
 *
 * `api` is injectable so the Windows semantics can be driven from any host — see
 * `static-site.test.ts`, which checks both `path.win32` and `path.posix`. A cross-drive case is
 * unreachable on POSIX, and a bug reachable on only one CI leg is a bug nobody can debug locally.
 */
export function isInside(
  parent: string,
  child: string,
  api: {
    relative: (a: string, b: string) => string;
    isAbsolute: (p: string) => boolean;
    sep: string;
  } = {
    relative,
    isAbsolute,
    sep,
  },
): boolean {
  const rel = api.relative(parent, child);
  if (api.isAbsolute(rel)) return false;
  return rel === '' || !(rel.startsWith('..' + api.sep) || rel === '..');
}

/** Where a module lands under `vendor/`, or `undefined` if it escapes every known package root. */
function vendorTarget(modules: readonly StaticModule[], file: string): string | undefined {
  for (const module of modules) {
    if (!isInside(module.root, file)) continue;
    return posix.join('vendor', module.name, ...relative(module.root, file).split(sep));
  }
  return undefined;
}

/**
 * Walk the static import graph from `entries` and report every module it reaches.
 *
 * @param options.entries absolute paths of the modules the pages import first
 * @param options.modules the bare-specifier table (see {@link engineModules})
 * @param options.siteRoot modules already inside the artifact keep their own path instead of being
 *   placed under `vendor/`. This is how the generated per-game boot modules — which belong to no
 *   package — take part in the same crawl as everything else, so the graph that is checked is the
 *   graph that ships.
 * @param options.read reads a file; injectable so a test can drive a synthetic graph
 * @param options.exists whether a path is a readable file; injectable for the same reason
 */
export function collectModuleGraph(options: {
  entries: readonly string[];
  modules: readonly StaticModule[];
  siteRoot?: string;
  read?: (file: string) => string;
  exists?: (file: string) => boolean;
}): ModuleGraph {
  const read = options.read ?? ((file: string) => readFileSync(file, 'utf8'));
  const exists =
    options.exists ??
    ((file: string) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  const bySpecifier = new Map(options.modules.map((module) => [module.specifier, module]));
  const siteRoot = options.siteRoot === undefined ? undefined : resolve(options.siteRoot);

  const files: GraphFile[] = [];
  const usedSpecifiers = new Set<string>();
  const deferred: string[] = [];
  const seen = new Set<string>();
  const queue = [...options.entries];

  /** Resolve one specifier written in `from`, or `undefined` when the site cannot serve it. */
  const resolveSpecifier = (from: string, specifier: string): string | undefined => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return resolve(dirname(from), specifier);
    }
    const module = bySpecifier.get(specifier);
    if (module === undefined) return undefined;
    usedSpecifiers.add(specifier);
    return module.entry;
  };

  /** Where a reached module is addressed inside the artifact. */
  const placeOf = (file: string): string | undefined => {
    if (siteRoot !== undefined && file !== siteRoot && isInside(siteRoot, file)) {
      return relative(siteRoot, file).split(sep).join('/');
    }
    return vendorTarget(options.modules, file);
  };

  while (queue.length > 0) {
    const file = queue.shift() as string;
    const key = resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);

    if (!exists(key)) {
      throw new StaticGraphError(
        `[aegis:static-site] the module graph reaches ${key}, which does not exist. ` +
          'Run `npm run build` before exporting the site.',
      );
    }
    const target = placeOf(key);
    if (target === undefined) {
      throw new StaticGraphError(
        `[aegis:static-site] ${key} is outside every package the site vendors, so it has no ` +
          'address in the artifact. A relative import escaped its own package.',
      );
    }
    files.push({ source: key, target });

    const { statik, dynamic } = moduleSpecifiers(read(key));
    for (const specifier of statik) {
      const resolved = resolveSpecifier(key, specifier);
      if (resolved === undefined) {
        throw new StaticGraphError(
          `[aegis:static-site] ${key} statically imports "${specifier}", which the static site ` +
            'cannot serve. A browser fetches static imports before the module runs, so this page ' +
            'would be dead on arrival. Add the specifier to the module table, or stop importing ' +
            'it from code the page loads.',
        );
      }
      queue.push(resolved);
    }
    for (const specifier of dynamic) {
      if (resolveSpecifier(key, specifier) === undefined) deferred.push(`${key} → ${specifier}`);
    }
  }

  return { files, usedSpecifiers: [...usedSpecifiers].sort(), deferred };
}

// ---------------------------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------------------------

/** One playable entry in the exported site. Deliberately game-agnostic; see `poc/build-site.mjs`. */
export interface StaticGame {
  /** URL slug, e.g. `"iso"`. Becomes `play/<id>/`. */
  id: string;
  /** Display title. */
  title: string;
  /** One-line pitch for the landing page. */
  blurb: string;
  /** The mode whose adapter draws it. */
  mode: GameMode;
  /** What winning looks like, shown in the HUD. */
  objective: string;
  /** How a human drives it. */
  bindings: ModeBindings;
  /** The scene document as **text**, embedded verbatim in the generated boot module. */
  sceneText: string;
  /** Bare specifier of the module exporting the composed plugin, e.g. `"@aegis/game-iso"`. */
  pluginModule: string;
  /** The export name on that module, e.g. `"serverVaultPlugin"`. */
  pluginExport: string;
  /** Seed override; defaults to the scene's. */
  seed?: number | string;
  /** Fixed ticks per second. Defaults to `60`. */
  tickRate?: number;
  /** Optional render-only local assets and presentation. */
  presentation?: PresentationSource;
}

/** A JS identifier, so a generated `import { X }` cannot be anything but an import. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How many `../` segments reach the site root from a play page. */
const PLAY_DEPTH = '../../';

/**
 * The import map for a page at `base` (a relative prefix reaching the site root).
 *
 * Every address is relative. An import map's addresses resolve against the document's base URL, so
 * this is the one spelling that survives being served from `/aegis-engine/`, from a domain root,
 * and from a reviewer's `python -m http.server` in a subdirectory — without the exporter being
 * told which it will be.
 */
export function staticImportMap(base: string, modules: readonly StaticModule[]): string {
  const imports: Record<string, string> = {};
  for (const module of [...modules].sort((a, b) => a.specifier.localeCompare(b.specifier))) {
    const rel = relative(module.root, module.entry)
      .split(sep)
      .filter((part) => part !== '');
    imports[module.specifier] = base + posix.join('vendor', module.name, ...rel);
  }
  return scriptJson({ imports });
}

function prepareStaticPresentation(game: StaticGame): PreparedPresentation | undefined {
  if (game.presentation === undefined) return undefined;
  const parsed = parseScene(game.sceneText, `${game.id}.scene.json`);
  if (!parsed.ok || parsed.value === undefined) throw new DiagnosticError(parsed.diagnostics);
  return preparePresentation(game.presentation, parsed.value);
}

function resolvedPresentation(
  id: string,
  prepared: PreparedPresentation | undefined,
): ResolvedPresentation | undefined {
  return prepared === undefined
    ? undefined
    : {
        manifest: prepared.manifest,
        baseUrl: `${PLAY_DEPTH}assets/${id}/`,
        files: prepared.files.map((file) => file.path),
      };
}

/** The generated ES module that boots one game. This is the page's entry into the graph. */
export function renderStaticBootModule(
  game: StaticGame,
  presentation = resolvedPresentation(game.id, prepareStaticPresentation(game)),
): string {
  if (!IDENTIFIER.test(game.pluginExport)) {
    throw new StaticGraphError(
      `[aegis:static-site] "${game.pluginExport}" is not a JavaScript identifier, so it cannot ` +
        `be imported by name from "${game.pluginModule}".`,
    );
  }
  const config = {
    gameId: game.id,
    mode: game.mode,
    title: game.title,
    objective: game.objective,
    bindings: game.bindings,
    ...(game.seed !== undefined ? { seed: game.seed } : {}),
    ...(game.tickRate !== undefined ? { tickRate: game.tickRate } : {}),
    ...(presentation === undefined ? {} : { presentation }),
  };
  const pluginModule = scriptJson(game.pluginModule).slice(1, -1).replace(/'/g, '\\u0027');
  return `// Generated by @aegis/render-three's static-site exporter. Do not edit.
//
// The simulation runs HERE, in your browser. There is no server: this module builds the same
// live session \`node poc/play.mjs\` builds, from the same composed plugin and the same scene
// document, and \`bootStatic\` steps it on the same fixed timestep a headless run uses.
import { parseScene } from '@aegis/content';
import { bootStatic } from '${STATIC_BOOT_SPECIFIER}';
import { ${game.pluginExport} } from '${pluginModule}';

/** The scene document, verbatim. Text is the substrate (CHARTER principle 1). */
const SCENE_TEXT = ${scriptJson(game.sceneText)};

const parsed = parseScene(SCENE_TEXT, ${scriptJson(`${game.id}.scene.json`)});
if (!parsed.ok || parsed.value === undefined) {
  throw new Error(
    '[aegis] the embedded scene failed validation:\\n' +
      parsed.diagnostics.map((d) => \`  \${d.code} \${d.message}\`).join('\\n'),
  );
}

bootStatic({ ...${scriptJson(config)}, plugin: ${game.pluginExport}, scene: parsed.value });
`;
}

/**
 * An inline favicon, so a page makes **no** root-relative request.
 *
 * Without it every page triggers a `GET /favicon.ico` at the *origin* root — which under a project
 * Pages site is outside the site entirely, 404s, and shows up in the console of a page that is
 * otherwise perfectly self-contained. It is also the one root-relative URL a page cannot avoid by
 * writing relative hrefs, because the browser makes it up. A data URI removes the request.
 *
 * Base64 rather than a percent-encoded SVG: the markup contains `#`, `<` and quotes, all of which
 * need escaping differently in a URL and in an HTML attribute, and getting one of the two wrong
 * produces a broken icon nobody notices. Base64 has one rule.
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<rect width="16" height="16" rx="3" fill="#0b1220"/>' +
  '<path d="M8 2.5 13 5v4.2C13 12 10.8 13.4 8 14 5.2 13.4 3 12 3 9.2V5z" fill="#67e8f9"/>' +
  '</svg>';
const FAVICON = `data:image/svg+xml;base64,${Buffer.from(FAVICON_SVG, 'utf8').toString('base64')}`;

/** The landing page: what this is, and one card per game. */
export function renderStaticIndexPage(games: readonly StaticGame[]): string {
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
    staticSite: true,
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="${FAVICON}" />
  <title>Aegis — play the proof-of-concept games</title>
  <meta name="description" content="Three playable proof-of-concept games from Aegis, an
    agent-first, deterministic, headless-first game engine. The simulation runs in your browser." />
  <style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** The play page for one game. */
export function renderStaticPlayPage(game: StaticGame, modules: readonly StaticModule[]): string {
  const body = renderGameChrome({
    title: game.title,
    objective: game.objective,
    mode: game.mode,
    bindings: game.bindings,
    backHref: PLAY_DEPTH,
    ...(game.presentation === undefined ? {} : { manifest: game.presentation.manifest }),
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="${FAVICON}" />
  <title>${escapeHtml(game.title)} — Aegis</title>
  <style>${PAGE_STYLE}</style>
  <script type="importmap">
${staticImportMap(PLAY_DEPTH, modules)}
  </script>
</head>
<body>
${body}
  <script type="module" src="./boot.js"></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------------------------

/** Options for {@link exportStaticSite}. */
export interface ExportOptions {
  /** The catalogue to publish. Must not be empty. */
  games: readonly StaticGame[];
  /** Absolute output directory. Replaced only after asset and module preflight succeeds. */
  outDir: string;
  /** Repository root, used to resolve the engine module table. */
  repoRoot: string;
  /** Extra bare specifiers the games need, e.g. their own packages. */
  modules?: readonly StaticModule[];
}

/** What an export produced. */
export interface ExportResult {
  /** Where it was written. */
  outDir: string;
  /** Site-relative paths of every file written, sorted. */
  files: string[];
  /** Site-relative paths of the generated HTML pages, sorted. */
  pages: string[];
  /** How many JavaScript modules the graph reached. */
  modules: number;
  /** Total bytes written. */
  bytes: number;
  /** Prepared presentation file count (including glTF image/buffer dependencies). */
  assetFiles: number;
  /** Bytes copied from the prepared presentation closures. */
  assetBytes: number;
  /** Public provenance inventory. Host source paths are deliberately absent. */
  assets: ExportedPresentationFile[];
  /** Deferred specifiers the graph named but the artifact does not serve. See {@link ModuleGraph}. */
  deferred: string[];
  /** Nonfatal preflight notes; deferred names still require initialized-world validation. */
  diagnostics?: readonly Diagnostic[];
}

export interface ExportedPresentationFile {
  gameId: string;
  /** Site-relative path, including assets/<gameId>/. */
  path: string;
  bytes: number;
  sha256: string;
  provenance?: Provenance;
}

/** Write `text` to `file`, creating parents. Returns the byte length. */
function write(file: string, text: string): number {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return Buffer.byteLength(text, 'utf8');
}

/** Whether `path` exists at all, without throwing. */
function statSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Export the whole site to `outDir`.
 *
 * Throws {@link StaticGraphError} rather than writing a site whose module graph is not closed —
 * that refusal is the difference between publishing a game and publishing a page that looks like
 * one.
 */
export function exportStaticSite(options: ExportOptions): ExportResult {
  if (options.games.length === 0) {
    throw new StaticGraphError('[aegis:static-site] at least one game is required');
  }
  const modules = [...engineModules(options.repoRoot), ...(options.modules ?? [])];
  const outDir = resolve(options.outDir);

  // This function replaces `outDir` after preflight, so it had better not be somewhere that
  // matters. Two refusals, and the pair is deliberate: an ancestor check alone would still let
  // someone point this at a sibling checkout, and a marker-file check alone would not stop
  // `--out ..`. A directory that *contains* the repository, or that holds a `package.json` or a
  // `.git`, is not a build output — it is somebody's work.
  const repoRoot = resolve(options.repoRoot);
  if (isInside(outDir, repoRoot)) {
    throw new StaticGraphError(
      `[aegis:static-site] refusing to write the site to ${outDir}: the repository is inside it, ` +
        'and this directory is deleted before it is written.',
    );
  }
  if (statSafe(join(outDir, 'package.json')) || statSafe(join(outDir, '.git'))) {
    throw new StaticGraphError(
      `[aegis:static-site] refusing to write the site to ${outDir}: it looks like a project ` +
        'directory, and this directory is deleted before it is written.',
    );
  }

  const ids = new Set<string>();
  const assetCopies: { inventory: ExportedPresentationFile; contents: Buffer }[] = [];
  const boots = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  for (const game of options.games) {
    if (!/^[A-Za-z0-9_-]+$/.test(game.id) || ids.has(game.id.toLowerCase()))
      throw new StaticGraphError(
        `[aegis:static-site] duplicate or invalid game id "${game.id}"; use unique letters, digits, "_" and "-"`,
      );
    ids.add(game.id.toLowerCase());
    const presentation = prepareStaticPresentation(game);
    if (presentation !== undefined) {
      for (const diagnostic of presentation.diagnostics ?? [])
        diagnostics.push({
          ...diagnostic,
          data: { ...diagnostic.data, gameId: game.id },
        });
      for (const file of presentation.files) {
        if (isInside(outDir, file.source))
          throw new DiagnosticError([
            renderDiagnostic(
              RenderCode.Path,
              'assetRoot',
              `Output "${outDir}" contains source asset "${file.path}" for game "${game.id}".`,
              'Choose an output directory separate from the authored asset directory.',
            ),
          ]);
        assetCopies.push({
          inventory: {
            gameId: game.id,
            path: `assets/${game.id}/${file.path}`,
            bytes: file.bytes,
            sha256: file.sha256,
            ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
          },
          contents: readPreparedPresentationFile(file),
        });
      }
    }
    boots.set(
      join(outDir, 'play', game.id, 'boot.js'),
      renderStaticBootModule(game, resolvedPresentation(game.id, presentation)),
    );
  }

  // Preflight the exact boot strings and asset bytes before replacing any previous export.
  // Generated entries live in memory; the rest of the crawler still reads the real module graph.
  const graph = collectModuleGraph({
    entries: [...boots.keys()],
    modules,
    siteRoot: outDir,
    read: (file) => boots.get(file) ?? readFileSync(file, 'utf8'),
    exists: (file) => {
      if (boots.has(file)) return true;
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
  });

  // Only the specifiers the graph actually used reach the import map. A map entry pointing at a
  // module nobody imports is a module nobody copied — a dangling address that would 404 the first
  // time anything did import it, with nothing in the build to say so.
  const used = modules.filter((module) => graph.usedSpecifiers.includes(module.specifier));

  for (const file of graph.files) {
    if (!file.target.startsWith('vendor/') && !boots.has(file.source))
      throw new StaticGraphError(
        `[aegis:static-site] ${file.source} was reached at site path "${file.target}", which is ` +
          'neither a vendored module nor a generated boot module.',
      );
  }
  for (const diagnostic of diagnostics)
    console.warn(
      `[aegis:static-site] ${diagnostic.data?.gameId} ${diagnostic.code}: ${diagnostic.message}\n  fix: ${diagnostic.fix}`,
    );
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const written: { path: string; bytes: number }[] = [];
  const pages: string[] = [];
  for (const [path, source] of boots)
    written.push({ path: relative(outDir, path).split(sep).join('/'), bytes: write(path, source) });

  for (const file of graph.files) {
    if (!file.target.startsWith('vendor/')) {
      continue;
    }
    const target = join(outDir, ...file.target.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.source, target);
    written.push({ path: file.target, bytes: statSync(file.source).size });
  }
  for (const { inventory, contents } of assetCopies) {
    const target = join(outDir, ...inventory.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    written.push({ path: inventory.path, bytes: contents.length });
  }

  const index = renderStaticIndexPage(options.games);
  written.push({ path: 'index.html', bytes: write(join(outDir, 'index.html'), index) });
  pages.push('index.html');
  // Pages serves 404.html for unknown paths; sending people back to the landing page beats the
  // default, which says nothing about what this site is.
  written.push({ path: '404.html', bytes: write(join(outDir, '404.html'), index) });
  pages.push('404.html');
  for (const game of options.games) {
    const path = `play/${game.id}/index.html`;
    written.push({
      path,
      bytes: write(join(outDir, 'play', game.id, 'index.html'), renderStaticPlayPage(game, used)),
    });
    pages.push(path);
  }
  // The official Pages pipeline does not run Jekyll, but a `gh-pages` branch served the old way
  // would, and Jekyll drops paths beginning with `_`. Costs one empty file to never find out.
  written.push({ path: '.nojekyll', bytes: write(join(outDir, '.nojekyll'), '') });

  return {
    outDir,
    files: written.map((entry) => entry.path).sort(),
    pages: pages.sort(),
    modules: graph.files.length,
    bytes: written.reduce((total, entry) => total + entry.bytes, 0),
    assetFiles: assetCopies.length,
    assetBytes: assetCopies.reduce((total, entry) => total + entry.contents.length, 0),
    assets: assetCopies
      .map((entry) => entry.inventory)
      .sort((a, b) => a.path.localeCompare(b.path)),
    deferred: graph.deferred,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
}

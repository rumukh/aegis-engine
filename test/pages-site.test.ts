/**
 * The exported site, checked as an **artifact** rather than as the function that produced it.
 *
 * `packages/render-three/src/static-site.test.ts` drives the exporter over a synthetic tree. That
 * is worth having and it is not this: it shares every assumption the exporter makes, so it cannot
 * notice the exporter being wrong about *this repository*. Here the site is built the way CI
 * builds it — `node poc/build-site.mjs`, in a real Node process, over the real `dist/` — and then
 * read back from disk by an instrument that shares nothing with it.
 *
 * "Shares nothing" is the load-bearing part, and it is deliberate down to the mechanism. The
 * exporter finds import specifiers with anchored regular expressions; this file finds them by
 * parsing each module with the TypeScript compiler's parser and walking `ImportDeclaration` /
 * `ExportDeclaration` nodes. It resolves bare specifiers through the **import map the page itself
 * carries**, not through the exporter's module table. Two detectors that share a mechanism cannot
 * disagree, and a check whose two sides cannot disagree is a tautology.
 *
 * What is checked, and why each one is a way the site could be a shell:
 *
 * - the module graph is closed under the page's own import map — otherwise a browser 404s mid-boot
 *   and the page paints its HUD over a game that never started;
 * - no module statically imports a `node:` built-in — the failure the whole static runtime exists
 *   to avoid;
 * - nothing anywhere mentions `/api/` — the dev server's transport is genuinely gone, not merely
 *   unused;
 * - no URL is root-relative — the one class that passes locally at a domain root and 404s under a
 *   project Pages prefix, which is exactly where this is going;
 * - every embedded scene is byte-identical to the scene file the headless acceptance tests run;
 * - the plugin *strings* the pages import name the very plugin objects `poc/play.mjs` runs.
 *
 * Every one of them is separately shown to be able to fail.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Subprocesses are awaited, never `execFileSync`.
 *
 * A synchronous child blocks this worker's event loop for as long as it runs, and vitest's worker
 * talks to the main process over an RPC with its own deadline. Measured here: the build-refusal
 * case spawns two full site exports back to back, ~19s of blocked loop, and the run ended with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` — every case green and the process exiting 1,
 * for a reason that has nothing to do with what is being asserted.
 */
const run = promisify(execFile);

/** The prefix a GitHub **project** Pages site is served under. The whole point of relative URLs. */
const PAGES_BASE = '/aegis-engine/';

let siteDir: string;
/** Site-relative, forward-slashed paths of every file in the artifact. */
let siteFiles: string[];
/**
 * The artifact's text contents, read once.
 *
 * Not an optimisation for its own sake. Every check below re-crawls the graph, and the graph
 * contains `three.module.js` — 1.27 MB that the TypeScript parser takes a second or so to chew
 * through. Re-reading and re-parsing it eight times made this file take 105 seconds and starve
 * vitest's own worker RPC (`Timeout calling "onTaskUpdate"`), which fails the run for a reason
 * that has nothing to do with what is being asserted. Caching by path also makes the parse cache
 * below a reference comparison rather than a 1.27 MB string compare.
 */
let siteText: Map<string, string>;

/** Read a site-relative file as text. */
function readSite(path: string): string {
  const cached = siteText.get(path);
  if (cached !== undefined) return cached;
  return readFileSync(join(siteDir, ...path.split('/')), 'utf8');
}

/** Every file under `dir`, as forward-slashed paths relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** Parsed specifiers, keyed by path and validated against the exact source that produced them. */
const parseCache = new Map<string, { source: string; specifiers: string[] }>();

/**
 * The module specifiers `source` imports, **by parsing it**.
 *
 * The second detector, and deliberately not the exporter's. A parser cannot be fooled by a
 * specifier that appears in a comment or a string, and it cannot miss one because of an anchor —
 * so where the two agree, they agree for independent reasons.
 *
 * The cache is keyed by path *and* checked against the source, so the controls below — which hand
 * this a deliberately modified copy of one module — are never answered from a stale entry. A cache
 * that ignored the source would silently disarm exactly the arms that must be able to fail.
 */
function importedSpecifiers(path: string, source: string): string[] {
  const cached = parseCache.get(path);
  if (cached !== undefined && cached.source === source) return cached.specifiers;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const out: string[] = [];
  for (const statement of parsed.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) out.push(specifier.text);
  }
  parseCache.set(path, { source, specifiers: out });
  return out;
}

/**
 * Remove line and block comments, so a module that *documents* the transport it replaced is not
 * confused with one that uses it.
 *
 * Approximate in one direction only: it can remove text it should have kept (a `//` inside a
 * string literal), never invent it. A false negative here would show up as a check that passed
 * over something, which is why the stripper is separately exercised in both directions below.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1 ');
}

/** The `imports` object of the import map a play page carries. */ function importMapOf(
  pageHtml: string,
): Record<string, string> {
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(pageHtml);
  if (match === null) throw new Error('the page carries no import map');
  return (JSON.parse(match[1] as string) as { imports: Record<string, string> }).imports;
}

/** What a closure crawl found. */
interface Closure {
  /** Site-relative paths of every module reached. */
  reached: string[];
  /** `"module → specifier"` for everything the artifact could not serve. */
  unresolved: string[];
  /** Specifiers naming a Node built-in, which a browser can never load. */
  nodeBuiltins: string[];
}

/**
 * Crawl the artifact from one play page, resolving bare specifiers through that page's own map.
 *
 * `read`/`exists` are injectable for one reason: a checker that answers "closed" whatever it is
 * given would pass over this artifact and over an artifact with half its files missing. The
 * controls below hide a file and require this to notice.
 */
function closureFrom(
  page: string,
  read: (path: string) => string = readSite,
  exists: (path: string) => boolean = (path) => existsSync(join(siteDir, ...path.split('/'))),
): Closure {
  const map = importMapOf(read(page));
  const entry = `${dirname(page)}/boot.js`;
  const reached: string[] = [];
  const unresolved: string[] = [];
  const nodeBuiltins: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!exists(path)) {
      unresolved.push(`(missing) ${path}`);
      continue;
    }
    reached.push(path);
    for (const specifier of importedSpecifiers(path, read(path))) {
      if (specifier.startsWith('node:')) {
        nodeBuiltins.push(`${path} → ${specifier}`);
        continue;
      }
      let target: string;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        // Resolved as a URL would be, relative to the importing module.
        target = new URL(specifier, `https://x/${path}`).pathname.slice(1);
      } else if (map[specifier] !== undefined) {
        // The map's addresses are relative to the *page*, which is one level below its boot module.
        target = new URL(map[specifier] as string, `https://x/${page}`).pathname.slice(1);
      } else {
        unresolved.push(`${path} → ${specifier}`);
        continue;
      }
      queue.push(target);
    }
  }
  return { reached, unresolved, nodeBuiltins };
}

beforeAll(async () => {
  siteDir = mkdtempSync(join(tmpdir(), 'aegis-pages-'));
  // The command CI runs, run the way CI runs it. Building the site through its real entry point is
  // what makes this a test of the shipped thing rather than of a function called with tidy
  // arguments — the `dist/` it reads is the one `pretest` just built.
  await run(process.execPath, [join('poc', 'build-site.mjs'), '--out', siteDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  siteFiles = walk(siteDir);
  siteText = new Map(
    siteFiles
      .filter((path) => path.endsWith('.js') || path.endsWith('.html'))
      .map((path) => [path, readFileSync(join(siteDir, ...path.split('/')), 'utf8')]),
  );
});

afterAll(() => {
  rmSync(siteDir, { recursive: true, force: true });
});

/** The three play pages the site publishes. */
const PLAY_PAGES = [
  'play/platformer/index.html',
  'play/iso/index.html',
  'play/fps/index.html',
] as const;

describe('the exported site is a real artifact (anti-vacuity)', () => {
  it('was built, and is not a handful of files', () => {
    // Every check below is "no member of a corpus has a property", which an empty corpus satisfies
    // perfectly. A build that silently produced three files would pass all of them.
    expect(siteFiles.length).toBeGreaterThan(80);
    expect(siteFiles.filter((f) => f.endsWith('.js')).length).toBeGreaterThan(80);
    expect(siteFiles).toContain('index.html');
    expect(siteFiles).toContain('404.html');
    for (const page of PLAY_PAGES) expect(siteFiles).toContain(page);
  });

  it('carries the three games and links each one relatively from the landing page', () => {
    const index = readSite('index.html');
    for (const [id, title] of [
      ['platformer', 'Coyote Gap'],
      ['iso', 'The Server Vault'],
      ['fps', 'Sector Breach'],
    ]) {
      expect(index).toContain(`href="play/${id}/"`);
      expect(index).toContain(title as string);
    }
  });
});

describe('the module graph is closed under the page’s own import map', () => {
  for (const page of PLAY_PAGES) {
    it(`${page} reaches only modules the artifact serves`, () => {
      const closure = closureFrom(page);
      expect(closure.unresolved).toEqual([]);
      // A closed graph over four modules would also satisfy the line above. The real graph is the
      // engine, all three modes, three.js and a game.
      expect(closure.reached.length).toBeGreaterThan(60);
      expect(closure.reached).toContain('vendor/three/build/three.module.js');
      expect(closure.reached).toContain('vendor/@aegis/render-three/dist/client/static-boot.js');
    });
  }

  it('can actually fail: hiding one vendored module is reported (anti-vacuity)', () => {
    // Without this, the three cases above would pass over a crawler that reached one file and
    // stopped, or that resolved nothing and therefore had nothing to complain about.
    const hidden = 'vendor/@aegis/core/dist/index.js';
    const closure = closureFrom(
      PLAY_PAGES[0],
      readSite,
      (path) => path !== hidden && existsSync(join(siteDir, ...path.split('/'))),
    );
    expect(closure.unresolved).toContain(`(missing) ${hidden}`);
  });

  it('can actually fail: an import the map does not name is reported (anti-vacuity)', () => {
    const page = PLAY_PAGES[0];
    const entry = `${dirname(page)}/boot.js`;
    const closure = closureFrom(page, (path) =>
      path === entry ? `import 'nowhere-in-the-map';\n${readSite(path)}` : readSite(path),
    );
    expect(closure.unresolved).toContain(`${entry} → nowhere-in-the-map`);
  });
});

describe('nothing in the artifact needs a Node process', () => {
  it('no module statically imports a node: built-in', () => {
    for (const page of PLAY_PAGES) {
      expect(closureFrom(page).nodeBuiltins, page).toEqual([]);
    }
  });

  it('can actually fail: a node: import is reported (anti-vacuity)', () => {
    const page = PLAY_PAGES[0];
    const entry = `${dirname(page)}/boot.js`;
    const closure = closureFrom(page, (path) =>
      path === entry
        ? `import { readFile } from 'node:fs/promises';\n${readSite(path)}`
        : readSite(path),
    );
    expect(closure.nodeBuiltins).toContain(`${entry} → node:fs/promises`);
  });

  it('the deferred harness import is a dynamic one, which a browser never fetches', () => {
    // `@aegis/harness`'s run.ts is genuinely in the graph — the iso game's package main imports it
    // for `defineGameTest`. What must be true is that its `node:fs/promises` is behind an
    // `await import(...)`, so no page ever fetches it. This is the claim the whole
    // browser-loadable-harness change rests on, asserted where it can be read.
    const harness = 'vendor/@aegis/harness/dist/run.js';
    expect(siteFiles).toContain(harness);
    const source = readSite(harness);
    expect(source).toContain("await import('node:fs/promises')");
    expect(importedSpecifiers(harness, source)).not.toContain('node:fs/promises');
  });

  it('the page’s runtime performs no network I/O at all', () => {
    // Stronger than "does not mention /api/", and immune to a comment that discusses the dev
    // server — which `static-boot.ts` legitimately does, because explaining what it replaced is
    // most of the reason it exists. What matters is that the module that steps the simulation has
    // no way to talk to anything: no `fetch`, no `XMLHttpRequest`, no socket.
    const boot = stripComments(readSite('vendor/@aegis/render-three/dist/client/static-boot.js'));
    expect(boot.length).toBeGreaterThan(1000);
    expect(boot).not.toMatch(/\bfetch\s*\(/);
    expect(boot).not.toContain('XMLHttpRequest');
    expect(boot).not.toContain('WebSocket');
    expect(boot).not.toContain('/api/');
  });

  it('no vendored @aegis module carries the dev server’s /api/ transport', () => {
    const aegis = siteFiles.filter((f) => f.startsWith('vendor/@aegis/') && f.endsWith('.js'));
    expect(aegis.length).toBeGreaterThan(40);
    for (const file of aegis) {
      expect(stripComments(readSite(file)).includes('/api/'), file).toBe(false);
    }
    // The dev server's client and the server itself are not merely unused — they were never
    // copied, because nothing the pages load imports them.
    expect(siteFiles).not.toContain('vendor/@aegis/render-three/dist/client/boot.js');
    expect(siteFiles).not.toContain('vendor/@aegis/render-three/dist/dev-server.js');
  });

  it('can actually fail: stripComments keeps code and drops commentary (anti-vacuity)', () => {
    // The two cases above are "a string is absent once comments are removed", which a stripper
    // that removed everything would satisfy for any input.
    expect(stripComments('// fetch("/api/x")\nconst a = 1;')).not.toContain('/api/');
    expect(stripComments('/* /api/ */ const b = 2;')).not.toContain('/api/');
    expect(stripComments('const url = "/api/x";')).toContain('/api/');
    expect(stripComments('// note\nconst a = 1;')).toContain('const a = 1;');
  });

  it('no file mentions the dev server’s /api/ transport', () => {
    const suspects = siteFiles.filter((f) => f.endsWith('.html') || f.endsWith('/boot.js'));
    expect(suspects.length).toBeGreaterThan(5);
    for (const file of suspects) {
      expect(readSite(file).includes('/api/'), file).toBe(false);
    }
  });
});

describe('every URL survives a /<repo>/ Pages prefix', () => {
  /** Root-relative `href`/`src` attributes, which resolve outside a project Pages site. */
  function rootRelativeUrls(html: string): string[] {
    return [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)]
      .map((match) => match[1] as string)
      .filter((url) => url.startsWith('/'));
  }

  it('no page writes a root-relative href or src', () => {
    const pages = siteFiles.filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(4);
    for (const page of pages) expect(rootRelativeUrls(readSite(page)), page).toEqual([]);
  });

  it('no import-map address is root-relative, and each one exists in the artifact', () => {
    for (const page of PLAY_PAGES) {
      const map = importMapOf(readSite(page));
      expect(Object.keys(map).length).toBeGreaterThan(5);
      for (const [specifier, address] of Object.entries(map)) {
        expect(address.startsWith('/'), `${page}: ${specifier}`).toBe(false);
        const target = new URL(address, `https://x/${page}`).pathname.slice(1);
        expect(siteFiles, `${page}: ${specifier} → ${address}`).toContain(target);
      }
    }
  });

  it('can actually fail: the detector fires on a root-relative URL (anti-vacuity)', () => {
    expect(rootRelativeUrls('<a href="/vendor/x.js"></a><script src="./ok.js"></script>')).toEqual([
      '/vendor/x.js',
    ]);
    expect(rootRelativeUrls('<script src="./ok.js"></script>')).toEqual([]);
  });

  it('resolves every play route under the Pages base path', () => {
    // Stated as URL arithmetic rather than as a served request, because the browser spec serves it
    // for real. What this pins is that the *relative* spelling composes with the prefix at all.
    for (const page of PLAY_PAGES) {
      const url = new URL(page, `https://user.github.io${PAGES_BASE}`);
      expect(url.pathname).toBe(`${PAGES_BASE}${page}`);
      const boot = new URL('./boot.js', url);
      expect(boot.pathname.startsWith(PAGES_BASE)).toBe(true);
    }
  });
});

describe('the pages run the games this repository actually ships', () => {
  it('embeds each scene document byte-for-byte', () => {
    // The scene is not re-serialised, re-indented or trimmed on its way into the page: what the
    // browser parses is the same bytes `runScene` parses, so a divergence between the played game
    // and the tested one cannot start here.
    for (const [id, scene] of [
      ['platformer', 'games/platformer/levels/coyote-gap.scene.json'],
      ['iso', 'games/iso/levels/server-vault.scene.json'],
      ['fps', 'games/fps/levels/sector-breach.scene.json'],
    ]) {
      const onDisk = readFileSync(join(REPO_ROOT, ...(scene as string).split('/')), 'utf8');
      const embedded = readSite(`play/${id}/boot.js`);
      expect(embedded, id).toContain(JSON.stringify(onDisk));
    }
  });

  it('imports each game’s composed plugin by its own package specifier', () => {
    for (const [id, specifier, exportName] of [
      ['platformer', '@aegis/game-platformer', 'coyoteGapPlugin'],
      ['iso', '@aegis/game-iso', 'serverVaultPlugin'],
      ['fps', '@aegis/game-fps', 'sectorBreachPlugin'],
    ]) {
      const boot = readSite(`play/${id}/boot.js`);
      expect(boot).toContain(`import { ${exportName} } from '${specifier}';`);
      expect(importedSpecifiers(`play/${id}/boot.js`, boot)).toContain(specifier);
    }
  });

  it('names, in strings, the very plugin objects poc/play.mjs runs', async () => {
    // The catalogue says the same thing twice — once as an imported value for the dev server, once
    // as a module specifier plus an export name for the browser — and two spellings of one fact
    // drift. This resolves the strings in a real Node process and compares object identity, so a
    // renamed export or a moved package fails here rather than in someone's browser.
    const probe = `
      import { POC } from './poc/poc-games.mjs';
      const out = [];
      for (const entry of POC) {
        const module = await import(entry.pluginModule);
        out.push({
          id: entry.id,
          sameObject: module[entry.pluginExport] === entry.plugin,
          mode: module[entry.pluginExport]?.mode ?? null,
          declaredMode: entry.plugin.mode,
        });
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const rows = JSON.parse(stdout) as {
      id: string;
      sameObject: boolean;
      mode: string | null;
      declaredMode: string;
    }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.sameObject, `${row.id}: pluginModule#pluginExport is not the plugin it runs`).toBe(
        true,
      );
      expect(row.mode, row.id).toBe(row.declaredMode);
    }
  });
});

describe('the build refuses rather than shipping a broken site', () => {
  it('fails when a module the graph needs is missing', async () => {
    // The export's whole safety argument is that an unservable static import stops the build. A
    // refusal nobody has watched happen is a refusal nobody can rely on. Driving it through the
    // real command means the failure path this asserts is the one CI would hit.
    //
    // The module hidden is the browser runtime, chosen because `poc/build-site.mjs` does not
    // import it: hiding something the exporter itself loads (`@aegis/core`, say) kills the process
    // at its own first import and proves nothing about the crawler.
    const moved = join(REPO_ROOT, 'packages', 'render-three', 'dist', 'client', 'static-boot.js');
    const stash = `${moved}.stashed`;
    const build = async (out: string): Promise<{ failed: boolean; message: string }> => {
      try {
        await run(process.execPath, [join('poc', 'build-site.mjs'), '--out', out], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        });
        return { failed: false, message: '' };
      } catch (error) {
        return { failed: true, message: String((error as { stderr?: string }).stderr ?? error) };
      }
    };

    const broken = mkdtempSync(join(tmpdir(), 'aegis-pages-broken-'));
    const ok = mkdtempSync(join(tmpdir(), 'aegis-pages-ok-'));
    try {
      renameSync(moved, stash);
      const refused = await build(broken);
      renameSync(stash, moved);
      expect(refused.failed, 'the export succeeded with the browser runtime missing').toBe(true);
      expect(refused.message).toMatch(/does not exist/);
      expect(refused.message).toMatch(/static-boot\.js/);

      // The other half: the same command over the same tree succeeds once the module is back.
      // Without it, the refusal above would also be satisfied by a build that is simply broken.
      const restored = await build(ok);
      expect(restored.failed, restored.message).toBe(false);
      expect(existsSync(join(ok, 'index.html'))).toBe(true);
    } finally {
      if (existsSync(stash)) renameSync(stash, moved);
      rmSync(broken, { recursive: true, force: true });
      rmSync(ok, { recursive: true, force: true });
    }
    expect(existsSync(moved)).toBe(true);
  });
});

void resolve;

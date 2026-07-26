/**
 * The plugin extension point (CHARTER principle 9).
 *
 * Every real game in this repo ships a **composed** {@link ModePlugin} — the stock mode plugin
 * with the game's own components and systems folded in — because the frozen `RunOptions` has no
 * extra-systems hook. Without a way to name that plugin, `run`, `inspect`, `validate`, `record`
 * and `replay` can only ever drive the three stock modes, which for a real game means simulating
 * a world whose entire semantic layer never runs. That failure is invisible: the run completes,
 * hashes, and exits `0`.
 *
 * So a plugin can be named three ways, in precedence order:
 *
 * 1. `--plugin <module>#<export>` — an explicit module + export, dynamically imported.
 * 2. `aegis.json` next to (or above) the scene, with `{ "plugin": "<module>#<export>" }`.
 * 3. Nothing — the stock plugin for the scene's `mode`.
 *
 * Whichever wins, the commands **report which one ran** (see {@link describePluginSource}), so an
 * agent can always tell whether the game's systems were actually installed.
 * @packageDocumentation
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGameMode } from '@aegis/core';
import type { ModePlugin } from '@aegis/harness';
import { AegisCliError, CliCode, messageOf } from './errors.js';
import { globFiles, isGlob } from './glob.js';

/** Where a resolved plugin came from. */
export type PluginSource =
  /** `--plugin <spec>`. */
  | 'flag'
  /** An `aegis.json` discovered next to (or above) the scene. */
  | 'config'
  /** A recording's `plugin` field, written by `aegis record`. */
  | 'recording'
  /** The stock `@aegis/mode-*` plugin for the scene's mode. */
  | 'mode';

/** A plugin plus the provenance every command prints. */
export interface ResolvedPlugin {
  /** The plugin the simulation will run. */
  readonly plugin: ModePlugin;
  /** The spec that produced it (a module#export, or a bare mode name). */
  readonly spec: string;
  /** How it was chosen. */
  readonly source: PluginSource;
  /** The `aegis.json` that supplied it, when `source` is `config`. */
  readonly configFile?: string;
}

/** Config document discovered beside a scene. */
interface AegisConfig {
  /** `<module>#<export>` or a bare mode name. Relative modules resolve against the config file. */
  plugin?: unknown;
  /**
   * Modules that export {@link GameTest}s, relative to this file. Lets a game whose test lives in
   * its own module — rather than in a separate `*.gametest.js` — still be found by `aegis test`.
   */
  tests?: unknown;
}

/** The config filename walked up from a scene's directory. */
export const CONFIG_FILENAME = 'aegis.json';

/** Module specifiers that are unambiguously filesystem paths. */
const PATH_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];

/** Whether `module` should be resolved as a file path rather than a bare package specifier. */
function isPathSpecifier(module: string): boolean {
  if (module.startsWith('@')) return false;
  if (module.startsWith('.') || module.startsWith('/') || module.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(module)) return true;
  return PATH_EXTENSIONS.some((ext) => module.endsWith(ext));
}

/** Split `<module>#<export>` into its parts. */
function splitSpec(spec: string): { module: string; exportName?: string } {
  const hash = spec.lastIndexOf('#');
  if (hash < 0) return { module: spec };
  return { module: spec.slice(0, hash), exportName: spec.slice(hash + 1) };
}

/** Structural check that a value satisfies the frozen {@link ModePlugin} contract. */
export function isModePlugin(value: unknown): value is ModePlugin {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['mode'] === 'string' &&
    isGameMode(v['mode']) &&
    typeof v['components'] === 'function' &&
    typeof v['systems'] === 'function' &&
    typeof v['view'] === 'function' &&
    (v['init'] === undefined || typeof v['init'] === 'function')
  );
}

/** Import a module by spec, resolving relative paths against the first `baseDirs` entry that has it. */
async function importModule(
  module: string,
  baseDirs: readonly string[],
  spec: string,
): Promise<Record<string, unknown>> {
  let target = module;
  if (isPathSpecifier(module)) {
    const candidates = isAbsolute(module) ? [module] : baseDirs.map((dir) => resolve(dir, module));
    const found = candidates.find((abs) => existsSync(abs));
    if (found === undefined) {
      throw new AegisCliError(
        CliCode.PluginLoadFailed,
        `Plugin module not found: ${candidates.join(' or ')}`,
        {
          fix: `--plugin takes <module>#<export>. Point it at a built JavaScript module (e.g. games/iso/dist/server-vault.js#serverVaultPlugin), a package (e.g. @aegis/game-fps#sectorBreachPlugin), or a mode name (platformer | iso | fps). Relative paths resolve against ${baseDirs.join(', ')}.`,
          data: { spec, module, searched: candidates },
        },
      );
    }
    target = pathToFileURL(found).href;
  }
  try {
    return (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new AegisCliError(
      CliCode.PluginLoadFailed,
      `Could not import plugin module "${module}": ${messageOf(err)}`,
      {
        fix: isPathSpecifier(module)
          ? 'Build the module first (a TypeScript source that imports sibling ".js" specifiers cannot be imported directly — point --plugin at the compiled output).'
          : `"${module}" was treated as a package specifier. Use an explicit path (./dir/file.js) if you meant a file.`,
        cause: err,
        data: { spec, module },
      },
    );
  }
}

/** Names of a module's exports that are runnable {@link ModePlugin}s, with the plugin itself. */
interface PluginExport {
  /** The export name. */
  name: string;
  /** The plugin, already narrowed by {@link isModePlugin} — no cast needed downstream. */
  plugin: ModePlugin;
}

/** Every export of `mod` that satisfies the {@link ModePlugin} contract, sorted by name. */
function pluginExports(mod: Record<string, unknown>): PluginExport[] {
  const found: PluginExport[] = [];
  for (const name of Object.keys(mod).sort()) {
    const value = mod[name];
    if (isModePlugin(value)) found.push({ name, plugin: value });
  }
  return found;
}

/** Pick the requested (or the only sensible) plugin export from an imported module. */
function selectExport(
  mod: Record<string, unknown>,
  exportName: string | undefined,
  spec: string,
  module: string,
): ModePlugin {
  const candidates = pluginExports(mod);
  const names = candidates.map((c) => c.name);
  if (exportName !== undefined) {
    const value = mod[exportName];
    if (value === undefined) {
      throw new AegisCliError(
        CliCode.PluginInvalid,
        `Module "${module}" has no export named "${exportName}".`,
        {
          fix:
            names.length > 0
              ? `Exports that are ModePlugins: ${names.join(', ')}. Use <module>#<export>.`
              : `That module exports no ModePlugin at all. Exports found: ${Object.keys(mod).sort().join(', ') || '(none)'}.`,
          data: { spec, module, exportName, pluginExports: names },
        },
      );
    }
    if (!isModePlugin(value)) {
      throw new AegisCliError(
        CliCode.PluginInvalid,
        `Export "${exportName}" of "${module}" is not a ModePlugin.`,
        {
          fix: `A ModePlugin needs { mode: "platformer" | "iso" | "fps", components(), systems(), view() }.${names.length > 0 ? ` Exports that qualify: ${names.join(', ')}.` : ''}`,
          data: { spec, module, exportName, pluginExports: names },
        },
      );
    }
    return value;
  }
  const fallback = mod['default'];
  if (isModePlugin(fallback)) return fallback;
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return only.plugin;
  throw new AegisCliError(
    CliCode.PluginInvalid,
    candidates.length === 0
      ? `Module "${module}" exports no ModePlugin.`
      : `Module "${module}" exports ${candidates.length} ModePlugins; name the one you want.`,
    {
      fix:
        candidates.length === 0
          ? `Export a ModePlugin { mode, components(), systems(), view() }. Exports found: ${Object.keys(mod).sort().join(', ') || '(none)'}.`
          : `Use --plugin ${module}#${names[0]!} (candidates: ${names.join(', ')}).`,
      data: { spec, module, pluginExports: names },
    },
  );
}

/**
 * Resolve a `<module>#<export>` spec (or a bare mode name) to a {@link ModePlugin}.
 * Relative module paths are tried against each of `baseDirs` in order.
 */
export async function loadPlugin(
  spec: string,
  baseDirs: readonly string[],
  modes: { has(mode: string): boolean; resolve(mode: string): ModePlugin },
): Promise<ModePlugin> {
  const { module, exportName } = splitSpec(spec);
  if (exportName === undefined && modes.has(module)) return modes.resolve(module);
  const mod = await importModule(module, baseDirs, spec);
  return selectExport(mod, exportName, spec, module);
}

/** A plugin spec declared by an `aegis.json`, with the directory its relative paths resolve against. */
export interface DiscoveredPluginSpec {
  /** The `<module>#<export>` spec. */
  spec: string;
  /** Absolute path of the `aegis.json` that declared it. */
  file: string;
  /** Directory relative module paths in `spec` resolve against. */
  baseDir: string;
}

/**
 * Walk up from `startDir` looking for the nearest `aegis.json` that declares a `plugin`.
 *
 * This is how a *scene* can declare the plugin it belongs to without changing the frozen scene
 * schema: one three-line file per game directory makes `aegis run games/iso/levels/x.scene.json`
 * correct with no flag at all.
 */
export function discoverPluginSpec(startDir: string): DiscoveredPluginSpec | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 64; depth++) {
    const file = resolve(dir, CONFIG_FILENAME);
    if (existsSync(file)) {
      let config: AegisConfig | undefined;
      try {
        config = JSON.parse(readFileSync(file, 'utf8')) as AegisConfig;
      } catch (err) {
        throw new AegisCliError(
          CliCode.PluginLoadFailed,
          `Could not read ${file}: ${messageOf(err)}`,
          {
            fix: `${CONFIG_FILENAME} must be a JSON object, e.g. { "plugin": "./dist/game.js#gamePlugin" }.`,
            cause: err,
          },
        );
      }
      if (typeof config.plugin === 'string' && config.plugin.length > 0) {
        return { spec: config.plugin, file, baseDir: dir };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** One-line, greppable provenance for a resolved plugin — printed by every simulating command. */
export function describePluginSource(resolved: ResolvedPlugin): string {
  switch (resolved.source) {
    case 'flag':
      return `${resolved.spec} (--plugin)`;
    case 'config':
      return `${resolved.spec} (${CONFIG_FILENAME}: ${resolved.configFile ?? '?'})`;
    case 'recording':
      return `${resolved.spec} (from the recording)`;
    case 'mode':
      return `${resolved.spec} (stock mode plugin — no --plugin given)`;
  }
}

/** An `aegis.json` found while scanning for game tests. */
export interface TestManifest {
  /** Absolute path of the `aegis.json`. */
  file: string;
  /** Absolute paths of the modules its `tests` entries resolved to, sorted. */
  modules: readonly string[];
  /** Entries that resolved to nothing — reported, never silently dropped. */
  unresolved: readonly string[];
  /** Whether the file declared a `tests` field at all. */
  declaresTests: boolean;
}

/** Read one config's `tests` entries as a string list, tolerating a bare string. */
function testEntries(config: AegisConfig): string[] {
  const { tests } = config;
  if (typeof tests === 'string') return [tests];
  if (!Array.isArray(tests)) return [];
  return tests.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Every `aegis.json` in `files`, with its `tests` entries resolved.
 *
 * A game's acceptance test does not always live in a file named `*.gametest.*` — the iso PoC
 * default-exports its `GameTest` from the same module that exports its plugin, which is the
 * natural place for it. Discovery by filename alone therefore under-reports, and a green
 * `aegis test` covering one of three games reads as coverage while being the opposite. A game
 * declares where its tests are, in the same file where it already declares its plugin.
 *
 * Entries may be globs (`./dist/*.gametest.js`), so a declaration survives the test being renamed
 * or split — these games are authored by other sessions and do move. An entry that resolves to
 * **nothing** is an error rather than an empty contribution: a discovery mechanism that reports
 * success when it found nothing is worse than no mechanism, because a passing run cannot then be
 * told apart from a silent one.
 */
export function discoverTestManifests(files: readonly string[]): TestManifest[] {
  const manifests: TestManifest[] = [];
  for (const file of files) {
    let config: AegisConfig;
    try {
      config = JSON.parse(readFileSync(file, 'utf8')) as AegisConfig;
    } catch (err) {
      throw new AegisCliError(
        CliCode.PluginLoadFailed,
        `Could not read ${file}: ${messageOf(err)}`,
        {
          fix: `${CONFIG_FILENAME} must be a JSON object, e.g. { "tests": ["./dist/*.gametest.js"] }.`,
          cause: err,
        },
      );
    }
    const dir = dirname(file);
    const entries = testEntries(config);
    const modules = new Set<string>();
    const unresolved: string[] = [];
    for (const entry of entries) {
      const matched = isGlob(entry)
        ? globFiles(entry, dir)
        : [isAbsolute(entry) ? entry : resolve(dir, entry)].filter((p) => existsSync(p));
      if (matched.length === 0) unresolved.push(entry);
      for (const m of matched) modules.add(m);
    }
    manifests.push({
      file,
      modules: [...modules].sort(),
      unresolved,
      declaresTests: entries.length > 0,
    });
  }
  return manifests;
}

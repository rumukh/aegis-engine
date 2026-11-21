import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseScene } from '@aegis/content';
import { DiagnosticError } from '@aegis/core';
import { parseInputScript } from '@aegis/harness';
import { BINDINGS, engineModules, isInside, parseAssetRights } from '@aegis/render-three';
import type { AssetRights, GameDefinition, StaticGame } from '@aegis/render-three';
import { validatePresentation } from '@aegis/render-three/presentation/validate';
import type { CommandContext } from './command.js';
import { AegisCliError, CliCode, messageOf } from './errors.js';
import { CONFIG_FILENAME, loadPluginEntry } from './plugin.js';
import { assertSceneRunnable } from './commands/sim.js';

export interface GameProject {
  root: string;
  game: GameDefinition;
  sceneText: string;
  pluginExport: string;
  pluginEntry?: string;
  rights?: AssetRights;
}

function invalid(file: string, field: string, message: string): never {
  throw new AegisCliError(CliCode.GameManifest, `${file} (${field}): ${message}`, {
    fix: 'Check the fields and manifest-relative file paths; see docs/api/game-distribution.md.',
    data: { file, field },
  });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return invalid(file, 'JSON', messageOf(err));
  }
}

/** An explicit project: never walk to an unrelated parent's catalogue or infer the first scene. */
export async function loadGameProject(ctx: CommandContext): Promise<GameProject> {
  if (ctx.args.positionals.length > 1)
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      'Expected one game directory or aegis.json file.',
    );
  const target = resolve(ctx.io.cwd, ctx.args.positionals[0] ?? '.');
  const file = basename(target) === CONFIG_FILENAME ? target : join(target, CONFIG_FILENAME);
  const config = readJson(file);
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return invalid(file, 'manifest', 'Expected a JSON object.');
  const fields: Record<string, unknown> = config as Record<string, unknown>;
  const root = realpathSync(dirname(file));
  const string = (key: string, fallback?: string): string => {
    const value = fields[key] === undefined ? fallback : fields[key];
    if (typeof value !== 'string' || !value.trim())
      return invalid(file, key, `Expected a nonempty "${key}" string.`);
    return value;
  };
  const reference = (key: string): string => {
    const ref = string(key);
    const path = resolve(root, ref);
    if (
      isAbsolute(ref) ||
      !existsSync(path) ||
      !statSync(path).isFile() ||
      !isInside(root, realpathSync(path))
    )
      return invalid(file, key, `"${ref}" must name an existing file inside the game (${path}).`);
    return path;
  };
  const scenePath = reference('scene');
  const sceneText = readFileSync(scenePath, 'utf8');
  const parsed = parseScene(sceneText, scenePath);
  if (!parsed.ok || !parsed.value) throw new DiagnosticError(parsed.diagnostics);
  const scene = parsed.value;
  const spec = string('plugin', scene.mode);
  const selected = await loadPluginEntry(spec, [root], ctx.modes);
  if (selected.plugin.mode !== scene.mode)
    return invalid(
      file,
      'plugin',
      `Plugin "${spec}" is ${selected.plugin.mode}, but "${scenePath}" is ${scene.mode}.`,
    );
  assertSceneRunnable(scene, scenePath, {
    plugin: selected.plugin,
    spec,
    configFile: file,
    source: fields.plugin === undefined ? 'mode' : 'config',
  });
  const id = string('id', basename(root));
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    return invalid(file, 'id', 'Use a URL slug made of letters, digits, "_" or "-".');
  const game: GameDefinition = {
    id,
    title: string('title', scene.name),
    blurb: string('blurb', `A ${scene.mode} game.`),
    objective: string('objective', 'Explore the level.'),
    mode: scene.mode,
    scene,
    plugin: selected.plugin,
    bindings: BINDINGS[scene.mode],
  };
  if (fields.input !== undefined) {
    const path = reference('input');
    game.script = readFileSync(path, 'utf8');
    const input = parseInputScript(game.script, selected.plugin.inputs?.(), path);
    if (!input.ok) throw new DiagnosticError(input.diagnostics);
  }
  if (fields.presentation !== undefined) {
    const path = reference('presentation');
    const result = validatePresentation(readJson(path), path, selected.plugin.events?.());
    if (!result.ok || !result.value) throw new DiagnosticError(result.diagnostics);
    game.presentation = { manifest: result.value, assetRoot: dirname(path) };
  }
  const project: GameProject = {
    root,
    game,
    sceneText,
    pluginExport: selected.name,
    pluginEntry: selected.entry,
  };
  if (fields.rights !== undefined) {
    const path = reference('rights');
    project.rights = parseAssetRights(readJson(path), path);
  }
  return project;
}

/** Bundle project code only; browser and game must share the same engine modules (registry identity). */
export async function staticGame(project: GameProject): Promise<StaticGame> {
  const { game, sceneText, pluginExport, pluginEntry, rights } = project;
  let pluginCode: string | undefined;
  if (pluginEntry !== undefined) {
    const { build } = await import('esbuild');
    const result = await build({
      absWorkingDir: project.root,
      entryPoints: [pluginEntry],
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      bundle: true,
      write: false,
      logLevel: 'silent',
      external: engineModules().map((m) => m.specifier),
    });
    if (result.outputFiles.length !== 1)
      return invalid(
        pluginEntry,
        'plugin',
        'The plugin must bundle as a single browser ESM module. Declare media in presentation/1.',
      );
    pluginCode = result.outputFiles[0]!.text;
  }
  return {
    ...game,
    sceneText,
    pluginExport,
    pluginCode,
    rights,
    pluginModule: pluginCode === undefined ? `@aegis/mode-${game.mode}` : './game.js',
  };
}

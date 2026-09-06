/**
 * `aegis describe` discovers a selected game's authoring vocabulary without a diagnostic probe.
 * A scene supplies selection context only; no validation, initialization or simulation runs.
 * @packageDocumentation
 */
import { describeCapabilities, formatCapabilities } from '../capabilities.js';
import type { Command, CommandContext } from '../command.js';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { json } from '../format.js';
import { describePluginSource, discoverPluginSpec, loadPlugin } from '../plugin.js';
import type { ResolvedPlugin } from '../plugin.js';
import { flagBool, flagString } from './shared.js';
import { loadScene, resolveRunPlugin } from './sim.js';

const USAGE = [
  'aegis describe [scene] [options]',
  '',
  'Discover the selected plugin, component defaults/schema facts, registered resource IDs,',
  'prefab declarations, resolved systems and supported CLI operations. No simulation runs.',
  '',
  '  --plugin <spec>   A mode name, package, or <module>#<export> (highest precedence).',
  '  --mode <mode>     platformer | iso | fps; fallback selection or plugin-mode assertion.',
  '  --json            Emit deterministic, versioned capabilities/1 JSON.',
  '',
  'With a scene: use the same plugin selection as run/inspect, without validating the scene.',
  'Without a scene: --plugin, then the nearest aegis.json above cwd, then --mode.',
  'No selection is an error; describe never guesses an arbitrary game.',
  'Relative --plugin paths resolve against cwd; config paths resolve against aegis.json.',
  'Defaults are authoring hints, not a gameplay oracle. Unknown schema facts are reported.',
  '',
  'Examples:',
  '  aegis describe --mode platformer --json',
  '  aegis describe --plugin @aegis/game-fps#sectorBreachPlugin --json',
  '  aegis describe games/iso/levels/server-vault.scene.json --json',
].join('\n');

/** Scene-less discovery uses the loader/config rules without fabricating a scene. */
async function resolveWithoutScene(ctx: CommandContext): Promise<ResolvedPlugin> {
  const spec = flagString(ctx.args, 'plugin');
  const mode = flagString(ctx.args, 'mode');
  let resolved: ResolvedPlugin;
  if (spec !== undefined) {
    resolved = {
      plugin: await loadPlugin(spec, [ctx.io.cwd], ctx.modes),
      spec,
      source: 'flag',
    };
  } else {
    const discovered = discoverPluginSpec(ctx.io.cwd);
    if (discovered !== undefined) {
      resolved = {
        plugin: await loadPlugin(discovered.spec, [discovered.baseDir], ctx.modes),
        spec: discovered.spec,
        source: 'config',
        configFile: discovered.file,
      };
    } else if (mode !== undefined) {
      resolved = { plugin: ctx.modes.resolve(mode), spec: mode, source: 'mode' };
    } else {
      throw new AegisCliError(
        CliCode.MissingArgument,
        'No plugin selected for capability discovery.',
        {
          fix: 'Pass a scene, --plugin <spec>, or --mode platformer|iso|fps; or declare a plugin in aegis.json.',
        },
      );
    }
  }
  if (mode !== undefined && resolved.plugin.mode !== mode) {
    throw new AegisCliError(
      CliCode.PluginModeMismatch,
      `Plugin ${describePluginSource(resolved)} is a "${resolved.plugin.mode}" plugin, but --mode ${mode} was given.`,
      {
        fix: 'Choose a matching plugin or remove --mode.',
        data: { pluginMode: resolved.plugin.mode, flagMode: mode },
      },
    );
  }
  return resolved;
}

/** Inject the live registry lazily, avoiding a command-module/registry import cycle. */
export function createDescribeCommand(commands: () => readonly Command[]): Command {
  return {
    name: 'describe',
    summary: 'Discover a game plugin and its supported authoring operations.',
    usage: USAGE,
    flags: { plugin: 'value', mode: 'value' },
    async run(ctx: CommandContext): Promise<number> {
      const wantJson = flagBool(ctx.args, 'json');
      if (ctx.args.positionals.length > 1) {
        throw new AegisCliError(
          CliCode.InvalidFlagValue,
          'Capability discovery accepts at most one scene.',
          { fix: 'Use aegis describe [scene] [--plugin <spec>] [--mode <mode>].' },
        );
      }
      const mode = flagString(ctx.args, 'mode');
      if (mode !== undefined && !ctx.modes.has(mode)) ctx.modes.resolve(mode);
      const sceneArg = ctx.args.positionals[0];
      const loaded = sceneArg === undefined ? undefined : loadScene(ctx, sceneArg);
      const resolved =
        loaded === undefined
          ? await resolveWithoutScene(ctx)
          : await resolveRunPlugin(ctx, loaded.scene, loaded.abs);
      const description = describeCapabilities(
        resolved,
        commands(),
        ctx.modes.available(),
        sceneArg ?? null,
      );
      ctx.io.out(wantJson ? json(description) : formatCapabilities(description, resolved) + '\n');
      return Exit.Ok;
    },
  };
}

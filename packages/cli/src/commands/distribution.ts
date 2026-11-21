import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { exportStaticSite, isInside, RELEASE_TARGETS, startDevServer } from '@aegis/render-three';
import type { Command } from '../command.js';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { json } from '../format.js';
import { loadGameProject, staticGame } from '../game-project.js';
import { flagBool, flagChoice, flagInt, flagString } from './shared.js';

const reads = ['aegis.json', 'scene/1', 'presentation/1', 'input-script', 'asset-rights/1'];

export const playCommand: Command = {
  name: 'play',
  summary: 'Serve a playable game from its own aegis.json.',
  usage:
    'aegis play [directory | aegis.json] [--port <0..65535>] [--base-path /prefix/] [--json]\n' +
    'Serves the game on loopback (default port 5173). Ctrl+C to stop; no browser is launched.',
  flags: { port: 'value', 'base-path': 'value' },
  formats: { reads, writes: [], stdout: ['text', 'json'] },
  async run(ctx) {
    const { game } = await loadGameProject(ctx);
    const port =
      flagString(ctx.args, 'port') === undefined
        ? 5173
        : flagInt(ctx.args, 'port', { required: true, min: 0 })!;
    if (port > 65535)
      throw new AegisCliError(CliCode.InvalidFlagValue, '--port must be between 0 and 65535.');
    const server = await startDevServer({
      games: [game],
      port,
      basePath: flagString(ctx.args, 'base-path'),
    });
    const url = `${server.url}/play/${game.id}/`;
    let stop!: () => void;
    const stopped = new Promise<void>((done) => {
      stop = done;
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      ctx.io.out(
        flagBool(ctx.args, 'json')
          ? json({ url, root: `${server.url}/`, id: game.id })
          : `Live game: ${url}\nCtrl+C to stop.\n`,
      );
      await stopped;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await server.close();
    }
    return Exit.Ok;
  },
};

function canonicalOutput(path: string): string {
  if (!existsSync(path))
    return dirname(path) === path ? path : join(canonicalOutput(dirname(path)), basename(path));
  return realpathSync(path);
}

/** The exporter replaces its destination; never treat authored files as an old build. */
function checkOutput(outDir: string, root: string): void {
  if (isInside(canonicalOutput(outDir), root)) {
    throw new AegisCliError(
      CliCode.OutputExists,
      `Refusing to replace ${outDir}: it contains the game.`,
    );
  }
  if (!existsSync(outDir)) return;
  if (lstatSync(outDir).isDirectory()) {
    if (!readdirSync(outDir).length) return;
    try {
      if (
        JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8')).aegis === 'release/1' &&
        existsSync(join(outDir, '.nojekyll'))
      )
        return;
    } catch {
      /* Not a previous export. */
    }
  }
  throw new AegisCliError(CliCode.OutputExists, `Refusing to replace ${outDir}.`, {
    fix: 'Choose an empty directory or a previous Aegis export containing release.json.',
  });
}

export const exportCommand: Command = {
  name: 'export',
  summary: 'Export a relocatable static game after runtime asset preflight.',
  usage:
    'aegis export [directory | aegis.json] [--out <dir>] [--release evaluation|commercial] [--json]\n' +
    'Defaults to <game>/dist-site and evaluation. Serve the output at any URL prefix.\n' +
    'Commercial requires an exact, cleared review for each runtime media file; see release.json.',
  flags: { out: 'value', release: 'value' },
  choices: { release: RELEASE_TARGETS },
  formats: { reads, writes: ['static-site', 'release/1'], stdout: ['text', 'json'] },
  async run(ctx) {
    const release = flagChoice(ctx.args, 'release', RELEASE_TARGETS, 'evaluation');
    const project = await loadGameProject(ctx);
    const outDir = resolve(
      ctx.io.cwd,
      flagString(ctx.args, 'out') ?? join(project.root, 'dist-site'),
    );
    checkOutput(outDir, project.root);
    const result = exportStaticSite({ outDir, release, games: [await staticGame(project)] });
    const entry = `play/${project.game.id}/index.html`;
    ctx.io.out(
      flagBool(ctx.args, 'json')
        ? json({ ...result, entry })
        : `${release} static export: ${outDir}\nEntry: ${entry}\nRuntime media: ${result.assetFiles} files (${result.assetBytes} bytes); see release.json.\n`,
    );
    return Exit.Ok;
  },
};

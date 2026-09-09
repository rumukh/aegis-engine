import { basename, dirname, extname } from 'node:path';
import {
  captureDimensions,
  PREVIEW_LIGHTS,
  PREVIEW_PROJECTIONS,
  PREVIEW_SHAPES,
  PREVIEW_VIEWS,
  startAssetPreview,
  validatePreviewSettings,
} from '@aegis/render-three/preview';
import type {
  AssetPreview,
  AssetPreviewOptions,
  PreviewSelection,
  PreviewSettings,
} from '@aegis/render-three/preview';
import type { Command, CommandContext } from '../command.js';
import { AegisCliError, CliCode } from '../errors.js';
import { json } from '../format.js';
import {
  flagBool,
  flagChoice,
  flagInt,
  flagString,
  requirePositional,
  resolvePath,
} from './shared.js';

const USAGE = [
  'aegis preview <asset> [options]',
  '',
  'Render a local model, texture, or declared material WITHOUT starting a game.',
  'Direct .glb/.gltf/PNG/JPEG/WebP/SVG input needs no scene, plugin, or catalog.',
  'presentation/1 JSON selects declared resources, not its game bindings or audio.',
  '',
  '  --out <file.png>       Save exact PNG pixels and <file.png>.preview.json.',
  '  --serve               Keep the asset-only operator page and capture browser warm.',
  '  --watch               Watch source/dependencies; implies --serve.',
  '  --out-dir <directory>  Explicitly enable bounded warm capture writes in this directory.',
  '  --port <number>        Loopback port (default: OS-allocated). Stop with Ctrl+C.',
  '  --width <pixels>       Capture width (default 1024); --height defaults to 768.',
  '  --model <id>           Select a declared model from a presentation/1 descriptor.',
  '  --texture <id>         Select a declared texture; --frame <name> selects an atlas frame.',
  '  --material <id>        Material studio sample, or override with --model.',
  '  --shape <shape>        Material sample: sphere | cube | plane.',
  '  --asset-root <dir>     Descriptor asset directory (default: beside the descriptor).',
  `  --view <view>          ${PREVIEW_VIEWS.join(' | ')}.`,
  '  --projection <type>    perspective | orthographic.',
  '  --camera <x,y,z>       Explicit position; pair with --target <x,y,z>.',
  '  --lighting <preset>    studio | neutral | warm.',
  '  --background <color>   Six-digit hex color, e.g. "#18212f".',
  '  --clip <name>          Exact model animation clip, sampled while paused.',
  '  --time <seconds>       Sample within the selected clip (default 0).',
  '  --json                Versioned capture/session report; structured errors on stderr.',
  '',
  'A one-shot requires --out. A server without --out/--out-dir cannot write captures.',
  'Asset paths and glTF dependencies must satisfy the production local closure policy.',
  'No runtime CDN or external decoder. Declared provenance is preserved, not verified;',
  'direct-input author/license/source remain unknown. No cross-GPU pixel determinism claim.',
  '',
  'Examples (from the repository root):',
  '  aegis preview games\\iso\\assets\\operative.gltf --clip walk --time 0.25 --out operative.png',
  '  aegis preview games\\platformer\\assets\\engineer.svg --out engineer.png --json',
  '  aegis preview look.presentation.json --model hero --serve --watch --out-dir captures',
].join('\n');

interface StopSignal {
  wait: Promise<void>;
  dispose(): void;
}

function processStopSignal(): StopSignal {
  let done!: () => void;
  const wait = new Promise<void>((resolve) => {
    done = resolve;
  });
  process.once('SIGINT', done);
  process.once('SIGTERM', done);
  return {
    wait,
    dispose() {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
    },
  };
}

export interface PreviewCommandDeps {
  start?(options: AssetPreviewOptions): Promise<AssetPreview>;
  stopSignal?(): StopSignal;
}

function selection(ctx: CommandContext): PreviewSelection | undefined {
  const model = flagString(ctx.args, 'model');
  const texture = flagString(ctx.args, 'texture');
  const material = flagString(ctx.args, 'material');
  const frame = flagString(ctx.args, 'frame');
  if (
    (model !== undefined && texture !== undefined) ||
    (texture !== undefined && material !== undefined)
  )
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      'Choose one --model, --texture, or --material specimen.',
      {
        fix: '--model may additionally use --material as an override. Other selection combinations are invalid.',
      },
    );
  if (frame !== undefined && texture === undefined)
    throw new AegisCliError(CliCode.InvalidFlagValue, '--frame requires --texture <declared-id>.', {
      fix: 'Select a texture from a presentation/1 descriptor that declares atlas frames.',
    });
  if (model !== undefined)
    return { kind: 'model', id: model, ...(material === undefined ? {} : { material }) };
  if (texture !== undefined)
    return { kind: 'texture', id: texture, ...(frame === undefined ? {} : { frame }) };
  if (material !== undefined) return { kind: 'material', id: material };
  return undefined;
}

function settings(ctx: CommandContext): PreviewSettings {
  const { args } = ctx;
  const result: PreviewSettings = {};
  if (args.flags['view'] !== undefined)
    result.view = flagChoice(args, 'view', PREVIEW_VIEWS, 'three-quarter');
  if (args.flags['projection'] !== undefined)
    result.projection = flagChoice(args, 'projection', PREVIEW_PROJECTIONS, 'perspective');
  if (args.flags['lighting'] !== undefined)
    result.lighting = flagChoice(args, 'lighting', PREVIEW_LIGHTS, 'studio');
  if (args.flags['shape'] !== undefined)
    result.shape = flagChoice(args, 'shape', PREVIEW_SHAPES, 'sphere');
  const background = flagString(args, 'background');
  const clip = flagString(args, 'clip');
  const time = flagString(args, 'time');
  if (background !== undefined) result.background = background;
  if (clip !== undefined) result.clip = clip;
  if (time !== undefined) result.time = Number(time);
  const camera = flagString(args, 'camera');
  const target = flagString(args, 'target');
  if ((camera === undefined) !== (target === undefined))
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      '--camera and --target must be supplied together.',
      { fix: 'Use --camera 3,2,4 --target 0,1,0, or omit both for automatic bounds framing.' },
    );
  return validatePreviewSettings({
    ...result,
    ...(camera === undefined || target === undefined
      ? {}
      : {
          camera: {
            position: camera.split(',').map(Number),
            target: target.split(',').map(Number),
          },
        }),
  });
}

export function createPreviewCommand(deps: PreviewCommandDeps = {}): Command {
  return {
    name: 'preview',
    summary: 'Preview local assets without starting a game.',
    usage: USAGE,
    flags: {
      out: 'value',
      serve: 'boolean',
      watch: 'boolean',
      'out-dir': 'value',
      port: 'value',
      width: 'value',
      height: 'value',
      model: 'value',
      texture: 'value',
      material: 'value',
      frame: 'value',
      'asset-root': 'value',
      shape: 'value',
      view: 'value',
      projection: 'value',
      lighting: 'value',
      background: 'value',
      clip: 'value',
      time: 'value',
      camera: 'value',
      target: 'value',
    },
    choices: {
      view: PREVIEW_VIEWS,
      projection: PREVIEW_PROJECTIONS,
      lighting: PREVIEW_LIGHTS,
      shape: PREVIEW_SHAPES,
    },
    formats: {
      reads: ['glTF/2.0', 'PNG', 'JPEG', 'WebP', 'SVG', 'presentation/1'],
      writes: ['PNG', 'asset-preview-capture/1'],
      stdout: ['text', 'asset-preview-capture/1', 'asset-preview-session/1'],
    },
    async run(ctx) {
      const { args, io } = ctx;
      const source = resolvePath(
        io,
        requirePositional(args, 0, 'asset', 'aegis preview <asset> --out <file.png>'),
      );
      if (args.positionals.length !== 1)
        throw new AegisCliError(
          CliCode.InvalidFlagValue,
          'Asset preview takes exactly one source.',
          {
            fix: 'Use a presentation/1 descriptor to select among declared assets, or start one preview per direct input.',
          },
        );
      const out = flagString(args, 'out');
      const serve = flagBool(args, 'serve') || flagBool(args, 'watch');
      if (!serve && out === undefined)
        throw new AegisCliError(
          CliCode.MissingArgument,
          'A one-shot asset preview requires --out <file.png>.',
          { fix: 'Pass --out, or use --serve for the persistent operator page.' },
        );
      if (out !== undefined && extname(out).toLowerCase() !== '.png')
        throw new AegisCliError(CliCode.InvalidFlagValue, '--out must name a PNG file.', {
          fix: 'Use e.g. --out captures\\operative.png. A versioned JSON sidecar is written beside it.',
        });
      const absoluteOut = out === undefined ? undefined : resolvePath(io, out);
      const outDir = flagString(args, 'out-dir');
      if (outDir !== undefined && absoluteOut !== undefined)
        throw new AegisCliError(CliCode.InvalidFlagValue, 'Use --out or --out-dir, not both.', {
          fix: '--out also enables warm writes in that PNG directory when --serve is used.',
        });
      const selected = selection(ctx);
      const studioSettings = settings(ctx);
      if (studioSettings.shape !== undefined && selected?.kind !== 'material')
        throw new AegisCliError(
          CliCode.InvalidFlagValue,
          '--shape requires a --material studio sample.',
          { fix: 'Do not apply sample-shape flags to a model or texture.' },
        );
      const size = captureDimensions(flagInt(args, 'width'), flagInt(args, 'height'));
      const port = flagInt(args, 'port', { min: 0 });
      if (port !== undefined && port > 65535)
        throw new AegisCliError(CliCode.InvalidFlagValue, '--port cannot exceed 65535.', {
          fix: 'Use 0 for an available loopback port.',
        });
      const assetRoot = flagString(args, 'asset-root');
      const stop = serve ? (deps.stopSignal ?? processStopSignal)() : undefined;
      let preview: AssetPreview | undefined;
      try {
        preview = await (deps.start ?? startAssetPreview)({
          source,
          selection: selected,
          settings: studioSettings,
          port,
          watch: flagBool(args, 'watch'),
          ...(assetRoot === undefined ? {} : { assetRoot: resolvePath(io, assetRoot) }),
          ...(absoluteOut !== undefined
            ? { outputDir: dirname(absoluteOut) }
            : outDir !== undefined
              ? { outputDir: resolvePath(io, outDir) }
              : {}),
        });
        const report =
          absoluteOut === undefined
            ? undefined
            : await preview.capture({ filename: basename(absoluteOut), ...size });
        if (serve) {
          const session = {
            aegis: 'asset-preview-session/1',
            url: preview.url,
            token: preview.token,
            revision: preview.server.state().revision,
            watch: flagBool(args, 'watch'),
            outputDir: preview.server.outputDir ?? null,
            coldStartMs: preview.coldStartMs,
            capture: report ?? null,
            scope: 'asset-only; no gameplay validation',
          };
          io.out(
            flagBool(args, 'json')
              ? json(session)
              : `Asset studio: ${preview.url}\nRevision: ${session.revision}; ${session.watch ? 'watching source + dependencies' : 'manual reload'}\n` +
                  `Warm capture directory: ${session.outputDir ?? '(disabled; use --out-dir)'}\nToken: ${preview.token}\n` +
                  (report === undefined
                    ? ''
                    : `PNG: ${report.output.path}\nRecipe: ${report.output.sidecar}\n`) +
                  'No game is running. Stop with Ctrl+C.\n',
          );
          await stop!.wait;
        } else if (report !== undefined) {
          io.out(
            flagBool(args, 'json')
              ? json(report)
              : `PNG: ${report.output.path} (${report.output.width}x${report.output.height})\nRecipe: ${report.output.sidecar}\n` +
                  `Asset: ${report.rendered.kind}:${report.rendered.id}; revision ${report.revision}; source matched at capture.\n`,
          );
        }
        return 0;
      } finally {
        stop?.dispose();
        await preview?.close();
      }
    },
  };
}

export const previewCommand = createPreviewCommand();

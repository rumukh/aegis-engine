/**
 * `aegis validate` — schema-check content and presentation documents with the owning package's
 * structured diagnostics (CHARTER principle 8).
 *
 * Validation never throws for content problems: every issue is a {@link Diagnostic} with a code,
 * a location and a fix. The command exits `2` when any document has an error (or, under
 * `--strict`, a warning), so CI and agents can branch on the outcome.
 *
 * A scene is validated against the registry it will actually *run* under, so `--plugin` (or an
 * `aegis.json` beside the scene) is honoured here exactly as it is by `run` — otherwise a game's
 * own components are reported as unknown by the very command that is supposed to green-light it.
 * @packageDocumentation
 */
import {
  diagnostic,
  ContentCode,
  parsePrefab,
  parseScene,
  parseTilemap,
  validatePrefab,
  validateScene,
} from '@aegis/content';
import type { Diagnostic } from '@aegis/core';
import { createSceneContext } from '@aegis/harness';
import type { PresentationManifest } from '@aegis/render-three/presentation/schema';
import { validatePresentation } from '@aegis/render-three/presentation/validate';
import { dirname } from 'node:path';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { formatDiagnostics, hasErrors, json } from '../format.js';
import { globAll, isGlob } from '../glob.js';
import type { Command, CommandContext } from '../command.js';
import { describePluginSource, discoverPluginSpec, loadPlugin } from '../plugin.js';
import type { ResolvedPlugin } from '../plugin.js';
import { flagBool, flagString, readText, requirePositional, resolvePath } from './shared.js';
import { baseRegistry, resolveRunPlugin } from './sim.js';

const PRESENTATION_FORMAT: PresentationManifest['aegis'] = 'presentation/1';

/** Document formats handled by this command, also exposed through capability discovery. */
export const VALIDATION_FORMATS = [
  'scene/1',
  'prefab/1',
  'tilemap/1',
  PRESENTATION_FORMAT,
] as const;

const PRESENTATION_VALIDATION = {
  format: PRESENTATION_FORMAT,
  scope: 'structural',
  notChecked: ['asset-files', 'asset-decoding', 'initialized-world-bindings'],
} as const;

const USAGE = [
  'aegis validate <file...> [options]',
  '',
  'Schema-check one or more scene/prefab/tilemap/presentation documents. Kind is detected from',
  `the "aegis" discriminator (${VALIDATION_FORMATS.map((format) => `"${format}"`).join(' | ')}). Arguments`,
  'containing wildcards are expanded by the CLI, so quoted globs work on every shell.',
  '',
  "  --plugin <spec>   Validate scenes against this plugin's components (<module>#<export>).",
  "  --mode <mode>     Validate scenes against this mode instead of the scene's own.",
  '                    Prefabs use the chosen plugin too; without one, only core/content',
  '                    components are available. Named prefab references require its catalog.',
  '  --json            Emit diagnostics as JSON (stable error codes).',
  '  --strict          Treat warnings as errors (affects exit code).',
  '',
  'presentation/1 checks are STRUCTURAL ONLY: manifest fields, declared references and limits.',
  'Asset files/decoding and initialized-world bindings are NOT checked. No plugin is loaded',
  'for presentation documents; --plugin/--mode apply only to scene/prefab documents.',
  '',
  'Exit codes: 0 = clean, 2 = one or more documents had problems.',
  '',
  'Examples:',
  '  aegis validate level1.scene.json',
  '  aegis validate "levels/*.scene.json" --strict',
  '  aegis validate look.presentation.json --json',
  '  aegis validate games/iso/levels/server-vault.scene.json \\',
  '    --plugin games/iso/dist/server-vault.js#serverVaultPlugin',
].join('\n');

/** Result of validating one document. */
interface FileReport {
  file: string;
  ok: boolean;
  plugin?: string;
  validation?: typeof PRESENTATION_VALIDATION;
  diagnostics: readonly Diagnostic[];
}

/** Prefabs have no mode field to infer; use an explicit plugin/mode or nearby config. */
async function prefabPlugin(ctx: CommandContext, abs: string): Promise<ResolvedPlugin | undefined> {
  const flagSpec = flagString(ctx.args, 'plugin');
  const mode = flagString(ctx.args, 'mode');
  const config = flagSpec === undefined ? discoverPluginSpec(dirname(abs)) : undefined;
  const spec = flagSpec ?? config?.spec ?? mode;
  if (spec === undefined) return undefined;
  const resolved: ResolvedPlugin = {
    plugin: await loadPlugin(
      spec,
      [flagSpec === undefined ? (config?.baseDir ?? ctx.io.cwd) : ctx.io.cwd],
      ctx.modes,
    ),
    spec,
    source: flagSpec !== undefined ? 'flag' : config !== undefined ? 'config' : 'mode',
    ...(config !== undefined ? { configFile: config.file } : {}),
  };
  if (mode !== undefined && resolved.plugin.mode !== mode) {
    throw new AegisCliError(
      CliCode.PluginModeMismatch,
      `Plugin ${describePluginSource(resolved)} is a "${resolved.plugin.mode}" plugin, but --mode ${mode} was given.`,
      {
        fix: 'Use a plugin for the requested mode, or omit the mismatching --mode.',
      },
    );
  }
  return resolved;
}

/** Validate a single already-read document; scenes resolve their plugin's components first. */
async function validateDocument(
  ctx: CommandContext,
  file: string,
  abs: string,
  text: string,
): Promise<Omit<FileReport, 'file' | 'ok'>> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // Fall through: parseScene will surface the InvalidJson diagnostic uniformly.
    return { diagnostics: parseScene(text, file).diagnostics };
  }
  const discriminator =
    typeof document === 'object' && document !== null && 'aegis' in document
      ? document.aegis
      : undefined;

  switch (discriminator) {
    case 'scene/1': {
      const parsed = parseScene(text, file);
      if (!parsed.ok || !parsed.value) return { diagnostics: parsed.diagnostics };
      const scene = parsed.value;
      if (!ctx.modes.has(scene.mode) && flagString(ctx.args, 'plugin') === undefined) {
        const validated = validateScene(scene, { registry: baseRegistry(), file });
        return { diagnostics: [...parsed.diagnostics, ...validated.diagnostics] };
      }
      const resolved = await resolveRunPlugin(ctx, scene, abs);
      const validated = validateScene(scene, createSceneContext(resolved.plugin, { file }));
      return {
        diagnostics: [...parsed.diagnostics, ...validated.diagnostics],
        plugin: describePluginSource(resolved),
      };
    }
    case 'prefab/1': {
      const parsed = parsePrefab(text, file);
      if (!parsed.ok || parsed.value === undefined) return { diagnostics: parsed.diagnostics };
      const resolved = await prefabPlugin(ctx, abs);
      const context =
        resolved === undefined
          ? { registry: baseRegistry(), file }
          : createSceneContext(resolved.plugin, { file });
      const validated = validatePrefab(parsed.value, context);
      return {
        diagnostics: [...parsed.diagnostics, ...validated.diagnostics],
        ...(resolved !== undefined ? { plugin: describePluginSource(resolved) } : {}),
      };
    }
    case 'tilemap/1':
      return { diagnostics: parseTilemap(text, file).diagnostics };
    case PRESENTATION_FORMAT:
      return {
        diagnostics: validatePresentation(document, file).diagnostics,
        validation: PRESENTATION_VALIDATION,
      };
    default:
      return {
        diagnostics: [
          diagnostic(
            ContentCode.UnknownFormat,
            `Unknown document kind ${JSON.stringify(discriminator)}.`,
            {
              location: { file, path: 'aegis' },
              fix: `Set "aegis" to one of: ${VALIDATION_FORMATS.map((format) => `"${format}"`).join(', ')}.`,
              data: { received: discriminator },
            },
          ),
        ],
      };
  }
}

/**
 * Expand the positional arguments, globbing any that contain wildcards.
 *
 * The help has always advertised `aegis validate *.scene.json`, but Windows shells do not expand
 * globs, so that documented invocation failed with "File not found: …\*.scene.json". Expanding
 * here makes the advertised command work on every platform.
 */
function expandTargets(ctx: CommandContext, patterns: readonly string[]): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    if (!isGlob(pattern)) {
      files.push(pattern);
      continue;
    }
    const matched = globAll([pattern], ctx.io.cwd);
    if (matched.length === 0) {
      throw new AegisCliError(CliCode.FileNotFound, `No files matched "${pattern}".`, {
        fix: `Globs are expanded by the CLI and resolved against ${ctx.io.cwd}. Check the pattern, or pass explicit paths.`,
        data: { pattern },
      });
    }
    for (const abs of matched) files.push(abs);
  }
  return files;
}

/** `aegis validate` — validate content or presentation with its owning package's validator. */
export const validateCommand: Command = {
  name: 'validate',
  summary: 'Validate a scene/prefab/tilemap/presentation document.',
  usage: USAGE,
  flags: { plugin: 'value', mode: 'value', strict: 'boolean' },
  async run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    requirePositional(args, 0, 'file', 'aegis validate <file...>');
    const strict = flagBool(args, 'strict');

    const reports: FileReport[] = [];
    for (const rel of expandTargets(ctx, args.positionals)) {
      const abs = resolvePath(io, rel);
      const text = readText(abs, io);
      const report = await validateDocument(ctx, rel, abs, text);
      const failed =
        hasErrors(report.diagnostics) ||
        (strict && report.diagnostics.some((d) => d.severity === 'warning'));
      reports.push({ file: rel, ok: !failed, ...report });
    }

    const ok = reports.every((r) => r.ok);
    if (flagBool(args, 'json')) {
      io.out(json({ ok, strict, files: reports }));
    } else {
      io.out(
        reports
          .map((r) => {
            const head =
              r.validation !== undefined
                ? `# ${r.file}: ${r.validation.format} structural validation only.\n` +
                  '# Not checked: asset files/decoding or initialized-world bindings.\n'
                : r.plugin !== undefined
                  ? `# ${r.file} against plugin ${r.plugin}\n`
                  : '';
            return head + formatDiagnostics(r.diagnostics, r.file);
          })
          .join('\n\n') + '\n',
      );
    }
    return ok ? Exit.Ok : Exit.Validation;
  },
};

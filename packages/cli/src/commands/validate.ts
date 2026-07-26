/**
 * `aegis validate` — schema-check scene / prefab / tilemap documents and print structured
 * diagnostics with their stable `AEG-CONTENT-####` codes (CHARTER principle 8).
 *
 * Validation never throws for content problems: every issue is a {@link Diagnostic} with a code,
 * a location and a fix. The command exits `2` when any document has an error (or, under
 * `--strict`, a warning), so CI and agents can branch on the outcome.
 * @packageDocumentation
 */
import {
  createRegistry,
  diagnostic,
  ContentCode,
  Dead,
  Health,
  Light,
  Model,
  parsePrefab,
  parseScene,
  parseTilemap,
  Sprite,
  Trigger,
  Triggered,
  validateScene,
} from '@aegis/content';
import { Name, Transform } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import type { ComponentRegistry } from '@aegis/content';
import { Exit } from '../errors.js';
import { formatDiagnostics, hasErrors, json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import { flagBool, readText, requirePositional, resolvePath } from './shared.js';

const USAGE = [
  'aegis validate <file...> [options]',
  '',
  'Schema-check one or more scene/prefab/tilemap documents. Kind is detected from the',
  'document\'s "aegis" discriminator ("scene/1" | "prefab/1" | "tilemap/1").',
  '',
  '  --json            Emit diagnostics as JSON (stable error codes).',
  '  --strict          Treat warnings as errors (affects exit code).',
  '',
  'Exit codes: 0 = clean, 2 = one or more documents had problems.',
  '',
  'Examples:',
  '  aegis validate level1.scene.json',
  '  aegis validate *.scene.json --strict',
  '  aegis validate hero.prefab.json --json',
].join('\n');

/** The base registry the harness always installs, so scene component ids resolve during validate. */
function baseRegistry(): ComponentRegistry {
  return createRegistry(Transform, Name, Sprite, Model, Light, Health, Trigger, Dead, Triggered);
}

/** Result of validating one document. */
interface FileReport {
  file: string;
  ok: boolean;
  diagnostics: readonly Diagnostic[];
}

/** Validate a single already-read document; `mode` resolution adds mode components for scenes. */
function validateDocument(ctx: CommandContext, file: string, text: string): readonly Diagnostic[] {
  let discriminator: unknown;
  try {
    discriminator = (JSON.parse(text) as { aegis?: unknown }).aegis;
  } catch {
    // Fall through: parseScene will surface the InvalidJson diagnostic uniformly.
    return parseScene(text, file).diagnostics;
  }

  switch (discriminator) {
    case 'scene/1': {
      const parsed = parseScene(text, file);
      if (!parsed.ok || !parsed.value) return parsed.diagnostics;
      const scene = parsed.value;
      const registry = baseRegistry();
      if (ctx.modes.has(scene.mode))
        registry.registerAll(ctx.modes.resolve(scene.mode).components());
      const validated = validateScene(scene, { registry });
      return [...parsed.diagnostics, ...validated.diagnostics];
    }
    case 'prefab/1':
      return parsePrefab(text, file).diagnostics;
    case 'tilemap/1':
      return parseTilemap(text, file).diagnostics;
    default:
      return [
        diagnostic(
          ContentCode.UnknownFormat,
          `Unknown document kind ${JSON.stringify(discriminator)}.`,
          {
            location: { file, path: 'aegis' },
            fix: 'Set "aegis" to one of: "scene/1", "prefab/1", "tilemap/1".',
            data: { received: discriminator },
          },
        ),
      ];
  }
}

/** `aegis validate` — validate a scene/prefab/tilemap document against the schema. */
export const validateCommand: Command = {
  name: 'validate',
  summary: 'Validate a scene/prefab/tilemap document.',
  usage: USAGE,
  run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    requirePositional(args, 0, 'file', 'aegis validate <file...>');
    const strict = flagBool(args, 'strict');

    const reports: FileReport[] = [];
    for (const rel of args.positionals) {
      const abs = resolvePath(io, rel);
      const text = readText(abs, io);
      const diagnostics = validateDocument(ctx, rel, text);
      const failed =
        hasErrors(diagnostics) || (strict && diagnostics.some((d) => d.severity === 'warning'));
      reports.push({ file: rel, ok: !failed, diagnostics });
    }

    const ok = reports.every((r) => r.ok);
    if (flagBool(args, 'json')) {
      io.out(json({ ok, strict, files: reports }));
    } else {
      io.out(reports.map((r) => formatDiagnostics(r.diagnostics, r.file)).join('\n\n') + '\n');
    }
    return Promise.resolve(ok ? Exit.Ok : Exit.Validation);
  },
};

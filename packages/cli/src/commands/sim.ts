/**
 * Simulation helpers shared by `run`, `inspect`, `record` and `replay`: load and parse a scene
 * against {@link CliIO.cwd}, resolve its mode plugin, and summarise event logs.
 * @packageDocumentation
 */
import { parseScene } from '@aegis/content';
import type { SceneFile } from '@aegis/content';
import { DiagnosticError } from '@aegis/core';
import type { EventReader, GameEvent } from '@aegis/core';
import type { AsciiView, ModePlugin, SemanticFrame, SimResult } from '@aegis/harness';
import type { CommandContext } from '../command.js';
import { AegisCliError, CliCode } from '../errors.js';
import { readText, resolvePath } from './shared.js';

/** A scene loaded from disk: its absolute path, the path as the user gave it, and the parsed file. */
export interface LoadedScene {
  abs: string;
  ref: string;
  scene: SceneFile;
}

/** Read and parse a scene document, throwing {@link DiagnosticError} (exit 2) if it is invalid. */
export function loadScene(ctx: CommandContext, rel: string): LoadedScene {
  const abs = resolvePath(ctx.io, rel);
  const text = readText(abs, ctx.io);
  const parsed = parseScene(text, rel);
  if (!parsed.ok || !parsed.value) throw new DiagnosticError(parsed.diagnostics);
  return { abs, ref: rel, scene: parsed.value };
}

/** Resolve the mode plugin: an explicit `--mode` wins, otherwise the scene's declared mode. */
export function resolvePlugin(
  ctx: CommandContext,
  scene: SceneFile,
  flagMode?: string,
): ModePlugin {
  return ctx.modes.resolve(flagMode ?? scene.mode);
}

/** Count events by type into a Map (used for greppable histograms and JSON). */
export function eventCounts(events: EventReader): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events.history() as readonly GameEvent[]) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return counts;
}

/** Event counts as a plain, canonical-JSON-friendly record. */
export function eventCountsObject(events: EventReader): Record<string, number> {
  return Object.fromEntries(eventCounts(events));
}

/** Produce the semantic frame, mapping a not-yet-implemented mode view to {@link CliCode.ViewUnavailable}. */
export function frameOf(result: SimResult, mode: string, tick?: number): SemanticFrame {
  try {
    return result.frame(tick);
  } catch (err) {
    if (err instanceof AegisCliError) throw err;
    throw new AegisCliError(
      CliCode.ViewUnavailable,
      `Mode "${mode}" cannot produce a semantic frame: ${(err as Error).message}`,
      { fix: `The ${mode} view provider may not be implemented yet.`, cause: err },
    );
  }
}

/** Produce the ASCII view, or a {@link CliCode.ViewUnavailable} error if the mode offers none. */
export function asciiOf(result: SimResult, mode: string, tick?: number): AsciiView {
  let view: AsciiView | undefined;
  try {
    view = result.ascii(tick);
  } catch (err) {
    throw new AegisCliError(
      CliCode.ViewUnavailable,
      `Mode "${mode}" cannot produce an ASCII view: ${(err as Error).message}`,
      { fix: `The ${mode} view provider may not be implemented yet.`, cause: err },
    );
  }
  if (!view) {
    throw new AegisCliError(CliCode.ViewUnavailable, `Mode "${mode}" has no ASCII view.`, {
      fix: 'Use --frame or --json instead (e.g. fps relies on the semantic frame, not ASCII).',
    });
  }
  return view;
}

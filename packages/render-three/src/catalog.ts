/**
 * The dev server's catalogue: what it needs to know about a playable thing.
 *
 * Deliberately game-agnostic. `@aegis/render-three` is *engine* — `scripts/check-deps.mjs`
 * enforces that nothing under `packages/` may depend on anything under `games/`, by package name
 * or by relative path ("the engine must NEVER depend on a game"). So this module defines the
 * shape of a catalogue entry and knows how to read a scene document, and the **caller** supplies
 * the entries. Wiring the three PoC games is a composition root's job, not the renderer's; see
 * `poc/poc-games.mjs`.
 * @packageDocumentation
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticError } from '@aegis/core';
import type { GameMode } from '@aegis/core';
import { parseScene } from '@aegis/content';
import type { SceneFile } from '@aegis/content';
import type { ModePlugin } from '@aegis/harness';
import type { ModeBindings } from './bindings.js';

/** What a completed playthrough must look like, so a capture can refuse to ship a failed one. */
export interface GameAcceptance {
  /** The event that must have been emitted for the run to count as won, e.g. `"level.completed"`. */
  winEvent: string;
  /** `Name` of the entity that must still be alive at the end, e.g. `"player"`. */
  playerName: string;
  /**
   * The event whose tick makes the most legible screenshot. Defaults to
   * {@link GameAcceptance.winEvent}.
   *
   * Only the event *name* is a choice; the tick is read out of the run's own event log, so this
   * cannot drift into photographing a moment that never happened. It exists because a game can
   * win somewhere visually dull — Sector Breach's exit is a dead-end wall, so the frame worth
   * keeping is the firefight, not the doorway.
   *
   * Naming one is a claim that the run emits it. If it is named and never emitted, the capture
   * **fails**; it does not quietly fall back to {@link GameAcceptance.winEvent}, because that
   * would publish a screenshot of a moment nobody chose and say nothing about it.
   */
  photoEvent?: string;
}

/** One playable entry in the dev server's catalogue. */
export interface GameDefinition {
  /** URL slug, e.g. `"iso"`. */
  id: string;
  /** Display title, e.g. `"The Server Vault"`. */
  title: string;
  /** One-line pitch shown on the landing page. */
  blurb: string;
  /** The mode whose adapter draws it. */
  mode: GameMode;
  /**
   * The plugin to run. For a game this must be its **composed** plugin (the mode's systems plus
   * the game's own); the bare mode plugin would give a world with physics and no game rules.
   */
  plugin: ModePlugin;
  /** The parsed scene document. */
  scene: SceneFile;
  /** Seed override; defaults to the scene's. */
  seed?: number | string;
  /** Fixed ticks per second. Defaults to `60`. */
  tickRate?: number;
  /** How a human drives it. */
  bindings: ModeBindings;
  /** What "winning" looks like, shown in the HUD. */
  objective: string;
  /**
   * The game's own `.input` script (DSL text) — the same one its acceptance test runs. The
   * screenshot capture replays it through real browser events, so a capture can never drift from
   * the playthrough the tests prove.
   */
  script?: string;
  /** How many ticks of {@link GameDefinition.script} to replay. Defaults to the script's span. */
  scriptTicks?: number;
  /** The outcome a capture must observe, or it fails. */
  acceptance?: GameAcceptance;
}

/** Read and parse a scene document, throwing structured diagnostics on failure. */
export async function loadScene(path: string): Promise<SceneFile> {
  const text = await readFile(path, 'utf8');
  const parsed = parseScene(text, path);
  if (!parsed.ok || parsed.value === undefined) throw new DiagnosticError(parsed.diagnostics);
  return parsed.value;
}

/** Read an input-script document as text. Parsing is the caller's job (see `script-input.ts`). */
export async function loadInputScript(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/**
 * Find the repository root by walking up from this module until a directory holds both
 * `packages` and `node_modules` — which is exactly the precondition for serving `/vendor`, since
 * that maps `/vendor/@aegis/<pkg>` to `packages/<pkg>` and `/vendor/three` to the installed
 * package. Works from `src/` under vitest and from `dist/` when built.
 */
export function findRepoRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'node_modules'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[aegis:render-three] could not locate the repository root above ${from} ` +
      '(expected a directory containing both "packages" and "node_modules" — run npm install).',
  );
}

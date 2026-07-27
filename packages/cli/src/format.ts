/**
 * Shared rendering: turn diagnostics, frames, ASCII views and summaries into stable, greppable
 * text (and their `--json` equivalents).
 *
 * Output is for an agent first, a human second (CHARTER principle 9): every human line is a
 * fixed, parseable shape (`severity CODE at loc: message`), and every command that emits data
 * offers a `--json` form built from {@link canonicalStringify} so two identical runs are
 * byte-identical and diffable. No colour, no box-drawing, no wall-clock — nothing an agent has
 * to interpret visually.
 * @packageDocumentation
 */
import { canonicalStringify, entityGeneration, entityIndex, round } from '@aegis/core';
import type { Diagnostic, Entity } from '@aegis/core';
import type { AsciiView, SemanticFrame } from '@aegis/harness';

/**
 * Re-brand a raw packed handle as an {@link Entity}.
 *
 * This is a real seam, not a convenience: `WorldSnapshot` serialises an entity handle as a
 * decimal **string**, and `@aegis/core` exposes `entityIndex`/`entityGeneration` (which take a
 * branded handle) but **no `Entity` constructor or parser** — core itself brands with
 * `0 as Entity` for `NULL_ENTITY`. So reading a snapshot back into a handle must re-brand
 * somewhere. This is the CLI's single such point, named and kept in one place rather than
 * scattered. Reported to the PM: a checked `toEntity(value: number): Entity` in core removes it.
 */
function asEntity(handle: number): Entity {
  return handle as Entity;
}

/**
 * Render a packed entity handle in an agent- and human-legible form: `#<index>` for the common
 * case, `#<index>@<gen>` when the generation is not 1 (i.e. the slot has been reused). Core packs
 * `generation` into the high 32 bits, so a raw handle like `4294967296` is really index 0,
 * generation 1 — unreadable, and indistinguishable from its neighbour `4294967297`. This keeps the
 * index visually dominant and the generation distinguishable, and stays stable/diffable.
 */
export function formatEntity(handle: number): string {
  const e = asEntity(handle);
  const generation = entityGeneration(e);
  return generation === 1 ? `#${entityIndex(e)}` : `#${entityIndex(e)}@${generation}`;
}

/** The decomposed parts of a packed handle for `--json`; `id` preserves the raw packed value. */
export function entityParts(handle: number): { id: string; index: number; generation: number } {
  const e = asEntity(handle);
  return { id: String(handle), index: entityIndex(e), generation: entityGeneration(e) };
}

/** Whether any diagnostic is error severity. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/** Render one diagnostic's source location as `file:path`, `file`, or `<no location>`. */
function formatLocation(d: Diagnostic): string {
  const loc = d.location;
  if (!loc) return '<no location>';
  const parts: string[] = [];
  if (loc.file !== undefined) parts.push(loc.file);
  if (loc.line !== undefined)
    parts.push(String(loc.line) + (loc.column !== undefined ? `:${loc.column}` : ''));
  const head = parts.join(':');
  if (loc.path !== undefined) return head ? `${head} ${loc.path}` : loc.path;
  return head || '<no location>';
}

/** Render a single diagnostic to one or two stable lines (no trailing newline). */
export function formatDiagnostic(d: Diagnostic): string {
  const lines = [`${d.severity} ${d.code} at ${formatLocation(d)}: ${d.message}`];
  if (d.fix) lines.push(`  fix: ${d.fix}`);
  return lines.join('\n');
}

/** Render a list of diagnostics as human text, one block each, plus a trailing count summary. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[], file?: string): string {
  if (diagnostics.length === 0) {
    return file ? `ok ${file}: no problems found` : 'ok: no problems found';
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const infos = diagnostics.length - errors - warnings;
  const summary = `${errors} error(s), ${warnings} warning(s), ${infos} info`;
  return [...diagnostics.map(formatDiagnostic), `-- ${summary}${file ? ` in ${file}` : ''}`].join(
    '\n',
  );
}

/** Serialise any value to canonical (sorted-key, stable) JSON with a trailing newline. */
export function json(value: unknown): string {
  return canonicalStringify(value) + '\n';
}

/** Render a `key: value` block, values already stringified, aligned on the colon. */
export function formatFields(fields: ReadonlyArray<readonly [string, string]>): string {
  const width = fields.reduce((w, [k]) => Math.max(w, k.length), 0);
  return fields.map(([k, v]) => `${k.padEnd(width)} : ${v}`).join('\n');
}

/** A `type ×count` histogram of an event log, most frequent first (ties broken by name). */
export function formatEventHistogram(counts: ReadonlyMap<string, number>): string {
  if (counts.size === 0) return '  (no events)';
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .map(([type, n]) => `  ${type} ×${n}`)
    .join('\n');
}

/** Render an {@link AsciiView} as its rows with a legend footer (human view). */
export function formatAscii(view: AsciiView): string {
  const legend = Object.entries(view.legend)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([glyph, desc]) => `  ${glyph} = ${desc}`)
    .join('\n');
  return [
    `# ascii tick=${view.tick} ${view.width}x${view.height}`,
    ...view.rows,
    '# legend',
    legend,
  ].join('\n');
}

/**
 * Render a {@link SemanticFrame} as a compact, greppable per-entity table (human view).
 *
 * Every field of {@link VisibleEntity} appears, not just position: `layer` decides draw order,
 * and `occluded`/`visibleFraction` are the whole point of the fps frame (principle 7) — a fully
 * hidden entity must not read as a visible one. Optional fields are omitted rather than faked, so
 * "not reported by this mode" stays distinguishable from "reported as visible".
 *
 * The header reports the **census**, not just the row count. A frame lists only what the camera
 * sees, so on `server-vault` it prints 3 rows for a 6-entity world with both mission objectives
 * culled — and `entities=3` alone reads as "the world holds 3 entities", i.e. "the objective does
 * not exist". `aegis inspect --view world` has always said `entities: 3 of 6`; this now does too.
 * The harness fills `totalEntities`/`excludedEntities` for every frame it produces; a frame
 * without them (a hand-built one) prints the old bare form rather than inventing a total.
 *
 * `note` is an optional extra `#` line the caller has **measured** (e.g. how many of the excluded
 * entities `--offscreen` actually recovers). It is a parameter rather than a constant because the
 * answer differs per mode — the platformer and fps providers cull by viewport and honour
 * `includeOffscreen`; the iso provider filters by component and ignores it — and a fixed sentence
 * naming a flag that changes nothing would be exactly the kind of confident-but-wrong advice this
 * output exists to avoid.
 */
export function formatFrame(frame: SemanticFrame, note?: string): string {
  const shown = frame.entities.length;
  const total = frame.totalEntities;
  const excluded = frame.excludedEntities ?? (total === undefined ? undefined : total - shown);
  const census = total === undefined ? `entities=${shown}` : `entities=${shown} of ${total}`;
  const header =
    `# frame tick=${frame.tick} mode=${frame.mode} ` +
    `viewport=${frame.viewport.width}x${frame.viewport.height} ${census}`;
  const cam = frame.camera;
  const camLine =
    `# camera pos=(${cam.position.x},${cam.position.y},${cam.position.z}) ` +
    `projection=${cam.projection}`;
  const excludedLine =
    excluded !== undefined && excluded > 0
      ? [
          `# ${excluded} entit${excluded === 1 ? 'y is' : 'ies are'} NOT in this frame — the ` +
            `mode's view provider left them out (off-screen, or not projected at all).`,
          ...(note === undefined ? [] : [note]),
        ]
      : [];
  if (shown === 0) {
    return [header, camLine, ...excludedLine, '  (no visible entities)'].join('\n');
  }
  const rows = frame.entities.map((e) => {
    const name = e.name ?? '';
    const tags = e.tags.length > 0 ? e.tags.join('|') : '-';
    const parts = [
      `  ${formatEntity(e.entity)} ${name} [${tags}]`,
      `world=(${e.world.x},${e.world.y},${e.world.z})`,
      `screen=(${round2(e.screen.x)},${round2(e.screen.y)})`,
      `depth=${round2(e.depth)}`,
      `layer=${e.layer}`,
    ];
    if (e.bounds) parts.push(`bounds=${round2(e.bounds.width)}x${round2(e.bounds.height)}`);
    if (e.occluded !== undefined) parts.push(`occluded=${e.occluded ? 'yes' : 'no'}`);
    if (e.visibleFraction !== undefined) parts.push(`visible=${round2(e.visibleFraction)}`);
    parts.push(`glyph=${e.glyph ?? '?'}`);
    return parts.join(' ');
  });
  return [header, camLine, ...excludedLine, ...rows].join('\n');
}

/** Round to 2 decimals for display only (never feeds a hash). */
function round2(n: number): number {
  return round(n * 100) / 100;
}

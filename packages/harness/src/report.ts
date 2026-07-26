/**
 * Shared failure-reporting vocabulary (CHARTER principle 6, principle 8).
 *
 * When a headless playthrough fails, the thrown message is the **entire** debugging surface an
 * agent has — there is no viewport to glance at. So the same entity spelling, the same world
 * summary and the same "what did the predicate actually see" rendering are used by every
 * assertion in `assert.ts` and by the invariants in `run.ts`, rather than each inventing its
 * own. Keeping them here also keeps `run.ts` and `assert.ts` free of an import cycle.
 * @packageDocumentation
 */
import { entityGeneration, entityIndex, Name } from '@aegis/core';
import type { Entity, EntityView, World } from '@aegis/core';

/** Normalise an unknown thrown value into an `Error`, without pretending a non-Error is one.
 *
 * `catch (err)` binds `unknown`, and the reflex `(err as Error).message` yields `undefined` for
 * anything that isn't an `Error` — inside the very diagnostic whose job is to explain the failure.
 * Where that is safe, it is safe *because of a fact about the call site* (e.g. `JSON.parse` without
 * a reviver throws only `SyntaxError`), and a fact about a call site can change. This is
 * unconditional.
 */
export function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * What a predicate actually observed.
 *
 * A bare `boolean` says only "false", which is why `holds` and `assertInvariant` used to produce
 * the two least useful messages in the package. Returning a {@link CheckOutcome} instead lets the
 * failure name the value it saw and the value it wanted, so the message alone is actionable.
 */
export interface CheckOutcome {
  /** Whether the property held. */
  ok: boolean;
  /** The value actually observed (rendered into the failure message). */
  actual?: unknown;
  /** The value that was required. */
  expected?: unknown;
  /** A free-form line describing the state that made the check fail. */
  detail?: string;
}

/** A predicate result: the terse `boolean` form, or the self-describing {@link CheckOutcome}. */
export type CheckResult = boolean | CheckOutcome;

/** Normalise either predicate form to a {@link CheckOutcome}. */
export function toOutcome(result: CheckResult): CheckOutcome {
  return typeof result === 'boolean' ? { ok: result } : result;
}

/** Render a value for a failure message: JSON for structures, `String` for the rest. */
export function renderValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * The `actual` / `expected` / `detail` lines of a failure message, or `''` when the predicate
 * returned a bare boolean and told us nothing.
 */
export function renderOutcome(outcome: CheckOutcome): string {
  const lines: string[] = [];
  if (outcome.expected !== undefined) lines.push(`  expected: ${renderValue(outcome.expected)}`);
  if (outcome.actual !== undefined) lines.push(`  actual  : ${renderValue(outcome.actual)}`);
  if (outcome.detail !== undefined) lines.push(`  detail  : ${outcome.detail}`);
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/**
 * Render a packed entity handle the way the CLI does (`packages/cli/src/format.ts`): `#<index>`
 * for the common case, `#<index>@<gen>` once a slot has been reused. Core packs `generation` into
 * the high 32 bits, so a raw handle like `4294967296` is really index 0, generation 1 — unreadable
 * and indistinguishable from its neighbour. An agent debugging a failed playthrough must see the
 * *same* name for an entity here as in `aegis inspect`, so the spelling is kept identical across
 * the whole tool. Presentation only — structured/hashed data keeps the raw packed handle.
 *
 * Takes a branded {@link Entity} rather than a bare `number`: every caller already has one (query
 * results and `EntityView.entity` are branded), so widening to `number` here would only discard
 * the protection at the point where a slot index could be mistaken for a live handle.
 */
export function formatEntity(entity: Entity): string {
  const generation = entityGeneration(entity);
  return generation === 1 ? `#${entityIndex(entity)}` : `#${entityIndex(entity)}@${generation}`;
}

/** A short, readable label for a matched entity view: `#0 "hero"` (or `#0@2` when reused). */
export function describeEntityView(view: EntityView): string {
  const name = view.tryGet(Name)?.value;
  return name ? `${formatEntity(view.entity)} "${name}"` : formatEntity(view.entity);
}

/** A short, readable label for one entity handle: `#0 "hero"` (or `#0@2` when reused). */
export function describeEntity(world: World, entity: Entity): string {
  const view = world
    .query({ has: [] })
    .views()
    .find((v) => v.entity === entity);
  return view ? describeEntityView(view) : formatEntity(entity);
}

/**
 * A one-line census of a world: how many entities it holds and who they are. Used as the default
 * `detail` when a predicate returns a bare boolean, so even the laziest assertion still reports
 * *something* about the state it rejected.
 */
export function summariseWorld(world: World, limit = 6): string {
  const views = world.query({ has: [] }).views();
  if (views.length === 0) return 'the world is empty (0 entities)';
  const shown = views.slice(0, limit).map(describeEntityView);
  const extra = views.length > limit ? `, … (+${views.length - limit} more)` : '';
  return `${views.length} entit${views.length === 1 ? 'y' : 'ies'}: ${shown.join(', ')}${extra}`;
}

/** `scene "games/…", seed 'poc-platformer', tick 12 of 400` — enough to reproduce a failure. */
export function describeRun(run: {
  scene?: string;
  seed?: number | string;
  tick?: number;
  ticks?: number;
}): string {
  const parts: string[] = [];
  if (run.scene !== undefined) parts.push(`scene ${JSON.stringify(run.scene)}`);
  if (run.seed !== undefined) parts.push(`seed ${renderValue(run.seed)}`);
  if (run.tick !== undefined) {
    parts.push(run.ticks === undefined ? `tick ${run.tick}` : `tick ${run.tick} of ${run.ticks}`);
  } else if (run.ticks !== undefined) {
    parts.push(`${run.ticks} ticks`);
  }
  return parts.join(', ');
}

/**
 * The two things the harness could not previously tell apart: **"verified"** and
 * **"didn't check"** (CHARTER principle 6).
 *
 * Two independent ways an assertion could report success without testing anything:
 *
 * 1. **A component reference that resolves to nothing.** `world.query` matches string refs
 *    against component ids; an id that no component has simply never matches. So
 *    `entityCount({ has: ['Enmy'] }, 0)` — "assert every enemy is dead" — passed on *any* world,
 *    including one where the enemy stood there at full health, and `none: ['Playr']` silently
 *    disabled the exclusion it was written to apply. A typo must be a loud error.
 * 2. **An `expect` block that asserts nothing.** `runGameTest` reported `passed: true` whenever
 *    the callback did not throw, so an empty (or accidentally short-circuited) expectation read
 *    as a clean pass. Assertions are counted, and a test that ran none fails.
 *
 * Both are recorded **on the {@link "./run".SimResult} object itself**, under a registered
 * symbol, so no public contract grows an enumerable field and nothing leaks between runs.
 *
 * ## Why not module state
 * Both records lived in module-level `WeakMap`s until a second copy of this module —
 * two physical installs, a `dist` tree imported by file URL as well as by specifier, a Windows
 * path whose drive letter is cased differently — gave the process **two ledgers**. Assertions
 * incremented one, {@link "./assert".runGameTest} read the other, and a test that asserted
 * correctly was failed with *"executed ZERO assertions … its `expect(result)` callback returned
 * without calling a single `expectSim(...)` assertion"*: a message that states something false
 * about code that is fine, and sends its reader to debug the wrong file. Worse in the other
 * direction, {@link unknownComponentRefs} returned `[]` for a result the *other* instance had
 * registered, silently disarming the typo guard — the exact fail-open this module exists to
 * prevent. State keyed by the result, and carried by the result, cannot be duplicated: there is
 * only ever one result object. See `module-instances.test.ts`.
 * @packageDocumentation
 */
import type { QueryDescriptor, World } from '@aegis/core';
import { abs } from '@aegis/core';
import type { ComponentRegistry } from '@aegis/content';

// --- cross-instance state ---------------------------------------------------------------------

/** Everything the harness knows about which component ids a given run can resolve. */
interface KnownComponents {
  /** Ids registered for the run: core + content + the mode plugin + caller extras. */
  registered: ReadonlySet<string>;
  /** The final world, consulted lazily for ids a system attached without registering. */
  world: World;
  /** Cache of the (expensive) world scan, computed at most once per run. */
  inWorld?: ReadonlySet<string>;
}

/** Everything the harness records about one run, for reporting what it actually verified. */
interface VerificationState {
  /** Which component ids the run can resolve; absent for an object the harness did not produce. */
  known?: KnownComponents;
  /** Every assertion that executed against the run, in order. */
  assertions: AssertionRecord[];
}

/**
 * The property this module hangs {@link VerificationState} off a result under.
 *
 * `Symbol.for` (the process-wide registry) rather than a fresh `Symbol()`: a fresh symbol is
 * per-module-instance and would reproduce exactly the split this design removes. The `/1` suffix
 * is a shape version — a future incompatible record must pick a new key rather than silently
 * misread this one.
 */
const VERIFICATION = Symbol.for('aegis.harness.verification/1');

/**
 * Fallback for a result that cannot carry a property (frozen or sealed — a hand-rolled test
 * double, typically). Held on `globalThis` under a registered symbol so that even this path is
 * shared by every copy of this module, rather than reintroducing the split it replaces.
 */
const FALLBACK = Symbol.for('aegis.harness.verification.fallback/1');

type FallbackHost = { [FALLBACK]?: WeakMap<object, VerificationState> };

function fallbackStore(): WeakMap<object, VerificationState> {
  const host = globalThis as FallbackHost;
  return (host[FALLBACK] ??= new WeakMap<object, VerificationState>());
}

/** The state carried by `result`, reading through any module instance that attached it. */
function stateOf(result: object): VerificationState | undefined {
  const carried = (result as { [VERIFICATION]?: VerificationState })[VERIFICATION];
  if (carried && Array.isArray(carried.assertions)) return carried;
  return fallbackStore().get(result);
}

/** The state carried by `result`, attaching a fresh one if this is the first record about it. */
function ensureState(result: object): VerificationState {
  const existing = stateOf(result);
  if (existing) return existing;
  const state: VerificationState = { assertions: [] };
  try {
    Object.defineProperty(result, VERIFICATION, {
      value: state,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    // Non-extensible result: keep the record in the shared fallback rather than throwing from
    // inside an assertion, which would report a harness problem as a gameplay failure.
    fallbackStore().set(result, state);
  }
  return state;
}

// --- known component ids --------------------------------------------------------------------

/** Record which component ids `result` can resolve. Called by the runner for every run. */
export function registerKnownComponents(
  result: object,
  registry: ComponentRegistry,
  world: World,
): void {
  ensureState(result).known = { registered: new Set(registry.ids()), world };
}

/** Component ids actually present on some entity in `world` (scans the snapshot once). */
function componentIdsInWorld(world: World): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entity of world.snapshot().entities) {
    for (const id of Object.keys(entity.components)) ids.add(id);
  }
  return ids;
}

/**
 * Every component id this run can resolve: the registry, plus anything a system attached at
 * runtime without declaring it in `ModePlugin.components()`. The world scan is only reached for
 * a ref that already missed the registry, and is cached, so the happy path stays free.
 */
function resolvableIds(entry: KnownComponents): ReadonlySet<string> {
  if (entry.inWorld === undefined) entry.inWorld = componentIdsInWorld(entry.world);
  return new Set([...entry.registered, ...entry.inWorld]);
}

/** Case-insensitive / edit-distance-1 candidates for a mistyped id, cheapest first. */
function nearMisses(unknownId: string, candidates: Iterable<string>): string[] {
  const lower = unknownId.toLowerCase();
  const close: string[] = [];
  for (const id of candidates) {
    if (id === unknownId) continue;
    const other = id.toLowerCase();
    if (other === lower || withinOneEdit(lower, other)) close.push(id);
  }
  return close.sort();
}

/** Whether `a` becomes `b` with at most one insertion, deletion or substitution. */
function withinOneEdit(a: string, b: string): boolean {
  if (abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (shorter.length === longer.length) i++;
    j++;
  }
  return edits + (longer.length - j) + (shorter.length - i) <= 1;
}

/** One unresolvable reference, with the clause it appeared in and what it might have meant. */
export interface UnknownComponentRef {
  /** The id as written in the query. */
  id: string;
  /** Which clause it appeared in. */
  clause: 'has' | 'any' | 'none';
  /** Registered/present ids within one edit of it, if any. */
  suggestions: readonly string[];
}

/**
 * Unresolvable string component references in `query`, in clause order.
 *
 * `ComponentType` references cannot be mistyped, so only strings are checked. Returns `[]` for a
 * result the harness did not produce (nothing is known about it, and guessing would be worse than
 * saying nothing).
 */
export function unknownComponentRefs(
  result: object,
  query: QueryDescriptor,
): readonly UnknownComponentRef[] {
  const entry = stateOf(result)?.known;
  if (!entry) return [];
  const clauses: [UnknownComponentRef['clause'], QueryDescriptor['has']][] = [
    ['has', query.has],
    ['any', query.any],
    ['none', query.none],
  ];
  const misses: UnknownComponentRef[] = [];
  let resolvable: ReadonlySet<string> | undefined;
  for (const [clause, refs] of clauses) {
    for (const ref of refs ?? []) {
      if (typeof ref !== 'string') continue;
      if (entry.registered.has(ref)) continue;
      resolvable ??= resolvableIds(entry);
      if (resolvable.has(ref)) continue;
      misses.push({ id: ref, clause, suggestions: nearMisses(ref, resolvable) });
    }
  }
  return misses;
}

/**
 * The explanatory block appended to a failure caused by unresolvable references: what could not
 * be resolved, what it probably meant, and why a silent no-op would have been worse.
 */
export function explainUnknownRefs(result: object, misses: readonly UnknownComponentRef[]): string {
  const entry = stateOf(result)?.known;
  const lines = misses.map((m) => {
    const hint =
      m.suggestions.length > 0
        ? ` Did you mean ${m.suggestions.map((s) => `"${s}"`).join(' or ')}?`
        : '';
    return `  - "${m.id}" (in ${m.clause}:) is not a registered component and no entity has it.${hint}`;
  });
  const catalogue = entry
    ? `\nRegistered components: ${[...entry.registered].sort().join(', ')}`
    : '';
  const plural = misses.length === 1 ? 'reference' : 'references';
  return (
    `\nUnresolvable component ${plural} — the query could never have matched what you meant:\n` +
    `${lines.join('\n')}\n` +
    `An unresolvable reference matches nothing and silently disables its clause, so an ` +
    `assertion built on it can pass on any world (an "all enemies dead" count of 0 is met by a ` +
    `world where the enemy is alive at full health). Fix the name rather than the expectation.` +
    catalogue
  );
}

// --- the assertion ledger -------------------------------------------------------------------

/** One assertion that actually executed against a run. */
export interface AssertionRecord {
  /** The assertion method or invariant that ran. */
  kind: string;
  /** What it checked, in one readable line. */
  detail: string;
}

/** Record that an assertion really executed against `result`. Called by every assertion. */
export function recordAssertion(result: object, kind: string, detail: string): void {
  ensureState(result).assertions.push({ kind, detail });
}

/** Every assertion that executed against `result`, in order. */
export function assertionsFor(result: object): readonly AssertionRecord[] {
  return stateOf(result)?.assertions ?? [];
}

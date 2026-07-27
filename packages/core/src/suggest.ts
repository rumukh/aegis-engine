/**
 * The one "did you mean …?" engine.
 *
 * Two places in the engine have to decide whether a name an author wrote is a *typo* of a
 * registered name or a *different* name: `@aegis/content` (unknown component, field, resource
 * and enum values) and the scheduler (a `before`/`after` entry naming no registered system).
 * They had two implementations with different rules, and the difference was not cosmetic —
 * the scheduler's flat "within two edits" limit **throws**, so it turned a legitimately-absent
 * optional dependency into a schedule that could not be built at all:
 *
 * ```
 * createSchedule().add({ name: 'ai', run }).add({ name: 'x', after: ['aim'], run }).resolved()
 * // [aegis] Schedule: system "x" declares after: ["aim"] … Did you mean "ai"?
 * ```
 *
 * One edit is most of a two-character name. The rule below is therefore scaled to length, and
 * scaled to the length of the **shorter** name: a name only has as many characters as it has,
 * so allowing one edit between `ai` and `aim` means letting half the shorter name differ, which
 * is not a typo — it is a different name. Every suggestion `@aegis/content` pins
 * (`curent`→`current`, `nmae`→`name`, `Helth`→`Health`, `spere`→`sphere`,
 * `platformer.tilemp`→`platformer.tilemap`) still holds under it; `aim`→`ai` no longer does.
 * @packageDocumentation
 */

/**
 * Restricted Damerau-Levenshtein distance: an adjacent transposition counts as one edit, so
 * `nmae` -> `name` scores 1. Field, component and system names are short, so the matrix stays
 * tiny.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    rows.push(row);
  }
  const first = rows[0] as number[];
  for (let j = 0; j <= b.length; j++) first[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const prev = rows[i - 1] as number[];
    const cur = rows[i] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = (prev[j] as number) + 1; // deletion
      const insertion = (cur[j - 1] as number) + 1;
      if (insertion < best) best = insertion;
      const substitution = (prev[j - 1] as number) + cost;
      if (substitution < best) best = substitution;
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const transposition = ((rows[i - 2] as number[])[j - 2] as number) + 1;
        if (transposition < best) best = transposition;
      }
      cur[j] = best;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/**
 * How far apart two names may be before a suggestion is more confusing than helpful, given the
 * length of the **shorter** of the two.
 *
 * @param length - Length of the shorter name.
 */
export function suggestionTolerance(length: number): number {
  if (length <= 2) return 0; // one- and two-letter names (x/y/z, ai) would all suggest each other
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * The closest of `candidates` to `name`, or `undefined` when nothing is close enough.
 *
 * A case-only difference always wins. Ties break on the lexicographically smaller candidate, so
 * the suggestion is deterministic whatever order the candidates arrive in.
 */
export function suggestName(name: string, candidates: Iterable<string>): string | undefined {
  const sorted = [...candidates].sort();
  const lower = name.toLowerCase();
  for (const candidate of sorted) if (candidate.toLowerCase() === lower) return candidate;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of sorted) {
    const shortest = candidate.length < name.length ? candidate.length : name.length;
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= suggestionTolerance(shortest) && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

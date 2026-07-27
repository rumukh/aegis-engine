/**
 * Every `AGENTS.md` citation in the source tree must point at something that exists.
 *
 * `AGENTS.md` §9 is a numbered table of rough edges, and source comments cite its rows to explain
 * why a regression test exists. Those citations used to name a **row number**. A row number is an
 * index into a list that nothing validates, so deleting a row silently invalidates every citation
 * below it — which is exactly what happened: one commit removed a row that measured false, and
 * four correct citations in four files became wrong at once, with nothing red and nothing to
 * notice. The section that warns about one source copied into many channels acquired an unguarded
 * index into itself.
 *
 * Renumbering the citations would only postpone it to the next edit, so a citation now quotes a
 * distinctive fragment of the row's own **title**. A title survives insertion, deletion and
 * reordering; if the row it names is genuinely removed, this test goes red and a human decides
 * whether the citing test still has a subject. That is the correct outcome — a dangling citation
 * is a question, not a formatting error.
 *
 * ## What is checked
 *
 * 1. Every cited section (`§1.5`, `§6.4`, `§9`) resolves to a heading in `AGENTS.md`.
 * 2. Every quoted fragment (`§9, "names its plugin as a string"`) appears in exactly **one** §9
 *    row. Zero means the row moved or went; more than one means the fragment is too weak to
 *    identify anything, which is the same failure a stale number has.
 * 3. No citation uses the bare `§9 #6` row-number form at all. This is the rule that matters:
 *    the other two only catch a citation that has already broken, while this one removes the
 *    mechanism.
 *
 * ## Why the anti-vacuity floors are here
 *
 * Every check above is a `for` loop over a corpus this file discovers for itself. A walker with a
 * wrong root, a regex that stopped matching, or a heading format that changed would produce an
 * empty corpus — and an empty corpus passes every one of them. That reads as "all citations are
 * valid" and means "no citations were examined". So the corpus sizes are asserted first, and the
 * checks below are only meaningful because those assertions ran.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** Working-tree files are CRLF here; every pattern below is written against `\n`. */
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const guide = read(join(root, 'AGENTS.md'));

/** Directories that hold no authored source, including the fixture root under `node_modules`. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo']);
const SOURCE_ROOTS = ['packages', 'games', 'test', 'scripts', 'poc'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Section ids declared by headings: `## 9. Rough edges` and `### 1.5 Setup` both count. */
function declaredSections(): Set<string> {
  const ids = new Set<string>();
  for (const line of guide.split('\n')) {
    const m = /^#{1,4} (\d+(?:\.\d+)*)\.? /.exec(line);
    const id = m?.[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * The bolded lead of each `| n | **Title.** …` row in the §9 table. Matching against the whole
 * row would let a citation "resolve" against prose in the *work around it by…* column, which is
 * not a name for anything.
 */
function rowTitles(): string[] {
  const titles: string[] = [];
  for (const line of guide.split('\n')) {
    const m = /^\|\s*\d+\s*\|\s*\*\*(.+?)\*\*/.exec(line);
    const title = m?.[1];
    if (title !== undefined) titles.push(title);
  }
  return titles;
}

interface Citation {
  file: string;
  line: number;
  section: string;
  /** Text immediately following the section id, where a `#n` or a `"fragment"` would appear. */
  tail: string;
}

const CITATION = /`?AGENTS\.md`?[^\n§]{0,40}§\s*(\d+(?:\.\d+)*)/g;

function citations(): Citation[] {
  const found: Citation[] = [];
  for (const dir of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(root, dir))) {
      const text = read(file);
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(CITATION)) {
          const section = m[1];
          if (section === undefined) continue;
          found.push({
            file: file.slice(root.length + 1).replace(/\\/g, '/'),
            line: i + 1,
            section,
            tail: line.slice((m.index ?? 0) + m[0].length),
          });
        }
      });
    }
  }
  return found;
}

const SECTIONS = declaredSections();
const TITLES = rowTitles();
const CITED = citations();

/** A quoted fragment on the same line as the citation, e.g. `§9, "names its plugin as a string"`. */
function quotedFragment(tail: string): string | undefined {
  return /^\s*,\s*"([^"]+)"/.exec(tail)?.[1];
}

/** The retired form: a bare row index, e.g. `§9 #6`. */
function rowNumber(tail: string): string | undefined {
  return /^\s*#(\d+)/.exec(tail)?.[1];
}

describe('AGENTS.md citations resolve', () => {
  it('the corpora are non-empty, so the checks below examined something', () => {
    // Floors, not exact counts: exact counts would redden on every unrelated edit, which trains
    // people to update the number without reading why it moved.
    expect(SECTIONS.size, 'no numbered headings parsed out of AGENTS.md').toBeGreaterThan(20);
    expect(TITLES.length, 'no §9 rough-edge rows parsed out of AGENTS.md').toBeGreaterThanOrEqual(
      5,
    );
    expect(CITED.length, 'no AGENTS.md citations found in the source tree').toBeGreaterThanOrEqual(
      6,
    );
  });

  it('every cited section exists', () => {
    const dangling = CITED.filter((c) => !SECTIONS.has(c.section)).map(
      (c) => `${c.file}:${c.line} cites §${c.section}, which is not a heading in AGENTS.md`,
    );
    expect(dangling).toEqual([]);
  });

  it('every quoted row fragment names exactly one row', () => {
    const problems: string[] = [];
    for (const c of CITED) {
      const fragment = quotedFragment(c.tail);
      if (fragment === undefined) continue;
      const hits = TITLES.filter((t) => t.includes(fragment));
      if (hits.length !== 1) {
        problems.push(
          `${c.file}:${c.line} quotes "${fragment}", which matches ${hits.length} §9 rows ` +
            `(want exactly 1). Either the row changed, or the fragment is too weak to name one.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('no citation uses a bare row number', () => {
    const numeric = CITED.filter((c) => rowNumber(c.tail) !== undefined).map(
      (c) =>
        `${c.file}:${c.line} cites §${c.section} #${rowNumber(c.tail)} by number. Quote a ` +
        `fragment of the row's title instead — a number silently retargets when a row is removed.`,
    );
    expect(numeric).toEqual([]);
  });
});

describe('the guard can actually fail', () => {
  // Without these, every assertion above is a loop that a broken parser satisfies by iterating
  // nothing. Each control drives the same predicate the real check uses.

  it('rejects a section that does not exist', () => {
    expect(SECTIONS.has('9')).toBe(true);
    expect(SECTIONS.has('99.99')).toBe(false);
  });

  it('rejects a fragment that names no row', () => {
    // Stated as a throw rather than a `!`: if the table is empty this control is examining
    // nothing, and the run should say so out loud instead of failing on an index.
    const first = TITLES[0];
    if (first === undefined)
      throw new Error('the §9 table has no rows, so this control cannot run');
    const real = first.slice(0, 24);
    expect(TITLES.filter((t) => t.includes(real))).toHaveLength(1);
    expect(TITLES.filter((t) => t.includes('a rough edge nobody wrote down'))).toHaveLength(0);
  });

  it('recognises the retired row-number form', () => {
    expect(rowNumber(' #6: the scaffolded test')).toBe('6');
    expect(rowNumber(', "names its plugin as a string")')).toBeUndefined();
  });

  it('reads a quoted fragment only when one is actually there', () => {
    expect(quotedFragment(', "names its plugin as a string")')).toBe(
      'names its plugin as a string',
    );
    expect(quotedFragment(' makes the general argument')).toBeUndefined();
  });

  it('the walker reaches real source and skips node_modules', () => {
    const files = sourceFiles(join(root, 'packages'));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => f.includes(`${'node_modules'}`))).toEqual([]);
  });
});

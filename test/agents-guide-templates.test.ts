/**
 * **Every code template in `AGENTS.md` must be a verbatim quote of a file the gate runs.**
 *
 * ## Why this file exists, and why it is here
 *
 * `AGENTS.md` is the emitter for every game anyone writes with this engine. The defect that
 * shaped this project's whole review phase — `hashEquals(result.hash)`, an assertion that can
 * never fail — entered from a *design document* and was then copied verbatim into a shipped game
 * test, three harness tests, a second design doc, a commit message and the `scaffold` generator.
 * Six channels, one source. The code channel is now closed by a lint rule; **prose has no
 * runner**, so a guide full of copyable templates is the highest-half-life propagation channel
 * left in the repository.
 *
 * The PM ruling this implements: anything a reader would copy to make their own game work must be
 * a verbatim quote of a real file the gate already runs, with a test asserting the fenced block
 * still matches. The doc then holds no independent copy, so it cannot drift. Exempt: transcripts
 * (output — nobody copies output into their source) and clearly-marked sketches.
 *
 * It lives in a root-level `test/` tree rather than following `gametest-discovery.test.ts` into
 * `games/platformer/test/`. That precedent states its own reason: *"it lives here only because the
 * root vitest config globs each game's `test` directory, so a cross-game check has to sit inside
 * one of them."* The constraint was the absence of a root-covered location, not a judgement that a
 * game is the right home. `AGENTS.md` and the root config are both owned by the PM
 * (`docs/working-agreement.md` §1), so the guard over a root document now sits in a tree its owner
 * also owns — rather than in a package whose owner does not own the thing being guarded.
 * `vitest.config.ts` and `tsconfig.tests.json` were extended in the same change set, so this
 * directory is covered by `npm run verify`, type-checked, linted and format-checked like any other.
 *
 * ## The contract a marker expresses
 *
 * Every fenced block whose language is `ts`, `js`, `mjs`, `cjs` or `json` must carry an HTML
 * comment on the nearest non-blank line **above** the opening fence:
 *
 * - `template-source: <repo-relative path> #file` — the block is the whole file.
 * - `template-source: <repo-relative path> #region` — the block is a contiguous excerpt of it.
 * - `template-exempt: <reason>` — a transcript, or a sketch that is marked as one.
 *
 * **An unmarked code block fails.** That is the load-bearing half: a guard that only checks the
 * blocks already marked cannot see the *next* template someone adds, and a new unmarked template
 * is exactly the rot channel this closes. Requiring a marker forces the author to classify.
 *
 * ## Normalisation, stated rather than implied
 *
 * Both sides are reduced identically: a line whose trimmed form starts with a line comment, a
 * JSDoc opener, a JSDoc continuation asterisk or a JSDoc closer is dropped — which removes doc
 * comment blocks wholesale, since every line of one starts with one of those — and blank lines are
 * dropped. `#file` compares with leading indentation intact; `#region` also trims the left,
 * because an excerpt is legitimately re-indented when lifted out of its nesting.
 *
 * Known limit, stated because an unstated limit is how this project's last four instrument
 * failures happened: comment removal is line-based, so a trailing comment on a line of code is
 * **not** stripped, and such a line must be quoted with its comment. That is deliberate. A regular
 * expression spanning block-comment delimiters would also match inside the JSON string
 * `"src/ ** / *.ts"` (written spaced here for the same reason) and would silently reduce both
 * sides to the same mangled text — a comparison that agrees because both inputs were destroyed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Repository root — this file sits at `<root>/test/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Languages that make a fenced block a *template* rather than a transcript. */
const CODE_LANGS = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'json']);

/**
 * Every code block in `AGENTS.md` today. A drop below this means the extractor stopped seeing
 * blocks — an instrument that cannot tell "I checked and found nothing" from "I never looked" is
 * the single most repeated failure in this project's history, so the extractor is pinned too.
 * Growing the guide is expected; raise this number deliberately when you do.
 */
const KNOWN_CODE_BLOCKS = 15;

/** One fenced block, with the line above its opening fence. */
interface Block {
  /** Fence language, e.g. `ts`. */
  lang: string;
  /** 1-based line number of the opening fence, for failure messages. */
  line: number;
  /** Block body, without the fences. */
  body: string;
  /** The trimmed nearest non-blank line above the opening fence. */
  marker: string | undefined;
}

/** A parsed `template-source` marker. */
interface SourceRef {
  path: string;
  mode: 'file' | 'region';
}

/** The trimmed nearest non-blank line above `fenceLine` (1-based), or `undefined`. */
function markerAbove(lines: readonly string[], fenceLine: number): string | undefined {
  // Not "the line directly above": `prettier --check .` is part of the gate and it inserts a blank
  // line between an HTML comment and a fenced block, so requiring adjacency would make the guard
  // and the formatter contradict each other — and the formatter always wins.
  for (let i = fenceLine - 2; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line !== '') return line;
  }
  return undefined;
}

/** Split `AGENTS.md` into fenced blocks, carrying the marker above each opening fence. */
function readBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let open: { lang: string; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? '').startsWith('```')) continue;
    if (open === undefined) {
      open = { lang: (lines[i] ?? '').slice(3).trim(), line: i + 1 };
    } else {
      blocks.push({
        lang: open.lang,
        line: open.line,
        body: lines.slice(open.line, i).join('\n'),
        marker: markerAbove(lines, open.line),
      });
      open = undefined;
    }
  }
  if (open !== undefined) {
    throw new Error(`AGENTS.md has an unclosed code fence opened at line ${open.line}`);
  }
  return blocks;
}

/** True for a line that is pure commentary in TS, JS or a commented JSON excerpt. */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** Drop comment and blank lines; trim per the comparison mode. See the file header. */
function normalise(text: string, mode: 'file' | 'region'): string[] {
  return text
    .split('\n')
    .map((l) => (mode === 'region' ? l.trim() : l.trimEnd()))
    .filter((l) => l.trim() !== '' && !isCommentLine(l.trim()));
}

/** Is `needle` a contiguous run inside `haystack`? */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((line, j) => haystack[i + j] === line)) return true;
  }
  return false;
}

/** Parse `<!-- template-source: <path> #file|#region -->`. */
function parseSourceMarker(marker: string | undefined): SourceRef | undefined {
  const m = /^<!--\s*template-source:\s*(\S+)\s+#(file|region)\s*-->$/.exec(marker ?? '');
  if (m === null) return undefined;
  return { path: m[1] as string, mode: m[2] as 'file' | 'region' };
}

/** Does this marker declare the block deliberately un-pinnable, **with a reason**? */
function isExemptMarker(marker: string | undefined): boolean {
  return /^<!--\s*template-exempt:\s*\S.*-->$/.test(marker ?? '');
}

/**
 * Compare one block against its declared source. `undefined` means it matches; otherwise a
 * message naming the first line that differs — a diff, never a bare boolean, so a failure says
 * *what* drifted rather than only *that* something did.
 */
function mismatch(
  block: Block,
  source: string,
  mode: 'file' | 'region',
  path: string,
): string | undefined {
  const want = normalise(block.body, mode);
  const have = normalise(source, mode);
  if (want.length === 0) return `the block at AGENTS.md:${block.line} normalised to nothing`;

  if (mode === 'file') {
    if (want.length === have.length && want.every((l, i) => l === have[i])) return undefined;
    const at = want.findIndex((l, i) => l !== have[i]);
    const i = at === -1 ? want.length : at;
    return (
      `AGENTS.md:${block.line} is no longer a verbatim copy of ${path}.\n` +
      `  first difference at code line ${i + 1}:\n` +
      `    AGENTS.md: ${JSON.stringify(want[i] ?? '<end of block>')}\n` +
      `    ${path}:   ${JSON.stringify(have[i] ?? '<end of file>')}`
    );
  }

  if (containsRun(have, want)) return undefined;
  const missing = want.find((l) => !have.includes(l)) ?? want[0];
  return (
    `AGENTS.md:${block.line} is no longer a contiguous excerpt of ${path}.\n` +
    `  this line is absent from ${path}, or no longer adjacent to the rest:\n` +
    `    ${JSON.stringify(missing)}`
  );
}

/** Read the source file a marker names. */
function readSource(path: string): string {
  return readFileSync(join(ROOT, ...path.split('/')), 'utf8');
}

const blocks = readBlocks(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'));
const codeBlocks = blocks.filter((b) => CODE_LANGS.has(b.lang));
const pinnedBlocks = codeBlocks
  .map((block) => ({ block, src: parseSourceMarker(block.marker) }))
  .filter((e): e is { block: Block; src: SourceRef } => e.src !== undefined);

describe('AGENTS.md templates are quotes of files the gate runs', () => {
  it('the extractor still sees the guide (anti-vacuity)', () => {
    // Without this, an extractor that silently matched nothing would report a clean sweep — which
    // is how six "negative findings" in this project turned out to be instruments that never ran.
    expect(blocks.length).toBeGreaterThan(codeBlocks.length);
    expect(
      codeBlocks.length,
      `expected at least ${KNOWN_CODE_BLOCKS} ts/js/json blocks in AGENTS.md but found ` +
        `${codeBlocks.length} — if the guide legitimately shrank, lower KNOWN_CODE_BLOCKS on purpose`,
    ).toBeGreaterThanOrEqual(KNOWN_CODE_BLOCKS);
  });

  it('every code block declares its provenance', () => {
    const unmarked = codeBlocks
      .filter((b) => parseSourceMarker(b.marker) === undefined && !isExemptMarker(b.marker))
      .map((b) => `AGENTS.md:${b.line} (${b.lang})`);
    expect(
      unmarked,
      'these code blocks carry no provenance marker on the nearest non-blank line above the\n' +
        'opening fence. Add\n' +
        '  <!-- template-source: <path> #file -->    if it quotes a whole file,\n' +
        '  <!-- template-source: <path> #region -->  if it quotes a contiguous excerpt, or\n' +
        '  <!-- template-exempt: <reason> -->        if it is a transcript or a marked sketch.',
    ).toEqual([]);
  });

  it('the exemption has a floor: real templates stay pinned', () => {
    // Marking everything exempt would satisfy the test above while pinning nothing.
    expect(pinnedBlocks.map((e) => e.src.path).sort()).toEqual([
      'games/fps/tsconfig.json',
      'games/platformer/aegis.json',
      'games/platformer/src/coyote-gap.gametest.ts',
      'games/platformer/src/plugin.ts',
    ]);
  });

  it.each(
    pinnedBlocks.map((e) => ({
      name: `AGENTS.md:${e.block.line} = ${e.src.path} (#${e.src.mode})`,
      ...e,
    })),
  )('$name', ({ block, src }) => {
    expect(mismatch(block, readSource(src.path), src.mode, src.path)).toBeUndefined();
  });
});

describe('the guard can actually fail', () => {
  // `golden-hash.invariant.test.ts` ships a second test asserting its own detector still detects,
  // because a guard that has stopped working looks exactly like a guard with nothing to report.
  // These perturb a known-good pairing in memory and require the comparison to reject it.
  const pinned = pinnedBlocks.find((e) => e.src.mode === 'file');

  it('there is a pinned whole-file block to perturb', () => {
    expect(pinned?.src.path).toBeDefined();
  });

  it('rejects a changed line', () => {
    const { block, src } = pinned as { block: Block; src: SourceRef };
    const body = block.body.replace(/\w+/, 'tamperedIdentifier');
    expect(body).not.toBe(block.body); // the perturbation actually perturbed
    expect(mismatch({ ...block, body }, readSource(src.path), 'file', src.path)).toContain(
      'no longer a verbatim copy',
    );
  });

  it('rejects a deleted line', () => {
    const { block, src } = pinned as { block: Block; src: SourceRef };
    const body = normalise(block.body, 'file').slice(0, -1).join('\n');
    expect(mismatch({ ...block, body }, readSource(src.path), 'file', src.path)).toContain(
      'no longer a verbatim copy',
    );
  });

  it('rejects an excerpt whose lines are no longer adjacent', () => {
    const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const block: Block = { lang: 'ts', line: 0, body: lines.join('\n'), marker: undefined };
    // Positive control first: the comparison must accept the un-perturbed case, or its rejection
    // of the perturbed one proves nothing.
    expect(mismatch(block, lines.join('\n'), 'region', 'x.ts')).toBeUndefined();
    const wedged = [lines[0], lines[1], 'const wedge = 0;', lines[2]].join('\n');
    expect(mismatch(block, wedged, 'region', 'x.ts')).toContain('no longer a contiguous excerpt');
  });

  it('rejects an exemption with no reason', () => {
    expect(isExemptMarker('<!-- template-exempt: -->')).toBe(false);
    expect(isExemptMarker('<!-- template-exempt: a stated reason -->')).toBe(true);
    expect(parseSourceMarker('<!-- template-source: a/b.ts -->')).toBeUndefined();
    expect(parseSourceMarker('<!-- template-source: a/b.ts #file -->')).toEqual({
      path: 'a/b.ts',
      mode: 'file',
    });
  });
});

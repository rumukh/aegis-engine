/**
 * ADR-0001's math surface list, given a runner.
 *
 * `docs/adr/0001-determinism-strategy.md` §"Which functions core actually provides" tells an
 * implementer which `Math.*` members the lint rule bans and which of them `@aegis/core` replaces.
 * Its whole purpose is to answer "I need `pow`, what do I do?" — so when it is wrong, it is wrong
 * at exactly the moment someone is trusting it, and it sends them looking for an export that does
 * not exist or, worse, tells them there is no legal path when there is one.
 *
 * It was wrong. The "does not provide" list omitted `atan`, `expm1`, `log1p`, `sinh`, `cosh` and
 * `tanh`. `atan` is the one that matters: it is banned by the lint rule, it is *not* provided by
 * core (only `atan2` is), and the ADR's list of gaps did not mention it. A mode author reading
 * that paragraph would conclude `atan` was available.
 *
 * `AGENTS.md` §9 makes the general argument: a lint rule closes the code channel mechanically and
 * permanently, but **prose has no runner**, so the prose channel is closed only by a human reading
 * a document and asking what a line is for — a one-time act nobody schedules. This file is that
 * schedule. Both lists in the ADR are now derived and compared against the two things they
 * describe: the eslint configuration, and core's actual exports.
 *
 * **Stated limitation.** The banned list is read out of `eslint.config.js` as text rather than by
 * importing it, because that file is JavaScript and this program (`tsconfig.tests.json`) has no
 * `allowJs`. So this test is pinned to the *shape* of that declaration, not to eslint's effective
 * configuration: someone could add a second `no-restricted-properties` block elsewhere in the
 * config and this test would not see it. The floor assertions below are what keep the parse from
 * degrading silently into "found nothing, therefore nothing is banned".
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as core from '@aegis/core';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `Math.random` is banned but is not a math-surface gap: the seeded PRNG replaces it. */
const NOT_A_MATH_GAP = 'random';

/** Read the `Math.*` members the determinism lint rule refuses. */
function bannedMathProps(): string[] {
  const source = readFileSync(join(repoRoot, 'eslint.config.js'), 'utf8');
  const match = /const bannedMathProps = \[([^\]]*)\]/.exec(source);
  if (match === null) throw new Error('could not find `bannedMathProps` in eslint.config.js');
  return [...(match[1] as string).matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1] as string);
}

/** The two lists ADR-0001 publishes, in the order it publishes them. */
function adrLists(): { provides: string[]; missing: string[] } {
  const source = readFileSync(
    join(repoRoot, 'docs', 'adr', '0001-determinism-strategy.md'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const heading = '### Which functions core actually provides';
  const start = source.indexOf(heading);
  if (start < 0) throw new Error(`could not find "${heading}" in ADR-0001`);

  // Bounded to the one paragraph, not to the section. A section-wide slice silently swept in
  // every backticked identifier in the four paragraphs that follow, which made the gap list look
  // 26 entries long and would have hidden a real omission behind a pile of unrelated names.
  const marker = 'It does **not** provide';
  const split = source.indexOf(marker, start);
  if (split < 0) throw new Error('could not find the "does not provide" sentence in ADR-0001');
  const paragraphStart = source.lastIndexOf('\n\n', split) + 2;
  const paragraphEnd = source.indexOf('\n\n', split);
  if (paragraphStart <= 1 || paragraphEnd < 0 || paragraphStart > split) {
    throw new Error('could not bound the math-surface paragraph in ADR-0001');
  }

  // Identifiers only: the paragraph also backticks `Math.*`, `@aegis/core/math` and a test path.
  // De-duplicated, because a name may legitimately be mentioned twice in explanatory prose.
  const names = (text: string): string[] => [
    ...new Set(
      [...text.matchAll(/`([^`]+)`/g)]
        .map((m) => m[1] as string)
        .filter((name) => /^[a-z][A-Za-z0-9]*$/.test(name)),
    ),
  ];

  return {
    provides: names(source.slice(paragraphStart, split)),
    missing: names(source.slice(split, paragraphEnd)),
  };
}

const banned = bannedMathProps();
const adr = adrLists();
const exported = new Set(
  Object.entries(core)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name),
);

describe('ADR-0001 math surface', () => {
  it('found a banned list worth checking', () => {
    // Anti-vacuity. Every assertion below is trivially satisfiable by an empty parse.
    expect(banned.length).toBeGreaterThanOrEqual(20);
    expect(banned).toContain('sin');
    expect(banned).toContain(NOT_A_MATH_GAP);
  });

  it('found both ADR lists worth checking', () => {
    expect(adr.provides.length).toBeGreaterThanOrEqual(15);
    expect(adr.missing.length).toBeGreaterThanOrEqual(5);
    expect(adr.provides).toContain('sin');
  });

  it('read a real module rather than an empty namespace', () => {
    expect(exported.size).toBeGreaterThan(20);
    expect(exported.has('sin')).toBe(true);
  });

  it('everything the ADR says core provides is exported by core', () => {
    expect(adr.provides.filter((name) => !exported.has(name))).toEqual([]);
  });

  it('the gap list is exactly the banned members core does not replace', () => {
    const gaps = banned
      .filter((name) => name !== NOT_A_MATH_GAP)
      .filter((name) => !exported.has(name));
    expect([...adr.missing].sort()).toEqual([...gaps].sort());
  });

  it('the PRNG carve-out stays true: core does not export a `random`', () => {
    expect(exported.has(NOT_A_MATH_GAP)).toBe(false);
  });

  it('atan specifically — banned, not provided, and therefore listed as a gap', () => {
    // The finding this file exists for. Kept as a named case so the reason survives the list.
    expect(banned).toContain('atan');
    expect(exported.has('atan')).toBe(false);
    expect(exported.has('atan2')).toBe(true);
    expect(adr.missing).toContain('atan');
  });
});

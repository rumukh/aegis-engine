/**
 * Guards the two synchronisation points that make a scripted click land on the cell it names.
 *
 * ## What went wrong
 *
 * `aegis.project(x, 0, z)` answers "where is that world cell on screen?", and the capture run
 * clicks the pixel it returns. Two things feed that answer, and both used to be whatever the
 * browser last happened to produce:
 *
 * 1. the **mirror** world, refreshed by an exchange driven from `requestAnimationFrame`; and
 * 2. the **camera**, which `iso` re-aims at the player inside `adapter.sync(mirror)` — also once
 *    per animation frame, and strictly *after* the snapshot that moved the player landed.
 *
 * Starve animation frames and the projection is answered from a camera aimed at an older world.
 * Measured under saturating CPU load (16 busy processes on 16 logical CPUs), **7 of 14 scripted
 * clicks projected to a different pixel before synchronising than after** — up to 191px in x and
 * 110px in y, which on the isometric grid is several cells. The operative then walked somewhere
 * nobody asked for and the run ended `NOT WON` at its 960-tick ceiling.
 *
 * ## Why both lines are here
 *
 * They were attributed separately, by comparing projected pixels rather than pass/fail:
 *
 * - With the camera sync but no `syncInput`, the projection is aimed at a mirror one exchange old.
 * - With `syncInput` but no camera sync, the "fresh" pixels came back **byte-identical to the
 *   stale ones** — the mirror had advanced and the camera had not.
 *
 * Neither line is redundant. The outcome-level symptom was intermittent (2 failures in 4 loaded
 * runs, 0 in 3 idle ones), which is exactly why it is guarded here by the mechanism instead: a
 * flaky red proves nothing on the run where it happens to pass.
 *
 * ## What this test does and does not prove
 *
 * It is a **source-order guard**, not a behavioural one: `boot.ts` only runs against a real canvas
 * and WebGL context, which this suite has no way to provide. So it proves the ordering is still
 * written, not that a browser honours it. The behavioural check is the capture gate itself
 * (`npm run capture`), which drives a real browser and is the instrument that found this.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** Read a sibling source file with line endings normalised, so CRLF checkouts read the same. */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The body of a `{`-delimited block starting at `header`, by brace balance.
 *
 * Asserting on the whole file would let a match anywhere satisfy an ordering that only matters
 * inside one function — the same mistake as a regex matching inside a comment.
 */
function block(text: string, header: string): string {
  const start = text.indexOf(header);
  expect(start, `block header not found: ${header}`).toBeGreaterThanOrEqual(0);
  expect(
    text.indexOf(header, start + 1),
    `block header is not unique, so the guard cannot say which one it read: ${header}`,
  ).toBe(-1);

  let depth = 0;
  for (let i = start + header.length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

describe('a scripted click is projected against a synchronised world', () => {
  const boot = source('./client/boot.ts');
  const capture = source('./capture.ts');

  it('reads the two files it claims to guard', () => {
    // Anti-vacuity: an empty or truncated read would satisfy every "contains" check below by
    // vacuity, and a guard that passes on nothing is the failure mode this project keeps meeting.
    expect(boot.length).toBeGreaterThan(4_000);
    expect(capture.length).toBeGreaterThan(10_000);
    expect(boot).toContain('adapter.camera');
    expect(capture).toContain('aegis.project(');
  });

  it('aims the camera at the current mirror before projecting', () => {
    const body = block(
      boot,
      'project(x: number, y: number, z: number): { x: number; y: number } | null {',
    );
    const sync = body.indexOf('adapter.sync(mirror)');
    const project = body.indexOf('.project(adapter.camera)');

    expect(
      sync,
      'project() no longer re-syncs the adapter; the camera can be a frame stale',
    ).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThanOrEqual(0);
    expect(
      sync,
      'the adapter must be synced before the camera is measured, not after',
    ).toBeLessThan(project);
  });

  it('settles an exchange before asking where a cell is on screen', () => {
    const body = block(capture, 'if (segment.click !== undefined) {');
    const settle = body.indexOf('await syncInput(cdp)');
    const project = body.indexOf('aegis.project(');

    expect(
      settle,
      'the click branch no longer settles an exchange before projecting',
    ).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThanOrEqual(0);
    expect(settle, 'the mirror must be current before it is projected from').toBeLessThan(project);
  });
});

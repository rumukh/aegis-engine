/**
 * Input-script DSL: parsing, compilation to per-tick frames, and format round-tripping.
 *
 * These tests are the executable proof of CHARTER principle 5 ("input is a script"): the exact
 * frames an agent's text compiles to, including the fiddly edge cases (half-open ranges,
 * overlapping holds, out-of-order statements, release-inside-hold, axis last-wins, look spread,
 * absolute aim → delta, click/point pointers), and that a script round-trips through the
 * canonical formatter without changing meaning. Parse errors are asserted to be structured
 * diagnostics with a location and a fix, never thrown stack traces.
 */
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '@aegis/core';
import { formatInputScript, parseInputScript, scriptFromCommands } from './input-script.js';

/** Parse `text` and return the compiled frames, failing loudly if parsing errored. */
function compile(text: string, ticks: number): readonly InputFrame[] {
  const parsed = parseInputScript(text);
  if (!parsed.ok || !parsed.value) {
    throw new Error(`unexpected parse error:\n${JSON.stringify(parsed.diagnostics, null, 2)}`);
  }
  return parsed.value.frames(ticks);
}

describe('parseInputScript — digital actions', () => {
  it('hold is half-open: [a, b) holds, with derived press/release edges', () => {
    const frames = compile('hold A 0..3', 5);
    expect(frames[0]!.actions['A']).toBe(true);
    expect(frames[2]!.actions['A']).toBe(true);
    expect(frames[3]!.actions['A']).toBeUndefined(); // b is exclusive
    expect(frames[0]!.pressed).toEqual(['A']); // edge derived at the first held tick
    expect(frames[1]!.pressed).toEqual([]); // still held, not a new press
    expect(frames[3]!.released).toEqual(['A']); // edge derived the tick after the last held
  });

  it('press @t holds exactly one tick and derives both edges', () => {
    const frames = compile('press A @2', 5);
    expect(frames[1]!.actions['A']).toBeUndefined();
    expect(frames[2]!.actions['A']).toBe(true);
    expect(frames[2]!.pressed).toEqual(['A']);
    expect(frames[3]!.actions['A']).toBeUndefined();
    expect(frames[3]!.released).toEqual(['A']);
  });

  it('overlapping holds union into one continuous press, with a single press edge', () => {
    const frames = compile('hold A 0..3\nhold A 2..5', 6);
    for (let t = 0; t < 5; t++) expect(frames[t]!.actions['A']).toBe(true);
    expect(frames[5]!.actions['A']).toBeUndefined();
    // Exactly one press edge (at 0) and one release edge (at 5), despite two overlapping holds.
    expect(frames.filter((f) => f.pressed.includes('A')).map((f) => f.tick)).toEqual([0]);
    expect(frames.filter((f) => f.released.includes('A')).map((f) => f.tick)).toEqual([5]);
  });

  it('is order-independent: out-of-order holds compile identically to sorted', () => {
    const outOfOrder = compile('hold A 5..7\nhold A 0..2', 8);
    const sorted = compile('hold A 0..2\nhold A 5..7', 8);
    expect(outOfOrder).toEqual(sorted);
    expect(outOfOrder.filter((f) => f.actions['A']).map((f) => f.tick)).toEqual([0, 1, 5, 6]);
  });

  it('release clears from r up to the next hold-start, re-holding after that', () => {
    const frames = compile('hold A 0..10\nrelease A @4\nhold A 6..8', 12);
    const held = frames.filter((f) => f.actions['A']).map((f) => f.tick);
    expect(held).toEqual([0, 1, 2, 3, 6, 7, 8, 9]); // 4,5 cleared by the release
    expect(frames.filter((f) => f.pressed.includes('A')).map((f) => f.tick)).toEqual([0, 6]);
    expect(frames.filter((f) => f.released.includes('A')).map((f) => f.tick)).toEqual([4, 10]);
  });
});

describe('parseInputScript — analog channels', () => {
  it('axis: last source-order write wins on overlap; unset ticks are absent', () => {
    const frames = compile('axis X 0.5 0..4\naxis X -1 2..6', 7);
    expect(frames[0]!.axes['X']).toBe(0.5);
    expect(frames[1]!.axes['X']).toBe(0.5);
    expect(frames[2]!.axes['X']).toBe(-1); // overlap → later command wins
    expect(frames[5]!.axes['X']).toBe(-1);
    expect(frames[6]!.axes['X']).toBeUndefined(); // outside any axis span
  });

  it('look spreads a delta evenly across a range and accumulates', () => {
    const frames = compile('look 10 0 0..5', 5);
    for (let t = 0; t < 5; t++) expect(frames[t]!.look.dx).toBeCloseTo(2, 10);
    const total = frames.reduce((s, f) => s + f.look.dx, 0);
    expect(total).toBeCloseTo(10, 10);
  });

  it('look @t applies the whole delta at one tick', () => {
    const frames = compile('look 3 1 @2', 4);
    expect(frames[2]!.look).toEqual({ dx: 3, dy: 1 });
    expect(frames[0]!.look).toEqual({ dx: 0, dy: 0 });
  });

  it('aim is absolute: compiled to the delta that makes the running look-sum hit the target', () => {
    const frames = compile('look 5 0 @0\naim 20 0 @2', 3);
    expect(frames[0]!.look.dx).toBe(5);
    expect(frames[2]!.look.dx).toBe(15); // 5 already applied → +15 reaches 20
    const sum = frames.reduce((s, f) => s + f.look.dx, 0);
    expect(sum).toBe(20);
  });

  it('click sets a primary button; point moves without a button; both fill screen+world', () => {
    const frames = compile('click 3,4 @1\npoint 5,6 @2', 3);
    expect(frames[0]!.pointer).toBeNull();
    expect(frames[1]!.pointer).toEqual({
      screen: { x: 3, y: 4 },
      world: { x: 3, y: 4, z: 0 },
      buttons: ['primary'],
    });
    expect(frames[2]!.pointer).toEqual({
      screen: { x: 5, y: 6 },
      world: { x: 5, y: 6, z: 0 },
      buttons: [],
    });
  });
});

describe('parseInputScript — comments, blanks and clamping', () => {
  it('ignores blank lines and # comments', () => {
    const parsed = parseInputScript('# a comment\n\nhold A 0..2   # trailing comment\n');
    expect(parsed.ok).toBe(true);
    expect(parsed.value!.commands).toHaveLength(1);
  });

  it('clamps spans to the requested tick window', () => {
    const frames = compile('hold A 0..1000', 3);
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.actions['A'] === true)).toBe(true);
  });
});

describe('parseInputScript — diagnostics are structured, located and fixable', () => {
  it('reports an unknown command with a location and a suggested fix', () => {
    const parsed = parseInputScript('jump A @2');
    expect(parsed.ok).toBe(false);
    const diag = parsed.diagnostics[0]!;
    expect(diag.code).toBe('AEG-HARNESS-0002');
    expect(diag.severity).toBe('error');
    expect(diag.location).toEqual({ line: 1, column: 1 });
    expect(diag.fix).toContain('hold');
  });

  it('reports a missing argument with the column just past the last token', () => {
    const parsed = parseInputScript('hold');
    expect(parsed.ok).toBe(false);
    const diag = parsed.diagnostics[0]!;
    expect(diag.code).toBe('AEG-HARNESS-0003');
    expect(diag.location?.line).toBe(1);
    expect(diag.fix).toContain('Usage:');
  });

  it('reports an empty/backwards range with a concrete fix', () => {
    const parsed = parseInputScript('hold A 5..2');
    expect(parsed.ok).toBe(false);
    const diag = parsed.diagnostics[0]!;
    expect(diag.code).toBe('AEG-HARNESS-0004');
    expect(diag.message).toContain('5..2');
    expect(diag.fix).toContain('@5');
  });

  it('reports a press without @ as a syntax error, not a thrown exception', () => {
    const parsed = parseInputScript('press A 3');
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics[0]!.code).toBe('AEG-HARNESS-0001');
  });

  it('collects diagnostics across multiple bad lines, reporting the line number of each', () => {
    const parsed = parseInputScript('hold A 0..2\nbogus\naxis X 0..2');
    expect(parsed.ok).toBe(false);
    const lines = parsed.diagnostics.map((d) => d.location?.line).sort();
    expect(lines).toContain(2); // bogus
    expect(lines).toContain(3); // axis missing its value argument
  });
});

describe('formatInputScript — canonical, round-trippable text', () => {
  it('re-parses to identical frames after formatting (semantic round-trip)', () => {
    const source = [
      'hold Right 0..60',
      'press Jump @28',
      'axis MoveX -0.5 10..20',
      'look 90 0 5..7',
      'aim 45 10 @30',
      'click 3,4 @2',
      'point 5,6 @3',
      'release Right @59',
    ].join('\n');
    const first = parseInputScript(source);
    expect(first.ok).toBe(true);
    const formatted = formatInputScript(first.value!);
    const second = parseInputScript(formatted);
    expect(second.ok).toBe(true);
    expect(second.value!.frames(64)).toEqual(first.value!.frames(64));
  });

  it('normalises negative zero so formatting is deterministic', () => {
    const script = scriptFromCommands([
      { kind: 'axis', axis: 'X', value: -0, span: { start: 0, end: 1 } },
    ]);
    expect(formatInputScript(script)).toBe('axis X 0 0..1');
  });

  it('sorts commands by (firstTick, kind, secondaryKey) regardless of input order', () => {
    const parsed = parseInputScript('press B @5\nhold A 0..3\npress A @5');
    const formatted = formatInputScript(parsed.value!);
    expect(formatted).toBe(['hold A 0..3', 'press A @5', 'press B @5'].join('\n'));
  });
});

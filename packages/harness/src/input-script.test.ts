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

  it('preserves source order, because the compiler reads it', () => {
    // Sorting these three is harmless, but sorting is not *generally* safe (see below), so the
    // formatter does not sort at all: what it emits is exactly what was authored.
    const parsed = parseInputScript('press B @5\nhold A 0..3\npress A @5');
    expect(formatInputScript(parsed.value!)).toBe(
      ['press B @5', 'hold A 0..3', 'press A @5'].join('\n'),
    );
  });
});

/**
 * The regression suite for the recorder-corrupts-the-script defect.
 *
 * `formatInputScript` used to re-sort commands by `(firstTick, kind, secondaryKey)` while the
 * compiler resolves overlapping `axis`/`pointer` writes as *last source-order wins* and sums
 * `look` deltas in source order. So the canonical text of a script was not the script:
 * `SimResult.recording()` serialised through the formatter, and replaying that recording failed
 * the determinism check — blaming a perfectly deterministic engine and pointing an agent at
 * `Math.random` in innocent mode code.
 *
 * The old round-trip test could not catch any of this: every command in it had a distinct first
 * tick, so the sort was a no-op. These cases all have overlapping or tie-breaking commands, and
 * each of them fails on the pre-fix formatter.
 */
describe('formatInputScript — round-trip preserves compiled frames (regression)', () => {
  /** `parse → format → parse` must compile to byte-identical frames. */
  function expectStableRoundTrip(source: string, ticks: number): void {
    const first = parseInputScript(source);
    expect(first.ok, `parse failed: ${JSON.stringify(first.diagnostics)}`).toBe(true);
    const formatted = formatInputScript(first.value!);
    const second = parseInputScript(formatted);
    expect(second.ok).toBe(true);
    expect(second.value!.frames(ticks)).toEqual(first.value!.frames(ticks));
    // And it is a fixed point: formatting the re-parsed script yields the same text.
    expect(formatInputScript(second.value!)).toBe(formatted);
  }

  it('overlapping axis spans: the later write must still win after formatting', () => {
    // The harness-level proof from the audit: ticks 5..7 compile to Move = 1, and used to
    // compile to Move = -1 after a format round-trip because `-1` starts later and sorted first.
    const source = 'axis Move -1 5..8\naxis Move 1 0..10';
    const frames = compile(source, 10);
    expect(frames[5]!.axes['Move']).toBe(1);
    expectStableRoundTrip(source, 10);
  });

  it('same-tick pointer clicks: the later click must still win after formatting', () => {
    // The end-to-end case: `aegis record` reordered these two and `aegis replay` then reported
    // AEG-CLI-0007 "determinism check FAILED" against a deterministic engine.
    const source = 'click 9,1 @2\nclick 1,5 @2';
    expect(compile(source, 4)[2]!.pointer!.world).toEqual({ x: 1, y: 5, z: 0 });
    expectStableRoundTrip(source, 4);
  });

  it('same-tick aims: the later absolute target must still win after formatting', () => {
    const source = 'aim 90 0 @1\naim 10 0 @1';
    expect(compile(source, 3)[1]!.look.dx).toBe(10);
    expectStableRoundTrip(source, 3);
  });

  it('three overlapping look deltas keep their summation order', () => {
    // Floating-point addition is commutative but not associative: 2^53 + 1 + 1 === 2^53, while
    // 1 + 1 + 2^53 === 2^53 + 2. The pre-fix formatter tie-broke same-tick commands on their
    // `(dyaw,dpitch)` string key, reordering these three and changing the compiled frame. This
    // is why the formatter preserves source order outright instead of "sorting when it looks
    // safe" — the safe cases are not obvious enough to hand-check.
    const source = 'look 9007199254740992 0 @0\nlook 1 0 @0\nlook 1 0 @0';
    expect(compile(source, 1)[0]!.look.dx).toBe(9007199254740992);
    expectStableRoundTrip(source, 1);
  });

  it('reversed source order round-trips to itself, not to a re-sorted script', () => {
    const source = [
      'press Fire @40',
      'axis MoveX 1 20..60',
      'hold Right 0..60',
      'click 2,2 @1',
    ].join('\n');
    expect(formatInputScript(parseInputScript(source).value!)).toBe(source);
    expectStableRoundTrip(source, 60);
  });

  it('warns that an order-sensitive script is not safe to re-order', () => {
    const parsed = parseInputScript(
      'axis Move -1 5..8\naxis Move 1 0..10\nclick 9,1 @2\nclick 1,5 @2',
    );
    expect(parsed.ok).toBe(true); // legal, just fragile
    const codes = parsed.diagnostics.map((d) => d.code);
    expect(codes).toContain('AEG-HARNESS-0012');
    expect(parsed.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    const axisWarning = parsed.diagnostics.find((d) => d.message.includes('axis Move'))!;
    expect(axisWarning.message).toContain('Swapping the two lines');
    expect(axisWarning.location?.line).toBe(2);
  });

  it('does not warn when overlapping axis writes agree, or when spans are disjoint', () => {
    expect(parseInputScript('axis Move 1 0..10\naxis Move 1 5..8').diagnostics).toEqual([]);
    expect(parseInputScript('axis F 1 40..124\naxis F 1 124..170').diagnostics).toEqual([]);
    expect(parseInputScript('hold A 5..7\nhold A 0..2\npress A @9').diagnostics).toEqual([]);
  });
});

/**
 * F4: statements outside `[0, ticks)` are silently swallowed by the compiler's clamping, so a
 * 60-tick run with `press Jump @500` hashes byte-identically to a run with no input at all.
 * `check(totalTicks)` is the channel that makes that visible.
 */
describe('InputScript.check — statements the tick window swallowed', () => {
  it('reports a statement that lies entirely outside the window as an error', () => {
    const script = parseInputScript('press Jump @500\nhold Right 200..300').value!;
    const diags = script.check(60);
    expect(diags).toHaveLength(2);
    // Nothing in this script applied, so the run is identical to one with no input: an error.
    expect(diags.every((d) => d.severity === 'error')).toBe(true);
    expect(diags[0]!.code).toBe('AEG-HARNESS-0009');
    expect(diags[0]!.message).toContain('"press Jump @500"');
    expect(diags[0]!.message).toContain('[0, 60)');
    expect(diags[0]!.fix).toContain('501');
    expect(diags[0]!.location?.line).toBe(1);
    expect(diags[1]!.message).toContain('"hold Right 200..300"');
  });

  it('downgrades to a warning when the rest of the script did apply', () => {
    // Running a prefix of a playthrough is a first-class workflow (`aegis inspect --tick 90` on a
    // 400-tick script), so a later statement falling outside the window must not abort it.
    const diags = parseInputScript('hold Right 0..30\npress Jump @500').value!.check(60);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('AEG-HARNESS-0009');
    expect(diags[0]!.severity).toBe('warning');
  });

  it('never errors on a 0-tick window, where no statement can apply by definition', () => {
    const diags = parseInputScript('press Jump @5').value!.check(0);
    expect(diags.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('reports a clipped span as a warning naming the ticks that never ran', () => {
    const diags = parseInputScript('hold A 0..1000').value!.check(3);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('AEG-HARNESS-0010');
    expect(diags[0]!.severity).toBe('warning');
    expect(diags[0]!.message).toContain('clipped to ticks 0..3');
    expect(diags[0]!.message).toContain('3..1000');
  });

  it('reports the fraction of a clipped look delta that was actually applied', () => {
    // `look 90 0 50..70` on a 60-tick run turns 45° and used to say nothing at all.
    const diags = parseInputScript('look 90 0 50..70').value!.check(60);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('AEG-HARNESS-0011');
    expect(diags[0]!.severity).toBe('warning');
    expect(diags[0]!.message).toContain('45° of 90° yaw');
  });

  it('is silent for a script that fits its window', () => {
    const script = parseInputScript('hold Right 0..60\npress Fire @1\nclick 2,3 @59').value!;
    expect(script.check(60)).toEqual([]);
  });
});

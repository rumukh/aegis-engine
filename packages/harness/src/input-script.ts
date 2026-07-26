/**
 * The input-scripting format (CHARTER principle 5): "input is a script".
 *
 * An agent authors input as text, in a small line-oriented DSL, and the harness compiles it
 * to a deterministic sequence of {@link InputFrame}s — one per tick. The same text round-trips
 * from a recording, so a recorded session *is* a readable script. Ticks are addressed
 * absolutely so a script diffs cleanly and reorders safely.
 *
 * ## Grammar
 * ```text
 * # comments start with '#'
 * hold   <Action> <a>..<b>          # hold a digital action across tick range [a, b)
 * press  <Action> @<t>              # activate for exactly tick t (edge press)
 * release <Action> @<t>             # deactivate at tick t
 * axis   <Name> <value> <a>..<b>    # set analog axis (e.g. -1..1) across [a, b)
 * look   <dyaw> <dpitch> @<t>       # relative mouse-look delta (degrees) at tick t   [fps]
 * look   <dyaw> <dpitch> <a>..<b>   # spread the delta evenly across [a, b)           [fps]
 * aim    <yaw> <pitch> @<t>         # absolute look target; compiled to look deltas   [fps]
 * click  <x>,<y> @<t>               # primary pointer click at world/grid (x, y)      [iso]
 * point  <x>,<y> @<t>               # pointer move without a click                    [iso]
 * ```
 * Ranges `a..b` are half-open (include `a`, exclude `b`). `@t` is the single tick `t`.
 * Example (platformer): `hold Right 0..90` then `press Jump @30`.
 *
 * ## Compilation model
 * Digital actions are compiled through a single per-action **held** timeline: `hold`/`press`
 * set it true across their span, and `release @r` clears it from `r` up to the next hold-start
 * strictly after `r`. The edge sets are then *derived* by diffing the held timeline between
 * consecutive ticks (`held[-1] = false`), so a `hold`'s first tick is a `pressed` and the tick
 * after its last is a `released`, and overlapping holds simply union. Axes and pointers are
 * "last source-order write wins" on overlap; `look` deltas accumulate; `aim` is absolute and
 * is converted to the delta that makes the running look-sum equal the target at that tick.
 * @packageDocumentation
 */
import type { Diagnostic, InputFrame, PointerInput, Validated } from '@aegis/core';
import { diagnostic, HarnessCode } from './diagnostics.js';

/** Inclusive-start, exclusive-end tick span. `@t` parses to `{ start: t, end: t + 1 }`. */
export interface TickSpan {
  start: number;
  end: number;
}

/** Hold a digital action across a span. */
export interface HoldCommand {
  kind: 'hold';
  action: string;
  span: TickSpan;
}

/** Edge-press a digital action for one tick. */
export interface PressCommand {
  kind: 'press';
  action: string;
  tick: number;
}

/** Release a digital action at a tick. */
export interface ReleaseCommand {
  kind: 'release';
  action: string;
  tick: number;
}

/** Set an analog axis to a value across a span. */
export interface AxisCommand {
  kind: 'axis';
  axis: string;
  value: number;
  span: TickSpan;
}

/** Apply a relative look delta (degrees), at a tick or spread across a span. */
export interface LookCommand {
  kind: 'look';
  dyaw: number;
  dpitch: number;
  span: TickSpan;
}

/** Aim at an absolute yaw/pitch; the compiler converts to look deltas. */
export interface AimCommand {
  kind: 'aim';
  yaw: number;
  pitch: number;
  tick: number;
}

/** Move the pointer, optionally clicking, at a tick. */
export interface PointerCommand {
  kind: 'pointer';
  x: number;
  y: number;
  click: boolean;
  tick: number;
}

/** One parsed command in an input script. */
export type InputCommand =
  | HoldCommand
  | PressCommand
  | ReleaseCommand
  | AxisCommand
  | LookCommand
  | AimCommand
  | PointerCommand;

/** A parsed, validated input script: its command AST plus a compiler to per-tick frames. */
export interface InputScript {
  /** The parsed commands, in source order. */
  readonly commands: readonly InputCommand[];
  /**
   * Compile to exactly `totalTicks` frames. Edge sets (`pressed`/`released`) are derived by
   * diffing the held-action set between consecutive ticks, so a `hold` implies a `pressed`
   * on its first tick and a `released` on the tick after its last.
   */
  frames(totalTicks: number): readonly InputFrame[];
}

// --- parsing -------------------------------------------------------------------------------

interface Token {
  text: string;
  /** 1-based column of the token's first character. */
  column: number;
}

/** Split a line into whitespace-delimited tokens, tracking each token's 1-based column. */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push({ text: m[0], column: m.index + 1 });
  }
  return tokens;
}

function loc(line: number, column: number): { line: number; column: number } {
  return { line, column };
}

/** Parse an integer tick `>= 0`. */
function parseTick(token: Token, line: number, diags: Diagnostic[]): number | undefined {
  const n = Number(token.text);
  if (token.text.trim() === '' || !Number.isInteger(n) || n < 0) {
    diags.push(
      diagnostic(HarnessCode.InvalidTick, `"${token.text}" is not a valid tick.`, {
        location: loc(line, token.column),
        fix: 'Ticks are non-negative integers, e.g. 0, 30, 120.',
      }),
    );
    return undefined;
  }
  return n;
}

/** Parse a finite number (integer or float, signed). */
function parseNum(token: Token, line: number, diags: Diagnostic[]): number | undefined {
  const n = Number(token.text);
  if (token.text.trim() === '' || !Number.isFinite(n)) {
    diags.push(
      diagnostic(HarnessCode.InvalidNumber, `"${token.text}" is not a number.`, {
        location: loc(line, token.column),
        fix: 'Use a decimal number, e.g. -1, 0.5, 90.',
      }),
    );
    return undefined;
  }
  return n;
}

/** Parse `@t` into a single tick. */
function parseAt(token: Token, line: number, diags: Diagnostic[]): number | undefined {
  if (!token.text.startsWith('@')) {
    diags.push(
      diagnostic(HarnessCode.InvalidSyntax, `Expected "@<tick>" but found "${token.text}".`, {
        location: loc(line, token.column),
        fix: 'Address a single tick with "@", e.g. @30.',
      }),
    );
    return undefined;
  }
  return parseTick({ text: token.text.slice(1), column: token.column + 1 }, line, diags);
}

/** Parse either `a..b` (half-open) or `@t` into a {@link TickSpan}. */
function parseSpan(token: Token, line: number, diags: Diagnostic[]): TickSpan | undefined {
  if (token.text.startsWith('@')) {
    const t = parseAt(token, line, diags);
    return t === undefined ? undefined : { start: t, end: t + 1 };
  }
  const dots = token.text.indexOf('..');
  if (dots < 0) {
    diags.push(
      diagnostic(
        HarnessCode.InvalidRange,
        `Expected a tick range "a..b" or "@t" but found "${token.text}".`,
        {
          location: loc(line, token.column),
          fix: 'Ranges are half-open, e.g. 0..90 covers ticks 0 through 89.',
        },
      ),
    );
    return undefined;
  }
  const startTok = { text: token.text.slice(0, dots), column: token.column };
  const endTok = { text: token.text.slice(dots + 2), column: token.column + dots + 2 };
  const start = parseTick(startTok, line, diags);
  const end = parseTick(endTok, line, diags);
  if (start === undefined || end === undefined) return undefined;
  if (end <= start) {
    diags.push(
      diagnostic(
        HarnessCode.InvalidRange,
        `Empty tick range ${start}..${end}: the end must be greater than the start.`,
        {
          location: loc(line, token.column),
          fix: `Ranges are half-open; use ${start}..${start + 1} for a single tick, or "@${start}".`,
        },
      ),
    );
    return undefined;
  }
  return { start, end };
}

/** Parse an `x,y` pointer coordinate pair. */
function parsePoint(
  token: Token,
  line: number,
  diags: Diagnostic[],
): { x: number; y: number } | undefined {
  const comma = token.text.indexOf(',');
  if (comma < 0) {
    diags.push(
      diagnostic(HarnessCode.InvalidPointer, `Expected "x,y" but found "${token.text}".`, {
        location: loc(line, token.column),
        fix: 'Give the pointer target as two comma-separated numbers, e.g. 4,2.',
      }),
    );
    return undefined;
  }
  const x = parseNum({ text: token.text.slice(0, comma), column: token.column }, line, diags);
  const y = parseNum(
    { text: token.text.slice(comma + 1), column: token.column + comma + 1 },
    line,
    diags,
  );
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

/** Require exactly `count` argument tokens after the verb; report missing/extra. */
function checkArity(
  tokens: Token[],
  count: number,
  verb: string,
  line: number,
  usage: string,
  diags: Diagnostic[],
): boolean {
  const args = tokens.length - 1;
  if (args < count) {
    const at = tokens[tokens.length - 1] ?? tokens[0]!;
    diags.push(
      diagnostic(
        HarnessCode.MissingArgument,
        `"${verb}" needs ${count} argument${count === 1 ? '' : 's'} but got ${args}.`,
        { location: loc(line, at.column + at.text.length), fix: `Usage: ${usage}` },
      ),
    );
    return false;
  }
  if (args > count) {
    const extra = tokens[count + 1]!;
    diags.push(
      diagnostic(
        HarnessCode.UnexpectedArgument,
        `"${verb}" takes ${count} arguments; "${extra.text}" is extra.`,
        { location: loc(line, extra.column), fix: `Usage: ${usage}` },
      ),
    );
    return false;
  }
  return true;
}

/** Parse input-script `text` into an {@link InputScript}, reporting syntax errors as diagnostics. */
export function parseInputScript(text: string): Validated<InputScript> {
  const diags: Diagnostic[] = [];
  const commands: InputCommand[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const hash = raw.indexOf('#');
    const content = hash >= 0 ? raw.slice(0, hash) : raw;
    if (content.trim() === '') return;
    const tokens = tokenize(content);
    const verbTok = tokens[0]!;
    const verb = verbTok.text.toLowerCase();

    switch (verb) {
      case 'hold': {
        if (!checkArity(tokens, 2, 'hold', lineNo, 'hold <Action> <a>..<b>', diags)) return;
        const span = parseSpan(tokens[2]!, lineNo, diags);
        if (span) commands.push({ kind: 'hold', action: tokens[1]!.text, span });
        return;
      }
      case 'press': {
        if (!checkArity(tokens, 2, 'press', lineNo, 'press <Action> @<t>', diags)) return;
        const t = parseAt(tokens[2]!, lineNo, diags);
        if (t !== undefined) commands.push({ kind: 'press', action: tokens[1]!.text, tick: t });
        return;
      }
      case 'release': {
        if (!checkArity(tokens, 2, 'release', lineNo, 'release <Action> @<t>', diags)) return;
        const t = parseAt(tokens[2]!, lineNo, diags);
        if (t !== undefined) commands.push({ kind: 'release', action: tokens[1]!.text, tick: t });
        return;
      }
      case 'axis': {
        if (!checkArity(tokens, 3, 'axis', lineNo, 'axis <Name> <value> <a>..<b>', diags)) return;
        const value = parseNum(tokens[2]!, lineNo, diags);
        const span = parseSpan(tokens[3]!, lineNo, diags);
        if (value !== undefined && span) {
          commands.push({ kind: 'axis', axis: tokens[1]!.text, value, span });
        }
        return;
      }
      case 'look': {
        if (!checkArity(tokens, 3, 'look', lineNo, 'look <dyaw> <dpitch> <a>..<b>|@<t>', diags)) {
          return;
        }
        const dyaw = parseNum(tokens[1]!, lineNo, diags);
        const dpitch = parseNum(tokens[2]!, lineNo, diags);
        const span = parseSpan(tokens[3]!, lineNo, diags);
        if (dyaw !== undefined && dpitch !== undefined && span) {
          commands.push({ kind: 'look', dyaw, dpitch, span });
        }
        return;
      }
      case 'aim': {
        if (!checkArity(tokens, 3, 'aim', lineNo, 'aim <yaw> <pitch> @<t>', diags)) return;
        const yaw = parseNum(tokens[1]!, lineNo, diags);
        const pitch = parseNum(tokens[2]!, lineNo, diags);
        const t = parseAt(tokens[3]!, lineNo, diags);
        if (yaw !== undefined && pitch !== undefined && t !== undefined) {
          commands.push({ kind: 'aim', yaw, pitch, tick: t });
        }
        return;
      }
      case 'click':
      case 'point': {
        if (!checkArity(tokens, 2, verb, lineNo, `${verb} <x>,<y> @<t>`, diags)) return;
        const pt = parsePoint(tokens[1]!, lineNo, diags);
        const t = parseAt(tokens[2]!, lineNo, diags);
        if (pt && t !== undefined) {
          commands.push({ kind: 'pointer', x: pt.x, y: pt.y, click: verb === 'click', tick: t });
        }
        return;
      }
      default:
        diags.push(
          diagnostic(HarnessCode.UnknownCommand, `Unknown command "${verbTok.text}".`, {
            location: loc(lineNo, verbTok.column),
            fix: 'Expected one of: hold, press, release, axis, look, aim, click, point.',
          }),
        );
    }
  });

  const hasError = diags.some((d) => d.severity === 'error');
  if (hasError) return { ok: false, diagnostics: diags };
  return { ok: true, value: scriptFromCommands(commands), diagnostics: diags };
}

// --- compilation ---------------------------------------------------------------------------

/** Clamp `[a, b)` to `[0, n)` and invoke `fn` for each tick in the intersection. */
function forEachTick(a: number, b: number, n: number, fn: (t: number) => void): void {
  const lo = a < 0 ? 0 : a;
  const hi = b > n ? n : b;
  for (let t = lo; t < hi; t++) fn(t);
}

function compileFrames(
  commands: readonly InputCommand[],
  totalTicks: number,
): readonly InputFrame[] {
  const n = totalTicks < 0 ? 0 : totalTicks;

  // Digital actions: build a per-action held timeline, then derive edges by diffing.
  const held = new Map<string, boolean[]>();
  const heldOf = (name: string): boolean[] => {
    let arr = held.get(name);
    if (!arr) {
      arr = new Array<boolean>(n).fill(false);
      held.set(name, arr);
    }
    return arr;
  };
  // Hold-start boundaries per action, used to bound the effect of a release.
  const starts = new Map<string, number[]>();
  const addStart = (name: string, t: number): void => {
    const list = starts.get(name) ?? [];
    list.push(t);
    starts.set(name, list);
  };

  for (const cmd of commands) {
    if (cmd.kind === 'hold') {
      const arr = heldOf(cmd.action);
      forEachTick(cmd.span.start, cmd.span.end, n, (t) => (arr[t] = true));
      addStart(cmd.action, cmd.span.start);
    } else if (cmd.kind === 'press') {
      const arr = heldOf(cmd.action);
      forEachTick(cmd.tick, cmd.tick + 1, n, (t) => (arr[t] = true));
      addStart(cmd.action, cmd.tick);
    }
  }
  // Apply releases after holds/presses: clear [r, nextStart) where nextStart is the first
  // hold-start strictly after r for that action (or n when there is none).
  for (const cmd of commands) {
    if (cmd.kind !== 'release') continue;
    const arr = heldOf(cmd.action);
    const startList = starts.get(cmd.action) ?? [];
    let boundary = n;
    for (const s of startList) {
      if (s > cmd.tick && s < boundary) boundary = s;
    }
    forEachTick(cmd.tick, boundary, n, (t) => (arr[t] = false));
  }

  // Axes: last source-order write wins on overlap. `undefined` means "not set this tick".
  const axes = new Map<string, (number | undefined)[]>();
  const axisOf = (name: string): (number | undefined)[] => {
    let arr = axes.get(name);
    if (!arr) {
      arr = new Array<number | undefined>(n).fill(undefined);
      axes.set(name, arr);
    }
    return arr;
  };
  for (const cmd of commands) {
    if (cmd.kind !== 'axis') continue;
    const arr = axisOf(cmd.axis);
    forEachTick(cmd.span.start, cmd.span.end, n, (t) => (arr[t] = cmd.value));
  }

  // Look: relative deltas accumulate; aim (absolute) overrides at its tick.
  const yaw = new Array<number>(n).fill(0);
  const pitch = new Array<number>(n).fill(0);
  for (const cmd of commands) {
    if (cmd.kind !== 'look') continue;
    const count = cmd.span.end - cmd.span.start;
    const dy = cmd.dyaw / count;
    const dp = cmd.dpitch / count;
    forEachTick(cmd.span.start, cmd.span.end, n, (t) => {
      yaw[t]! += dy;
      pitch[t]! += dp;
    });
  }
  const aims = commands
    .filter((c): c is AimCommand => c.kind === 'aim')
    .sort((a, b) => a.tick - b.tick);
  for (const aim of aims) {
    if (aim.tick < 0 || aim.tick >= n) continue;
    let sumYaw = 0;
    let sumPitch = 0;
    for (let t = 0; t < aim.tick; t++) {
      sumYaw += yaw[t]!;
      sumPitch += pitch[t]!;
    }
    yaw[aim.tick] = aim.yaw - sumYaw;
    pitch[aim.tick] = aim.pitch - sumPitch;
  }

  // Pointers: last source-order write wins on overlap.
  const pointers = new Array<PointerInput | null>(n).fill(null);
  for (const cmd of commands) {
    if (cmd.kind !== 'pointer') continue;
    if (cmd.tick < 0 || cmd.tick >= n) continue;
    pointers[cmd.tick] = {
      screen: { x: cmd.x, y: cmd.y },
      world: { x: cmd.x, y: cmd.y, z: 0 },
      buttons: cmd.click ? ['primary'] : [],
    };
  }

  const frames: InputFrame[] = [];
  for (let t = 0; t < n; t++) {
    const actions: Record<string, boolean> = {};
    const pressed: string[] = [];
    const released: string[] = [];
    for (const name of [...held.keys()].sort()) {
      const arr = held.get(name)!;
      const now = arr[t] === true;
      const prev = t > 0 && arr[t - 1] === true;
      if (now) actions[name] = true;
      if (now && !prev) pressed.push(name);
      if (!now && prev) released.push(name);
    }
    const frameAxes: Record<string, number> = {};
    for (const name of [...axes.keys()].sort()) {
      const v = axes.get(name)![t];
      if (v !== undefined) frameAxes[name] = v;
    }
    frames.push({
      tick: t,
      actions,
      pressed,
      released,
      axes: frameAxes,
      look: { dx: yaw[t]!, dy: pitch[t]! },
      pointer: pointers[t] ?? null,
    });
  }
  return frames;
}

/** Build an {@link InputScript} directly from commands (skips parsing). */
export function scriptFromCommands(commands: readonly InputCommand[]): InputScript {
  const frozen = commands.slice();
  return {
    commands: frozen,
    frames(totalTicks: number): readonly InputFrame[] {
      return compileFrames(frozen, totalTicks);
    },
  };
}

// --- formatting ----------------------------------------------------------------------------

/** Render a number in canonical, round-trippable form (`-0` normalised to `0`). */
function num(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

const KIND_ORDER: Record<InputCommand['kind'], number> = {
  hold: 0,
  press: 1,
  release: 2,
  axis: 3,
  look: 4,
  aim: 5,
  pointer: 6,
};

function firstTick(cmd: InputCommand): number {
  switch (cmd.kind) {
    case 'hold':
    case 'axis':
    case 'look':
      return cmd.span.start;
    default:
      return cmd.tick;
  }
}

/** A stable secondary key so commands on the same tick order deterministically. */
function secondaryKey(cmd: InputCommand): string {
  switch (cmd.kind) {
    case 'hold':
    case 'press':
    case 'release':
      return cmd.action;
    case 'axis':
      return cmd.axis;
    case 'look':
      return `${num(cmd.dyaw)},${num(cmd.dpitch)}`;
    case 'aim':
      return `${num(cmd.yaw)},${num(cmd.pitch)}`;
    case 'pointer':
      return `${num(cmd.x)},${num(cmd.y)}`;
  }
}

function formatCommand(cmd: InputCommand): string {
  switch (cmd.kind) {
    case 'hold':
      return `hold ${cmd.action} ${cmd.span.start}..${cmd.span.end}`;
    case 'press':
      return `press ${cmd.action} @${cmd.tick}`;
    case 'release':
      return `release ${cmd.action} @${cmd.tick}`;
    case 'axis':
      return `axis ${cmd.axis} ${num(cmd.value)} ${cmd.span.start}..${cmd.span.end}`;
    case 'look':
      return cmd.span.end === cmd.span.start + 1
        ? `look ${num(cmd.dyaw)} ${num(cmd.dpitch)} @${cmd.span.start}`
        : `look ${num(cmd.dyaw)} ${num(cmd.dpitch)} ${cmd.span.start}..${cmd.span.end}`;
    case 'aim':
      return `aim ${num(cmd.yaw)} ${num(cmd.pitch)} @${cmd.tick}`;
    case 'pointer':
      return `${cmd.click ? 'click' : 'point'} ${num(cmd.x)},${num(cmd.y)} @${cmd.tick}`;
  }
}

/** Render an {@link InputScript} back to canonical DSL text (for recordings). */
export function formatInputScript(script: InputScript): string {
  const sorted = script.commands.slice().sort((a, b) => {
    const ta = firstTick(a);
    const tb = firstTick(b);
    if (ta !== tb) return ta - tb;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    const ka = secondaryKey(a);
    const kb = secondaryKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return sorted.map(formatCommand).join('\n');
}

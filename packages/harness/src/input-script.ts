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
 *
 * ## Source order is part of the meaning
 * Because axis/pointer overlap resolution and `look` accumulation read the command list in
 * order, {@link formatInputScript} renders commands **in source order** — it must not sort, or a
 * recording would not be the script that ran. Statements whose combined effect depends on that
 * order are reported as `AEG-HARNESS-0012` warnings, and statements the tick window swallowed
 * are reported by {@link InputScript.check}.
 * @packageDocumentation
 */
import type { Diagnostic, InputFrame, PointerInput, SourceLocation, Validated } from '@aegis/core';
import { diagnostic, HarnessCode } from './diagnostics.js';

/** Inclusive-start, exclusive-end tick span. `@t` parses to `{ start: t, end: t + 1 }`. */
export interface TickSpan {
  start: number;
  end: number;
}

/**
 * Where a command came from in the source text. Optional: commands built programmatically via
 * {@link scriptFromCommands} have no source. Carried so compile-time diagnostics (a statement
 * that fell outside the tick window, an order-sensitive overlap) can point at the offending line
 * instead of describing it in prose.
 */
interface Located {
  /** 1-based line/column of the statement in the original script text. */
  at?: SourceLocation;
}

/** Hold a digital action across a span. */
export interface HoldCommand extends Located {
  kind: 'hold';
  action: string;
  span: TickSpan;
}

/** Edge-press a digital action for one tick. */
export interface PressCommand extends Located {
  kind: 'press';
  action: string;
  tick: number;
}

/** Release a digital action at a tick. */
export interface ReleaseCommand extends Located {
  kind: 'release';
  action: string;
  tick: number;
}

/** Set an analog axis to a value across a span. */
export interface AxisCommand extends Located {
  kind: 'axis';
  axis: string;
  value: number;
  span: TickSpan;
}

/** Apply a relative look delta (degrees), at a tick or spread across a span. */
export interface LookCommand extends Located {
  kind: 'look';
  dyaw: number;
  dpitch: number;
  span: TickSpan;
}

/** Aim at an absolute yaw/pitch; the compiler converts to look deltas. */
export interface AimCommand extends Located {
  kind: 'aim';
  yaw: number;
  pitch: number;
  tick: number;
}

/** Move the pointer, optionally clicking, at a tick. */
export interface PointerCommand extends Located {
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
  /**
   * The parsed commands, **in source order**. Order is semantically load-bearing: axis and
   * pointer writes are last-source-order-wins and `look` deltas accumulate, so re-ordering this
   * list can change {@link InputScript.frames}. {@link formatInputScript} therefore preserves it.
   */
  readonly commands: readonly InputCommand[];
  /**
   * Compile to exactly `totalTicks` frames. Edge sets (`pressed`/`released`) are derived by
   * diffing the held-action set between consecutive ticks, so a `hold` implies a `pressed`
   * on its first tick and a `released` on the tick after its last.
   */
  frames(totalTicks: number): readonly InputFrame[];
  /**
   * Report statements that would have no (or reduced) effect when compiled to `totalTicks`
   * frames — the tick window silently swallows anything outside `[0, totalTicks)`.
   *
   * A swallowed or clipped statement is a `warning`; if **no** statement in the script applied at
   * all, they are `error`s, because the run is then identical to one with no input. (Running a
   * prefix of a playthrough — `aegis inspect --tick 90` on a 400-tick script — is legitimate, so
   * the partial case must not be fatal.)
   *
   * A 60-tick run with `press Jump @500` used to hash byte-identically to a run with no input;
   * this is how a caller finds out. {@link "./run".runScene} surfaces these via
   * {@link "./run".RunOptions.onInputDiagnostics}.
   */
  check(totalTicks: number): readonly Diagnostic[];
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
  // Normalise -0 to 0. The canonical formatter renders both as "0" (see `num`), so keeping a
  // parsed -0 would make `parse -> format -> parse` lose the sign and stop being exact.
  return n === 0 ? 0 : n;
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
    const at = loc(lineNo, verbTok.column);

    switch (verb) {
      case 'hold': {
        if (!checkArity(tokens, 2, 'hold', lineNo, 'hold <Action> <a>..<b>', diags)) return;
        const span = parseSpan(tokens[2]!, lineNo, diags);
        if (span) commands.push({ kind: 'hold', action: tokens[1]!.text, span, at });
        return;
      }
      case 'press': {
        if (!checkArity(tokens, 2, 'press', lineNo, 'press <Action> @<t>', diags)) return;
        const t = parseAt(tokens[2]!, lineNo, diags);
        if (t !== undefined) {
          commands.push({ kind: 'press', action: tokens[1]!.text, tick: t, at });
        }
        return;
      }
      case 'release': {
        if (!checkArity(tokens, 2, 'release', lineNo, 'release <Action> @<t>', diags)) return;
        const t = parseAt(tokens[2]!, lineNo, diags);
        if (t !== undefined) {
          commands.push({ kind: 'release', action: tokens[1]!.text, tick: t, at });
        }
        return;
      }
      case 'axis': {
        if (!checkArity(tokens, 3, 'axis', lineNo, 'axis <Name> <value> <a>..<b>', diags)) return;
        const value = parseNum(tokens[2]!, lineNo, diags);
        const span = parseSpan(tokens[3]!, lineNo, diags);
        if (value !== undefined && span) {
          commands.push({ kind: 'axis', axis: tokens[1]!.text, value, span, at });
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
          commands.push({ kind: 'look', dyaw, dpitch, span, at });
        }
        return;
      }
      case 'aim': {
        if (!checkArity(tokens, 3, 'aim', lineNo, 'aim <yaw> <pitch> @<t>', diags)) return;
        const yaw = parseNum(tokens[1]!, lineNo, diags);
        const pitch = parseNum(tokens[2]!, lineNo, diags);
        const t = parseAt(tokens[3]!, lineNo, diags);
        if (yaw !== undefined && pitch !== undefined && t !== undefined) {
          commands.push({ kind: 'aim', yaw, pitch, tick: t, at });
        }
        return;
      }
      case 'click':
      case 'point': {
        if (!checkArity(tokens, 2, verb, lineNo, `${verb} <x>,<y> @<t>`, diags)) return;
        const pt = parsePoint(tokens[1]!, lineNo, diags);
        const t = parseAt(tokens[2]!, lineNo, diags);
        if (pt && t !== undefined) {
          commands.push({
            kind: 'pointer',
            x: pt.x,
            y: pt.y,
            click: verb === 'click',
            tick: t,
            at,
          });
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
  diags.push(...orderSensitivityDiagnostics(commands));
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
    check(totalTicks: number): readonly Diagnostic[] {
      return checkAgainstWindow(frozen, totalTicks);
    },
  };
}

// --- compile-time diagnostics ---------------------------------------------------------------

/** The half-open tick span a command affects (`@t` commands occupy exactly `[t, t + 1)`). */
function spanOf(cmd: InputCommand): TickSpan {
  switch (cmd.kind) {
    case 'hold':
    case 'axis':
    case 'look':
      return cmd.span;
    default:
      return { start: cmd.tick, end: cmd.tick + 1 };
  }
}

/** `"hold Right 200..300"` — the statement as written, for quoting in a diagnostic. */
function quote(cmd: InputCommand): string {
  return `"${formatCommand(cmd)}"`;
}

/**
 * Report statements that the tick window silently swallowed.
 *
 * {@link forEachTick} clamps, and the pointer/`aim` compilers `continue`, so a statement outside
 * `[0, totalTicks)` simply never happens: a 60-tick run with `press Jump @500` produces a hash
 * byte-identical to a run with no input at all. Shortening a run is the most likely authoring
 * mistake in the DSL, and it used to be completely invisible.
 *
 * **Severity:** a swallowed statement is normally a `warning`, because running a *prefix* of a
 * playthrough is a first-class workflow (`aegis inspect --tick 90` on a 400-tick script leaves
 * every later statement inactive on purpose). When **no** statement in the script had any effect
 * at all, the script as a whole is an `error`: the run is then indistinguishable from one with no
 * input, which is never what the author meant.
 */
function checkAgainstWindow(
  commands: readonly InputCommand[],
  totalTicks: number,
): readonly Diagnostic[] {
  const n = totalTicks < 0 ? 0 : totalTicks;
  const window = `[0, ${n})`;
  const effective = commands.filter((cmd) => {
    const { start, end } = spanOf(cmd);
    return (end > n ? n : end) > (start < 0 ? 0 : start);
  }).length;
  // `ticks: 0` steps nothing at all, so no statement *can* apply; that is a degenerate window,
  // not a mis-authored script.
  const scriptDidNothing = n > 0 && commands.length > 0 && effective === 0;
  const diags: Diagnostic[] = [];

  for (const cmd of commands) {
    const { start, end } = spanOf(cmd);
    const lo = start < 0 ? 0 : start;
    const hi = end > n ? n : end;
    const options = (fix: string): Parameters<typeof diagnostic>[2] => ({
      ...(cmd.at ? { location: cmd.at } : {}),
      fix,
      data: { statement: formatCommand(cmd), start, end, totalTicks: n },
    });

    if (hi <= lo) {
      diags.push(
        diagnostic(
          HarnessCode.StatementOutOfRange,
          `${quote(cmd)} had no effect: ticks ${start}..${end} lie outside the compiled window ${window}, ` +
            `so this run is identical to one with the statement deleted.`,
          {
            ...options(
              `Run at least ${end} tick${end === 1 ? '' : 's'}, or move the statement inside ${window}.`,
            ),
            severity: scriptDidNothing ? 'error' : 'warning',
          },
        ),
      );
      continue;
    }
    if (start >= 0 && end <= n) continue;

    if (cmd.kind === 'look') {
      const applied = (hi - lo) / (end - start);
      diags.push(
        diagnostic(
          HarnessCode.LookDeltaClipped,
          `${quote(cmd)} was clipped to ticks ${lo}..${hi} by the ${n}-tick window, so only ` +
            `${num(cmd.dyaw * applied)}° of ${num(cmd.dyaw)}° yaw and ${num(cmd.dpitch * applied)}° of ` +
            `${num(cmd.dpitch)}° pitch were actually applied.`,
          {
            ...options(
              `Run at least ${end} ticks to apply the whole delta, or use "look ${num(cmd.dyaw * applied)} ${num(cmd.dpitch * applied)} ${lo}..${hi}".`,
            ),
            severity: 'warning',
          },
        ),
      );
      continue;
    }
    diags.push(
      diagnostic(
        HarnessCode.StatementClipped,
        `${quote(cmd)} was clipped to ticks ${lo}..${hi} by the ${n}-tick window; ` +
          `ticks ${hi}..${end} of it never ran.`,
        {
          ...options(`Run at least ${end} ticks, or write the span as ${lo}..${hi}.`),
          severity: 'warning',
        },
      ),
    );
  }
  return diags;
}

/** Whether two half-open spans share at least one tick. */
function overlaps(a: TickSpan, b: TickSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Report statements whose combined effect depends on the **order of the lines in the file**.
 *
 * ADR-0004 promises that "ticks are absolute, so lines reorder and diff independently". That is
 * true of `hold`/`press`/`release` (a union of booleans) but not of axes and pointers, which are
 * last-source-order-write-wins, nor of three-or-more overlapping `look` deltas, whose sum is
 * order-dependent in floating point. Those cases are legal but fragile, so the author is told.
 */
function orderSensitivityDiagnostics(commands: readonly InputCommand[]): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const conflict = (later: InputCommand, earlier: InputCommand, what: string): void => {
    diags.push(
      diagnostic(
        HarnessCode.OrderSensitiveOverlap,
        `${quote(later)} overlaps ${quote(earlier)}: ${what} Swapping the two lines would ` +
          `change the compiled input, so this script is not safe to re-order.`,
        {
          severity: 'warning',
          ...(later.at ? { location: later.at } : {}),
          fix: 'Give the statements disjoint spans/ticks, or keep the intended winner last — the recorder preserves source order for exactly this reason.',
          data: { later: formatCommand(later), earlier: formatCommand(earlier) },
        },
      ),
    );
  };

  for (let j = 0; j < commands.length; j++) {
    const b = commands[j]!;
    for (let i = 0; i < j; i++) {
      const a = commands[i]!;
      if (a.kind !== b.kind) continue;
      if (
        a.kind === 'axis' &&
        b.kind === 'axis' &&
        a.axis === b.axis &&
        a.value !== b.value &&
        overlaps(a.span, b.span)
      ) {
        conflict(b, a, `the later "axis ${b.axis}" write wins on the shared ticks.`);
      } else if (
        a.kind === 'pointer' &&
        b.kind === 'pointer' &&
        a.tick === b.tick &&
        (a.x !== b.x || a.y !== b.y || a.click !== b.click)
      ) {
        conflict(b, a, `both target tick ${b.tick}, and only the later pointer survives.`);
      } else if (
        a.kind === 'aim' &&
        b.kind === 'aim' &&
        a.tick === b.tick &&
        (a.yaw !== b.yaw || a.pitch !== b.pitch)
      ) {
        conflict(b, a, `both aim on tick ${b.tick}, and only the later target survives.`);
      }
    }
  }
  diags.push(...lookAccumulationDiagnostics(commands));
  return diags;
}

/**
 * Three or more `look` statements covering one tick sum in source order. Floating-point addition
 * is commutative but **not associative**, so `(a + b) + c` need not equal `(b + c) + a`: with
 * three overlapping deltas the compiled frame depends on line order. Two are always safe.
 */
function lookAccumulationDiagnostics(commands: readonly InputCommand[]): Diagnostic[] {
  const looks = commands.filter((c): c is LookCommand => c.kind === 'look');
  if (looks.length < 3) return [];
  const edges: { at: number; delta: number }[] = [];
  for (const l of looks) {
    edges.push({ at: l.span.start, delta: 1 }, { at: l.span.end, delta: -1 });
  }
  edges.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.delta - b.delta));
  let open = 0;
  let peak = 0;
  for (const e of edges) {
    open += e.delta;
    if (open > peak) peak = open;
  }
  if (peak < 3) return [];
  const last = looks[looks.length - 1]!;
  return [
    diagnostic(
      HarnessCode.OrderSensitiveOverlap,
      `${peak} "look" statements cover a common tick. Their deltas are summed in source order, ` +
        `and floating-point addition is not associative, so re-ordering these lines can change ` +
        `the compiled look delta.`,
      {
        severity: 'warning',
        ...(last.at ? { location: last.at } : {}),
        fix: 'Merge the overlapping look statements into one, or give them disjoint spans.',
        data: { overlappingLooks: peak },
      },
    ),
  ];
}

// --- formatting ----------------------------------------------------------------------------

/** Render a number in canonical, round-trippable form (`-0` normalised to `0`). */
function num(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
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

/**
 * Render an {@link InputScript} back to canonical DSL text (for recordings).
 *
 * **Source order is preserved, deliberately.** This function used to re-sort commands by
 * `(firstTick, kind, secondaryKey)`, which silently changed what the script meant:
 * {@link compileFrames} resolves overlapping `axis` and `pointer` writes as *last source-order
 * wins* and sums `look` deltas in source order, so re-ordering the command list re-compiles to
 * different frames. Because `SimResult.recording()` serialises input through here, a recorded
 * session was not the session that ran — and replaying it failed the determinism check, blaming
 * a perfectly deterministic engine for "non-determinism (wall-clock, Math.random, unstable
 * iteration) in a system".
 *
 * Preserving order makes `parse → format → parse` produce an identical command list, and
 * therefore identical compiled frames, **for every input** — a guarantee by construction rather
 * than one resting on a hand-written "is this reorder safe?" predicate. Ticks are absolute
 * (ADR-0004), so the text still diffs and reads fine when the author wrote it out of order; a
 * script whose meaning actually depends on that order is reported by
 * {@link parseInputScript} as an `AEG-HARNESS-0012` warning.
 */
export function formatInputScript(script: InputScript): string {
  return script.commands.map(formatCommand).join('\n');
}

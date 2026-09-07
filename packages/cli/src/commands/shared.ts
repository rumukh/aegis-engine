/**
 * Helpers shared by every command: flag/positional extraction with actionable errors, and
 * filesystem access resolved against {@link CliIO.cwd} (never `process.cwd()`), so the CLI is
 * testable and correct on Windows.
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isValidTickRate } from '@aegis/core';
import type { ParsedArgs } from '../args.js';
import type { CliIO } from '../io.js';
import { AegisCliError, CliCode, errnoOf, messageOf } from '../errors.js';

/** Resolve a possibly-relative path against the command's working directory. */
export function resolvePath(io: CliIO, p: string): string {
  return isAbsolute(p) ? p : resolve(io.cwd, p);
}

/** Read a required positional argument, or throw {@link CliCode.MissingArgument}. */
export function requirePositional(
  args: ParsedArgs,
  index: number,
  name: string,
  usage: string,
): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw new AegisCliError(CliCode.MissingArgument, `Missing required argument <${name}>.`, {
      fix: `Usage: ${usage}`,
    });
  }
  return value;
}

/** Read a string flag value, or `undefined`. A bare `--flag` (boolean true) is rejected. */
export function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AegisCliError(CliCode.InvalidFlagValue, `Flag --${key} needs a value.`, {
      fix: `Pass a value, e.g. --${key} <value>.`,
    });
  }
  return value;
}

/** Read a boolean flag; `--flag`/`--flag=true` → true; `--flag=false` → false; absent → default. */
export function flagBool(args: ParsedArgs, key: string, fallback = false): boolean {
  const value = args.flags[key];
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === 'false') return false;
  throw new AegisCliError(CliCode.InvalidFlagValue, `Flag --${key} must be a boolean.`, {
    fix: `Use --${key} or --${key}=false.`,
    data: { received: value },
  });
}

/** Read an integer flag. Throws {@link CliCode.InvalidFlagValue} for non-integers. */
export function flagInt(
  args: ParsedArgs,
  key: string,
  options: { required?: boolean; min?: number } = {},
): number | undefined {
  const raw = args.flags[key];
  if (raw === undefined || raw === true) {
    if (options.required) {
      throw new AegisCliError(CliCode.MissingArgument, `Flag --${key} is required.`, {
        fix: `Pass --${key} <integer>.`,
      });
    }
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || (options.min !== undefined && n < options.min)) {
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      `Flag --${key} must be an integer${options.min !== undefined ? ` >= ${options.min}` : ''}, got "${String(raw)}".`,
      { fix: `Pass --${key} <integer>.`, data: { received: raw } },
    );
  }
  return n;
}

/** Read a finite positive tick rate; fractional rates are supported by the simulation. */
export function flagTickRate(args: ParsedArgs): number | undefined {
  const raw = flagString(args, 'tick-rate');
  if (raw === undefined) return undefined;
  const rate = Number(raw);
  if (!isValidTickRate(rate)) {
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      `Flag --tick-rate must be a finite positive number with a finite timestep, got "${raw}".`,
      { fix: 'Use --tick-rate 30, --tick-rate 60, or another finite positive rate.' },
    );
  }
  return rate;
}

/** Read a flag whose value must be one of `choices`. */
export function flagChoice<T extends string>(
  args: ParsedArgs,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = flagString(args, key);
  if (value === undefined) return fallback;
  // `find` narrows to T by construction; `includes` + a cast would only assert the same thing.
  const match = choices.find((choice) => choice === value);
  if (match === undefined) {
    throw new AegisCliError(CliCode.InvalidChoice, `Invalid --${key} value "${value}".`, {
      fix: `Use one of: ${choices.join(', ')}.`,
      data: { received: value, choices },
    });
  }
  return match;
}

/**
 * Default ceiling on a single command's tick count.
 *
 * A run is O(ticks) work and the harness allocates per tick, so an implausible `--ticks` used to
 * die 35 seconds later in a V8 out-of-memory abort with a native stack trace and no diagnostic
 * code at all. One million ticks is ~4.6 hours of simulated time at 60Hz — far beyond any real
 * scripted playthrough, and still a bounded, explainable refusal rather than a crash.
 */
export const DEFAULT_TICK_LIMIT = 1_000_000;

/** Read a tick count, refusing implausible values before they become an out-of-memory abort. */
export function flagTicks(args: ParsedArgs, key = 'ticks', required = true): number {
  const ticks = flagInt(args, key, { required, min: 0 }) ?? 0;
  const limit = flagInt(args, 'max-ticks', { min: 1 }) ?? DEFAULT_TICK_LIMIT;
  if (ticks > limit) {
    throw new AegisCliError(
      CliCode.TickLimitExceeded,
      `--${key} ${ticks} exceeds the tick limit of ${limit}.`,
      {
        fix: `A run costs time and memory proportional to its tick count. Simulate fewer ticks (a scripted playthrough is typically a few hundred to a few thousand), or raise the ceiling deliberately with --max-ticks ${ticks}.`,
        data: { ticks, limit, flag: key },
      },
    );
  }
  return ticks;
}

/**
 * Interpret a `--seed` flag: an all-digits value becomes a number (so hashes match numeric
 * scene seeds), anything else stays a string. Absent → `undefined` (the scene/default wins).
 */
export function flagSeed(args: ParsedArgs, key = 'seed'): number | string | undefined {
  const value = flagString(args, key);
  if (value === undefined) return undefined;
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

/** Read a UTF-8 file, mapping a missing file to an actionable {@link CliCode.FileNotFound}. */
export function readText(absPath: string, io: CliIO): string {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') {
      throw new AegisCliError(CliCode.FileNotFound, `File not found: ${absPath}`, {
        fix: `Check the path (resolved against ${io.cwd}).`,
        cause: err,
      });
    }
    throw new AegisCliError(CliCode.FileNotFound, `Could not read ${absPath}: ${messageOf(err)}`, {
      cause: err,
    });
  }
}

import { describe, it, expect } from 'vitest';
import { main, parseArgs, findCommand, COMMANDS, GLOBAL_FLAGS, suggestFlag } from './index.js';
import type { CliIO, FlagSpec } from './index.js';

function fakeIO(argv: readonly string[]): { io: CliIO; out: () => string; err: () => string } {
  let outBuf = '';
  let errBuf = '';
  const io: CliIO = {
    argv,
    cwd: '/',
    out: (t) => (outBuf += t),
    err: (t) => (errBuf += t),
  };
  return { io, out: () => outBuf, err: () => errBuf };
}

describe('@aegis/cli dispatcher', () => {
  it('registers all ten commands', () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(
      [
        'describe',
        'import',
        'inspect',
        'preview',
        'record',
        'replay',
        'run',
        'scaffold',
        'test',
        'validate',
      ].sort(),
    );
  });

  it('prints help and returns 0 with no args', async () => {
    const { io, out } = fakeIO([]);
    expect(await main(io)).toBe(0);
    expect(out()).toContain('Usage: aegis <command>');
  });

  it('reports unknown commands with a stable code and a suggestion', async () => {
    const { io, err } = fakeIO(['frobnicate']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain('AEG-CLI-0013');
    expect(err()).toContain('Unknown command: frobnicate');
  });

  // Regression: parseArgs used to run AFTER the unknown-command branch, so a `--json` consumer
  // got human prose on stderr and could not parse the failure at all.
  it('reports an unknown command as JSON when --json was requested', async () => {
    const { io, err } = fakeIO(['frobnicate', '--json']);
    expect(await main(io)).toBe(1);
    const data = JSON.parse(err()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe('AEG-CLI-0013');
    expect(data.error.message).toContain('frobnicate');
  });

  it('suggests the closest command name', async () => {
    const { io, err } = fakeIO(['valid']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain("Did you mean 'aegis validate'?");
  });

  it('shows command usage for --help without running it', async () => {
    const { io, out } = fakeIO(['run', '--help']);
    expect(await main(io)).toBe(0);
    expect(out()).toContain('aegis run <scene>');
  });

  it('maps a missing scene to an actionable exit code 1', async () => {
    const { io, err } = fakeIO(['run', 'does-not-exist.scene.json', '--ticks', '10']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain('AEG-CLI-0004');
    expect(err()).toContain('File not found');
  });

  // Regression: an undeclared flag used to be parsed, ignored, and the command exited 0 —
  // so `--asci` silently produced a run with no ASCII output and no warning.
  it('rejects an unknown flag with a did-you-mean instead of ignoring it', async () => {
    const { io, err } = fakeIO(['run', 'x.scene.json', '--ticks', '5', '--asci']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain('AEG-CLI-0012');
    expect(err()).toContain('Did you mean --ascii?');
  });

  it('rejects a value flag with no value', async () => {
    const { io, err } = fakeIO(['run', 'x.scene.json', '--ticks']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain('AEG-CLI-0002');
    expect(err()).toContain('--ticks needs a value');
  });
});

describe('parseArgs', () => {
  const spec: FlagSpec = {
    ...GLOBAL_FLAGS,
    ticks: 'value',
    mode: 'value',
    seed: 'value',
    hash: 'boolean',
    ascii: 'boolean',
  };

  it('parses positionals, --key value, --key=value and bare flags', () => {
    const parsed = parseArgs(['scene.json', '--ticks', '90', '--mode=fps', '--hash'], spec);
    expect(parsed.positionals).toEqual(['scene.json']);
    expect(parsed.flags).toEqual({ ticks: '90', mode: 'fps', hash: true });
    expect(parsed.unknown).toEqual([]);
  });

  it('treats everything after -- as positional', () => {
    const parsed = parseArgs(['--', '--not-a-flag'], spec);
    expect(parsed.positionals).toEqual(['--not-a-flag']);
  });

  // Regression: any non-dash token after ANY flag used to become that flag's value, so a
  // boolean flag before the positional ate it — `aegis inspect --json level.scene.json`
  // reported "Missing required argument <scene>" for a scene that WAS supplied.
  it('does not let a boolean flag swallow the following positional', () => {
    const parsed = parseArgs(['--json', 'level.scene.json'], spec);
    expect(parsed.positionals).toEqual(['level.scene.json']);
    expect(parsed.flags['json']).toBe(true);
  });

  it('keeps the positional when a boolean flag sits between value flags', () => {
    const parsed = parseArgs(['--ticks', '10', '--json', 'level.scene.json'], spec);
    expect(parsed.positionals).toEqual(['level.scene.json']);
    expect(parsed.flags).toEqual({ ticks: '10', json: true });
  });

  // Regression: `-1` was parsed as a flag, so flagSeed's documented negative support
  // (/^-?\d+$/) was unreachable.
  it('accepts a negative number as a value-flag value', () => {
    const parsed = parseArgs(['--seed', '-1'], spec);
    expect(parsed.flags['seed']).toBe('-1');
    expect(parsed.missingValues).toEqual([]);
  });

  it('reports a value flag with no value rather than silently making it boolean', () => {
    expect(parseArgs(['--seed'], spec).missingValues).toEqual(['seed']);
    expect(parseArgs(['--seed', '--json'], spec).missingValues).toEqual(['seed']);
  });

  // Regression: an undeclared flag used to be indistinguishable from a declared one, and
  // it also consumed the next token — `aegis test --json "games/**/*.gametest.js"` ran the
  // DEFAULT globs in the DEFAULT reporter and exited 0.
  it('collects undeclared flags without consuming the next token', () => {
    const parsed = parseArgs(['--asci', 'scene.json'], spec);
    expect(parsed.unknown).toEqual(['asci']);
    expect(parsed.positionals).toEqual(['scene.json']);
  });

  it('collects an undeclared --key=value flag too', () => {
    expect(parseArgs(['--nope=1'], spec).unknown).toEqual(['nope']);
  });
});

describe('suggestFlag', () => {
  const spec: FlagSpec = { ascii: 'boolean', ticks: 'value', reporter: 'value' };
  it('suggests on a shared prefix', () => {
    expect(suggestFlag('asci', spec)).toBe('ascii');
  });
  it('suggests on a small edit distance', () => {
    expect(suggestFlag('tikcs', spec)).toBe('ticks');
  });
  it('suggests nothing for something unrelated', () => {
    expect(suggestFlag('quaternion', spec)).toBeUndefined();
  });
});

describe('findCommand', () => {
  it('finds by name', () => {
    expect(findCommand('validate')?.summary).toContain('Validate');
    expect(findCommand('nope')).toBeUndefined();
  });

  it('every command declares its flags so nothing is silently ignored', () => {
    for (const command of COMMANDS) {
      expect(Object.keys(command.flags).length).toBeGreaterThan(0);
      for (const kind of Object.values(command.flags)) {
        expect(['boolean', 'value']).toContain(kind);
      }
    }
  });
});

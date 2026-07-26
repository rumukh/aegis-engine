import { describe, it, expect } from 'vitest';
import { main, parseArgs, findCommand, COMMANDS } from './index.js';
import type { CliIO } from './index.js';

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
  it('registers all seven commands', () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(
      ['inspect', 'record', 'replay', 'run', 'scaffold', 'test', 'validate'].sort(),
    );
  });

  it('prints help and returns 0 with no args', async () => {
    const { io, out } = fakeIO([]);
    expect(await main(io)).toBe(0);
    expect(out()).toContain('Usage: aegis <command>');
  });

  it('reports unknown commands with exit code 1', async () => {
    const { io, err } = fakeIO(['frobnicate']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain('Unknown command: frobnicate');
  });

  it('shows command usage for --help without running it', async () => {
    const { io, out } = fakeIO(['run', '--help']);
    expect(await main(io)).toBe(0);
    expect(out()).toContain('aegis run <scene>');
  });

  it('maps a stubbed command failure to exit code 1', async () => {
    const { io, err } = fakeIO(['run', 'scene.json', '--ticks', '10']);
    expect(await main(io)).toBe(1);
    expect(err()).toContain('not implemented');
  });
});

describe('parseArgs', () => {
  it('parses positionals, --key value, --key=value and bare flags', () => {
    const parsed = parseArgs(['scene.json', '--ticks', '90', '--mode=fps', '--hash']);
    expect(parsed.positionals).toEqual(['scene.json']);
    expect(parsed.flags).toEqual({ ticks: '90', mode: 'fps', hash: true });
  });

  it('treats everything after -- as positional', () => {
    const parsed = parseArgs(['--', '--not-a-flag']);
    expect(parsed.positionals).toEqual(['--not-a-flag']);
  });
});

describe('findCommand', () => {
  it('finds by name', () => {
    expect(findCommand('validate')?.summary).toContain('Validate');
    expect(findCommand('nope')).toBeUndefined();
  });
});

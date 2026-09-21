import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestTemp, selectTestTempRoot } from '../scripts/test-temp.mjs';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const helperUrl = new URL('../scripts/test-temp.mjs', import.meta.url).href;
let fixtures: string;
beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'aegis-test-temp-fixture-'));
});
afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe('owned test temporary storage', () => {
  it('uses Windows local storage rather than a redirected general temporary drive', () => {
    expect(
      selectTestTempRoot(
        'win32',
        { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', TEMP: 'F:\\temp', TMP: 'F:\\temp' },
        'F:\\temp',
      ),
    ).toEqual({
      directory: 'C:\\Users\\tester\\AppData\\Local\\Aegis\\test-tmp',
      source: 'Windows local application data',
    });
  });

  it('honors an explicit absolute override and identifies its provenance', () => {
    expect(
      selectTestTempRoot('win32', {
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        AEGIS_TEST_TMPDIR: 'D:\\validation',
      }),
    ).toEqual({ directory: 'D:\\validation', source: 'AEGIS_TEST_TMPDIR' });
    expect(selectTestTempRoot('linux', { AEGIS_TEST_TMPDIR: '/var/tmp/validation' })).toEqual({
      directory: '/var/tmp/validation',
      source: 'AEGIS_TEST_TMPDIR',
    });
  });

  it('retains the system default on other platforms or without local application data', () => {
    expect(selectTestTempRoot('linux', { LOCALAPPDATA: 'C:\\not-used' }, '/tmp/native')).toEqual({
      directory: '/tmp/native',
      source: 'system temporary directory',
    });
    expect(selectTestTempRoot('win32', {}, 'D:\\system-temp')).toEqual({
      directory: 'D:\\system-temp',
      source: 'system temporary directory',
    });
  });

  it('rejects empty or relative settings instead of silently selecting another location', () => {
    for (const invalid of ['', 'relative', '..\\escape', 'D:relative'])
      expect(() =>
        selectTestTempRoot('win32', { AEGIS_TEST_TMPDIR: invalid }, 'C:\\fallback'),
      ).toThrow('AEGIS_TEST_TMPDIR must be an absolute directory path');
    expect(() => selectTestTempRoot('win32', { LOCALAPPDATA: 'relative' })).toThrow(
      'LOCALAPPDATA must be an absolute directory path',
    );
    expect(() => selectTestTempRoot('linux', { AEGIS_TEST_TMPDIR: 'relative' })).toThrow(
      'AEGIS_TEST_TMPDIR must be an absolute directory path',
    );
  });

  it('keeps independent consumers outside the checkout, including ignored subdirectories', () => {
    for (const inside of [workspace, join(workspace, 'node_modules', '.temporary')])
      expect(() =>
        createTestTemp(workspace, { ...process.env, AEGIS_TEST_TMPDIR: inside }),
      ).toThrow('outside the checkout');
  });

  it('refuses a directory alias that actually points into the checkout', () => {
    const alias = join(fixtures, 'checkout-alias');
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    let temporary: ReturnType<typeof createTestTemp> | undefined;
    try {
      expect(() => {
        temporary = createTestTemp(workspace, {
          ...process.env,
          AEGIS_TEST_TMPDIR: alias,
        });
      }).toThrow('outside the checkout');
    } finally {
      temporary?.dispose();
      unlinkSync(alias);
    }
  });

  it('passes a real child its owned directory without mutating the parent environment', () => {
    const parent = {
      ...process.env,
      AEGIS_TEST_TMPDIR: fixtures,
      TEMP: 'previous-temp',
      TMP: 'previous-tmp',
      TMPDIR: 'previous-tmpdir',
      AEGIS_TEMP_CONTROL: 'preserved',
    };
    const before = { ...parent };
    const temporary = createTestTemp(workspace, parent);
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { tmpdir } from 'node:os';
           console.log(JSON.stringify({directory:tmpdir(),temp:process.env.TEMP,
             tmp:process.env.TMP,tmpdir:process.env.TMPDIR,marker:process.env.AEGIS_TEMP_CONTROL}));`,
        ],
        { env: temporary.environment, encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        directory: temporary.directory,
        temp: temporary.directory,
        tmp: temporary.directory,
        tmpdir: temporary.directory,
        marker: 'preserved',
      });
      expect(parent).toEqual(before);
      expect(dirname(temporary.directory)).toBe(realpathSync(fixtures));
    } finally {
      temporary.dispose();
    }
    expect(existsSync(temporary.directory)).toBe(false);
  });

  it('isolates simultaneous runs and removes only the directory the run owns', () => {
    const sentinel = join(fixtures, 'caller-owned.txt');
    writeFileSync(sentinel, 'keep');
    const environment = { ...process.env, AEGIS_TEST_TMPDIR: fixtures };
    const first = createTestTemp(workspace, environment);
    const second = createTestTemp(workspace, environment);
    try {
      expect(first.directory).not.toBe(second.directory);
      const nested = join(first.directory, 'nested');
      mkdirSync(nested);
      writeFileSync(join(nested, 'temporary.txt'), 'discard');
      first.dispose();
      expect(existsSync(first.directory)).toBe(false);
      expect(existsSync(second.directory)).toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toBe('keep');
      expect(existsSync(fixtures)).toBe(true);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('reports an unusable configured directory rather than falling back', () => {
    const file = join(fixtures, 'not-a-directory');
    writeFileSync(file, 'keep');
    expect(() => createTestTemp(workspace, { ...process.env, AEGIS_TEST_TMPDIR: file })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('keep');
  });

  it('cleans a real subprocess directory even when the subprocess exits explicitly', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createTestTemp, installTestTempCleanup } from ${JSON.stringify(helperUrl)};
         const temporary=createTestTemp(${JSON.stringify(workspace)});
         installTestTempCleanup(temporary);
         console.log(temporary.directory);
         process.exit(0);`,
      ],
      {
        env: { ...process.env, AEGIS_TEST_TMPDIR: fixtures },
        encoding: 'utf8',
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const directory = child.stdout.trim();
    expect(dirname(directory)).toBe(realpathSync(fixtures));
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(fixtures)).toBe(true);
  });

  it('refuses success when cleanup fails, including an explicit successful exit', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { installTestTempCleanup } from ${JSON.stringify(helperUrl)};
         installTestTempCleanup({dispose(){throw new Error('controlled-cleanup-failure')}});
         process.exit(0);`,
      ],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('temporary-directory cleanup failed');
    expect(child.stderr).toContain('controlled-cleanup-failure');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 240_000,
    env: { ...process.env, NODE_PATH: '' },
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
    );
  }
  return result.stdout.trim();
}

export function npm(args, cwd) {
  const cli = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((path) => path?.endsWith('npm-cli.js') && existsSync(path));
  if (!cli) throw new Error('Cannot locate npm-cli.js; invoke this command through npm run.');
  return run(process.execPath, [cli, ...args], cwd);
}

export function isMain(url) {
  return process.argv[1] !== undefined && fileURLToPath(url) === resolve(process.argv[1]);
}

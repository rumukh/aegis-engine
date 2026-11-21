import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('../../', import.meta.url));

/** Real installed package layout, with no workspace links, src, games, poc or Vite aliases.
 * RUNNER_TEMP on CI (or an explicit AEGIS_GAME_TEST_ROOT) also places it outside the checkout.
 */
export function standaloneFixture() {
  const parent =
    process.env.AEGIS_GAME_TEST_ROOT ??
    process.env.RUNNER_TEMP ??
    join(checkout, 'node_modules', '.aegis-distribution-fixtures');
  const root = resolve(parent, `aegis-distribution-${randomUUID()}`);
  const modules = join(root, 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  // Copy the installed runtime dependencies recursively, not a list of workspace aliases. Engine
  // packages get exactly their published files, third parties come from the locked installation.
  const copied = new Set<string>();
  const copy = (name: string): void => {
    if (copied.has(name)) return;
    copied.add(name);
    const from = join(checkout, 'node_modules', name);
    const to = join(modules, name);
    const pkg = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
    if (name.startsWith('@aegis/')) {
      mkdirSync(to, { recursive: true });
      for (const part of ['package.json', 'dist', ...(pkg.bin ? ['bin'] : [])])
        cpSync(join(from, part), join(to, part), { recursive: true });
    } else {
      cpSync(from, to, { recursive: true, dereference: true });
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) copy(dep);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      if (existsSync(join(checkout, 'node_modules', dep))) copy(dep);
  };
  copy('@aegis/cli');
  const bin = join(modules, '@aegis/cli/bin/aegis.mjs');
  // Even when a developer's fixture is under out/, the CLI is forbidden from reading the
  // checkout. The esbuild service is needed only for a project-supplied plugin.
  const nodeFlags = [
    process.allowedNodeEnvironmentFlags.has('--permission')
      ? '--permission'
      : '--experimental-permission',
    `--allow-fs-read=${root}`,
    `--allow-fs-write=${root}`,
  ];
  const cli = (args: string[], cwd = root, bundle = false) =>
    exec(
      process.execPath,
      [...nodeFlags, ...(bundle ? ['--allow-child-process', '--allow-worker'] : []), bin, ...args],
      { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
  const game = join(root, 'first-light');
  const startLive = async (): Promise<{ url: string; rootUrl: string; close(): Promise<void> }> => {
    const network = process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : [];
    const child = spawn(
      process.execPath,
      [
        ...nodeFlags,
        ...network,
        bin,
        'play',
        '.',
        '--port',
        '0',
        '--base-path',
        '/reviews/live/',
        '--json',
      ],
      { cwd: game, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    const close = async (): Promise<void> => {
      child.kill();
      await closed;
    };
    const lines = createInterface({ input: child.stdout });
    try {
      const address = await new Promise<{ url: string; root: string }>((done, fail) => {
        const timer = setTimeout(() => {
          child.kill();
          fail(new Error(`No live URL: ${stderr}`));
        }, 45_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          fail(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          fail(new Error(`play exited ${code}: ${stderr}`));
        });
        lines.once('line', (line) => {
          clearTimeout(timer);
          try {
            done(JSON.parse(line));
          } catch (err) {
            fail(err);
          }
        });
      });
      return { url: address.url, rootUrl: address.root, close };
    } catch (error) {
      await close();
      throw error;
    } finally {
      lines.close();
    }
  };
  return {
    root,
    game,
    cli,
    startLive,
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }),
  };
}

export function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

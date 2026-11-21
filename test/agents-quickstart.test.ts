import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  makeFixtureDir,
  PACKAGE_ROOT,
  removeFixtureDir,
} from '../packages/cli/src/testing/fixtures.js';

const root = resolve(PACKAGE_ROOT, '../..');
const guide = readFileSync(join(root, 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');

function block(marker: string): string[] {
  const match = guide.match(new RegExp('<!-- ' + marker + ' -->\\s*```\\w+\\n([^`]*?)\\n```'));
  if (!match) throw new Error(`Missing ${marker} example in AGENTS.md`);
  return match[1]!.split('\n');
}

// Read commands from the guide, not a second copy. No shell or browser, only the built CLI.
function cli(line: string, cwd: string, expected = 0): string {
  const [bin, ...args] = line.match(/"[^"]*"|\S+/g) ?? [];
  expect(bin).toBe('aegis');
  const run = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, 'bin/aegis.mjs'), ...args.map((arg) => arg.replace(/^"|"$/g, ''))],
    { cwd, encoding: 'utf8', timeout: 30_000 },
  );
  if (run.error) throw run.error;
  expect(run.status, `${line}\n${run.stderr}${run.stdout}`).toBe(expected);
  return run.stdout;
}

it('executes the documented loop in an empty project and matches the actual scaffold tree', () => {
  const dir = makeFixtureDir();
  try {
    expect(readdirSync(dir)).toEqual([]);
    const lines = block('quickstart-commands');
    expect(lines.map((line) => line.split(' ')[1])).toEqual([
      'scaffold',
      'validate',
      'run',
      'inspect',
      'test',
    ]);
    cli(lines[0]!, dir);
    const project = join(dir, 'first-game');
    expect(readdirSync(project).sort()).toEqual(block('quickstart-files').sort());
    expect(JSON.parse(readFileSync(join(project, 'aegis.json'), 'utf8'))).toMatchObject({
      scene: expect.stringContaining('first-game.scene.json'),
      presentation: expect.stringContaining('first-game.presentation.json'),
      input: expect.stringContaining('first-game.input'),
    });
    cli(lines[1]!, dir);
    const run = JSON.parse(cli(lines[2]!, dir));
    expect(run.events['player.landed']).toBeGreaterThan(0);
    const inspected = JSON.parse(cli(lines[3]!, dir));
    expect(inspected).toMatchObject({
      matched: 1,
      page: { returned: 1 },
      resourceSelection: { mode: 'none' },
      hash: run.hash,
    });
    expect(inspected.entities[0].name).toBe('player');
    expect(inspected.resources).toBeUndefined();
    expect(JSON.parse(cli(lines[4]!, dir))).toMatchObject({
      passed: 1,
      failed: 0,
      invalid: 0,
      testsDiscovered: 1,
    });

    // A broken inline level must make the same documented test fail, not just change its hash.
    const scene = join(project, 'first-game.scene.json');
    const broken = JSON.parse(readFileSync(scene, 'utf8'));
    delete broken.resources['platformer.tilemap'];
    writeFileSync(scene, JSON.stringify(broken));
    expect(JSON.parse(cli(lines[4]!, dir, 1))).toMatchObject({
      passed: 0,
      failed: 1,
      testsDiscovered: 1,
    });
  } finally {
    removeFixtureDir(dir);
  }
});

it('executes the guide’s real Sector Breach plugin/frame query', () => {
  const lines = block('quickstart-fps');
  expect(lines).toHaveLength(1);
  const frame = JSON.parse(cli(lines[0]!, root));
  expect(frame).toMatchObject({
    mode: 'fps',
    tick: 9,
    camera: { projection: 'perspective' },
    totalEntities: 5,
    excludedEntities: 4,
    entities: [{ name: 'button' }],
  });
});

it('keeps the linked Ledge Hop scene, manifest, and game test usable as written', () => {
  const reference = readFileSync(join(root, 'GAME-AUTHORING.md'), 'utf8').replace(/\r\n/g, '\n');
  const excerpts = [
    ...reference.matchAll(
      /<!-- template-exempt: authored for this guide[^\n]+-->\s*```\w+\n([\s\S]*?)\n```/g,
    ),
  ].map((m) => m[1]!);
  expect(excerpts).toHaveLength(3);
  const dir = makeFixtureDir();
  try {
    const project = join(dir, 'ledge-hop');
    mkdirSync(project);
    for (const [index, name] of [
      'ledge-hop.scene.json',
      'aegis.json',
      'ledge-hop.gametest.mjs',
    ].entries())
      writeFileSync(join(project, name), excerpts[index]!);
    cli('aegis validate ledge-hop/ledge-hop.scene.json --strict', dir);
    const test = 'aegis test "ledge-hop/**/*.gametest.mjs" --json';
    expect(JSON.parse(cli(test, dir))).toMatchObject({ passed: 1, failed: 0 });
    // Keep everything but the input identical. Jump too late and the named jump assertion fails.
    writeFileSync(
      join(project, 'ledge-hop.gametest.mjs'),
      excerpts[2]!.replace('press Jump @48', 'press Jump @70'),
    );
    expect(JSON.parse(cli(test, dir, 1)).tests[0].error).toContain('player.jumped');
  } finally {
    removeFixtureDir(dir);
  }
});

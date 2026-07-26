/**
 * Regression tests for test discovery (F1) and the scaffold's runnability (F5).
 *
 * The defect these pin down is the nastiest kind: a *red test that reported green*. A single
 * wrong field type made `isGameTest` reject a test module, discovery skipped it with no output
 * at all, and the suite reported `1 passed, 0 failed` and exited 0.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './cli.js';
import type { CliDeps } from './cli.js';
import { createModeResolver, defaultModeResolver } from './modes.js';
import { fakeMode } from './testing/fake-mode.js';

import {
  makeFixtureDir,
  PACKAGE_ROOT,
  removeFixtureDir,
  sweepStaleFixtures,
} from './testing/fixtures.js';

sweepStaleFixtures();
const FAKE_MODE_DIST = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'testing', 'fake-mode.js')).href;

const deps: CliDeps = { modes: createModeResolver([fakeMode]) };
/** The real shipped modes — the scaffold's output is only meaningful against those. */
const realDeps: CliDeps = { modes: defaultModeResolver() };

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: readonly string[], cwd: string, d: CliDeps = deps): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main({ argv, cwd, out: (t) => (out += t), err: (t) => (err += t) }, d);
  return { code, out, err };
}

const SCENE = {
  aegis: 'scene/1',
  name: 'fixture-level',
  mode: 'platformer',
  seed: 'fixture-seed',
  entities: [
    {
      id: 'hero',
      tags: ['Player'],
      components: {
        Transform: { position: { x: 0, y: 0, z: 0 } },
        Velocity: { x: 0, y: 0, z: 0 },
        Health: { current: 1, max: 1 },
      },
    },
  ],
};

const createdDirs: string[] = [];

function makeDir(): string {
  const dir = makeFixtureDir();
  createdDirs.push(dir);
  writeFileSync(join(dir, 'level.scene.json'), JSON.stringify(SCENE, null, 2), 'utf8');
  return dir;
}

/** Write a gametest module; `overrides` replaces literal source fragments to break it. */
function writeTest(dir: string, file: string, body: string): void {
  writeFileSync(join(dir, file), body, 'utf8');
}

/** A valid, passing test module. */
function goodTest(dir: string, name = 'good test'): string {
  const scene = join(dir, 'level.scene.json').split('\\').join('\\\\');
  return [
    `import { defineGameTest, expectSim } from '@aegis/harness';`,
    `import { fakeMode } from '${FAKE_MODE_DIST}';`,
    `export default defineGameTest({`,
    `  name: '${name}',`,
    `  scene: '${scene}',`,
    `  ticks: 30,`,
    `  options: { plugin: fakeMode },`,
    `  expect(result) { expectSim(result).entityExists({ has: ['Player'] }); },`,
    `});`,
    ``,
  ].join('\n');
}

/**
 * The auditor's exact reproduction: a test whose `ticks` is the string `'30'`, carrying an
 * assertion that WOULD fail. `isGameTest` rejected it structurally and discovery dropped it.
 */
function malformedTest(dir: string): string {
  const scene = join(dir, 'level.scene.json').split('\\').join('\\\\');
  return [
    `import { fakeMode } from '${FAKE_MODE_DIST}';`,
    `export default {`,
    `  name: 'red test that must not vanish',`,
    `  scene: '${scene}',`,
    `  ticks: '30',`,
    `  options: { plugin: fakeMode },`,
    `  expect() { throw new Error('this assertion WOULD fail'); },`,
    `};`,
    ``,
  ].join('\n');
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) removeFixtureDir(dir);
  }
});

describe('aegis test discovery reporting', () => {
  // Regression: this exact pair reported "1 passed, 0 failed of 1", exit 0 — a red test
  // silently deleted from the suite by one wrong field type.
  it('reports a malformed GameTest as a failure instead of skipping it', async () => {
    const dir = makeDir();
    writeTest(dir, 'good.gametest.mjs', goodTest(dir));
    writeTest(dir, 'bad.gametest.mjs', malformedTest(dir));

    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('PASS good test');
    expect(r.out).toContain('INVALID red test that must not vanish');
    expect(r.out).toContain('field "ticks" must be a number, got string');
    expect(r.out).toContain('1 passed, 0 failed, 1 invalid of 2');
    expect(r.err).toContain('AEG-CLI-0014');
  });

  it('reports malformed tests in --json too', async () => {
    const dir = makeDir();
    writeTest(dir, 'good.gametest.mjs', goodTest(dir));
    writeTest(dir, 'bad.gametest.mjs', malformedTest(dir));

    const r = await cli(['test', '--json'], dir);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.out) as {
      passed: number;
      failed: number;
      invalid: number;
      total: number;
      filesScanned: number;
      invalidTests: { code: string; problems: string[] }[];
    };
    expect(data).toMatchObject({ passed: 1, failed: 0, invalid: 1, total: 2, filesScanned: 2 });
    expect(data.invalidTests[0]!.code).toBe('AEG-CLI-0014');
    expect(data.invalidTests[0]!.problems.join(' ')).toContain('ticks');
  });

  it('reports malformed tests in the TAP reporter as "not ok"', async () => {
    const dir = makeDir();
    writeTest(dir, 'bad.gametest.mjs', malformedTest(dir));
    const r = await cli(['test', '--reporter', 'tap'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('1..1');
    expect(r.out).toContain('not ok 1 - red test that must not vanish # AEG-CLI-0014');
  });

  // Regression: discovery said nothing at all about what it had examined, so "0 tests found"
  // and "1 test found, 1 silently dropped" produced identical, reassuring output.
  it('states files scanned, tests found and exports skipped', async () => {
    const dir = makeDir();
    writeTest(dir, 'good.gametest.mjs', goodTest(dir));
    writeTest(
      dir,
      'extra.gametest.mjs',
      `export const helper = { unrelated: true };\nexport const n = 42;\n`,
    );
    const r = await cli(['test'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 file(s) scanned, 1 test(s) found, 2 unrelated export(s) skipped');

    const asJson = await cli(['test', '--json'], dir);
    const data = JSON.parse(asJson.out) as { filesScanned: number; exportsSkipped: number };
    expect(data).toMatchObject({ filesScanned: 2, exportsSkipped: 2 });
  });

  it('reports a module that cannot even be imported', async () => {
    const dir = makeDir();
    writeTest(dir, 'broken.gametest.mjs', `import 'node:definitely-not-a-module';\n`);
    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0014');
    expect(r.out).toContain('could not be imported');
  });

  // Regression: `--filter zzz` blamed the glob and never mentioned the filter, so the fix text
  // pointed at the one thing that was not the problem.
  it('blames the filter, not the glob, when a filter matches nothing', async () => {
    const dir = makeDir();
    writeTest(dir, 'good.gametest.mjs', goodTest(dir));
    const r = await cli(['test', '--filter', 'zzz'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0008');
    expect(r.err).toContain('--filter "zzz"');
    expect(r.err).toContain('"good test"');
  });

  it('still explains an empty discovery in terms of the glob', async () => {
    const dir = makeDir();
    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0008');
    expect(r.err).toContain('gametest');
  });

  // Regression: `aegis test --json "games/**/*.gametest.js"` had its glob swallowed by --json,
  // ran the DEFAULT patterns, fell back to the pretty reporter, and exited 0.
  it('keeps a glob positional that follows --json, and honours the json reporter', async () => {
    const dir = makeDir();
    writeTest(dir, 'good.gametest.mjs', goodTest(dir));
    const r = await cli(['test', '--json', '*.gametest.mjs'], dir);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as { passed: number; filesScanned: number };
    expect(data.passed).toBe(1);
    expect(data.filesScanned).toBe(1);
  });

  it('resolves a string options.plugin so an import-free test can run', async () => {
    const dir = makeDir();
    const scene = join(dir, 'level.scene.json').split('\\').join('\\\\');
    writeTest(
      dir,
      'nodeps.gametest.mjs',
      [
        `export default {`,
        `  name: 'import-free test',`,
        `  scene: '${scene}',`,
        `  ticks: 5,`,
        `  options: { plugin: 'platformer' },`,
        `  expect(result) { if (result.query({ has: ['Player'] }).count() !== 1) throw new Error('no player'); },`,
        `};`,
        ``,
      ].join('\n'),
    );
    const r = await cli(['test'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS import-free test');
  });

  it('reports an unresolvable string options.plugin as a broken test', async () => {
    const dir = makeDir();
    const scene = join(dir, 'level.scene.json').split('\\').join('\\\\');
    writeTest(
      dir,
      'badplugin.gametest.mjs',
      [
        `export default {`,
        `  name: 'bad plugin spec',`,
        `  scene: '${scene}',`,
        `  ticks: 5,`,
        `  options: { plugin: './nope.mjs#thing' },`,
        `  expect() {},`,
        `};`,
        ``,
      ].join('\n'),
    );
    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('options.plugin could not be resolved');
    expect(r.err).toContain('AEG-CLI-0014');
  });
});

describe('aegis test finds tests an aegis.json declares', () => {
  /**
   * A game's acceptance test does not always live in a file named `*.gametest.*`: the iso PoC
   * default-exports its `GameTest` from the same module that exports its plugin, which is the
   * natural place for it. Filename-only discovery therefore under-reports — and a green run
   * covering one of three games reads as coverage while being the opposite.
   */
  it('discovers a GameTest in a module the manifest points at', async () => {
    const dir = makeDir();
    // Named so the default glob can never match it — only the declaration can find it.
    writeTest(dir, 'game-module.mjs', goodTest(dir, 'declared test'));
    writeFileSync(join(dir, 'aegis.json'), '{ "tests": ["./game-module.mjs"] }\n', 'utf8');

    const r = await cli(['test'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS declared test');
    expect(r.out).toContain('1 via aegis.json');
  });

  it('counts a manifest module once when the glob also matched it', async () => {
    const dir = makeDir();
    writeTest(dir, 'both.gametest.mjs', goodTest(dir, 'counted once'));
    writeFileSync(join(dir, 'aegis.json'), '{ "tests": ["./both.gametest.mjs"] }\n', 'utf8');

    const r = await cli(['test', '--json'], dir);
    const data = JSON.parse(r.out) as { filesScanned: number; total: number };
    expect(data).toMatchObject({ filesScanned: 1, total: 1 });
  });

  // The coverage gap that made the auditor's "1 of 3" dangerous: a game exists, and said nothing
  // about its tests. Discovery can't find them, but it can say that it didn't look.
  it('names a manifest that declares no tests, so a partial run cannot read as coverage', async () => {
    const dir = makeDir();
    writeTest(dir, 'only.gametest.mjs', goodTest(dir, 'the one test'));
    writeFileSync(join(dir, 'aegis.json'), '{ "plugin": "platformer" }\n', 'utf8');

    const r = await cli(['test'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('declare(s) no "tests"');
    expect(r.out).toContain('NOT covered by this run');
    expect(r.out).toContain('aegis.json');

    const asJson = await cli(['test', '--json'], dir);
    const data = JSON.parse(asJson.out) as { manifestsWithoutTests: string[] };
    expect(data.manifestsWithoutTests).toHaveLength(1);
  });

  it('reports a declared test module that does not exist instead of dropping it', async () => {
    const dir = makeDir();
    writeTest(dir, 'only.gametest.mjs', goodTest(dir, 'the one test'));
    writeFileSync(join(dir, 'aegis.json'), '{ "tests": ["./gone.mjs"] }\n', 'utf8');

    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('declares a test module that does not exist: ./gone.mjs');
    expect(r.err).toContain('AEG-CLI-0014');
  });
});

describe('aegis scaffold produces a runnable game', () => {
  // Regression: the generated tilemap was never referenced by the generated scene, so the level
  // had no ground, no collision, --ascii failed, and 120 ticks produced no motion at all.
  it('embeds the tilemap in the scene so the level has ground and an ASCII view', async () => {
    const dir = makeDir();
    const scaffold = await cli(['scaffold', 'game', 'demo', '--mode', 'platformer'], dir);
    expect(scaffold.code).toBe(0);

    const scene = JSON.parse(readFileSync(join(dir, 'demo', 'demo.scene.json'), 'utf8')) as {
      resources?: Record<string, { layers?: unknown[] }>;
    };
    expect(scene.resources?.['platformer.tilemap']).toBeDefined();
    expect(scene.resources!['platformer.tilemap']!.layers).toBeDefined();
  });

  it('writes an input script and a starter test alongside the scene', async () => {
    const dir = makeDir();
    await cli(['scaffold', 'game', 'demo', '--mode', 'platformer'], dir);
    expect(existsSync(join(dir, 'demo', 'demo.input'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'demo.gametest.mjs'))).toBe(true);
    expect(readFileSync(join(dir, 'demo', 'demo.input'), 'utf8')).toContain('hold Right');
  });

  /**
   * The advertised zero-to-running-game path (architecture.md §6), start to finish. It used to
   * break at steps 3 and 4: `--ascii` failed with "mode has no ASCII view", the player had not
   * moved after 120 ticks and no events fired, and `aegis test` died on `Cannot find package
   * '@aegis/harness'`.
   */
  it.each(['platformer', 'iso', 'fps'] as const)(
    'scaffold → validate → run --ascii → test all succeed for %s',
    async (mode) => {
      const dir = makeDir();
      const name = `demo${mode}`;
      const scaffold = await cli(['scaffold', 'game', name, '--mode', mode], dir, realDeps);
      expect(scaffold.code).toBe(0);

      const validated = await cli(
        ['validate', `${name}/${name}.scene.json`, `${name}/${name}.tilemap.json`],
        dir,
        realDeps,
      );
      expect(validated.code).toBe(0);

      const ran = await cli(
        [
          'run',
          `${name}/${name}.scene.json`,
          '--ticks',
          '120',
          '--input',
          `${name}/${name}.input`,
          '--ascii',
        ],
        dir,
        realDeps,
      );
      expect(ran.code).toBe(0);
      expect(ran.out).toContain('# ascii');

      const tested = await cli(['test', `${name}/*.gametest.mjs`], dir, realDeps);
      expect(tested.code).toBe(0);
      expect(tested.out).toContain(`PASS ${name} plays for 120 ticks`);
    },
  );

  it('scaffolds a game whose scene and tilemap both validate', async () => {
    const dir = makeDir();
    await cli(['scaffold', 'game', 'demo', '--mode', 'platformer'], dir, realDeps);
    const validated = await cli(
      ['validate', 'demo/demo.scene.json', 'demo/demo.tilemap.json'],
      dir,
      realDeps,
    );
    expect(validated.code).toBe(0);
    expect(validated.out).toContain('no problems found');
  });

  // Regression: the generated test said "Run with: aegis test" but imported bare
  // '@aegis/harness' with no package.json, so it died with `Cannot find package`.
  it('generates a test module with no bare package imports', async () => {
    const dir = makeDir();
    await cli(['scaffold', 'game', 'demo', '--mode', 'platformer'], dir);
    const source = readFileSync(join(dir, 'demo', 'demo.gametest.mjs'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports).toEqual(['node:url']);
  });

  // Regression: scaffold wrote artifacts one at a time and threw on the FIRST clash, leaving a
  // half-written directory that could only be completed with --force.
  it('writes nothing at all when any target already exists', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'demo.scene.json'), '{}', 'utf8');
    const r = await cli(['scaffold', 'scene', 'demo'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0006');
    expect(readFileSync(join(dir, 'demo.scene.json'), 'utf8')).toBe('{}');

    const forced = await cli(['scaffold', 'scene', 'demo', '--force'], dir);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(dir, 'demo.scene.json'), 'utf8')).toContain('scene/1');
  });

  it('--json lists every written file', async () => {
    const dir = makeDir();
    const r = await cli(['scaffold', 'game', 'demo', '--json'], dir);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as { files: string[] };
    expect(data.files).toEqual([
      'demo/aegis.json',
      'demo/demo.scene.json',
      'demo/demo.tilemap.json',
      'demo/demo.input',
      'demo/demo.gametest.mjs',
    ]);
  });

  /**
   * A scaffolded scene marks its entities (`Player`, `Goal`) with tags no stock mode registers,
   * so without a plugin declaration the CLI would rightly refuse to run it (`AEG-CLI-0020`).
   * Emitting `aegis.json` makes the correct configuration the default rather than something the
   * author has to know about — and is the one line they edit when the game grows its own plugin.
   */
  it('emits an aegis.json so the naive invocation resolves a plugin instead of failing', async () => {
    const dir = makeDir();
    await cli(['scaffold', 'game', 'demo', '--mode', 'platformer'], dir, realDeps);
    const config = JSON.parse(readFileSync(join(dir, 'demo', 'aegis.json'), 'utf8')) as {
      plugin: string;
    };
    expect(config.plugin).toBe('platformer');

    // The naive invocation: no --plugin, nothing hand-authored.
    const ran = await cli(
      ['run', 'demo/demo.scene.json', '--ticks', '120', '--input', 'demo/demo.input'],
      dir,
      realDeps,
    );
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('aegis.json');
  });
});

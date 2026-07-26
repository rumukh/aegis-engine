/**
 * End-to-end command tests: every command is *actually executed* against real fixtures (a scene,
 * an input script, and the package's own fake mode), and we assert on real output — not just
 * arg-parsing. This is how we prove the CLI runs, exactly as the harness proved its runner before
 * any mode existed. Cross-package `@aegis/*` specifiers resolve to built `dist`, so these tests
 * assume `npm run build` has run (as `npm run verify` does).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from './cli.js';
import type { CliDeps } from './cli.js';
import { createModeResolver } from './modes.js';
import { fakeMode } from './testing/fake-mode.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_MODE_DIST = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'testing', 'fake-mode.js')).href;

const deps: CliDeps = { modes: createModeResolver([fakeMode]) };

/** A captured CLI invocation. */
interface Run {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI with a fixed cwd, capturing stdout/stderr and the exit code. */
async function cli(argv: readonly string[], cwd: string): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main({ argv, cwd, out: (t) => (out += t), err: (t) => (err += t) }, deps);
  return { code, out, err };
}

/** The package's canonical fake-mode scene: a player, an enemy, and a goal volume. */
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
    {
      id: 'critter',
      tags: ['Enemy'],
      components: {
        Transform: { position: { x: 2, y: 0, z: 0 } },
        Health: { current: 1, max: 1 },
      },
    },
    {
      id: 'flag',
      components: {
        Transform: { position: { x: 5, y: 0, z: 0 } },
        Trigger: { kind: 'goal', shape: 'box', half: { x: 0.6, y: 1.5, z: 1 }, once: true },
      },
    },
  ],
};

const INPUT = 'hold Right 0..30\npress Fire @1';

const createdDirs: string[] = [];

/** Make a throwaway working directory seeded with the scene + input fixtures. */
function makeDir(): string {
  const dir = mkdtempSync(join(PACKAGE_ROOT, 'clitest-'));
  createdDirs.push(dir);
  writeFileSync(join(dir, 'level.scene.json'), JSON.stringify(SCENE, null, 2), 'utf8');
  writeFileSync(join(dir, 'walk.input'), INPUT, 'utf8');
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('aegis run', () => {
  it('simulates the scene and reports hash, entities and events as greppable text', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json', '--ticks', '30', '--input', 'walk.input'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^scene\s+: level\.scene\.json$/m);
    expect(r.out).toMatch(/^mode\s+: platformer$/m);
    expect(r.out).toMatch(/^ticks\s+: 30$/m);
    expect(r.out).toMatch(/^hash\s+: \S+$/m);
    expect(r.out).toMatch(/^entities\s+: 4$/m);
    expect(r.out).toContain('events:');
  });

  it('--hash prints only the bare hash, and it is stable across runs', async () => {
    const dir = makeDir();
    const a = await cli(
      ['run', 'level.scene.json', '--ticks', '30', '--input', 'walk.input', '--hash'],
      dir,
    );
    const b = await cli(
      ['run', 'level.scene.json', '--ticks', '30', '--input', 'walk.input', '--hash'],
      dir,
    );
    expect(a.code).toBe(0);
    expect(a.out.trim()).toMatch(/^[0-9a-f]+$/);
    expect(a.out).toBe(b.out);
  });

  it('--json emits a machine-readable result with seed and hash exposed', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json', '--ticks', '30', '--json'], dir);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as Record<string, unknown>;
    expect(data['mode']).toBe('platformer');
    expect(data['ticks']).toBe(30);
    expect(typeof data['hash']).toBe('string');
    expect(data['seed']).toBe('fixture-seed');
    expect(data['entities']).toBe(4);
  });

  it('--ascii renders the player glyph without a GPU', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json', '--ticks', '0', '--ascii'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('# ascii');
    expect(r.out).toContain('@');
  });
});

describe('aegis inspect', () => {
  it('dumps world state with component data an agent can read', async () => {
    const dir = makeDir();
    const r = await cli(['inspect', 'level.scene.json', '--tick', '0'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^tick\s+: 0$/m);
    expect(r.out).toContain('Transform = ');
    expect(r.out).toContain('Velocity = ');
    // Entity handles are decomposed: hero is slot index 0, generation 1 -> "#0".
    expect(r.out).toContain('#0 "hero"');
    expect(r.out).not.toContain('#4294967296');
  });

  it('--query filters the world dump and exposes packed + decomposed handles in JSON', async () => {
    const dir = makeDir();
    const r = await cli(['inspect', 'level.scene.json', '--query', 'has:Enemy', '--json'], dir);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as {
      matched: number;
      total: number;
      entities: { id: string; index: number; generation: number }[];
    };
    expect(data.matched).toBe(1);
    expect(data.total).toBe(4);
    const enemy = data.entities[0];
    expect(enemy).toBeDefined();
    expect(enemy!.index).toBe(1);
    expect(enemy!.generation).toBe(1);
    expect(enemy!.id).toBe('4294967297'); // raw packed handle preserved for tools
  });

  it('--view frame prints the structured semantic frame', async () => {
    const dir = makeDir();
    const r = await cli(['inspect', 'level.scene.json', '--view', 'frame'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('# frame');
    expect(r.out).toContain('mode=platformer');
    expect(r.out).toContain('#0'); // decomposed handle, not the packed 4294967296
    expect(r.out).not.toContain('#4294967296');
  });

  it('--view ascii prints the ASCII raster', async () => {
    const dir = makeDir();
    const r = await cli(['inspect', 'level.scene.json', '--view', 'ascii'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('# ascii');
    expect(r.out).toContain('@');
  });
});

describe('aegis validate', () => {
  it('accepts a good scene and exits 0', async () => {
    const dir = makeDir();
    const r = await cli(['validate', 'level.scene.json'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no problems found');
  });

  it('reports an unknown component with a stable code and exits 2', async () => {
    const dir = makeDir();
    const bad = {
      aegis: 'scene/1',
      name: 'bad',
      mode: 'platformer',
      entities: [{ id: 'x', components: { Nonexistent: {} } }],
    };
    writeFileSync(join(dir, 'bad.scene.json'), JSON.stringify(bad), 'utf8');
    const r = await cli(['validate', 'bad.scene.json'], dir);
    expect(r.code).toBe(2);
    expect(r.out).toContain('AEG-CONTENT');
    expect(r.out).toContain('unknown component');
  });

  it('--json reports ok:false for a bad document', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'bad.scene.json'), '{ not json', 'utf8');
    const r = await cli(['validate', 'bad.scene.json', '--json'], dir);
    expect(r.code).toBe(2);
    const data = JSON.parse(r.out) as { ok: boolean };
    expect(data.ok).toBe(false);
  });
});

describe('aegis record / replay', () => {
  it('records a run and replays it to an identical hash', async () => {
    const dir = makeDir();
    const rec = await cli(
      [
        'record',
        'level.scene.json',
        '--out',
        'run.replay.json',
        '--ticks',
        '30',
        '--input',
        'walk.input',
      ],
      dir,
    );
    expect(rec.code).toBe(0);
    expect(existsSync(join(dir, 'run.replay.json'))).toBe(true);

    const replay = await cli(['replay', 'run.replay.json'], dir);
    expect(replay.code).toBe(0);
    expect(replay.out).toMatch(/^match\s+: yes$/m);

    const asJson = await cli(['replay', 'run.replay.json', '--json'], dir);
    const data = JSON.parse(asJson.out) as {
      match: boolean;
      expectedHash: string;
      actualHash: string;
    };
    expect(data.match).toBe(true);
    expect(data.actualHash).toBe(data.expectedHash);
  });

  it('detects a tampered recording and exits 1 with a determinism error', async () => {
    const dir = makeDir();
    await cli(['record', 'level.scene.json', '--out', 'run.replay.json', '--ticks', '30'], dir);
    const recPath = join(dir, 'run.replay.json');
    const rec = JSON.parse(readFileSync(recPath, 'utf8')) as { finalHash: string };
    rec.finalHash = 'deadbeefdeadbeef';
    writeFileSync(recPath, JSON.stringify(rec), 'utf8');

    const replay = await cli(['replay', 'run.replay.json'], dir);
    expect(replay.code).toBe(1);
    expect(replay.err).toContain('AEG-CLI-0007');
    expect(replay.err).toContain('determinism');
  });
});

describe('aegis test', () => {
  /** Write a self-locating gametest module into `dir`. */
  function writeGameTest(
    dir: string,
    file: string,
    name: string,
    query: string,
    assertion = `entityExists(${query})`,
  ): void {
    const scene = join(dir, 'level.scene.json').split('\\').join('\\\\');
    const src = [
      `import { defineGameTest, expectSim } from '@aegis/harness';`,
      `import { fakeMode } from '${FAKE_MODE_DIST}';`,
      `export default defineGameTest({`,
      `  name: '${name}',`,
      `  scene: '${scene}',`,
      `  ticks: 30,`,
      `  options: { plugin: fakeMode },`,
      `  input: 'hold Right 0..30',`,
      `  expect(result) { expectSim(result).${assertion}; },`,
      `});`,
      ``,
    ].join('\n');
    writeFileSync(join(dir, file), src, 'utf8');
  }

  it('runs a passing gametest and exits 0', async () => {
    const dir = makeDir();
    writeGameTest(dir, 'pass.gametest.mjs', 'player spawns', `{ has: ['Player'] }`);
    const r = await cli(['test'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS player spawns');
    expect(r.out).toContain('1 passed, 0 failed');
  });

  it('runs a failing gametest, prints the harness message, and exits 1', async () => {
    const dir = makeDir();
    writeGameTest(dir, 'fail.gametest.mjs', 'dragon exists', `{ has: ['Dragon'] }`);
    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL dragon exists');
    expect(r.out).toContain('Expected at least one entity matching has:[Dragon]');
  });

  it('decomposes packed handles in harness failure messages (pretty + json)', async () => {
    const dir = makeDir();
    // entityCount fails while the Player DOES match, so the harness samples it as `#<packed> "name"`.
    writeGameTest(
      dir,
      'count.gametest.mjs',
      'one player only',
      `{ has: ['Player'] }`,
      `entityCount({ has: ['Player'] }, 5)`,
    );
    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Matched entities:');
    // The sampled handle is decomposed, not the raw packed integer.
    expect(r.out).toContain('#0 "hero"');
    expect(r.out).not.toContain('#4294967296');

    const j = await cli(['test', '--json'], dir);
    const data = JSON.parse(j.out) as { tests: { error?: string }[] };
    expect(data.tests[0]!.error).toContain('#0 "hero"');
    expect(data.tests[0]!.error).not.toContain('#4294967296');
  });

  it('--reporter tap emits TAP', async () => {
    const dir = makeDir();
    writeGameTest(dir, 'pass.gametest.mjs', 'player spawns', `{ has: ['Player'] }`);
    const r = await cli(['test', '--reporter', 'tap'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('TAP version 13');
    expect(r.out).toContain('ok 1 - player spawns');
  });

  it('--json summarises pass/fail counts', async () => {
    const dir = makeDir();
    writeGameTest(dir, 'fail.gametest.mjs', 'dragon exists', `{ has: ['Dragon'] }`);
    const r = await cli(['test', '--json'], dir);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.out) as { passed: number; failed: number; total: number };
    expect(data).toMatchObject({ passed: 0, failed: 1, total: 1 });
  });

  it('exits 1 with a stable code when no tests are discovered', async () => {
    const dir = makeDir();
    const r = await cli(['test'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0008');
  });
});

describe('aegis scaffold', () => {
  it('scaffolds a game whose generated scene validates', async () => {
    const dir = makeDir();
    const r = await cli(['scaffold', 'game', 'demo', '--mode', 'platformer'], dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'demo', 'demo.scene.json'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'demo.tilemap.json'))).toBe(true);
    expect(existsSync(join(dir, 'demo', 'demo.gametest.mjs'))).toBe(true);

    const validated = await cli(
      ['validate', 'demo/demo.scene.json', 'demo/demo.tilemap.json'],
      dir,
    );
    expect(validated.code).toBe(0);
    expect(validated.out).toContain('no problems found');
  });

  it('--json lists the written files', async () => {
    const dir = makeDir();
    const r = await cli(['scaffold', 'scene', 'lvl2', '--json'], dir);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as { kind: string; files: string[] };
    expect(data.kind).toBe('scene');
    expect(data.files).toContain('lvl2.scene.json');
  });

  it('refuses to overwrite without --force, then succeeds with it', async () => {
    const dir = makeDir();
    const first = await cli(['scaffold', 'scene', 'dup'], dir);
    expect(first.code).toBe(0);
    const clash = await cli(['scaffold', 'scene', 'dup'], dir);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('AEG-CLI-0006');
    const forced = await cli(['scaffold', 'scene', 'dup', '--force'], dir);
    expect(forced.code).toBe(0);
  });
});

describe('actionable errors', () => {
  it('teaches the user when a mode is unknown', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json', '--ticks', '10', '--mode', 'nope'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0003');
    expect(r.err).toContain('fix:');
  });

  it('teaches the user when a required flag is missing', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0001');
  });
});

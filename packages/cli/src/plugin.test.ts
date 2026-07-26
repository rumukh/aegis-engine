/**
 * Regression tests for the plugin extension point and the diagnostics around it.
 *
 * Each `it` here maps to a defect the CLI shipped with, and each fails on the pre-fix code:
 * a game's composed plugin was unreachable, a scene whose components the plugin does not provide
 * ran anyway and reported success, a huge `--ticks` died in a V8 OOM with no diagnostic, and a
 * missing ASCII view was blamed on the mode instead of the world.
 *
 * Cross-package `@aegis/*` specifiers resolve to built `dist`, so these tests assume
 * `npm run build` has run (as `npm run verify` does).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from './cli.js';
import type { CliDeps } from './cli.js';
import { createModeResolver } from './modes.js';
import { isModePlugin } from './plugin.js';
import { fakeMode } from './testing/fake-mode.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_MODE_DIST = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'testing', 'fake-mode.js')).href;

const deps: CliDeps = { modes: createModeResolver([fakeMode]) };

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: readonly string[], cwd: string): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main({ argv, cwd, out: (t) => (out += t), err: (t) => (err += t) }, deps);
  return { code, out, err };
}

/**
 * A scene using a component the *stock* fake mode does not provide — the shape of every shipped
 * game (`Patrol` on the platformer critter, `GruntAi` on the fps grunt).
 */
const GAME_SCENE = {
  aegis: 'scene/1',
  name: 'game-level',
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
        Patrol: { minX: 1, maxX: 3 },
      },
    },
  ],
};

/** A composed plugin module: the mode plugin plus the game's own component. */
const GAME_PLUGIN = [
  `import { defineComponent } from '@aegis/core';`,
  `import { fakeMode } from '${FAKE_MODE_DIST}';`,
  `export const Patrol = defineComponent({ id: 'Patrol', defaults: () => ({ minX: 0, maxX: 0 }) });`,
  `export const gamePlugin = {`,
  `  mode: 'platformer',`,
  `  components: () => [...fakeMode.components(), Patrol],`,
  `  systems: () => fakeMode.systems(),`,
  `  init: (world) => fakeMode.init?.(world),`,
  `  view: () => fakeMode.view(),`,
  `};`,
  `export const notAPlugin = { mode: 'platformer' };`,
  ``,
].join('\n');

/** A plugin whose view provider genuinely has no ASCII projection. */
const NO_ASCII_PLUGIN = [
  `import { fakeMode } from '${FAKE_MODE_DIST}';`,
  `export const blindPlugin = {`,
  `  mode: 'platformer',`,
  `  components: () => fakeMode.components(),`,
  `  systems: () => fakeMode.systems(),`,
  `  init: (world) => fakeMode.init?.(world),`,
  `  view: () => ({`,
  `    mode: 'platformer',`,
  `    semanticFrame: (w, o) => fakeMode.view().semanticFrame(w, o),`,
  `    asciiView: () => undefined,`,
  `  }),`,
  `};`,
  ``,
].join('\n');

const createdDirs: string[] = [];

/** A throwaway working directory holding the game scene and the composed plugin module. */
function makeDir(scene: unknown = GAME_SCENE): string {
  const dir = mkdtempSync(join(PACKAGE_ROOT, 'plugintest-'));
  createdDirs.push(dir);
  writeFileSync(join(dir, 'level.scene.json'), JSON.stringify(scene, null, 2), 'utf8');
  writeFileSync(join(dir, 'game-plugin.mjs'), GAME_PLUGIN, 'utf8');
  writeFileSync(join(dir, 'blind-plugin.mjs'), NO_ASCII_PLUGIN, 'utf8');
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('isModePlugin', () => {
  it('accepts a real plugin and rejects look-alikes', () => {
    expect(isModePlugin(fakeMode)).toBe(true);
    expect(isModePlugin({ mode: 'platformer' })).toBe(false);
    expect(
      isModePlugin({ mode: 'nope', components: () => [], systems: () => ({}), view: () => ({}) }),
    ).toBe(false);
    expect(isModePlugin(null)).toBe(false);
  });
});

describe('aegis run --plugin (the game plugin extension point)', () => {
  // Regression: there was no --plugin flag at all, so a game's composed plugin — the blessed
  // engine-wide pattern — was unreachable from run/inspect/validate/record/replay.
  it('runs a scene under a composed plugin named as <module>#<export>', async () => {
    const dir = makeDir();
    const r = await cli(
      ['run', 'level.scene.json', '--ticks', '10', '--plugin', './game-plugin.mjs#gamePlugin'],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^plugin\s+: \.\/game-plugin\.mjs#gamePlugin \(--plugin\)$/m);
  });

  // Regression: a scene whose components no registered plugin provides used to run to
  // completion and print a clean hash — the single worst failure mode in this project.
  it('refuses to run a scene the stock plugin cannot provide components for', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json', '--ticks', '10'], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('AEG-CLI-0018');
    expect(r.err).toContain('Patrol');
    expect(r.err).toContain('--plugin');
    expect(r.out).toBe('');
  });

  it('reports the refusal as JSON with the unknown components listed', async () => {
    const dir = makeDir();
    const r = await cli(['run', 'level.scene.json', '--ticks', '10', '--json'], dir);
    expect(r.code).toBe(2);
    const data = JSON.parse(r.err) as {
      error: { code: string; data: { unknownComponents: string[]; pluginSource: string } };
    };
    expect(data.error.code).toBe('AEG-CLI-0018');
    expect(data.error.data.unknownComponents).toEqual(['Patrol']);
    expect(data.error.data.pluginSource).toBe('mode');
  });

  // Regression: an iso game scene validated fine against the stock plugin (its game vocabulary
  // is tags, not components) and ran "successfully" with none of its systems installed. Nothing
  // in the output said which plugin ran, so the lie was undetectable.
  it('always states which plugin actually ran, in pretty and JSON', async () => {
    const dir = makeDir({ ...GAME_SCENE, entities: [GAME_SCENE.entities[0]] });
    const pretty = await cli(['run', 'level.scene.json', '--ticks', '5'], dir);
    expect(pretty.out).toMatch(
      /^plugin\s+: platformer \(stock mode plugin — no --plugin given\)$/m,
    );

    const asJson = await cli(['run', 'level.scene.json', '--ticks', '5', '--json'], dir);
    const data = JSON.parse(asJson.out) as {
      plugin: { spec: string; source: string; systems: string[] };
    };
    expect(data.plugin.spec).toBe('platformer');
    expect(data.plugin.source).toBe('mode');
  });

  it('reports a missing plugin module with a stable code and a real fix', async () => {
    const dir = makeDir();
    const r = await cli(
      ['run', 'level.scene.json', '--ticks', '5', '--plugin', './nope.mjs#gamePlugin'],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0015');
    expect(r.err).toContain('nope.mjs');
  });

  it('reports an export that is not a ModePlugin, listing the ones that are', async () => {
    const dir = makeDir();
    const r = await cli(
      ['run', 'level.scene.json', '--ticks', '5', '--plugin', './game-plugin.mjs#notAPlugin'],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0016');
    expect(r.err).toContain('gamePlugin');
  });

  it('rejects a plugin whose mode disagrees with the scene', async () => {
    const dir = makeDir();
    const r = await cli(
      [
        'run',
        'level.scene.json',
        '--ticks',
        '5',
        '--mode',
        'iso',
        '--plugin',
        './game-plugin.mjs#gamePlugin',
      ],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0017');
  });
});

describe('run composition is reported, not assumed', () => {
  /**
   * The iso defect could not be caught by the unknown-component gate: a game's iso vocabulary is
   * *tags* (`Operative`, `Guard`, `Patrol`), and a scene tag is free-form by design, so an
   * unregistered one cannot be an error. It is never nothing, though — a marker no plugin
   * provides is a marker no system reads, and that is exactly the difference between "the game
   * ran" and "the stock mode ran over the game's scene".
   */
  it('names scene markers the running plugin does not provide', async () => {
    const dir = makeDir({
      ...GAME_SCENE,
      entities: [
        { ...GAME_SCENE.entities[0]!, tags: ['Player', 'Operative', 'Guard'] },
        {
          ...GAME_SCENE.entities[1]!,
          components: { Transform: { position: { x: 2, y: 0, z: 0 } } },
        },
      ],
    });
    const r = await cli(['run', 'level.scene.json', '--ticks', '5'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^markers\s+: Guard, Operative$/m);
    expect(r.out).toContain('no system reads them');
    // `Player` IS provided by the fake mode, so it must not be listed.
    expect(r.out).not.toContain('Player,');
  });

  it('says nothing about markers when the plugin provides them all', async () => {
    const dir = makeDir({
      ...GAME_SCENE,
      entities: [{ ...GAME_SCENE.entities[0]!, tags: ['Player'] }],
    });
    const r = await cli(['run', 'level.scene.json', '--ticks', '5'], dir);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('markers');
  });

  it('reports the schedule size, so a missing game layer is visible as data', async () => {
    const dir = makeDir({ ...GAME_SCENE, entities: [GAME_SCENE.entities[0]] });
    const r = await cli(['run', 'level.scene.json', '--ticks', '5'], dir);
    expect(r.out).toMatch(/^systems\s+: \d+$/m);

    const asJson = await cli(['run', 'level.scene.json', '--ticks', '5', '--json'], dir);
    const data = JSON.parse(asJson.out) as {
      plugin: { systems: string[] };
      unregisteredMarkers: string[];
    };
    expect(data.plugin.systems.length).toBeGreaterThan(0);
    expect(data.unregisteredMarkers).toEqual([]);
  });

  it('still surfaces markers on --hash, via stderr so the captured hash stays clean', async () => {
    const dir = makeDir({
      ...GAME_SCENE,
      entities: [{ ...GAME_SCENE.entities[0]!, tags: ['Operative'] }],
    });
    const r = await cli(['run', 'level.scene.json', '--ticks', '5', '--hash'], dir);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^[0-9a-f]+$/);
    expect(r.err).toContain('Operative');
  });
});

describe('aegis.json plugin discovery', () => {
  it('uses the nearest aegis.json when no --plugin is given, and says so', async () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'aegis.json'),
      '{ "plugin": "./game-plugin.mjs#gamePlugin" }\n',
      'utf8',
    );
    const r = await cli(['run', 'level.scene.json', '--ticks', '10'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('aegis.json');
    expect(r.out).toContain('game-plugin.mjs#gamePlugin');
  });
});

describe('aegis inspect / validate honour the plugin', () => {
  it('inspect runs the composed plugin and reports its provenance', async () => {
    const dir = makeDir();
    const r = await cli(
      ['inspect', 'level.scene.json', '--tick', '5', '--plugin', './game-plugin.mjs#gamePlugin'],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('game-plugin.mjs#gamePlugin');
    expect(r.out).toContain('Patrol = ');
  });

  // Regression: `aegis validate` on every shipped game scene exited 2 with
  // "unknown component", because it could only ever use the stock mode's components.
  it('validate accepts a game scene against its composed plugin', async () => {
    const dir = makeDir();
    const bare = await cli(['validate', 'level.scene.json'], dir);
    expect(bare.code).toBe(2);
    expect(bare.out).toContain('AEG-CONTENT-0005');

    const withPlugin = await cli(
      ['validate', 'level.scene.json', '--plugin', './game-plugin.mjs#gamePlugin'],
      dir,
    );
    expect(withPlugin.code).toBe(0);
    expect(withPlugin.out).toContain('no problems found');
  });

  // Regression: the help advertised `aegis validate *.scene.json`, but validate never globbed,
  // so on Windows (no shell expansion) it failed with "File not found: ...\*.scene.json".
  it('validate expands a glob positional itself', async () => {
    const dir = makeDir({ ...GAME_SCENE, entities: [GAME_SCENE.entities[0]] });
    const r = await cli(['validate', '*.scene.json'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no problems found');
  });

  it('validate reports an unmatched glob rather than pretending it checked something', async () => {
    const dir = makeDir();
    const r = await cli(['validate', '*.prefab.json'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0004');
    expect(r.err).toContain('No files matched');
  });
});

describe('aegis record / replay carry the plugin', () => {
  it('records which plugin ran and replays with it, with no flag', async () => {
    const dir = makeDir();
    const rec = await cli(
      [
        'record',
        'level.scene.json',
        '--out',
        'run.replay.json',
        '--ticks',
        '20',
        '--plugin',
        './game-plugin.mjs#gamePlugin',
      ],
      dir,
    );
    expect(rec.code).toBe(0);

    const replay = await cli(['replay', 'run.replay.json'], dir);
    expect(replay.code).toBe(0);
    expect(replay.out).toMatch(/^match\s+: yes$/m);
    expect(replay.out).toContain('(from the recording)');
  });
});

describe('aegis run --ticks limits', () => {
  // Regression: `--ticks 100000000` spent 35s thrashing GC and died in a V8 out-of-memory
  // abort with a native stack trace, exit 134, and no AEG-CLI-#### code at all.
  it('refuses an implausible tick count with a stable code instead of an OOM', async () => {
    const dir = makeDir({ ...GAME_SCENE, entities: [GAME_SCENE.entities[0]] });
    const r = await cli(['run', 'level.scene.json', '--ticks', '100000000', '--hash'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0019');
    expect(r.err).toContain('--max-ticks');
  });

  it('honours an explicit --max-ticks ceiling in both directions', async () => {
    const dir = makeDir({ ...GAME_SCENE, entities: [GAME_SCENE.entities[0]] });
    const refused = await cli(
      ['run', 'level.scene.json', '--ticks', '5000', '--max-ticks', '100', '--hash'],
      dir,
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('AEG-CLI-0019');
    expect(refused.err).toContain('tick limit of 100');

    const allowed = await cli(
      ['run', 'level.scene.json', '--ticks', '50', '--max-ticks', '100', '--hash'],
      dir,
    );
    expect(allowed.code).toBe(0);
    expect(allowed.out.trim()).toMatch(/^[0-9a-f]+$/);
  });
});

describe('missing ASCII view diagnostics', () => {
  // Regression: AEG-CLI-0009 said "Mode X has no ASCII view" for any undefined result, so an
  // agent was told the entire platformer mode had none when the scene simply had no tilemap.
  it('blames the world, not the mode, when the world has no resources', async () => {
    const dir = makeDir({ ...GAME_SCENE, entities: [GAME_SCENE.entities[0]] });
    const r = await cli(
      [
        'run',
        'level.scene.json',
        '--ticks',
        '1',
        '--ascii',
        '--plugin',
        './blind-plugin.mjs#blindPlugin',
      ],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('AEG-CLI-0009');
    expect(r.err).toContain('THIS WORLD');
    expect(r.err).not.toMatch(/Mode "platformer" has no ASCII view/);
  });

  it('names the empty grid resource when there is one', async () => {
    const dir = makeDir({
      ...GAME_SCENE,
      entities: [GAME_SCENE.entities[0]],
      resources: { 'demo.collision': { width: 0, height: 8, solid: [] } },
    });
    const r = await cli(
      [
        'run',
        'level.scene.json',
        '--ticks',
        '1',
        '--ascii',
        '--json',
        '--plugin',
        './blind-plugin.mjs#blindPlugin',
      ],
      dir,
    );
    expect(r.code).toBe(1);
    const data = JSON.parse(r.err) as {
      error: { code: string; data: { cause: string; emptyGridResources: string[] } };
    };
    expect(data.error.code).toBe('AEG-CLI-0009');
    expect(data.error.data.cause).toBe('world-grid-is-empty');
    expect(data.error.data.emptyGridResources).toEqual(['demo.collision']);
  });
});

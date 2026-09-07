import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CapabilityDescription } from './capabilities.js';
import type { EntityPage, ResourceProjection, ResourceSummary } from './inspection.js';
import {
  makeFixtureDir,
  PACKAGE_ROOT,
  removeFixtureDir,
  sweepStaleFixtures,
} from './testing/fixtures.js';

sweepStaleFixtures();
const ROOT = resolve(PACKAGE_ROOT, '..', '..');
const BIN = join(PACKAGE_ROOT, 'bin', 'aegis.mjs');
const dirs: string[] = [];

interface CliResult {
  code: number;
  out: string;
  err: string;
}

/** Use the installed bin and built modules, including their actual schema identity WeakMap. */
function cli(args: readonly string[], cwd = ROOT): CliResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) throw new Error(`CLI terminated on signal ${result.signal}`);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function capabilities(args: readonly string[], cwd = ROOT): CapabilityDescription {
  const result = cli(['describe', ...args, '--json'], cwd);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toBe('');
  return JSON.parse(result.out) as CapabilityDescription;
}

const BASE_COMPONENTS = [
  'Dead',
  'Health',
  'Light',
  'Model',
  'Name',
  'Sprite',
  'Transform',
  'Trigger',
  'Triggered',
];

const STOCK = [
  {
    mode: 'platformer',
    components: [
      'BodyState',
      'KinematicPlatform',
      'PlatformerCamera',
      'PlatformerController',
      'TileCollider',
      'Velocity',
    ],
    resources: ['platformer.collision', 'platformer.tilemap'],
    systems: [
      'platformer.intake',
      'platformer.gravity',
      'platformer.platform',
      'platformer.integrate',
      'platformer.camera',
    ],
  },
  {
    mode: 'iso',
    components: [
      'AttackOrder',
      'Attacker',
      'Blocking',
      'Controlled',
      'GridPosition',
      'IsoActor',
      'IsoCamera',
      'MoveOrder',
    ],
    resources: ['IsoGrid', 'NavGrid'],
    systems: [
      'iso.intake',
      'iso.cooldown',
      'iso.pathfind',
      'iso.move',
      'iso.combat',
      'iso.trigger',
      'iso.camera',
      'content.health.death',
    ],
  },
  {
    mode: 'fps',
    components: ['CapsuleBody', 'FpsCamera', 'FpsController', 'HitBox', 'Hitscan', 'LookState'],
    resources: ['fps.collision', 'fps.floorplan'],
    systems: [
      'fps.look',
      'fps.intake',
      'fps.gravity',
      'fps.integrate',
      'fps.hitscan',
      'fps.camera',
    ],
  },
] as const;

const GAMES = [
  {
    stock: STOCK[0],
    level: 'coyote-gap',
    spec: '@aegis/game-platformer#coyoteGapPlugin',
    components: ['Critter', 'LethalHit', 'Patrol', 'Player'],
    systems: [
      'platformer.intake',
      'platformer.gravity',
      'game.patrol',
      'platformer.platform',
      'platformer.integrate',
      'game.stompgore',
      'platformer.camera',
      'game.hazard',
      'content.health.death',
      'game.goal',
      'game.deathmap',
    ],
  },
  {
    stock: STOCK[1],
    level: 'server-vault',
    spec: '@aegis/game-iso#serverVaultPlugin',
    components: ['Guard', 'Hostile', 'Operative', 'Patrol'],
    systems: [
      'iso.intake',
      'iso.cooldown',
      'game.patrol',
      'game.detect',
      'iso.pathfind',
      'iso.move',
      'iso.combat',
      'iso.trigger',
      'iso.camera',
      'content.health.death',
      'game.objectives',
      'game.death',
    ],
  },
  {
    stock: STOCK[2],
    level: 'sector-breach',
    spec: '@aegis/game-fps#sectorBreachPlugin',
    components: ['Button', 'Enemy', 'GruntAi', 'LethalHit', 'Player'],
    systems: [
      'fps.look',
      'fps.intake',
      'fps.gravity',
      'fps.integrate',
      'fps.hitscan',
      'game.grunt.ai',
      'fps.camera',
      'game.door',
      'game.enemy.damage',
      'game.hazard',
      'content.health.death',
      'game.death.map',
      'game.goal',
    ],
  },
] as const;

const PLUGIN = `
import { createSchedule, defineComponent, defineResource, defineTag, Name, Transform } from '@aegis/core';
import { describeComponent } from '@aegis/content';
import { platformerPlugin } from '@aegis/mode-platformer';

const Config = defineComponent({
  id: 'WorkbenchConfig',
  defaults: () => ({
    speed: 4, flavor: 'calm', active: true, constructor: 'safe',
    nested: { axis: { x: 1, y: 2 } }, routes: [], data: {}, token: null
  }),
});
describeComponent(Config, {
  optional: { note: 'string', extra: 'object', optionalNull: 'null', items: 'array' },
  enums: { flavor: ['calm', 'bold'] },
});
const Settings = defineResource('fixture.settings', () => {
  throw new Error('Discovery must not create resource values');
});
const forbidden = () => { throw new Error('Discovery must not initialize, step or project'); };
export const declarations = {
  mode: 'platformer',
  components: () => [Config],
  resources: () => [Settings, 'fixture.empty'],
  prefabs: () => [
    { aegis: 'prefab/1', name: 'z-crate', components: { WorkbenchConfig: { flavor: 'bold' } },
      children: [{ id: 'lid', components: { Transform: {} } }] },
    { aegis: 'prefab/1', name: 'a-marker', tags: ['Marker'] },
  ],
  init: forbidden,
  view: forbidden,
  systems: () => createSchedule()
    .add({ name: 'last', phase: 'cleanup', after: ['uninstalled.external-system', 'input'], run: forbidden })
    .add({ name: 'later', after: ['first'], run: forbidden })
    .add({ name: 'first', run: forbidden })
    .add({ name: 'input', phase: 'input', run: forbidden }),
};
const Original = defineComponent({ id: 'IdentitySplit', defaults: () => ({ value: '' }) });
describeComponent(Original, { optional: { annotation: 'string' } });
const Replacement = defineComponent({ id: 'IdentitySplit', defaults: () => ({ value: '' }) });
export const identityPlugin = { ...declarations, components: () => [Replacement] };
export const duplicatePrefabs = {
  ...declarations,
  prefabs: () => [{ aegis: 'prefab/1', name: 'duplicate' }, { aegis: 'prefab/1', name: 'duplicate' }],
};
export const cyclic = {
  ...declarations,
  systems: () => createSchedule()
    .add({ name: 'a', after: ['b'], run: forbidden })
    .add({ name: 'b', after: ['a'], run: forbidden }),
};
export const invalid = { mode: 'platformer' };
export const empty = {
  mode: 'platformer',
  components: () => [],
  systems: () => createSchedule(),
  view: () => platformerPlugin.view(),
};
export const scalarResources = { ...empty, resources: () => ['enabled', 'nil', 'number'] };

const Observed = defineTag('Observed');
const Recycled = defineTag('Recycled');
const Progress = defineResource('runtime.progress', () => ({ ticks: 0 }));
export const observation = {
  mode: 'platformer',
  components: () => [Observed, Recycled],
  resources: () => ['alpha.settings', 'list', 'message'],
  init(world) {
    world.despawn(world.query({ has: [Recycled] }).one().entity);
    world.spawn(Name({ value: 'replacement' }), Observed(), Transform({ position: { x: 10, y: 0, z: 0 } }));
    world.setResource(Progress, { ticks: 0 });
  },
  view: () => platformerPlugin.view(),
  systems: () => createSchedule().add({
    name: 'advance-all',
    run({ world }) {
      for (const entity of world.query({ has: [Observed, Transform] }).views()) {
        entity.get(Transform).position.x += 1;
      }
      world.setResource(Progress, { ticks: world.tick + 1 });
    },
  }),
};
`;

function fixture(): string {
  const dir = makeFixtureDir();
  dirs.push(dir);
  writeFileSync(join(dir, 'plugin.mjs'), PLUGIN, 'utf8');
  return dir;
}

function observationFixture(): string {
  const dir = fixture();
  writeFileSync(join(dir, 'aegis.json'), JSON.stringify({ plugin: './plugin.mjs#observation' }));
  writeFileSync(
    join(dir, 'world.scene.json'),
    JSON.stringify({
      aegis: 'scene/1',
      name: 'observation',
      mode: 'platformer',
      seed: 'workbench',
      resources: {
        message: 'ready',
        list: [1, 2, 3, 4],
        'alpha.settings': { answer: 42, label: 'untouched' },
      },
      entities: [
        { id: 'alpha', tags: ['Observed', 'Recycled'], components: { Transform: {} } },
        {
          id: 'beta',
          tags: ['Observed'],
          components: { Transform: { position: { x: 1, y: 0, z: 0 } } },
        },
        { id: 'camera', components: { Transform: { position: { x: 2, y: 0, z: 0 } } } },
        {
          id: 'gamma',
          tags: ['Observed'],
          components: { Transform: { position: { x: 3, y: 0, z: 0 } } },
        },
        {
          id: 'delta',
          tags: ['Observed'],
          components: { Transform: { position: { x: 4, y: 0, z: 0 } } },
        },
      ],
    }),
  );
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeFixtureDir(dir);
});

describe('aegis describe: built CLI acceptance', () => {
  it.each(STOCK)(
    'discovers the real $mode mode, deterministically and without a scene',
    (stock) => {
      const args = ['describe', '--mode', stock.mode, '--json'];
      const first = cli(args);
      const second = cli(args);
      expect(first.code, first.err).toBe(0);
      expect(second.code, second.err).toBe(0);
      expect(second.out).toBe(first.out);
      const data = JSON.parse(first.out) as CapabilityDescription;
      expect(data.aegis).toBe('capabilities/1');
      expect(data.scene).toBeNull();
      expect(data.plugin).toEqual({ mode: stock.mode, source: 'mode', spec: stock.mode });
      expect(data.components.map((c) => c.id)).toEqual(
        [...BASE_COMPONENTS, ...stock.components].sort(),
      );
      expect(data.resources).toEqual({ declared: true, ids: stock.resources, valueSchemas: null });
      expect(data.systems.order.map((s) => s.name)).toEqual(stock.systems);
      expect(data.systems.unresolved).toEqual([]);
      const explicit = capabilities(['--plugin', stock.mode]);
      expect(explicit.plugin.source).toBe('flag');
      expect(explicit.components).toEqual(data.components);
    },
  );

  it.each(GAMES)(
    'discovers the composed $level plugin through scene, flag and cwd config',
    (game) => {
      const gameDir = join(ROOT, 'games', game.stock.mode);
      const scene = join('games', game.stock.mode, 'levels', `${game.level}.scene.json`);
      const data = capabilities([scene]);
      expect(data.plugin).toEqual({
        mode: game.stock.mode,
        spec: game.spec,
        source: 'config',
        configFile: join(gameDir, 'aegis.json'),
      });
      expect(data.components.map((c) => c.id)).toEqual(
        [...BASE_COMPONENTS, ...game.stock.components, ...game.components].sort(),
      );
      expect(data.resources.ids).toEqual(game.stock.resources);
      expect(data.systems.order.map((s) => s.name)).toEqual(game.systems);
      expect(data.systems.unresolved).toEqual([]);
      expect(data.prefabs).toEqual({ catalog: [], declared: false, expanded: false });

      const explicit = capabilities(['--plugin', game.spec]);
      expect(explicit.plugin).toEqual({ mode: game.stock.mode, spec: game.spec, source: 'flag' });
      expect(explicit.components).toEqual(data.components);
      const fromCwd = capabilities([], join(gameDir, 'levels'));
      expect(fromCwd.plugin).toEqual(data.plugin);
      expect(fromCwd.scene).toBeNull();
    },
  );

  it('reflects actual optional/enumerated/nested schema facts, without inventing ranges or unions', () => {
    const data = capabilities(['--plugin', './plugin.mjs#declarations'], fixture());
    const config = data.components.find((c) => c.id === 'WorkbenchConfig')!;
    expect(config.schema).toEqual({
      optional: { note: 'string', extra: 'object', optionalNull: 'null', items: 'array' },
      enums: { flavor: ['calm', 'bold'] },
    });
    expect(config.schemaStatus).toBe('declared');
    expect(config.additionalFields).toBe(false);
    expect(config.fields.map((f) => f.name)).toEqual([
      'active',
      'constructor',
      'data',
      'extra',
      'flavor',
      'items',
      'nested',
      'note',
      'optionalNull',
      'routes',
      'speed',
      'token',
    ]);
    expect(config.fields.every((f) => f.required === false)).toBe(true);
    expect(config.fields.find((f) => f.name === 'speed')).toEqual({
      name: 'speed',
      source: 'default',
      required: false,
      value: { kind: 'number', finite: true },
    });
    expect(config.fields.find((f) => f.name === 'nested')?.value).toEqual({
      kind: 'object',
      additionalFields: false,
      requiredKeys: ['axis'],
      fields: {
        axis: {
          kind: 'object',
          additionalFields: false,
          requiredKeys: ['x', 'y'],
          fields: { x: { kind: 'number', finite: true }, y: { kind: 'number', finite: true } },
        },
      },
    });
    expect(config.fields.find((f) => f.name === 'token')?.value).toEqual({ kind: 'any' });
    expect(config.fields.find((f) => f.name === 'optionalNull')?.value).toEqual({ kind: 'null' });
    expect(config.fields.find((f) => f.name === 'extra')?.value).toEqual({
      kind: 'object',
      additionalFields: true,
    });
    expect(config.fields.find((f) => f.name === 'data')?.value).toEqual({
      kind: 'object',
      additionalFields: true,
      fields: {},
      requiredKeys: [],
    });
    expect(config.fields.find((f) => f.name === 'routes')?.value).toEqual({
      kind: 'array',
      items: 'serialisable',
    });
    expect(config.fields.find((f) => f.name === 'flavor')?.stringEnum).toEqual(['calm', 'bold']);
    expect(config.fields.find((f) => f.name === 'constructor')?.stringEnum).toBeUndefined();
    const trigger = data.components.find((c) => c.id === 'Trigger')!;
    expect(trigger.fields.find((f) => f.name === 'shape')?.stringEnum).toEqual(['box', 'sphere']);
    expect(trigger.fields.find((f) => f.name === 'kind')?.stringEnum).toBeUndefined();
    expect(trigger.defaults).toEqual({
      kind: 'goal',
      shape: 'box',
      half: { x: 0.5, y: 0.5, z: 0.5 },
      radius: 0.5,
      once: true,
    });
    expect(data.limits.join(' ')).toContain('not a complete JSON Schema');
    expect(data.limits.join(' ')).toContain('not evidence that gameplay is correct');
  });

  it('exposes declarations and real scheduler order without calling init, run, view or resource factories', () => {
    const data = capabilities(['--plugin', './plugin.mjs#declarations'], fixture());
    expect(data.resources.ids).toEqual(['fixture.empty', 'fixture.settings']);
    expect(data.systems.phases).toEqual([
      'input',
      'preUpdate',
      'update',
      'physics',
      'postUpdate',
      'events',
      'cleanup',
    ]);
    expect(data.systems.order.map((s) => [s.index, s.phase, s.name])).toEqual([
      [0, 'input', 'input'],
      [1, 'update', 'first'],
      [2, 'update', 'later'],
      [3, 'cleanup', 'last'],
    ]);
    expect(data.systems.unresolved).toEqual([
      { system: 'last', kind: 'after', name: 'uninstalled.external-system' },
    ]);
    expect(data.prefabs.expanded).toBe(false);
    expect(data.prefabs.catalog).toEqual([
      { aegis: 'prefab/1', name: 'a-marker', tags: ['Marker'] },
      {
        aegis: 'prefab/1',
        name: 'z-crate',
        components: { WorkbenchConfig: { flavor: 'bold' } },
        children: [{ id: 'lid', components: { Transform: {} } }],
      },
    ]);
  });

  it('reports identity-keyed schema misses instead of borrowing another component declaration', () => {
    const data = capabilities(['--plugin', './plugin.mjs#identityPlugin'], fixture());
    const split = data.components.find((c) => c.id === 'IdentitySplit')!;
    expect(split.schemaStatus).toBe('identity-mismatch');
    expect(split.schema).toBeNull();
    expect(split.fields.map((f) => f.name)).toEqual(['value']);
  });

  it('lets an agent author accepted component/resource vocabulary without an error probe', () => {
    const dir = fixture();
    const data = capabilities(['--plugin', './plugin.mjs#declarations'], dir);
    const component = data.components.find((c) => c.id === 'WorkbenchConfig')!;
    const resource = data.resources.ids.find((id) => id === 'fixture.settings')!;
    expect(component.id).toBe('WorkbenchConfig');
    expect(resource).toBe('fixture.settings');
    writeFileSync(
      join(dir, 'authored.scene.json'),
      JSON.stringify({
        aegis: 'scene/1',
        name: 'authored from discovery',
        mode: 'platformer',
        resources: { [resource]: { difficulty: 2 } },
        entities: [
          {
            id: 'crate',
            prefab: 'z-crate',
            components: {
              [component.id]: { flavor: 'bold', note: 'agent-authored', optionalNull: null },
            },
          },
        ],
      }),
    );
    const validated = cli(
      ['validate', 'authored.scene.json', '--plugin', './plugin.mjs#declarations', '--json'],
      dir,
    );
    expect(validated.code, validated.err || validated.out).toBe(0);
    expect(JSON.parse(validated.out)).toMatchObject({
      ok: true,
      files: [{ ok: true, diagnostics: [] }],
    });
  });

  it('uses a scene only for selection, never adding its undeclared vocabulary', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'aegis.json'), JSON.stringify({ plugin: './plugin.mjs#declarations' }));
    writeFileSync(
      join(dir, 'not-runnable.scene.json'),
      JSON.stringify({
        aegis: 'scene/1',
        name: 'selection only',
        mode: 'platformer',
        resources: { 'not.registered': {} },
        entities: [{ id: 'x', components: { NotRegistered: {} } }],
      }),
    );
    const data = capabilities(['not-runnable.scene.json'], dir);
    expect(data.resources.ids).toEqual(['fixture.empty', 'fixture.settings']);
    expect(data.components.some((c) => c.id === 'NotRegistered')).toBe(false);
    const overridden = capabilities(['not-runnable.scene.json', '--plugin', 'platformer'], dir);
    expect(overridden.plugin).toEqual({ mode: 'platformer', source: 'flag', spec: 'platformer' });
  });

  it('reports content facts that agree with real accepted and rejected authored values', () => {
    const dir = fixture();
    const cases = [
      {
        data: {
          speed: -12.5,
          nested: { axis: { x: 4, y: 9 } },
          routes: [1, 'two', { free: true }],
          data: { free: [1, 2] },
          token: { any: 'serialisable kind' },
          extra: { free: true },
          optionalNull: null,
        },
        codes: [],
      },
      { data: { flavor: 'loud' }, codes: ['AEG-CONTENT-0015'] },
      { data: { nested: { axis: { x: 4 } } }, codes: ['AEG-CONTENT-0013'] },
      { data: { spiid: 4 }, codes: ['AEG-CONTENT-0012'] },
      { data: { optionalNull: 'not-null' }, codes: ['AEG-CONTENT-0004'] },
      { data: { speed: '4' }, codes: ['AEG-CONTENT-0004'] },
    ];
    const files = cases.map((entry, index) => {
      const file = `case-${index}.scene.json`;
      writeFileSync(
        join(dir, file),
        JSON.stringify({
          aegis: 'scene/1',
          name: 'schema parity',
          mode: 'platformer',
          entities: [{ id: 'entity', components: { WorkbenchConfig: entry.data } }],
        }),
      );
      return file;
    });
    const result = cli(
      ['validate', ...files, '--plugin', './plugin.mjs#declarations', '--json'],
      dir,
    );
    expect(result.code, result.err).toBe(2);
    const report = JSON.parse(result.out) as {
      files: { ok: boolean; diagnostics: { code: string }[] }[];
    };
    expect(report.files.map((file) => file.ok)).toEqual([true, false, false, false, false, false]);
    expect(report.files.map((file) => file.diagnostics.map((d) => d.code))).toEqual(
      cases.map((entry) => entry.codes),
    );
  });

  it('reports absent optional declarations as unavailable, without synthesising inventories', () => {
    const data = capabilities(['--plugin', './plugin.mjs#empty'], fixture());
    expect(data.components.map((component) => component.id)).toEqual([...BASE_COMPONENTS].sort());
    expect(data.resources).toEqual({ declared: false, ids: [], valueSchemas: null });
    expect(data.prefabs).toEqual({ declared: false, expanded: false, catalog: [] });
    expect(data.systems.order).toEqual([]);
  });

  it('resolves config-relative modules above cwd and rejects mode disagreements', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'aegis.json'), JSON.stringify({ plugin: './plugin.mjs#declarations' }));
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    expect(capabilities([], nested).plugin.configFile).toBe(join(dir, 'aegis.json'));
    const mismatch = cli(['describe', '--mode', 'fps', '--json'], nested);
    expect(mismatch.code).toBe(1);
    expect(JSON.parse(mismatch.err)).toMatchObject({ error: { code: 'AEG-CLI-0017' } });
  });

  it('reports live command flags, file formats, useful help and explicit discovery limits', () => {
    const data = capabilities(['--mode', 'platformer']);
    expect(data.operations.commands.map((c) => c.name)).toEqual([
      'describe',
      'inspect',
      'record',
      'replay',
      'run',
      'scaffold',
      'test',
      'validate',
    ]);
    expect(data.operations.modes).toEqual(['fps', 'iso', 'platformer']);
    expect(data.operations.commands.find((c) => c.name === 'inspect')?.flags).toEqual({
      h: 'boolean',
      help: 'boolean',
      json: 'boolean',
      tick: 'value',
      mode: 'value',
      plugin: 'value',
      input: 'value',
      seed: 'value',
      'max-ticks': 'value',
      view: 'value',
      offscreen: 'boolean',
      query: 'value',
      limit: 'value',
      offset: 'value',
      resources: 'value',
      resource: 'value',
    });
    expect(data.operations.commands.find((c) => c.name === 'inspect')?.choices).toEqual({
      view: ['world', 'frame', 'ascii'],
      resources: ['all', 'summary', 'none'],
    });
    expect(data.operations.commands.find((c) => c.name === 'record')?.formats).toEqual({
      reads: ['scene/1', 'input-script'],
      writes: ['recording/1'],
      stdout: ['text', 'json'],
    });
    expect(data.operations.commands.find((c) => c.name === 'validate')?.formats?.reads).toEqual([
      'scene/1',
      'prefab/1',
      'tilemap/1',
    ]);
    expect(cli(['--help']).out).toContain('describe');
    expect(cli(['describe', '--help']).out).toContain('capabilities/1');
    const human = cli(['describe', '--plugin', './plugin.mjs#declarations'], fixture());
    expect(human.code, human.err).toBe(0);
    expect(human.out).toContain('data:object');
    expect(human.out).toContain('note?:string');
    expect(human.out).toContain('unresolved constraints: 1 (not applied)');
    expect(human.out).toContain('resource');
    expect(human.out).toContain('not evidence that gameplay is correct');
  });

  it.each([
    { args: [], code: 'AEG-CLI-0001' },
    { args: ['--mode', 'dungeon'], code: 'AEG-CLI-0003' },
    { args: ['--plugin', 'fps', '--mode', 'iso'], code: 'AEG-CLI-0017' },
    { args: ['--plugin', './missing.mjs'], code: 'AEG-CLI-0015' },
    { args: ['--plugin', './plugin.mjs#invalid'], code: 'AEG-CLI-0016' },
    { args: ['--plugin', './plugin.mjs#absent'], code: 'AEG-CLI-0016' },
    { args: ['--plugin', './plugin.mjs'], code: 'AEG-CLI-0016' },
    { args: ['--plugin'], code: 'AEG-CLI-0002' },
    { args: ['--mode', 'fps', '--ticks', '0'], code: 'AEG-CLI-0012' },
    { args: ['first.scene.json', 'second.scene.json'], code: 'AEG-CLI-0002' },
    { args: ['--mode', 'fps', '--json=wrong'], code: 'AEG-CLI-0002', jsonFirst: true },
  ])('rejects invalid discovery input $args with $code', ({ args, code, jsonFirst }) => {
    const result = cli(
      ['describe', ...(jsonFirst ? ['--json'] : []), ...args, ...(jsonFirst ? [] : ['--json'])],
      fixture(),
    );
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    // An invalid --json value intentionally requests neither JSON nor text-as-JSON.
    if (jsonFirst) expect(result.err).toContain(code);
    else expect(JSON.parse(result.err)).toMatchObject({ error: { code } });
  });

  it('refuses a cyclic schedule and an ambiguous prefab catalog rather than claiming valid capabilities', () => {
    const dir = fixture();
    const cycle = cli(['describe', '--plugin', './plugin.mjs#cyclic', '--json'], dir);
    expect(cycle.code).toBe(1);
    expect(JSON.parse(cycle.err).error.message).toContain('cyclic before/after');
    const duplicate = cli(['describe', '--plugin', './plugin.mjs#duplicatePrefabs', '--json'], dir);
    expect(duplicate.code).toBe(2);
    expect(JSON.parse(duplicate.err)).toMatchObject({
      diagnostics: [{ code: 'AEG-CONTENT-0007' }],
    });
  });
});

interface WorldReport {
  entities: {
    id: string;
    index: number;
    generation: number;
    name: string;
    components: { Transform: { position: { x: number } } };
  }[];
  matched: number;
  total: number;
  tick: number;
  hash: string;
  page?: EntityPage;
  resources?: Record<string, unknown>;
  resourceSummary?: ResourceSummary[];
  resourceSelection?: ResourceProjection['selection'];
}

function world(args: readonly string[], cwd: string): WorldReport {
  const result = cli(['inspect', 'world.scene.json', ...args, '--json'], cwd);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toBe('');
  return JSON.parse(result.out) as WorldReport;
}

describe('aegis inspect: opt-in bounded world output', () => {
  it('preserves the default JSON shape and all entities/resource values', () => {
    const data = world([], observationFixture());
    expect(Object.keys(data).sort()).toEqual([
      'entities',
      'hash',
      'matched',
      'mode',
      'plugin',
      'query',
      'resources',
      'scene',
      'seed',
      'tick',
      'total',
      'unregisteredMarkers',
    ]);
    expect(data.entities.map((e) => e.name)).toEqual([
      'replacement',
      'beta',
      'camera',
      'gamma',
      'delta',
    ]);
    expect(data.matched).toBe(5);
    expect(data.total).toBe(5);
    expect(data.resources).toEqual({
      'alpha.settings': { answer: 42, label: 'untouched' },
      list: [1, 2, 3, 4],
      message: 'ready',
      'runtime.progress': { ticks: 0 },
    });
  });

  it('preserves default human census and full-resource rendering', () => {
    const result = cli(['inspect', 'world.scene.json'], observationFixture());
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('entities: 5 of 5\n');
    expect(result.out).toContain('#0@2 "replacement"');
    expect(result.out).toContain(
      'resources:\n  alpha.settings = {"answer":42,"label":"untouched"}\n' +
        '  list = [1,2,3,4]\n  message = "ready"\n  runtime.progress = {"ticks":0}\n',
    );
    expect(result.out).not.toContain('truncated');
    expect(result.out).not.toContain('page:');
  });

  it('pages after query filtering, retaining total/matched counts and complete selected entities', () => {
    const dir = observationFixture();
    const data = world(['--query', 'has:Observed', '--offset', '1', '--limit', '2'], dir);
    expect(data.matched).toBe(4);
    expect(data.total).toBe(5);
    expect(data.entities.map((e) => e.name)).toEqual(['beta', 'gamma']);
    expect(data.page).toEqual({
      order: 'entity-index',
      offset: 1,
      limit: 2,
      returned: 2,
      truncated: true,
      hasMore: true,
      nextOffset: 3,
    });
    expect(data.resources?.list).toEqual([1, 2, 3, 4]);
    const human = cli(
      ['inspect', 'world.scene.json', '--query', 'has:Observed', '--offset', '1', '--limit', '2'],
      dir,
    );
    expect(human.out).toContain('entities: 2 returned of 4 matched (5 total)');
    expect(human.out).toContain('page: offset=1 limit=2 truncated=yes hasMore=yes');
    expect(human.out).not.toContain('"replacement"');
  });

  it('uses ascending entity indices even after a slot is reused at a higher generation', () => {
    const data = world(['--limit', '2'], observationFixture());
    expect(data.entities.map((e) => [e.id, e.index, e.generation, e.name])).toEqual([
      ['8589934592', 0, 2, 'replacement'],
      ['4294967297', 1, 1, 'beta'],
    ]);
  });

  it.each([
    { args: ['--limit', '0'], names: [], returned: 0, truncated: true, hasMore: true, next: null },
    {
      args: ['--offset', '4'],
      names: ['delta'],
      returned: 1,
      truncated: true,
      hasMore: false,
      next: null,
    },
    {
      args: ['--offset', '5', '--limit', '2'],
      names: [],
      returned: 0,
      truncated: true,
      hasMore: false,
      next: null,
    },
    {
      args: ['--offset', '99'],
      names: [],
      returned: 0,
      truncated: true,
      hasMore: false,
      next: null,
    },
    {
      args: ['--offset', '9007199254740991'],
      names: [],
      returned: 0,
      truncated: true,
      hasMore: false,
      next: null,
    },
    {
      args: ['--limit', '9007199254740991'],
      names: ['replacement', 'beta', 'camera', 'gamma', 'delta'],
      returned: 5,
      truncated: false,
      hasMore: false,
      next: null,
    },
  ])(
    'reports empty/count-only/end/unbounded pages honestly for $args',
    ({ args, names, returned, truncated, hasMore, next }) => {
      const data = world(args, observationFixture());
      expect(data.matched).toBe(5);
      expect(data.total).toBe(5);
      expect(data.entities.map((e) => e.name)).toEqual(names);
      expect(data.page).toMatchObject({ returned, truncated, hasMore, nextOffset: next });
    },
  );

  it('does not claim truncation when a query genuinely matched nothing', () => {
    const data = world(['--query', 'has:Recycled', '--limit', '2'], observationFixture());
    expect(data.entities).toEqual([]);
    expect(data.matched).toBe(0);
    expect(data.total).toBe(5);
    expect(data.page).toMatchObject({ returned: 0, truncated: false, hasMore: false });
  });

  it('still rejects an unresolvable query rather than treating it as an empty page', () => {
    const result = cli(
      ['inspect', 'world.scene.json', '--query', 'has:Missing', '--limit', '2', '--json'],
      observationFixture(),
    );
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(JSON.parse(result.err).error.message).toContain('Unresolvable component reference');
  });

  it('summarises or omits resources without pretending that resource values were returned', () => {
    const dir = observationFixture();
    const summary = world(['--limit', '0', '--resources', 'summary'], dir);
    expect(summary.resources).toBeUndefined();
    expect(summary.resourceSummary).toEqual([
      { id: 'alpha.settings', kind: 'object', keyCount: 2 },
      { id: 'list', kind: 'array', length: 4 },
      { id: 'message', kind: 'string', length: 5 },
      { id: 'runtime.progress', kind: 'object', keyCount: 1 },
    ]);
    expect(summary.resourceSelection).toEqual({
      mode: 'summary',
      total: 4,
      matched: 4,
      returned: 4,
      valuesReturned: 0,
      omittedValues: 4,
      truncated: true,
    });
    const none = world(['--resources', 'none'], dir);
    expect(none.resources).toBeUndefined();
    expect(none.resourceSummary).toBeUndefined();
    expect(none.resourceSelection).toEqual({
      mode: 'none',
      total: 4,
      matched: 4,
      returned: 0,
      valuesReturned: 0,
      omittedValues: 4,
      truncated: true,
    });
    expect(none.entities).toHaveLength(5);
    const human = cli(
      ['inspect', 'world.scene.json', '--limit', '0', '--resources', 'summary'],
      dir,
    );
    expect(human.out).toContain(
      'resources: summary; 4 returned of 4 matched (4 total); 4 value(s) omitted; truncated=yes',
    );
    expect(human.out).toContain('  list: array length=4');
    expect(human.out).not.toContain('untouched');
  });

  it('selects one full resource value or summary explicitly, including runtime-created IDs', () => {
    const dir = observationFixture();
    const data = world(['--resource', 'list'], dir);
    expect(data.resources).toEqual({ list: [1, 2, 3, 4] });
    expect(data.resourceSelection).toEqual({
      mode: 'all',
      total: 4,
      matched: 1,
      returned: 1,
      valuesReturned: 1,
      omittedValues: 3,
      truncated: true,
    });
    const summary = world(['--resource', 'runtime.progress', '--resources', 'summary'], dir);
    expect(summary.resourceSummary).toEqual([
      { id: 'runtime.progress', kind: 'object', keyCount: 1 },
    ]);
    expect(summary.resourceSelection).toMatchObject({
      total: 4,
      matched: 1,
      returned: 1,
      omittedValues: 4,
    });
    const all = world(['--resources', 'all'], dir);
    expect(all.resourceSelection).toMatchObject({
      returned: 4,
      valuesReturned: 4,
      truncated: false,
    });
    expect(Object.keys(all.resources ?? {})).toEqual([
      'alpha.settings',
      'list',
      'message',
      'runtime.progress',
    ]);
  });

  it('distinguishes an empty resource set from omitted values and summarises scalar kinds', () => {
    const dir = fixture();
    writeFileSync(
      join(dir, 'world.scene.json'),
      JSON.stringify({
        aegis: 'scene/1',
        name: 'empty',
        mode: 'platformer',
        entities: [],
      }),
    );
    const empty = world(
      ['--plugin', './plugin.mjs#empty', '--limit', '0', '--resources', 'none'],
      dir,
    );
    expect(empty.matched).toBe(0);
    expect(empty.total).toBe(0);
    expect(empty.resourceSelection).toEqual({
      mode: 'none',
      total: 0,
      matched: 0,
      returned: 0,
      valuesReturned: 0,
      omittedValues: 0,
      truncated: false,
    });
    writeFileSync(
      join(dir, 'world.scene.json'),
      JSON.stringify({
        aegis: 'scene/1',
        name: 'scalars',
        mode: 'platformer',
        entities: [],
        resources: { enabled: false, nil: null, number: 2 },
      }),
    );
    const scalars = world(
      ['--plugin', './plugin.mjs#scalarResources', '--resources', 'summary'],
      dir,
    );
    expect(scalars.resourceSummary).toEqual([
      { id: 'enabled', kind: 'boolean' },
      { id: 'nil', kind: 'null' },
      { id: 'number', kind: 'number' },
    ]);
    expect(scalars.resourceSelection).toMatchObject({
      total: 3,
      returned: 3,
      omittedValues: 3,
      truncated: true,
    });
  });

  it('bounds only output: the whole world still advances and hashes identically', () => {
    const dir = observationFixture();
    const full = world(['--tick', '3'], dir);
    expect(
      full.entities
        .filter((e) => e.name !== 'camera')
        .map((e) => e.components.Transform.position.x),
    ).toEqual([13, 4, 6, 7]);
    expect(full.resources?.['runtime.progress']).toEqual({ ticks: 3 });
    const page = world(['--tick', '3', '--limit', '1', '--resources', 'none'], dir);
    expect(page.tick).toBe(3);
    expect(page.hash).toBe(full.hash);
    expect(page.entities[0]?.components.Transform.position.x).toBe(13);
    expect(page.matched).toBe(5);
  });

  it.each(['limit', 'offset'])(
    'rejects invalid --%s values with structured diagnostics before loading a scene',
    (flag) => {
      for (const raw of [
        '-1',
        '1.5',
        'NaN',
        'Infinity',
        '-Infinity',
        '9007199254740992',
        '',
        ' ',
      ]) {
        const result = cli(['inspect', 'does-not-exist.scene.json', `--${flag}=${raw}`, '--json']);
        expect(result.code, raw).toBe(1);
        expect(result.out).toBe('');
        expect(JSON.parse(result.err)).toMatchObject({ error: { code: 'AEG-CLI-0002' } });
      }
      const missing = cli(['inspect', 'does-not-exist.scene.json', `--${flag}`, '--json']);
      expect(missing.code).toBe(1);
      expect(JSON.parse(missing.err)).toMatchObject({ error: { code: 'AEG-CLI-0002' } });
    },
  );

  it.each(['frame', 'ascii'])(
    'rejects world output controls with the %s view instead of ignoring them',
    (view) => {
      for (const args of [
        ['--limit', '1'],
        ['--offset', '0'],
        ['--resources', 'all'],
        ['--resource', 'list'],
      ]) {
        const result = cli([
          'inspect',
          'does-not-exist.scene.json',
          '--view',
          view,
          ...args,
          '--json',
        ]);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.err)).toMatchObject({
          error: { code: 'AEG-CLI-0002', data: { view, allowedViews: ['world'] } },
        });
      }
    },
  );

  it.each([
    { args: ['--resources', 'brief'], code: 'AEG-CLI-0011' },
    { args: ['--resource', 'absent'], code: 'AEG-CLI-0011' },
    { args: ['--resource='], code: 'AEG-CLI-0002' },
    { args: ['--resource', 'list', '--resources', 'none'], code: 'AEG-CLI-0002' },
    { args: ['--limt', '1'], code: 'AEG-CLI-0012' },
  ])('rejects invalid resource/output controls $args', ({ args, code }) => {
    const result = cli(['inspect', 'world.scene.json', ...args, '--json'], observationFixture());
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(JSON.parse(result.err)).toMatchObject({ error: { code } });
  });
});

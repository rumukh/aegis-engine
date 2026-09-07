import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '@aegis/core';
import type { PresentationManifest } from '@aegis/render-three/presentation/schema';
import type { CapabilityDescription } from './capabilities.js';
import {
  makeFixtureDir,
  PACKAGE_ROOT,
  removeFixtureDir,
  sweepStaleFixtures,
} from './testing/fixtures.js';

sweepStaleFixtures();
const dirs: string[] = [];
const BIN = join(PACKAGE_ROOT, 'bin', 'aegis.mjs');

interface Report {
  ok: boolean;
  strict: boolean;
  files: {
    file: string;
    ok: boolean;
    plugin?: string;
    validation?: {
      format: string;
      scope: string;
      notChecked: string[];
    };
    diagnostics: Diagnostic[];
  }[];
}

const MANIFEST: PresentationManifest = {
  aegis: 'presentation/1',
  assets: [
    {
      id: 'surface',
      kind: 'texture',
      src: 'not-installed.png',
      provenance: { author: 'CLI fixture', license: 'CC0-1.0', source: 'original fixture' },
    },
  ],
  materials: [{ id: 'wall', shading: 'standard', map: 'surface' }],
  entities: [
    {
      target: { name: 'not-spawned' },
      visual: { kind: 'primitive', shape: 'box', material: 'wall' },
    },
  ],
  hud: { playerName: 'not-spawned', winEvent: 'game.won', loseEvents: ['game.lost'] },
};

function fixture(): string {
  const dir = makeFixtureDir();
  dirs.push(dir);
  return dir;
}

function writeDocument(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value), 'utf8');
}

function cli(args: readonly string[], cwd: string) {
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

afterEach(() => {
  for (const dir of dirs.splice(0)) removeFixtureDir(dir);
});

describe('aegis validate presentation/1: built CLI', () => {
  it.each([false, true])(
    'accepts structural data with strict=%s while naming every unchecked scope',
    (strict) => {
      const dir = fixture();
      writeDocument(dir, 'look.json', MANIFEST);
      expect(existsSync(join(dir, 'not-installed.png'))).toBe(false);
      const result = cli(['validate', 'look.json', '--json', ...(strict ? ['--strict'] : [])], dir);
      expect(result.code, result.err || result.out).toBe(0);
      expect(result.err).toBe('');
      const report = JSON.parse(result.out) as Report;
      expect(report).toEqual({
        ok: true,
        strict,
        files: [
          {
            file: 'look.json',
            ok: true,
            validation: {
              format: 'presentation/1',
              scope: 'structural',
              notChecked: ['asset-files', 'asset-decoding', 'initialized-world-bindings'],
            },
            diagnostics: [],
          },
        ],
      });
      expect(existsSync(join(dir, 'not-installed.png'))).toBe(false);
    },
  );

  it('qualifies human success rather than implying files or entity names were verified', () => {
    const dir = fixture();
    writeDocument(dir, 'look.presentation.json', MANIFEST);
    const result = cli(['validate', 'look.presentation.json'], dir);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(
      '# look.presentation.json: presentation/1 structural validation only.\n' +
        '# Not checked: asset files/decoding or initialized-world bindings.\n' +
        'ok look.presentation.json: no problems found\n',
    );
  });

  it('does not import a nearby or explicitly selected game plugin for presentation validation', () => {
    const dir = fixture();
    writeDocument(dir, 'look.json', MANIFEST);
    writeDocument(dir, 'aegis.json', { plugin: './must-not-run.mjs#plugin' });
    writeFileSync(
      join(dir, 'must-not-run.mjs'),
      'throw new Error("A structural check must not import game code");\n',
    );
    for (const flags of [[], ['--plugin', './must-not-run.mjs#plugin', '--mode', 'fps']]) {
      const result = cli(['validate', 'look.json', ...flags, '--json'], dir);
      expect(result.code, result.err).toBe(0);
      const report = JSON.parse(result.out) as Report;
      expect(report.files[0]?.plugin).toBeUndefined();
      expect(report.files[0]?.validation?.notChecked).toContain('initialized-world-bindings');
    }
  });

  it.each([
    {
      name: 'unknown field',
      value: { aegis: 'presentation/1', asssets: [] },
      code: 'AEG-RENDER-0001',
      path: 'presentation.asssets',
    },
    {
      name: 'unsupported quality',
      value: { aegis: 'presentation/1', quality: 'ultra' },
      code: 'AEG-RENDER-0001',
      path: 'presentation.quality',
    },
    {
      name: 'missing declared asset',
      value: {
        aegis: 'presentation/1',
        materials: [{ id: 'wall', shading: 'standard', map: 'missing' }],
      },
      code: 'AEG-RENDER-0002',
      path: 'materials[0].map',
    },
    {
      name: 'nonlocal asset path',
      value: {
        ...MANIFEST,
        assets: [{ ...MANIFEST.assets![0], src: '../not-installed.png' }],
      },
      code: 'AEG-RENDER-0003',
      path: 'assets[0].src',
    },
    {
      name: 'duplicate asset ID',
      value: { ...MANIFEST, assets: [MANIFEST.assets![0], MANIFEST.assets![0]] },
      code: 'AEG-RENDER-0002',
      path: 'assets[1].id',
    },
    {
      name: 'point-light budget',
      value: {
        aegis: 'presentation/1',
        environment: {
          points: Array.from({ length: 9 }, () => ({
            color: '#ffffff',
            intensity: 1,
            position: [0, 0, 0],
            distance: 2,
          })),
        },
      },
      code: 'AEG-RENDER-0006',
      path: 'environment.points',
    },
  ])('rejects $name using published codes and file/field locations', ({ value, code, path }) => {
    const dir = fixture();
    writeDocument(dir, 'bad.presentation.json', value);
    const result = cli(['validate', 'bad.presentation.json', '--json', '--strict'], dir);
    expect(result.code, result.err || result.out).toBe(2);
    expect(result.err).toBe('');
    const report = JSON.parse(result.out) as Report;
    expect(report.ok).toBe(false);
    expect(report.files[0]?.ok).toBe(false);
    expect(report.files[0]?.validation?.scope).toBe('structural');
    expect(report.files[0]?.diagnostics).toContainEqual(
      expect.objectContaining({
        code,
        severity: 'error',
        location: { file: 'bad.presentation.json', path },
        fix: expect.any(String),
      }),
    );
  });

  it('reports independent presentation problems together in text and JSON', () => {
    const dir = fixture();
    writeDocument(dir, 'bad.json', {
      aegis: 'presentation/1',
      quality: 'ultra',
      materials: [{ id: 'wall', shading: 'standard', map: 'missing' }],
    });
    const jsonResult = cli(['validate', 'bad.json', '--json'], dir);
    expect(jsonResult.code).toBe(2);
    const report = JSON.parse(jsonResult.out) as Report;
    expect(report.files[0]?.diagnostics.map((d) => [d.code, d.location?.path])).toEqual([
      ['AEG-RENDER-0001', 'presentation.quality'],
      ['AEG-RENDER-0002', 'materials[0].map'],
    ]);
    const human = cli(['validate', 'bad.json'], dir);
    expect(human.code).toBe(2);
    expect(human.out).toContain('error AEG-RENDER-0001 at bad.json presentation.quality:');
    expect(human.out).toContain('error AEG-RENDER-0002 at bad.json materials[0].map:');
    expect(human.out).toContain('-- 2 error(s), 0 warning(s), 0 info in bad.json');
    expect(human.out).toContain('structural validation only');
  });

  it.each([
    { text: '{ broken', code: 'AEG-CONTENT-0001' },
    { text: '{"aegis":"presentation/2"}', code: 'AEG-CONTENT-0002' },
    {
      text: '{"aegis":"presentation/1","environment":{"ambient":{"color":"#ffffff","intensity":1e999}}}',
      code: 'AEG-RENDER-0001',
    },
  ])('retains format/JSON rejection and finite-number validation for $text', ({ text, code }) => {
    const dir = fixture();
    writeFileSync(join(dir, 'bad.json'), text, 'utf8');
    const result = cli(['validate', 'bad.json', '--json'], dir);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out) as Report;
    expect(report.files[0]?.diagnostics[0]?.code).toBe(code);
    expect(report.files[0]?.diagnostics[0]?.location?.file).toBe('bad.json');
    if (text.includes('presentation/2')) {
      expect(report.files[0]?.diagnostics[0]?.fix).toContain('"presentation/1"');
    }
  });

  it('supports mixed-format glob validation without changing content result shape', () => {
    const dir = fixture();
    writeDocument(dir, 'a.scene.json', {
      aegis: 'scene/1',
      name: 'empty',
      mode: 'platformer',
      entities: [],
    });
    writeDocument(dir, 'b.prefab.json', {
      aegis: 'prefab/1',
      name: 'crate',
      components: { Transform: {} },
    });
    writeDocument(dir, 'c.tilemap.json', {
      aegis: 'tilemap/1',
      name: 'one-cell',
      width: 1,
      height: 1,
      tileSize: 1,
      legend: { '#': { solid: true } },
      layers: [{ name: 'collision', data: ['#'] }],
    });
    writeDocument(dir, 'd.presentation.json', {
      aegis: 'presentation/1',
    } satisfies PresentationManifest);
    const result = cli(['validate', '*.json', '--plugin', 'platformer', '--json'], dir);
    expect(result.code, result.err || result.out).toBe(0);
    const report = JSON.parse(result.out) as Report;
    expect(report.files.map((file) => file.file)).toEqual([
      join(dir, 'a.scene.json'),
      join(dir, 'b.prefab.json'),
      join(dir, 'c.tilemap.json'),
      join(dir, 'd.presentation.json'),
    ]);
    expect(report.files.map((file) => file.ok)).toEqual([true, true, true, true]);
    expect(report.files.slice(0, 3).every((file) => file.validation === undefined)).toBe(true);
    expect(report.files.slice(0, 2).every((file) => file.plugin === 'platformer (--plugin)')).toBe(
      true,
    );
    expect(report.files[3]?.plugin).toBeUndefined();
    expect(report.files[3]?.validation?.scope).toBe('structural');
  });

  it.each(['--asset-root', '--prepare', '--scene', '--world'])(
    'refuses unimplemented %s operations',
    (flag) => {
      const dir = fixture();
      writeDocument(dir, 'look.json', MANIFEST);
      const result = cli(['validate', 'look.json', flag, 'ignored', '--json'], dir);
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(JSON.parse(result.err)).toMatchObject({
        error: { code: 'AEG-CLI-0012', data: { flag: flag.slice(2) } },
      });
    },
  );

  it('reports structural presentation validation as an implemented CLI format, not new plugin content', () => {
    const result = cli(['describe', '--mode', 'iso', '--json'], fixture());
    expect(result.code, result.err).toBe(0);
    const data = JSON.parse(result.out) as CapabilityDescription;
    const validation = data.operations.commands.find((command) => command.name === 'validate');
    expect(validation?.formats).toEqual({
      reads: ['scene/1', 'prefab/1', 'tilemap/1', 'presentation/1'],
      writes: [],
      stdout: ['text', 'json'],
    });
    expect(validation?.usage).toContain('STRUCTURAL ONLY');
    expect(validation?.usage).toContain('initialized-world bindings are NOT checked');
    expect(validation?.flags).toEqual({
      h: 'boolean',
      help: 'boolean',
      json: 'boolean',
      mode: 'value',
      plugin: 'value',
      strict: 'boolean',
    });
    expect(data.resources.ids).toEqual(['IsoGrid', 'NavGrid']);
    expect(data.components.some((component) => component.id === 'presentation/1')).toBe(false);
    const help = cli(['validate', '--help'], fixture());
    expect(help.code).toBe(0);
    expect(help.out).toContain('"presentation/1"');
    expect(help.out).toContain(
      'Asset files/decoding and initialized-world bindings are NOT checked',
    );
  });
});

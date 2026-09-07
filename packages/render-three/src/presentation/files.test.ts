import { mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagnosticError } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import {
  preparePresentation,
  presentationMimeType,
  readPreparedPresentationFile,
} from './files.js';
import { RenderCode } from './diagnostics.js';
import { PRESENTATION_LIMITS } from './schema.js';
import type { AssetSpec, PresentationManifest, PresentationSource } from './schema.js';

const workspace = resolve(`.aegis-presentation-files-${process.pid}`);
const root = join(workspace, 'assets');
const provenance = { author: 'Aegis tests', license: 'MIT', source: 'procedural test fixture' };
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z" fill="#fff"/></svg>';
const prefabScene: SceneFile = {
  aegis: 'scene/1',
  name: 'Prefab scene',
  mode: 'platformer',
  entities: [{ id: 'root', children: [{ id: 'family', prefab: 'actor-family' }] }],
};

beforeEach(() => {
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(path: string, bytes: string | Buffer): void {
  const file = join(root, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
function asset(src: string, kind: AssetSpec['kind'] = 'texture', id = 'sample'): AssetSpec {
  return { id, kind, src, provenance };
}
function source(
  assets: readonly AssetSpec[],
  extra: Partial<PresentationManifest> = {},
): PresentationSource {
  return { manifest: { aegis: 'presentation/1', assets, ...extra }, assetRoot: root };
}
function model(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, ...extra };
}
function glb(document: Record<string, unknown>, binary?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = binary === undefined ? 0 : Math.ceil(binary.length / 4) * 4;
  const out = Buffer.alloc(20 + jsonLength + (binary === undefined ? 0 : 8 + binLength));
  out.write('glTF');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  out.fill(0x20, 20, 20 + jsonLength);
  json.copy(out, 20);
  if (binary !== undefined) {
    out.writeUInt32LE(binLength, 20 + jsonLength);
    out.writeUInt32LE(0x004e4942, 24 + jsonLength);
    binary.copy(out, 28 + jsonLength);
  }
  return out;
}
function diagnostic(run: () => unknown, code: string, text?: string): DiagnosticError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticError);
    const failure = error as DiagnosticError;
    expect(failure.diagnostics[0]?.code).toBe(code);
    expect(failure.diagnostics[0]?.location?.path).toBeTruthy();
    expect(failure.diagnostics[0]?.fix).toBeTruthy();
    if (text !== undefined) expect(failure.message).toContain(text);
    return failure;
  }
  throw new Error(`Expected ${code}, but preparation succeeded.`);
}

describe('preparePresentation', () => {
  it('accepts a render-only descriptor without a filesystem root and snapshots its manifest', () => {
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      environment: { background: '#123456' },
    };
    const prepared = preparePresentation({ manifest });
    manifest.environment!.background = '#abcdef';
    expect(prepared).toEqual({
      manifest: { aegis: 'presentation/1', environment: { background: '#123456' } },
      files: [],
      totalBytes: 0,
    });
  });

  it('runs pure schema validation before attempting asset IO', () => {
    const input = source([asset('missing.png')], { quality: 'ultra' as 'standard' });
    const error = diagnostic(() => preparePresentation(input), RenderCode.Shape);
    expect(error.diagnostics[0]?.location?.path).toBe('presentation.quality');
  });

  it('inventories only declared files with byte counts, real paths, SHA-256 and provenance', () => {
    write('images/pixel.png', png);
    write('unrelated.txt', 'not part of the closure');
    const prepared = preparePresentation(source([asset('images/pixel.png')]));
    expect(prepared.totalBytes).toBe(70);
    expect(prepared.files).toEqual([
      {
        path: 'images/pixel.png',
        source: realpathSync(join(root, 'images', 'pixel.png')),
        bytes: 70,
        sha256: '2640059609118b695c139804676372eca75c30d30e5906775902d13e44f5356c',
        provenance,
      },
    ]);
    expect(readPreparedPresentationFile(prepared.files[0]!)).toEqual(png);
  });

  it('requires a readable absolute asset root when there are file assets', () => {
    const input = source([asset('pixel.png')]);
    diagnostic(
      () => preparePresentation({ manifest: input.manifest }),
      RenderCode.Path,
      'assetRoot',
    );
    diagnostic(() => preparePresentation({ ...input, assetRoot: 'relative' }), RenderCode.Path);
    diagnostic(
      () => preparePresentation({ ...input, assetRoot: 7 as unknown as string }),
      RenderCode.Path,
    );
    diagnostic(
      () => preparePresentation({ ...input, assetRoot: join(root, 'missing') }),
      RenderCode.Path,
    );
    write('file', 'not a directory');
    diagnostic(
      () => preparePresentation({ ...input, assetRoot: join(root, 'file') }),
      RenderCode.Path,
    );
  });

  it.each([
    '../outside.png',
    '/absolute.png',
    'C:/absolute.png',
    'https://example.test/a.png',
    '//example.test/a.png',
    'nested\\a.png',
    'a.png?x=1',
    'a.png#x',
    '%61.png',
    'a//b.png',
    'a/./b.png',
    'CON.png',
    'folder./a.png',
  ])('rejects nonportable authored paths: %s', (path) => {
    diagnostic(() => preparePresentation(source([asset(path)])), RenderCode.Path);
  });

  it('rejects missing files and directories with the asset id and field in the diagnostic', () => {
    const error = diagnostic(
      () => preparePresentation(source([asset('missing.png', 'texture', 'hero')])),
      RenderCode.Asset,
      'hero',
    );
    expect(error.diagnostics[0]?.location?.path).toBe('assets[0].src');
    mkdirSync(join(root, 'directory.png'));
    diagnostic(() => preparePresentation(source([asset('directory.png')])), RenderCode.Asset);
  });

  it('resolves roots and interior symlinks, but never follows a dependency outside them', () => {
    write('local/pixel.png', png);
    symlinkSync(join(root, 'local'), join(root, 'linked'), 'junction');
    symlinkSync(root, join(workspace, 'alias'), 'junction');
    const input = source([asset('linked/pixel.png')]);
    expect(
      preparePresentation({ ...input, assetRoot: join(workspace, 'alias') }).files[0]?.source,
    ).toBe(realpathSync(join(root, 'local', 'pixel.png')));
    const outside = join(workspace, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'pixel.png'), png);
    symlinkSync(outside, join(root, 'escaped'), 'junction');
    diagnostic(
      () => preparePresentation(source([asset('escaped/pixel.png')])),
      RenderCode.Path,
      'symlink',
    );
  });

  it('rejects differently-cased URL spellings that collide on Windows', () => {
    write('pixel.png', png);
    diagnostic(
      () =>
        preparePresentation(source([asset('pixel.png'), asset('PIXEL.png', 'texture', 'other')])),
      RenderCode.Path,
      'case-insensitive',
    );
  });

  it('refuses conflicting provenance for multiple declarations of the same file', () => {
    write('pixel.png', png);
    diagnostic(
      () =>
        preparePresentation(
          source([
            asset('pixel.png'),
            {
              ...asset('pixel.png', 'texture', 'other'),
              provenance: { ...provenance, license: 'other' },
            },
          ]),
        ),
      RenderCode.Reference,
      'provenance',
    );
  });

  it('rejects a file replaced or modified after preparation, even at the same size', () => {
    write('pixel.png', png);
    const file = preparePresentation(source([asset('pixel.png')])).files[0]!;
    const changed = Buffer.from(png);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    write('pixel.png', changed);
    diagnostic(() => readPreparedPresentationFile(file), RenderCode.Asset, 'after preflight');
  });

  it('reports raw-missing entity, object/effect anchor, and HUD names without rejecting init-created names', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'Test',
      mode: 'platformer',
      entities: [{ id: 'parent', children: [{ id: 'player' }] }],
    };
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      entities: [{ target: { name: 'player' }, visual: { kind: 'primitive', shape: 'box' } }],
      objects: [
        { id: 'badge', anchor: { entity: 'parent' }, visual: { kind: 'primitive', shape: 'box' } },
      ],
      effects: [{ event: 'hit', kind: 'pulse', target: { entity: 'player' }, durationTicks: 2 }],
      hud: { playerName: 'player', winEvent: 'won', loseEvents: ['died'] },
    };
    expect(preparePresentation({ manifest }, scene).files).toEqual([]);
    const pending = {
      ...manifest,
      entities: [{ target: { name: 'absent' }, visual: { kind: 'primitive', shape: 'box' } }],
      hud: { ...manifest.hud!, playerName: 'absent' },
    } satisfies PresentationManifest;
    const prepared = preparePresentation({ manifest: pending }, scene);
    expect(prepared.diagnostics?.map((entry) => entry.location?.path)).toEqual([
      'entities[0].target.name',
      'hud.playerName',
    ]);
    expect(prepared.diagnostics).toEqual([
      expect.objectContaining({
        code: RenderCode.Reference,
        severity: 'warning',
        data: { entity: 'absent', deferred: true, reason: 'world-initialization' },
      }),
      expect.objectContaining({
        code: RenderCode.Reference,
        severity: 'warning',
        data: { entity: 'absent', deferred: true, reason: 'world-initialization' },
      }),
    ]);
    expect(() => preparePresentation({ manifest: pending })).not.toThrow();
    const pendingAnchors: PresentationManifest = {
      ...manifest,
      objects: [{ ...manifest.objects![0]!, anchor: { entity: 'absent' } }],
      effects: [{ ...manifest.effects![0]!, target: { entity: 'absent' } }],
    };
    const anchors = preparePresentation({ manifest: pendingAnchors }, scene);
    expect(anchors.diagnostics?.map((entry) => entry.location?.path)).toEqual([
      'objects[0].anchor.entity',
      'effects[0].target.entity',
    ]);
    expect(anchors.diagnostics?.every((entry) => entry.severity === 'warning')).toBe(true);
  });

  it('enforces the per-file budget before reading an oversized file', () => {
    write('large.png', png);
    truncateSync(join(root, 'large.png'), PRESENTATION_LIMITS.fileBytes + 1);
    diagnostic(() => preparePresentation(source([asset('large.png')])), RenderCode.Budget);
  });

  it('defers unresolved names from nested prefab references, but still inventories every asset', () => {
    write('pixel.png', png);
    const input = source([asset('pixel.png')], {
      entities: [
        { target: { name: 'expanded-child' }, visual: { kind: 'primitive', shape: 'box' } },
      ],
      hud: { playerName: 'expanded-child', winEvent: 'won', loseEvents: [] },
    });
    const prepared = preparePresentation(input, prefabScene);
    expect(prepared.files.map((file) => file.path)).toEqual(['pixel.png']);
    expect(prepared.totalBytes).toBe(70);
    expect(prepared.diagnostics).toHaveLength(2);
    expect(prepared.diagnostics?.map((diagnostic) => diagnostic.location?.path)).toEqual([
      'entities[0].target.name',
      'hud.playerName',
    ]);
    for (const note of prepared.diagnostics ?? []) {
      expect(note.code).toBe(RenderCode.Reference);
      expect(note.severity).toBe('warning');
      expect(note.message).toContain('deferred');
      expect(note.fix).toContain('fully initialized world');
      expect(note.data).toEqual({
        entity: 'expanded-child',
        deferred: true,
        reason: 'world-initialization',
      });
    }
    expect(prepared.manifest.hud?.playerName).toBe('expanded-child');
    const withoutPrefabs = preparePresentation(input, {
      ...prefabScene,
      entities: [{ id: 'root' }],
    });
    expect(withoutPrefabs.diagnostics).toEqual(prepared.diagnostics);
    expect(withoutPrefabs.files).toEqual(prepared.files);
  });

  it('reports deferred names for HUD-only manifests without requiring assets or a root', () => {
    const prepared = preparePresentation(
      {
        manifest: {
          aegis: 'presentation/1',
          hud: { playerName: 'expanded-child', winEvent: 'won', loseEvents: [] },
        },
      },
      prefabScene,
    );
    expect(prepared.files).toEqual([]);
    expect(prepared.diagnostics).toMatchObject([
      { severity: 'warning', location: { path: 'hud.playerName' }, data: { deferred: true } },
    ]);
  });

  it('does not warn about names already declared directly, even when another entity uses a prefab', () => {
    const prepared = preparePresentation(
      {
        manifest: {
          aegis: 'presentation/1',
          hud: { playerName: 'family', winEvent: 'won', loseEvents: [] },
        },
      },
      prefabScene,
    );
    expect(prepared.diagnostics).toBeUndefined();
  });

  it.each([
    ['missing.bin', RenderCode.Asset],
    ['../outside.bin', RenderCode.Path],
    ['https://example.test/mesh.bin', RenderCode.Path],
  ])(
    'still rejects invalid asset dependency %s while initialized-world name checking is deferred',
    (uri, code) => {
      write('rig.gltf', JSON.stringify(model({ buffers: [{ uri, byteLength: 4 }] })));
      const input = source([asset('rig.gltf', 'gltf')], {
        hud: { playerName: 'expanded-child', winEvent: 'won', loseEvents: [] },
      });
      diagnostic(() => preparePresentation(input, prefabScene), code);
      diagnostic(() => preparePresentation(input, { ...prefabScene, entities: [] }), code);
    },
  );

  it('counts glTF dependencies in the aggregate byte budget', () => {
    write(
      'rig.gltf',
      JSON.stringify(
        model({
          buffers: [0, 1].map((i) => ({
            uri: `${i}.bin`,
            byteLength: PRESENTATION_LIMITS.fileBytes,
          })),
        }),
      ),
    );
    for (const i of [0, 1]) {
      write(`${i}.bin`, '');
      truncateSync(join(root, `${i}.bin`), PRESENTATION_LIMITS.fileBytes);
    }
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Budget,
      'total budget',
    );
  });

  it('bounds the file count of the whole closure, not just the manifest asset list', () => {
    const buffers = Array.from({ length: PRESENTATION_LIMITS.assets }, (_, i) => {
      write(`${i}.bin`, 'x');
      return { uri: `${i}.bin`, byteLength: 1 };
    });
    write('rig.gltf', JSON.stringify(model({ buffers })));
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Budget,
      'files',
    );
  });
});

describe('supported media and self-contained SVG', () => {
  it.each([
    ['pixel.png', png, 'texture', 'image/png'],
    ['pixel.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'texture', 'image/jpeg'],
    ['pixel.jpeg', Buffer.from([0xff, 0xd8, 0xff]), 'texture', 'image/jpeg'],
    ['pixel.webp', Buffer.from('RIFF0000WEBP'), 'texture', 'image/webp'],
    ['pixel.svg', svg, 'texture', 'image/svg+xml'],
    ['tone.wav', Buffer.from('RIFF0000WAVE'), 'audio', 'audio/wav'],
    ['tone.ogg', Buffer.from('OggS'), 'audio', 'audio/ogg'],
    ['tone.mp3', Buffer.from('ID3'), 'audio', 'audio/mpeg'],
  ] as const)('accepts %s and reports its delivery MIME', (path, bytes, kind, mime) => {
    write(path, bytes);
    expect(preparePresentation(source([asset(path, kind)])).files).toHaveLength(1);
    expect(presentationMimeType(path)).toBe(mime);
  });

  it.each([
    ['image.ktx2', 'texture'],
    ['audio.aac', 'audio'],
    ['model.obj', 'gltf'],
  ] as const)('refuses unsupported %s rather than falling back', (path, kind) => {
    write(path, 'unsupported content');
    diagnostic(() => preparePresentation(source([asset(path, kind)])), RenderCode.Unsupported);
  });

  it('refuses a mislabeled raster or audio file', () => {
    write('bad.png', 'not an image');
    write('bad.wav', 'not audio');
    diagnostic(() => preparePresentation(source([asset('bad.png')])), RenderCode.Asset);
    diagnostic(() => preparePresentation(source([asset('bad.wav', 'audio')])), RenderCode.Asset);
    expect(presentationMimeType('script.html')).toBe('application/octet-stream');
  });

  it('permits SVG fragment references and embedded image data', () => {
    write(
      'local.svg',
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="shape"/></defs><use href="#shape"/><path fill="url(#shape)"/><image href="data:image/png;base64,${png.toString('base64')}"/></svg>`,
    );
    expect(preparePresentation(source([asset('local.svg')])).files).toHaveLength(1);
  });

  it.each([
    '<image href="https://example.test/pixel.png"/>',
    '<image xlink:href="../pixel.png"/>',
    '<image href="&#104;ttps://example.test/pixel.png"/>',
    '<g xml:base="https://example.test/"><use href="#external"/></g>',
    '<style>path{fill:url(https://example.test/pixel.svg)}</style>',
    '<style>@import "https://example.test/style.css";</style>',
    '<style>@&#105;mport "https://example.test/style.css";</style>',
    '<style>path{fill:u\\72l(https://example.test/pixel.svg)}</style>',
    '<style>path{fill:image-set("https://example.test/a.png" 1x)}</style>',
    '<script>fetch("https://example.test/")</script>',
    '<image href="#safe"><set attributeName="href" to="https://example.test/a.png"/></image>',
    '<foreignObject><iframe src="https://example.test/"/></foreignObject>',
  ])('refuses non-self-contained or active SVG: %s', (body) => {
    write('bad.svg', `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
    diagnostic(() => preparePresentation(source([asset('bad.svg')])), RenderCode.Unsupported);
  });

  it('rejects an external XML entity or stylesheet', () => {
    write('bad.svg', '<!DOCTYPE svg SYSTEM "https://example.test/svg.dtd">' + svg);
    diagnostic(() => preparePresentation(source([asset('bad.svg')])), RenderCode.Unsupported);
    write('bad.svg', '<?xml-stylesheet href="https://example.test/a.css"?>' + svg);
    diagnostic(() => preparePresentation(source([asset('bad.svg')])), RenderCode.Unsupported);
  });
});

describe('glTF and GLB dependency closure', () => {
  it('preserves relative paths, deduplicates shared files, and includes only image/buffer dependencies', () => {
    write(
      'models/rig.gltf',
      JSON.stringify(
        model({
          buffers: [{ uri: 'mesh.bin', byteLength: 4 }],
          images: [{ uri: 'images/pixel.png' }, { uri: 'images/pixel.png' }],
          extras: { documentation: 'https://example.test/not-a-runtime-request' },
        }),
      ),
    );
    write('models/mesh.bin', 'mesh');
    write('models/images/pixel.png', png);
    write('models/unused.bin', 'never fetched');
    const input = source([
      asset('models/rig.gltf', 'gltf'),
      asset('models/images/pixel.png', 'texture', 'map'),
    ]);
    const prepared = preparePresentation(input);
    expect(prepared.files.map((file) => file.path)).toEqual([
      'models/images/pixel.png',
      'models/mesh.bin',
      'models/rig.gltf',
    ]);
    expect(prepared.totalBytes).toBe(prepared.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(prepared.files.every((file) => file.provenance?.license === 'MIT')).toBe(true);
  });

  it('uses a dependency’s explicit provenance regardless of the manifest’s asset order', () => {
    const textureCredit = {
      author: 'Texture author',
      license: 'CC0-1.0',
      source: 'original texture',
    };
    write('rig.gltf', JSON.stringify(model({ images: [{ uri: 'pixel.png' }] })));
    write('pixel.png', png);
    const prepared = preparePresentation(
      source([
        asset('rig.gltf', 'gltf'),
        { ...asset('pixel.png', 'texture', 'map'), provenance: textureCredit },
      ]),
    );
    expect(prepared.files.find((file) => file.path === 'pixel.png')?.provenance).toEqual(
      textureCredit,
    );
  });

  it('permits embedded buffers and images without inventing files', () => {
    write(
      'rig.gltf',
      JSON.stringify(
        model({
          buffers: [
            { uri: 'data:application/octet-stream;base64,AAEC/w==', byteLength: 4 },
            { uri: 'data:application/gltf-buffer,%00%ff%7f', byteLength: 3 },
          ],
          images: [{ uri: `data:image/png;base64,${png.toString('base64')}` }],
        }),
      ),
    );
    expect(
      preparePresentation(source([asset('rig.gltf', 'gltf')])).files.map((file) => file.path),
    ).toEqual(['rig.gltf']);
  });

  it('inspects a GLB JSON chunk and checks both external and BIN-backed images', () => {
    write(
      'external.glb',
      glb(model({ buffers: [{ uri: 'mesh.bin', byteLength: 4 }], images: [{ uri: 'pixel.png' }] })),
    );
    write('mesh.bin', 'mesh');
    write('pixel.png', png);
    write(
      'embedded.glb',
      glb(
        model({
          buffers: [{ byteLength: png.length }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
          images: [{ bufferView: 0, mimeType: 'image/png' }],
        }),
        png,
      ),
    );
    const prepared = preparePresentation(
      source([asset('external.glb', 'gltf'), asset('embedded.glb', 'gltf', 'embedded')]),
    );
    expect(prepared.files.map((file) => file.path)).toEqual([
      'embedded.glb',
      'external.glb',
      'mesh.bin',
      'pixel.png',
    ]);
    expect(presentationMimeType('external.glb')).toBe('model/gltf-binary');
    expect(presentationMimeType('model.gltf')).toBe('model/gltf+json');
    expect(presentationMimeType('mesh.bin')).toBe('application/octet-stream');
  });

  it.each([
    'https://example.test/mesh.bin',
    '//example.test/mesh.bin',
    '../mesh.bin',
    '/mesh.bin',
    'file:///mesh.bin',
    'mesh.bin?x=1',
    'mesh.bin#x',
    '%6desh.bin',
    'folder\\mesh.bin',
  ])('rejects an escaping or nonlocal dependency: %s', (uri) => {
    write('rig.gltf', JSON.stringify(model({ buffers: [{ uri, byteLength: 1 }] })));
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Path,
      'URI',
    );
  });

  it('rejects missing and symlink-escaping dependencies with the glTF field', () => {
    write('rig.gltf', JSON.stringify(model({ images: [{ uri: 'pixel.png' }] })));
    const error = diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Asset,
    );
    expect(error.diagnostics[0]?.location?.path).toBe('assets[0].images[0].uri');
    const outside = join(workspace, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'pixel.png'), png);
    symlinkSync(outside, join(root, 'escaped'), 'junction');
    write('rig.gltf', JSON.stringify(model({ images: [{ uri: 'escaped/pixel.png' }] })));
    diagnostic(() => preparePresentation(source([asset('rig.gltf', 'gltf')])), RenderCode.Path);
  });

  it.each([
    'KHR_draco_mesh_compression',
    'EXT_meshopt_compression',
    'KHR_texture_basisu',
    'EXT_texture_avif',
    'UNKNOWN_decoder',
  ])('rejects required decoder/unknown extension %s inside GLB as well as JSON', (extension) => {
    write('rig.glb', glb(model({ extensionsRequired: [extension] })));
    diagnostic(
      () => preparePresentation(source([asset('rig.glb', 'gltf')])),
      RenderCode.Unsupported,
      extension,
    );
  });

  it('rejects decoder usage even when its required declaration was omitted', () => {
    write(
      'rig.gltf',
      JSON.stringify(
        model({
          meshes: [
            { primitives: [{ extensions: { KHR_draco_mesh_compression: { bufferView: 0 } } }] },
          ],
        }),
      ),
    );
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Unsupported,
      'KHR_draco_mesh_compression',
    );
  });

  it('accepts supported non-decoder extensions without requiring a CDN', () => {
    write(
      'rig.gltf',
      JSON.stringify(
        model({
          extensionsRequired: [
            'KHR_materials_unlit',
            'KHR_texture_transform',
            'KHR_mesh_quantization',
          ],
        }),
      ),
    );
    expect(preparePresentation(source([asset('rig.gltf', 'gltf')])).files).toHaveLength(1);
  });

  it('rejects older glTF versions and malformed JSON/GLB', () => {
    write('rig.gltf', JSON.stringify(model({ asset: { version: '1.0' } })));
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Unsupported,
    );
    write('rig.gltf', '{');
    diagnostic(() => preparePresentation(source([asset('rig.gltf', 'gltf')])), RenderCode.Asset);
    const malformed = glb(model());
    malformed.writeUInt32LE(malformed.length + 4, 8);
    write('rig.glb', malformed);
    diagnostic(
      () => preparePresentation(source([asset('rig.glb', 'gltf')])),
      RenderCode.Asset,
      'GLB',
    );
    write('rig.glb', Buffer.from('glTF'));
    diagnostic(() => preparePresentation(source([asset('rig.glb', 'gltf')])), RenderCode.Asset);
  });

  it('checks buffers and embedded images rather than accepting broken view references', () => {
    write(
      'rig.gltf',
      JSON.stringify(
        model({ buffers: [{ uri: 'data:application/octet-stream;base64,AA==', byteLength: 8 }] }),
      ),
    );
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Asset,
      'shorter',
    );
    write(
      'rig.glb',
      glb(
        model({
          buffers: [{ byteLength: png.length }],
          bufferViews: [{ buffer: 0, byteOffset: png.length, byteLength: 1 }],
          images: [{ bufferView: 0, mimeType: 'image/png' }],
        }),
        png,
      ),
    );
    diagnostic(
      () => preparePresentation(source([asset('rig.glb', 'gltf')])),
      RenderCode.Asset,
      'bufferView',
    );
    write(
      'rig.gltf',
      JSON.stringify(
        model({
          images: [
            {
              uri:
                'data:image/svg+xml,' +
                encodeURIComponent(
                  '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/pixel.png"/></svg>',
                ),
            },
          ],
        }),
      ),
    );
    diagnostic(
      () => preparePresentation(source([asset('rig.gltf', 'gltf')])),
      RenderCode.Unsupported,
      'SVG',
    );
  });
});

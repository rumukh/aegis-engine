import { describe, expect, it } from 'vitest';
import { FIXTURE_MANIFEST } from '../testing/presentation-fixture.js';
import { RenderCode, isAssetPath } from './diagnostics.js';
import { validatePresentation } from './validate.js';

describe('presentation data validation', () => {
  it('validates win camera, bounded timeline and declared presentation-only audio cues', () => {
    const ending = {
      model: 'set',
      clip: 'Departure',
      camera: { eye: 'eye', target: 'target' },
      title: 'Safe',
      message: 'Home.',
    };
    const base = {
      aegis: 'presentation/1',
      assets: [
        {
          id: 'set',
          kind: 'gltf',
          src: 'set.glb',
          provenance: { author: 'Aegis', license: 'Original', source: 'fixture' },
        },
      ],
      hud: { playerName: 'player', winEvent: 'level.completed', loseEvents: [] },
      audio: { cues: [{ event: 'presentation.separated', caption: { text: 'Clear.' } }] },
    };
    expect(validatePresentation({ ...base, ui: { winEnding: ending } }).ok).toBe(true);
    expect(
      validatePresentation({
        ...base,
        ui: { winEnding: { ...ending, cues: [{ atSeconds: 4, event: 'presentation.separated' }] } },
      }).ok,
    ).toBe(true);
    for (const change of [
      { model: 'absent' },
      { fadeSeconds: 4 },
      { camera: { eye: 'same', target: 'same' } },
      { camera: { eye: 'eye', target: 'target', fov: 180 } },
      { cues: [{ atSeconds: 4, event: 'level.completed' }] },
      { cues: [{ atSeconds: 4, event: 'presentation.missing' }] },
      { captions: [{ startSeconds: 4, endSeconds: 2, text: 'Reversed' }] },
      {
        captions: [
          { startSeconds: 0, endSeconds: 3, text: 'A' },
          { startSeconds: 2, endSeconds: 4, text: 'B' },
        ],
      },
    ])
      expect(
        validatePresentation({ ...base, ui: { winEnding: { ...ending, ...change } } }).ok,
      ).toBe(false);
    expect(validatePresentation({ ...base, hud: undefined, ui: { winEnding: ending } }).ok).toBe(
      false,
    );
  });
  it('bounds opt-in loss fading and requires authoritative loss events without changing omission defaults', () => {
    const hud = { playerName: 'player', winEvent: 'won', loseEvents: ['lost'] };
    expect(
      validatePresentation({
        aegis: 'presentation/1',
        hud,
        ui: { lossEnding: { fadeSeconds: 1, title: 'Caught' } },
      }).ok,
    ).toBe(true);
    for (const lossEnding of [
      null,
      { fadeSeconds: -1 },
      { fadeSeconds: 3 },
      { fadeSeconds: Infinity },
      { cameraFall: true },
    ])
      expect(validatePresentation({ aegis: 'presentation/1', hud, ui: { lossEnding } }).ok).toBe(
        false,
      );
    expect(validatePresentation({ aegis: 'presentation/1', ui: { lossEnding: {} } }).ok).toBe(
      false,
    );
    expect(validatePresentation({ aegis: 'presentation/1', hud, ui: {} }).ok).toBe(true);
  });
  it('accepts a real textured/model/audio fixture and an explicit primitive-only descriptor', () => {
    expect(validatePresentation(FIXTURE_MANIFEST).ok).toBe(true);
    expect(validatePresentation({ aegis: 'presentation/1' }).ok).toBe(true);
  });

  it.each([
    { aegis: 'presentation/2' },
    { aegis: 'presentation/1', asssets: [] },
    { aegis: 'presentation/1', quality: 'ultra' },
    { aegis: 'presentation/1', environment: { fog: { color: '#abcdef', near: 2, far: 1 } } },
    { aegis: 'presentation/1', environment: { ambient: { color: '#ffffff', intensity: NaN } } },
    { aegis: 'presentation/1', legacy: { level: false } },
  ])('rejects invalid shape or a silent legacy-layer removal: %j', (document) => {
    const result = validatePresentation(document);
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]?.fix).toBeTruthy();
  });

  it('reports all independent missing references instead of accepting unused IDs', () => {
    const result = validatePresentation(
      {
        aegis: 'presentation/1',
        materials: [{ id: 'wrong', shading: 'standard', map: 'missing' }],
        surfaces: { wall: 'absent' },
        entities: [{ target: { name: 'hero' }, visual: { kind: 'model', mesh: 'unknown' } }],
      },
      'test.presentation.json',
    );
    expect(result.diagnostics.filter((d) => d.code === RenderCode.Reference)).toHaveLength(3);
    expect(result.diagnostics.every((d) => d.location?.file === 'test.presentation.json')).toBe(
      true,
    );
  });

  it('accepts explicit iso framing data and rejects unbounded or misspelled camera fields', () => {
    for (const camera of [
      { framing: 'follow' },
      { framing: 'level', padding: 0 },
      { framing: 'level', padding: 1.5 },
    ]) {
      expect(validatePresentation({ aegis: 'presentation/1', camera }).ok).toBe(true);
    }
    for (const camera of [
      null,
      {},
      { framing: 'automatic' },
      { framing: 'level', padding: -1 },
      { framing: 'level', padding: Infinity },
      { framing: 'level', padding: '1' },
      { framing: 'level', paddding: 1 },
    ]) {
      const result = validatePresentation({ aegis: 'presentation/1', camera });
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some((diagnostic) => diagnostic.location?.path?.startsWith('camera')),
      ).toBe(true);
    }
  });

  it('validates atlas/state sequence membership and rejects fields for another visual kind', () => {
    const valid = structuredClone(FIXTURE_MANIFEST);
    valid.entities = [
      {
        target: { role: 'player' },
        visual: {
          kind: 'sprite',
          texture: 'surface',
          animations: { move: { frames: ['left', 'right'], frameTicks: 6 } },
        },
      },
    ];
    expect(validatePresentation(valid).ok).toBe(true);
    const bad = {
      ...valid,
      entities: [
        {
          target: { name: 'hero' },
          visual: {
            kind: 'sprite',
            texture: 'surface',
            mesh: 'rig',
            animations: { idle: { frames: ['typo'], frameTicks: 0 } },
          },
        },
      ],
    };
    const result = validatePresentation(bad);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes('typo'))).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects duplicate IDs and instanced animation instead of silently guessing', () => {
    const result = validatePresentation({
      ...FIXTURE_MANIFEST,
      assets: [...FIXTURE_MANIFEST.assets!, FIXTURE_MANIFEST.assets![0]],
      objects: [
        { id: 'duplicates', visual: { kind: 'model', mesh: 'rig', clip: 'spin' }, instances: [{}] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes('Duplicate'))).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes('Instanced models'))).toBe(true);
  });

  it('enforces finite instance and light budgets', () => {
    const result = validatePresentation({
      aegis: 'presentation/1',
      objects: [
        {
          id: 'batch',
          visual: { kind: 'primitive', shape: 'box' },
          instances: Array.from({ length: 4097 }, () => ({})),
        },
      ],
      environment: {
        points: Array.from({ length: 9 }, () => ({
          color: '#ffffff',
          intensity: 1,
          position: [0, 0, 0],
          distance: 10,
        })),
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.filter((d) => d.code === RenderCode.Budget).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it.each([
    '../secret',
    '/root.png',
    'C:\\file.png',
    'https://host/image.png',
    'safe/%2e%2e/x',
    'x.png?query',
    'x.png#fragment',
    'a//b',
  ])('rejects non-local or ambiguous paths: %s', (path) => {
    expect(isAssetPath(path)).toBe(false);
  });

  it('accepts ordinary asset folders as the path validator positive control', () => {
    expect(isAssetPath('textures/ship-deck_01.png')).toBe(true);
  });
});

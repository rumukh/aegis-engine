import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preparePresentation } from '../packages/render-three/src/presentation/files.js';
import { validatePresentation } from '../packages/render-three/src/presentation/validate.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STUDIES = new URL('../poc/previews/asset-studies.presentation.json', import.meta.url);

function manifest() {
  const parsed: unknown = JSON.parse(readFileSync(STUDIES, 'utf8'));
  const result = validatePresentation(parsed);
  if (!result.ok || result.value === undefined) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.value;
}

describe('standalone PoC asset studies', () => {
  it('declares actual study resources, without a scene, game bindings or audio', () => {
    const study = manifest();
    expect(study.assets?.map((asset) => asset.id)).toEqual([
      'engineer',
      'operative',
      'console',
      'kestrel',
      'rifle',
      'deck-color',
      'deck-normal',
    ]);
    expect(study.entities).toBeUndefined();
    expect(study.objects).toBeUndefined();
    expect(study.effects).toBeUndefined();
    expect(study.audio).toBeUndefined();
    expect(study.hud).toBeUndefined();
    expect(study.materials).toEqual([
      {
        id: 'deck',
        shading: 'standard',
        map: 'deck-color',
        normalMap: 'deck-normal',
        roughness: 0.65,
        metalness: 0.45,
        repeat: [2, 2],
      },
    ]);
  });

  it('prepares real local dependencies and fingerprints without including executable game files', () => {
    const prepared = preparePresentation({ manifest: manifest(), assetRoot: ROOT });
    expect(prepared.totalBytes).toBeGreaterThan(1_000_000);
    expect(prepared.totalBytes).toBeLessThan(2_000_000);
    const paths = prepared.files.map((file) => file.path);
    expect(paths).toContain('games/iso/assets/terminal-locked.png');
    expect(paths).toContain('games/iso/assets/terminal-active.png');
    expect(paths).toContain('games/fps/assets/generated/kestrel-security.glb');
    expect(paths.every((path) => /\.(?:gltf|glb|png|svg)$/.test(path))).toBe(true);
    for (const file of prepared.files) {
      const bytes = readFileSync(file.source);
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(file.provenance?.license).toBe('MIT');
    }
  });

  it('keeps review atlas selections aligned with the separately authored sprite sheet', () => {
    const engineer = manifest().assets?.find((asset) => asset.id === 'engineer');
    if (engineer?.kind !== 'texture') throw new Error('Missing engineer texture study.');
    const atlas = JSON.parse(
      readFileSync(new URL('../games/platformer/assets/atlas.json', import.meta.url), 'utf8'),
    ) as {
      textures: {
        engineer: {
          width: number;
          height: number;
          frames: Record<string, { x: number; y: number; width: number; height: number }>;
        };
      };
    };
    const sheet = atlas.textures.engineer;
    expect([sheet.width, sheet.height]).toEqual([1280, 384]);
    for (const [reviewName, sourceName] of [
      ['idle', 'idle-0'],
      ['run', 'run-0'],
      ['jump', 'jump'],
      ['victory', 'win-0'],
    ] as const) {
      const frame = sheet.frames[sourceName];
      if (frame === undefined) throw new Error(`Missing source frame ${sourceName}.`);
      expect(engineer.frames?.[reviewName]).toEqual([
        frame.x / sheet.width,
        frame.y / sheet.height,
        (frame.x + frame.width) / sheet.width,
        (frame.y + frame.height) / sheet.height,
      ]);
    }
  });
});

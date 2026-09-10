import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const ROOT = join('games', 'platformer', 'assets');
const execute = promisify(execFile);

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Sheet {
  file: string;
  width: number;
  height: number;
  frames?: Record<string, Frame>;
  anchor?: { x: number; y: number };
  deck?: { left: number; top: number; right: number };
  standalone?: Record<string, string>;
}
interface Atlas {
  textures: Record<string, Sheet>;
}
interface Provenance {
  license: string;
  sources: { file?: string; files?: string[]; source?: string; kind: string }[];
}

async function inventory(): Promise<{ atlas: Atlas; provenance: Provenance }> {
  return {
    atlas: JSON.parse(await readFile(join(ROOT, 'atlas.json'), 'utf8')) as Atlas,
    provenance: JSON.parse(await readFile(join(ROOT, 'provenance.json'), 'utf8')) as Provenance,
  };
}

describe('Coyote Gap original presentation assets', () => {
  it('ships self-contained sized images and bounded nonempty audio with recorded provenance', async () => {
    const { atlas, provenance } = await inventory();
    expect(provenance.license).toBe('MIT');
    const files = provenance.sources.flatMap(
      (source) => source.files ?? (source.file === undefined ? [] : [source.file]),
    );
    expect(new Set(files).size).toBe(files.length);
    expect(files).toHaveLength(29);
    let bytes = 0;
    for (const file of files) {
      const content = await readFile(join(ROOT, file));
      bytes += content.length;
      expect(content.length, file).toBeGreaterThan(200);
      if (file.endsWith('.svg')) {
        const svg = content.toString('utf8');
        expect(svg, file).toMatch(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        expect(svg, file).toMatch(/width="\d+" height="\d+"/);
        expect(svg, file).not.toMatch(/<script|<image|<foreignObject|href=|@import/i);
        expect(svg, file).not.toContain('\r');
      }
    }
    expect(bytes).toBeLessThan(2_000_000);
    for (const sheet of Object.values(atlas.textures)) {
      const svg = await readFile(join(ROOT, sheet.file), 'utf8');
      expect(svg).toContain(`width="${sheet.width}" height="${sheet.height}"`);
      for (const frame of Object.values(sheet.frames ?? {})) {
        expect(frame.x).toBeGreaterThanOrEqual(0);
        expect(frame.y).toBeGreaterThanOrEqual(0);
        expect(frame.width).toBeGreaterThan(0);
        expect(frame.height).toBeGreaterThan(0);
        expect(frame.x + frame.width).toBeLessThanOrEqual(sheet.width);
        expect(frame.y + frame.height).toBeLessThanOrEqual(sheet.height);
      }
    }
  });

  it('pins the authored foot/deck landmarks and explicit invisible effect end frames', async () => {
    const { atlas } = await inventory();
    expect(atlas.textures.engineer?.anchor).toEqual({ x: 80, y: 180 });
    expect(atlas.textures.critter?.anchor).toEqual({ x: 64, y: 110 });
    expect(atlas.textures.ferry?.deck).toEqual({ left: 17, top: 35, right: 495 });
    expect(atlas.textures.engineer?.frames).toHaveProperty('win-2');
    expect(atlas.textures.critter?.frames?.clear).toEqual({
      x: 640,
      y: 0,
      width: 128,
      height: 128,
    });
    expect(atlas.textures.effects?.frames?.clear).toEqual({
      x: 1024,
      y: 0,
      width: 128,
      height: 128,
    });
    expect(await readFile(join(ROOT, 'critter.svg'), 'utf8')).toContain(
      '<g transform="translate(640 0)" ></g>',
    );
    expect(await readFile(join(ROOT, 'effects.svg'), 'utf8')).toContain(
      '<g transform="translate(1024 0)" ></g>',
    );
  });

  it('exports standalone terrain from the very same authored cells as its atlas', async () => {
    const { atlas } = await inventory();
    const terrain = atlas.textures.terrain!;
    const svg = await readFile(join(ROOT, terrain.file), 'utf8');
    const files = Object.values(terrain.standalone ?? {});
    expect(files).toHaveLength(12);
    for (const file of files) {
      const cell = await readFile(join(ROOT, file), 'utf8');
      expect(cell).toContain('width="128" height="128"');
      const body = /<\/defs>([\s\S]*)<\/svg>/.exec(cell)?.[1];
      expect(body?.length, file).toBeGreaterThan(30);
      expect(svg, file).toContain(body);
    }
  });

  it('contains original nonclipping PCM cues and a restrained twelve-second ambient loop', async () => {
    const names = ['jump', 'landing', 'stomp', 'ferry', 'beacon', 'fall', 'canyon-air'];
    for (const name of names) {
      const bytes = await readFile(join(ROOT, `${name}.wav`));
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ');
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(bytes.readUInt16LE(20)).toBe(1);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(22050);
      expect(bytes.readUInt16LE(34)).toBe(16);
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
      let peak = 0;
      let energy = 0;
      for (let i = 44; i < bytes.length; i += 2) {
        const sample = bytes.readInt16LE(i) / 32767;
        peak = Math.max(peak, Math.abs(sample));
        energy += sample * sample;
      }
      expect(peak, name).toBeGreaterThan(0.01);
      expect(peak, name).toBeLessThan(0.5);
      expect(energy, name).toBeGreaterThan(0);
      const seconds = (bytes.length - 44) / 44100;
      if (name === 'canyon-air') expect(seconds).toBe(12);
      else expect(seconds).toBeLessThanOrEqual(1.8);
    }
  });

  it('regenerates every procedural asset byte-for-byte outside the working tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aegis-coyote-assets-'));
    try {
      for (const script of ['generate.mjs', 'generate-audio.mjs']) {
        await execute(process.execPath, [join(ROOT, 'source', script), '--out', directory], {
          timeout: 15_000,
        });
      }
      const outputs = await readdir(directory);
      expect(outputs).toHaveLength(30);
      for (const file of outputs) {
        expect(await readFile(join(directory, file)), file).toEqual(
          await readFile(join(ROOT, file)),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

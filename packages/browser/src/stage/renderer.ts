import type { Matrix } from '../animation/sample.js';

/** A decoded image owned by a renderer. */
export interface StageTexture {
  readonly width: number;
  readonly height: number;
  /** Decoded bytes owned for this image: width x height x 4. */
  readonly bytes: number;
}
export interface Quad {
  texture: StageTexture;
  /** Source rectangle in texture pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Maps the source rectangle's local pixels (0..sw, 0..sh) to device pixels. */
  matrix: Matrix;
  opacity: number;
  /** Multiply colour, `#rrggbb`. */
  tint?: string;
  /** Optional mask region, same size as the source rectangle (tint applies where mask alpha). */
  mask?: { texture: StageTexture; sx: number; sy: number };
}
export interface Grade {
  /** 1 = unchanged. */
  brightness: number;
  /** 0 = unchanged, 1 = strongly warm. */
  warmth: number;
}
export interface StageRenderer {
  readonly kind: 'webgl' | 'canvas';
  createTexture(image: TexImageSource & { width: number; height: number }): StageTexture;
  deleteTexture(texture: StageTexture): void;
  resize(width: number, height: number): void;
  begin(clear: string, grade: Grade): void;
  draw(quad: Quad): void;
  /** Solid rectangle in device pixels, e.g. letterbox bars and fade transitions. */
  fill(x: number, y: number, width: number, height: number, color: string, opacity: number): void;
  end(): { drawCalls: number; quads: number };
  /** True when the context was lost; the stage then recreates textures. */
  lost(): boolean;
  dispose(): void;
}

export function parseColor(color: string): [number, number, number] {
  const value = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? 'ffffff';
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

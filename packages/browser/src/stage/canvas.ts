import { BrowserServiceError } from '../errors.js';
import type { Grade, Quad, StageRenderer, StageTexture } from './renderer.js';

interface CanvasTexture extends StageTexture {
  image: CanvasImageSource | null;
}
type Surface = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Canvas 2D fallback for devices without WebGL (ADR-0013). Tinted parts are composed once per
 * (frame, colour) into a cached surface, never per frame.
 */
export class Canvas2DRenderer implements StageRenderer {
  readonly kind = 'canvas' as const;
  private readonly context: CanvasRenderingContext2D;
  private readonly textures = new Set<CanvasTexture>();
  private readonly tinted = new Map<string, { surface: Surface; texture: CanvasTexture }>();
  private grade: Grade = { brightness: 1, warmth: 0 };
  private quads = 0;
  private readonly ids = new WeakMap<StageTexture, number>();
  private nextId = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new BrowserServiceError('unavailable', 'Canvas 2D is unavailable.');
    this.context = context;
  }

  private surface(width: number, height: number): Surface {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const element = this.canvas.ownerDocument.createElement('canvas');
    element.width = width;
    element.height = height;
    return element;
  }

  private id(texture: StageTexture): number {
    let id = this.ids.get(texture);
    if (!id) {
      id = this.nextId++;
      this.ids.set(texture, id);
    }
    return id;
  }

  createTexture(image: TexImageSource & { width: number; height: number }): StageTexture {
    const texture: CanvasTexture = {
      width: image.width,
      height: image.height,
      bytes: image.width * image.height * 4,
      image: image as CanvasImageSource,
    };
    this.textures.add(texture);
    return texture;
  }

  deleteTexture(texture: StageTexture): void {
    const owned = texture as CanvasTexture;
    if (!this.textures.delete(owned)) return;
    const id = this.ids.get(texture);
    for (const key of [...this.tinted.keys()])
      if (id !== undefined && (key.startsWith(`${String(id)}:`) || key.includes(`|${String(id)}:`)))
        this.tinted.delete(key);
    if (owned.image && 'close' in owned.image && typeof owned.image.close === 'function')
      owned.image.close();
    owned.image = null;
  }

  /** Bytes held by cached tinted surfaces (counted in the stage's owned memory). */
  cacheBytes(): number {
    let total = 0;
    for (const entry of this.tinted.values()) total += entry.texture.bytes;
    return total;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = Math.max(1, width);
    if (this.canvas.height !== height) this.canvas.height = Math.max(1, height);
  }

  begin(clear: string, grade: Grade): void {
    this.quads = 0;
    this.grade = grade;
    const c = this.context;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = clear;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private tint(quad: Quad): CanvasImageSource | undefined {
    const texture = quad.texture as CanvasTexture;
    if (!texture.image) return undefined;
    const mask = quad.mask?.texture as CanvasTexture | undefined;
    const key = `${String(this.id(texture))}:${String(quad.sx)},${String(quad.sy)},${String(quad.sw)},${String(quad.sh)}|${mask ? `${String(this.id(mask))}:${String(quad.mask!.sx)},${String(quad.mask!.sy)}` : '-'}|${quad.tint!}`;
    const cached = this.tinted.get(key);
    if (cached) return cached.surface;
    const surface = this.surface(quad.sw, quad.sh);
    const c = surface.getContext('2d') as Context2D;
    // Colour layer limited to the mask (or the whole part), multiplied onto the part.
    const layer = this.surface(quad.sw, quad.sh);
    const l = layer.getContext('2d') as Context2D;
    if (mask?.image)
      l.drawImage(
        mask.image,
        quad.mask!.sx,
        quad.mask!.sy,
        quad.sw,
        quad.sh,
        0,
        0,
        quad.sw,
        quad.sh,
      );
    else l.drawImage(texture.image, quad.sx, quad.sy, quad.sw, quad.sh, 0, 0, quad.sw, quad.sh);
    l.globalCompositeOperation = 'source-in';
    l.fillStyle = quad.tint!;
    l.fillRect(0, 0, quad.sw, quad.sh);
    c.drawImage(texture.image, quad.sx, quad.sy, quad.sw, quad.sh, 0, 0, quad.sw, quad.sh);
    c.globalCompositeOperation = 'multiply';
    c.drawImage(layer, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(texture.image, quad.sx, quad.sy, quad.sw, quad.sh, 0, 0, quad.sw, quad.sh);
    this.tinted.set(key, {
      surface,
      texture: { width: quad.sw, height: quad.sh, bytes: quad.sw * quad.sh * 4, image: surface },
    });
    return surface;
  }

  draw(quad: Quad): void {
    const texture = quad.texture as CanvasTexture;
    if (!texture.image || quad.opacity <= 0) return;
    const c = this.context;
    const m = quad.matrix;
    c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    c.globalAlpha = Math.min(1, quad.opacity);
    if (quad.tint) {
      const tinted = this.tint(quad);
      if (tinted) c.drawImage(tinted, 0, 0, quad.sw, quad.sh);
    } else c.drawImage(texture.image, quad.sx, quad.sy, quad.sw, quad.sh, 0, 0, quad.sw, quad.sh);
    this.quads++;
  }

  fill(x: number, y: number, width: number, height: number, color: string, opacity: number): void {
    if (opacity <= 0) return;
    const c = this.context;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = Math.min(1, opacity);
    c.fillStyle = color;
    c.fillRect(x, y, width, height);
  }

  end(): { drawCalls: number; quads: number } {
    const { brightness, warmth } = this.grade;
    const c = this.context;
    c.setTransform(1, 0, 0, 1, 0, 0);
    // Comfort grade without `ctx.filter`, which Safari lacks: a warm multiply and a light screen.
    if (warmth > 0) {
      c.globalCompositeOperation = 'multiply';
      c.globalAlpha = Math.min(1, warmth * 0.35);
      c.fillStyle = '#ffd7a8';
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (brightness > 1) {
      c.globalCompositeOperation = 'screen';
      c.globalAlpha = Math.min(1, (brightness - 1) * 1.2);
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    return { drawCalls: this.quads, quads: this.quads };
  }

  lost(): boolean {
    return false;
  }

  dispose(): void {
    for (const texture of [...this.textures]) this.deleteTexture(texture);
    this.tinted.clear();
  }
}

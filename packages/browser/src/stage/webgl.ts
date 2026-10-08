import { BrowserServiceError } from '../errors.js';
import { parseColor } from './renderer.js';
import type { Grade, Quad, StageRenderer, StageTexture } from './renderer.js';

const VERTEX = `
attribute vec2 a_position;
attribute vec2 a_uv;
attribute vec2 a_maskUv;
attribute vec4 a_tint;
attribute float a_mask;
uniform vec2 u_resolution;
varying vec2 v_uv;
varying vec2 v_maskUv;
varying vec4 v_tint;
varying float v_mask;
void main() {
  v_uv = a_uv;
  v_maskUv = a_maskUv;
  v_tint = a_tint;
  v_mask = a_mask;
  gl_Position = vec4(a_position.x / u_resolution.x * 2.0 - 1.0, 1.0 - a_position.y / u_resolution.y * 2.0, 0.0, 1.0);
}`;
// Textures are premultiplied on upload; multiply tint commutes with premultiplication.
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_texture;
uniform sampler2D u_maskTexture;
uniform vec2 u_grade;
varying vec2 v_uv;
varying vec2 v_maskUv;
varying vec4 v_tint;
varying float v_mask;
void main() {
  vec4 color = texture2D(u_texture, v_uv);
  float amount = v_mask > 0.5 ? texture2D(u_maskTexture, v_maskUv).a : 1.0;
  vec3 rgb = color.rgb * mix(vec3(1.0), v_tint.rgb, amount);
  rgb = rgb * u_grade.x + u_grade.y * vec3(0.08, 0.03, -0.06) * color.a;
  gl_FragColor = vec4(clamp(rgb, 0.0, color.a), color.a) * v_tint.a;
}`;
const FLOATS = 11;
const MAX_QUADS = 4096;

interface GlTexture extends StageTexture {
  handle: WebGLTexture | null;
  generation: number;
}

/** A minimal batched textured-quad renderer on WebGL 1 (no three.js), see ADR-0013. */
export class WebGlRenderer implements StageRenderer {
  readonly kind = 'webgl' as const;
  private readonly gl: WebGLRenderingContext;
  private program!: WebGLProgram;
  private buffer!: WebGLBuffer;
  private indices!: WebGLBuffer;
  private readonly data = new Float32Array(MAX_QUADS * 4 * FLOATS);
  private count = 0;
  private texture?: GlTexture;
  private maskTexture?: GlTexture;
  private white!: GlTexture;
  private drawCalls = 0;
  private quads = 0;
  private width = 1;
  private height = 1;
  private isLost = false;
  private generation = 0;
  private readonly textures = new Set<GlTexture>();
  private readonly onLost = (event: Event): void => {
    event.preventDefault();
    this.isLost = true;
  };
  private readonly onRestored = (): void => {
    this.isLost = false;
    this.setup();
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    });
    if (!gl) throw new BrowserServiceError('unavailable', 'WebGL is unavailable.');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.setup();
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost())
      throw new BrowserServiceError(
        'unavailable',
        `Shader failed: ${String(gl.getShaderInfoLog(shader))}`,
      );
    return shader;
  }

  private setup(): void {
    const gl = this.gl;
    this.generation++;
    const program = gl.createProgram()!;
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
      throw new BrowserServiceError('unavailable', 'Stage shader program failed to link.');
    this.program = program;
    gl.useProgram(program);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const index = new Uint16Array(MAX_QUADS * 6);
    for (let i = 0, v = 0; i < index.length; i += 6, v += 4)
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i);
    this.indices = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    const stride = FLOATS * 4;
    const attribute = (name: string, size: number, offset: number): void => {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
    };
    attribute('a_position', 2, 0);
    attribute('a_uv', 2, 2);
    attribute('a_maskUv', 2, 4);
    attribute('a_tint', 4, 6);
    attribute('a_mask', 1, 10);
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_maskTexture'), 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const pixel = new Uint8Array([255, 255, 255, 255]);
    this.white = this.upload(undefined, 1, 1, pixel);
    this.textures.delete(this.white);
  }

  private upload(
    image: (TexImageSource & { width: number; height: number }) | undefined,
    width: number,
    height: number,
    pixels?: Uint8Array,
  ): GlTexture {
    const gl = this.gl;
    const handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels ?? null,
      );
    const texture: GlTexture = {
      width,
      height,
      bytes: width * height * 4,
      handle,
      generation: this.generation,
    };
    this.textures.add(texture);
    return texture;
  }

  createTexture(image: TexImageSource & { width: number; height: number }): StageTexture {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    if (image.width > max || image.height > max)
      throw new BrowserServiceError(
        'limit',
        `Texture exceeds this device's ${String(max)} px limit.`,
      );
    return this.upload(image, image.width, image.height);
  }

  deleteTexture(texture: StageTexture): void {
    const owned = texture as GlTexture;
    if (!this.textures.delete(owned)) return;
    if (owned.generation === this.generation) this.gl.deleteTexture(owned.handle);
    owned.handle = null;
  }

  /** Whether a texture belongs to the current context generation (false after a context loss). */
  valid(texture: StageTexture): boolean {
    return (
      (texture as GlTexture).generation === this.generation &&
      (texture as GlTexture).handle !== null
    );
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
  }

  begin(clear: string, grade: Grade): void {
    const gl = this.gl;
    this.drawCalls = 0;
    this.quads = 0;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_resolution'), this.width, this.height);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_grade'), grade.brightness, grade.warmth);
    const [r, g, b] = parseColor(clear);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private flush(): void {
    if (!this.count || !this.texture) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * 4 * FLOATS));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, (this.maskTexture ?? this.white).handle);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture.handle);
    gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_SHORT, 0);
    this.drawCalls++;
    this.count = 0;
  }

  private push(
    texture: GlTexture,
    mask: GlTexture | undefined,
    corners: readonly [number, number][],
    uv: readonly [number, number, number, number],
    maskUv: readonly [number, number, number, number],
    rgba: readonly [number, number, number, number],
    masked: number,
  ): void {
    if (
      texture !== this.texture ||
      (masked && mask !== this.maskTexture) ||
      this.count >= MAX_QUADS
    ) {
      this.flush();
      this.texture = texture;
      if (masked) this.maskTexture = mask;
    }
    const [u0, v0, u1, v1] = uv;
    const [m0, n0, m1, n1] = maskUv;
    const uvs: [number, number, number, number][] = [
      [u0, v0, m0, n0],
      [u1, v0, m1, n0],
      [u0, v1, m0, n1],
      [u1, v1, m1, n1],
    ];
    let offset = this.count * 4 * FLOATS;
    for (let i = 0; i < 4; i++) {
      const [x, y] = corners[i]!;
      const [u, v, mu, mv] = uvs[i]!;
      this.data.set([x, y, u, v, mu, mv, rgba[0], rgba[1], rgba[2], rgba[3], masked], offset);
      offset += FLOATS;
    }
    this.count++;
    this.quads++;
  }

  draw(quad: Quad): void {
    const texture = quad.texture as GlTexture;
    if (!texture.handle || quad.opacity <= 0) return;
    const m = quad.matrix;
    const corner = (x: number, y: number): [number, number] => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];
    const corners = [
      corner(0, 0),
      corner(quad.sw, 0),
      corner(0, quad.sh),
      corner(quad.sw, quad.sh),
    ];
    const uv = [
      quad.sx / texture.width,
      quad.sy / texture.height,
      (quad.sx + quad.sw) / texture.width,
      (quad.sy + quad.sh) / texture.height,
    ] as const;
    const [r, g, b] = quad.tint ? parseColor(quad.tint) : [1, 1, 1];
    const mask = quad.tint && quad.mask ? (quad.mask.texture as GlTexture) : undefined;
    const maskUv = mask
      ? ([
          quad.mask!.sx / mask.width,
          quad.mask!.sy / mask.height,
          (quad.mask!.sx + quad.sw) / mask.width,
          (quad.mask!.sy + quad.sh) / mask.height,
        ] as const)
      : ([0, 0, 0, 0] as const);
    this.push(texture, mask, corners, uv, maskUv, [r, g, b, quad.opacity], mask ? 1 : 0);
  }

  fill(x: number, y: number, width: number, height: number, color: string, opacity: number): void {
    if (opacity <= 0) return;
    const [r, g, b] = parseColor(color);
    this.push(
      this.white,
      undefined,
      [
        [x, y],
        [x + width, y],
        [x, y + height],
        [x + width, y + height],
      ],
      [0, 0, 1, 1],
      [0, 0, 0, 0],
      [r, g, b, opacity],
      0,
    );
  }

  end(): { drawCalls: number; quads: number } {
    this.flush();
    this.texture = undefined;
    this.maskTexture = undefined;
    return { drawCalls: this.drawCalls, quads: this.quads };
  }

  lost(): boolean {
    return this.isLost || this.gl.isContextLost();
  }

  dispose(): void {
    const gl = this.gl;
    for (const texture of this.textures)
      if (texture.generation === this.generation) gl.deleteTexture(texture.handle);
    this.textures.clear();
    gl.deleteTexture(this.white.handle);
    gl.deleteBuffer(this.buffer);
    gl.deleteBuffer(this.indices);
    gl.deleteProgram(this.program);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
  }
}

#!/usr/bin/env node
/**
 * Browser 2D puppet-stage benchmark for ANIM-01.
 *
 * Measures DOM/CSS transforms, Canvas 2D and raw WebGL against one deterministic synthetic
 * puppet-stage scene: four layered puppets, twenty-four hierarchical parts per puppet, per-frame
 * transforms, eye/mouth source swaps, a 2560x1600 background, forty alpha particles and one
 * greyscale-mask scarf accessory per puppet tinted at runtime.
 *
 * Run from the repository root:
 *
 *   node scripts/bench-stage.mjs --rounds 3 --graphics hardware --out C:\path\bench-stage-chromium.json
 *   node scripts/bench-stage.mjs --quick --tech webgl
 *   node scripts/bench-stage.mjs --serve-only
 *
 * If packages/render-three/dist/browser.js is absent, the script runs `npm run build` first so it
 * can use the repository's Chromium CDP helpers. Results are local browser measurements only, not
 * iPad hardware claims.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpus, platform, release, type } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_BROWSER = resolve(ROOT, 'packages', 'render-three', 'dist', 'browser.js');
const DEFAULT_TECHS = ['dom', 'canvas', 'webgl'];
const VIEWPORTS = [
  { id: '1280x800@1', width: 1280, height: 800, deviceScaleFactor: 1 },
  { id: '1024x768@2', width: 1024, height: 768, deviceScaleFactor: 2 },
];
const THROTTLES = [1, 4];

function parseArgs(argv) {
  const options = {
    techs: DEFAULT_TECHS,
    rounds: 1,
    quick: false,
    serveOnly: false,
    graphics: 'software',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--tech') options.techs = argv[++index].split(',').map((value) => value.trim());
    else if (arg === '--rounds') options.rounds = Number.parseInt(argv[++index], 10);
    else if (arg === '--out') options.out = resolve(argv[++index]);
    else if (arg === '--md-out') options.mdOut = resolve(argv[++index]);
    else if (arg === '--graphics') options.graphics = argv[++index];
    else if (arg === '--quick') options.quick = true;
    else if (arg === '--serve-only') options.serveOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error('--rounds must be >= 1');
  }
  for (const tech of options.techs) {
    if (!DEFAULT_TECHS.includes(tech)) throw new Error(`Unknown --tech ${tech}`);
  }
  if (!['software', 'hardware'].includes(options.graphics)) {
    throw new Error('--graphics must be "software" or "hardware"');
  }
  return options;
}

function usage() {
  return (
    'Usage: node scripts/bench-stage.mjs [--tech dom,canvas,webgl] [--rounds N] ' +
    '[--quick] [--graphics hardware|software] [--out file] [--md-out file]\n' +
    '       node scripts/bench-stage.mjs --serve-only'
  );
}

function ensureBuilt() {
  if (existsSync(DIST_BROWSER)) return;
  console.error(
    '[bench-stage] packages/render-three/dist/browser.js missing; running npm run build',
  );
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
}

function benchHtml() {
  return String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Aegis puppet stage benchmark</title>
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #05070d; }
#stage { position: fixed; inset: 0; overflow: hidden; contain: strict; background: #05070d; }
.bg, .part, .particle { position: absolute; left: 0; top: 0; will-change: transform; transform-origin: 0 0; background-repeat: no-repeat; }
canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
</style>
</head>
<body><div id="stage"></div>
<script>
(() => {
  const PARTS = 24;
  const PUPPETS = 4;
  const PARTICLES = 40;
  const SLOT = 256;
  const ATLAS_COLS = 4;
  const ATLAS_SIZE = 1024;
  const TECH = new URLSearchParams(location.search).get('tech') || 'dom';
  const stage = document.getElementById('stage');
  let renderer = null;
  let fixture = null;
  const scarfColors = ['#dc3758', '#28a5d8', '#7bc64b', '#d8a328'];

  function seeded(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function canvas2d(width, height) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  async function toUrl(canvas) {
    if ('convertToBlob' in canvas) return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
    return canvas.toDataURL('image/png');
  }

  function fillRounded(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawPart(ctx, puppet, part, variant, w, h) {
    const hue = (puppet * 75 + part * 17 + variant * 23) % 360;
    ctx.clearRect(0, 0, SLOT, SLOT);
    ctx.save();
    ctx.translate((SLOT - w) / 2, (SLOT - h) / 2);
    if (part === 4) {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(1, 'rgba(150,150,150,0.45)');
      ctx.fillStyle = grad;
      fillRounded(ctx, 0, 0, w, h, 24);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let x = 14; x < w; x += 28) ctx.fillRect(x, 0, 10, h);
      ctx.restore();
      return;
    }
    const grad = ctx.createRadialGradient(w * 0.3, h * 0.25, 8, w * 0.5, h * 0.55, Math.max(w, h));
    grad.addColorStop(0, 'hsl(' + hue + ' 88% 72%)');
    grad.addColorStop(1, 'hsl(' + hue + ' 58% 38%)');
    ctx.fillStyle = grad;
    fillRounded(ctx, 0, 0, w, h, Math.min(w, h) * 0.22);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 5;
    ctx.stroke();
    if (part === 1) {
      ctx.fillStyle = '#10131f';
      const blink = variant === 2 ? 4 : 18;
      ctx.fillRect(w * 0.24, h * 0.4, 18, blink);
      ctx.fillRect(w * 0.58, h * 0.4, 18, blink);
    } else if (part === 2) {
      ctx.strokeStyle = '#21121a';
      ctx.lineWidth = 7 + variant * 2;
      ctx.beginPath();
      ctx.arc(w * 0.5, h * 0.5, 20 + variant * 7, 0.08 * Math.PI, 0.92 * Math.PI);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(w * 0.12, h * 0.15, w * 0.18, h * 0.55);
    }
    ctx.restore();
  }

  async function createFixture() {
    const parts = [];
    const atlases = [];
    const atlasUrls = [];
    for (let puppet = 0; puppet < PUPPETS; puppet++) {
      const atlas = canvas2d(ATLAS_SIZE, ATLAS_SIZE);
      const ctx = atlas.getContext('2d');
      const rects = [];
      for (let part = 0; part < PARTS; part++) {
        const variants = part === 1 || part === 2 ? 3 : 1;
        rects[part] = [];
        for (let variant = 0; variant < variants; variant++) {
          const slotIndex = part + (part === 1 ? variant * PARTS : part === 2 ? (variant + 3) * 4 : 0);
          const col = slotIndex % ATLAS_COLS;
          const row = Math.floor(slotIndex / ATLAS_COLS) % 8;
          const x = col * SLOT;
          const y = row * SLOT;
          const w = 72 + ((part * 37 + puppet * 11) % 118);
          const h = 60 + ((part * 29 + puppet * 19) % 132);
          const tmp = canvas2d(SLOT, SLOT);
          drawPart(tmp.getContext('2d'), puppet, part, variant, w, h);
          ctx.drawImage(tmp, x, y);
          rects[part][variant] = { x: x + (SLOT - w) / 2, y: y + (SLOT - h) / 2, w, h };
        }
      }
      atlases.push({ canvas: atlas, rects });
      atlasUrls.push(await toUrl(atlas));
    }
    const bg = canvas2d(2560, 1600);
    const bctx = bg.getContext('2d');
    const grad = bctx.createLinearGradient(0, 0, 2560, 1600);
    grad.addColorStop(0, '#10264d');
    grad.addColorStop(0.45, '#46346b');
    grad.addColorStop(1, '#101722');
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, 2560, 1600);
    const rand = seeded(42);
    for (let i = 0; i < 700; i++) {
      bctx.fillStyle = 'rgba(255,255,255,' + (0.05 + rand() * 0.22).toFixed(3) + ')';
      bctx.beginPath();
      bctx.arc(rand() * 2560, rand() * 1600, 1 + rand() * 3, 0, Math.PI * 2);
      bctx.fill();
    }
    for (let i = 0; i < 18; i++) {
      bctx.fillStyle = 'rgba(30, 18, 55, 0.45)';
      bctx.fillRect(i * 150 - 80, 1080 - (i % 5) * 55, 220, 520);
    }
    const particle = canvas2d(64, 64);
    const pctx = particle.getContext('2d');
    const pgrad = pctx.createRadialGradient(32, 32, 1, 32, 32, 32);
    pgrad.addColorStop(0, 'rgba(255,235,150,0.95)');
    pgrad.addColorStop(0.5, 'rgba(255,130,70,0.45)');
    pgrad.addColorStop(1, 'rgba(255,130,70,0)');
    pctx.fillStyle = pgrad;
    pctx.fillRect(0, 0, 64, 64);
    for (let part = 0; part < PARTS; part++) {
      parts.push({ parent: part === 0 ? -1 : Math.floor((part - 1) / 2), x: (part % 6) * 21 - 48, y: Math.floor(part / 6) * 38 - 30 });
    }
    return { atlases, atlasUrls, bg, bgUrl: await toUrl(bg), particle, particleUrl: await toUrl(particle), parts };
  }

  function releaseFixture(current) {
    if (!current) return;
    for (const url of current.atlasUrls) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    if (current.bgUrl.startsWith('blob:')) URL.revokeObjectURL(current.bgUrl);
    if (current.particleUrl.startsWith('blob:')) URL.revokeObjectURL(current.particleUrl);
  }

  function mul(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }

  function localMatrix(x, y, rot, sx, sy) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return [c * sx, s * sx, -s * sy, c * sy, x, y];
  }

  function worldParts(t, width, height) {
    const out = [];
    const baseScale = Math.min(width / 1280, height / 800) * 0.95;
    for (let puppet = 0; puppet < PUPPETS; puppet++) {
      const rootX = width * (0.18 + puppet * 0.21) + Math.sin(t * 1.25 + puppet) * 24;
      const rootY = height * (0.58 + (puppet % 2) * 0.08) + Math.cos(t * 1.1 + puppet) * 18;
      const root = localMatrix(rootX, rootY, Math.sin(t * 0.85 + puppet) * 0.08, baseScale, baseScale);
      const matrices = [];
      for (let part = 0; part < PARTS; part++) {
        const meta = fixture.parts[part];
        const wave = Math.sin(t * (1.7 + (part % 5) * 0.18) + puppet * 0.7 + part * 0.33);
        const local = localMatrix(meta.x + wave * 5, meta.y + Math.cos(t * 1.4 + part) * 3, wave * 0.22, 1 + wave * 0.035, 1 - wave * 0.025);
        matrices[part] = meta.parent < 0 ? mul(root, local) : mul(matrices[meta.parent], local);
        const variant = part === 1 ? Math.floor(t * 4 + puppet) % 3 : part === 2 ? Math.floor(t * 9 + puppet) % 3 : 0;
        out.push({ puppet, part, matrix: matrices[part], variant });
      }
    }
    return out;
  }

  class DomRenderer {
    async init() {
      stage.textContent = '';
      this.bg = document.createElement('div');
      this.bg.className = 'bg';
      this.bg.style.backgroundImage = 'url(' + fixture.bgUrl + ')';
      this.bg.style.backgroundSize = '100% 100%';
      stage.appendChild(this.bg);
      this.nodes = [];
      for (let puppet = 0; puppet < PUPPETS; puppet++) {
        for (let part = 0; part < PARTS; part++) {
          const el = document.createElement('div');
          el.className = 'part';
          el.style.backgroundImage = 'url(' + fixture.atlasUrls[puppet] + ')';
          el.style.backgroundSize = ATLAS_SIZE + 'px ' + ATLAS_SIZE + 'px';
          stage.appendChild(el);
          this.nodes.push(el);
        }
      }
      this.particles = Array.from({ length: PARTICLES }, () => {
        const el = document.createElement('div');
        el.className = 'particle';
        el.style.width = '34px';
        el.style.height = '34px';
        el.style.backgroundImage = 'url(' + fixture.particleUrl + ')';
        el.style.backgroundSize = '34px 34px';
        stage.appendChild(el);
        return el;
      });
    }
    draw(now) {
      const t = now / 1000;
      const width = innerWidth;
      const height = innerHeight;
      this.bg.style.width = width + 'px';
      this.bg.style.height = height + 'px';
      let index = 0;
      for (const item of worldParts(t, width, height)) {
        const rect = fixture.atlases[item.puppet].rects[item.part][item.variant];
        const node = this.nodes[index++];
        node.style.width = rect.w + 'px';
        node.style.height = rect.h + 'px';
        node.style.backgroundPosition = '-' + rect.x + 'px -' + rect.y + 'px';
        node.style.backgroundColor = item.part === 4 ? scarfColors[item.puppet] : '';
        node.style.backgroundBlendMode = item.part === 4 ? 'multiply' : '';
        node.style.transform = 'matrix(' + item.matrix.map((value) => value.toFixed(4)).join(',') + ')';
      }
      for (let i = 0; i < PARTICLES; i++) {
        const x = (width * ((i * 37) % 100)) / 100 + Math.sin(t * 2 + i) * 42;
        const y = (height * ((i * 53) % 100)) / 100 + Math.cos(t * 1.7 + i) * 28;
        this.particles[i].style.opacity = String(0.25 + 0.5 * ((i % 7) / 6));
        this.particles[i].style.transform = 'translate(' + (x % width).toFixed(2) + 'px,' + (y % height).toFixed(2) + 'px) scale(' + (0.55 + (i % 5) * 0.12).toFixed(3) + ')';
      }
    }
    dispose() { stage.textContent = ''; }
  }

  class CanvasRenderer {
    async init() {
      stage.textContent = '';
      this.canvas = document.createElement('canvas');
      stage.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.tinted = [];
      for (let puppet = 0; puppet < PUPPETS; puppet++) {
        const rect = fixture.atlases[puppet].rects[4][0];
        const off = canvas2d(rect.w, rect.h);
        const ctx = off.getContext('2d');
        ctx.fillStyle = scarfColors[puppet];
        ctx.fillRect(0, 0, rect.w, rect.h);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(fixture.atlases[puppet].canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        this.tinted[puppet] = off;
      }
    }
    draw(now) {
      const dpr = devicePixelRatio || 1;
      const width = innerWidth;
      const height = innerHeight;
      if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(fixture.bg, 0, 0, width, height);
      const t = now / 1000;
      for (const item of worldParts(t, width, height)) {
        const rect = fixture.atlases[item.puppet].rects[item.part][item.variant];
        const m = item.matrix;
        ctx.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
        if (item.part === 4) ctx.drawImage(this.tinted[item.puppet], 0, 0);
        else ctx.drawImage(fixture.atlases[item.puppet].canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let i = 0; i < PARTICLES; i++) {
        const x = (width * ((i * 37) % 100)) / 100 + Math.sin(t * 2 + i) * 42;
        const y = (height * ((i * 53) % 100)) / 100 + Math.cos(t * 1.7 + i) * 28;
        ctx.globalAlpha = 0.25 + 0.5 * ((i % 7) / 6);
        const size = 34 * (0.55 + (i % 5) * 0.12);
        ctx.drawImage(fixture.particle, x % width, y % height, size, size);
      }
      ctx.globalAlpha = 1;
    }
    dispose() { stage.textContent = ''; }
  }

  class WebglRenderer {
    async init() {
      stage.textContent = '';
      this.canvas = document.createElement('canvas');
      stage.appendChild(this.canvas);
      const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false });
      if (!gl) throw new Error('WebGL unavailable');
      this.gl = gl;
      const vs = 'attribute vec2 a_pos;attribute vec2 a_uv;attribute vec4 a_color;uniform vec2 u_res;varying vec2 v_uv;varying vec4 v_color;void main(){vec2 z=a_pos/u_res;vec2 c=z*2.0-1.0;gl_Position=vec4(c.x,-c.y,0,1);v_uv=a_uv;v_color=a_color;}';
      const fs = 'precision mediump float;uniform sampler2D u_tex;varying vec2 v_uv;varying vec4 v_color;void main(){gl_FragColor=texture2D(u_tex,v_uv)*v_color;}';
      const program = this.program = this.createProgram(vs, fs);
      gl.useProgram(program);
      this.aPos = gl.getAttribLocation(program, 'a_pos');
      this.aUv = gl.getAttribLocation(program, 'a_uv');
      this.aColor = gl.getAttribLocation(program, 'a_color');
      this.uRes = gl.getUniformLocation(program, 'u_res');
      this.buffer = gl.createBuffer();
      this.textures = [this.texture(fixture.bg), ...fixture.atlases.map((atlas) => this.texture(atlas.canvas)), this.texture(fixture.particle)];
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    shader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    }
    createProgram(vs, fs) {
      const gl = this.gl;
      const program = gl.createProgram();
      gl.attachShader(program, this.shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(program, this.shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      return program;
    }
    texture(source) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return tex;
    }
    pushQuad(vertices, m, w, h, sx, sy, sw, sh, texW, texH, color) {
      const p = [[0, 0], [w, 0], [0, h], [0, h], [w, 0], [w, h]];
      const uv = [[sx, sy], [sx + sw, sy], [sx, sy + sh], [sx, sy + sh], [sx + sw, sy], [sx + sw, sy + sh]];
      for (let i = 0; i < 6; i++) {
        const x = m[0] * p[i][0] + m[2] * p[i][1] + m[4];
        const y = m[1] * p[i][0] + m[3] * p[i][1] + m[5];
        vertices.push(x, y, uv[i][0] / texW, uv[i][1] / texH, color[0], color[1], color[2], color[3]);
      }
    }
    drawBatch(texture, vertices) {
      if (vertices.length === 0) return;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      const stride = 8 * 4;
      gl.enableVertexAttribArray(this.aPos);
      gl.enableVertexAttribArray(this.aUv);
      gl.enableVertexAttribArray(this.aColor);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, stride, 8);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 16);
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 8);
    }
    draw(now) {
      const dpr = devicePixelRatio || 1;
      const width = innerWidth;
      const height = innerHeight;
      const gl = this.gl;
      if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
      }
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniform2f(this.uRes, width, height);
      this.drawBatch(this.textures[0], [0,0,0,0,1,1,1,1,width,0,1,0,1,1,1,1,0,height,0,1,1,1,1,1,0,height,0,1,1,1,1,1,width,0,1,0,1,1,1,1,width,height,1,1,1,1,1,1]);
      const batches = Array.from({ length: PUPPETS }, () => []);
      const t = now / 1000;
      for (const item of worldParts(t, width, height)) {
        const rect = fixture.atlases[item.puppet].rects[item.part][item.variant];
        let color = [1, 1, 1, 1];
        if (item.part === 4) {
          const hex = scarfColors[item.puppet];
          color = [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, 1];
        }
        this.pushQuad(batches[item.puppet], item.matrix, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h, ATLAS_SIZE, ATLAS_SIZE, color);
      }
      for (let i = 0; i < PUPPETS; i++) this.drawBatch(this.textures[i + 1], batches[i]);
      const particles = [];
      for (let i = 0; i < PARTICLES; i++) {
        const x = (width * ((i * 37) % 100)) / 100 + Math.sin(t * 2 + i) * 42;
        const y = (height * ((i * 53) % 100)) / 100 + Math.cos(t * 1.7 + i) * 28;
        const size = 34 * (0.55 + (i % 5) * 0.12);
        this.pushQuad(particles, [1,0,0,1,x % width,y % height], size, size, 0, 0, 64, 64, 64, 64, [1, 1, 1, 0.25 + 0.5 * ((i % 7) / 6)]);
      }
      this.drawBatch(this.textures[this.textures.length - 1], particles);
    }
    dispose() { stage.textContent = ''; }
  }

  async function createRenderer() {
    fixture = await createFixture();
    renderer = TECH === 'dom' ? new DomRenderer() : TECH === 'canvas' ? new CanvasRenderer() : new WebglRenderer();
    await renderer.init();
  }

  function disposeRenderer() {
    if (renderer) renderer.dispose();
    renderer = null;
    releaseFixture(fixture);
    fixture = null;
  }

  function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  }

  async function frameLoop(durationMs, collect) {
    const start = performance.now();
    return new Promise((resolve) => {
      function tick(ts) {
        if (renderer) {
          const before = performance.now();
          renderer.draw(ts);
          const after = performance.now();
          if (collect) collect(ts, after - before);
        }
        if (performance.now() - start >= durationMs) resolve();
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  const benchRuns = new Map();
  let nextBenchRunId = 1;

  window.__stageBench = {
    ready: true,
    async prepare(sceneChanges) {
      disposeRenderer();
      for (let i = 0; i < sceneChanges; i++) {
        await createRenderer();
        disposeRenderer();
      }
      await createRenderer();
      return {
        heapAfterSceneChanges: performance.memory ? performance.memory.usedJSHeapSize : null,
        domNodesAfterSceneChanges: document.getElementsByTagName('*').length,
      };
    },
    async run(config) {
      let prepared = config.preparedMetrics;
      if (!config.reusePrepared) prepared = await this.prepare(config.sceneChanges ?? 50);
      await frameLoop(config.warmupMs ?? 2000, null);
      const times = [];
      const drawTimes = [];
      await frameLoop(config.measureMs ?? 5000, (ts, drawMs) => { times.push(ts); drawTimes.push(drawMs); });
      const intervals = [];
      for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
      const elapsed = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
      const over334 = intervals.filter((value) => value > 33.4).length;
      return {
        tech: TECH,
        frames: times.length,
        elapsedSeconds: elapsed,
        fps: elapsed > 0 ? (times.length - 1) / elapsed : 0,
        medianIntervalMs: percentile(intervals, 0.5),
        p95IntervalMs: percentile(intervals, 0.95),
        percentIntervalsOver33_4: intervals.length > 0 ? (over334 / intervals.length) * 100 : 0,
        medianDrawMs: percentile(drawTimes, 0.5),
        p95DrawMs: percentile(drawTimes, 0.95),
        heapAfterSceneChanges: prepared.heapAfterSceneChanges,
        domNodesAfterSceneChanges: prepared.domNodesAfterSceneChanges,
        devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
    start(config) {
      const id = nextBenchRunId++;
      benchRuns.set(id, { done: false, value: null, error: null });
      this.run(config).then(
        (value) => benchRuns.set(id, { done: true, value, error: null }),
        (error) =>
          benchRuns.set(id, {
            done: true,
            value: null,
            error: error && error.stack ? error.stack : String(error),
          }),
      );
      return id;
    },
    startPrepare(sceneChanges) {
      const id = nextBenchRunId++;
      benchRuns.set(id, { done: false, value: null, error: null });
      this.prepare(sceneChanges).then(
        (value) => benchRuns.set(id, { done: true, value, error: null }),
        (error) =>
          benchRuns.set(id, {
            done: true,
            value: null,
            error: error && error.stack ? error.stack : String(error),
          }),
      );
      return id;
    },
    result(id) {
      return benchRuns.get(id) ?? { done: true, value: null, error: 'unknown bench run id' };
    },
    gpuInfo() {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      let webglVendor = null;
      let webglRenderer = null;
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
          webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        } else {
          webglVendor = gl.getParameter(gl.VENDOR);
          webglRenderer = gl.getParameter(gl.RENDERER);
        }
      }
      return {
        navigatorGpu: Boolean(navigator.gpu),
        webglAvailable: Boolean(gl),
        webglVendor,
        webglRenderer,
      };
    },
    dispose: disposeRenderer,
  };
})();
</script></body></html>`;
}

async function startServer() {
  const html = benchHtml();
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/bench')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }
    res.writeHead(302, { location: '/bench?tech=dom' });
    res.end();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server did not bind TCP');
  return { server, port: address.port, url: `http://127.0.0.1:${address.port}/bench` };
}

async function closeBrowser(browser, CdpSession) {
  let control;
  try {
    const version = await (
      await globalThis.fetch(`http://127.0.0.1:${browser.port}/json/version`)
    ).json();
    control = await CdpSession.connect(version.webSocketDebuggerUrl);
    await control.send('Browser.close').catch(() => undefined);
  } finally {
    control?.close();
  }
  const deadline = Date.now() + 10_000;
  while (
    browser.process.exitCode === null &&
    browser.process.signalCode === null &&
    Date.now() < deadline
  ) {
    await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 100));
  }
  if (browser.process.exitCode === null && browser.process.signalCode === null)
    browser.process.kill();
}

async function pollPageRun(cdp, evaluate, runId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const polled = await evaluate(cdp, `window.__stageBench.result(${JSON.stringify(runId)})`);
    if (polled.done === true) {
      if (polled.error !== null) throw new Error(polled.error);
      return polled.value;
    }
    if (Date.now() > deadline) throw new Error(`Benchmark case timed out: ${label}`);
    await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 1000));
  }
}

async function runCase({ browserApi, baseUrl, tech, viewport, throttle, quick, graphics }) {
  const { launchBrowser, openPage, evaluate, until, CdpSession } = browserApi;
  const browser = await launchBrowser({
    viewport: { width: viewport.width, height: viewport.height },
    graphics,
  });
  let cdp;
  try {
    const version = await (
      await globalThis.fetch(`http://127.0.0.1:${browser.port}/json/version`)
    ).json();
    cdp = await openPage(browser.port, `${baseUrl}?tech=${tech}`, {
      width: viewport.width,
      height: viewport.height,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.deviceScaleFactor > 1,
    });
    await until(
      cdp,
      'Boolean(window.__stageBench && window.__stageBench.ready)',
      (value) => value === true,
    );
    const gpuInfo = await evaluate(cdp, 'window.__stageBench.gpuInfo()');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const prepareId = await evaluate(
      cdp,
      `window.__stageBench.startPrepare(${JSON.stringify(quick ? 5 : 50)})`,
    );
    const preparedMetrics = await pollPageRun(
      cdp,
      evaluate,
      prepareId,
      quick ? 120_000 : 900_000,
      `${tech} ${viewport.id} prepare`,
    );
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const runId = await evaluate(
      cdp,
      `window.__stageBench.start(${JSON.stringify({
        warmupMs: quick ? 500 : 2000,
        measureMs: quick ? 1500 : 5000,
        preparedMetrics,
        reusePrepared: true,
      })})`,
    );
    const result = await pollPageRun(
      cdp,
      evaluate,
      runId,
      quick ? 120_000 : 900_000,
      `${tech} ${viewport.id} ${throttle}x`,
    );
    await evaluate(cdp, 'window.__stageBench.dispose()').catch(() => undefined);
    return {
      ...result,
      browserProduct: version.Browser,
      viewportId: viewport.id,
      throttle,
      quick,
      graphics,
      gpuInfo,
    };
  } finally {
    cdp?.close();
    await closeBrowser(browser, CdpSession);
  }
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function summarize(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.tech}|${result.viewportId}|${result.throttle}`;
    const current = groups.get(key) ?? [];
    current.push(result);
    groups.set(key, current);
  }
  return Array.from(groups.entries())
    .map(([key, rows]) => {
      const [tech, viewportId, throttleText] = key.split('|');
      return {
        tech,
        viewportId,
        throttle: Number(throttleText),
        rounds: rows.length,
        fps: median(rows.map((row) => row.fps)),
        medianIntervalMs: median(rows.map((row) => row.medianIntervalMs)),
        p95IntervalMs: median(rows.map((row) => row.p95IntervalMs)),
        percentIntervalsOver33_4: median(rows.map((row) => row.percentIntervalsOver33_4)),
        medianDrawMs: median(rows.map((row) => row.medianDrawMs)),
        p95DrawMs: median(rows.map((row) => row.p95DrawMs)),
        heapAfterSceneChanges: median(
          rows.map((row) => row.heapAfterSceneChanges).filter((value) => value !== null),
        ),
        domNodesAfterSceneChanges: median(rows.map((row) => row.domNodesAfterSceneChanges)),
      };
    })
    .sort(
      (a, b) =>
        a.viewportId.localeCompare(b.viewportId) ||
        a.throttle - b.throttle ||
        a.tech.localeCompare(b.tech),
    );
}

function fmt(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return Number(value).toFixed(digits);
}

function markdownTable(summary, metadata) {
  const lines = [];
  lines.push(`# Puppet stage benchmark (${new Date(metadata.createdAt).toISOString()})`);
  lines.push('');
  lines.push(`Chrome: ${metadata.chromeVersion ?? 'unknown'}`);
  lines.push(`Graphics mode: ${metadata.graphics}`);
  lines.push(
    `GPU: navigator.gpu=${metadata.gpuInfo?.navigatorGpu ?? 'unknown'}; WebGL renderer=${metadata.gpuInfo?.webglRenderer ?? 'unknown'}`,
  );
  lines.push(
    `Machine: ${metadata.machine.cpuCount} logical CPUs; ${metadata.machine.cpuModel}; ${metadata.machine.os}`,
  );
  lines.push('');
  lines.push(
    '| viewport | throttle | tech | rounds | fps | median interval ms | p95 interval ms | >33.4ms intervals | median draw JS ms | p95 draw JS ms | heap after recreate | DOM nodes |',
  );
  lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summary) {
    lines.push(
      `| ${row.viewportId} | ${row.throttle}x | ${row.tech} | ${row.rounds} | ${fmt(row.fps)} | ${fmt(row.medianIntervalMs, 2)} | ${fmt(row.p95IntervalMs, 2)} | ${fmt(row.percentIntervalsOver33_4, 1)}% | ${fmt(row.medianDrawMs, 3)} | ${fmt(row.p95DrawMs, 3)} | ${row.heapAfterSceneChanges === null ? 'n/a' : Math.round(row.heapAfterSceneChanges).toString()} | ${fmt(row.domNodesAfterSceneChanges, 0)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  ensureBuilt();
  const serverInfo = await startServer();
  if (options.serveOnly) {
    console.log(`${serverInfo.url}?tech=dom`);
    console.log(`${serverInfo.url}?tech=canvas`);
    console.log(`${serverInfo.url}?tech=webgl`);
    return;
  }

  const browserApi = await import(pathToFileURL(DIST_BROWSER).href);
  const allResults = [];
  let chromeVersion = null;
  try {
    for (let round = 1; round <= options.rounds; round++) {
      for (const viewport of VIEWPORTS) {
        for (const throttle of THROTTLES) {
          for (const tech of options.techs) {
            console.error(
              `[bench-stage] round ${round}/${options.rounds} ${viewport.id} ${throttle}x ${tech}`,
            );
            const result = await runCase({
              browserApi,
              baseUrl: serverInfo.url,
              tech,
              viewport,
              throttle,
              quick: options.quick,
              graphics: options.graphics,
            });
            chromeVersion ??= result.browserProduct;
            allResults.push({ ...result, round });
          }
        }
      }
    }
  } finally {
    await new Promise((resolvePromise) => serverInfo.server.close(resolvePromise));
  }

  const metadata = {
    createdAt: new Date().toISOString(),
    chromeVersion,
    graphics: options.graphics,
    gpuInfo: allResults[0]?.gpuInfo ?? null,
    options,
    machine: {
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      os: `${type()} ${release()} (${platform()})`,
      node: process.version,
    },
  };
  const summary = summarize(allResults);
  const output = { metadata, summary, results: allResults };
  const markdown = markdownTable(summary, metadata);
  if (options.out !== undefined) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`);
  }
  if (options.mdOut !== undefined) {
    mkdirSync(dirname(options.mdOut), { recursive: true });
    writeFileSync(options.mdOut, markdown);
  }
  console.log(markdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

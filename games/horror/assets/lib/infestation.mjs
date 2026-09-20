import { BufferGeometry, Float32BufferAttribute } from 'three';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Raster, noise, normalMap, png } from './raster.mjs';

export const INFESTATION_MATERIALS = {
  'colony-shell': {
    map: 'colony-shell-basecolor.png',
    normal: 'colony-shell-normal.png',
    orm: 'colony-shell-orm.png',
    metal: 1,
    rough: 1,
    normalScale: 0.38,
  },
  'colony-root': {
    color: [0.033, 0.041, 0.03, 1],
    normal: 'colony-shell-normal.png',
    normalScale: 0.24,
    rough: 0.58,
    metal: 0,
  },
  'colony-core': {
    color: [0.024, 0.015, 0.013, 1],
    normal: 'colony-shell-normal.png',
    normalScale: 0.2,
    rough: 0.64,
    metal: 0,
  },
  'colony-membrane': {
    color: [0.104, 0.077, 0.042, 1],
    normal: 'colony-shell-normal.png',
    normalScale: 0.3,
    rough: 0.65,
    metal: 0,
  },
  'wound-tissue': {
    color: [0.19, 0.036, 0.028, 1],
    normal: 'colony-shell-normal.png',
    normalScale: 0.18,
    rough: 0.69,
    metal: 0,
  },
  'dried-blood': {
    color: [0.086, 0.021, 0.013, 1],
    normal: 'colony-shell-normal.png',
    normalScale: 0.12,
    rough: 0.9,
    metal: 0,
  },
  'torn-liner': {
    color: [0.068, 0.052, 0.033, 1],
    normal: 'suit-textile-normal.png',
    normalScale: 0.42,
    rough: 0.98,
    metal: 0,
    double: true,
  },
  'ceramic-fracture': {
    color: [0.19, 0.18, 0.13, 1],
    normal: 'colony-shell-normal.png',
    normalScale: 0.16,
    rough: 0.91,
    metal: 0,
  },
};

export async function cookInfestationTextures(output) {
  const size = 1024,
    base = new Raster(size, size),
    orm = new Raster(size, size);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size,
        grain = noise(x, y, 936) - 0.5;
      const rind =
        Math.sin(v * 61 + Math.sin(u * 11) * 2.2) * 0.45 + Math.sin(u * 29 - v * 23) * 0.3;
      const fissure = Math.max(0, Math.sin(u * 37 + Math.sin(v * 17) * 2)) ** 18;
      const pit = noise(Math.floor(x / 7), Math.floor(y / 9), 719) > 0.91 ? 1 : 0;
      const tint = 113 + rind * 21 - fissure * 24 - pit * 13 + grain * 10;
      base.pixel(x, y, [tint * 0.99, tint, tint * 0.83]);
      orm.pixel(x, y, [255 - pit * 29 - fissure * 19, 203 + rind * 11 + grain * 8, 0]);
      heights[y * size + x] = rind * 0.038 - fissure * 0.06 - pit * 0.045 + grain * 0.01;
    }
  const outputMaps = [
    [
      'colony-shell-basecolor.png',
      base,
      'Original dark mineral rind with irregular compact weathering and fissures; no pale lamella/leaf stripes, no new image generation.',
    ],
    [
      'colony-shell-normal.png',
      normalMap(heights, size, size, 1.55),
      'OpenGL normal from authored relative pit/rind height; artistic approximation, not a scan.',
    ],
    [
      'colony-shell-orm.png',
      orm,
      'Authored linear AO/roughness/nonmetallic mineral rind. No emission.',
    ],
  ];
  const inventory = [];
  for (const [file, image, recipe] of outputMaps) {
    const bytes = png(image);
    await writeFile(join(output, file), bytes);
    inventory.push({ file, width: size, height: size, bytes: bytes.length, recipe });
  }
  return inventory;
}

function geometry(model, node, material, positions, uv, indices) {
  const mesh = new BufferGeometry();
  mesh.setAttribute('position', new Float32BufferAttribute(positions, 3));
  mesh.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  mesh.setIndex(indices);
  mesh.computeVertexNormals();
  model.add(node, material, mesh);
}

function mass(model, node, material, center, size, seed) {
  const around = 36,
    rows = 20,
    positions = [],
    uv = [],
    indices = [];
  for (let row = 0; row <= rows; row++)
    for (let col = 0; col <= around; col++) {
      const v = row / rows,
        phi = 0.004 + v * (Math.PI - 0.008),
        u = col / around,
        theta = u * Math.PI * 2;
      const ridge =
        1 + 0.12 * Math.sin(theta * 3 + v * 11 + seed) + 0.05 * Math.sin(theta * 7 - v * 17 + seed);
      positions.push(
        center[0] + size[0] * Math.cos(theta) * Math.sin(phi) * ridge,
        center[1] + size[1] * Math.cos(phi),
        center[2] + size[2] * Math.sin(theta) * Math.sin(phi) * ridge,
      );
      uv.push(u, v);
      if (row < rows && col < around) {
        const a = row * (around + 1) + col,
          b = a + around + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  geometry(model, node, material, positions, uv, indices);
}

function woundRing(model, node, material, center, radii, inner, outer, depth, seed) {
  const segments = 72,
    layers = 5,
    positions = [],
    uv = [],
    indices = [];
  for (let row = 0; row <= layers; row++) {
    const t = row / layers,
      radius = inner + (outer - inner) * t;
    for (let col = 0; col <= segments; col++) {
      const angle = (col / segments) * Math.PI * 2;
      const torn = 1 + 0.07 * Math.sin(angle * 5 + seed) + 0.042 * Math.cos(angle * 11 - seed);
      positions.push(
        center[0] + Math.cos(angle) * radii[0] * radius * torn,
        center[1] + Math.sin(angle) * radii[1] * radius * torn,
        center[2] + depth * (0.65 * Math.sin(t * Math.PI) + 0.35 * t),
      );
      uv.push(col / segments, t);
      if (row < layers && col < segments) {
        const a = row * (segments + 1) + col,
          b = a + segments + 1;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
  }
  geometry(model, node, material, positions, uv, indices);
}

function tissueOpening(model, node, center, size, seed) {
  mass(
    model,
    node,
    'colony-core',
    [center[0], center[1], center[2] - 0.006],
    [size[0] * 0.97, size[1] * 0.99, 0.009],
    seed,
  );
  woundRing(model, node, 'torn-liner', center, size, 0.93, 1.17, 0.006, seed);
  woundRing(
    model,
    node,
    'dried-blood',
    [center[0], center[1], center[2] + 0.002],
    size,
    0.82,
    1.02,
    0.008,
    seed,
  );
  woundRing(
    model,
    node,
    'wound-tissue',
    [center[0], center[1], center[2] + 0.004],
    size,
    0.63,
    0.86,
    0.016,
    seed,
  );
}

function brokenRind(model, node, center, scale, seed) {
  mass(model, node, 'colony-membrane', center, scale, seed);
  for (const [dx, dy, dz, width, height, depth, offset] of [
    [-0.016, -0.03, 0.023, 0.026, 0.051, 0.02, 1],
    [0.023, 0.029, 0.012, 0.033, 0.048, 0.024, 5],
    [-0.018, 0.063, -0.013, 0.027, 0.042, 0.023, 8],
  ]) {
    mass(
      model,
      node,
      'colony-shell',
      [center[0] + dx, center[1] + dy, center[2] + dz],
      [width, height, depth],
      seed + offset,
    );
  }
}

export function chestInfestation(model, node) {
  tissueOpening(model, node, [0.105, 0.047, 0.217], [0.097, 0.162], 3);
  // Root starts end below the surviving shell face, so the organism reads as emerging from the rupture.
  for (const points of [
    [
      [0.002, -0.083, 0.174],
      [0.04, -0.03, 0.227],
      [0.104, 0.032, 0.233],
      [0.18, 0.13, 0.168],
      [0.215, 0.26, 0.097],
    ],
    [
      [0.037, 0.194, 0.176],
      [0.07, 0.152, 0.229],
      [0.137, 0.098, 0.233],
      [0.21, 0.23, 0.109],
      [0.237, 0.338, 0.042],
    ],
    [
      [0.196, -0.135, 0.153],
      [0.179, -0.07, 0.214],
      [0.158, 0.002, 0.244],
      [0.201, 0.197, 0.147],
      [0.248, 0.301, 0.021],
    ],
    [
      [0.18, -0.192, 0.16],
      [0.112, -0.109, 0.231],
      [0.139, 0.026, 0.229],
      [0.193, 0.111, 0.177],
    ],
  ])
    model.cable(node, 'colony-root', points, 0.009, 28);
  mass(model, node, 'colony-root', [0.149, 0.065, 0.221], [0.031, 0.086, 0.023], 3);
  brokenRind(model, node, [0.22, 0.244, 0.087], [0.05, 0.116, 0.057], 12);
  brokenRind(model, node, [0.278, 0.329, -0.019], [0.054, 0.082, 0.057], 18);
  model.cable(
    node,
    'colony-root',
    [
      [0.22, 0.225, 0.078],
      [0.26, 0.278, 0.052],
      [0.303, 0.351, -0.002],
      [0.284, 0.391, -0.044],
    ],
    0.017,
    22,
  );
  for (const points of [
    [
      [-0.013, 0.146, 0.224],
      [-0.034, 0.106, 0.224],
      [-0.02, 0.072, 0.224],
    ],
    [
      [0.041, -0.177, 0.219],
      [0.015, -0.197, 0.221],
      [-0.018, -0.222, 0.22],
    ],
  ])
    model.cable(node, 'dried-blood', points, 0.006, 9);
  for (let thread = 0; thread < 6; thread++) {
    const x = 0.015 + thread * 0.016;
    model.cable(
      node,
      'torn-liner',
      [
        [x, -0.15, 0.223],
        [x - 0.004, -0.181, 0.219],
        [x + 0.018, -0.212, 0.192],
      ],
      0.0024,
      8,
    );
  }
  model.features.push({
    type: 'first-gate-2-rupture',
    node: 'thorax',
    design:
      'One readable torn pressure opening with dark layered core, localized injury/contact rim and thick roots buried under broken shell; closed irregular mineral rind, no ribbon/leaf growth.',
  });
}

export function shoulderInfestation(model, node) {
  tissueOpening(model, node, [0.026, -0.045, 0.103], [0.053, 0.106], 9);
  mass(model, node, 'colony-root', [0.04, -0.04, 0.112], [0.025, 0.08, 0.02], 7);
  mass(model, node, 'colony-shell', [0.053, 0.02, 0.075], [0.029, 0.066, 0.026], 11);
  for (let root = 0; root < 4; root++) {
    const x = -0.005 + root * 0.017;
    model.cable(
      node,
      'colony-root',
      [
        [x, -0.208, 0.083],
        [x + 0.016, -0.091, 0.13],
        [x + 0.012, -0.014, 0.132],
        [x + 0.033, 0.054, 0.057],
      ],
      0.0058,
      19,
    );
  }
}

export function helmetInfestation(model, node) {
  // The approved visor is untouched. A narrow injured seal and roots show the same organism entering it.
  tissueOpening(model, node, [0.157, -0.112, 0.158], [0.024, 0.046], 5);
  mass(model, node, 'colony-root', [0.157, -0.129, 0.164], [0.019, 0.041, 0.014], 4);
  for (let i = 0; i < 4; i++)
    model.cable(
      node,
      'colony-root',
      [
        [0.09 + i * 0.018, -0.194, 0.078],
        [0.126 + i * 0.011, -0.149, 0.175],
        [0.151 + i * 0.008, -0.096, 0.182],
        [0.179 + i * 0.005, -0.029, 0.092],
      ],
      0.0034,
      20,
    );
  mass(model, node, 'colony-shell', [0.174, -0.095, 0.12], [0.016, 0.037, 0.026], 2);
  model.cable(
    node,
    'ceramic-fracture',
    [
      [-0.122, 0.106, 0.096],
      [-0.09, 0.135, 0.09],
      [-0.074, 0.15, 0.056],
    ],
    0.003,
    12,
  );
}

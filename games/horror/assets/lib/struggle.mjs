import { BufferGeometry, Float32BufferAttribute } from 'three';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Model } from './model.mjs';
import { MATERIALS } from './textures.mjs';
import { INFESTATION_MATERIALS } from './infestation.mjs';
import { Raster, noise, png } from './raster.mjs';

export const FIRST_STRUGGLE = {
  id: 'maintenance-drag-aftermath',
  model: 'struggle.glb',
  anchor: 'world',
  position: [0, 0, 0],
  wallFace: { x: 4.5, solidCell: [5, 16], openCell: [4, 16], outward: [-1, 0, 0] },
  bounds: { min: [2.7, 0, 15.1], max: [4.72, 1.55, 17.1] },
  visualIntent:
    'One oblique impact tore the upper-right attachment and broke three unequal rods. A snagged frayed strap and one interrupted heel/tool drag lead into the same contact zone, with one restrained dried hand wipe. No floating scraps, repeated footprints, body or extra clutter.',
  collision:
    'No new collision. Floor marks at y.003; no freestanding debris. Raised vent detail lies in original solid volume except <=.015m frame lip.',
  protectedControl: {
    entity: 'maintenance-note',
    position: [7.55, 0, 17],
    minimumHorizontalDistance: 2.8,
  },
};

function capsuleDistance(x, y, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

export async function cookAftermathDecals(output) {
  const image = new Raster(1024, 1024, [0, 0, 0, 0]);
  const fingers = [
    [[225, 251], [147, 55], 18],
    [[250, 249], [239, 31], 21],
    [[274, 252], [317, 54], 20],
    [[295, 281], [378, 134], 17],
    [[203, 305], [96, 215], 21],
  ];
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const u = x % 512,
        v = y % 512,
        quadrant = Math.floor(x / 512) + Math.floor(y / 512) * 2;
      const grain = noise(u, v, 833);
      let color,
        alpha = 0;
      if (quadrant === 0) {
        const curve = 229 + 34 * Math.sin(v / 180) - 0.1 * (v - 256);
        const trail = Math.max(0, 1 - Math.abs(u - curve) / (13 + 18 * Math.sin(v / 155) ** 2));
        const broken = (v > 91 && v < 132) || (v > 287 && v < 335) ? 0.07 : 1;
        const heel = Math.hypot((u - 235) / 50, (v - 398) / 33);
        const heelRim = Math.max(0, 1 - Math.abs(heel - 0.88) * 7);
        const tread = v > 377 && v < 421 && u > 206 && u < 262 && (u + v * 0.4) % 19 < 5;
        const scuff =
          trail *
          broken *
          Math.max(0, Math.min(1, (v - 34) / 51)) *
          Math.max(0, Math.min(1, (472 - v) / 58));
        alpha = (scuff * 0.54 + heelRim * 0.83 + (tread ? 0.28 : 0)) * (100 + grain * 86);
        color = [31, 28, 22];
      } else if (quadrant === 1) {
        const palm = Math.hypot((u - 252) / 68, (v - 299) / 72);
        const finger = fingers.some(([a, b, width]) => capsuleDistance(u, v, a, b) < width);
        const dragged =
          v > 298 && v < 446 && Math.abs(u - (237 + (v - 300) * 0.36)) < 41 * (1 - (v - 298) / 160);
        alpha = palm < 1 || finger || dragged ? 106 + grain * 74 : 0;
        if (noise(Math.floor(u / 13), Math.floor(v / 9), 137) < 0.21 || grain < 0.09) alpha *= 0.17;
        color = [75, 26, 17];
      } else if (quadrant === 2) {
        const distance = Math.min(
          capsuleDistance(u, v, [91, 408], [196, 255]),
          capsuleDistance(u, v, [204, 242], [316, 131]),
          capsuleDistance(u, v, [333, 114], [398, 98]),
        );
        const core = Math.max(0, 1 - distance / 5),
          rub = Math.max(0, 1 - distance / 19) * 0.48;
        alpha = (core + rub) * (40 + grain * 118);
        color = distance < 1.3 ? [92, 87, 72] : [26, 24, 19];
      } else {
        const d = Math.hypot((u - 261) / 1.1, v - 239);
        const abrasion = Math.max(0, 1 - d / 110);
        const crack =
          Math.min(
            capsuleDistance(u, v, [261, 239], [96, 342]),
            capsuleDistance(u, v, [249, 251], [401, 106]),
          ) < 2.5;
        alpha = (abrasion * abrasion + (crack ? 0.5 : 0)) * (45 + grain * 110);
        color = [42, 35, 23];
      }
      image.pixel(x, y, [...color, Math.min(180, alpha)]);
    }
  const bytes = png(image);
  await writeFile(join(output, 'aftermath-decals.png'), bytes);
  return {
    file: 'aftermath-decals.png',
    bytes: bytes.length,
    width: 1024,
    height: 1024,
    recipe:
      'Original one interrupted dragged heel trace, one dried handwipe and broken tool scoring. No repeatedfootstep stamping, continuousbrightwire, sourcephoto or emission.',
  };
}

export function struggleModel(scene) {
  const plan = scene.resources['fps.floorplan'];
  const at = (x, z) => plan.legend[plan.rows[plan.height - 1 - z][x]];
  if (!at(5, 16).solid || at(4, 16).solid)
    throw new Error('First aftermath canonical wall face changed');
  const model = new Model('meridian-maintenance-struggle', {
    ...MATERIALS,
    ...INFESTATION_MATERIALS,
    aftermath: { map: 'aftermath-decals.png', alpha: 'BLEND', rough: 0.93, metal: 0 },
    'snagged-textile': {
      color: [0.22, 0.19, 0.12, 1],
      normal: 'suit-textile-normal.png',
      normalScale: 0.4,
      rough: 0.97,
      metal: 0,
      double: true,
    },
  });
  const vent = model.node('inward-buckled-maintenance-cover');
  model.withTransform([4.5, 0, 16], -Math.PI / 2, () => {
    model.box(vent, 'rubber', [-0.02, 0.87, -0.035], [1.24, 1.05, 0.01]);
    model.box(vent, 'steel', [-0.675, 0.92, -0.01], [0.042, 1.22, 0.042], 0.006);
    model.box(vent, 'steel', [0.675, 0.69, -0.01], [0.042, 0.76, 0.042], 0.006);
    model.box(vent, 'steel', [0, 0.305, -0.01], [1.39, 0.03, 0.042], 0.005);
    model.box(vent, 'steel', [-0.28, 1.535, -0.01], [0.83, 0.03, 0.042], 0.005);
    model.cable(
      vent,
      'steel',
      [
        [0.65, 1.055, 0.003],
        [0.589, 1.158, -0.012],
        [0.505, 1.233, -0.017],
      ],
      0.009,
      6,
    );
    model.cable(
      vent,
      'steel',
      [
        [0.13, 1.527, 0.003],
        [0.246, 1.457, -0.012],
        [0.323, 1.364, -0.016],
      ],
      0.009,
      6,
    );
    for (const x of [-0.57, -0.38, 0.38, 0.57])
      model.cable(
        vent,
        'satin',
        [
          [x, 0.34, 0.003],
          [x, x > 0 ? 1.22 : 1.5, 0.003],
        ],
        0.007,
        2,
      );
    for (const points of [
      [
        [-0.19, 0.34, 0.003],
        [-0.195, 0.7, 0.003],
        [-0.128, 0.91, -0.01],
        [0.023, 1.029, -0.004],
      ],
      [
        [-0.19, 1.5, 0.003],
        [-0.17, 1.295, -0.013],
        [-0.103, 1.245, -0.01],
      ],
      [
        [0, 0.34, 0.003],
        [0.007, 0.687, 0.003],
        [0.113, 0.951, -0.012],
        [0.271, 1.085, -0.007],
      ],
      [
        [0, 1.5, 0.003],
        [0.065, 1.393, -0.012],
      ],
      [
        [0.19, 0.34, 0.003],
        [0.192, 0.617, 0.003],
        [0.31, 0.845, -0.013],
      ],
      [
        [0.19, 1.49, -0.01],
        [0.317, 1.328, -0.012],
      ],
    ])
      model.cable(vent, 'satin', points, 0.007, Math.max(2, points.length - 1));
    model.cable(
      vent,
      'steel',
      [
        [-0.64, 0.59, 0.003],
        [-0.23, 0.59, 0.003],
        [0.028, 0.607, -0.001],
        [0.55, 0.713, -0.013],
      ],
      0.005,
      6,
    );
    for (const [x, y] of [
      [-0.675, 0.35],
      [-0.675, 1.48],
      [0.675, 0.35],
    ])
      model.cylinder(vent, 'graphite', [x, y, 0.011], 0.015, 0.006, 'z', 0.015, 8);
    model.cylinder(vent, 'rubber', [0.615, 1.425, 0.003], 0.024, 0.005, 'z', 0.024, 16);
    model.torus(vent, 'steel', [0.613, 1.429, 0.006], 0.025, 0.004, [0, 0, 0], 16);
    model.cable(
      vent,
      'ceramic-fracture',
      [
        [0.591, 1.435, 0.008],
        [0.535, 1.41, 0.007],
        [0.48, 1.355, 0.008],
      ],
      0.003,
      4,
    );
    const positions = [],
      uv = [],
      indices = [];
    for (let row = 0; row <= 10; row++)
      for (let side = 0; side < 2; side++) {
        const t = row / 10,
          width = 0.07 * (1 - 0.32 * t) * (1 + 0.13 * Math.sin(t * 23));
        positions.push(
          0.5 - t * 0.1 + ((side ? 1 : -1) * width) / 2,
          1.36 - t * 0.4,
          0.008 - 0.022 * Math.sin(t * Math.PI),
        );
        uv.push(side, t);
        if (row < 10 && side === 0) {
          const a = row * 2;
          indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
      }
    const cloth = new BufferGeometry();
    cloth.setAttribute('position', new Float32BufferAttribute(positions, 3));
    cloth.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    cloth.setIndex(indices);
    cloth.computeVertexNormals();
    model.add(vent, 'snagged-textile', cloth);
    for (let strand = 0; strand < 5; strand++) {
      const x = 0.383 + strand * 0.009;
      model.cable(
        vent,
        'snagged-textile',
        [
          [x, 0.965, 0.006],
          [x + 0.009, 0.918 - strand * 0.008, 0.004],
          [x + 0.016, 0.891 - strand * 0.007, 0.002],
        ],
        0.0013,
        4,
      );
    }
    model.decal(vent, [0.47, 0.86, 0.012], 0.29, 0.4, [0.5, 0, 0.5, 0.5], 0, 'aftermath');
    model.decal(vent, [0.42, 1.29, 0.011], 0.44, 0.46, [0.5, 0.5, 0.5, 0.5], 0, 'aftermath');
  });
  const marks = model.node('flush-directional-drag-evidence');
  function floorDecal(center, size, tile, yaw) {
    const [x, z] = center,
      [w, d] = size;
    model.withTransform([x, 0.003, z], yaw, () => {
      const u = (tile % 2) * 0.5,
        v = Math.floor(tile / 2) * 0.5;
      model.quad(
        marks,
        'aftermath',
        [
          [-w / 2, 0, d / 2],
          [w / 2, 0, d / 2],
          [w / 2, 0, -d / 2],
          [-w / 2, 0, -d / 2],
        ],
        [
          [u, v + 0.5],
          [u + 0.5, v + 0.5],
          [u + 0.5, v],
          [u, v],
        ],
      );
    });
  }
  floorDecal([3.59, 16.02], [0.52, 1.72], 0, 1.08);
  floorDecal([4.02, 16.15], [0.34, 0.82], 2, 0.69);
  model.features.push(FIRST_STRUGGLE);
  return model;
}

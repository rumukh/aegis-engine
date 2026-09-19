import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Shape } from 'three';
import { Model } from './model.mjs';
import { MATERIALS } from './textures.mjs';

export const AFTERMATH_SITES = [
  {
    id: 'arrival-aftermath',
    role: 'arrival interrupted retreat',
    anchor: [19.5, 0, 7.02],
    yaw: -90,
    raised: { min: [19.486, 0.35, 6.7], max: [19.7, 1.85, 7.35] },
    floor: { min: [18.9, 0.003, 6.7], max: [19.48, 0.005, 7.3] },
    solid: [20, 7],
    open: [19, 7],
    normal: [-1, 0, 0],
    wallAxis: 0,
    wallPlane: 19.5,
    protected: { min: [17.8, 0, 5.4], max: [19.5, 3, 6.6], control: 'arrival-terminal' },
    story:
      'A scored removable service cover was struck while someone retreated from the arrival control. One dark contact wipe breaks off at its torn lower seam; short interrupted floor rubs lead away. No duplicate handprint or freestanding obstacle.',
    primary: [19.49, 1.19, 7.04],
    capture: { tick: 196, worldHash: 'ac15ac5a549119c1', flashlight: true },
  },
  {
    id: 'infirmary-aftermath',
    role: 'failed aid at a folded berth',
    anchor: [29.5, 0, 16.3],
    yaw: -90,
    raised: { min: [29.486, 0.45, 15.85], max: [29.7, 2.2, 16.75] },
    floor: { min: [29, 0.003, 15.85], max: [29.48, 0.005, 16.75] },
    solid: [30, 16],
    open: [29, 16],
    normal: [-1, 0, 0],
    wallAxis: 0,
    wallPlane: 29.5,
    protected: { min: [27.7, 0, 12.35], max: [29.5, 3, 13.65], control: 'triage-recorder' },
    story:
      'A compact aid wrap remains caught in a bent berth clip. Its folded fabric has a single absorbed contact patch and ragged tension tear, while a narrow restraint tail hangs against the existing padding. No body, new medical furniture collider or repeated floor stamp.',
    primary: [29.49, 1.52, 16.29],
    capture: { tick: 3830, worldHash: 'd417f7cc153b6c02', flashlight: false },
  },
  {
    id: 'archive-aftermath',
    role: 'failed equipment brace',
    anchor: [22.075, 0, 31.5],
    yaw: 180,
    raised: { min: [21.7, 0.35, 31.486], max: [22.45, 1.85, 31.7] },
    floor: { min: [21.7, 0.003, 31], max: [22.45, 0.005, 31.48] },
    solid: [22, 32],
    open: [22, 31],
    normal: [0, 0, -1],
    wallAxis: 2,
    wallPlane: 31.5,
    protected: { min: [20.4, 0, 29.4], max: [21.6, 3, 31.5], control: 'archive-recorder' },
    story:
      'An improvised short brace was forced across a recorder cassette, not a passage. One mounting ear has sheared and a split cassette lip has sunk against its dark seat. Opposed contact scores and a sparse lower-edge residue explain the force; the control and corridor remain clear.',
    primary: [22.04, 1.21, 31.49],
    capture: { tick: 4728, worldHash: '296b05427899aa11', flashlight: false },
  },
];

const KIT = {
  ...MATERIALS,
  'aftermath-residue': {
    map: 'aftermath-decals.png',
    rough: 0.94,
    metal: 0,
    alpha: 'BLEND',
    double: true,
  },
  'aid-fabric': {
    color: [0.32, 0.3, 0.24, 1],
    normal: 'suit-textile-normal.png',
    normalScale: 0.3,
    rough: 0.97,
    metal: 0,
    double: true,
  },
  'aid-soak': {
    map: 'aftermath-decals.png',
    normal: 'suit-textile-normal.png',
    normalScale: 0.18,
    rough: 0.96,
    metal: 0,
    alpha: 'BLEND',
    double: true,
  },
  'fracture-substrate': {
    color: [0.19, 0.18, 0.135, 1],
    normal: 'graphite-normal.png',
    normalScale: 0.25,
    rough: 0.86,
    metal: 0.1,
  },
};

function plate(model, node, material, outline, position, thickness = 0.016) {
  const shape = new Shape();
  outline.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelSize: 0.002,
    bevelThickness: 0.001,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  model.add(node, material, geometry, position, [0, 0, 0], KIT[material].tile ?? null);
}

function floorMark(model, node, center, size, rect, yaw) {
  model.withTransform([center[0], 0.004, center[1]], yaw, () => {
    const [w, d] = size,
      [u, v, du, dv] = rect;
    model.quad(
      node,
      'aftermath-residue',
      [
        [-w / 2, 0, d / 2],
        [w / 2, 0, d / 2],
        [w / 2, 0, -d / 2],
        [-w / 2, 0, -d / 2],
      ],
      [
        [u, v + dv],
        [u + du, v + dv],
        [u + du, v],
        [u, v],
      ],
    );
  });
}

function attachedCloth(model, node) {
  const columns = 6,
    rows = 12,
    positions = [],
    uv = [],
    indices = [];
  const point = (s, t) => {
    const width = 0.265 * (1 - 0.18 * t) * (1 + 0.045 * Math.sin(t * 24));
    const x = 0.074 - t * 0.115 + s * width;
    const y = 1.89 - t * 0.62 + Math.sin(s * 9 + t * 7) * 0.007 * t;
    const z = -0.008 + Math.sin(t * Math.PI * 2.3 + s * 3) * 0.008 + s * 0.003;
    return [x, y, z];
  };
  for (let row = 0; row <= rows; row++)
    for (let col = 0; col <= columns; col++) {
      const s = col / columns - 0.5,
        t = row / rows;
      positions.push(...point(s, t));
      uv.push((col / columns) * 2, t * 4);
      if (row < rows && col < columns) {
        const a = row * (columns + 1) + col,
          b = a + columns + 1;
        if (!(row > 8 && col === 2 && row % 2 === 0)) indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
  const frontCount = positions.length / 3,
    frontIndices = [...indices],
    boundary = new Map();
  for (let i = 0; i < frontCount; i++) {
    positions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2] - 0.0015);
    uv.push(uv[i * 2], uv[i * 2 + 1]);
  }
  for (let i = 0; i < frontIndices.length; i += 3) {
    const triangle = frontIndices.slice(i, i + 3);
    indices.push(triangle[0] + frontCount, triangle[2] + frontCount, triangle[1] + frontCount);
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge],
        b = triangle[(edge + 1) % 3],
        key = [a, b].sort((x, y) => x - y).join(':');
      if (boundary.has(key)) boundary.delete(key);
      else boundary.set(key, [a, b]);
    }
  }
  for (const [a, b] of boundary.values())
    indices.push(a, b + frontCount, b, a, a + frontCount, b + frontCount);
  const mesh = new BufferGeometry();
  mesh.setAttribute('position', new Float32BufferAttribute(positions, 3));
  mesh.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  mesh.setIndex(indices);
  mesh.computeVertexNormals();
  model.add(node, 'aid-fabric', mesh);
  for (let i = 0; i < 4; i++) {
    const p = point(-0.42 + i * 0.25, 1);
    model.cable(
      node,
      'aid-fabric',
      [
        p,
        [p[0] + 0.01, p[1] - 0.03 - i * 0.006, p[2] - 0.005],
        [p[0] - 0.006, p[1] - 0.046 - i * 0.005, p[2] - 0.009],
      ],
      0.0014,
      4,
    );
  }
  // A cropped palm/contact region, not the maintenance site's repeated full hand motif.
  for (let row = 0; row < 4; row++) {
    const t0 = 0.31 + row * 0.085,
      t1 = t0 + 0.085;
    const a = point(-0.39, t1),
      b = point(0.26, t1),
      c = point(0.26, t0),
      d = point(-0.39, t0);
    for (const p of [a, b, c, d]) p[2] += 0.0006;
    const v0 = 0.205 + row * 0.043,
      v1 = v0 + 0.043;
    model.quad(
      node,
      'aid-soak',
      [a, b, c, d],
      [
        [0.66, v1],
        [0.82, v1],
        [0.82, v0],
        [0.66, v0],
      ],
    );
  }
  for (const side of [-1, 1]) {
    const a = point(side * 0.5, 0),
      b = point(side * 0.5, 1);
    model.cable(node, 'aid-fabric', [a, point(side * 0.5, 0.5), b], 0.0021, 12);
  }
}

export function aftermathSitesModel(scene) {
  const floorplan = scene.resources?.['fps.floorplan'];
  if (!floorplan || floorplan.width !== 31 || floorplan.height !== 41 || floorplan.tileSize !== 1)
    throw new Error('Unexpected canonical collision contract');
  const cell = ([x, z]) => floorplan.legend[floorplan.rows[floorplan.height - 1 - z][x]];
  const model = new Model('null-meridian-three-aftermath-sites', KIT);
  for (const site of AFTERMATH_SITES) {
    if (!cell(site.solid)?.solid || cell(site.open)?.solid)
      throw new Error(`Wall contract changed for ${site.id}`);
    const node = model.node(site.id),
      floor = model.node(`${site.id}-floor`, node);
    model.withTransform(site.anchor, (site.yaw * Math.PI) / 180, () => {
      if (site.id === 'arrival-aftermath') {
        model.box(node, 'graphite', [0, 1.18, -0.024], [0.49, 0.68, 0.04], 0.012);
        plate(
          model,
          node,
          'ceramic',
          [
            [-0.224, -0.294],
            [0.046, -0.29],
            [0.094, -0.206],
            [0.066, -0.158],
            [0.176, -0.097],
            [0.224, 0.078],
            [0.217, 0.291],
            [-0.224, 0.291],
          ],
          [0, 1.19, -0.011],
        );
        plate(
          model,
          node,
          'fracture-substrate',
          [
            [0.122, -0.259],
            [0.198, -0.226],
            [0.222, -0.112],
            [0.172, -0.156],
          ],
          [0, 1.19, -0.016],
          0.014,
        );
        for (const [x, y] of [
          [-0.198, 0.939],
          [-0.198, 1.447],
          [0.195, 1.445],
        ])
          model.cylinder(node, 'satin', [x, y, 0.009], 0.009, 0.006, 'z', 0.009, 8);
        model.cylinder(node, 'rubber', [0.18, 0.941, 0.008], 0.015, 0.004, 'z', 0.015, 12);
        model.cable(
          node,
          'steel',
          [
            [0.18, 0.94, 0.009],
            [0.15, 0.967, 0.001],
            [0.134, 0.954, -0.008],
          ],
          0.003,
          5,
        );
        model.cable(
          node,
          'rubber',
          [
            [0.09, 0.99, -0.003],
            [0.095, 0.86, -0.005],
            [0.054, 0.795, -0.012],
          ],
          0.006,
          9,
        );
        model.decal(
          node,
          [-0.012, 1.266, 0.008],
          0.31,
          0.3,
          [0.08, 0.59, 0.34, 0.29],
          0,
          'aftermath-residue',
        );
        model.decal(
          node,
          [0.04, 1.035, 0.009],
          0.19,
          0.19,
          [0.67, 0.67, 0.21, 0.21],
          0,
          'aftermath-residue',
        );
        model.features.push({
          site: site.id,
          detail:
            'One scored/parted service cover; attached torn fastener and terminating contact wipe',
          primaryLocal: [0, 1.19, 0.01],
        });
      } else if (site.id === 'infirmary-aftermath') {
        model.box(node, 'graphite', [0.065, 1.905, -0.025], [0.23, 0.105, 0.045], 0.008);
        model.box(node, 'satin', [0.065, 1.922, -0.003], [0.19, 0.027, 0.026], 0.005);
        model.cable(
          node,
          'steel',
          [
            [0.133, 1.947, 0.006],
            [0.153, 1.891, 0.003],
            [0.111, 1.864, -0.008],
          ],
          0.004,
          6,
        );
        attachedCloth(model, node);
        model.cable(
          node,
          'aid-fabric',
          [
            [-0.16, 1.83, -0.013],
            [-0.215, 1.659, -0.01],
            [-0.217, 1.453, -0.016],
            [-0.188, 1.352, -0.02],
          ],
          0.014,
          15,
        );
        model.box(node, 'graphite', [-0.162, 1.838, -0.006], [0.068, 0.07, 0.025], 0.007);
        model.decal(
          node,
          [-0.075, 0.9, 0.01],
          0.15,
          0.12,
          [0.69, 0.295, 0.12, 0.11],
          0,
          'aftermath-residue',
        );
        model.features.push({
          site: site.id,
          detail:
            'A frayed aid wrap anchored to one bent berth clip; one absorbed transfer region and a slack restraint tail',
          primaryLocal: [0.03, 1.67, 0.006],
        });
      } else {
        model.box(node, 'graphite', [0.015, 1.12, -0.036], [0.53, 0.5, 0.05], 0.008);
        plate(
          model,
          node,
          'satin',
          [
            [-0.246, -0.205],
            [0.171, -0.205],
            [0.226, -0.125],
            [0.158, -0.043],
            [0.241, 0.06],
            [0.238, 0.197],
            [-0.244, 0.197],
          ],
          [0.015, 1.16, -0.011],
          0.016,
        );
        model.box(node, 'graphite', [-0.132, 1.234, 0.007], [0.1, 0.054, 0.01], 0.006);
        model.cable(
          node,
          'steel',
          [
            [-0.16, 1.234, 0.007],
            [-0.153, 1.178, 0.002],
            [-0.125, 1.145, -0.005],
          ],
          0.005,
          5,
        );
        plate(
          model,
          node,
          'fracture-substrate',
          [
            [0.158, -0.141],
            [0.243, -0.204],
            [0.239, -0.055],
            [0.194, -0.065],
          ],
          [0.015, 1.16, -0.012],
          0.013,
        );
        model.box(
          node,
          'steel',
          [-0.022, 1.318, -0.003],
          [0.042, 0.63, 0.022],
          0.006,
          [0, 0, -0.66],
        );
        model.box(node, 'ochre', [-0.207, 1.066, -0.001], [0.088, 0.083, 0.02], 0.007);
        model.box(node, 'rubber', [0.153, 1.567, -0.004], [0.11, 0.065, 0.015], 0.006);
        model.cylinder(node, 'satin', [-0.205, 1.055, 0.009], 0.011, 0.006, 'z', 0.011, 10);
        model.decal(
          node,
          [0.098, 1.355, 0.011],
          0.24,
          0.28,
          [0.12, 0.57, 0.32, 0.35],
          0,
          'aftermath-residue',
        );
        model.decal(
          node,
          [-0.13, 1.014, 0.01],
          0.12,
          0.07,
          [0.7, 0.325, 0.1, 0.06],
          0,
          'aftermath-residue',
        );
        model.features.push({
          site: site.id,
          detail:
            'Short cassette brace seated at opposite contacts; parted lip and sheared mounting ear, not a doorway barricade',
          primaryLocal: [-0.04, 1.29, 0.011],
        });
      }
    });
    if (site.id === 'arrival-aftermath') {
      floorMark(model, floor, [19.215, 7.08], [0.24, 0.38], [0.08, 0.59, 0.3, 0.3], -0.28);
    } else if (site.id === 'infirmary-aftermath') {
      floorMark(model, floor, [29.28, 16.32], [0.18, 0.3], [0.66, 0.29, 0.16, 0.14], 0.17);
    } else {
      floorMark(model, floor, [22.19, 31.26], [0.22, 0.26], [0.08, 0.68, 0.29, 0.24], -0.26);
    }
  }
  return model;
}

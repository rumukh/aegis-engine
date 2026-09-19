import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Shape } from 'three';
import { Model, rotation } from './model.mjs';
import { MATERIALS } from './textures.mjs';
import { curvedVisor } from './optical-surfaces.mjs';

function pressureLoft(model, node, material, sections, segments = 32, fold = 0.004) {
  const rings = [...sections].sort((a, b) => a[0] - b[0]);
  const positions = [],
    uvs = [],
    indices = [];
  for (let row = 0; row < rings.length; row++) {
    const [y, rx, rz, z = 0, x = 0] = rings[row];
    for (let col = 0; col <= segments; col++) {
      const angle = (col / segments) * Math.PI * 2;
      const wrinkle =
        fold * Math.sin(angle * 5 + row * 1.9) * Math.sin((Math.PI * row) / (rings.length - 1));
      positions.push(x + (rx + wrinkle) * Math.cos(angle), y, z + (rz + wrinkle) * Math.sin(angle));
      uvs.push((col / segments) * 1.4, ((y - rings[0][0]) / (rings.at(-1)[0] - rings[0][0])) * 1.6);
      if (row < rings.length - 1 && col < segments) {
        const a = row * (segments + 1) + col,
          b = a + segments + 1;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
  }
  for (const end of [0, rings.length - 1]) {
    const [y, , , z = 0, x = 0] = rings[end];
    const center = positions.length / 3;
    positions.push(x, y, z);
    uvs.push(0.5, 0.5);
    for (let col = 0; col < segments; col++) {
      const a = end * (segments + 1) + col;
      indices.push(...(end === 0 ? [center, a, a + 1] : [center, a + 1, a]));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  model.add(node, material, geometry);
}

function shell(
  model,
  node,
  outline,
  position,
  depth = 0.028,
  material = 'suit-shell',
  bevel = 0.01,
) {
  const shape = new Shape();
  outline.forEach(([x, y], index) => (index ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 4,
  });
  const minX = Math.min(...outline.map((p) => p[0])),
    maxX = Math.max(...outline.map((p) => p[0]));
  const minY = Math.min(...outline.map((p) => p[1])),
    maxY = Math.max(...outline.map((p) => p[1]));
  const uv = geometry.getAttribute('uv'),
    p = geometry.getAttribute('position');
  for (let i = 0; i < p.count; i++)
    uv.setXY(i, (p.getX(i) - minX) / (maxX - minX), 1 - (p.getY(i) - minY) / (maxY - minY));
  for (const group of geometry.groups) {
    const section = new BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const attribute = geometry.getAttribute(name);
      section.setAttribute(
        name,
        new Float32BufferAttribute(
          attribute.array.slice(
            group.start * attribute.itemSize,
            (group.start + group.count) * attribute.itemSize,
          ),
          attribute.itemSize,
        ),
      );
    }
    model.add(
      node,
      group.materialIndex === 1 && material === 'suit-shell' ? 'shell-edge' : material,
      section,
      position,
    );
  }
  geometry.dispose();
}

export function responderModel() {
  const model = new Model('meridian-corrupted-responder', MATERIALS);
  const solveLeg = (pelvisHeight, footZ, lift = 0) => {
    const thigh = 0.43,
      shin = Math.sqrt(0.4 * 0.4 + 0.009 * 0.009);
    const drop = pelvisHeight - 0.055 - 0.115 - lift;
    const cosine = (drop * drop + footZ * footZ - thigh * thigh - shin * shin) / (2 * thigh * shin);
    if (cosine < -1 || cosine > 1)
      throw new Error('Authored responder foot target is outside leg reach');
    const bend = Math.acos(cosine);
    const hip =
      Math.atan2(-footZ, drop) - Math.atan2(shin * Math.sin(bend), thigh + shin * Math.cos(bend));
    const knee = bend + Math.atan2(0.009, 0.4);
    return { hip, knee, ankle: -hip - knee };
  };
  const bind = solveLeg(0.94, 0);
  const hips = model.node('pelvis', 0, [0, 0.94, 0]);
  const chest = model.node('thorax', hips, [0, 0.46, -0.035]);
  const fastener = (node, x, y, z, radius = 0.007) => {
    model.cylinder(node, 'steel', [x, y, z], radius, 0.006, 'z', radius, 8);
    model.box(node, 'rubber', [x, y, z + 0.0034], [radius * 1.3, 0.0016, 0.001]);
  };
  const seam = (node, points, radius = 0.0035) => model.cable(node, 'rubber', points, radius, 18);
  const bellows = (node, centerY, radius, count = 5, gap = 0.023) => {
    for (let i = 0; i < count; i++)
      model.torus(
        node,
        'rubber',
        [0, centerY + (i - (count - 1) / 2) * gap, 0],
        radius,
        0.01,
        [Math.PI / 2, 0, 0],
        24,
      );
  };

  pressureLoft(
    model,
    hips,
    'suit-textile',
    [
      [-0.04, 0.211, 0.125, -0.01],
      [0, 0.226, 0.144],
      [0.05, 0.235, 0.155],
      [0.17, 0.213, 0.144],
    ],
    36,
  );
  pressureLoft(
    model,
    hips,
    'suit-textile',
    [
      [-0.16, 0.047, 0.092],
      [-0.075, 0.071, 0.13],
      [0.035, 0.095, 0.141],
    ],
    24,
    0.002,
  );
  pressureLoft(
    model,
    chest,
    'suit-textile',
    [
      [-0.3, 0.205, 0.145],
      [-0.23, 0.205, 0.148],
      [-0.16, 0.22, 0.166],
      [-0.05, 0.253, 0.183],
      [0.1, 0.274, 0.19],
      [0.22, 0.267, 0.175, -0.013],
      [0.29, 0.219, 0.148, -0.018],
      [0.315, 0.15, 0.125, -0.018],
    ],
    40,
    0.006,
  );
  for (const side of [-1, 1]) {
    seam(chest, [
      [side * 0.215, -0.25, 0.065],
      [side * 0.244, -0.08, 0.1],
      [side * 0.262, 0.08, 0.07],
      [side * 0.221, 0.25, 0.08],
    ]);
    model.box(hips, 'rubber', [side * 0.12, 0.05, 0.156], [0.215, 0.052, 0.031], 0.008);
  }
  model.box(hips, 'steel', [0.015, 0.05, 0.18], [0.074, 0.064, 0.017], 0.008);
  model.box(hips, 'rubber', [0.015, 0.05, 0.193], [0.03, 0.024, 0.005]);
  const chestOutline = [
    [-0.19, -0.2],
    [-0.23, -0.08],
    [-0.228, 0.16],
    [-0.145, 0.25],
    [0.14, 0.24],
    [0.225, 0.14],
    [0.21, -0.16],
    [0.115, -0.235],
    [-0.09, -0.225],
  ];
  shell(
    model,
    chest,
    chestOutline.map(([x, y]) => [x * 1.05, y * 1.04]),
    [0, 0.005, 0.16],
    0.018,
    'rubber',
    0.007,
  );
  shell(model, chest, chestOutline, [0, 0.005, 0.179], 0.026);
  for (const [x, y] of [
    [-0.173, 0.15],
    [0.166, 0.15],
    [-0.155, -0.15],
    [0.151, -0.15],
  ])
    fastener(chest, x, y, 0.224, 0.009);
  model.badge(chest, [-0.08, 0.04, 0.222], 0.2, 0.052, 0);
  model.box(chest, 'graphite', [0.114, -0.027, 0.232], [0.14, 0.195, 0.069], 0.009);
  for (let row = 0; row < 5; row++)
    model.box(chest, 'steel', [0.114, -0.067 + row * 0.023, 0.27], [0.085, 0.007, 0.006]);
  model.box(chest, 'ochre', [0.114, 0.052, 0.27], [0.052, 0.014, 0.007]);
  for (const x of [0.057, 0.171]) for (const y of [-0.1, 0.049]) fastener(chest, x, y, 0.27, 0.005);

  model.cylinder(chest, 'steel', [-0.117, -0.108, 0.238], 0.041, 0.06, 'z', 0.041, 24);
  model.torus(chest, 'rubber', [-0.117, -0.108, 0.272], 0.034, 0.009, [0, 0, 0], 24);
  model.cylinder(chest, 'copper', [-0.117, -0.108, 0.27], 0.023, 0.029, 'z', 0.023, 16);
  model.cable(
    chest,
    'rubber',
    [
      [-0.117, -0.108, 0.28],
      [-0.22, -0.16, 0.21],
      [-0.3, -0.1, 0.03],
      [-0.29, 0.13, -0.19],
      [-0.15, 0.26, -0.23],
    ],
    0.021,
    30,
  );
  for (let turn = 0; turn < 7; turn++) {
    model.torus(
      chest,
      'graphite',
      [-0.117, -0.108, 0.278 + turn * 0.001],
      0.03 + turn * 0.0006,
      0.003,
      [0, 0, 0],
      20,
    );
  }
  model.box(chest, 'graphite', [0, 0.022, -0.195], [0.4, 0.54, 0.105], 0.025);
  for (const x of [-0.105, 0.105]) {
    model.cylinder(chest, 'suit-shell', [x, 0.015, -0.21], 0.064, 0.43, 'y', 0.057, 24);
    for (const y of [-0.12, 0.18])
      model.torus(chest, 'steel', [x, y, -0.21], 0.064, 0.009, [Math.PI / 2, 0, 0], 24);
    model.box(chest, 'rubber', [x, 0.01, -0.275], [0.12, 0.031, 0.007]);
  }
  for (const side of [-1, 1]) {
    model.cable(
      chest,
      'ochre',
      [
        [side * 0.17, -0.25, 0.128],
        [side * 0.218, 0.12, 0.135],
        [side * 0.16, 0.29, 0.013],
        [side * 0.15, 0.18, -0.24],
      ],
      0.016,
      18,
    );
    model.box(chest, 'steel', [side * 0.202, -0.035, 0.16], [0.049, 0.065, 0.025], 0.006);
  }

  const head = model.node('helmet', chest, [0, 0.445, -0.002]);
  model.cylinder(head, 'rubber', [0, -0.137, 0], 0.124, 0.135, 'y', 0.124, 32);
  for (const y of [-0.19, -0.15, -0.12])
    model.torus(head, 'steel', [0, y, 0], 0.145, 0.011, [Math.PI / 2, 0, 0], 32);
  pressureLoft(
    model,
    head,
    'suit-shell',
    [
      [-0.17, 0.112, 0.118, -0.004],
      [-0.13, 0.172, 0.15, -0.008],
      [-0.065, 0.196, 0.17, -0.008],
      [0.035, 0.197, 0.177, -0.015],
      [0.115, 0.181, 0.158, -0.018],
      [0.163, 0.139, 0.12, -0.025],
      [0.184, 0.054, 0.059, -0.025],
    ],
    48,
    0,
  );
  const visor = [
    [-0.144, -0.061],
    [-0.151, 0.029],
    [-0.118, 0.087],
    [0.108, 0.092],
    [0.149, 0.039],
    [0.142, -0.069],
    [0.088, -0.107],
    [-0.105, -0.102],
  ];
  shell(
    model,
    head,
    visor.map(([x, y]) => [x * 1.13, y * 1.14]),
    [0, 0.005, 0.142],
    0.027,
    'rubber',
    0.012,
  );
  shell(
    model,
    head,
    visor.map(([x, y]) => [x * 1.045, y * 1.05]),
    [0, 0.005, 0.173],
    0.012,
    'steel',
    0.005,
  );
  model.add(head, 'rescue-visor', curvedVisor(visor), [0, 0.005, 0]);
  shell(
    model,
    head,
    [
      [-0.155, -0.031],
      [-0.13, -0.068],
      [0.12, -0.061],
      [0.149, -0.015],
      [0.146, 0.013],
      [-0.15, 0.013],
    ],
    [0, -0.09, 0.16],
    0.024,
    'suit-shell',
    0.006,
  );
  for (const side of [-1, 1]) {
    model.box(head, 'graphite', [side * 0.195, -0.044, 0.022], [0.032, 0.16, 0.1], 0.012);
    model.box(head, 'steel', [side * 0.194, 0.092, -0.025], [0.035, 0.035, 0.105], 0.007);
    for (const y of [-0.078, 0.058]) fastener(head, side * 0.153, y, 0.194, 0.007);
  }
  model.box(head, 'ochre', [-0.055, 0.174, -0.032], [0.031, 0.008, 0.175], 0.003);
  model.badge(head, [0.036, -0.146, 0.177], 0.13, 0.032, 1);
  model.box(head, 'graphite', [-0.203, 0.091, 0.055], [0.039, 0.066, 0.12], 0.01);

  const legs = [],
    knees = [],
    ankles = [],
    arms = [],
    elbows = [];
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'left' : 'right';
    const leg = model.node(
      `hip-${suffix}`,
      hips,
      [side * 0.133, -0.055, 0],
      rotation('x', bind.hip),
    );
    legs.push(leg);
    pressureLoft(
      model,
      leg,
      'suit-textile',
      [
        [-0.445, 0.08, 0.087],
        [-0.36, 0.1, 0.108],
        [-0.29, 0.116, 0.112, -0.01],
        [-0.2, 0.117, 0.112],
        [-0.1, 0.121, 0.12],
        [0.12, 0.118, 0.113],
      ],
      32,
      0.0045,
    );
    seam(leg, [
      [side * 0.109, 0, 0.026],
      [side * 0.119, -0.17, 0.038],
      [side * 0.105, -0.32, 0.023],
      [side * 0.077, -0.43, 0.015],
    ]);
    model.box(leg, 'suit-textile', [side * 0.077, -0.17, 0.083], [0.09, 0.21, 0.083], 0.014);
    model.box(leg, 'rubber', [side * 0.077, -0.083, 0.129], [0.094, 0.028, 0.015], 0.004);
    model.badge(leg, [side * 0.077, -0.135, 0.131], 0.075, 0.019, 2);
    const knee = model.node(`knee-${suffix}`, leg, [0, -0.43, 0], rotation('x', bind.knee));
    knees.push(knee);
    pressureLoft(
      model,
      knee,
      'rubber',
      [
        [-0.076, 0.077, 0.086],
        [0, 0.084, 0.092],
        [0.075, 0.079, 0.09],
      ],
      28,
      0.001,
    );
    bellows(knee, -0.005, 0.083, 5, 0.02);
    pressureLoft(
      model,
      knee,
      'suit-textile',
      [
        [-0.405, 0.067, 0.083, 0.009],
        [-0.34, 0.074, 0.089, -0.006],
        [-0.24, 0.089, 0.105, -0.011],
        [-0.15, 0.101, 0.111, -0.004],
        [-0.065, 0.082, 0.088],
      ],
      30,
      0.0045,
    );
    const shin = [
      [-0.06, -0.3],
      [-0.074, -0.13],
      [-0.063, -0.071],
      [0.057, -0.074],
      [0.074, -0.14],
      [0.051, -0.3],
    ];
    shell(model, knee, shin, [0, 0, 0.091], 0.02);
    for (const y of [-0.11, -0.25]) fastener(knee, -side * 0.037, y, 0.124, 0.006);
    model.box(knee, 'ochre', [side * 0.037, -0.188, 0.127], [0.012, 0.11, 0.003]);
    const ankle = model.node(`ankle-${suffix}`, knee, [0, -0.4, 0.009], rotation('x', bind.ankle));
    ankles.push(ankle);
    pressureLoft(
      model,
      ankle,
      'rubber',
      [
        [-0.105, 0.105, 0.185, 0.066],
        [-0.072, 0.114, 0.181, 0.066],
        [-0.015, 0.099, 0.137, 0.035],
        [0.054, 0.075, 0.095, 0.012],
        [0.088, 0.07, 0.085, 0.007],
      ],
      32,
      0.001,
    );
    model.box(ankle, 'graphite', [0, -0.099, 0.063], [0.227, 0.03, 0.373], 0.01);
    for (let tread = 0; tread < 6; tread++)
      model.box(ankle, 'rubber', [0, -0.11, -0.081 + tread * 0.059], [0.235, 0.01, 0.031]);
    shell(
      model,
      ankle,
      [
        [-0.091, -0.09],
        [-0.102, -0.039],
        [-0.078, 0.002],
        [0.077, 0.002],
        [0.101, -0.042],
        [0.087, -0.09],
      ],
      [0, 0, 0.177],
      0.011,
      'steel',
      0.004,
    );
    for (const y of [0.001, 0.05]) bellows(ankle, y, 0.078, 1);

    const arm = model.node(`shoulder-${suffix}`, chest, [side * 0.286, 0.229, -0.003]);
    arms.push(arm);
    pressureLoft(
      model,
      arm,
      'suit-textile',
      [
        [-0.355, 0.065, 0.073],
        [-0.26, 0.081, 0.09],
        [-0.15, 0.091, 0.098],
        [-0.045, 0.099, 0.115, -0.006],
        [0.049, 0.099, 0.105, -0.013],
      ],
      32,
      0.004,
    );
    const shoulder = [
      [-0.082, -0.124],
      [-0.098, -0.037],
      [-0.083, 0.044],
      [-0.032, 0.067],
      [0.073, 0.045],
      [0.103, -0.028],
      [0.083, -0.111],
      [0.006, -0.142],
    ];
    shell(model, arm, shoulder, [0, 0, 0.075], 0.021);
    for (const x of [-0.058, 0.058]) fastener(arm, x, -0.029, 0.118, 0.007);
    model.badge(arm, [0, -0.085, 0.114], 0.117, 0.029, 3);
    if (side === 1) {
      for (const y of [-0.033, -0.075])
        model.box(arm, 'ochre', [0.016, y, 0.128], [0.155, 0.02, 0.003], 0, [0, 0, 0.14]);
    } else {
      model.box(arm, 'graphite', [-0.02, -0.19, 0.097], [0.125, 0.14, 0.045], 0.012);
      model.box(arm, 'satin', [-0.02, -0.15, 0.121], [0.088, 0.017, 0.007]);
    }
    seam(arm, [
      [side * 0.091, 0.025, -0.025],
      [side * 0.091, -0.12, 0.006],
      [side * 0.074, -0.28, -0.02],
    ]);
    const elbow = model.node(`elbow-${suffix}`, arm, [0, -0.355, 0]);
    elbows.push(elbow);
    bellows(elbow, -0.002, 0.07, 5, 0.021);
    pressureLoft(
      model,
      elbow,
      'suit-textile',
      [
        [-0.32, 0.05, 0.059],
        [-0.24, 0.068, 0.073],
        [-0.12, 0.079, 0.078],
        [-0.04, 0.066, 0.073],
      ],
      28,
      0.004,
    );
    shell(
      model,
      elbow,
      [
        [-0.047, -0.275],
        [-0.062, -0.105],
        [-0.041, -0.065],
        [0.053, -0.076],
        [0.065, -0.17],
        [0.038, -0.275],
      ],
      [0, 0, 0.064],
      0.017,
    );
    model.box(elbow, 'graphite', [0, -0.175, 0.101], [0.065, 0.1, 0.025], 0.007);
    for (const y of [-0.146, -0.173, -0.2])
      model.box(elbow, 'steel', [0, y, 0.115], [0.037, 0.006, 0.004]);
    bellows(elbow, -0.305, 0.055, 3, 0.015);
    model.box(elbow, 'rubber', [0, -0.375, 0.006], [0.083, 0.11, 0.062], 0.023);
    for (let finger = 0; finger < 4; finger++) {
      model.cylinder(
        elbow,
        'rubber',
        [-0.029 + finger * 0.019, -0.445 + Math.abs(finger - 1.4) * 0.004, 0.018],
        0.0095,
        0.064,
        'y',
        0.01,
        10,
      );
    }
    model.box(elbow, 'rubber', [-side * 0.049, -0.383, 0.032], [0.027, 0.08, 0.03], 0.01, [
      0.2,
      0,
      -side * 0.36,
    ]);
    for (const y of [-0.348, -0.38])
      seam(
        elbow,
        [
          [-0.033, y, 0.04],
          [0, y - 0.003, 0.041],
          [0.033, y, 0.04],
        ],
        0.002,
      );
  }

  const quatTrack = (node, axis, times, values) => ({
    node,
    path: 'rotation',
    times,
    values: values.map((angle) => rotation(axis, angle)),
  });
  model.animation('Idle', [
    quatTrack(chest, 'x', [0, 1.7, 3.4], [0.055, 0.075, 0.055]),
    quatTrack(head, 'z', [0, 1.7, 3.4], [-0.062, -0.083, -0.062]),
    quatTrack(arms[0], 'x', [0, 1.7, 3.4], [-0.085, -0.11, -0.085]),
    quatTrack(elbows[1], 'x', [0, 1.7, 3.4], [-0.14, -0.165, -0.14]),
  ]);
  const times = Array.from({ length: 49 }, (_, i) => (i * 2.2) / 48);
  const phases = times.map((time) => time / 1.1);
  const hipHeights = phases.map((phase) => 0.895 + 0.047 * Math.sin(Math.PI * (phase % 1)) ** 2);
  const poses = [0, 1].map((leg) =>
    phases.map((phase, i) => {
      const local = (phase + leg) % 2,
        part = local % 1;
      const footZ = local < 1 ? 0.4 - 0.8 * part : -0.4 * Math.cos(part * Math.PI);
      const lift = local < 1 ? 0 : 0.075 * Math.sin(part * Math.PI) ** 2;
      return solveLeg(hipHeights[i], footZ, lift);
    }),
  );
  model.animation('Stalk', [
    ...legs.map((node, i) =>
      quatTrack(
        node,
        'x',
        times,
        poses[i].map((pose) => pose.hip),
      ),
    ),
    ...knees.map((node, i) =>
      quatTrack(
        node,
        'x',
        times,
        poses[i].map((pose) => pose.knee),
      ),
    ),
    ...ankles.map((node, i) =>
      quatTrack(
        node,
        'x',
        times,
        poses[i].map((pose) => pose.ankle),
      ),
    ),
    quatTrack(
      arms[0],
      'x',
      times,
      phases.map((phase) => -0.065 + 0.145 * Math.cos(phase * Math.PI)),
    ),
    quatTrack(
      arms[1],
      'x',
      times,
      phases.map((phase) => -0.025 - 0.125 * Math.cos(phase * Math.PI)),
    ),
    quatTrack(
      elbows[0],
      'x',
      times,
      phases.map((phase) => -0.175 + 0.055 * Math.cos(phase * Math.PI)),
    ),
    quatTrack(
      chest,
      'x',
      times,
      phases.map((phase) => 0.055 + 0.009 * Math.sin(phase * Math.PI) ** 2),
    ),
    {
      node: hips,
      path: 'translation',
      times,
      values: phases.map((phase, i) => [-0.014 * Math.sin(phase * Math.PI), hipHeights[i], 0]),
    },
  ]);
  model.animation('Search', [
    quatTrack(head, 'y', [0, 1.1, 2.3, 3.6, 4.4], [0, -0.75, 0.08, 0.75, 0]),
    quatTrack(chest, 'y', [0, 1.1, 2.3, 3.6, 4.4], [0, -0.13, 0, 0.17, 0]),
    quatTrack(elbows[1], 'x', [0, 1.1, 2.3, 3.6, 4.4], [-0.14, -0.2, -0.35, -0.2, -0.14]),
  ]);
  model.animation('Lunge', [
    quatTrack(chest, 'x', [0, 0.25, 0.52, 0.8], [0.055, -0.08, 0.28, 0.32]),
    ...arms.map((node, i) =>
      quatTrack(node, 'x', [0, 0.25, 0.52, 0.8], [-0.04, -0.1, i ? -1.15 : -1.22, -1.1]),
    ),
    ...elbows.map((node) =>
      quatTrack(node, 'x', [0, 0.25, 0.52, 0.8], [-0.14, -0.28, -0.42, -0.2]),
    ),
    quatTrack(head, 'x', [0, 0.25, 0.52, 0.8], [0, 0.06, -0.23, -0.18]),
  ]);
  return model;
}

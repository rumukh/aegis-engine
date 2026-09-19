import { Model, rotation } from './model.mjs';
import { MATERIALS } from './textures.mjs';

export const MOUNTS = [
  {
    entity: 'arrival-terminal',
    kind: 'arrival',
    position: [19.45, 0, 6],
    yaw: -90,
    width: 0.94,
    height: 0.73,
    centerY: 1.23,
  },
  {
    entity: 'fuse-locker',
    kind: 'fuse',
    position: [3, 0, 8.55],
    yaw: 0,
    width: 0.88,
    height: 1.16,
    centerY: 1.25,
  },
  {
    entity: 'maintenance-note',
    kind: 'note',
    position: [7.55, 0, 17],
    yaw: 90,
    width: 0.58,
    height: 0.76,
    centerY: 1.3,
  },
  {
    entity: 'service-wheel',
    kind: 'wheel',
    position: [4, 0, 23.45],
    yaw: 180,
    width: 0.62,
    height: 1.18,
    centerY: 1.18,
  },
  {
    entity: 'power-console',
    kind: 'power',
    position: [3, 0, 31.45],
    yaw: 180,
    width: 0.92,
    height: 1.08,
    centerY: 1.25,
  },
  {
    entity: 'bus-isolator',
    kind: 'lever',
    position: [9, 0, 31.45],
    yaw: 180,
    width: 0.74,
    height: 1.06,
    centerY: 1.23,
  },
  {
    entity: 'triage-recorder',
    kind: 'triage',
    position: [29.45, 0, 13],
    yaw: -90,
    width: 0.8,
    height: 0.98,
    centerY: 1.27,
  },
  {
    entity: 'archive-recorder',
    kind: 'recorder',
    position: [21, 0, 31.45],
    yaw: 180,
    width: 0.9,
    height: 0.96,
    centerY: 1.28,
  },
  {
    entity: 'coolant-valve',
    kind: 'coolant',
    position: [3, 0, 23.45],
    yaw: 180,
    width: 0.62,
    height: 1.3,
    centerY: 1.2,
  },
  {
    entity: 'uplink-console',
    kind: 'uplink',
    position: [6, 0, 39.45],
    yaw: 180,
    width: 0.95,
    height: 1.04,
    centerY: 1.23,
  },
  {
    entity: 'evac-control',
    kind: 'evac',
    position: [29.45, 0, 38],
    yaw: -90,
    width: 0.9,
    height: 1.18,
    centerY: 1.25,
  },
];

export function validateMounts(scene) {
  for (const mount of MOUNTS) {
    const position = scene.entities.find((entity) => entity.id === mount.entity)?.components
      ?.Transform?.position;
    if (
      !position ||
      [position.x, position.y, position.z].some((value, i) => value !== mount.position[i])
    )
      throw new Error(
        `Atomic wall-mount contract not present: ${mount.entity} must be at ${mount.position}`,
      );
  }
}

export function mountedProp(mount) {
  const model = new Model(`meridian-${mount.entity}`, MATERIALS);
  const node = model.node('wall-housing');
  const { kind, width, height, centerY: cy } = mount;
  const bracket = kind === 'note' ? 'steel' : 'graphite';
  model.box(node, bracket, [0, cy, -0.175], [width, height, 0.27], 0.028);
  model.box(node, 'steel', [0, cy, -0.05], [width - 0.04, height - 0.04, 0.07], 0.014);
  model.box(node, 'rubber', [0, cy, -0.034], [width - 0.115, height - 0.14, 0.032], 0.01);
  const label = (row, y = cy + height / 2 - 0.108) =>
    model.sign(node, [0, y, -0.003], width - 0.18, 0.081, row);
  const screw = (x, y) => {
    model.cylinder(node, 'satin', [x, y, -0.007], 0.011, 0.01, 'z', 0.011, 8);
    model.box(node, 'graphite', [x, y, -0.0019], [0.014, 0.0025, 0.0009]);
  };
  for (const x of [-(width / 2 - 0.045), width / 2 - 0.045])
    for (const y of [cy - height / 2 + 0.05, cy + height / 2 - 0.05]) screw(x, y);
  const buttons = (y, count = 4) => {
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * 0.105;
      model.box(
        node,
        i === count - 1 ? 'ochre' : 'ceramic',
        [x, y, -0.01],
        [0.067, 0.033, 0.018],
        0.006,
      );
    }
  };
  if (['arrival', 'power', 'uplink', 'evac', 'note'].includes(kind)) {
    const screen = { arrival: 0, power: 1, uplink: 5, evac: 6, note: 7 }[kind];
    const sy = cy + (kind === 'note' ? 0.03 : 0.085);
    const screenWidth = width - 0.24,
      screenHeight = screenWidth * 0.49;
    model.box(
      node,
      'ceramic',
      [0, sy, -0.027],
      [screenWidth + 0.1, screenHeight + 0.085, 0.046],
      0.019,
    );
    model.box(
      node,
      'rubber',
      [0, sy, -0.006],
      [screenWidth + 0.026, screenHeight + 0.02, 0.01],
      0.008,
    );
    model.panel(node, [0, sy, 0], screenWidth, screenHeight, screen);
    label(
      kind === 'arrival'
        ? 1
        : kind === 'power'
          ? 3
          : kind === 'uplink'
            ? 6
            : kind === 'evac'
              ? 7
              : 2,
    );
    buttons(cy - height * 0.22, kind === 'note' ? 2 : 4);
    if (kind === 'power') {
      for (const x of [-0.25, 0, 0.25]) {
        model.box(node, 'graphite', [x, cy - 0.35, -0.015], [0.17, 0.11, 0.023], 0.008);
        model.cylinder(node, 'steel', [x, cy - 0.35, -0.004], 0.021, 0.006, 'z', 0.021, 14);
      }
    }
    if (kind === 'uplink') {
      for (const x of [-0.35, 0.35]) {
        model.box(node, 'ochre', [x, cy - 0.285, -0.012], [0.051, 0.17, 0.021], 0.007);
        for (const y of [-0.33, -0.3, -0.27, -0.24])
          model.box(node, 'steel', [x, cy + y, -0.001], [0.038, 0.006, 0.001]);
      }
    }
    if (kind === 'evac') {
      model.cylinder(node, 'ochre', [0, cy - 0.4, -0.03], 0.083, 0.056, 'z', 0.08, 24);
      model.cylinder(node, 'rubber', [0, cy - 0.4, -0.0015], 0.052, 0.002, 'z', 0.052, 24);
      for (const x of [-0.11, 0.11])
        model.box(node, 'steel', [x, cy - 0.4, -0.017], [0.031, 0.19, 0.03], 0.007);
    }
  } else if (kind === 'fuse') {
    label(9);
    for (let row = 0; row < 3; row++) {
      const y = cy + 0.24 - row * 0.27;
      model.box(node, 'graphite', [0, y, -0.096], [0.65, 0.19, 0.16], 0.01);
      model.cylinder(node, 'ceramic', [0, y, -0.072], 0.055, 0.35, 'x', 0.055, 20);
      for (const x of [-0.185, 0.185]) {
        model.cylinder(node, 'copper', [x, y, -0.072], 0.058, 0.049, 'x', 0.058, 16);
        model.box(node, 'steel', [x, y - 0.069, -0.085], [0.092, 0.065, 0.12], 0.009);
      }
      model.box(node, 'ochre', [0, y, -0.012], [0.075, 0.027, 0.018]);
    }
    label(3, cy - 0.47);
  } else if (kind === 'wheel' || kind === 'coolant') {
    label(kind === 'coolant' ? 10 : 8);
    const wy = cy - 0.11;
    model.cylinder(node, 'steel', [0, wy, -0.18], 0.11, 0.25, 'z', 0.11, 16);
    const wheel = model.node('manual-wheel', node, [0, wy, -0.03]);
    model.torus(wheel, 'ochre', [0, 0, 0], 0.232, 0.024, [0, 0, 0], 32);
    for (let spoke = 0; spoke < 5; spoke++) {
      const angle = (spoke * Math.PI * 2) / 5;
      model.box(
        wheel,
        'steel',
        [Math.sin(angle) * 0.12, Math.cos(angle) * 0.12, 0],
        [0.02, 0.22, 0.028],
        0.004,
        [0, 0, -angle],
      );
    }
    model.cylinder(wheel, 'graphite', [0, 0, 0], 0.042, 0.039, 'z');
    const gy = cy + 0.32;
    model.cylinder(node, 'satin', [0.13, gy, -0.024], 0.054, 0.044, 'z', 0.054, 24);
    model.cylinder(node, 'visor', [0.13, gy, -0.0017], 0.043, 0.002, 'z', 0.043, 24);
    model.box(node, 'warm', [0.13, gy + 0.012, -0.0003], [0.0025, 0.028, 0.0005], 0, [0, 0, -0.45]);
    label(kind === 'coolant' ? 10 : 8, cy - height / 2 + 0.12);
    model.animation('Turn', [
      {
        node: wheel,
        path: 'rotation',
        times: [0, 0.5, 1],
        values: [rotation('z', 0), rotation('z', -Math.PI / 2), rotation('z', -Math.PI)],
      },
    ]);
  } else if (kind === 'lever') {
    label(3);
    model.box(node, 'ochre', [0, cy - 0.015, -0.028], [0.36, 0.62, 0.05], 0.028);
    model.box(node, 'rubber', [0, cy - 0.015, -0.003], [0.083, 0.53, 0.004], 0.014);
    const lever = model.node('isolator-lever', node, [0, cy - 0.06, -0.1]);
    model.box(lever, 'steel', [0, 0.13, 0.04], [0.035, 0.26, 0.038], 0.006);
    model.box(lever, 'graphite', [0, 0.245, 0.058], [0.24, 0.065, 0.075], 0.016);
    model.animation('Turn', [
      {
        node: lever,
        path: 'rotation',
        times: [0, 1],
        values: [rotation('z', 0), rotation('z', Math.PI)],
      },
    ]);
  } else if (kind === 'triage') {
    label(4);
    model.panel(node, [0, cy + 0.13, 0], 0.55, 0.25, 2);
    for (const x of [-0.155, 0.155]) {
      model.cylinder(node, 'steel', [x, cy - 0.17, -0.022], 0.08, 0.04, 'z', 0.08, 24);
      model.cylinder(node, 'rubber', [x, cy - 0.17, -0.0016], 0.052, 0.002, 'z', 0.052, 20);
      for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        model.cylinder(
          node,
          'graphite',
          [x + Math.cos(angle) * 0.066, cy - 0.17 + Math.sin(angle) * 0.066, -0.0015],
          0.008,
          0.002,
          'z',
          0.008,
          6,
        );
      }
    }
    buttons(cy - 0.34, 3);
  } else if (kind === 'recorder') {
    label(5);
    model.box(node, 'rubber', [0, cy - 0.04, -0.115], [0.64, 0.39, 0.2], 0.014);
    model.box(node, 'ochre', [0, cy - 0.04, -0.075], [0.51, 0.29, 0.145], 0.026);
    model.panel(node, [0, cy - 0.03, -0.001], 0.39, 0.16, 3);
    for (const x of [-0.31, 0.31]) {
      model.box(node, 'steel', [x, cy - 0.04, -0.04], [0.033, 0.42, 0.065], 0.01);
      model.box(node, 'graphite', [x, cy + 0.11, -0.016], [0.065, 0.07, 0.028], 0.008);
    }
    label(11, cy - 0.36);
  }
  return model;
}

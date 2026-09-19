import { SphereGeometry } from 'three';
import { Model } from './model.mjs';
import { MATERIALS } from './textures.mjs';
import { noise } from './raster.mjs';
import { MOUNTS, validateMounts } from './interactables.mjs';
import { ringGeometry, RING_ROTATION } from './optical-surfaces.mjs';

export const DOORS = [
  {
    entity: 'service-door',
    position: [6, 0, 24],
    rotation: [0, 0, 0],
    cells: [
      [5, 24],
      [6, 24],
      [7, 24],
    ],
    event: 'horror.service.opened',
  },
  {
    entity: 'power-door',
    position: [12, 0, 29],
    rotation: [0, 90, 0],
    cells: [
      [12, 28],
      [12, 29],
      [12, 30],
    ],
    event: 'horror.power.restored',
  },
  {
    entity: 'archive-west-door',
    position: [18, 0, 22],
    rotation: [0, 90, 0],
    cells: [
      [18, 21],
      [18, 22],
      [18, 23],
    ],
    event: 'horror.power.restored',
  },
  {
    entity: 'archive-south-door',
    position: [24, 0, 20],
    rotation: [0, 0, 0],
    cells: [
      [23, 20],
      [24, 20],
      [25, 20],
    ],
    event: 'horror.power.restored',
  },
  {
    entity: 'observation-door',
    position: [15, 0, 34],
    rotation: [0, 0, 0],
    cells: [
      [14, 34],
      [15, 34],
      [16, 34],
    ],
    event: 'horror.coolant.isolated',
  },
  {
    entity: 'evac-door',
    position: [24, 0, 37],
    rotation: [0, 90, 0],
    cells: [
      [24, 36],
      [24, 37],
      [24, 38],
    ],
    event: 'horror.uplink.transmitted',
  },
];

export const PROPS = MOUNTS.map(({ entity, yaw }) => [entity, entity, yaw]);

export const LIGHTS = [
  {
    id: 'ingress-practical',
    position: [15, 3.33, 5],
    target: [15, 0, 5],
    color: '#f2cf97',
    intensity: 24,
    distance: 13,
    angle: 65,
    shadow: false,
  },
  {
    id: 'maintenance-practical',
    position: [3, 3.33, 17],
    target: [4, 0, 18],
    color: '#dec69b',
    intensity: 23,
    distance: 17,
    angle: 65,
    shadow: false,
  },
  {
    id: 'power-practical',
    position: [7, 3.33, 29],
    target: [6, 0, 29],
    color: '#efd4a4',
    intensity: 35,
    distance: 17,
    angle: 65,
    shadow: true,
  },
  {
    id: 'infirmary-practical',
    position: [26, 3.33, 14],
    target: [26, 0, 14],
    color: '#b4c9be',
    intensity: 23,
    distance: 17,
    angle: 65,
    shadow: false,
  },
  {
    id: 'archive-practical',
    position: [22, 3.33, 28],
    target: [24, 0, 28],
    color: '#e4bf83',
    intensity: 28,
    distance: 17,
    angle: 65,
    shadow: false,
  },
  {
    id: 'spine-practical',
    position: [15, 3.33, 24],
    target: [15, 0, 25],
    color: '#afc5c5',
    intensity: 26,
    distance: 17,
    angle: 65,
    shadow: false,
  },
  {
    id: 'observation-practical',
    position: [15, 3.33, 37],
    target: [15, 0, 38],
    color: '#e8c99b',
    intensity: 26,
    distance: 15,
    angle: 70,
    shadow: false,
  },
];

const ROOMS = [
  'ingress',
  'maintenance',
  'power',
  'infirmary',
  'archive',
  'spine',
  'observation',
  'evacuation',
];
function roomAt(x, z) {
  if (z < 9) return 'ingress';
  if (z >= 35) return x >= 25 ? 'evacuation' : 'observation';
  if (x < 12) return z >= 25 ? 'power' : 'maintenance';
  if (x > 18) return z >= 21 ? 'archive' : 'infirmary';
  return 'spine';
}

export function buildFacility(scene) {
  validateMounts(scene);
  const grid = scene.resources?.['fps.floorplan'];
  if (
    !grid ||
    grid.width !== 31 ||
    grid.height !== 41 ||
    grid.tileSize !== 1 ||
    grid.origin?.x !== 0 ||
    grid.origin?.z !== 0
  )
    throw new Error(
      'Unsupported layout revision: expected contracted 31x41 grid, 1m integer centers, origin(0,0)',
    );
  if (grid.rows.length !== grid.height || grid.rows.some((row) => row.length !== grid.width))
    throw new Error('Malformed floorplan rows');
  const cell = (x, z) => grid.legend[grid.rows[grid.height - 1 - z]?.[x]];
  const open = (x, z) => {
    const value = cell(x, z);
    return value && (!value.solid || value.door);
  };
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  for (const door of DOORS) {
    const authored = entities.get(door.entity)?.components?.Transform?.position;
    if (!authored || [authored.x, authored.y, authored.z].some((v, i) => v !== door.position[i]))
      throw new Error(`Portal anchor drift: ${door.entity}`);
    for (const [x, z] of door.cells)
      if (!cell(x, z)?.door) throw new Error(`Portal cell missing: ${door.entity}(${x},${z})`);
  }
  const model = new Model('null-meridian-facility', MATERIALS);
  const rooms = new Map(ROOMS.map((name) => [name, model.node(`sector-${name}`)]));
  const envelope = model.node('sealed-pressure-envelope');
  model.quad(envelope, 'hull', [
    [-0.5, 3.61, -0.5],
    [30.5, 3.61, -0.5],
    [30.5, 3.61, 40.5],
    [-0.5, 3.61, 40.5],
  ]);
  model.quad(envelope, 'hull', [
    [-0.5, -0.01, 40.5],
    [30.5, -0.01, 40.5],
    [30.5, -0.01, -0.5],
    [-0.5, -0.01, -0.5],
  ]);
  const collision = {
    floorTiles: [],
    boundaryFaces: [],
    doorCells: [],
    source: 'Authoritative scene fps.floorplan',
    maxWallIntrusion: 0,
    floorHeight: 0,
    hullSeal: {
      floor: -0.01,
      ceiling: 3.61,
      x: [-0.5, 30.5],
      z: [-0.5, 40.5],
      purpose:
        'Continuous opaque hull behind detailed inner surfaces; closes grazing views through wall rebates at floor/ceiling junctions.',
    },
  };
  const room = (x, z) => rooms.get(roomAt(x, z));
  const windowCell = (x, z, dx, dz) => z === 39 && dz === 1 && dx === 0 && x >= 8 && x <= 21;

  function moduleAt(x, z, dx, dz) {
    if (x === 29 && dx === 1 && z >= 10 && z <= 18) return 'folded-medical-berth';
    if (z === 31 && dz === 1 && x >= 20 && x <= 28) return 'recorder-cassettes';
    if (x === 1 && dx === -1 && z >= 25 && z <= 30) return 'power-capacitors';
    if (x === 11 && dx === -1 && z >= 2 && z <= 5) return 'docking-insulation';
    if (x === 19 && dx === 1 && z >= 2 && z <= 6) return 'open-service-bay';
    if (x === 17 && dx === 1 && [10, 11, 16, 17, 23, 24, 29, 30].includes(z))
      return 'open-service-bay';
    if (x === 13 && dx === -1 && [12, 13, 20, 21, 31, 32].includes(z)) return 'open-service-bay';
    if (x === 1 && dx === -1 && z >= 10 && z <= 22 && z % 3 !== 0) return 'open-service-bay';
    return 'pressure-panel';
  }
  function recessedModule(node, type, cellIndex) {
    model.box(node, 'graphite', [0, 1.8, -0.45], [1, 3.6, 0.1]);
    for (const x of [-0.455, 0.455]) model.box(node, 'steel', [x, 1.8, -0.12], [0.06, 3.6, 0.22]);
    for (const y of [0.18, 3.4])
      model.box(node, 'graphite', [0, y, -0.15], [0.91, 0.2, 0.28], 0.014);
    model.box(node, 'ceramic', [0, 2.95, -0.08], [0.84, 0.42, 0.12], 0.025);
    if (type === 'folded-medical-berth') {
      model.box(node, 'steel', [0, 1.56, -0.23], [0.73, 2.18, 0.25], 0.042);
      for (const [y, h] of [
        [0.92, 0.67],
        [1.67, 0.73],
        [2.25, 0.29],
      ])
        model.box(node, 'padding', [0, y, -0.094], [0.6, h, 0.14], 0.045);
      for (const y of [0.69, 1.24, 2.13]) {
        model.box(node, 'fabric', [0, y, -0.016], [0.65, 0.043, 0.024], 0.004);
        model.box(node, 'steel', [0.17, y, -0.002], [0.055, 0.059, 0.004]);
      }
      for (const x of [-0.37, 0.37]) model.cylinder(node, 'steel', [x, 1.6, -0.07], 0.025, 1.94);
      model.sign(node, [0, 2.96, -0.012], 0.67, 0.13, 4);
      model.box(node, 'teal', [-0.25, 2.58, -0.031], [0.075, 0.016, 0.014]);
    } else if (type === 'recorder-cassettes') {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          const x = (col - 1) * 0.255,
            y = 0.64 + row * 0.4;
          model.box(node, 'graphite', [x, y, -0.15], [0.221, 0.34, 0.23], 0.009);
          model.box(node, 'satin', [x, y, -0.028], [0.16, 0.29, 0.018], 0.006);
          model.box(node, 'rubber', [x, y + 0.035, -0.014], [0.085, 0.13, 0.014], 0.004);
          model.box(node, 'steel', [x, y + 0.032, -0.004], [0.035, 0.103, 0.005]);
          model.box(
            node,
            row === cellIndex % 5 && col === 1 ? 'red' : 'ochre',
            [x - 0.054, y - 0.096, -0.015],
            [0.043, 0.018, 0.01],
          );
        }
      }
      model.sign(node, [0, 2.96, -0.012], 0.67, 0.13, 5);
    } else if (type === 'power-capacitors') {
      for (const x of [-0.27, 0, 0.27]) {
        model.cylinder(node, 'satin', [x, 1.58, -0.15], 0.116, 2.02, 'y', 0.094, 20);
        for (const y of [0.72, 1.0, 2.18, 2.44])
          model.torus(node, 'rubber', [x, y, -0.15], 0.114, 0.014, [Math.PI / 2, 0, 0], 20);
        model.cylinder(node, 'copper', [x, 2.69, -0.12], 0.03, 0.29);
      }
      model.box(node, 'copper', [0, 2.77, -0.13], [0.76, 0.032, 0.075]);
      model.sign(node, [0, 2.97, -0.012], 0.67, 0.13, 3);
      model.box(node, 'ochre', [0, 0.4, -0.026], [0.75, 0.16, 0.03]);
    } else if (type === 'docking-insulation') {
      for (let row = 0; row < 6; row++) {
        model.box(node, 'fabric', [0, 0.56 + row * 0.35, -0.15], [0.81, 0.3, 0.24], 0.061);
        model.box(node, 'steel', [0, 0.72 + row * 0.35, -0.087], [0.74, 0.025, 0.05]);
      }
      for (const x of [-0.29, 0.29])
        model.box(node, 'ochre', [x, 1.6, -0.031], [0.035, 2.41, 0.029]);
      model.sign(node, [0, 2.97, -0.012], 0.67, 0.13, 1);
    } else {
      for (let wire = 0; wire < 6; wire++) {
        const x = -0.32 + wire * 0.115;
        model.cable(
          node,
          wire % 3 === 0 ? 'copper' : 'rubber',
          [
            [x, 0.27, -0.2],
            [x, 0.8, -0.12],
            [x + 0.035, 1.6, -0.18],
            [x - 0.06, 2.2, -0.23],
            [x, 2.72, -0.2],
          ],
          0.022,
          16,
        );
      }
      for (const y of [0.53, 1.01, 1.87, 2.51])
        model.box(node, 'steel', [0, y, -0.083], [0.77, 0.042, 0.034]);
      model.box(node, 'graphite', [0.16, 1.38, -0.083], [0.37, 0.48, 0.14], 0.014);
      model.sign(node, [0.16, 1.51, -0.01], 0.3, 0.074, 12, 0, 'screen');
      for (let fuse = 0; fuse < 4; fuse++) {
        model.box(node, 'ceramic', [0.046 + fuse * 0.073, 1.3, -0.016], [0.045, 0.1, 0.023], 0.005);
        model.box(node, 'ochre', [0.046 + fuse * 0.073, 1.285, -0.003], [0.021, 0.022, 0.004]);
      }
      model.sign(node, [0, 2.97, -0.012], 0.67, 0.13, 2);
    }
  }
  function wall(node, x, z, dx, dz) {
    const angle = Math.atan2(-dx, -dz);
    const isWindow = windowCell(x, z, dx, dz);
    const seed = x * 37 + z * 11 + dx * 3 + dz;
    const previous = new Map(
      [...model.parts.entries()].map(([key, part]) => [key, part.positions.length]),
    );
    model.withTransform([x + dx * 0.5, 0, z + dz * 0.5], angle, () => {
      // Positive local Z is the walkable side. All rigid wall detail stays behind collision.
      if (isWindow) {
        model.box(node, 'graphite', [0, 0.38, -0.23], [1, 0.76, 0.46]);
        model.box(node, 'ceramic', [0, 0.42, -0.055], [0.91, 0.57, 0.07], 0.019);
        model.box(node, 'steel', [0, 0.79, -0.245], [1, 0.075, 0.49]);
        model.box(node, 'graphite', [0, 3.33, -0.2], [1, 0.54, 0.4]);
        if (x % 3 === 2 || x === 8 || x === 21) {
          model.box(node, 'graphite', [-0.44, 1.93, -0.26], [0.11, 2.3, 0.48], 0.015);
          model.box(node, 'steel', [-0.44, 1.93, -0.015], [0.041, 2.31, 0.027]);
        }
        return;
      }
      const machine = [
        [5, 7, 15, 18],
        [5, 7, 27, 28],
        [23, 25, 15, 16],
        [23, 25, 24, 26],
      ].some(
        ([minX, maxX, minZ, maxZ]) =>
          x + dx >= minX && x + dx <= maxX && z + dz >= minZ && z + dz <= maxZ,
      );
      const mount = MOUNTS.find(({ position, yaw }) => {
        const a = (yaw * Math.PI) / 180;
        return (
          Math.abs(Math.sin(a) + dx) < 0.001 &&
          Math.abs(Math.cos(a) + dz) < 0.001 &&
          Math.abs(position[0] - (x + dx * 0.45)) < 0.001 &&
          Math.abs(position[2] - (z + dz * 0.45)) < 0.001
        );
      });
      if (mount) {
        model.box(node, 'graphite', [0, 1.8, -0.46], [1, 3.6, 0.1]);
        for (const side of [-1, 1])
          model.box(node, 'steel', [side * 0.485, 1.8, -0.12], [0.025, 3.6, 0.22]);
        model.box(node, 'ceramic', [0, 2.79, -0.09], [0.87, 1.32, 0.13], 0.025);
        model.box(node, 'graphite', [0, 0.25, -0.13], [0.86, 0.5, 0.24]);
        model.box(node, 'steel', [0, 0.04, -0.031], [1, 0.08, 0.06]);
        model.features.push({
          type: 'interactive-recess',
          entity: mount.entity,
          cell: [x, z],
          face: [dx, dz],
          depth: 0.4,
          clearance: 'No ceramic pressure panel behind interactive front face',
        });
        return;
      }
      const module = moduleAt(x, z, dx, dz);
      if (!machine && module !== 'pressure-panel') {
        recessedModule(node, module, x + z);
        model.features.push({
          type: module,
          cell: [x, z],
          face: [dx, dz],
          collision: 'recessed entirely behind wall collision plane',
        });
        return;
      }
      model.box(node, 'graphite', [0, 1.8, -0.335], [1, 3.6, 0.37]);
      if (machine) {
        model.cylinder(node, 'satin', [0, 1.85, -0.25], 0.22, 2.92, 'y', 0.22, 16);
        for (const y of [0.55, 1.2, 2.65, 3.15]) {
          model.torus(node, 'graphite', [0, y, -0.25], 0.225, 0.021, [Math.PI / 2, 0, 0], 20);
          model.box(node, 'steel', [0, y, -0.027], [0.58, 0.046, 0.024]);
        }
        model.cylinder(node, 'copper', [-0.36, 1.8, -0.07], 0.044, 3.6, 'y', 0.044, 8);
        model.box(node, 'graphite', [0.44, 1.8, -0.05], [0.1, 3.6, 0.08]);
        model.box(node, 'ochre', [0, 2.12, -0.011], [0.35, 0.15, 0.014]);
        model.sign(node, [0, 2.12, -0.003], 0.34, 0.11, roomAt(x, z) === 'power' ? 3 : 10);
        return;
      }
      model.box(node, 'ceramic', [0, 1.7, -0.083], [0.858, 1.84, 0.118], 0.032);
      model.box(node, 'ceramic', [0, 2.88, -0.095], [0.856, 0.43, 0.09], 0.013);
      model.box(node, 'steel', [-0.465, 1.8, -0.032], [0.064, 3.6, 0.064]);
      model.box(node, 'rubber', [0.443, 1.8, -0.036], [0.018, 3.6, 0.032]);
      model.box(node, 'steel', [0, 0.125, -0.047], [1, 0.25, 0.092]);
      model.box(node, 'graphite', [0, 0.49, -0.05], [0.86, 0.37, 0.08]);
      for (let y = 0.37; y < 0.64; y += 0.043)
        model.box(node, 'steel', [0, y, -0.007], [0.75, 0.012, 0.012]);
      for (const x of [-0.375, 0.375]) {
        for (const y of [0.91, 2.47])
          model.cylinder(node, 'satin', [x, y, -0.013], 0.012, 0.013, 'z', 0.012, 6);
      }
      model.cylinder(node, 'steel', [0, 3.24, -0.105], 0.062, 1, 'x', 0.062, 8);
      model.cylinder(node, 'copper', [0, 3.41, -0.079], 0.037, 1, 'x', 0.037, 8);
      for (const x of [-0.33, 0.33])
        model.box(node, 'graphite', [x, 3.26, -0.025], [0.043, 0.28, 0.027]);
      if (Math.abs(seed) % 7 === 0) model.sign(node, [0, 1.12, -0.021], 0.58, 0.09, 0);
      if (Math.abs(seed) % 11 === 0) {
        model.box(node, 'ochre', [0.21, 2.08, -0.019], [0.028, 0.38, 0.018]);
        model.sign(node, [0, 2.16, -0.017], 0.34, 0.062, 3);
      }
    });
    for (const [key, part] of model.parts) {
      for (let i = previous.get(key) ?? 0; i < part.positions.length; i += 3) {
        const intrusion =
          (part.positions[i] - x - dx * 0.5) * -dx + (part.positions[i + 2] - z - dz * 0.5) * -dz;
        collision.maxWallIntrusion = Math.max(collision.maxWallIntrusion, intrusion);
        if (intrusion > 0.00001)
          throw new Error(
            `Wall detail intrudes into traversable space at ${x},${z}: ${intrusion}m`,
          );
      }
    }
    collision.boundaryFaces.push({
      cell: [x, z],
      adjacentSolid: [x + dx, z + dz],
      plane: dx ? { x: x + dx * 0.5 } : { z: z + dz * 0.5 },
      window: isWindow,
    });
  }
  for (let z = 0; z < grid.height; z++) {
    for (let x = 0; x < grid.width; x++) {
      const definition = cell(x, z);
      if (!definition) throw new Error(`Undefined legend at ${x},${z}`);
      if (!open(x, z)) continue;
      if (definition.floor !== 0 || definition.ceil !== 3.6)
        throw new Error('Changed floor/ceiling contract');
      const node = room(x, z);
      collision.floorTiles.push([x, z]);
      if (definition.door) collision.doorCells.push([x, z]);
      model.quad(node, 'deck', [
        [x - 0.5, 0, z + 0.5],
        [x + 0.5, 0, z + 0.5],
        [x + 0.5, 0, z - 0.5],
        [x - 0.5, 0, z - 0.5],
      ]);
      model.quad(node, 'graphite', [
        [x - 0.5, 3.6, z - 0.5],
        [x + 0.5, 3.6, z - 0.5],
        [x + 0.5, 3.6, z + 0.5],
        [x - 0.5, 3.6, z + 0.5],
      ]);
      if (x % 3 === 0 && z % 3 === 0) {
        model.box(node, 'steel', [x, 3.57, z], [0.035, 0.06, 1]);
        model.box(node, 'graphite', [x, 3.54, z], [0.68, 0.045, 0.76]);
        for (let stripe = 0; stripe < 6; stripe++)
          model.box(node, 'steel', [x - 0.28 + stripe * 0.11, 3.513, z], [0.015, 0.01, 0.67]);
      }
      if (definition.door) continue;
      for (const [dx, dz] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        if (cell(x + dx, z + dz)?.solid && !cell(x + dx, z + dz)?.door) wall(node, x, z, dx, dz);
      }
    }
  }

  function plaque(position, angle, row, width = 2.4) {
    const node = room(position[0], position[2]);
    model.withTransform(position, angle, () => {
      model.box(node, 'steel', [0, 0, -0.06], [width + 0.08, 0.37, 0.09], 0.014);
      model.sign(node, [0, 0, -0.008], width, 0.29, row);
    });
  }
  plaque([15, 2.55, 0.505], 0, 1, 3.3);
  plaque([0.505, 2.6, 12], Math.PI / 2, 2);
  plaque([6, 2.8, 31.495], Math.PI, 3, 3.2);
  plaque([29.495, 2.5, 16], -Math.PI / 2, 4);
  plaque([24, 2.65, 31.495], Math.PI, 5, 3.1);
  plaque([7, 2.8, 34.505], 0, 6, 2.6);
  plaque([27, 2.7, 39.495], Math.PI, 7, 3.5);

  for (const light of LIGHTS) {
    const [x, , z] = light.position,
      node = room(x, z);
    model.box(node, 'graphite', [x, 3.51, z], [2.1, 0.13, 0.57], 0.018);
    model.box(node, 'steel', [x, 3.44, z], [1.91, 0.027, 0.41]);
    model.box(
      node,
      light.id.includes('infirmary') ? 'teal' : 'warm',
      [x, 3.416, z],
      [1.72, 0.015, 0.26],
    );
    for (let offset = -0.8; offset <= 0.8; offset += 0.2)
      model.box(node, 'graphite', [x + offset, 3.4, z], [0.018, 0.028, 0.3]);
  }

  // Overhead infrastructure stays above the capsule; machine mass occupies existing solid cells.
  for (let z = 10; z <= 33; z += 3) {
    const node = rooms.get('spine');
    model.box(node, 'graphite', [15, 3.49, z], [4.93, 0.21, 0.18], 0.015);
    for (const x of [13.45, 16.55]) {
      model.cylinder(node, 'steel', [x, 3.36, z], 0.1, 3, 'z', 0.1, 12);
      model.cylinder(node, 'copper', [x + 0.18, 3.34, z], 0.035, 3, 'z', 0.035, 8);
      model.box(node, 'ochre', [x, 3.29, z], [0.24, 0.04, 0.05]);
    }
    for (const z of [9, 15, 21, 27, 33]) {
      const node = rooms.get('spine');
      model.box(node, 'steel', [15, 3.42, z], [4.98, 0.18, 0.27], 0.025);
      for (const side of [-1, 1]) {
        model.box(node, 'graphite', [15 + side * 2.1, 3.1, z], [0.82, 0.24, 0.36], 0.03, [
          0,
          0,
          side * 0.73,
        ]);
        model.box(node, 'ceramic', [15 + side * 1.7, 3.35, z], [0.65, 0.1, 0.39], 0.022);
        model.box(node, 'ochre', [15 + side * 2.13, 3.07, z - 0.191], [0.34, 0.027, 0.011], 0, [
          0,
          0,
          side * 0.73,
        ]);
      }
    }
    for (const [centerX, z, width, sector] of [
      [15, 4, 8.8, 'ingress'],
      [6, 26, 10.8, 'power'],
      [24, 22, 10.8, 'archive'],
      [14, 36, 18.8, 'observation'],
    ]) {
      const node = rooms.get(sector);
      model.box(node, 'graphite', [centerX, 3.48, z], [width, 0.2, 0.42], 0.025);
      model.box(node, 'satin', [centerX, 3.355, z], [width - 0.05, 0.025, 0.28]);
      for (const side of [-1, 1]) {
        model.box(
          node,
          'graphite',
          [centerX + side * (width / 2 - 0.38), 3.08, z],
          [0.97, 0.23, 0.42],
          0.025,
          [0, 0, side * 0.71],
        );
      }
    }
    const cableRoutes = [
      {
        sector: 'ingress',
        points: [
          [18.6, 3.42, 1.5],
          [18.4, 3.13, 4],
          [18.6, 3.4, 7],
        ],
        wires: 4,
      },
      {
        sector: 'maintenance',
        points: [
          [1.4, 3.3, 10],
          [2.1, 2.97, 13],
          [1.8, 3.16, 18],
          [1.3, 3.35, 23],
        ],
        wires: 5,
      },
      {
        sector: 'power',
        points: [
          [1.6, 3.33, 30],
          [4, 3.02, 29.8],
          [7, 3.2, 30.2],
          [10.7, 3.4, 30],
        ],
        wires: 6,
      },
    ];
    for (const route of cableRoutes) {
      for (let wire = 0; wire < route.wires; wire++) {
        model.cable(
          rooms.get(route.sector),
          wire === 1 ? 'copper' : 'rubber',
          route.points.map(([x, y, z]) => [x + wire * 0.052, y, z]),
          0.021,
          28,
        );
      }
      model.features.push({
        type: 'overhead-contained-cable-loom',
        ...route,
        minimumClearance: 2.9,
      });
    }
  }
  const machinery = [
    { center: [6, 0, 16.5], size: [3, 3.6, 4], sector: 'maintenance', type: 'coolant' },
    { center: [6, 0, 27.5], size: [3, 3.6, 2], sector: 'power', type: 'transformer' },
    { center: [24, 0, 15.5], size: [3, 3.6, 2], sector: 'infirmary', type: 'medical-services' },
    { center: [24, 0, 25], size: [3, 3.6, 3], sector: 'archive', type: 'recorder-bank' },
  ];
  for (const fixture of machinery) {
    const [x, , z] = fixture.center,
      node = rooms.get(fixture.sector);
    model.box(node, 'graphite', [x, 1.8, z], [fixture.size[0] - 0.7, 3.6, fixture.size[2] - 0.7]);
    for (let i = -1; i <= 1; i++) {
      model.cylinder(node, 'satin', [x + i * 0.81, 1.8, z], 0.32, 3.45, 'y', 0.32, 16);
      for (const y of [0.5, 1.3, 2.6, 3.2])
        model.torus(node, 'graphite', [x + i * 0.81, y, z], 0.33, 0.05, [Math.PI / 2, 0, 0], 16);
    }
    model.features.push({
      id: fixture.type,
      collision: 'entire fixture contained in existing solid cells',
      ...fixture,
    });
  }
  // Different insets replace selected wall sections, not walkable-space furniture.
  for (const [x, z, type, angle] of [
    [10, 0.51, 'docking', 0],
    [0.51, 21, 'utility', Math.PI / 2],
    [29.49, 12, 'medical', -Math.PI / 2],
    [28, 31.49, 'archive', Math.PI],
  ]) {
    if (type === 'docking') continue;
    const node = room(x, z);
    model.withTransform([x, 0, z], angle, () => {
      model.box(node, 'steel', [0, 1.6, -0.1], [0.8, 2.1, 0.18], 0.028);
      for (let row = 0; row < 6; row++) {
        model.box(node, 'graphite', [0, 0.8 + row * 0.26, -0.002], [0.7, 0.18, 0.014]);
        model.box(
          node,
          row === 1 ? 'red' : 'teal',
          [0.25, 0.8 + row * 0.26, 0.007],
          [0.023, 0.014, 0.006],
        );
      }
      model.sign(
        node,
        [0, 2.42, 0.002],
        0.65,
        0.115,
        type === 'medical' ? 4 : type === 'archive' ? 5 : 2,
      );
    });
  }

  // Flush deck wayfinding is visual only and does not add a traversable obstacle.
  for (const [x, z, angle] of [
    [15, 7, 0],
    [15, 16, 0],
    [15, 27, 0],
    [6, 22, 0],
    [24, 18, 0],
    [23, 37, -Math.PI / 2],
  ]) {
    const node = room(x, z);
    model.withTransform([x, 0.004, z], angle, () => {
      model.box(node, 'ochre', [0, 0, 0], [0.1, 0.003, 1.0]);
      model.box(node, 'ochre', [-0.13, 0, 0.3], [0.1, 0.003, 0.4], 0, [0, -0.75, 0]);
      model.box(node, 'ochre', [0.13, 0, 0.3], [0.1, 0.003, 0.4], 0, [0, 0.75, 0]);
    });
  }
  return { model, collision, rooms: ROOMS };
}

export function exteriorModel() {
  const model = new Model('meridian-orbital-exterior', MATERIALS);
  const planet = model.node('pale-gas-giant', 0, [7, 4, 700]);
  model.add(planet, 'planet', new SphereGeometry(360, 96, 64), [0, 0, 0], [0.14, 2.1, -0.21]);
  model.add(planet, 'ring-density', ringGeometry(), [0, 0, 0], RING_ROTATION);
  const spars = model.node('external-antenna-array');
  for (const side of [-1, 1]) {
    const x = side < 0 ? -2 : 33;
    model.box(spars, 'graphite', [x, -1, 53], [0.7, 0.7, 23], 0.08);
    for (let z = 44; z < 63; z += 3) {
      model.box(spars, 'steel', [x, 2, z], [0.22, 6, 0.22]);
      model.box(spars, 'graphite', [x, 4.8, z], [5, 0.17, 2.3]);
      for (let strip = -2; strip <= 2; strip++)
        model.box(spars, 'visor', [x + strip * 0.85, 4.9, z], [0.8, 0.02, 2.12]);
    }
  }
  const stars = model.node('distant-star-field');
  for (let i = 0; i < 160; i++) {
    const x = (noise(i, 0, 280) - 0.5) * 1800;
    const y = (noise(i, 1, 280) - 0.5) * 950;
    const size = 0.073 + noise(i, 2, 280) ** 6 * 0.28;
    model.quad(stars, 'star', [
      [x + size, y - size, 970],
      [x - size, y - size, 970],
      [x - size, y + size, 970],
      [x + size, y + size, 970],
    ]);
  }
  return model;
}

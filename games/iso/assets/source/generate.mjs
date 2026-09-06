import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { audio } from './audio.mjs';
import { Model, rgb } from './mesh.mjs';
import { textures } from './textures.mjs';

const P = {
  ink: rgb('#142333'),
  steel: rgb('#526e7d'),
  edge: rgb('#9eb8bf'),
  light: rgb('#d1dcdb'),
  teal: rgb('#256573'),
  rust: rgb('#a7513b'),
  brass: rgb('#c99355'),
  dark: rgb('#0a141e'),
  white: [1, 1, 1],
};
const quaternion = (axis, angle) => {
  const q = [0, 0, 0, Math.cos(angle / 2)];
  q[axis] = Math.sin(angle / 2);
  return q;
};

function actorClips(model, parts, guard) {
  const times = Array.from({ length: 9 }, (_, i) => i / 8);
  const rotate = (node, values, duration = 1, axis = 0) => ({
    node,
    path: 'rotation',
    times: times.map((t) => t * duration),
    values: values.map((angle) => quaternion(axis, angle)),
  });
  const wave = times.map((t) => Math.sin(t * Math.PI * 2));
  model.animation('idle', [
    rotate(
      parts.head,
      wave.map((v) => v * (guard ? 0.16 : 0.055)),
      2,
      1,
    ),
    {
      node: parts.torso,
      path: 'translation',
      times: times.map((t) => t * 2),
      values: wave.map((v) => [0, 0.68 + v * 0.008, 0]),
    },
  ]);
  model.animation('walk', [
    rotate(
      parts.leftLeg,
      wave.map((v) => v * 0.42),
    ),
    rotate(
      parts.rightLeg,
      wave.map((v) => -v * 0.42),
    ),
    rotate(
      parts.leftArm,
      wave.map((v) => -v * 0.18),
    ),
    rotate(
      parts.rightArm,
      wave.map((v) => v * 0.12),
    ),
  ]);
  model.animation('attack', [
    rotate(
      parts.rightArm,
      wave.map((v) => -Math.max(0, v) * 0.22),
      0.28,
    ),
    rotate(
      parts.torso,
      wave.map((v) => -Math.max(0, v) * 0.09),
      0.28,
    ),
  ]);
  model.animation('death', [
    rotate(
      0,
      times.map((t) => -t * 1.42),
      0.6,
      2,
    ),
    {
      node: 0,
      path: 'translation',
      times: times.map((t) => t * 0.6),
      values: times.map((t) => [t * 0.18, t * 0.15, 0]),
    },
  ]);
}

function actor(guard) {
  const model = new Model(guard ? 'Bastion security sentinel' : 'Lancer vault operative');
  const glow = model.glow(
    guard ? 'Amber targeting optics' : 'Cyan visor and telemetry',
    guard ? '#ffc17b' : '#72eee7',
  );
  const armor = guard ? P.rust : P.teal;
  const torso = model.part('torso', [0, 0.68, 0]);
  torso.shape.bevel([0, 0.13, 0], [guard ? 0.48 : 0.35, 0.32, 0.25], 0.045, armor);
  torso.shape.bevel([0, 0.17, 0.127], [0.25, 0.19, 0.06], 0.024, guard ? P.brass : P.edge);
  torso.shape.box([0, 0.19, 0.16], [0.04, 0.13, 0.009], P.white, glow);
  torso.shape.bevel([0, -0.09, 0], [0.25, 0.15, 0.2], 0.025, P.ink);
  torso.shape.box([0, -0.035, 0.095], [0.29, 0.052, 0.045], P.steel);
  torso.shape.bevel([0, 0.13, -0.16], [guard ? 0.31 : 0.23, 0.25, 0.13], 0.025, P.ink);
  for (const x of [-0.075, 0.075]) {
    torso.shape.box([x, 0.17, -0.23], [0.025, 0.16, 0.014], P.white, glow);
  }
  if (!guard) {
    torso.shape.bevel([-0.2, 0.04, 0], [0.09, 0.24, 0.2], 0.016, P.light);
    torso.shape.box([0.12, -0.01, 0.13], [0.074, 0.096, 0.06], P.ink);
  }
  const head = model.part('head', [0, 0.97, 0]);
  head.shape.prism([0, -0.005, 0], 0.085, 0.065, P.dark, 0, 8);
  head.shape.bevel(
    [0, 0.105, 0],
    [guard ? 0.29 : 0.245, 0.235, 0.245],
    0.045,
    guard ? P.ink : P.light,
  );
  head.shape.bevel([0, 0.105, 0.12], [0.23, 0.09, 0.055], 0.016, P.dark);
  head.shape.box(
    [0, 0.12, 0.151],
    [guard ? 0.09 : 0.2, guard ? 0.055 : 0.026, 0.012],
    P.white,
    glow,
  );
  head.shape.bevel([0, 0.03, 0.115], [0.155, 0.075, 0.07], 0.016, P.steel);
  head.shape.box([0.13, 0.12, -0.02], [0.028, guard ? 0.13 : 0.19, 0.06], armor);
  if (guard) {
    head.shape.bevel([0, 0.22, -0.015], [0.15, 0.055, 0.22], 0.012, P.brass);
  }
  const limbs = {};
  for (const sign of [-1, 1]) {
    const side = sign < 0 ? 'left' : 'right';
    const arm = model.part(`arm-${side}`, [sign * (guard ? 0.31 : 0.25), 0.87, 0]);
    arm.shape.bevel([0, -0.025, 0], [guard ? 0.19 : 0.13, 0.19, 0.22], 0.03, armor);
    arm.shape.box([sign * 0.045, 0.027, 0.075], [0.065, 0.02, 0.025], P.white, glow);
    arm.shape.bevel([0, -0.18, 0.035], [0.1, 0.18, 0.115], 0.02, P.ink);
    arm.shape.bevel([0, -0.29, 0.055], [0.115, 0.12, 0.145], 0.018, P.steel);
    const leg = model.part(`leg-${side}`, [sign * 0.115, 0.54, 0]);
    leg.shape.bevel([0, -0.115, 0], [0.135, 0.23, 0.17], 0.025, guard ? P.ink : P.teal);
    leg.shape.bevel([0, -0.225, 0.078], [0.15, 0.105, 0.065], 0.018, guard ? P.brass : P.edge);
    leg.shape.bevel([0, -0.335, -0.015], [0.13, 0.2, 0.145], 0.018, P.steel);
    leg.shape.bevel([0, -0.478, 0.045], [0.16, 0.12, 0.27], 0.024, P.ink);
    leg.shape.box([0, -0.416, 0.09], [0.085, 0.02, 0.04], guard ? P.rust : P.light);
    limbs[sign < 0 ? 'leftArm' : 'rightArm'] = arm.index;
    limbs[sign < 0 ? 'leftLeg' : 'rightLeg'] = leg.index;
    if (sign > 0) {
      const weapon = model.part('weapon', [0, -0.255, 0.12], arm.index);
      weapon.shape.bevel([0, 0.04, 0.105], [0.095, 0.13, 0.35], 0.02, P.ink);
      weapon.shape.box([0, 0.115, 0.08], [0.034, 0.026, 0.16], P.edge);
      weapon.shape.box([0, 0.03, 0.29], [0.06, 0.06, 0.05], P.steel);
      weapon.shape.box([0, 0.03, 0.316], [0.026, 0.026, 0.004], P.white, glow);
    }
  }
  actorClips(model, { torso: torso.index, head: head.index, ...limbs }, guard);
  return model.encode();
}

function rack() {
  const model = new Model('Rear-perimeter server rack');
  const face = model.texture('Seven service bays', 'server-face.png', 'server-emission.png');
  const glow = model.glow('Rack telemetry', '#59bfd4', 0.65);
  const rack = model.part('rack').shape;
  rack.bevel([0, 0.045, 0], [0.87, 0.09, 0.72], 0.025, P.ink);
  rack.bevel([0, 0.86, 0], [0.8, 1.66, 0.64], 0.055, P.steel);
  rack.box([0, 0.88, 0.326], [0.67, 1.49, 0.024], P.dark);
  rack.face(
    [
      [-0.325, 0.14, 0.341],
      [0.325, 0.14, 0.341],
      [0.325, 1.61, 0.341],
      [-0.325, 1.61, 0.341],
    ],
    P.white,
    face,
    [0, 0, 1],
  );
  rack.bevel([0, 1.72, 0], [0.72, 0.095, 0.57], 0.028, P.ink);
  rack.box([0, 1.738, 0.296], [0.56, 0.014, 0.013], P.white, glow);
  for (const x of [-0.18, 0.18]) {
    rack.prism([x, 1.78, -0.02], 0.105, 0.022, P.dark, 0, 12);
    rack.prism([x, 1.794, -0.02], 0.055, 0.01, P.steel, 0, 8);
  }
  return model.encode();
}

function consoleModel() {
  const model = new Model('Access control pedestal');
  const screen = model.texture(
    'Locked access screen',
    'terminal-locked.png',
    'terminal-locked.png',
  );
  const glow = model.glow('Console status', '#ffc777');
  const base = model.part('console').shape;
  base.bevel([0, 0.055, 0], [0.49, 0.11, 0.36], 0.035, P.ink);
  base.bevel([0, 0.255, -0.065], [0.25, 0.35, 0.18], 0.03, P.steel);
  base.box([0, 0.245, 0.031], [0.045, 0.22, 0.014], P.white, glow);
  const display = model.part('screen', [0, 0.48, -0.025]);
  display.shape.bevel([0, 0, 0], [0.52, 0.105, 0.36], 0.025, P.ink);
  display.shape.face(
    [
      [-0.226, 0.055, 0.14],
      [0.226, 0.055, 0.14],
      [0.226, 0.055, -0.14],
      [-0.226, 0.055, -0.14],
    ],
    P.white,
    screen,
    [0, 1, 0],
  );
  model.nodes[display.index].rotation = quaternion(0, 0.44);
  return model.encode();
}

function door() {
  const model = new Model('Retracting security shutter');
  const glow = model.glow('Sealed door warning', '#f8b966');
  const frame = model.part('frame').shape;
  frame.bevel([0, 0.025, 0], [0.98, 0.05, 0.88], 0.014, P.ink);
  for (const sign of [-1, 1]) {
    frame.bevel([sign * 0.438, 0.22, 0], [0.104, 0.42, 0.36], 0.016, P.steel);
    frame.box([sign * 0.442, 0.428, 0], [0.07, 0.008, 0.27], P.white, glow);
    const leaf = model.part(sign < 0 ? 'leaf-left' : 'leaf-right', [sign * 0.197, 0, 0]);
    leaf.shape.bevel([0, 0.208, 0], [0.385, 0.366, 0.26], 0.028, P.brass);
    leaf.shape.bevel([0, 0.208, 0.136], [0.3, 0.275, 0.024], 0.008, P.ink);
    for (let y = 0.095; y < 0.345; y += 0.085) {
      leaf.shape.box([sign * 0.066, y, 0.153], [0.14, 0.034, 0.012], P.brass);
    }
    leaf.shape.box([-sign * 0.173, 0.21, 0.15], [0.018, 0.26, 0.01], P.white, glow);
  }
  return model.encode();
}

function extraction() {
  const model = new Model('Data extraction uplink');
  const glow = model.glow('Uplink cyan', '#6de4df');
  const pad = model.part('pad').shape;
  pad.prism([0, 0.025, 0], 0.44, 0.05, P.ink, 0, 16);
  pad.prism([0, 0.058, 0], 0.37, 0.028, P.steel, 0, 16, 0.3);
  pad.prism([0, 0.077, 0], 0.31, 0.015, P.white, glow, 24, 0.29);
  pad.prism([0, 0.06, 0], 0.235, 0.05, P.teal, 0, 8);
  for (const [x, z] of [
    [-0.3, -0.3],
    [0.3, -0.3],
    [-0.3, 0.3],
    [0.3, 0.3],
  ]) {
    pad.bevel([x, 0.11, z], [0.105, 0.17, 0.105], 0.018, P.edge);
    pad.box([x, 0.2, z], [0.065, 0.014, 0.065], P.white, glow);
  }
  return model.encode();
}

function partition() {
  const model = new Model('Low tactical service partition');
  const surface = model.texture('Vented composite service panel', 'partition-panel.png');
  const body = model.part('partition').shape;
  body.bevel([0, 0.205, 0], [1, 0.41, 1], 0.055, P.steel);
  body.box([0, 0.416, 0], [0.81, 0.012, 0.81], P.dark);
  body.face(
    [
      [-0.397, 0.425, 0.397],
      [0.397, 0.425, 0.397],
      [0.397, 0.425, -0.397],
      [-0.397, 0.425, -0.397],
    ],
    P.white,
    surface,
    [0, 1, 0],
  );
  for (const sign of [-1, 1]) {
    body.box([sign * 0.493, 0.09, 0], [0.012, 0.036, 0.77], P.ink);
    body.box([0, 0.09, sign * 0.493], [0.77, 0.036, 0.012], P.ink);
  }
  return model.encode();
}

const ICONS = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="64" viewBox="0 0 256 64">
  <g fill="none" stroke="#a6e6e1" stroke-width="2.5" stroke-linejoin="round">
    <path d="M20 13h24l8 10v22l-20 9-20-9V23zM20 26h24v12H20zM26 32h12"/>
    <path d="M84 12h24l8 8v31H76V20zM86 30h20v13H86zM90 30v-7a6 6 0 0 1 12 0v7"/>
    <path d="M141 16h38v26h-38zM150 50h20M160 42v8M147 22h26M147 29h12M147 35h21"/>
    <path d="M202 42l22 12 22-12V22l-22-12-22 12zM224 19v24M215 34l9 9 9-9"/>
  </g>
</svg>
`;

export function buildAssets() {
  const files = new Map([...textures(), ...audio()]);
  const models = new Map([
    ['operative.gltf', actor(false)],
    ['sentinel.gltf', actor(true)],
    ['server-rack.gltf', rack()],
    ['access-console.gltf', consoleModel()],
    ['vault-door.gltf', door()],
    ['extraction-pad.gltf', extraction()],
    ['service-partition.gltf', partition()],
  ]);
  for (const [name, model] of models)
    files.set(name, Buffer.from(`${JSON.stringify(model, null, 2)}\n`));
  files.set('vault-icons.svg', Buffer.from(ICONS));
  const manifest = {
    aegis: 'asset-provenance/1',
    name: 'Server Vault original diorama kit',
    author: 'Aegis contributors',
    license: 'MIT',
    source: 'source/generate.mjs',
    recipe: 'node games/iso/assets/source/generate.mjs',
    conventions: {
      units: 'navigation cells',
      up: '+Y',
      forward: '+Z',
      origin: 'feet for actors, ground centre for props',
      interiorWallCeiling: 0.45,
      tallEquipmentPlacement: 'Rear perimeter only; never in front of a passable cell.',
    },
    assets: [...files].map(([file, bytes]) => ({
      file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(models.has(file) ? models.get(file).extras : {}),
    })),
  };
  files.set('provenance.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

export async function writeAssets(output = fileURLToPath(new URL('../', import.meta.url))) {
  const files = buildAssets();
  await mkdir(output, { recursive: true });
  for (const [name, bytes] of files) await writeFile(join(output, name), bytes);
  return {
    files: files.size,
    bytes: [...files.values()].reduce((sum, file) => sum + file.length, 0),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]
    ? resolve(process.argv[2])
    : join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await writeAssets(output);
  process.stdout.write(
    `Server Vault: ${result.files} original assets, ${result.bytes} bytes -> ${output}\n`,
  );
}

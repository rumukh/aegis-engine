import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { exteriorModel } from './lib/facility.mjs';

// A separate presentation set: no gameplay geometry or previously accepted asset is rebuilt.
const model = exteriorModel();
model.name = 'null-meridian-departure';
model.materials = {
  ...model.materials,
  'ending-hull': { ...model.materials.ceramic, color: [0.4, 0.44, 0.46, 1] },
};
const station = model.node('station-pressure-hull');
for (const [x, z, width, length] of [
  [15, 4, 10, 10],
  [6, 17, 13, 16],
  [6, 28, 13, 8],
  [15, 21, 6, 26],
  [24, 15, 13, 12],
  [24, 26, 13, 12],
  [13, 37, 20, 6],
]) {
  model.box(station, 'graphite', [x, 1.7, z], [width, 4.2, length], 0.18);
  model.box(station, 'ending-hull', [x, 3.84, z], [width - 0.6, 0.2, length - 0.6], 0.08);
  for (let offset = -length / 2 + 1; offset < length / 2; offset += 2.5) {
    model.box(station, 'steel', [x, 4.01, z + offset], [width - 0.3, 0.16, 0.12]);
    for (const side of [-1, 1])
      model.box(
        station,
        'satin',
        [x + side * (width / 2 + 0.02), 1.7, z + offset],
        [0.15, 4, 0.16],
      );
  }
  for (const [x, z] of [
    [6, 16],
    [6, 28],
    [24, 14],
    [24, 26],
  ]) {
    model.box(station, 'graphite', [x, 4.4, z], [5, 0.9, 3], 0.2);
    model.box(station, 'steel', [x, 4.86, z], [4.7, 0.06, 2.7], 0.08);
    for (let offset = -2; offset <= 2; offset += 0.24)
      model.box(station, 'rubber', [x + offset, 4.91, z], [0.12, 0.045, 2.5]);
    for (const side of [-1, 1]) {
      model.cylinder(station, 'steel', [x + side * 3.5, 4.2, z], 0.3, 5, 'z', 0.3);
      for (const dz of [-1.9, 0, 1.9])
        model.torus(station, 'ochre', [x + side * 3.5, 4.2, z + dz], 0.31, 0.04);
    }
  }
  for (const x of [13.7, 16.3])
    model.cylinder(station, 'steel', [x, 4.35, 21], 0.18, 26, 'z', 0.18, 12);
}
for (const z of [8, 15, 22, 29, 36]) {
  model.box(station, 'rubber', [31.01, 2, z], [0.15, 1.1, 2.1], 0.04);
  model.box(station, 'warm', [31.1, 2.45, z], [0.03, 0.08, 1.7]);
}
for (const x of [5, 9, 13, 17, 21]) {
  model.box(station, 'visor', [x, 1.8, 40.05], [3.6, 2.1, 0.12], 0.08);
  model.box(station, 'warm', [x, 3.01, 40.13], [3.8, 0.055, 0.05]);
}
model.withTransform([31.1, 1.9, 25], Math.PI / 2, () => model.sign(station, [0, 0, 0], 7, 0.5, 0));
const collar = model.node('evacuation-docking-collar', 0, [24, 1.8, 37]);
model.torus(collar, 'steel', [0, 0, 0], 2.15, 0.3, [0, Math.PI / 2, 0], 32);
model.torus(collar, 'rubber', [0.55, 0, 0], 2, 0.12, [0, Math.PI / 2, 0], 32);

const capsule = model.node('independent-capsule', 0, [28, 0, 37]);
model.box(capsule, 'graphite', [0, -0.25, 0], [7, 0.65, 5.6], 0.14);
model.box(capsule, 'deck', [0, 0.09, 0], [6.5, 0.08, 5.15]);
model.box(capsule, 'ceramic', [0, 3.85, 0], [6.8, 0.4, 5.6], 0.14);
for (const side of [-1, 1]) {
  model.box(capsule, 'ceramic', [0, 1.8, side * 2.7], [6.8, 3.8, 0.3], 0.12);
  model.box(capsule, 'graphite', [0, 1.75, side * 2.52], [6.3, 1.5, 0.1], 0.04);
  model.box(capsule, 'warm', [0, 3.35, side * 2.48], [5.5, 0.055, 0.07]);
  model.box(capsule, 'ochre', [0, 0.75, side * 2.88], [6.3, 0.12, 0.08]);
  for (const x of [-2.6, 0, 2.6])
    model.box(capsule, 'steel', [x, 1.85, side * 2.88], [0.14, 3.7, 0.12]);
}
model.box(capsule, 'ceramic', [3.45, 1.8, 0], [0.3, 3.8, 5.6], 0.12);
model.box(capsule, 'visor', [3.64, 2.05, 0], [0.08, 1.6, 3.2], 0.06);
model.cylinder(capsule, 'ceramic', [3.95, 1.8, 0], 1.85, 1.2, 'x', 2.7, 8);
model.cylinder(capsule, 'steel', [4.58, 1.8, 0], 1.35, 0.13, 'x', 1.35, 24);
model.cylinder(capsule, 'visor', [4.66, 1.8, 0], 1.14, 0.06, 'x', 1.14, 24);
model.torus(capsule, 'ochre', [4.71, 1.8, 0], 1.19, 0.025, [0, Math.PI / 2, 0], 24);
for (const side of [-1, 1]) {
  model.box(capsule, 'graphite', [-0.2, 4.1, side * 1.4], [4.5, 0.3, 0.48], 0.12);
  model.box(capsule, 'ochre', [-0.2, 4.27, side * 1.4], [3.9, 0.03, 0.18]);
  for (const x of [-2.4, 2.2]) {
    model.sphere(capsule, 'steel', [x, 3.4, side * 2.8], [0.35, 0.35, 0.35], 12, 8);
    model.cylinder(capsule, 'rubber', [x, 3.4, side * 3.1], 0.16, 0.3, 'z', 0.12, 12);
  }
}
model.sign(capsule, [0, 2, -2.92], 3.6, 0.32, 7, Math.PI);
model.box(capsule, 'steel', [-3.4, 3.3, 0], [0.4, 1, 5.6], 0.04);
for (const side of [-1, 1])
  model.box(capsule, 'steel', [-3.4, 1.4, side * 2.22], [0.4, 2.8, 1.15], 0.04);
model.withTransform([0, 0, 0], Math.PI / 2, () => {
  model.sign(capsule, [0, 3.24, -3.15], 2.9, 0.27, 15);
});
for (const side of [-1, 1]) {
  const leaf = model.node(`hatch-${side < 0 ? 'left' : 'right'}`, capsule, [0, 0, side * 1.6]);
  model.box(leaf, 'ceramic', [-3.36, 1.52, side * 0.78], [0.2, 2.9, 1.54], 0.04);
  model.box(leaf, 'steel', [-3.23, 1.52, side * 0.05], [0.06, 2.9, 0.09]);
  model.box(leaf, 'ochre', [-3.2, 1.05, side * 0.78], [0.05, 0.09, 1.4]);
  model.features.push({ hatchNode: leaf, side });
}
const recorder = model.node('secured-crew-recorder', capsule, [-2.3, 0.6, -1.7]);
model.box(recorder, 'ochre', [0, 0, 0], [0.65, 0.4, 0.9], 0.08);
model.box(recorder, 'rubber', [0, 0.22, 0], [0.12, 0.08, 0.96]);
model.box(recorder, 'teal', [0.34, 0.04, 0], [0.025, 0.06, 0.34]);
const exhaust = model.node('departure-thrusters', capsule, [-3.9, 0, 0]);
for (const z of [-1.7, 1.7]) {
  model.cylinder(capsule, 'graphite', [-3.5, -0.3, z], 0.36, 0.8, 'x', 0.25);
  model.cylinder(exhaust, 'teal', [-0.5, -0.3, z], 0.04, 1, 'x', 0.22, 12);
}

const eye = model.node('ending-eye', 0, [29.2, 1.8, 37]);
const target = model.node('ending-target', 0, [24.5, 1.5, 37]);
const tracks = model.features
  .filter((feature) => feature.hatchNode !== undefined)
  .map(({ hatchNode, side }) => ({
    node: hatchNode,
    path: 'translation',
    times: [0, 0.35, 2.2, 18],
    values: [
      [0, 0, side * 1.6],
      [0, 0, side * 1.6],
      [0, 0, 0],
      [0, 0, 0],
    ],
  }));
tracks.push(
  {
    node: capsule,
    path: 'translation',
    times: [0, 3.6, 6, 10, 16, 18],
    values: [
      [28, 0, 37],
      [28, 0, 37],
      [31, 0.3, 39],
      [45, 2, 46],
      [78, 6, 65],
      [92, 8, 74],
    ],
  },
  {
    node: exhaust,
    path: 'scale',
    times: [0, 3.6, 4, 6, 12, 16, 18],
    values: [
      [0, 0, 0],
      [0, 0, 0],
      [1, 1, 1],
      [1.5, 1, 1],
      [1.2, 1, 1],
      [0.5, 1, 1],
      [0.3, 1, 1],
    ],
  },
  {
    node: eye,
    path: 'translation',
    times: [0, 3.59, 3.6, 10.49, 10.5, 18],
    values: [
      [29.2, 1.8, 37],
      [29.3, 1.8, 37],
      [55, 17, 13],
      [67, 20, 12],
      [112, 22, 12],
      [140, 28, 8],
    ],
  },
  {
    node: target,
    path: 'translation',
    times: [0, 3.59, 3.6, 10.49, 10.5, 18],
    values: [
      [24.5, 1.5, 37],
      [24.5, 1.5, 37],
      [22, 1, 30],
      [30, 2, 35],
      [50, 5, 49],
      [73, 7, 62],
    ],
  },
);
model.animation('Departure', tracks);
const output = fileURLToPath(new URL('./generated/evacuation-ending.glb', import.meta.url));
const cooked = await model.save(output);
const bytes = await readFile(output);
const provenance = {
  schema: 'null-meridian-ending/1',
  source: 'games/horror/assets/build-ending.mjs',
  sourceSha256: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  authorship: 'Original authored Aegis geometry and glTF animation; no generated video.',
  reused:
    'Existing material maps, gas giant, rings and antenna kit. Original sources remain unchanged.',
  durationSeconds: 18,
  shots: [
    { start: 0, end: 3.6, beat: 'Capsule hatch closes around the recovered crew recorder.' },
    {
      start: 3.6,
      end: 10.5,
      beat: 'Thrusters fire; independent capsule separates from the east collar.',
    },
    { start: 10.5, end: 18, beat: 'Capsule leaves the station behind above the gas giant.' },
  ],
  file: cooked.file,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
await writeFile(
  new URL('./ending-provenance.json', import.meta.url),
  `${JSON.stringify(provenance, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(provenance)}\n`);

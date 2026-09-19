import { Model } from './model.mjs';
import { MATERIALS } from './textures.mjs';

export function doorModel() {
  const model = new Model('meridian-pressure-bulkhead', MATERIALS);
  const frame = model.node('bulkhead-frame');
  for (const x of [-1.55, 1.55]) {
    model.box(frame, 'graphite', [x, 1.8, 0], [0.1, 3.6, 0.73], 0.024);
    model.box(frame, 'steel', [x * 1.021, 1.8, -0.34], [0.028, 3.55, 0.022]);
  }
  model.box(frame, 'steel', [0, 0.012, 0], [3, 0.024, 0.88]);
  model.box(frame, 'graphite', [0, 3.48, 0], [3.13, 0.24, 0.81], 0.02);
  model.sign(frame, [0, 3.45, 0.411], 2.62, 0.17, 8);
  model.sign(frame, [0, 3.45, -0.411], 2.62, 0.17, 8, Math.PI);
  const tracks = [];
  for (const side of [-1, 1]) {
    const leaf = model.node(side < 0 ? 'leaf-left' : 'leaf-right', 0, [side * 0.75, 0, 0]);
    model.box(leaf, 'graphite', [0, 1.73, 0], [1.494, 3.42, 0.34], 0.045);
    for (const z of [-1, 1]) {
      model.box(leaf, 'ceramic', [0, 1.86, z * 0.183], [1.29, 2.68, 0.046], 0.029);
      model.box(leaf, 'ochre', [side * 0.5, 1.84, z * 0.211], [0.048, 2.49, 0.008]);
      model.box(leaf, 'steel', [-side * 0.48, 1.8, z * 0.212], [0.08, 0.37, 0.03], 0.013);
      model.sign(leaf, [0, 0.49, z * 0.213], 0.91, 0.11, 8, z < 0 ? Math.PI : 0);
      for (const x of [-0.57, 0.57])
        for (const y of [0.67, 2.98])
          model.cylinder(leaf, 'satin', [x, y, z * 0.217], 0.013, 0.01, 'z', 0.013, 8);
    }
    tracks.push({
      node: leaf,
      path: 'translation',
      times: [0, 0.12, 0.7],
      values: [
        [side * 0.75, 0, 0],
        [side * 0.78, 0, 0],
        [side * 2.28, 0, 0],
      ],
    });
  }
  model.animation('Open', tracks);
  return model;
}

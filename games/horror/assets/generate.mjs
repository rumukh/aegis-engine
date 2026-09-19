import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cookTextures, LABELS } from './lib/textures.mjs';
import { buildFacility, DOORS, exteriorModel, LIGHTS, PROPS } from './lib/facility.mjs';
import { doorModel } from './lib/door.mjs';
import { responderModel } from './lib/responder.mjs';
import { MOUNTS, mountedProp, validateMounts } from './lib/interactables.mjs';
import { ringDensity } from './lib/optical-surfaces.mjs';
import { png } from './lib/raster.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--scene', '--scope'].includes(args[i]) || !args[i + 1] || options.has(args[i]))
    throw new Error(
      'Usage: node games\\horror\\assets\\generate.mjs [--scene <canonical scene>] [--out <directory>] [--scope optics]',
    );
  options.set(args[i], args[i] === '--scope' ? args[i + 1] : resolve(args[i + 1]));
}
if (options.has('--scope') && options.get('--scope') !== 'optics')
  throw new Error('Only --scope optics is supported; omit scope for a full cook');
const opticsOnly = options.get('--scope') === 'optics';
const output = options.get('--out') ?? join(here, 'generated');
const scenePath = options.get('--scene') ?? join(here, '..', 'levels', 'null-meridian.scene.json');
const sceneBytes = await readFile(scenePath);
const scene = JSON.parse(sceneBytes.toString('utf8'));
validateMounts(scene);
const source = join(here, 'source');
const recipes = JSON.parse(await readFile(join(source, 'recipes.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
let previous;
if (opticsOnly) {
  previous = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'));
  if (previous.sourceScene.sha256 !== hash(sceneBytes))
    throw new Error('Optical-only cook requires the identical published scene');
  for (const file of previous.files) {
    if (hash(await readFile(join(output, file.file))) !== file.sha256)
      throw new Error(`Cannot reuse modified published asset: ${file.file}`);
  }
  const opticalSources = new Set([
    'generate.mjs',
    'source/recipes.json',
    'lib/optical-surfaces.mjs',
    'lib/responder.mjs',
  ]);
  for (const input of previous.recipeInputs) {
    if (
      !opticalSources.has(input.file) &&
      hash(await readFile(join(here, ...input.file.split('/')))) !== input.sha256
    )
      throw new Error(`Non-optical source changed; a full cook is required: ${input.file}`);
  }
  const provenance = JSON.parse(await readFile(join(here, 'provenance.json'), 'utf8'));
  for (const input of provenance.sourceFiles) {
    if (hash(await readFile(join(here, ...input.file.split('/')))) !== input.sha256)
      throw new Error(`Source image changed; a full cook is required: ${input.file}`);
  }
}
const textures = opticsOnly ? previous.textures : await cookTextures(source, output);
if (opticsOnly) {
  const density = ringDensity(),
    bytes = png(density);
  const texture = textures.find((entry) => entry.file === 'ring-density.png');
  if (!texture) throw new Error('Optical-only cook requires an existing continuous-ring revision');
  texture.bytes = bytes.length;
  texture.width = density.width;
  texture.height = density.height;
  await writeFile(join(output, texture.file), bytes);
}
const {
  model: facility,
  collision,
  rooms,
} = opticsOnly
  ? {
      model: { features: previous.authoredFeatures },
      collision: JSON.parse(await readFile(join(output, 'collision-audit.json'), 'utf8')),
      rooms: previous.rooms,
    }
  : buildFacility(scene);
if (facility.features.filter((feature) => feature.type === 'interactive-recess').length !== 11)
  throw new Error(
    'Every approved wall-mounted interaction needs exactly one visible facility recess',
  );
const models = opticsOnly ? previous.models : [];
for (const [file, model] of [
  ...(opticsOnly ? [] : [['facility.glb', facility]]),
  ['orbital-exterior.glb', exteriorModel()],
  ...(opticsOnly ? [] : MOUNTS.map((mount) => [`${mount.entity}.glb`, mountedProp(mount)])),
  ...(opticsOnly ? [] : [['pressure-door.glb', doorModel()]]),
  ['responder.glb', responderModel()],
]) {
  const stats = await model.save(join(output, file));
  if (opticsOnly) {
    const index = models.findIndex((entry) => entry.file === file);
    if (index < 0) throw new Error(`Missing published optical model ${file}`);
    models[index] = stats;
  } else models.push(stats);
}
const threat = models.find((model) => model.file === 'responder.glb');
if (
  threat.bounds.min[1] < -0.005 ||
  threat.bounds.max[1] > 2.11 ||
  Math.max(Math.abs(threat.bounds.min[0]), threat.bounds.max[0]) > 0.46
)
  throw new Error(`Threat contract bounds violated: ${JSON.stringify(threat.bounds)}`);
for (const prop of models.filter((model) =>
  MOUNTS.some((mount) => model.file === `${mount.entity}.glb`),
)) {
  if (
    Math.max(
      ...prop.bounds.min.map(Math.abs).filter((_, axis) => axis !== 1),
      ...prop.bounds.max.filter((_, axis) => axis !== 1),
    ) > 0.55
  )
    throw new Error(`Prop horizontal bounds exceed 0.55m: ${prop.file}`);
  if (prop.bounds.max[2] > 0.0001 || prop.bounds.min[2] < -0.311 || prop.bounds.min[1] < 0.5)
    throw new Error(
      `Wall-mounted prop has a forward projection, excessive depth or phantom pedestal: ${prop.file} ${JSON.stringify(prop.bounds)}`,
    );
}
for (const file of ['console.glb', 'isolation-control.glb', 'recorder.glb', 'wall-terminal.glb'])
  await rm(join(output, file), { force: true });
const runtimeFiles = [
  ...new Set([...models.map((model) => model.file), ...textures.map((texture) => texture.file)]),
].sort();
const files = [];
for (const file of runtimeFiles) {
  const bytes = await readFile(join(output, file));
  files.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
if (totalBytes > 48 * 1024 * 1024)
  throw new Error(`Visual budget exceeds48MiB reserved ceiling: ${totalBytes}`);
const sources = [];
for (const name of (await readdir(source)).filter((name) => name.endsWith('.png')).sort()) {
  const bytes = await readFile(join(source, name));
  sources.push({ file: `source/${name}`, bytes: bytes.length, sha256: hash(bytes) });
}
const recipeInputs = [];
for (const file of [
  'generate.mjs',
  'source/recipes.json',
  ...(await readdir(join(here, 'lib')))
    .filter((file) => file.endsWith('.mjs'))
    .sort()
    .map((file) => `lib/${file}`),
]) {
  const bytes = await readFile(join(here, ...file.split('/')));
  recipeInputs.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const threeVersion = JSON.parse(
  await readFile(
    join(dirname(fileURLToPath(import.meta.resolve('three'))), '..', 'package.json'),
    'utf8',
  ),
).version;
const footprint = textures.reduce(
  (sum, texture) => sum + (texture.width * texture.height * 4 * 4) / 3,
  0,
);
const manifest = {
  aegis: 'null-meridian-visual-assets/1',
  coordinateSystem: {
    units: 'meters',
    up: '+Y',
    forward: '+Z',
    floor: 0,
    ceiling: 3.6,
    gridCellCenters: 'integer X,Z',
  },
  sourceScene: {
    canonical: 'games/horror/levels/null-meridian.scene.json',
    sha256: hash(sceneBytes),
    floorplanSha256: hash(JSON.stringify(scene.resources['fps.floorplan'])),
    purpose:
      'Cook must be rerun if authoritative floorplan/door anchors change; unrelated component edits may change whole-scene hash without changing geometry.',
  },
  budget: {
    totalBytes,
    maximumVisualBytes: 48 * 1024 * 1024,
    reservedAudioBytes: 16 * 1024 * 1024,
    maximumFileBytes: 32 * 1024 * 1024,
    decodedUniqueTextureBytesWithMipmaps: Math.ceil(footprint),
    textureMemoryCaveat:
      'GPU texture instances may repeat across independently loaded GLBs. This is unique-image lower bound, not measured GPU residency.',
  },
  files,
  textures,
  models,
  rooms,
  authoredFeatures: facility.features,
  recipeInputs,
  toolchain: { node: process.versions.node, three: threeVersion },
  placement: {
    facility: {
      model: 'facility.glb',
      position: [0, 0, 0],
      fit: 'authored',
      replacesLegacyLevel: true,
    },
    exterior: { model: 'orbital-exterior.glb', position: [0, 0, 0], fit: 'authored' },
    doors: DOORS.map((door) => ({
      ...door,
      model: 'pressure-door.glb',
      clip: 'Open',
      duration: 0.7,
      holdLast: true,
      origin: 'feet center',
      collisionDrivenBy: 'gameplay, never animation',
    })),
    props: PROPS.map(([entity, model, yaw]) => {
      const position = scene.entities.find((e) => e.id === entity)?.components?.Transform?.position;
      if (!position) throw new Error(`Missing prop entity ${entity}`);
      const bounds = models.find((entry) => entry.file === `${model}.glb`).bounds;
      const angle = (yaw * Math.PI) / 180;
      const corners = [bounds.min[0], bounds.max[0]].flatMap((x) =>
        [bounds.min[2], bounds.max[2]].map((z) => [
          position.x + x * Math.cos(angle) + z * Math.sin(angle),
          position.z - x * Math.sin(angle) + z * Math.cos(angle),
        ]),
      );
      return {
        entity,
        model: `${model}.glb`,
        position: [position.x, position.y, position.z],
        rotation: [0, yaw, 0],
        fit: 'authored',
        worldFootprint: {
          min: [
            Math.min(...corners.map((point) => point[0])),
            position.y + bounds.min[1],
            Math.min(...corners.map((point) => point[1])),
          ],
          max: [
            Math.max(...corners.map((point) => point[0])),
            position.y + bounds.max[1],
            Math.max(...corners.map((point) => point[1])),
          ],
        },
        collision:
          'All body vertices at or behind local front z0, depth<=.31m, no geometry below.5m; front anchored.05m outside existing wall face. Facility has a matching recessed bay. Existing wall collision remains authoritative; no free-floor pedestal or new blocker.',
      };
    }),
    threat: {
      entity: 'responder',
      model: 'responder.glb',
      forward: '+Z',
      fit: 'authored',
      clips: {
        dormant: 'Idle',
        patrol: 'Stalk',
        search: 'Search',
        chase: 'Stalk',
        windup: 'Lunge',
      },
      motion:
        'Articulated rigid-node animation, no skeletal skin and no root motion; world motion authoritative.',
      locomotion: {
        clip: 'Stalk',
        cycleSeconds: 2.2,
        perFootfallTravelMetres: 0.8,
        fullCycleTravelMetres: 1.6,
        referenceSpeedMetresPerSecond: 1.6 / 2.2,
        playbackRate: 'actual world speed / referenceSpeedMetresPerSecond',
        note: '48-sample authored leg IK; stance heel/toe ground and world-space slip tested. Turning, stopping and runtime footstep phase alignment still need actual-game review.',
      },
    },
  },
  suggestedLighting: {
    note: 'Integrator converts this recommendation to current engine schema and tunes real captures. Seven world spots leave one camera flashlight slot; only power spot plus flashlight should cast shadows.',
    reflections: { texture: 'station-reflection.png', intensity: 0.32, dynamicRange: 'LDR' },
    spots: LIGHTS,
    ambient: { color: '#7c9292', intensity: 0.17 },
    background: '#030509',
    fog: 'Omit initially; do not hide geometry in fog.',
  },
  decals: LABELS.map(([title, subtitle], row) => ({
    row,
    title,
    subtitle,
    rect: [0, row / 16, 1, 1 / 16],
  })),
  limitations: [
    'Source concept is not an engine screenshot.',
    'Rigid articulated threat is not production skeletal animation.',
    'Authored planet illumination is baked into an Azure-generated neutral cloud derivative, with true distant geometric depth and rings.',
    'No claim of AAA completion or1440p60 performance until integrated engine measurements and visual acceptance.',
  ],
};
const provenance = {
  ...recipes,
  sourceFiles: sources,
  recipeInputs,
  toolchain: { node: process.versions.node, three: threeVersion },
  approvalConceptSha256: sources.find((file) => file.file === 'source/observation-concept.png')
    .sha256,
  geometry: {
    author: 'Aegis project / Copilot-assisted original authored geometry',
    license:
      'Repository MIT applies to generation code; mixed original/generated visual material rights documented per source.',
    borrowedArt: false,
  },
  generatedFiles: files,
};
await writeFile(join(output, 'inventory.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, 'collision-audit.json'), `${JSON.stringify(collision, null, 2)}\n`);
await writeFile(join(here, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, totalBytes, files: files.length, models: models.map(({ file, bytes, triangles, primitives, bounds, clips }) => ({ file, bytes, triangles, primitives, bounds, clips })), floorTiles: collision.floorTiles.length, wallFaces: collision.boundaryFaces.length, maxWallIntrusion: collision.maxWallIntrusion }, null, 2)}\n`,
);
